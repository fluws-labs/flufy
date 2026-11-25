use crate::memory;
use chrono::TimeZone;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectExperiment {
    pub id: String,
    pub title: String,
    pub hypothesis: String,
    pub metric: String,
    pub target: String,
    pub status: String,
    pub started_at: i64,
    pub ends_at: i64,
    pub result: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectState {
    pub project: String,
    pub current_bet: String,
    pub metric: String,
    pub target: String,
    pub experiments: Vec<ProjectExperiment>,
    pub decisions: Vec<String>,
    pub blockers: Vec<String>,
    pub last_evidence: String,
    pub updated_at: i64,
}

fn key(project: &str) -> String {
    let mut hasher = DefaultHasher::new();
    project.to_lowercase().hash(&mut hasher);
    let slug = project
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(40)
        .collect::<String>();
    format!("{}-{:x}", if slug.is_empty() { "proyecto" } else { &slug }, hasher.finish())
}

fn state_path(app: &AppHandle, project: &str) -> PathBuf {
    memory::agent_root(app).join("projects").join(format!("{}.json", key(project)))
}

fn clipped(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

fn string_list(value: Option<&Value>, max_items: usize, max_chars: usize) -> Vec<String> {
    value
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(|item| clipped(item, max_chars))
                .filter(|item| !item.is_empty())
                .take(max_items)
                .collect()
        })
        .unwrap_or_default()
}

pub fn get(app: &AppHandle, project: &str) -> ProjectState {
    let path = state_path(app, project);
    let mut state = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<ProjectState>(&text).ok())
        .unwrap_or_default();
    if state.project.trim().is_empty() {
        state.project = project.to_string();
    }
    state
}

pub fn set(app: &AppHandle, project: &str, input: &Value) -> Result<ProjectState, String> {
    let mut state = get(app, project);
    for (field, target) in [
        ("currentBet", &mut state.current_bet),
        ("metric", &mut state.metric),
        ("target", &mut state.target),
        ("lastEvidence", &mut state.last_evidence),
    ] {
        if let Some(value) = input.get(field).and_then(|value| value.as_str()) {
            *target = clipped(value, 1200);
        }
    }
    if input.get("decisions").is_some() {
        state.decisions = string_list(input.get("decisions"), 20, 500);
    }
    if input.get("blockers").is_some() {
        state.blockers = string_list(input.get("blockers"), 20, 500);
    }
    if let Some(items) = input.get("experiments").and_then(|value| value.as_array()) {
        state.experiments = items
            .iter()
            .take(20)
            .filter_map(|item| {
                let id = item["id"].as_str().map(str::trim).filter(|value| !value.is_empty())?;
                Some(ProjectExperiment {
                    id: clipped(id, 100),
                    title: clipped(item["title"].as_str().unwrap_or_default(), 300),
                    hypothesis: clipped(item["hypothesis"].as_str().unwrap_or_default(), 700),
                    metric: clipped(item["metric"].as_str().unwrap_or_default(), 400),
                    target: clipped(item["target"].as_str().unwrap_or_default(), 400),
                    status: clipped(item["status"].as_str().unwrap_or("running"), 40),
                    started_at: item["startedAt"].as_i64().unwrap_or(0),
                    ends_at: item["endsAt"].as_i64().unwrap_or(0),
                    result: clipped(item["result"].as_str().unwrap_or_default(), 700),
                })
            })
            .collect();
    }
    state.project = project.to_string();
    state.updated_at = chrono::Local::now().timestamp_millis();
    let path = state_path(app, project);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    memory::atomic_write(&path, &serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?)?;
    Ok(state)
}

/// Resumen corto para inyectar en el prompt de la misión.
pub fn summary(app: &AppHandle, project: &str) -> String {
    let state = get(app, project);
    if state.current_bet.trim().is_empty()
        && state.metric.trim().is_empty()
        && state.experiments.is_empty()
        && state.decisions.is_empty()
        && state.blockers.is_empty()
    {
        return String::new();
    }
    let experiments = state
        .experiments
        .iter()
        .filter(|experiment| experiment.status == "running")
        .map(|experiment| {
            let ends = if experiment.ends_at > 0 {
                chrono::Local
                    .timestamp_millis_opt(experiment.ends_at)
                    .single()
                    .map(|date| date.format("%Y-%m-%d").to_string())
                    .unwrap_or_else(|| experiment.ends_at.to_string())
            } else {
                "sin fecha".into()
            };
            format!("- {} ({}) hasta {}", experiment.title, experiment.id, ends)
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "\n## Estado del proyecto\n- Bet actual: {}\n- Métrica norte: {} / umbral {}\n- Experimentos en ventana:\n{}\n- Decisiones abiertas: {}\n- Bloqueos: {}\n- Última evidencia: {}\n",
        if state.current_bet.trim().is_empty() { "sin definir" } else { state.current_bet.as_str() },
        if state.metric.trim().is_empty() { "sin definir" } else { state.metric.as_str() },
        if state.target.trim().is_empty() { "sin definir" } else { state.target.as_str() },
        if experiments.is_empty() { "- ninguno".into() } else { experiments },
        if state.decisions.is_empty() { "ninguna".into() } else { state.decisions.join("; ") },
        if state.blockers.is_empty() { "ninguno".into() } else { state.blockers.join("; ") },
        if state.last_evidence.trim().is_empty() { "sin registrar".into() } else { state.last_evidence.as_str() },
    )
}

pub fn overview(app: &AppHandle, project: &str) -> Value {
    json!({ "state": get(app, project), "summary": summary(app, project) })
}
