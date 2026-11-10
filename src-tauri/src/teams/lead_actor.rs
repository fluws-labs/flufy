//! Durable event-driven Lead actor. It advances the SOURCE conversation in
//! place; it never creates another Lead or a second chat surface. Turns are
//! reserved in SQLite, so a crash never resends an uncertain prompt.
use super::{domain::*, lead_inbox, read, runner, update_lead};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const LEAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const IDLE_GRACE: Duration = Duration::from_secs(20);

fn running() -> &'static Mutex<HashSet<String>> {
    static ACTIVE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// One engine prompt at a time on the source conversation. Plan, coordination,
/// closeout and the actor all take this lock, so no two turns can overlap.
pub(super) fn lock_session() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Record a terminal run state for the Lead. Deduplicated by status, so a
/// restart or a repeated launch never asks the Lead to react twice.
pub fn run_state_changed(app: &AppHandle, run_id: &str) -> Result<(), String> {
    let run = super::run(app, run_id)?;
    if !matches!(run.status.as_str(), "completed" | "blocked" | "failed" | "planning_blocked") {
        return Ok(());
    }
    let Some(chat_id) = super::run_chat(app, run_id)? else { return Ok(()) };
    let Some(source) = read(app)?.chats.iter()
        .find(|chat| chat.id == chat_id)
        .and_then(|chat| chat.origin.as_ref().map(|origin| origin.session_id.clone()))
    else { return Ok(()) };
    if super::bound_chat(app, &source)?.as_deref() != Some(chat_id.as_str()) { return Ok(()); }
    let kind = if run.status == "completed" { "run.completed" } else { "run.blocked" };
    let payload = json!({
        "runId": run.id,
        "status": run.status,
        "summary": run.summary,
        "error": run.error,
    });
    update_lead(app, |_store, tx| {
        lead_inbox::enqueue(tx, &chat_id, &format!("run-state:{}:{}", run_id, run.status), kind, &payload, Some(40), now())
            .map(|_| ())
    })
}

pub fn run_attention(app: &AppHandle, run_id: &str) -> Result<(), String> {
    let run = super::run(app, run_id)?;
    let Some(chat_id) = super::run_chat(app, run_id)? else { return Ok(()) };
    let Some(source) = read(app)?.chats.iter().find(|chat| chat.id == chat_id)
        .and_then(|chat| chat.origin.as_ref().map(|origin| origin.session_id.clone())) else { return Ok(()) };
    if super::bound_chat(app, &source)?.as_deref() != Some(chat_id.as_str()) { return Ok(()); }
    let mut blockers: Vec<String> = run.tasks.iter()
        .filter(|task| matches!(task.status.as_str(), "blocked" | "needs_changes" | "review_error" | "waiting_dependency" | "interrupted" | "recovering"))
        .map(|task| format!("{} ({})", task.title, task.status)).collect();
    blockers.extend(run.coordination.iter().filter(|request| !["resolved", "cancelled"].contains(&request.status.as_str()))
        .map(|request| format!("coordinaci�n {}: {}", request.status, request.summary.chars().take(240).collect::<String>())));
    blockers.extend(run.support_reports.iter().filter(|report| report.finished_at.is_none())
        .map(|report| format!("soporte {} en curso", report.kind)));
    if let Some(error) = &run.error { blockers.push(error.chars().take(400).collect()); }
    if blockers.is_empty() { return Ok(()); }
    let summary = blockers.join("; ");
    let fingerprint = {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        run.status.hash(&mut hasher); summary.hash(&mut hasher); hasher.finish()
    };
    update_lead(app, |_store, tx| {
        lead_inbox::enqueue(tx, &chat_id, &format!("attention:{}:{}", run_id, fingerprint), "run.attention", &json!({
            "runId": run.id,
            "status": run.status,
            "summary": summary,
        }), Some(60), now()).map(|_| ())
    })
}

pub fn run_recovered(app: &AppHandle, run_id: &str) -> Result<(), String> {
    let run = super::run(app, run_id)?;
    let Some(chat_id) = super::run_chat(app, run_id)? else { return Ok(()) };
    let Some(source) = read(app)?.chats.iter().find(|chat| chat.id == chat_id)
        .and_then(|chat| chat.origin.as_ref().map(|origin| origin.session_id.clone())) else { return Ok(()) };
    if super::bound_chat(app, &source)?.as_deref() != Some(chat_id.as_str()) { return Ok(()); }
    update_lead(app, |_store, tx| {
        lead_inbox::enqueue(tx, &chat_id, &format!("run-reconciled:{}", run_id), "run.reconciled", &json!({
            "runId": run.id,
            "status": run.status,
            "summary": "El runner estaba ca�do y se reconciliaron sus sesiones. El worktree y los cambios se conservan.",
        }), Some(45), now()).map(|_| ())
    })
}

