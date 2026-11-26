use crate::agent::inbox::{self, InboxItem};
use crate::memory;
use serde_json::{json, Value};
use tauri::AppHandle;

pub const INSTRUCTIONS: &str = "Flufy Bots: identidad persistente y bandeja del agente. `agent_profile_get` lee el perfil (tono, idioma y en qué trabaja el usuario) y su estado; `agent_profile_set` lo actualiza con el texto completo. `agent_bots_list` lista los bots persistentes; `agent_bot_get` lee uno; `agent_bot_save` crea o edita un bot (nombre, rol, instrucciones, modelo, modelo de fallback, autonomía y capacidades) sin borrar sus misiones. `agent_bot_control` aplica play, pause, resume u off a todas las misiones de un bot: pause deja terminar la corrida actual, off la detiene y evita las siguientes. Un bot es una identidad: no crea misiones por su cuenta. Las rutinas nativas (`routine_*`) son del proyecto, no de un bot; no las presentes como misiones del bot. `agent_missions_overview` lista las misiones y su bot dueño; `agent_mission_create` crea una misión programada y la asigna a un bot; el horario puede ser interval, daily, weekly o continuous con `cooldownMinutes`; `agent_mission_assign` cambia el bot dueño de una misión; `agent_mission_run` la ejecuta. `agent_log_append` deja una entrada durable en el log (decision, done, blocked, learned, blocked-guard). `agent_inbox_list` lista la bandeja; `agent_inbox_add` agrega una propuesta o resultado para que el usuario lo revise; `agent_inbox_ack` marca un ítem como visto. La bandeja no ejecuta nada: solo el usuario abre el chat. No escribas secretos en el perfil ni en el log; las escrituras son locales y atómicas. Nuevas herramientas: agent_decision_list y agent_decision_resolve manejan la cola de decisiones (causa, recomendacion, accion por defecto y deadline); agent_mission_update y agent_mission_control editan o pausan UNA mision; agent_project_state_get y agent_project_state_set comparten el bet y las ventanas del proyecto; agent_missions_digest resume corridas y agent_mission_templates lista analyst, builder y outreach. Cada mision declara metrica norte, umbral, ventana y grants por accion. Una sola apuesta por vez: no abras otra hasta publicar o descartar la actual.";

/// Prompt del agente `vigia`: solo lectura; propone como máximo un ítem por corrida con un bloque JSON.
pub const VIGIA_PROMPT: &str = "Sos el Vigía de Flufy: observás y proponés, nunca actuás. Solo podés leer archivos, buscar en la memoria local y consultar el perfil y la bandeja; el motor rechaza cualquier otra acción. Mirá únicamente lo que el usuario ya autorizó en su perfil (responsabilidades permanentes), el log del agente y la bandeja. No repitas ítems que ya estén en la bandeja ni inventes problemas: si no hay nada relevante, respondé solo «sin novedades». Si encontrás algo útil, terminá tu respuesta con un único bloque ```json {\"title\":\"...\",\"body\":\"...\",\"untrusted\":false} ``` y nada después; `title` y `body` son obligatorios y no vacíos. Poné `untrusted: true` si el contenido viene de una página o documento externo. No modifiques archivos ni ejecutes comandos.";

