use super::domain::*;
use serde_json::Value;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuousFallback {
    pub enabled: bool,
    pub original_model: ModelRef,
    pub original_variant: Option<String>,
    pub current_model: ModelRef,
    pub candidates: Vec<ModelRef>,
    pub next_index: usize,
    pub restored: bool,
}

impl ContinuousFallback {
    pub fn new(enabled: bool, original_model: ModelRef, original_variant: Option<String>, models: &[ModelRef]) -> Result<Self, String> {
        if enabled && models.is_empty() { return Err("Configurá Modelos Fallback antes de activar el modo continuo".into()); }
        let mut candidates = Vec::new();
        for model in models {
            if model != &original_model && !candidates.contains(model) { candidates.push(model.clone()); }
        }
        Ok(Self { enabled, current_model: original_model.clone(), original_model, original_variant, candidates, next_index: 0, restored: false })
    }

    pub fn advance(&mut self, failed: &ModelRef) -> Result<ModelRef, String> {
        if !self.enabled || self.restored { return Err("Modo continuo desactivado".into()); }
        // Called within the store transaction: late failures reuse the committed model.
        if self.next_index > 0 && failed != &self.current_model { return Ok(self.current_model.clone()); }
        let next = self.candidates.get(self.next_index).ok_or("Se agotaron los Modelos Fallback. El trabajo se conserva; configurá otro modelo y reintentá")?.clone();
        self.next_index += 1;
        self.current_model = next.clone();
        Ok(next)
    }

    pub fn restore(&mut self) {
        self.current_model = self.original_model.clone();
        self.restored = true;
    }

    pub fn resume(&mut self) {
        self.current_model = self.next_index.checked_sub(1).and_then(|i| self.candidates.get(i))
            .cloned().unwrap_or_else(|| self.original_model.clone());
        self.restored = false;
    }
}

pub(super) fn validate_models(models: &[ModelRef]) -> Result<(), String> {
    if models.len() > 100 { return Err("La lista admite hasta 100 modelos".into()); }
    for (i, model) in models.iter().enumerate() {
        if model.provider_id.trim().is_empty() || model.model_id.trim().is_empty()
            || model.provider_id.len() > 256 || model.model_id.len() > 512
            || models[..i].contains(model) {
            return Err("Seleccioná modelos válidos sin duplicados".into());
        }
    }
    Ok(())
}

pub(super) fn confirmed_limit(error: &Value) -> bool {
    if error["name"] != "APIError" { return false; }
    let data = &error["data"];
    if [400,401,403,404,413].iter().any(|n| data["statusCode"].as_i64() == Some(*n)) { return false; }
    fn recognized(value: &Value, depth: usize) -> bool {
        if depth > 8 { return false; }
        match value {
            Value::String(s) => {
                if let Ok(value) = serde_json::from_str::<Value>(s) { return recognized(&value, depth + 1); }
                let text = s.to_lowercase();
                ["usage_limit_reached", "subscription_sharing_usage_limit_exceeded", "rate_limit_exceeded",
                    "insufficient_quota", "quota exceeded", "usage limit has been reached", "rate limit exceeded",
                    "monthly spending limit", "insufficient credits", "out of credits"].iter().any(|code| text.contains(code))
            }
            Value::Object(record) => ["code","type","message","error","responseBody"].iter()
                .filter_map(|key| record.get(*key)).any(|v| recognized(v, depth + 1)),
            _ => false,
        }
    }
    data["statusCode"].as_i64() == Some(429) || recognized(data, 0)
}

pub(super) fn safe_to_continue(messages: &Value, previous: &std::collections::HashSet<String>, last: &Value) -> bool {
    settled_tools(messages) && last["info"]["time"]["completed"].as_i64().is_some() && messages.as_array().is_some_and(|items| items.iter()
        .filter(|m| m["info"]["role"] == "assistant" && !m["info"]["id"].as_str().is_some_and(|id| previous.contains(id)))
        .all(|m| m["parts"].as_array().is_some_and(|parts| parts.iter().all(|p| p["type"] != "tool"
            || p["state"]["status"] == "completed"))))
}