pub fn start(app: AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) { return; }
    // A run may have completed while the app was closing. Deliver its durable
    // terminal event once, without waiting for another user message.
    if let Err(error) = reconcile_runs(&app) { log::warn!("[teams-lead] {}", error); }
    std::thread::spawn(move || loop {
        if let Err(error) = sweep(&app) {
            log::warn!("[teams-lead] {}", error);
        }
        std::thread::sleep(Duration::from_secs(1));
    });
}

/// Enqueue a real user message for a bound conversation. It is stored before
/// any engine effect; the actor serializes it with current Lead work.
pub fn send_user(app: &AppHandle, session: &str, text: &str) -> Result<String, String> {
    send_user_context(app, session, text, &[])
}

pub fn send_user_context(app: &AppHandle, session: &str, text: &str, context: &[String]) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() || text.len() > 64_000 {
        return Err("Escribí un mensaje de hasta 64 KB".into());
    }
    if context.iter().map(String::len).sum::<usize>() > 256_000 {
        return Err("El contexto del mensaje supera los 256 KB; reducí la selección adjunta".into());
    }
    let chat = super::bound_chat(app, session)?.ok_or("Esta conversación no tiene un Lead vinculado")?;
    let message_id = format!("msg_{}", id());
    update_lead(app, |_store, tx| {
        lead_inbox::enqueue(
            tx,
            &chat,
            &format!("user:{}", message_id),
            "user.message_received",
            &json!({ "messageId": message_id, "text": text, "context": context }),
            Some(50),
            now(),
        )
    })?;
    wake(app);
    Ok(message_id)
}

pub fn wake(_app: &AppHandle) {
    // The loop polls every second; a condvar would add no correctness here.
}

fn reconcile_runs(app: &AppHandle) -> Result<(), String> {
    let runs: Vec<String> = read(app)?.chats.into_iter()
        .flat_map(|chat| chat.runs.into_iter().map(|run| run.id))
        .collect();
    for run in runs {
        if let Err(error) = run_state_changed(app, &run) {
            log::warn!("[teams-lead] {}", error);
        }
    }
    Ok(())
}

fn sweep(app: &AppHandle) -> Result<(), String> {
    let db = super::db(app)?;
    let mut query = db.prepare(
        "SELECT b.team_chat_id FROM team_conversation_bindings b
         WHERE EXISTS(SELECT 1 FROM team_inbox i WHERE i.chat_id=b.team_chat_id AND i.status='pending')
            OR EXISTS(SELECT 1 FROM team_lead_turns t WHERE t.chat_id=b.team_chat_id AND t.status!='completed')",
    ).map_err(|e| e.to_string())?;
    let chats: Vec<String> = query.query_map([], |row| row.get(0)).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    drop(query);
    drop(db);
    if chats.is_empty() { return Ok(()); }
    for chat in chats {
        let current = {
            let db = super::db(app)?;
            lead_inbox::current(&db, &chat)?
        };
        let (turn, reconcile) = match current {
            Some(turn) if turn.status == "dispatching" || turn.status == "uncertain" => (Some(turn), true),
            // A prepared turn whose thread died before dispatch is retried; a
            // live thread is protected by the in-memory active set.
            Some(turn) if turn.status == "prepared" => (Some(turn), false),
            Some(_) => (None, false),
            None => {
                let mut db = super::db(app)?;
                (lead_inbox::claim(&mut db, &chat, now())?, false)
            }
        };
        let Some(turn) = turn else { continue };
        if !running().lock().map_err(|e| e.to_string())?.insert(turn.turn_id.clone()) { continue; }
        let app = app.clone();
        std::thread::spawn(move || {
            let _guard = lock_session();
            let outcome = if reconcile {
                reconcile_turn(&app, &chat, &turn)
            } else {
                run_turn(&app, &chat, &turn)
            };
            if let Err(error) = outcome {
                log::warn!("[teams-lead] {}: {}", chat, error);
            }
            if let Ok(mut active) = running().lock() { active.remove(&turn.turn_id); }
        });
    }
    Ok(())
}

