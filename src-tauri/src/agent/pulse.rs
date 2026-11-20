use crate::agent::inbox::{self, InboxItem};
use crate::memory;
use crate::oc::Opencode;
use chrono::{Local, Timelike};
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const TICK_SECS: u64 = 60;
const RUN_TIMEOUT_SECS: u64 = 10 * 60;
const POLL_SECS: u64 = 5;
const ROOT_IDLE_MS: i64 = 10 * 60_000;
const EVERY_MINUTES_DEFAULT: u64 = 120;
const MAX_PER_DAY_DEFAULT: u64 = 4;
const HISTORY_LIMIT: usize = 20;
const TITLE_MAX: usize = 200;
const BODY_MAX: usize = 4_000;


#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Run { project: String },
    Skip { reason: String },
}

#[derive(Debug, Clone, PartialEq)]
struct ParsedItem {
    title: String,
    body: String,
    untrusted: bool,
}

#[derive(Debug, Clone)]
struct RunOutcome {
    text: String,
    session: String,
    aborted: bool,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone)]
struct TickResult {
    ran: bool,
    project: Option<String>,
    reason: Option<String>,
    item: Option<InboxItem>,
    session: Option<String>,
    error: Option<String>,
}

trait SessionRunner {
    fn run(&self, project: &str, prompt: &str, timeout: Duration) -> Result<RunOutcome, String>;
}

/// Arranca el hilo del pulso. El Vigía está apagado por defecto y no toca nada
/// hasta que el usuario lo enciende desde Mi Flufy.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(TICK_SECS));
        tick_once(&app);
    });
}

#[tauri::command]
pub fn agent_pulse_get(app: AppHandle) -> Value {
    let state = memory::agent_state(&app);
    let pulse = state["pulse"].clone();
    let enabled = pulse["enabled"].as_bool().unwrap_or(false);
    let today = Local::now().format("%Y-%m-%d").to_string();
    let runs_today = if pulse["lastRunDate"].as_str() == Some(today.as_str()) {
        pulse["runsToday"].as_u64().unwrap_or(0)
    } else {
        0
    };
    json!({ "enabled": enabled, "runsToday": runs_today, "pulse": pulse })
}

#[tauri::command]
pub fn agent_pulse_set(app: AppHandle, enabled: bool) -> Value {
    let mut state = memory::agent_state(&app);
    if !state["pulse"].is_object() {
        state["pulse"] = json!({
            "enabled": false,
            "quietHours": { "from": "22:00", "to": "08:00" },
            "maxPerDay": MAX_PER_DAY_DEFAULT
        });
    }
    state["pulse"]["enabled"] = json!(enabled);
    if enabled {
        state["pulse"]["lastSkipReason"] = Value::Null;
    }
    state["updated"] = json!(now_iso());
    match memory::save_agent_state(&app, &state) {
        Ok(()) => json!({ "ok": true, "enabled": enabled }),
        Err(error) => json!({ "ok": false, "enabled": enabled, "error": error }),
    }
}

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

fn now_minutes() -> u32 {
    let now = Local::now();
    now.hour() * 60 + now.minute()
}

fn to_minutes(value: &str) -> Option<u32> {
    let (hours, minutes) = value.trim().split_once(':')?;
    let hours: u32 = hours.trim().parse().ok()?;
    let minutes: u32 = minutes.trim().parse().ok()?;
    (hours < 24 && minutes < 60).then_some(hours * 60 + minutes)
}

fn quiet_range(value: &Value) -> Option<(u32, u32)> {
    match value {
        Value::String(text) => {
            let (from, to) = text.split_once('-')?;
            Some((to_minutes(from)?, to_minutes(to)?))
        }
        Value::Object(map) => {
            let from = map.get("from")?.as_str()?;
            let to = map.get("to")?.as_str()?;
            Some((to_minutes(from)?, to_minutes(to)?))
        }
        _ => None,
    }
}