pub(super) fn snapshot_for_run(chat: &Chat, models: &[ModelRef], source_reply: Option<&str>) -> Result<Option<ContinuousFallback>, String> {
    if let Some(reply) = source_reply {
        return chat.messages.iter().find(|m| m.id == reply && m.status == "pending")
            .map(|m| m.continuous_fallback.clone()).ok_or("Pedido detenido; no se inició una ejecución nueva".into());
    }
    if !chat.continuous_mode { return Ok(None); }
    let lead = chat.team.members.iter().find(|m| m.id == chat.team.lead_agent_id).ok_or("Falta el Lead")?;
    ContinuousFallback::new(true, lead.model.clone(), lead.variant.clone(), models).map(Some)
}

pub(super) fn snapshot_for_message(chat: &Chat, models: &[ModelRef], run_id: Option<&str>) -> Result<Option<ContinuousFallback>, String> {
    if let Some(message) = chat.messages.iter().rev().find(|m| m.role == "assistant" && m.status == "complete"
        && m.run_id.as_deref() == run_id && m.clarification_start.is_some()) {
        // Absence is itself the accepted snapshot for legacy/non-continuous
        // requests. Do not enable fallback halfway through their clarification.
        return Ok(message.continuous_fallback.clone());
    }
    snapshot_for_run(chat, models, None)
}

/// An unfinished/failed tool may have applied an effect before losing its acknowledgement.
/// Never send a recovery prompt until that uncertainty has been reconciled externally.
pub(super) fn settled_tools(messages: &Value) -> bool {
    messages.as_array().is_some_and(|items| items.iter().all(|m|
        m["parts"].as_array().is_some_and(|parts| parts.iter().all(|p|
            p["type"] != "tool" || p["state"]["status"] == "completed"))))
}

/// Only fresh native account-level readings; transport/auth failures are not exhaustion.
pub(super) fn exhausted(model: &ModelRef) -> bool {
    match model.provider_id.as_str() {
        "openai" => crate::usage::chatgpt_snapshot().is_ok_and(|q| fresh_exhaustion(now(), q.measured_at, q.limit_reached, &q.windows)),
        "opencode-go" => crate::usage::go_snapshot().is_ok_and(|q| fresh_exhaustion(now(), q.measured_at, false, &q.windows)),
        _ => false,
    }
}

fn fresh_exhaustion(current: i64, measured: i64, limit: bool, windows: &[crate::usage::QuotaWindow]) -> bool {
    measured <= current && current.saturating_sub(measured) < 60_000
        && (limit || windows.iter().any(|w| w.used_percent.is_finite() && w.used_percent >= 100.0
            && w.resets_at.is_some_and(|reset| reset > current)))
}

pub(super) fn employee(run: &Run, original: &Employee) -> Employee {
    let mut employee = original.clone();
    if let Some(state) = run.continuous_fallback.as_ref().filter(|s| s.enabled && !s.restored && (s.next_index > 0 || original.id == run.team.lead_agent_id)) {
        employee.model = state.current_model.clone();
        employee.variant = if state.next_index == 0 { state.original_variant.clone() } else { None };
    }
    employee
}

pub(super) fn transition(app: &tauri::AppHandle, run_id: &str, failed: &ModelRef) -> Result<ModelRef,String> {
    super::update_run(app, run_id, |run| {
        if !["planning","running","delivering"].contains(&run.status.as_str()) {
            return Err("La ejecución está detenida; no se cambió el modelo".into());
        }
        let state = run.continuous_fallback.as_mut().ok_or("Modo continuo desactivado")?;
        let before = state.next_index;
        let next = state.advance(failed)?;
        if state.next_index != before {
            run.configuration_changes.push(serde_json::json!({"kind":"continuousFallback","at":now(),"from":failed,"to":next}));
        }
        Ok(next)
    })
}

pub(super) fn continuation_parts() -> Value {
    serde_json::json!([{"type":"text","text":"El proveedor alcanzó su cuota. Continuá desde el estado y los resultados ya registrados en esta sesión; no repitas operaciones completadas. Conservá el objetivo, permisos y formato de respuesta original."}])
}