fn directory(app: &AppHandle, chat_id: &str) -> Result<(String, String), String> {
    let chat = read(app)?.chats.into_iter().find(|chat| chat.id == chat_id)
        .ok_or("El vínculo apunta a un equipo inexistente")?;
    let origin = chat.origin.ok_or("El equipo no conserva su conversación de origen")?;
    Ok((origin.directory, origin.session_id))
}

fn events(app: &AppHandle, turn: &lead_inbox::LeadTurn) -> Result<Vec<Value>, String> {
    let db = super::db(app)?;
    let mut query = db.prepare(
        "SELECT kind,payload_json FROM team_events WHERE event_id=?1",
    ).map_err(|e| e.to_string())?;
    let mut rows = vec![];
    for id in &turn.event_ids {
        if let Some((kind, payload)) = query.query_row([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).optional().map_err(|e| e.to_string())? {
            rows.push(json!({ "kind": kind, "payload": serde_json::from_str::<Value>(&payload).unwrap_or(Value::Null) }));
        }
    }
    Ok(rows)
}

fn prompt(events: &[Value]) -> String {
    format!(
        "[Equipo] Eventos para el Lead:
{}

Respondé al usuario en esta misma conversación. Si falta una decisión, preguntala. No ejecutes tareas operativas: asignalas a un especialista. Para cambiar el tablero usá las herramientas de equipo; este texto por sí solo no modifica el trabajo.",
        serde_json::to_string_pretty(events).unwrap_or_default()
    )
}

// A single user message must appear as the user wrote it; the chat is the
// original conversation, not a synthetic event log. Multi-event turns (a report
// plus a user instruction) are framed explicitly as team data.
fn lead_parts(events: &[Value]) -> Vec<Value> {
    let user_text = events.iter()
        .filter(|event| event["kind"] == "user.message_received")
        .filter_map(|event| event["payload"]["text"].as_str())
        .collect::<Vec<_>>().join("

");
    if !user_text.is_empty() {
        let mut text = user_text;
        if let Some(run) = events.iter().find(|event| matches!(event["kind"].as_str(), Some("run.completed" | "run.blocked" | "run.reconciled"))) {
            let payload = &run["payload"];
            let notice = if run["kind"] == "run.completed" {
                format!("El equipo terminó el trabajo. Resumen: {}", payload["summary"].as_str().unwrap_or("sin resumen"))
            } else {
                format!("El equipo se detuvo ({}). Motivo: {}", payload["status"].as_str().unwrap_or("bloqueado"), payload["error"].as_str().or_else(|| payload["summary"].as_str()).unwrap_or("sin detalle"))
            };
            text.push_str(&format!("

[{}]", notice));
        }
        let other: Vec<_> = events.iter()
            .filter(|event| !matches!(event["kind"].as_str(), Some("user.message_received" | "run.completed" | "run.blocked")))
            .collect();
        if !other.is_empty() {
            text.push_str(&format!("

[Eventos del equipo]
{}", serde_json::to_string_pretty(&other).unwrap_or_default()));
        }
        let mut parts = vec![json!({ "type": "text", "text": text })];
        // Keep the visible user message intact. Preview identity, preferences
        // and selected text are durable prompt context, not file attachments.
        for event in events.iter().filter(|event| event["kind"] == "user.message_received") {
            for text in event["payload"]["context"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                if !text.trim().is_empty() {
                    parts.push(json!({ "type": "text", "text": text, "synthetic": true }));
                }
            }
        }
        return parts;
    }
    if events.len() == 1 && events[0]["kind"] == "run.attention" {
        let summary = events[0]["payload"]["summary"].as_str().unwrap_or("Hay bloqueos pendientes");
        return vec![json!({
            "type": "text",
            "synthetic": true,
            "text": format!("El equipo necesita tu atención: {}. Usá teams_board para leer el estado real. Si hace falta una decisión del usuario, preguntale con question y opciones concretas; no le pidas que abra el tablero ni que destrabe la app.", summary)
        })];
    }
    if events.len() == 1 && matches!(events[0]["kind"].as_str(), Some("run.completed" | "run.blocked" | "run.reconciled")) {
        let payload = &events[0]["payload"];
        let text = if events[0]["kind"] == "run.completed" {
            format!(
                "El equipo terminó el trabajo. Resumen: {}
Respondé al usuario con el resultado, qué se verificó y qué queda pendiente.",
                payload["summary"].as_str().unwrap_or("sin resumen")
            )
        } else if events[0]["kind"] == "run.reconciled" {
            "El runner estaba caído y sus sesiones se reconciliaron; el worktree y los cambios se conservan. Revisá el tablero con teams_board y, si el trabajo puede continuar, usá teams_control para reanudarlo.".to_string()
        } else {
            format!(
                "El equipo se detuvo. Estado: {}. Motivo: {}
Explicá al usuario el bloqueo real y qué decisión o acceso hace falta.",
                payload["status"].as_str().unwrap_or("bloqueado"),
                payload["error"].as_str().or_else(|| payload["summary"].as_str()).unwrap_or("sin detalle")
            )
        };
        return vec![json!({ "type": "text", "synthetic": true, "text": text })];
    }
    if events.len() == 1 && events[0]["kind"] == "user.message_received" {
        if let Some(text) = events[0]["payload"]["text"].as_str() {
            return vec![json!({ "type": "text", "text": text })];
        }
    }
    vec![json!({ "type": "text", "text": prompt(events) })]
}

fn lead_system() -> String {
    format!(
        "{}
{}",
        super::capabilities::instructions(super::capabilities::Mode::Lead),
        super::delivery_review::PROJECT_RULES
    )
}

fn status_context(app: &AppHandle, chat_id: &str) -> Result<String, String> {
    let chat = read(app)?.chats.into_iter().find(|chat| chat.id == chat_id)
        .ok_or("El vínculo apunta a un equipo inexistente")?;
    let Some(run) = chat.runs.last() else { return Ok("Sin trabajo iniciado".into()); };
    let tasks: Vec<Value> = run.tasks.iter().filter(|task| task.contract.task_kind.as_deref() != Some("group"))
        .map(|task| json!({
            "id": task.id,
            "title": task.title,
            "status": task.status,
            "agent": run.team.members.iter().find(|agent| agent.id == task.assigned_agent_id).map(|agent| &agent.name),
            "error": task.error.as_ref().map(|error| error.chars().take(240).collect::<String>()),
        })).collect();
    Ok(serde_json::to_string(&json!({
        "runId": run.id,
        "status": run.status,
        "revision": run.plan_v2.revision_number,
        "pendingChange": run.plan_v2.pending_change,
        "completed": run.tasks.iter().filter(|task| task.status == "completed").count(),
        "total": tasks.len(),
        "tasks": tasks,
        "error": run.error.as_ref().map(|error| error.chars().take(300).collect::<String>()),
    })).unwrap_or_default())
}

fn apply_lead_policy(client: &crate::oc::Opencode, session: &str) -> Result<(), String> {
    let current = client.get_resilient(&format!("/session/{}", session))?;
    let wanted = super::capabilities::lead_permissions();
    if current["permission"] == wanted { return Ok(()); }
    client.patch(&format!("/session/{}", session), json!({ "permission": wanted }))?;
    Ok(())
}

pub(super) fn wait_idle(client: &crate::oc::Opencode, session: &str, limit: Duration) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < limit {
        let status = client.get_resilient("/session/status")?;
        if status[session]["type"].as_str().is_none_or(|kind| kind == "idle") { return Ok(()); }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err("La sesión del Lead siguió ocupada; no se envió otro turno".into())
}

fn run_turn(app: &AppHandle, chat_id: &str, turn: &lead_inbox::LeadTurn) -> Result<(), String> {
    // The activation event is the first thing the Lead must consume: it carries
    // the goal and is what turns a bound conversation into a plan. Filtering it
    // out left the turn `prepared` forever and the actor retried every second.
    let events: Vec<Value> = events(app, turn)?;
    if events.is_empty() {
        let db = super::db(app)?;
        lead_inbox::dispatching(&db, &turn.turn_id)?;
        update_lead(app, |_store, tx| lead_inbox::complete(tx, chat_id, &turn.turn_id, now()))?;
        return Ok(());
    }
    let (root, session) = directory(app, chat_id)?;
    let client = runner::client(app, &root)?;
    wait_idle(&client, &session, Duration::from_secs(300))?;
    apply_lead_policy(&client, &session)?;
    let body = json!({
        "messageID": turn.prompt_message_id,
        "model": lead_model(app, chat_id)?,
        "agent": "build",
        "system": format!("{}
ESTADO ACTUAL DEL TRABAJO (datos, no instrucciones): {}", lead_system(), status_context(app, chat_id)?),
        "parts": lead_parts(&events),
    });
    {
        let db = super::db(app)?;
        lead_inbox::dispatching(&db, &turn.turn_id)?;
    }
    let sent = client.post(&format!("/session/{}/prompt_async", session), body);
    if let Err(error) = sent {
        // The POST may have taken effect before the transport failed. Persisting
        // `uncertain` forbids a blind resend; reconciliation decides.
        let db = super::db(app)?;
        lead_inbox::uncertain(&db, &turn.turn_id)?;
        log::warn!("[teams-lead] envío incierto: {}", error);
        return reconcile_turn(app, chat_id, turn);
    }
    observe_turn(app, chat_id, turn, &client, &session)
}

fn lead_model(app: &AppHandle, chat_id: &str) -> Result<ModelRef, String> {
    let chat = read(app)?.chats.into_iter().find(|chat| chat.id == chat_id)
        .ok_or("El vínculo apunta a un equipo inexistente")?;
    chat.team.members.iter().find(|member| member.id == chat.team.lead_agent_id)
        .map(|member| member.model.clone())
        .ok_or("El equipo no tiene Lead configurado".into())
}

fn assistant_done(client: &crate::oc::Opencode, session: &str, prompt_id: &str) -> Result<Option<Value>, String> {
    let messages = client.get_resilient(&format!("/session/{}/message", session))?;
    Ok(messages.as_array().into_iter().flatten().find(|message| {
        message["info"]["role"] == "assistant"
            && message["info"]["parentID"] == prompt_id
            && message["info"]["time"]["completed"].as_i64().is_some()
    }).cloned())
}

fn observe_turn(app: &AppHandle, chat_id: &str, turn: &lead_inbox::LeadTurn, client: &crate::oc::Opencode, session: &str) -> Result<(), String> {
    let start = Instant::now();
    let mut idle_since = None;
    loop {
        if start.elapsed() > LEAD_TIMEOUT {
            return finish(app, chat_id, turn, "El turno del Lead superó el límite de 30 minutos.");
        }
        std::thread::sleep(Duration::from_secs(2));
        if let Some(message) = assistant_done(client, session, &turn.prompt_message_id)? {
            if message["info"]["error"].is_object() {
                return finish(app, chat_id, turn, "El Lead devolvió un error.");
            }
            return finish(app, chat_id, turn, "");
        }
        let status = client.get_resilient("/session/status")?;
        let busy = status[session]["type"].as_str().is_some_and(|kind| kind != "idle");
        if busy { idle_since = None; }
        else if idle_since.is_none() { idle_since = Some(Instant::now()); }
        if idle_since.is_some_and(|since| since.elapsed() > IDLE_GRACE) {
            return finish(app, chat_id, turn, "La sesión quedó inactiva sin una respuesta completa del Lead.");
        }
    }
}

fn finish(app: &AppHandle, chat_id: &str, turn: &lead_inbox::LeadTurn, error: &str) -> Result<(), String> {
    update_lead(app, |store, tx| {
        lead_inbox::complete(tx, chat_id, &turn.turn_id, now())?;
        if let Some(chat) = store.chats.iter_mut().find(|chat| chat.id == chat_id) {
            if let Some(origin) = chat.origin.as_mut() {
                origin.error = if error.is_empty() { None } else { Some(error.into()) };
            }
        }
        if !error.is_empty() {
            lead_inbox::enqueue(
                tx,
                chat_id,
                &format!("turn-failed:{}", turn.turn_id),
                "lead.turn_failed",
                &json!({ "turnId": turn.turn_id, "error": error }),
                None,
                now(),
            )?;
        }
        Ok(())
    })
}

fn reconcile_turn(app: &AppHandle, chat_id: &str, turn: &lead_inbox::LeadTurn) -> Result<(), String> {
    let (root, session) = directory(app, chat_id)?;
    let client = runner::client(app, &root)?;
    if let Some(message) = assistant_done(&client, &session, &turn.prompt_message_id)? {
        let error = if message["info"]["error"].is_object() { "El Lead devolvió un error." } else { "" };
        return finish(app, chat_id, turn, error);
    }
    let status = client.get_resilient("/session/status")?;
    if status[session.as_str()]["type"].as_str().is_some_and(|kind| kind != "idle") {
        return observe_turn(app, chat_id, turn, &client, &session);
    }
    let messages = client.get_resilient(&format!("/session/{}/message", session))?;
    if messages.as_array().into_iter().flatten().any(|message| message["info"]["id"] == turn.prompt_message_id) {
        // The prompt was accepted but produced no complete answer. Do not resend.
        return finish(app, chat_id, turn, "El mensaje quedó registrado sin respuesta completa; no se reenvió.");
    }
    // The dispatch never reached the engine. Completing without a resend keeps
    // the conversation usable; the failure is recorded, not presented as success.
    finish(app, chat_id, turn, "El turno no llegó al motor; no se reenvió automáticamente.")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_distinguishes_events_from_instructions() {
        let text = prompt(&[json!({"kind":"user.message_received","payload":{"text":"hola"}})]);
        assert!(text.starts_with("[Equipo]"));
        assert!(text.contains("hola"));
        assert!(text.contains("No ejecutes tareas operativas"));
    }
    #[test]
    fn activation_event_reaches_the_lead_with_the_goal() {
        let parts = lead_parts(&[json!({
            "kind": "team.activated",
            "payload": { "goal": "Agregar indicador de ocupación" }
        })]);
        let text = parts[0]["text"].as_str().unwrap();
        assert!(text.starts_with("[Equipo]"));
        assert!(text.contains("Agregar indicador de ocupación"));
    }
    #[test]
    fn a_single_user_message_is_sent_as_the_user_wrote_it() {
        let parts = lead_parts(&[json!({"kind":"user.message_received","payload":{"text":"Arreglá el login"}})]);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["text"], "Arreglá el login");
    }
    #[test]
    fn automatic_context_survives_the_durable_inbox_without_polluting_the_user_message() {
        let event = json!({"kind":"user.message_received","payload":{"text":"Analizá dónde estamos y cuánto falta",
            "context":["[FLUFY_PREVIEW_IDENTITY]{\"taskId\":\"original-task\"}","Preferencias de diseño: conservar la tarea vigente",""]}});
        let restored: Value = serde_json::from_str(&serde_json::to_string(&event).unwrap()).unwrap();
        let parts = lead_parts(&[restored, json!({"kind":"run.blocked","payload":{"status":"cancelled","summary":"15/21 tareas"}})]);
        assert!(parts[0]["text"].as_str().unwrap().starts_with("Analizá dónde estamos y cuánto falta"));
        assert!(parts[0]["text"].as_str().unwrap().contains("cancelled"));
        assert!(!parts[0]["text"].as_str().unwrap().contains("FLUFY_PREVIEW_IDENTITY"));
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[1]["synthetic"], true);
        assert!(parts[1]["text"].as_str().unwrap().contains("original-task"));
        assert_eq!(parts[2]["synthetic"], true);
    }
    #[test]
    fn mixed_events_are_framed_as_team_data() {
        let parts = lead_parts(&[
            json!({"kind":"user.message_received","payload":{"text":"Seguí"}}),
            json!({"kind":"attempt.result_submitted","payload":{"taskId":"t1"}}),
        ]);
        assert_eq!(parts.len(), 1);
        let text = parts[0]["text"].as_str().unwrap();
        assert!(text.starts_with("Seguí"));
        assert!(text.contains("t1"));
    }
    #[test]
    fn a_waiting_user_message_is_combined_with_the_run_result() {
        let parts = lead_parts(&[
            json!({"kind":"user.message_received","payload":{"text":"¿Cómo va?"}}),
            json!({"kind":"run.completed","payload":{"status":"completed","summary":"Todo verificado"}}),
        ]);
        let text = parts[0]["text"].as_str().unwrap();
        assert!(text.starts_with("¿Cómo va?"));
        assert!(text.contains("El equipo terminó"));
        assert!(text.contains("Todo verificado"));
        assert!(!text.starts_with("[Equipo]"));
    }
    #[test]
    fn run_completion_is_visible_and_asks_for_a_user_facing_summary() {
        let parts = lead_parts(&[json!({
            "kind": "run.completed",
            "payload": { "runId": "r1", "status": "completed", "summary": "Se implementó y probó" }
        })]);
        let text = parts[0]["text"].as_str().unwrap();
        assert!(text.starts_with("El equipo terminó"));
        assert!(text.contains("Se implementó y probó"));
        assert!(!text.starts_with("[FLUFY_EQUIPO_INTERNO]"));
    }
    #[test]
    fn lead_system_forbids_execution() {
        assert!(lead_system().contains("Nunca ejecutás"));
    }
}
