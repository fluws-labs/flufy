use super::domain::{now, Employee};
use super::evidence::sanitize;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

// Live activity is a memory-only projection of the engine poll loop. Persisting
// every tool call would rewrite the whole team store on each tick.
const MAX_EVENTS: usize = 400;
const MAX_LABEL: usize = 160;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub seq: u64,
    pub at: i64,
    pub run_id: String,
    pub task_id: Option<String>,
    pub attempt_id: Option<String>,
    pub agent_id: String,
    pub agent_name: String,
    pub session_id: String,
    pub kind: String,
    pub status: String,
    pub tool: Option<String>,
    pub label: String,
    pub target: Option<String>,
    pub call_id: Option<String>,
}

#[derive(Default)]
pub struct ActivityLog {
    seq: u64,
    by_run: HashMap<String, Vec<Activity>>,
}

impl ActivityLog {
    fn push(&mut self, mut activity: Activity) -> Activity {
        self.seq += 1;
        activity.seq = self.seq;
        let entry = self.by_run.entry(activity.run_id.clone()).or_default();
        entry.push(activity.clone());
        if entry.len() > MAX_EVENTS {
            let excess = entry.len() - MAX_EVENTS;
            entry.drain(0..excess);
        }
        activity
    }

    pub fn recent(&self, run_id: &str, limit: usize) -> Vec<Activity> {
        let events = self.by_run.get(run_id);
        let start = events.map_or(0, |events| events.len().saturating_sub(limit));
        events.map_or_else(Vec::new, |events| events[start..].to_vec())
    }
}

#[derive(Clone, Debug)]
pub struct Context {
    pub task_id: Option<String>,
    pub attempt_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PartEvent {
    pub kind: &'static str,
    pub status: String,
    pub tool: Option<String>,
    pub label: String,
    pub target: Option<String>,
    pub call_id: Option<String>,
}

pub fn context(app: &AppHandle, run_id: &str, session: &str) -> Context {
    let found = super::run(app, run_id).ok().and_then(|run| {
        run.tasks.into_iter().find_map(|task| {
            task.attempts
                .into_iter()
                .rev()
                .find(|attempt| {
                    attempt.session_id.as_deref() == Some(session)
                        || attempt.review_session_id.as_deref() == Some(session)
                })
                .map(|attempt| (task.id, attempt.id))
        })
    });
    match found {
        Some((task_id, attempt_id)) => Context {
            task_id: Some(task_id),
            attempt_id: Some(attempt_id),
        },
        None => Context {
            task_id: None,
            attempt_id: None,
        },
    }
}

// Seeds the seen map with the session history so a resumed session does not
// replay old tool calls as if they were happening now.
pub fn diff(messages: &Value, seen: &mut HashMap<String, String>) -> Vec<PartEvent> {
    let mut events = Vec::new();
    for message in messages.as_array().into_iter().flatten() {
        if message["info"]["role"] != "assistant" {
            continue;
        }
        for part in message["parts"].as_array().into_iter().flatten() {
            if part["type"] != "tool" {
                continue;
            }
            let Some(key) = part["callID"].as_str().or(part["id"].as_str()) else {
                continue;
            };
            let status = part["state"]["status"]
                .as_str()
                .unwrap_or("pending")
                .to_string();
            if seen.get(key) == Some(&status) {
                continue;
            }
            seen.insert(key.to_string(), status.clone());
            let tool = part["tool"].as_str().unwrap_or("tool").to_string();
            let (label, target) = label_for(&tool, &part["state"]["input"]);
            events.push(PartEvent {
                kind: "tool",
                status,
                tool: Some(tool),
                label,
                target,
                call_id: part["callID"].as_str().map(str::to_string),
            });
        }
    }
    events
}

pub fn capture(
    app: &AppHandle,
    run_id: &str,
    session: &str,
    agent: &Employee,
    context: &Context,
    messages: &Value,
    seen: &mut HashMap<String, String>,
) {
    let events = diff(messages, seen);
    if events.is_empty() {
        return;
    }
    let Some(state) = app.try_state::<super::TeamsState>() else {
        return;
    };
    for event in events {
        let activity = Activity {
            seq: 0,
            at: now(),
            run_id: run_id.to_string(),
            task_id: context.task_id.clone(),
            attempt_id: context.attempt_id.clone(),
            agent_id: agent.id.clone(),
            agent_name: agent.name.clone(),
            session_id: session.to_string(),
            kind: event.kind.to_string(),
            status: event.status,
            tool: event.tool,
            label: event.label,
            target: event.target,
            call_id: event.call_id,
        };
        let stored = match state.activity.lock() {
            Ok(mut log) => log.push(activity),
            Err(_) => continue,
        };
        let _ = app.emit("team://activity", &stored);
    }
}

pub fn note(
    app: &AppHandle,
    run_id: &str,
    session: &str,
    agent: &Employee,
    context: &Context,
    kind: &str,
    status: &str,
    label: &str,
) {
    let Some(state) = app.try_state::<super::TeamsState>() else {
        return;
    };
    let activity = Activity {
        seq: 0,
        at: now(),
        run_id: run_id.to_string(),
        task_id: context.task_id.clone(),
        attempt_id: context.attempt_id.clone(),
        agent_id: agent.id.clone(),
        agent_name: agent.name.clone(),
        session_id: session.to_string(),
        kind: kind.to_string(),
        status: status.to_string(),
        tool: None,
        label: clamp(&sanitize(label), MAX_LABEL),
        target: None,
        call_id: None,
    };
    let stored = match state.activity.lock() {
        Ok(mut log) => log.push(activity),
        Err(_) => return,
    };
    let _ = app.emit("team://activity", &stored);
}

fn label_for(tool: &str, input: &Value) -> (String, Option<String>) {
    let field = |names: &[&str]| {
        names
            .iter()
            .find_map(|name| input[*name].as_str())
            .filter(|value| !value.is_empty())
    };
    let path = field(&["filePath", "path", "file", "filename"]);
    let command = field(&["command"]);
    let pattern = field(&["pattern"]);
    let url = field(&["url"]);
    let query = field(&["query"]);
    let target = path
        .or(command)
        .or(pattern)
        .or(url)
        .or(query)
        .map(|value| clamp(&sanitize(value), MAX_LABEL));
    let label = match tool {
        "read" => format!("Leyendo {}", path.unwrap_or("un archivo")),
        "edit" | "write" | "apply_patch" => {
            format!("Editando {}", path.unwrap_or("un archivo"))
        }
        "bash" | "terminal_terminal_run" => format!(
            "Ejecutando {}",
            command
                .map(|value| format!("`{}`", clamp(value, 90)))
                .unwrap_or_else(|| "un comando".into())
        ),
        "grep" => format!(
            "Buscando {}",
            pattern
                .map(|value| format!("`{}`", clamp(value, 80)))
                .unwrap_or_else(|| "en el proyecto".into())
        ),
        "glob" => format!(
            "Buscando archivos{}",
            pattern
                .map(|value| format!(" {}", clamp(value, 80)))
                .unwrap_or_default()
        ),
        "list" => format!("Listando {}", path.unwrap_or("la carpeta")),
        "webfetch" => format!("Leyendo {}", url.unwrap_or("una página web")),
        "websearch" => format!(
            "Buscando en la web{}",
            query
                .map(|value| format!(": {}", clamp(value, 90)))
                .unwrap_or_default()
        ),
        "todowrite" => "Actualizando el plan de pasos".into(),
        "todoread" => "Revisando el plan de pasos".into(),
        "task" => "Delegando una subtarea".into(),
        other => humanize(other),
    };
    (clamp(&sanitize(&label), MAX_LABEL), target)
}

fn humanize(tool: &str) -> String {
    let text = tool.replace(['_', '-'], " ");
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Herramienta".into(),
    }
}