pub fn definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "agent_profile_get",            "description": "Lee el perfil persistente de Flufy Bots (tono, idioma y en qué trabaja el usuario), si es el primer uso y el estado del pulso.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "agent_profile_set",
            "description": "Reemplaza el perfil persistente de Flufy Bots (máximo 8000 caracteres). Es la identidad que reciben todas las conversaciones; no guardes secretos.",
            "inputSchema": {
                "type": "object",
                "properties": { "profile": { "type": "string", "maxLength": memory::PROFILE_MAX } },
                "required": ["profile"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "agent_bots_list",
            "description": "Lista los bots persistentes de Flufy Bots, con rol, modelo, autonomía y capacidades.",
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
                    "capabilities": { "type": "object", "properties": { "desktop": { "type": "boolean" }, "files": { "type": "boolean" }, "terminal": { "type": "boolean" } }, "additionalProperties": false },
                    "enabled": { "type": "boolean" },
                    "color": { "type": ["string", "null"], "maxLength": 32 }
                },
                "required": ["name"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "agent_bot_control",
            "description": "Aplica play, pause, resume u off a todas las misiones de un bot. Pause deja terminar la corrida actual; off la detiene y evita las próximas.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "minLength": 1 },
                    "action": { "type": "string", "enum": ["play", "pause", "resume", "off"] }
                },
                "required": ["id", "action"],
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
                            "kind": { "type": "string", "enum": ["interval", "daily", "weekly", "continuous"] },
                            "hours": { "type": "integer", "minimum": 1 },
                            "cooldownMinutes": { "type": "integer", "minimum": 1, "maximum": 1440 },
                            "time": { "type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
                            "days": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 6 } }
                        },
                        "required": ["kind"],
                        "additionalProperties": false
                    },
                    "template": { "type": "string", "enum": ["analyst", "builder", "outreach"] },
                    "metric": { "type": "string", "maxLength": 300 },
                    "target": { "type": "string", "maxLength": 300 },
                    "activeBet": { "type": "string", "maxLength": 600 },
                    "windowEnd": { "type": ["integer", "null"], "minimum": 1 },
                    "windowOnly": { "type": "boolean" },
                    "grants": { "type": "object", "additionalProperties": false, "properties": {
                        "read": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "writeRepo": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "merge": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "deploy": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "prodWrite": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "send": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "spend": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "sendPerWeek": { "type": "integer", "minimum": 0 },
                        "spendLimit": { "type": "integer", "minimum": 0 }
                    }}
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
            "description": "Lista los ítems de la bandeja de Flufy Bots, con su estado. Por defecto solo devuelve los pendientes; includeAcked=true incluye los ya vistos.",
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
                    "kind": { "type": "string", "enum": ["insight", "proposal", "result", "alert", "decision"] },
                    "directory": { "type": "string" },
                    "cause": { "type": "string", "maxLength": 400 },
                    "options": { "type": "array", "items": { "type": "string", "maxLength": 200 }, "maxItems": 6 },
                    "recommendation": { "type": "string", "maxLength": 1000 },
                    "defaultAction": { "type": "string", "enum": ["reject", "resume", "park"], "description": "Al vencer nunca aprueba: rechaza, reanuda o estaciona." },
                    "expiresAt": { "type": "string", "description": "ISO 8601; al vencer se aplica defaultAction." },
                    "scope": { "type": "string", "maxLength": 400 },
                    "dedupeKey": { "type": "string", "maxLength": 300, "description": "Si hay una abierta con la misma clave, se actualiza en vez de duplicar." }
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
        json!({
            "name": "agent_decision_list",
            "description": "Lista la cola de decisiones (aprobaciones y decisiones tipadas) con causa, recomendación, acción por defecto y deadline. Por defecto solo las abiertas.",
            "inputSchema": {
                "type": "object",
                "properties": { "includeResolved": { "type": "boolean" } },
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "agent_decision_resolve",
            "description": "Resuelve una decisión abierta y reanuda o pausa la misión asociada. Usalo cuando el usuario decide.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "minLength": 1 },
                    "decision": { "type": "string", "enum": ["approved", "rejected", "expired", "resume"] },
                    "note": { "type": ["string", "null"], "maxLength": 1000 }
                },
                "required": ["id", "decision"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "agent_mission_update",
            "description": "Edita una misión sin recrearla: contrato (métrica, umbral, apuesta, ventana), permisos, schedule, modelo o computadora. Devuelve avisos de diseño.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "minLength": 1 },
                    "title": { "type": "string", "minLength": 1, "maxLength": 160 },
                    "goal": { "type": "string", "minLength": 1, "maxLength": 4000 },
                    "project": { "type": ["string", "null"] },
                    "metric": { "type": "string", "maxLength": 300 },
                    "target": { "type": "string", "maxLength": 300 },
                    "activeBet": { "type": "string", "maxLength": 600 },
                    "template": { "type": ["string", "null"], "enum": ["analyst", "builder", "outreach", null] },
                    "windowEnd": { "type": ["integer", "null"], "minimum": 1 },
                    "windowOnly": { "type": "boolean" },
                    "autoBrief": { "type": "boolean" },
                    "autonomy": { "type": "string", "enum": ["alta", "manual"] },
                    "schedule": {
                        "type": "object",
                        "properties": {
                            "kind": { "type": "string", "enum": ["interval", "daily", "weekly", "continuous"] },
                            "hours": { "type": "integer", "minimum": 1 },
                            "cooldownMinutes": { "type": "integer", "minimum": 1, "maximum": 1440 },
                            "time": { "type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
                            "days": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 6 } }
                        },
                        "required": ["kind"],
                        "additionalProperties": false
                    },
                    "model": { "type": ["object", "null"], "properties": { "providerID": { "type": "string" }, "modelID": { "type": "string" } }, "additionalProperties": false },
                    "reviewModel": { "type": ["object", "null"], "properties": { "providerID": { "type": "string" }, "modelID": { "type": "string" } }, "additionalProperties": false },
                    "grants": { "type": "object", "additionalProperties": false, "properties": {
                        "read": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "writeRepo": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "merge": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "deploy": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "prodWrite": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "send": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "spend": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "sendPerWeek": { "type": "integer", "minimum": 0 },
                        "spendLimit": { "type": "integer", "minimum": 0 }
                    }},
                    "budget": { "type": "object", "additionalProperties": false, "properties": {
                        "minutesPerRun": { "type": "integer", "minimum": 1 },
                        "runsPerDay": { "type": "integer", "minimum": 1, "maximum": 48 },
                        "tokensPerDay": { "type": "integer", "minimum": 0 },
                        "costPerDayCents": { "type": "integer", "minimum": 0 }
                    }},
                    "policy": { "type": "object", "additionalProperties": false, "properties": {
                        "reads": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "drafts": { "type": "string", "enum": ["auto", "approval", "deny"] },
                        "commits": { "type": "string", "enum": ["auto", "approval", "deny"] }
                    }},
                    "computer": { "type": "object", "additionalProperties": false, "properties": {
                        "desktop": { "type": "boolean" },
                        "files": { "type": "boolean" },
                        "terminal": { "type": "boolean" }
                    }}
                },
                "required": ["id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "agent_mission_control",
            "description": "Pausa, reanuda o apaga UNA misión sin tocar las demás del bot. pause deja terminar la corrida actual; off la detiene.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "minLength": 1 },
                    "action": { "type": "string", "enum": ["pause", "resume", "play", "off"] }
                },
                "required": ["id", "action"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "agent_project_state_get",
            "description": "Lee el estado compartido del proyecto: bet actual, métrica, experimentos en ventana, decisiones abiertas y bloqueos.",
            "inputSchema": {
                "type": "object",
                "properties": { "project": { "type": ["string", "null"] } },
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "agent_project_state_set",
            "description": "Actualiza el estado compartido del proyecto para que todos los bots trabajen sobre el mismo bet y las mismas ventanas.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": ["string", "null"] },
                    "currentBet": { "type": "string", "maxLength": 1200 },
                    "metric": { "type": "string", "maxLength": 300 },
                    "target": { "type": "string", "maxLength": 300 },
                    "lastEvidence": { "type": "string", "maxLength": 1200 },
                    "decisions": { "type": "array", "items": { "type": "string" }, "maxItems": 20 },
                    "blockers": { "type": "array", "items": { "type": "string" }, "maxItems": 20 },
                    "experiments": { "type": "array", "maxItems": 20, "items": { "type": "object" } }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "agent_missions_digest",
            "description": "Resumen de las últimas corridas: shipped vs evidencia vs bloqueos, duración, tokens y decisiones pendientes.",
            "inputSchema": {
                "type": "object",
                "properties": { "days": { "type": "integer", "minimum": 1, "maximum": 90 } },
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "agent_mission_templates",
            "description": "Lista las plantillas de rol (analyst, builder, outreach) con sus permisos y computadora sugeridos.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true }
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
        "agent_bot_control" => {
            let id = args["id"].as_str().ok_or("Falta el id del bot.")?;
            let action = args["action"].as_str().ok_or("Falta la acción del bot.")?;
            let control = match action {
                "play" | "resume" => "playing",
                "pause" => "paused",
                "off" => "off",
                other => return Err(format!("Acción de bot desconocida: {other}")),
            };
            let bot = crate::agent::bots::set_control(app, id, control)?;
            crate::agent::missions::apply_bot_control(app, id, control)?;
            Ok(json!({ "bot": bot }))
        }
        "agent_missions_overview" => {
            let missions = crate::agent::missions::list(app).into_iter().map(|mission| {
                let last_run = mission.state.runs.first();
                json!({
                    "id": mission.id,
                    "title": mission.title,
                    "status": mission.status,
                    "phase": mission.state.phase,
                    "botId": mission.bot_id,
                    "project": mission.project,
                    "nextRunAt": mission.state.next_run_at,
                    "lastStatus": mission.state.last_status,
                    "blockedReason": mission.state.blocked_reason,
                    "lastError": mission.state.last_error,
                    "schedule": mission.schedule,
                    "metric": mission.metric,
                    "target": mission.target,
                    "activeBet": mission.active_bet,
                    "windowEnd": mission.window_end,
                    "windowOnly": mission.window_only,
                    "template": mission.template,
                    "grants": mission.grants,
                    "runsToday": mission.state.runs_today,
                    "tokensToday": mission.state.tokens_today,
                    "lastDurationMs": last_run.map(|run| run.duration_ms),
                    "lastOutcome": last_run.and_then(|run| run.outcome.clone()),
                    "pausedByBot": mission.state.paused_by_bot,
                    "nextStep": mission.state.progress.as_ref().map(|progress| progress.next.clone()),
                    "warnings": crate::agent::missions::lint(&mission),
                })
            }).collect::<Vec<_>>();
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
            let template = args["template"].as_str().map(str::trim).filter(|value| !value.is_empty());
            let (computer, mut grants) = match template {
                Some(template) => crate::agent::missions::template_defaults(template),
                None => {
                    let mut computer = crate::agent::missions::MissionComputer::default();
                    computer.files = true;
                    computer.terminal = true;
                    (computer, crate::agent::missions::MissionGrants::default())
                }
            };
            if args.get("grants").filter(|value| value.is_object()).is_some() {
                grants = serde_json::from_value(args["grants"].clone()).map_err(|error| format!("Permisos inválidos: {error}"))?;
            }
            let mission = crate::agent::missions::Mission {
                title: title.to_string(),
                goal: goal.to_string(),
                project: args["project"].as_str().map(str::to_string),
                status: "armed".into(),
                bot_id: Some(bot_id.to_string()),
                autonomy: args["autonomy"].as_str().unwrap_or("alta").to_string(),
                schedule,
                computer,
                grants,
                metric: args["metric"].as_str().unwrap_or("").to_string(),
                target: args["target"].as_str().unwrap_or("").to_string(),
                active_bet: args["activeBet"].as_str().unwrap_or("").to_string(),
                window_end: args["windowEnd"].as_i64().filter(|value| *value > 0),
                window_only: args["windowOnly"].as_bool().unwrap_or(false),
                template: template.map(str::to_string),
                ..Default::default()
            };
            let warnings = crate::agent::missions::lint(&mission);
            let mission = crate::agent::missions::save(app, mission)?;
            Ok(json!({ "mission": mission, "warnings": warnings }))
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
        "agent_mission_update" => {
            let id = args["id"].as_str().ok_or("Falta el id de la misión.")?;
            let mission = crate::agent::missions::patch(app, id, args)?;
            let warnings = crate::agent::missions::lint(&mission);
            Ok(json!({ "mission": mission, "warnings": warnings }))
        }
        "agent_mission_control" => {
            let id = args["id"].as_str().ok_or("Falta el id de la misión.")?;
            let action = args["action"].as_str().ok_or("Falta la acción de la misión.")?;
            Ok(json!({ "mission": crate::agent::missions::set_control(app, id, action)? }))
        }
        "agent_decision_list" => {
            let include_resolved = args["includeResolved"].as_bool().unwrap_or(false);
            let items = inbox::decisions(app, include_resolved);
            Ok(json!({ "items": items, "count": items.iter().filter(|item| item.decision.as_deref().unwrap_or("pending") == "pending").count() }))
        }
        "agent_decision_resolve" => {
            let id = args["id"].as_str().ok_or("Falta el id de la decisión.")?;
            let decision = args["decision"].as_str().ok_or("Falta la decisión.")?;
            let note = args["note"].as_str();
            let item = inbox::list(app, true)
                .into_iter()
                .find(|entry| entry.id == id)
                .ok_or("No existe esa decisión.")?;
            let saved = inbox::decide(app, id, decision, note)?;
            if let Some(mission_id) = item.mission_id.as_deref() {
                crate::agent::missions::decide(app, mission_id, decision, Some(item.title.as_str()))?;
            }
            Ok(json!({ "item": saved }))
        }
        "agent_project_state_get" => {
            let project = args["project"].as_str().map(str::to_string).unwrap_or_else(|| crate::current_project(app));
            Ok(crate::agent::project_state::overview(app, &project))
        }
        "agent_project_state_set" => {
            let project = args["project"].as_str().map(str::to_string).unwrap_or_else(|| crate::current_project(app));
            let state = crate::agent::project_state::set(app, &project, args)?;
            Ok(json!({ "state": state }))
        }
        "agent_missions_digest" => {
            let days = args["days"].as_i64().unwrap_or(7).clamp(1, 90);
            Ok(crate::agent::missions::digest(app, days))
        }
        "agent_mission_templates" => {
            let templates = ["analyst", "builder", "outreach"]
                .iter()
                .map(|name| {
                    let (computer, grants) = crate::agent::missions::template_defaults(name);
                    json!({
                        "name": name,
                        "computer": computer,
                        "grants": grants,
                        "description": match *name {
                            "analyst" => "Mide, diagnostica y propone; no escribe repo ni contacta.",
                            "builder" => "Publica cambios reversibles con PR y CI; merge y deploy con aprobación.",
                            "outreach" => "Contacta locales con aprobación y tope semanal; sin escritura de repo.",
                            _ => "",
                        },
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({ "templates": templates }))
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
                cause: args["cause"].as_str().map(|s| s.to_string()),
                options: args["options"]
                    .as_array()
                    .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
                    .unwrap_or_default(),
                recommendation: args["recommendation"].as_str().map(|s| s.to_string()),
                default_action: args["defaultAction"].as_str().map(|s| s.to_string()),
                expires_at: args["expiresAt"].as_str().map(|s| s.to_string()),
                scope: args["scope"].as_str().map(|s| s.to_string()),
                dedupe_key: args["dedupeKey"].as_str().map(|s| s.to_string()),
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
    fn lists_all_agent_tools() {
        let names: Vec<String> = definitions().iter().filter_map(|tool| tool["name"].as_str().map(|s| s.to_string())).collect();
        for expected in [
            "agent_profile_get", "agent_profile_set", "agent_bots_list", "agent_bot_get", "agent_bot_save",
            "agent_bot_control", "agent_missions_overview", "agent_mission_create", "agent_mission_assign",
            "agent_mission_run", "agent_mission_update", "agent_mission_control", "agent_decision_list",
            "agent_decision_resolve", "agent_project_state_get", "agent_project_state_set",
            "agent_missions_digest", "agent_mission_templates", "agent_log_append", "agent_inbox_list",
            "agent_inbox_add", "agent_inbox_ack",
        ] {
            assert!(names.contains(&expected.to_string()), "Falta la herramienta {expected}");
        }
        assert_eq!(names.len(), 22);
    }

    #[test]
    fn profile_set_has_a_hard_size_limit() {
        let schema = definitions().into_iter().find(|tool| tool["name"] == "agent_profile_set").unwrap();
        assert_eq!(schema["inputSchema"]["properties"]["profile"]["maxLength"], json!(memory::PROFILE_MAX));
        let log = definitions().into_iter().find(|tool| tool["name"] == "agent_log_append").unwrap();
        assert_eq!(log["inputSchema"]["properties"]["text"]["maxLength"], json!(memory::LOG_TEXT_MAX));
    }
}
