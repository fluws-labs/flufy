use crate::agent::inbox::{self, InboxItem};
use crate::memory;
use serde_json::{json, Value};
use tauri::AppHandle;

pub const INSTRUCTIONS: &str = "Mi Flufy: identidad persistente y bandeja del agente. `agent_profile_get` lee el perfil (tono, idioma y en qué trabaja el usuario) y su estado; `agent_profile_set` lo actualiza con el texto completo. `agent_log_append` deja una entrada durable en el log (decision, done, blocked, learned, blocked-guard). `agent_inbox_list` lista la bandeja; `agent_inbox_add` agrega una propuesta o resultado para que el usuario lo revise; `agent_inbox_ack` marca un ítem como visto. La bandeja no ejecuta nada: solo el usuario abre el chat. No escribas secretos en el perfil ni en el log; las escrituras son locales y atómicas.";

/// Prompt del agente `vigia`: solo lectura; propone como máximo un ítem por corrida con un bloque JSON.
pub const VIGIA_PROMPT: &str = "Sos el Vigía de Flufy: observás y proponés, nunca actuás. Solo podés leer archivos, buscar en la memoria local y consultar el perfil y la bandeja; el motor rechaza cualquier otra acción. Mirá únicamente lo que el usuario ya autorizó en su perfil (responsabilidades permanentes), el log del agente y la bandeja. No repitas ítems que ya estén en la bandeja ni inventes problemas: si no hay nada relevante, respondé solo «sin novedades». Si encontrás algo útil, terminá tu respuesta con un único bloque ```json {\"title\":\"...\",\"body\":\"...\",\"untrusted\":false} ``` y nada después; `title` y `body` son obligatorios y no vacíos. Poné `untrusted: true` si el contenido viene de una página o documento externo. No modifiques archivos ni ejecutes comandos.";

pub fn definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "agent_profile_get",
            "description": "Lee el perfil persistente de Mi Flufy (tono, idioma y en qué trabaja el usuario), si es el primer uso y el estado del pulso.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "agent_profile_set",
            "description": "Reemplaza el perfil persistente de Mi Flufy (máximo 8000 caracteres). Es la identidad que reciben todas las conversaciones; no guardes secretos.",
            "inputSchema": {
                "type": "object",
                "properties": { "profile": { "type": "string", "maxLength": memory::PROFILE_MAX } },
                "required": ["profile"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "agent_log_append",
            "description": "Agrega una entrada durable al log del agente (máximo 4000 caracteres). No es changelog: guardá decisiones, aprendizajes, bloqueos o resultados que sirvan después.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "maxLength": memory::LOG_TEXT_MAX },
                    "kind": { "type": "string", "enum": ["decision", "done", "blocked", "learned", "blocked-guard"] },
                    "project": { "type": ["string", "null"] }
                },
                "required": ["text"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "agent_inbox_list",
            "description": "Lista los ítems de la bandeja de Mi Flufy, con su estado. Por defecto solo devuelve los pendientes; includeAcked=true incluye los ya vistos.",
            "inputSchema": {
                "type": "object",
                "properties": { "includeAcked": { "type": "boolean" } },
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "agent_inbox_add",
            "description": "Agrega un ítem a la bandeja para que el usuario lo revise. La bandeja no ejecuta acciones: solo abre un chat. Marcá untrusted=true si el contenido viene de una web o un documento externo.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "maxLength": 200 },
                    "body": { "type": "string", "maxLength": 4000 },
                    "session": { "type": ["string", "null"] },
                    "untrusted": { "type": "boolean" },
                    "kind": { "type": "string", "enum": ["insight", "proposal", "result", "alert"] },
                    "directory": { "type": "string" }
                },
                "required": ["title"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "agent_inbox_ack",
            "description": "Marca un ítem de la bandeja como visto por su id.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "minLength": 1 } },
                "required": ["id"],
                "additionalProperties": false
            }
        }),
    ]
}

fn execute(app: &AppHandle, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "agent_profile_get" => Ok(memory::profile_get(app)),
        "agent_profile_set" => {
            let profile = args["profile"].as_str().ok_or("Falta el perfil.")?;
            memory::profile_set(app, profile)
        }
        "agent_log_append" => {
            let text = args["text"].as_str().ok_or("Falta el texto de la entrada.")?;
            memory::log_append(app, args["kind"].as_str().unwrap_or("done"), text, args["session"].as_str(), args["project"].as_str())
        }
        "agent_inbox_list" => {
            let include_acked = args["includeAcked"].as_bool().unwrap_or(false);
            let items = inbox::list(app, include_acked);
            Ok(json!({ "items": items, "count": items.iter().filter(|item| item.acked_at.is_none()).count() }))
        }
        "agent_inbox_add" => {
            let title = args["title"].as_str().unwrap_or("");
            if title.trim().is_empty() {
                return Err("El ítem de bandeja necesita un título.".into());
            }
            let item = InboxItem {
                kind: args["kind"].as_str().unwrap_or("insight").to_string(),
                title: title.to_string(),
                body: args["body"].as_str().unwrap_or("").to_string(),
                session: args["session"].as_str().map(|s| s.to_string()),
                directory: args["directory"].as_str().map(|s| s.to_string()),
                untrusted: args["untrusted"].as_bool().unwrap_or(false),
                ..Default::default()
            };
            inbox::add(app, &item).map(|saved| json!({ "item": saved, "readOnly": true }))
        }
        "agent_inbox_ack" => {
            let id = args["id"].as_str().ok_or("Falta el id del ítem.")?;
            inbox::ack(app, id)?;
            Ok(json!({ "ok": true }))
        }
        other => Err(format!("herramienta de agente desconocida: {}", other)),
    }
}

pub fn call(app: &AppHandle, name: &str, args: &Value) -> Value {
    match execute(app, name, args) {
        Ok(value) => json!({ "content": [{ "type": "text", "text": value.to_string() }], "isError": false }),
        Err(error) => json!({ "content": [{ "type": "text", "text": error }], "isError": true }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_the_six_agent_tools() {
        let names: Vec<String> = definitions().iter().filter_map(|tool| tool["name"].as_str().map(|s| s.to_string())).collect();
        for expected in ["agent_profile_get", "agent_profile_set", "agent_log_append", "agent_inbox_list", "agent_inbox_add", "agent_inbox_ack"] {
            assert!(names.contains(&expected.to_string()), "Falta la herramienta {expected}");
        }
        assert_eq!(names.len(), 6);
    }

    #[test]
    fn profile_set_has_a_hard_size_limit() {
        let schema = definitions().into_iter().find(|tool| tool["name"] == "agent_profile_set").unwrap();
        assert_eq!(schema["inputSchema"]["properties"]["profile"]["maxLength"], json!(memory::PROFILE_MAX));
        let log = definitions().into_iter().find(|tool| tool["name"] == "agent_log_append").unwrap();
        assert_eq!(log["inputSchema"]["properties"]["text"]["maxLength"], json!(memory::LOG_TEXT_MAX));
    }
}