fn clamp(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut shortened = flat.chars().take(max.saturating_sub(1)).collect::<String>();
    shortened.push('…');
    shortened
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session(parts: Value) -> Value {
        json!([{ "info": { "role": "assistant", "id": "m1" }, "parts": parts }])
    }

    #[test]
    fn emits_once_and_again_on_status_change() {
        let running = session(json!([{
            "type": "tool", "tool": "edit", "callID": "c1",
            "state": { "status": "running", "input": { "filePath": "src/app.tsx" } }
        }]));
        let mut seen = HashMap::new();
        let first = diff(&running, &mut seen);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].status, "running");
        assert_eq!(first[0].label, "Editando src/app.tsx");
        assert_eq!(first[0].target.as_deref(), Some("src/app.tsx"));

        assert!(diff(&running, &mut seen).is_empty());

        let completed = session(json!([{
            "type": "tool", "tool": "edit", "callID": "c1",
            "state": { "status": "completed", "input": { "filePath": "src/app.tsx" } }
        }]));
        let second = diff(&completed, &mut seen);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].status, "completed");
    }

    #[test]
    fn labels_commands_and_ignores_non_tool_parts() {
        let messages = session(json!([
            { "type": "text", "text": "Voy a correr las pruebas" },
            { "type": "tool", "tool": "bash", "callID": "c2", "state": { "status": "running", "input": { "command": "npm run build" } } }
        ]));
        let mut seen = HashMap::new();
        let events = diff(&messages, &mut seen);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].label, "Ejecutando `npm run build`");
        assert_eq!(events[0].call_id.as_deref(), Some("c2"));
    }

    #[test]
    fn seeding_history_is_not_replayed_after_first_call() {
        let messages = session(json!([{
            "type": "tool", "tool": "read", "callID": "old",
            "state": { "status": "completed", "input": { "filePath": "README.md" } }
        }]));
        let mut seen = HashMap::new();
        let _ = diff(&messages, &mut seen);
        assert!(diff(&messages, &mut seen).is_empty());
        assert_eq!(seen.get("old").map(String::as_str), Some("completed"));
    }
}