fn in_quiet_hours(now: u32, quiet: &Value) -> bool {
    let Some((from, to)) = quiet_range(quiet) else { return false };
    if from == to {
        return false;
    }
    if from < to {
        now >= from && now < to
    } else {
        now >= from || now < to
    }
}

/// Tabla pura de condiciones. La entrada trae todo lo necesario para decidir;
/// la primera condición incumplida explica el salto.
pub fn decide(input: &Value) -> Decision {
    if !input["enabled"].as_bool().unwrap_or(false) {
        return Decision::Skip { reason: "el pulso está apagado".into() };
    }
    let Some(project) = input["project"].as_str().map(str::trim).filter(|p| !p.is_empty()) else {
        return Decision::Skip { reason: "no hay un proyecto reciente disponible".into() };
    };
    if input["updatePending"].as_bool().unwrap_or(false) {
        return Decision::Skip { reason: "hay una actualización en curso".into() };
    }
    if input["rootActive"].as_bool().unwrap_or(false) {
        return Decision::Skip { reason: "el usuario está trabajando en una sesión raíz".into() };
    }
    if in_quiet_hours(now_minutes_from(input), &input["quietHours"]) {
        return Decision::Skip { reason: "está dentro del horario silencioso".into() };
    }
    if let Some(elapsed) = input["minutesSinceLastRun"].as_f64() {
        let every = input["everyMinutes"].as_u64().unwrap_or(EVERY_MINUTES_DEFAULT).max(1) as f64;
        if elapsed < every {
            return Decision::Skip { reason: format!("todavía no pasaron {} minutos desde la última corrida", every as u64) };
        }
    }
    let runs_today = input["runsToday"].as_u64().unwrap_or(0);
    let max_per_day = input["maxPerDay"].as_u64().unwrap_or(MAX_PER_DAY_DEFAULT).max(1);
    if runs_today >= max_per_day {
        return Decision::Skip { reason: format!("se alcanzó el tope diario de {} corridas", max_per_day) };
    }
    if input["budget"].as_str() == Some("exhausted") {
        return Decision::Skip { reason: "el presupuesto de uso del día está agotado".into() };
    }
    if input["pressure"].as_str() == Some("critical") {
        return Decision::Skip { reason: "los recursos de la máquina están en estado crítico".into() };
    }
    Decision::Run { project: project.to_string() }
}

fn now_minutes_from(input: &Value) -> u32 {
    input["nowMinutes"].as_u64().map(|m| (m % 1440) as u32).unwrap_or_else(now_minutes)
}

fn tick_once(app: &AppHandle) {
    let state = memory::agent_state(app);
    let pulse = state["pulse"].clone();
    if !pulse["enabled"].as_bool().unwrap_or(false) {
        return;
    }
    let project = pick_project(&pulse, app);
    let mut input = json!({
        "enabled": true,
        "project": project,
        "updatePending": crate::updates::installing(app),
        "rootActive": false,
        "nowMinutes": now_minutes(),
        "quietHours": pulse["quietHours"].clone(),
        "minutesSinceLastRun": minutes_since(pulse["lastRunAt"].as_i64()),
        "everyMinutes": pulse["everyMinutes"].as_u64().unwrap_or(EVERY_MINUTES_DEFAULT),
        "runsToday": runs_today(&pulse),
        "maxPerDay": pulse["maxPerDay"].as_u64().unwrap_or(MAX_PER_DAY_DEFAULT),
        "budget": "unknown",
        "pressure": crate::resources::pressure(app),
    });
    if let Decision::Skip { reason } = decide(&input) {
        record_skip(app, &reason);
        return;
    }
    let directory = input["project"].as_str().unwrap_or_default().to_string();
    input["rootActive"] = json!(root_session_recent(app, &directory));
    if let Decision::Skip { reason } = decide(&input) {
        record_skip(app, &reason);
        return;
    }
    input["budget"] = json!(if usage_exhausted() { "exhausted" } else { "ok" });
    if let Decision::Skip { reason } = decide(&input) {
        record_skip(app, &reason);
        return;
    }
    mark_run_started(app);
    let runner = LiveRunner { app: app.clone() };
    let result = run_tick(&input, &runner);
    apply_result(app, result);
}

