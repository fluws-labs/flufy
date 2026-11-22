use crate::agent::inbox::{self, InboxItem};
use crate::memory;
use serde_json::{json, Value};
use tauri::AppHandle;

pub const INSTRUCTIONS: &str = "Mi Flufy: identidad persistente y bandeja del agente. `agent_profile_get` lee el perfil (tono, idioma y en qué trabaja el usuario) y su estado; `agent_profile_set` lo actualiza con el texto completo. `agent_bots_list` lista los bots persistentes; `agent_bot_get` lee uno; `agent_bot_save` crea o edita un bot (nombre, rol, instrucciones, modelo, modelo de fallback, autonomía y capacidades) sin borrar sus misiones. Un bot es una identidad: no crea misiones por su cuenta. Las rutinas nativas (`routine_*`) son del proyecto, no de un bot; no las presentes como misiones del bot. `agent_missions_overview` lista las misiones y su bot dueño; `agent_mission_create` crea una misión programada y la asigna a un bot; `agent_mission_assign` cambia el bot dueño de una misión; `agent_mission_run` la ejecuta. `agent_log_append` deja una entrada durable en el log (decision, done, blocked, learned, blocked-guard). `agent_inbox_list` lista la bandeja; `agent_inbox_add` agrega una propuesta o resultado para que el usuario lo revise; `agent_inbox_ack` marca un ítem como visto. La bandeja no ejecuta nada: solo el usuario abre el chat. No escribas secretos en el perfil ni en el log; las escrituras son locales y atómicas.";

/// Prompt del agente `vigia`: solo lectura; propone como máximo un ítem por corrida con un bloque JSON.
pub const VIGIA_PROMPT: &str = "Sos el Vigía de Flufy: observás y proponés, nunca actuás. Solo podés leer archivos, buscar en la memoria local y consultar el perfil y la bandeja; el motor rechaza cualquier otra acción. Mirá únicamente lo que el usuario ya autorizó en su perfil (responsabilidades permanentes), el log del agente y la bandeja. No repitas ítems que ya estén en la bandeja ni inventes problemas: si no hay nada relevante, respondé solo «sin novedades». Si encontrás algo útil, terminá tu respuesta con un único bloque ```json {\"title\":\"...\",\"body\":\"...\",\"untrusted\":false} ``` y nada después; `title` y `body` son obligatorios y no vacíos. Poné `untrusted: true` si el contenido viene de una página o documento externo. No modifiques archivos ni ejecutes comandos.";