pub(super) fn transition_message(app: &tauri::AppHandle, chat_id: &str, reply_id: &str, failed: &ModelRef) -> Result<ModelRef, String> {
    super::update(app, |store| {
        let chat = store.chats.iter_mut().find(|c| c.id == chat_id).ok_or("Chat inexistente")?;
        let end = chat.messages.iter().position(|m| m.id == reply_id && m.status == "pending").ok_or("Pedido detenido; no se cambió el modelo")?;
        let state = chat.messages[end].continuous_fallback.as_mut().ok_or("Modo continuo desactivado")?;
        let next = state.advance(failed)?;
        let snapshot = state.clone();
        if let Some(user) = chat.messages[..end].iter_mut().rev().find(|m| m.role == "user") {
            user.continuous_fallback = Some(snapshot);
        }
        Ok(next)
    })
}

pub(super) fn restore_finished(store: &mut Store) {
    for chat in &mut store.chats {
        for message in &mut chat.messages {
            if message.role == "assistant" && message.status != "pending" && message.clarification_start.is_none() {
                if let Some(state) = message.continuous_fallback.as_mut().filter(|s| !s.restored) { state.restore(); }
            }
        }
        for run in &mut chat.runs {
            if !["completed","awaiting_manual_qa","qa_approved","cancelled","failed"].contains(&run.status.as_str()) { continue; }
            let Some(state) = run.continuous_fallback.as_mut().filter(|s| !s.restored) else { continue; };
            state.restore();
            // Chat configuration is the user's current choice, not run-owned state.
            // Restoring a historical run must never overwrite a newer selection.
            run.configuration_changes.push(serde_json::json!({"kind":"continuousFallbackRestored","at":now(),"model":state.original_model,"variant":state.original_variant}));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(id: &str) -> ModelRef {
        ModelRef { provider_id: "test".into(), model_id: id.into() }
    }

    #[test]
    fn confirmed_provider_limits_only() {
        for code in ["usage_limit_reached", "insufficient_quota", "rate_limit_exceeded"] {
            assert!(confirmed_limit(&json!({"name":"APIError","data":{"message":code}})));
        }
        for error in [json!("quota exceeded"), json!({"name":"ToolError","data":{"message":"quota exceeded"}}),
            json!({"name":"APIError","data":{"statusCode":401,"message":"quota exceeded"}}),
            json!({"name":"APIError","data":{"statusCode":403,"message":"quota exceeded"}}),
            json!({"name":"APIError","data":{"statusCode":503,"message":"network error"}}),
            json!({"name":"PermissionDenied","data":{"statusCode":429}}),
            json!({"name":"APIError","data":{"message":"network error"}}),
            json!({"name":"APIError","data":{"message":"invalid_request"}})] {
            assert!(!confirmed_limit(&error));
        }
    }

    #[test]
    fn ordered_candidates_are_deduplicated_and_survive_restart() {
        let mut state = ContinuousFallback::new(true, model("a"), Some("high".into()), &[model("a"),model("b"),model("b"),model("c")]).unwrap();
        assert_eq!(state.current_model, model("a"));
        assert_eq!(state.advance(&model("a")).unwrap(), model("b"));
        // A late error from another session using a must reuse b, not consume c.
        assert_eq!(state.advance(&model("a")).unwrap(), model("b"));
        state = serde_json::from_value(serde_json::to_value(&state).unwrap()).unwrap();
        assert_eq!(state.advance(&model("b")).unwrap(), model("c"));
        assert!(state.advance(&model("c")).is_err());
        state.restore();
        assert!(state.restored);
        assert_eq!(state.current_model, model("a"));
        assert_eq!(state.original_variant.as_deref(), Some("high"));
    }

    #[test]
    fn empty_enabled_list_is_rejected_but_disabled_is_compatible() {
        assert!(ContinuousFallback::new(true, model("a"), None, &[]).is_err());
        let mut state = ContinuousFallback::new(false, model("a"), None, &[]).unwrap();
        assert!(state.advance(&model("a")).is_err());
        let store: Store = serde_json::from_value(json!({"schemaVersion":3,"teams":[],"skills":[],"chats":[]})).unwrap();
        assert!(store.fallback_models.is_empty());
    }

    fn chat() -> Chat {
        serde_json::from_value(json!({"id":"chat","title":"Prueba","archived":false,
            "continuousMode":true,"team":super::super::domain::tests::team(),"skills":[],"createdAt":1,"runs":[]})).unwrap()
    }

    fn saved_run(state: &ContinuousFallback, status: &str) -> Run {
        serde_json::from_value(json!({"id":"run","goal":"Prueba","team":super::super::domain::tests::team(),
            "skills":[],"status":status,"startedAt":1,"tasks":[{"id":"done","title":"Terminada","objective":"Prueba",
            "assignedAgentId":"lead","repository":"D:/repo","dependencies":[],"expectedFiles":[],"acceptanceCriteria":[],
            "status":"completed","attempts":[]}],"summary":"","evidenceDir":"unused","artifacts":[],"baseline":[],
            "notified":false,"continuousFallback":state,"planSessionId":"preserved-session"})).unwrap()
    }

    #[test]
    fn sqlite_roundtrip_inherits_initial_snapshot_not_later_chat_configuration() {
        let mut c = chat();
        let mut original = ContinuousFallback::new(true, model("original"), Some("high".into()), &[model("b"),model("c")]).unwrap();
        original.advance(&model("original")).unwrap();
        c.messages.push(serde_json::from_value(json!({"id":"reply","role":"assistant","text":"","createdAt":1,
            "status":"pending","continuousFallback":original})).unwrap());
        c.team.members[0].model = model("later-choice");
        c.team.members[0].variant = Some("later-variant".into());
        let mut store = super::super::empty();
        store.chats.push(c);
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE team_store (id INTEGER PRIMARY KEY, document TEXT NOT NULL)").unwrap();
        super::super::write_db(&mut db, &store).unwrap();
        let mut loaded = super::super::read_db(&db).unwrap();
        let inherited = snapshot_for_run(&loaded.chats[0], &[model("new-global-list")], Some("reply")).unwrap().unwrap();
        assert_eq!(serde_json::to_value(&inherited).unwrap(), serde_json::to_value(&original).unwrap());
        loaded.chats[0].runs.push(saved_run(&inherited, "running"));
        super::super::write_db(&mut db, &loaded).unwrap();
        let mut recovered = super::super::read_db(&db).unwrap();
        super::super::recover(&mut recovered);
        let run = &mut recovered.chats[0].runs[0];
        assert_eq!(run.plan_session_id.as_deref(), Some("preserved-session"));
        assert_eq!(run.tasks[0].status, "completed");
        let state = run.continuous_fallback.as_mut().unwrap();
        assert_eq!(state.next_index, 1);
        assert_eq!(state.advance(&model("original")).unwrap(), model("b"));
        assert_eq!(state.advance(&model("b")).unwrap(), model("c"));
    }

    #[test]
    fn concurrent_errors_consume_one_candidate_and_restart_keeps_the_boundary() {
        let state = std::sync::Arc::new(std::sync::Mutex::new(
            ContinuousFallback::new(true, model("a"), None, &[model("b"),model("c")]).unwrap()));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8).map(|_| {
            let state = state.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || { barrier.wait(); state.lock().unwrap().advance(&model("a")).unwrap() })
        }).collect();
        for thread in threads { assert_eq!(thread.join().unwrap(), model("b")); }
        let state = state.lock().unwrap();
        assert_eq!(state.next_index, 1);
        let mut restarted: ContinuousFallback = serde_json::from_value(serde_json::to_value(&*state).unwrap()).unwrap();
        restarted.restore();
        restarted.resume();
        assert_eq!(restarted.advance(&model("a")).unwrap(), model("b"));
        assert_eq!(restarted.next_index, 1);
    }

    #[test]
    fn restoration_is_run_local_idempotent_and_preserves_newer_choices() {
        for status in ["completed","awaiting_manual_qa","qa_approved","cancelled","failed"] {
            let mut state = ContinuousFallback::new(true, model("a"), Some("high".into()), &[model("b")]).unwrap();
            state.advance(&model("a")).unwrap();
            let mut c = chat();
            c.team.members[0].model = model("user-selected");
            c.team.members[0].variant = Some("later".into());
            c.runs = vec![saved_run(&state,status),saved_run(&state,"running")];
            let mut store = super::super::empty(); store.chats = vec![c.clone(), c];
            restore_finished(&mut store);
            let c = &store.chats[0];
            assert_eq!(c.team.members[0].model, model("user-selected"));
            assert_eq!(c.team.members[0].variant.as_deref(), Some("later"));
            assert_eq!(c.runs[0].continuous_fallback.as_ref().unwrap().current_model, model("a"));
            assert!(c.runs[0].continuous_fallback.as_ref().unwrap().restored);
            assert_eq!(c.runs[1].continuous_fallback.as_ref().unwrap().current_model, model("b"));
            assert!(!c.runs[1].continuous_fallback.as_ref().unwrap().restored);
            let restored = serde_json::to_value(&store).unwrap();
            restore_finished(&mut store);
            assert_eq!(serde_json::to_value(&store).unwrap(), restored);
        }
    }

    #[test]
    fn uncertain_tool_effects_block_continuation_including_older_turns() {
        let last = json!({"info":{"id":"last","role":"assistant","time":{"completed":1}},"parts":[]});
        for status in ["running","pending","error"] {
            let history = json!([{"info":{"id":"old","role":"assistant"},"parts":[{"type":"tool","state":{"status":status}}]},last]);
            assert!(!settled_tools(&history));
            assert!(!safe_to_continue(&history, &std::collections::HashSet::from(["old".into()]), &last));
        }
        let history = json!([{"info":{"role":"assistant"},"parts":[{"type":"tool","state":{"status":"completed"}}]},last]);
        assert!(settled_tools(&history));
        assert!(safe_to_continue(&history, &Default::default(), &last));
        assert!(!settled_tools(&Value::Null));
    }

    #[test]
    fn old_messages_and_runs_load_without_enabling_fallback() {
        let message: ChatMessage = serde_json::from_value(json!({"id":"legacy","role":"user","text":"Pedido","createdAt":1,"status":"complete"})).unwrap();
        assert!(message.continuous_fallback.is_none());
        let mut c = chat(); c.messages.push(message);
        c.messages[0].status = "pending".into();
        assert!(snapshot_for_run(&c, &[model("new-list")], Some("legacy")).unwrap().is_none());
        let mut run = serde_json::to_value(saved_run(&ContinuousFallback::new(false,model("a"),None,&[]).unwrap(), "running")).unwrap();
        run.as_object_mut().unwrap().remove("continuousFallback");
        assert!(serde_json::from_value::<Run>(run).unwrap().continuous_fallback.is_none());
    }

    #[test]
    fn clarification_keeps_optional_snapshot_despite_later_settings() {
        let mut c = chat();
        c.messages.push(serde_json::from_value(json!({"id":"clarification","role":"assistant","text":"Pregunta",
            "createdAt":1,"status":"complete","clarificationStart":"original-user"})).unwrap());
        assert!(snapshot_for_message(&c, &[model("new-global-list")], None).unwrap().is_none());
        let mut state = ContinuousFallback::new(true, model("original"), Some("high".into()), &[model("b"),model("c")]).unwrap();
        state.advance(&model("original")).unwrap();
        c.messages[0].continuous_fallback = Some(state.clone());
        c.continuous_mode = false;
        c.team.members[0].model = model("later-selection");
        let inherited = snapshot_for_message(&c, &[], None).unwrap().unwrap();
        assert_eq!(serde_json::to_value(inherited).unwrap(), serde_json::to_value(state).unwrap());
        // Another execution must not inherit this conversation's snapshot.
        assert!(snapshot_for_message(&c, &[], Some("other-run")).unwrap().is_none());
    }

    #[test]
    fn native_readings_must_be_recent_and_not_from_the_future() {
        assert!(fresh_exhaustion(100_000, 99_999, true, &[]));
        assert!(!fresh_exhaustion(100_000, 40_000, true, &[]));
        assert!(!fresh_exhaustion(100_000, 100_001, true, &[]));
        assert!(!fresh_exhaustion(100_000, i64::MIN, true, &[]));
        assert!(!fresh_exhaustion(100_000, 99_999, false, &[]));
        let window = |used_percent, resets_at| crate::usage::QuotaWindow { used_percent, window_seconds: 60, resets_at };
        assert!(fresh_exhaustion(100_000, 99_999, false, &[window(100.0,Some(100_001))]));
        assert!(!fresh_exhaustion(100_000, 99_999, false, &[window(100.0,Some(100_000))]));
        assert!(!fresh_exhaustion(100_000, 99_999, false, &[window(100.0,None)]));
        assert!(!fresh_exhaustion(100_000, 99_999, false, &[window(f64::NAN,Some(100_001))]));
    }
}