fn pick_project(pulse: &Value, app: &AppHandle) -> Option<String> {
    let configured: Vec<String> = pulse["projects"]
        .as_array()
        .map(|list| list.iter().filter_map(|value| value.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if !configured.is_empty() {
        return configured.into_iter().find(|path| Path::new(path).is_dir());
    }
    crate::recent_project_list(app).into_iter().next()
}

fn minutes_since(last_ms: Option<i64>) -> Option<f64> {
    last_ms.map(|last| ((now_ms() - last).max(0) as f64) / 60_000.0)
}

fn runs_today(pulse: &Value) -> u64 {
    let today = Local::now().format("%Y-%m-%d").to_string();
    if pulse["lastRunDate"].as_str() == Some(today.as_str()) {
        pulse["runsToday"].as_u64().unwrap_or(0)
    } else {
        0
    }
}

fn root_session_recent(app: &AppHandle, directory: &str) -> bool {
    if app.try_state::<crate::live::LiveState>().is_some() && !crate::live::busy_sessions(app).is_empty() {
        return true;
    }
    let Ok(server) = crate::ensure_server(app) else { return false };
    let Ok(list) = Opencode::new(&server, directory).get("/session") else { return false };
    let cutoff = now_ms() - ROOT_IDLE_MS;
    list.as_array().into_iter().flatten().any(|session| {
        let root = session["parentID"].as_str().map_or(true, |parent| parent.is_empty());
        root && session["time"]["updated"].as_i64().is_some_and(|updated| updated >= cutoff)
    })
}

/// No hay dato de presupuesto cuando el proveedor no responde: se sigue.
fn usage_exhausted() -> bool {
    if let Ok(chatgpt) = crate::usage::chatgpt_snapshot() {
        if chatgpt.limit_reached {
            return true;
        }
    }
    if let Ok(go) = crate::usage::go_snapshot() {
        if go.windows.iter().any(|window| window.used_percent >= 100.0) {
            return true;
        }
    }
    false
}

fn record_skip(app: &AppHandle, reason: &str) {
    let mut state = memory::agent_state(app);
    if state["pulse"]["lastSkipReason"].as_str() == Some(reason) {
        return;
    }
    state["pulse"]["lastSkipReason"] = json!(reason);
    state["pulse"]["lastSkipAt"] = json!(now_iso());
    state["updated"] = json!(now_iso());
    let _ = memory::save_agent_state(app, &state);
}

fn mark_run_started(app: &AppHandle) {
    let mut state = memory::agent_state(app);
    if !state["pulse"].is_object() {
        return;
    }
    let today = Local::now().format("%Y-%m-%d").to_string();
    if state["pulse"]["lastRunDate"].as_str() != Some(today.as_str()) {
        state["pulse"]["lastRunDate"] = json!(today);
        state["pulse"]["runsToday"] = json!(0);
    }
    let runs = state["pulse"]["runsToday"].as_u64().unwrap_or(0) + 1;
    state["pulse"]["runsToday"] = json!(runs);
    state["pulse"]["lastRunAt"] = json!(now_ms());
    state["pulse"]["lastSkipReason"] = Value::Null;
    state["updated"] = json!(now_iso());
    let _ = memory::save_agent_state(app, &state);
}

fn apply_result(app: &AppHandle, result: TickResult) {
    let mut entry = json!({
        "at": now_iso(),
        "project": result.project.clone(),
        "session": result.session.clone(),
        "status": if result.error.is_some() { "error" } else { "ok" },
    });
    if let Some(item) = &result.item {
        match inbox::add(app, item) {
            Ok(saved) => {
                entry["item"] = json!(saved.id);
                let _ = memory::log_append(app, "done", &format!("Vigía: {}", item.title), Some(&saved.id), result.project.as_deref());
            }
            Err(error) => {
                entry["status"] = json!("error");
                entry["error"] = json!(error.clone());
                let _ = memory::log_append(app, "blocked", &format!("El Vigía no pudo guardar el ítem: {}", error), None, result.project.as_deref());
            }
        }
    } else if let Some(error) = &result.error {
        entry["error"] = json!(error.clone());
        let _ = memory::log_append(app, "blocked", &format!("El Vigía no terminó la corrida: {}", error), None, result.project.as_deref());
    }
    let mut state = memory::agent_state(app);
    let mut history = state["pulse"]["lastPulses"].as_array().cloned().unwrap_or_default();
    history.insert(0, entry);
    history.truncate(HISTORY_LIMIT);
    state["pulse"]["lastPulses"] = Value::Array(history);
    state["pulse"]["lastSkipReason"] = Value::Null;
    state["updated"] = json!(now_iso());
    let _ = memory::save_agent_state(app, &state);
}

fn run_tick<R: SessionRunner + ?Sized>(input: &Value, runner: &R) -> TickResult {
    let project = match decide(input) {
        Decision::Skip { reason } => {
            return TickResult { ran: false, project: None, reason: Some(reason), item: None, session: None, error: None };
        }
        Decision::Run { project } => project,
    };
    let mut result = TickResult {
        ran: true,
        project: Some(project.clone()),
        reason: None,
        item: None,
        session: None,
        error: None,
    };
    match runner.run(&project, crate::desktop::agent::VIGIA_PROMPT, Duration::from_secs(RUN_TIMEOUT_SECS)) {
        Ok(outcome) => {
            result.session = Some(outcome.session.clone());
            if outcome.aborted {
                result.error = Some("la corrida superó los 10 minutos y se abortó".into());
                return result;
            }
            if let Some(parsed) = parse_item(&outcome.text) {
                result.item = Some(InboxItem {
                    id: String::new(),
                    at: String::new(),
                    kind: "insight".into(),
                    title: parsed.title,
                    body: parsed.body,
                    session: Some(outcome.session),
                    directory: Some(project),
                    untrusted: parsed.untrusted,
                    acked_at: None,
                    ..Default::default()
                });
            }
        }
        Err(error) => result.error = Some(error),
    }
    result
}

fn parse_item(text: &str) -> Option<ParsedItem> {
    let mut blocks: Vec<Value> = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("```") {
        let after = &rest[start + 3..];
        let Some(end) = after.find("```") else { break };
        let raw = after[..end].trim().strip_prefix("json").unwrap_or(after[..end].trim()).trim();
        if let Ok(value) = serde_json::from_str::<Value>(raw) {
            blocks.push(value);
        }
        rest = &after[end + 3..];
    }
    let value = blocks.pop()?;
    let title = value["title"]
        .as_str()?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() {
        return None;
    }
    let body = value["body"].as_str().unwrap_or_default().trim().to_string();
    Some(ParsedItem {
        title: title.chars().take(TITLE_MAX).collect(),
        body: body.chars().take(BODY_MAX).collect(),
        untrusted: value["untrusted"].as_bool().unwrap_or(false),
    })
}

fn assistant_text(messages: &Value) -> String {
    let last = messages
        .as_array()
        .and_then(|list| list.iter().rev().find(|message| message["info"]["role"] == "assistant"));
    last.and_then(|message| message["parts"].as_array())
        .map(|parts| {
            parts
                .iter()
                .filter(|part| part["type"] == "text" && !part["synthetic"].as_bool().unwrap_or(false))
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

struct LiveRunner {
    app: AppHandle,
}

impl SessionRunner for LiveRunner {
    fn run(&self, project: &str, prompt: &str, timeout: Duration) -> Result<RunOutcome, String> {
        let server = crate::ensure_server(&self.app)?;
        let client = Opencode::new(&server, project);
        let title = format!("Vigía — {} {}", Local::now().format("%Y-%m-%d"), Local::now().format("%H:%M"));
        let session = client.post("/session", json!({ "title": title }))?;
        let id = session["id"].as_str().ok_or("OpenCode no devolvió la sesión del Vigía")?.to_string();
        let body = json!({ "parts": [{ "type": "text", "text": prompt }], "agent": "vigia" });
        client.post(&format!("/session/{}/prompt_async", id), body)?;
        let started = Instant::now();
        let mut seen_busy = false;
        loop {
            std::thread::sleep(Duration::from_secs(POLL_SECS));
            let statuses = client.get("/session/status").unwrap_or(Value::Null);
            let busy = statuses[&id]["type"].as_str().map(|kind| kind != "idle").unwrap_or(false);
            seen_busy |= busy;
            if !busy && (seen_busy || started.elapsed().as_secs() > 20) {
                break;
            }
            if started.elapsed() >= timeout {
                let _ = client.post(&format!("/session/{}/abort", id), json!({}));
                return Ok(RunOutcome { text: String::new(), session: id, aborted: true });
            }
        }
        let messages = client.get(&format!("/session/{}/message", id))?;
        Ok(RunOutcome { text: assistant_text(&messages), session: id, aborted: false })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::PathBuf;

    fn base_input() -> Value {
        json!({
            "enabled": true,
            "project": "C:/proyecto",
            "updatePending": false,
            "rootActive": false,
            "nowMinutes": 12 * 60,
            "quietHours": { "from": "22:00", "to": "08:00" },
            "minutesSinceLastRun": null,
            "everyMinutes": 120,
            "runsToday": 0,
            "maxPerDay": 3,
            "budget": "ok",
            "pressure": "normal"
        })
    }

    fn reason(input: &Value) -> String {
        match decide(input) {
            Decision::Skip { reason } => reason,
            Decision::Run { project } => panic!("se esperaba un salto y corrió en {}", project),
        }
    }

    #[test]
    fn disabled_pulse_does_not_run() {
        let mut input = base_input();
        input["enabled"] = json!(false);
        assert_eq!(reason(&input), "el pulso está apagado");
    }

    #[test]
    fn missing_recent_project_skips() {
        let mut input = base_input();
        input["project"] = Value::Null;
        assert_eq!(reason(&input), "no hay un proyecto reciente disponible");
    }

    #[test]
    fn pending_update_skips() {
        let mut input = base_input();
        input["updatePending"] = json!(true);
        assert_eq!(reason(&input), "hay una actualización en curso");
    }

    #[test]
    fn active_root_session_skips() {
        let mut input = base_input();
        input["rootActive"] = json!(true);
        assert_eq!(reason(&input), "el usuario está trabajando en una sesión raíz");
    }

    #[test]
    fn quiet_hours_cover_overnight_and_ranges() {
        let mut input = base_input();
        input["nowMinutes"] = json!(23 * 60);
        assert_eq!(reason(&input), "está dentro del horario silencioso");
        input["nowMinutes"] = json!(7 * 60 + 59);
        assert_eq!(reason(&input), "está dentro del horario silencioso");
        input["nowMinutes"] = json!(8 * 60);
        assert!(matches!(decide(&input), Decision::Run { .. }));
        input["quietHours"] = json!({ "from": "09:00", "to": "10:00" });
        input["nowMinutes"] = json!(9 * 60 + 30);
        assert_eq!(reason(&input), "está dentro del horario silencioso");
        input["quietHours"] = json!("09:00-10:00");
        assert_eq!(reason(&input), "está dentro del horario silencioso");
    }

    #[test]
    fn interval_between_runs_is_respected() {
        let mut input = base_input();
        input["minutesSinceLastRun"] = json!(30.0);
        assert_eq!(reason(&input), "todavía no pasaron 120 minutos desde la última corrida");
        input["minutesSinceLastRun"] = json!(120.0);
        assert!(matches!(decide(&input), Decision::Run { .. }));
    }

    #[test]
    fn daily_limit_skips() {
        let mut input = base_input();
        input["runsToday"] = json!(3);
        assert_eq!(reason(&input), "se alcanzó el tope diario de 3 corridas");
    }

    #[test]
    fn exhausted_budget_skips() {
        let mut input = base_input();
        input["budget"] = json!("exhausted");
        assert_eq!(reason(&input), "el presupuesto de uso del día está agotado");
    }

    #[test]
    fn unknown_budget_still_runs() {
        let mut input = base_input();
        input["budget"] = json!("unknown");
        assert!(matches!(decide(&input), Decision::Run { .. }));
    }

    #[test]
    fn critical_resources_skip() {
        let mut input = base_input();
        input["pressure"] = json!("critical");
        assert_eq!(reason(&input), "los recursos de la máquina están en estado crítico");
        input["pressure"] = json!("tight");
        assert!(matches!(decide(&input), Decision::Run { .. }));
    }

    #[test]
    fn parse_item_reads_only_the_last_json_block() {
        let text = "antes\n```json\n{\"title\":\"viejo\",\"body\":\"x\"}\n```\n```json\n{\"title\":\"  Proyecto   sin tests  \",\"body\":\"Faltan pruebas\",\"untrusted\":true}\n```";
        let parsed = parse_item(text).expect("debe leer el bloque final");
        assert_eq!(parsed.title, "Proyecto sin tests");
        assert_eq!(parsed.body, "Faltan pruebas");
        assert!(parsed.untrusted);
    }

    #[test]
    fn parse_item_ignores_sin_novedades_and_empty_titles() {
        assert!(parse_item("sin novedades").is_none());
        assert!(parse_item("```json\n{\"title\":\"   \",\"body\":\"x\"}\n```").is_none());
        assert!(parse_item("```json\n{\"title\":\"algo\"}\n```").is_some());
    }

    struct ReadOnlyRunner;

    impl SessionRunner for ReadOnlyRunner {
        fn run(&self, project: &str, _prompt: &str, _timeout: Duration) -> Result<RunOutcome, String> {
            read_tree(Path::new(project))?;
            Ok(RunOutcome { text: "sin novedades".into(), session: "test-session".into(), aborted: false })
        }
    }

    fn read_tree(root: &Path) -> Result<(), String> {
        let entries = fs::read_dir(root).map_err(|e| e.to_string())?;
        for entry in entries {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.is_dir() {
                read_tree(&path)?;
            } else if path.is_file() {
                fs::read(&path).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    fn files_in(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let Ok(entries) = fs::read_dir(root) else { return out };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(files_in(&path));
            } else if path.is_file() {
                out.push(path);
            }
        }
        out.sort();
        out
    }

    fn tree_hash(root: &Path) -> String {
        let mut hasher = Sha256::new();
        for path in files_in(root) {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            hasher.update(rel.as_bytes());
            hasher.update([0u8]);
            hasher.update(fs::read(&path).unwrap_or_default());
            hasher.update([0u8]);
        }
        format!("{:x}", hasher.finalize())
    }

    #[test]
    fn pulse_tick_is_read_only() {
        let Some(project) = std::env::var("FLUFY_PULSE_TEST_PROJECT").ok().filter(|path| !path.trim().is_empty()) else {
            eprintln!("FLUFY_PULSE_TEST_PROJECT no está definido: se omite la corrida real");
            return;
        };
        let root = Path::new(&project);
        let before = tree_hash(root);
        let mut input = base_input();
        input["project"] = json!(project);
        let result = run_tick(&input, &ReadOnlyRunner);
        assert!(result.ran, "el tick debía correr: {:?}", result.reason);
        assert!(result.item.is_none(), "sin novedades no debe crear un ítem de bandeja");
        let after = tree_hash(root);
        assert_eq!(before, after, "el tick modificó archivos del proyecto vigilado");
        println!("pulse_read_only_ok");
    }
}