pub fn definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "agent_profile_get",            "description": "Lee el perfil persistente de Mi Flufy (tono, idioma y en qué trabaja el usuario), si es el primer uso y el estado del pulso.",
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
            "name": "agent_bots_list",
            "description": "Lista los bots persistentes de Mi Flufy, con rol, modelo, autonomía y capacidades.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "agent_bot_get",
            "description": "Lee un bot por id.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string", "minLength": 1 } }, "required": ["id"], "additionalProperties": false },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "agent_bot_save",
            "description": "Crea o edita un bot persistente. Si no hay id, crea uno a partir del nombre. No borra sus misiones. Las instrucciones son la identidad del bot en sus misiones y chats.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": ["string", "null"] },
                    "name": { "type": "string", "minLength": 1, "maxLength": 80 },
                    "role": { "type": "string", "maxLength": 120 },
                    "instructions": { "type": "string", "maxLength": 6000 },
                    "model": { "type": ["object", "null"], "properties": { "providerID": { "type": "string" }, "modelID": { "type": "string" } }, "additionalProperties": false },
                    "fallbackModel": { "type": ["object", "null"], "properties": { "providerID": { "type": "string" }, "modelID": { "type": "string" } }, "additionalProperties": false },
                    "autonomy": { "type": "string", "enum": ["alta", "manual"] },
                    "capabilities": { "type": "object", "properties": { "browser": { "type": "string", "enum": ["borrowed", "own", "internal"] }, "desktop": { "type": "boolean" }, "files": { "type": "boolean" }, "terminal": { "type": "boolean" } }, "additionalProperties": false },
                    "enabled": { "type": "boolean" },
                    "color": { "type": ["string", "null"], "maxLength": 32 }
                },
                "required": ["name"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "agent_missions_overview",
            "description": "Lista las misiones con su id, título, estado, bot dueño, proyecto y próxima corrida. Solo lectura.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "agent_mission_create",
            "description": "Crea una misión programada y la asigna a un bot. Usalo cuando el usuario pida una rutina o una tarea recurrente. No la ejecuta ahora.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "minLength": 1, "maxLength": 160 },
                    "goal": { "type": "string", "minLength": 1, "maxLength": 4000 },
                    "botId": { "type": "string", "minLength": 1 },
                    "project": { "type": ["string", "null"] },
                    "autonomy": { "type": "string", "enum": ["alta", "manual"] },
                    "schedule": {
                        "type": "object",
                        "properties": {
                            "kind": { "type": "string", "enum": ["interval", "daily", "weekly"] },
                            "hours": { "type": "integer", "minimum": 1 },
                            "time": { "type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
                            "days": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 6 } }
                        },
                        "required": ["kind"],
                        "additionalProperties": false
                    }
                },
                "required": ["title", "goal", "botId", "schedule"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "agent_mission_assign",
            "description": "Asigna una misión existente a un bot existente. No la ejecuta.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "minLength": 1 }, "botId": { "type": "string", "minLength": 1 } },
                "required": ["id", "botId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "agent_mission_run",
            "description": "Ejecuta ahora una misión existente. Usalo solo cuando el usuario lo pida explícitamente.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string", "minLength": 1 } }, "required": ["id"], "additionalProperties": false }
        }),
        json!({
            "name": "agent_log_append",            "description": "Agrega una entrada durable al log del agente (máximo 4000 caracteres). No es changelog: guardá decisiones, aprendizajes, bloqueos o resultados que sirvan después.",
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
        "agent_bots_list" => Ok(json!({ "bots": crate::agent::bots::list(app) })),
        "agent_bot_get" => {
            let id = args["id"].as_str().ok_or("Falta el id del bot.")?;
            Ok(crate::agent::bots::get(app, Some(id)).map(|bot| json!({ "bot": bot })).unwrap_or_else(|| json!({ "bot": null })))
        }
        "agent_bot_save" => Ok(json!({ "bot": crate::agent::bots::save(app, args)? })),
        "agent_missions_overview" => {
            let missions = crate::agent::missions::list(app).into_iter().map(|mission| json!({
                "id": mission.id, "title": mission.title, "status": mission.status,
                "botId": mission.bot_id, "project": mission.project, "nextRunAt": mission.state.next_run_at,
                "lastStatus": mission.state.last_status
            })).collect::<Vec<_>>();
            Ok(json!({ "missions": missions }))
        }
        "agent_mission_create" => {
            let title = args["title"].as_str().map(str::trim).filter(|value| !value.is_empty()).ok_or("La misión necesita un título.")?;
            let goal = args["goal"].as_str().map(str::trim).filter(|value| !value.is_empty()).ok_or("La misión necesita un objetivo.")?;
            let bot_id = args["botId"].as_str().map(str::trim).filter(|value| !value.is_empty()).ok_or("La misión necesita un botId.")?;
            if crate::agent::bots::get(app, Some(bot_id)).is_none() {
                return Err(format!("No existe el bot {bot_id}."));
            }
            let schedule: crate::agent::missions::MissionSchedule = serde_json::from_value(args["schedule"].clone()).map_err(|error| format!("Horario inválido: {error}"))?;
            let mut computer = crate::agent::missions::MissionComputer::default();
            computer.files = true;
            computer.terminal = true;
            let mission = crate::agent::missions::Mission {
                title: title.to_string(),
                goal: goal.to_string(),
                project: args["project"].as_str().map(str::to_string),
                status: "armed".into(),
                bot_id: Some(bot_id.to_string()),
                autonomy: args["autonomy"].as_str().unwrap_or("alta").to_string(),
                schedule,
                computer,
                ..Default::default()
            };
            Ok(json!({ "mission": crate::agent::missions::save(app, mission)? }))
        }
        "agent_mission_assign" => {
            let id = args["id"].as_str().ok_or("Falta el id de la misión.")?;
            let bot_id = args["botId"].as_str().ok_or("Falta el botId.")?;
            Ok(json!({ "mission": crate::agent::missions::assign_bot(app, id, bot_id)? }))
        }
        "agent_mission_run" => {
            let id = args["id"].as_str().ok_or("Falta el id de la misión.")?;
            crate::agent::missions::launch(app, id, true)?;
            Ok(json!({ "ok": true, "id": id }))
        }
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
        for expected in ["agent_profile_get", "agent_profile_set", "agent_bots_list", "agent_bot_get", "agent_bot_save", "agent_missions_overview", "agent_mission_create", "agent_mission_assign", "agent_mission_run", "agent_log_append", "agent_inbox_list", "agent_inbox_add", "agent_inbox_ack"] {
            assert!(names.contains(&expected.to_string()), "Falta la herramienta {expected}");
        }
        assert_eq!(names.len(), 13);    }

    #[test]
    fn profile_set_has_a_hard_size_limit() {
        let schema = definitions().into_iter().find(|tool| tool["name"] == "agent_profile_set").unwrap();
        assert_eq!(schema["inputSchema"]["properties"]["profile"]["maxLength"], json!(memory::PROFILE_MAX));
        let log = definitions().into_iter().find(|tool| tool["name"] == "agent_log_append").unwrap();
        assert_eq!(log["inputSchema"]["properties"]["text"]["maxLength"], json!(memory::LOG_TEXT_MAX));
    }
}
