mod activity;
mod lead_actor;
mod lead_inbox;
mod delivery_review;
pub mod handoff;
mod capture;
mod attachments;
mod autonomy;
mod capabilities;
mod coordination;
mod conflicts;
mod conversation;
pub mod domain;
mod errors;
mod fallback;
mod evidence;
mod folder_snapshot;
#[cfg(all(test, feature = "desktop-e2e"))]
mod integration;
#[cfg(all(test, feature = "desktop-e2e"))]
mod restart_tests;
mod retention;
mod runner;
mod skills;
mod staffing;
mod support;
pub mod routing;
pub mod remote;
pub mod plan_v2;
#[cfg(test)]
mod plan_v2_tests;
#[cfg(test)]
mod benchmarks;
#[cfg(test)]
mod routing_tests;

use domain::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub struct TeamsState {
    store: Mutex<Store>,
    controls: Mutex<()>,
    handoffs: Mutex<()>,
    runners: Mutex<std::collections::HashSet<String>>,
    activity: Mutex<activity::ActivityLog>,
    error: Option<String>,
}

fn empty() -> Store {
    Store {
        fallback_models: vec![],
        schema_version: 3,
        teams: vec![],
        skills: catalog(),
        chats: vec![],
    }
}

fn db(app: &AppHandle) -> Result<Connection, String> {
    let path = crate::app_data_file(app, "teams.sqlite")
        .ok_or("No se pudo localizar la carpeta de datos")?;
    let mut db = Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS team_store (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL);").map_err(|e| e.to_string())?;
    lead_inbox::migrate(&mut db)?;
    Ok(db)
}

fn read_db(db: &Connection) -> Result<Store, String> {
    let data = db.query_row("SELECT document FROM team_store WHERE id=1", [], |r| {
        r.get::<_, String>(0)
    });
    let mut store = match data {
        Ok(data) => serde_json::from_str::<Store>(&data)
            .map_err(|e| format!("No se puede leer teams.sqlite: {}", e))?,
        Err(rusqlite::Error::QueryReturnedNoRows) => empty(),
        Err(e) => return Err(e.to_string()),
    };
    if ![1, 2, 3].contains(&store.schema_version) {
        return Err("Versión de Equipos IA no compatible. Se preservó el archivo original".into());
    }
    if store.schema_version < 3 {
        // Keep the exact original document in the same SQLite database. Never
        // copy a live WAL database as a plain file or overwrite earlier backups.
        db.execute_batch("CREATE TABLE IF NOT EXISTS team_store_migration_backup (schema_version INTEGER PRIMARY KEY, document TEXT NOT NULL)").map_err(|e| e.to_string())?;
        db.execute("INSERT OR IGNORE INTO team_store_migration_backup(schema_version,document) SELECT ?1,document FROM team_store WHERE id=1",params![store.schema_version]).map_err(|e| e.to_string())?;
    }
    store.schema_version = 3;
    skills::upgrade(&mut store);
    Ok(store)
}

fn write_snapshot(tx: &rusqlite::Transaction<'_>, store: &Store) -> Result<(), String> {
    let data = serde_json::to_string(store).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO team_store(id, document) VALUES(1, ?1) ON CONFLICT(id) DO UPDATE SET document=excluded.document", params![data])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn write_db(db: &mut Connection, store: &Store) -> Result<(), String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    write_snapshot(&tx, store)?;
    tx.commit().map_err(|e| e.to_string())
}

/// Snapshot and Lead mailbox commit together. Callers persist an event/intent
/// in the same transaction as the domain change, so neither can exist alone.
pub fn update_lead<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut Store, &rusqlite::Transaction<'_>) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<TeamsState>();
    if let Some(e) = &state.error {
        return Err(e.clone());
    }
    let mut guard = state.store.lock().map_err(|e| e.to_string())?;
    let mut next = guard.clone();
    let mut db = db(app)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let result = f(&mut next, &tx)?;
    for run in next.chats.iter_mut().flat_map(|c| &mut c.runs) {
        let previous = guard.chats.iter().flat_map(|c| &c.runs).find(|r| r.id == run.id);
        if previous.is_none_or(|p| serde_json::to_value(p).ok() != serde_json::to_value(&*run).ok()) {
            run.plan_v2.sequence = previous.map_or(1, |p| p.plan_v2.sequence.saturating_add(1));
        }
    }
    write_snapshot(&tx, &next)?;
    tx.commit().map_err(|e| e.to_string())?;
    *guard = next;
    drop(guard);
    let _ = app.emit("team://changed", ());
    crate::live::teams_changed(app);
    Ok(result)
}

/// The source session when this run belongs to a conversation Lead. Plan,
/// coordination and closeout reuse it instead of creating a second Lead.
pub fn conversation_source(app: &AppHandle, run_id: &str) -> Result<Option<String>, String> {
    let store = read(app)?;
    for chat in store.chats {
        if chat.runs.iter().any(|run| run.id == run_id && run.plan_v2.conversation_lead) {
            return Ok(chat.origin.map(|origin| origin.session_id));
        }
    }
    Ok(None)
}

pub fn run_chat(app: &AppHandle, run_id: &str) -> Result<Option<String>, String> {
    Ok(read(app)?.chats.into_iter()
        .find(|chat| chat.runs.iter().any(|run| run.id == run_id))
        .map(|chat| chat.id))
}

pub fn start_conversation_run(app: &AppHandle, chat_id: &str, goal: &str) -> Result<String, String> {
    start_run_with(app.clone(), chat_id.into(), goal.into(), vec![], None, true)
}

/// Native lookup used by activation and guards. Never accepts a model-supplied
/// session as authority: call this with the session bound in the task context.
pub fn bound_chat(app: &AppHandle, session: &str) -> Result<Option<String>, String> {
    if session.is_empty() { return Ok(None); }
    let db = db(app)?;
    let chat: Option<String> = db.query_row(
        "SELECT team_chat_id FROM team_conversation_bindings WHERE source_session_id=?1",
        [session], |row| row.get(0),
    ).optional().map_err(|e| e.to_string())?;
    Ok(chat)
}

pub fn read(app: &AppHandle) -> Result<Store, String> {
    let state = app.state::<TeamsState>();
    if let Some(e) = &state.error {
        return Err(e.clone());
    }
    let result = state.store.lock().map_err(|e| e.to_string())?.clone();
    Ok(result)
}

fn chat_sessions(c: &Chat) -> Vec<String> {
    let mut sessions = Vec::new();
    for message in &c.messages {
        if let Some(id) = &message.session_id { sessions.push(id.clone()); }
    }
    for run in &c.runs {
        if let Some(id) = &run.plan_session_id { sessions.push(id.clone()); }
        for report in &run.support_reports { sessions.push(report.session_id.clone()); }
        sessions.extend(run.closing_sessions.iter().cloned());
        for request in &run.coordination { sessions.extend(request.sessions.iter().cloned()); }
        for task in &run.tasks {
            for attempt in &task.attempts {
                if let Some(id) = &attempt.session_id { sessions.push(id.clone()); }
                if let Some(id) = &attempt.review_session_id { sessions.push(id.clone()); }
            }
        }
    }
    sessions.sort();
    sessions.dedup();
    sessions
}

fn owns_session(c: &Chat, session: &str) -> bool {
    !session.is_empty() && (c.messages.iter().any(|m| m.session_id.as_deref() == Some(session)) || c.runs.iter().any(|r| {
                    r.plan_session_id.as_deref() == Some(session)
                        || r.support_reports.iter().any(|s|s.session_id==session)
                        || r.closing_sessions.iter().any(|id| id == session)
                        || r.coordination
                            .iter()
                            .any(|c| c.sessions.iter().any(|id| id == session))
                        || r.tasks.iter().flat_map(|t| &t.attempts).any(|a| {
                            a.session_id.as_deref() == Some(session)
                                || a.review_session_id.as_deref() == Some(session)
                        })
                }))
}

pub fn is_team_session(app: &AppHandle, session: &str) -> bool {
    app.try_state::<TeamsState>().and_then(|state| state.store.lock().ok().map(|s|
        s.chats.iter().any(|c| owns_session(c, session)))).unwrap_or(false)
}

/// Auto-approve for team sessions. Team chats default to full access inside
/// their scoped tool permissions; the chat's own switch can turn it off. The
/// global preference is not used here, so a team can't widen its scopes.
pub fn auto_approve_session(app: &AppHandle, session: &str) -> Option<bool> {
    let state = app.try_state::<TeamsState>()?;
    let store = state.store.lock().ok()?;
    let chat = store.chats.iter().find(|c| owns_session(c, session))?;
    Some(chat.auto_approve.unwrap_or(true))
}

pub fn memory_for_run(app: &AppHandle, run_id: &str) -> bool {
    let Some(state) = app.try_state::<TeamsState>() else { return true };
    let Ok(store) = state.store.lock() else { return true };
    store
        .chats
        .iter()
        .find(|c| c.runs.iter().any(|r| r.id == run_id))
        .and_then(|c| c.memory)
        .unwrap_or(true)
}

/// The native session registry, never model arguments, assigns every team
/// session to the single Chrome workspace selected for its chat.
pub(crate) fn browser_session(app: &AppHandle, session: &str) -> String {
    app.try_state::<TeamsState>().and_then(|state| state.store.lock().ok().and_then(|s|
        browser_owner(&s, session)))
        .unwrap_or_else(|| session.to_string())
}

pub(crate) fn browser_can_recover(app: &AppHandle, session: &str) -> bool {
    app.try_state::<TeamsState>().and_then(|state| state.store.lock().ok().map(|s|
        s.chats.iter().any(|c| c.messages.iter().any(|m| m.session_id.as_deref()==Some(session)) || c.runs.iter().flat_map(|r| &r.tasks).flat_map(|t| &t.attempts).any(|a| a.session_id.as_deref()==Some(session))))).unwrap_or(false)
}

fn browser_owner(store: &Store, session: &str) -> Option<String> {
    store.chats.iter().find(|c| owns_session(c, session)).map(|c| format!("team:{}", c.id))
}

pub fn busy(app: &AppHandle) -> bool {
    app.try_state::<TeamsState>()
        .and_then(|state| {
            state.store.lock().ok().map(|s| {
                s.chats.iter().any(|c| c.messages.iter().any(|m| m.status == "pending")) || s.chats
                    .iter()
                    .flat_map(|c| &c.runs)
                    .any(|r| active(&r.status) || runner::unsettled(r))
            })
        })
        .unwrap_or(false)
}

pub fn update<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut Store) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<TeamsState>();
    if let Some(e) = &state.error {
        return Err(e.clone());
    }
    let mut guard = state.store.lock().map_err(|e| e.to_string())?;
    let mut next = guard.clone();
    let result = f(&mut next)?;
    fallback::restore_finished(&mut next);
    for run in next.chats.iter_mut().flat_map(|c| &mut c.runs) {
        let previous = guard.chats.iter().flat_map(|c| &c.runs).find(|r| r.id == run.id);
        if previous.is_none_or(|p| serde_json::to_value(p).ok() != serde_json::to_value(&*run).ok()) {
            run.plan_v2.sequence = previous.map_or(1, |p| p.plan_v2.sequence.saturating_add(1));
        }
    }
    write_db(&mut db(app)?, &next)?;
    *guard = next;
    drop(guard);
    let _ = app.emit("team://changed", ());
    crate::live::teams_changed(app);
    Ok(result)
}

pub fn run(app: &AppHandle, id: &str) -> Result<Run, String> {
    read(app)?
        .chats
        .into_iter()
        .flat_map(|c| c.runs)
        .find(|r| r.id == id)
        .ok_or("Ejecución inexistente".into())
}

pub fn update_run<T>(
    app: &AppHandle,
    id: &str,
    f: impl FnOnce(&mut Run) -> Result<T, String>,
) -> Result<T, String> {
    update(app, |s| {
        let r = s
            .chats
            .iter_mut()
            .flat_map(|c| c.runs.iter_mut())
            .find(|r| r.id == id)
            .ok_or("Ejecución inexistente")?;
        f(r)
    })
}

pub fn start(app: &AppHandle) {
    let loaded = db(app).and_then(|d| read_db(&d));
    let (mut store, error) = match loaded {
        Ok(s) => (s, None),
        Err(e) => {
            log::error!("[teams] {}", e);
            (empty(), Some(e))
        }
    };
    recover(&mut store);
    fallback::restore_finished(&mut store);
    app.manage(TeamsState {
        store: Mutex::new(store),
        controls: Mutex::new(()),
        handoffs: Mutex::new(()),
        runners: Mutex::new(Default::default()),
        activity: Mutex::new(Default::default()),
        error,
    });
    if let Err(e) = update(app, |_| Ok(())) {
        log::error!("[teams] {}", e);
    }
    lead_actor::start(app.clone());
    let recovery = app.clone();
    std::thread::spawn(move || loop {
        if let Err(error) = runner::recover_stale(&recovery) {
            log::warn!("[teams-recovery] {}", error);
        }
        std::thread::sleep(std::time::Duration::from_secs(30));
    });
    let handle = app.clone();
    std::thread::spawn(move || loop {
        if let Err(e) = retention::sweep(&handle) {
            log::warn!("[teams-retention] {}", e);
        }
        std::thread::sleep(std::time::Duration::from_secs(24 * 60 * 60));
    });
}

fn recover(store: &mut Store) {
    // Recovery never replays a prompt. Explicit resume reconciles each recorded session first.
    for chat in &mut store.chats {
        for m in &mut chat.messages {
            if m.status == "pending" {
                m.status = "interrupted".into();
                m.text = "La aplicación se cerró antes de terminar esta respuesta. Podés volver a preguntar; tu mensaje quedó guardado y no se repitió ninguna operación.".into();
            }
        }
        for r in &mut chat.runs {
            if active(&r.status) && r.status != "plan_ready" {
                r.status = "blocked".into();
                r.error = Some("El proceso se interrumpió. Inspeccioná las sesiones y reanudá para reconciliar el motor sin repetir operaciones automáticamente.".into());
            }
        }
    }
}

fn canonical(path: &str) -> Result<String, String> {
    let p = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| format!("Carpeta no disponible: {} ({})", path, e))?;
    if !p.is_dir() {
        return Err("Se esperaba una carpeta".into());
    }
    Ok(p.to_string_lossy().trim_start_matches(r"\\?\").to_string())
}

#[tauri::command]
pub fn teams_state(app: AppHandle) -> Result<Store, String> {
    read(&app)
}

/// Native activation gateway. The caller cannot supply its session: identity
/// comes from the bound task context. Kept out of the model tool list until the
/// durable actor can safely take over the conversation.
#[tauri::command]
pub fn teams_lead_activate(app: AppHandle, request: serde_json::Value) -> Result<serde_json::Value, String> {
    handoff::activate_lead(&app, &request)
}

#[tauri::command]
pub fn teams_lead_bound(app: AppHandle, session: String) -> Result<bool, String> {
    Ok(bound_chat(&app, &session)?.is_some())
}

#[tauri::command]
pub fn teams_lead_unbind(app: AppHandle, session: String) -> Result<bool, String> {
    let Some(chat_id) = bound_chat(&app, &session)? else { return Ok(false) };
    update_lead(&app, |store, tx| {
        lead_inbox::unbind(tx, &session)?;
        if let Some(chat) = store.chats.iter_mut().find(|chat| chat.id == chat_id) {
            if let Some(origin) = chat.origin.as_mut() { origin.error = None; }
            // Back to the legacy team executor: the chat is a normal chat again
            // and the board behaves like a manual team.
            for run in chat.runs.iter_mut() { run.plan_v2.conversation_lead = false; }
        }
        Ok(())
    })?;
    Ok(true)
}

#[tauri::command]
pub fn teams_lead_send(app: AppHandle, session: String, text: String) -> Result<String, String> {
    lead_actor::send_user(&app, &session, &text)
}

/// Remote/PWA entry point. It stores the message before any engine effect and
/// lets the durable actor serialize it with team work.
pub fn send_lead_message(app: &AppHandle, session: &str, text: &str) -> Result<String, String> {
    lead_actor::send_user(app, session, text)
}

#[tauri::command]
pub fn team_activity(app: AppHandle, run_id: String) -> Vec<activity::Activity> {
    app.state::<TeamsState>()
        .activity
        .lock()
        .map(|log| log.recent(&run_id, 400))
        .unwrap_or_default()
}

#[tauri::command]
pub fn team_chat_send(app: AppHandle, chat_id: String, text: String, images: Option<Vec<ImageInput>>) -> Result<String, String> {
    // A bound chat must use the source conversation's durable actor. Sending to
    // the legacy team chat would open a second, invisible Lead.
    let images = images.unwrap_or_default();
    if let Some(origin) = read(&app)?.chats.iter()
        .find(|chat| chat.id == chat_id)
        .and_then(|chat| chat.origin.clone())
    {
        if bound_chat(&app, &origin.session_id)?.as_deref() == Some(chat_id.as_str()) {
            if !images.is_empty() { return Err("En una conversación con Lead, enviá texto sin adjuntos por ahora".into()); }
            return lead_actor::send_user(&app, &origin.session_id, &text);
        }
    }
    conversation::send(app, chat_id, text, images)
}

#[tauri::command]
pub async fn team_chat_cancel(app: AppHandle, chat_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || conversation::cancel(&app, &chat_id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn team_image_read(app: AppHandle, image_id: String) -> Result<String, String> {
    let store = read(&app)?;
    let image = store.chats.iter().flat_map(|c| c.messages.iter().flat_map(|m| &m.images).chain(c.runs.iter().flat_map(|r| &r.images)))
        .find(|i| i.id == image_id).ok_or("Esta imagen no pertenece a un chat de equipos")?;
    attachments::data_url(&app, image)
}

#[tauri::command]
pub fn teams_save(app: AppHandle, mut team: Team) -> Result<Team, String> {
    team.project_root = canonical(&team.project_root)?;
    team.allowed_repositories = team
        .allowed_repositories
        .iter()
        .map(|p| canonical(p))
        .collect::<Result<_, _>>()?;
    team.allowed_repositories.sort_by_key(|p| p.to_lowercase());
    team.allowed_repositories.dedup_by(|a, b| same_path(a, b));
    update(&app, |s| {
        validate_team(&team, &s.skills)?;
        if team.id.is_empty() {
            team.id = id();
        }
        team.updated_at = now();
        s.teams.retain(|t| t.id != team.id);
        s.teams.push(team.clone());
        Ok(team)
    })
}

#[tauri::command]
pub fn teams_delete(app: AppHandle, id: String) -> Result<(), String> {
    update(&app, |s| {
        s.teams.retain(|t| t.id != id);
        Ok(())
    })
}

#[tauri::command]
pub fn team_skills_save(app: AppHandle, mut skill: Skill) -> Result<Skill, String> {
    if skill.name.trim().is_empty()
        || skill.instructions.trim().is_empty()
        || skill.instructions.len() > 32_000
    {
        return Err("La skill necesita nombre e instrucciones (máximo 32 KB)".into());
    }
    update(&app, |s| {
        if skill.id.is_empty() {
            skill.id = id();
        }
        skill.version = s
            .skills
            .iter()
            .filter(|v| v.id == skill.id)
            .map(|v| v.version)
            .max()
            .unwrap_or(0)
            + 1;
        s.skills.push(skill.clone());
        Ok(skill)
    })
}

#[tauri::command]
pub fn team_chats_create(app: AppHandle, team_id: String) -> Result<Chat, String> {
    update(&app, |s| {
        let team = s
            .teams
            .iter()
            .find(|t| t.id == team_id)
            .ok_or("Equipo inexistente")?
            .clone();
        let chat = Chat {
            continuous_mode: false,
            origin: None,
            messages: vec![],
            id: id(),
            title: team.name.clone(),
            archived: false,
            team,
            skills: s.skills.clone(),
            created_at: now(),
            runs: vec![],
            memory: None,
            auto_approve: None,
        };
        s.chats.push(chat.clone());
        Ok(chat)
    })
}

#[tauri::command]
pub fn team_chats_auto(
    app: AppHandle,
    project_root: String,
    model: ModelRef,
    variant: Option<String>,
) -> Result<Chat, String> {
    let root = canonical(&project_root)?;
    update(&app, |s| {
        let chat = autonomous_chat(s, root, model, variant)?;
        s.chats.push(chat.clone());
        Ok(chat)
    })
}

fn autonomous_chat(s: &Store, root: String, model: ModelRef, variant: Option<String>) -> Result<Chat, String> {
        let lead_id = id();
        let refs = s
            .skills
            .iter()
            .filter(|skill| {
                ["team-lead", "comportamientos"].contains(&skill.id.as_str())
                    && !s
                        .skills
                        .iter()
                        .any(|v| v.id == skill.id && v.version > skill.version)
            })
            .map(|skill| SkillRef {
                id: skill.id.clone(),
                version: skill.version,
            })
            .collect();
        let team = Team {
            plan_v2: Default::default(),
            autonomous: true,
            id: id(),
            name: "Modo equipo".into(),
            project_root: root.clone(),
            allowed_repositories: vec![root.clone()],
            lead_agent_id: lead_id.clone(),
            members: vec![Employee {
                id: lead_id,
                name: "Lead".into(),
                role: "Lead".into(),
                model,
                variant,
                skill_refs: refs,
                instructions: String::new(),
                tools: [
                    "read",
                    "glob",
                    "grep",
                    "edit",
                    "write",
                    "apply_patch",
                    "bash",
                ]
                .iter()
                .map(|s| s.to_string())
                .collect(),
                max_concurrent_tasks: 1,
            }],
            max_parallel_tasks: staffing::MAX_WORKERS,
            max_retries_per_task: 1,
            updated_at: now(),
            evidence_targets: vec![],
            limits: Limits::default(),
        };
        validate_team(&team, &s.skills)?;
        let chat = Chat {
            continuous_mode: false,
            origin: None,
            messages: vec![],
            id: id(),
            title: "Modo equipo".into(),
            archived: false,
            team,
            skills: s.skills.clone(),
            created_at: now(),
            runs: vec![],
            memory: None,
            auto_approve: None,
        };
        Ok(chat)
}

#[tauri::command]
pub fn team_chats_edit(
    app: AppHandle,
    id: String,
    title: String,
    archived: bool,
) -> Result<(), String> {
    if title.trim().is_empty() || title.len() > 160 {
        return Err("Título inválido".into());
    }
    update(&app, |s| {
        let c = s
            .chats
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or("Chat inexistente")?;
        c.title = title;
        c.archived = archived;
        Ok(())
    })
}

#[tauri::command]
pub fn team_fallback_models_set(app: AppHandle, models: Vec<ModelRef>) -> Result<(), String> {
    fallback::validate_models(&models)?;
    update(&app, |s| { s.fallback_models = models; Ok(()) })
}

#[tauri::command]
pub fn team_chats_continuous(app: AppHandle, chat_id: String, enabled: bool) -> Result<(), String> {
    update(&app, |s| {
        if enabled && s.fallback_models.is_empty() { return Err("Configurá Modelos Fallback antes de activar el modo continuo".into()); }
        let chat = s.chats.iter_mut().find(|c| c.id == chat_id).ok_or("Chat inexistente")?;
        chat.continuous_mode = enabled;
        for run in &mut chat.runs {
            if active(&run.status) || ["blocked","planning_blocked"].contains(&run.status.as_str()) {
                if let Some(state) = &mut run.continuous_fallback { state.enabled = enabled; }
            }
        }
        for message in chat.messages.iter_mut().filter(|m| m.status == "pending") {
            if let Some(state) = &mut message.continuous_fallback { state.enabled = enabled; }
        }
        Ok(())
    })
}

#[tauri::command]
pub fn team_chats_settings(app: AppHandle, chat_id: String, memory: bool, auto_approve: bool) -> Result<(), String> {
    let sessions = update(&app, |s| {
        let chat = s.chats.iter_mut().find(|c| c.id == chat_id).ok_or("Chat inexistente")?;
        chat.memory = Some(memory);
        chat.auto_approve = Some(auto_approve);
        Ok(chat_sessions(chat))
    })?;
    for session in sessions {
        crate::memory::set_session(&app, &session, memory);
    }
    Ok(())
}

#[tauri::command]
pub fn team_chats_model(app: AppHandle, chat_id: String, agent_id: String, model: ModelRef, variant: Option<String>) -> Result<(), String> {
    update(&app, |store| {
        let chat = store.chats.iter_mut().find(|c| c.id == chat_id).ok_or("Chat inexistente")?;
        change_chat_model(chat, &agent_id, model, variant)
    })
}

fn change_chat_model(chat: &mut Chat, agent_id: &str, model: ModelRef, variant: Option<String>) -> Result<(), String> {
    if model.provider_id.trim().is_empty() || model.model_id.trim().is_empty() { return Err("Seleccioná un modelo disponible".into()); }
    if chat.archived { return Err("Restaurá el chat antes de cambiar su modelo".into()); }
    if chat.messages.iter().any(|m| m.status == "pending") { return Err("Esperá o detené la respuesta del Lead antes de cambiar el modelo".into()); }
    let agent = chat.team.members.iter_mut().find(|a| a.id == agent_id).ok_or("Integrante inexistente")?;
    agent.model = model;
    agent.variant = variant.filter(|v| !v.trim().is_empty());
    chat.team.updated_at = now();
    // Runs and past attempts are immutable snapshots of the models they used.
    Ok(())
}

#[tauri::command]
pub fn team_runs_start(app: AppHandle, chat_id: String, goal: String) -> Result<String, String> {
    let bound = read(&app)?.chats.iter()
        .find(|chat| chat.id == chat_id)
        .and_then(|chat| chat.origin.as_ref().map(|origin| origin.session_id.clone()))
        .map(|session| bound_chat(&app, &session).ok().flatten().as_deref() == Some(chat_id.as_str()))
        .unwrap_or(false);
    if bound { return start_conversation_run(&app, &chat_id, &goal); }
    start_run(app, chat_id, goal, vec![], None)
}

fn start_run(app: AppHandle, chat_id: String, goal: String, images: Vec<ChatImage>, source_reply: Option<&str>) -> Result<String, String> {
    start_run_with(app, chat_id, goal, images, source_reply, false)
}

fn start_run_with(app: AppHandle, chat_id: String, goal: String, images: Vec<ChatImage>, source_reply: Option<&str>, conversation_lead: bool) -> Result<String, String> {
    if goal.trim().is_empty() || goal.len() > 64_000 {
        return Err("Ingresá un objetivo (máximo 64 KB)".into());
    }
    if crate::updates::installing(&app) {
        return Err("Esperá a que finalice la actualización".into());
    }
    let chat = read(&app)?
        .chats
        .into_iter()
        .find(|c| c.id == chat_id)
        .ok_or("Chat inexistente")?;
    evidence::validate_folders(&chat.team.allowed_repositories)?;
    let run_id = id();
    let dir = crate::app_data_file(&app, "comportamientos")
        .ok_or("Sin carpeta de datos")?
        .join(&run_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    update(&app, |s| {
        let c = s
            .chats
            .iter()
            .find(|c| c.id == chat_id)
            .ok_or("Chat inexistente")?;
        if crate::updates::installing(&app) {
            return Err("Esperá a que finalice la actualización".into());
        }
        if c.archived {
            return Err("Restaurá el chat antes de continuar".into());
        }
        if source_reply.is_some_and(|id| !c.messages.iter().any(|m| m.id == id && m.status == "pending")) {
            return Err("Pedido del Lead detenido o ya finalizado; no se inició una ejecución nueva".into());
        }
        validate_team(&c.team, &c.skills)?;
        let continuous_fallback = fallback::snapshot_for_run(c, &s.fallback_models, source_reply)?;
        let mut team = c.team.clone();
        if let Some(state) = &continuous_fallback {
            if let Some(lead) = team.members.iter_mut().find(|m| m.id == team.lead_agent_id) {
                lead.model = state.original_model.clone();
                lead.variant = state.original_variant.clone();
            }
        }
        if let Some((owner,r)) = conflicts::first(s,c) {
            let task = r.tasks.iter().find(|t| t.status != "completed").map(|t|t.title.as_str()).unwrap_or("Organizar y revisar el trabajo");
            return Err(format!("La carpeta está ocupada por el equipo «{}» ({task}). Abrí «Ver equipos que ocupan la carpeta» para verlo o detenerlo; su trabajo se conserva.",owner.title));
        }
        let c = s
            .chats
            .iter_mut()
            .find(|c| c.id == chat_id)
            .ok_or("Chat inexistente")?;
        let prior = c
            .runs
            .last()
            .map(|r| {
                format!(
                    "

Entrega previa ({}): {}
Feedback actual: ",
                    r.id, r.summary
                )
            })
            .unwrap_or_default();
        let source_start = source_reply.and_then(|reply| conversation::clarification_start(c,reply))
            .and_then(|first| c.messages.iter().position(|m|m.id==first));
        c.runs.push(Run {
            continuous_fallback,
            delivery_review_version: 1,
            delivery_review: None,
            plan_v2: plan_v2::PlanV2State { enabled: c.team.plan_v2.enabled, conversation_lead, review_before_start: c.team.plan_v2.review_before_start, stage: "discovery".into(), ..Default::default() },
            support_reports: vec![],
            images: images.clone(),
            guidance: vec![],
            chat_summary: None,
            id: run_id.clone(),
            goal: format!("{}{}", prior, goal),
            team,
            skills: c.skills.clone(),
            status: "planning".into(),
            started_at: now(),
            finished_at: None,
            plan_session_id: None,
            closing_sessions: vec![],
            closing_reviews: vec![],
            configuration_changes: vec![],
            coordination: vec![],
            tasks: vec![],
            summary: String::new(),
            error: None,
            evidence_dir: dir.to_string_lossy().into(),
            artifacts: vec![],
            baseline: vec![],
            notified: false,
            capture_targets: c.team.evidence_targets.clone(),
            observations: vec![],
            recovered_plan: None,
            session_usage: Default::default(),
            evidence_expired_at: None,
        });
        if let Some(reply) = source_reply {
            if let Some(end) = c.messages.iter().position(|m| m.id == reply) {
                c.messages[end].run_id = Some(run_id.clone());
                let first = source_start.or_else(|| c.messages[..end].iter().rposition(|m|m.role=="user")).unwrap_or(end);
                for message in &mut c.messages[first..end] {
                    message.run_id = Some(run_id.clone());
                }
            }
        }
        Ok(())
    })?;
    runner::launch(&app, &run_id);
    Ok(run_id)
}

#[tauri::command]
pub async fn team_runs_control(
    app: AppHandle,
    run_id: String,
    action: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || control(&app, &run_id, &action))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn team_runs_stop_conflicts(app: AppHandle, chat_id: String, run_ids: Vec<String>) -> Result<Vec<conflicts::StopResult>, String> {
    tauri::async_runtime::spawn_blocking(move || conflicts::stop(&app,&chat_id,run_ids)).await.map_err(|e|e.to_string())?
}

fn control(app: &AppHandle, id: &str, action: &str) -> Result<(), String> {
    // Two retries must never launch two schedulers for the same run. Keep control
    // reconciliation serialized independently from short persistence checkpoints.
    let state = app.state::<TeamsState>();
    let _control = state.controls.lock().map_err(|e| e.to_string())?;
    let r = run(app, id)?;
    match action {
        "pause" if matches!(r.status.as_str(), "running" | "planning") => {
            update_run(app, id, |r| {
                r.status = "paused".into();
                Ok(())
            })?;
        }
        "cancel" if active(&r.status) || ["blocked","planning_blocked","plan_ready"].contains(&r.status.as_str()) || runner::unsettled(&r) => {
            let was_active = active(&r.status) && r.status != "plan_ready";
            let completed = matches!(r.status.as_str(),"completed"|"awaiting_manual_qa"|"qa_approved");
            if !was_active {
                runner::reconcile(app, &r, true)?;
            }
            update_run(app, id, |r| {
                if was_active { r.status="cancelling".into(); }
                else if !completed { r.status="cancelled".into(); }
                if r.status == "cancelled" {
                    r.finished_at = Some(now());
                    for task in &mut r.tasks {
                        if task.status != "completed" {
                            task.status = "cancelled".into();
                        }
                    }
                }
                if !completed { r.error = Some(
                    "Cancelación solicitada. Los cambios ya aplicados se conservan; revisá los archivos y la evidencia."
                        .into(),
                ); }
                Ok(())
            })?;
        }
        "resume" if r.status == "paused" => {
            update_run(app, id, |r| {
                r.status = if r.tasks.is_empty() {
                    "planning"
                } else {
                    "running"
                }
                .into();
                Ok(())
            })?;
            // If the scheduler exited while paused, restarting it is safe and
            // idempotent; ready tasks can continue without replaying prompts.
            runner::launch(app, id);
        }
        "continue" if r.status == "running" => {
            // A run can remain "running" after its scheduler thread stopped
            // (restart, pause/resume race or a dead worker). Reconcile any
            // uncertain session before relaunching; never replay blindly.
            if runner::unsettled(&r) {
                runner::reconcile(app, &r, false)?;
            }
            runner::launch(app, id);
        }
        "start_plan" if r.status == "plan_ready" => {
            let changes = plan_v2::stale_changes(&plan_v2::discover(&r)?, &r.plan_v2.discovery);
            if !changes.is_empty() {
                return Err(format!(
                    "STALE_BASELINE: los archivos cambiaron desde la validación del plan: {}",
                    changes.join("; ")
                ));
            }
            update_run(app,id,|r| {
                if !r.plan_v2.validation.as_ref().is_some_and(|v| v.valid) || plan_v2::plan_digest(r) != r.plan_v2.digest {
                    return Err("REVISION_CONFLICT: revisá el plan vigente antes de iniciar".into());
                }
                r.status = "running".into(); Ok(())
            })?;
            runner::launch(app,id);
        }
        "retry" | "force_retry" if ["blocked","failed","planning_blocked"].contains(&r.status.as_str()) => {
            let force = action == "force_retry";
            runner::reconcile(app, &r, force)?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while state.runners.lock().map_err(|e| e.to_string())?.contains(id) {
                if std::time::Instant::now() >= deadline { return Err("El scheduler todavía está cerrando las sesiones anteriores; esperá antes de continuar".into()); }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            if r.plan_v2.enabled && r.plan_v2.pending_change { plan_v2::apply_guidance(app,id)?; }
            update(app, |s| {
                let current = s
                    .chats
                    .iter()
                    .flat_map(|c| &c.runs)
                    .find(|v| v.id == id)
                    .ok_or("Ejecución inexistente")?;
                if s.chats.iter().flat_map(|c| &c.runs).any(|v| {
                    v.id != id
                        && (active(&v.status) || runner::unsettled(v))
                        && v.team.allowed_repositories.iter().any(|a| {
                            current
                                .team
                                .allowed_repositories
                                .iter()
                                .any(|b| overlaps(a, b))
                        })
                }) {
                    return Err("Otro equipo está usando estas carpetas".into());
                }
                let r = s
                    .chats
                    .iter_mut()
                    .flat_map(|c| &mut c.runs)
                    .find(|v| v.id == id)
                    .ok_or("Ejecución inexistente")?;
                for t in &mut r.tasks {
                    if t.status != "completed" && (!r.plan_v2.enabled || t.status != "cancelled") {
                        t.status = if r
                            .coordination
                            .iter()
                            .any(|c| c.from_task_id == t.id && c.status != "resolved")
                        {
                            "waiting_dependency"
                        } else {
                            "pending"
                        }
                        .into();
                        t.error = None;
                    }
                }
                for c in &mut r.coordination {
                    if c.status == "blocked" {
                        c.status = "pending".into();
                    }
                }
                r.status = if r.tasks.is_empty() {
                    "planning"
                } else {
                    "running"
                }
                .into();
                r.error = None;
                if let Some(state) = &mut r.continuous_fallback { state.resume(); }
                if r.tasks.is_empty() { r.recovered_plan = None; }
                Ok(())
            })?;
            runner::launch(app, id);
        }
        "approve" if matches!(r.status.as_str(), "completed" | "awaiting_manual_qa") => {
            update_run(app, id, |r| {
                if !conversation::review_ready(r) { return Err("El equipo todavía tiene trabajo o comprobaciones pendientes".into()); }
                r.status = "qa_approved".into();
                Ok(())
            })?;
        }
        _ => return Err("Esta acción no corresponde al estado actual".into()),
    }
    Ok(())
}

#[tauri::command]
pub fn team_tasks_reassign(
    app: AppHandle,
    run_id: String,
    task_id: String,
    employee: Employee,
) -> Result<(), String> {
    update_run(&app, &run_id, |r| {
        if r.plan_v2.enabled {
            return Err("Usá el tablero y apply_plan_patch para reasignar pendientes del Plan V2; los intentos anteriores no se alteran".into());
        }
        if r.status != "blocked" || runner::unsettled(r) {
            return Err("Solo se reasignan tareas bloqueadas sin sesiones pendientes".into());
        }
        let t = r
            .tasks
            .iter_mut()
            .find(|t| t.id == task_id)
            .ok_or("Tarea inexistente")?;
        if t.status == "completed" {
            return Err("La tarea ya terminó".into());
        }
        // Keep the chat's snapshot; record an explicit run-level configuration revision.
        let member = r
            .team
            .members
            .iter_mut()
            .find(|m| m.id == employee.id)
            .ok_or("Empleado inexistente")?;
        r.configuration_changes.push(serde_json::json!({"at":now(),"taskId":task_id,"beforeAgentId":t.assigned_agent_id,"agentId":employee.id,"beforeModel":member.model,"model":employee.model,"variant":employee.variant}));
        member.model = employee.model;
        member.variant = employee.variant;
        t.assigned_agent_id = member.id.clone();
        Ok(())
    })
}

#[tauri::command]
pub fn team_chats_planner(app: AppHandle, chat_id: String, config: plan_v2::PlanV2Config) -> Result<(),String> {
    routing::validate(&config.routing)?;
    update(&app,|s| {
        let chat = s.chats.iter_mut().find(|c| c.id == chat_id).ok_or("Chat inexistente")?;
        if chat.messages.iter().any(|m| m.status == "pending") { return Err("Esperá a que termine el mensaje del Lead".into()); }
        chat.team.plan_v2 = config;
        Ok(())
    })
}

#[tauri::command]
pub async fn team_routing_catalog(app: AppHandle, chat_id: String) -> Result<Vec<routing::AvailableModel>,String> {
    crate::proc::blocking(move || {
        let chat = read(&app)?.chats.into_iter().find(|c| c.id == chat_id).ok_or("Chat inexistente")?;
        let client = runner::client(&app,&chat.team.allowed_repositories[0])?;
        Ok(routing::catalog(&client.get_resilient("/config/providers")?))
    }).await
}

#[tauri::command]
pub fn preview_plan_patch(app: AppHandle, patch: plan_v2::PlanPatch) -> Result<plan_v2::PlanRevision,String> {
    let current = run(&app,&patch.run_id)?;
    plan_v2::simulate_patch(&current,&patch,"user").map(|(_,receipt)| receipt)
}

#[tauri::command]
pub fn apply_plan_patch(app: AppHandle, patch: plan_v2::PlanPatch) -> Result<plan_v2::PlanRevision,String> {
    update_run(&app,&patch.run_id,|current| {
        let (next,receipt) = plan_v2::simulate_patch(current,&patch,"user")?;
        *current = next;
        Ok(receipt)
    })
}

#[tauri::command]
pub fn team_runs_model(
    app: AppHandle,
    run_id: String,
    agent_id: String,
    model: ModelRef,
    variant: Option<String>,
) -> Result<(), String> {
    if model.provider_id.is_empty() || model.model_id.is_empty() {
        return Err("Seleccioná un modelo disponible".into());
    }
    update_run(&app, &run_id, |r| {
        if r.status != "blocked" || runner::unsettled(r) {
            return Err("Reconfigurá solo una ejecución bloqueada sin sesiones pendientes".into());
        }
        let employee = r
            .team
            .members
            .iter_mut()
            .find(|a| a.id == agent_id)
            .ok_or("Empleado inexistente")?;
        r.configuration_changes.push(serde_json::json!({"at":now(),"agentId":agent_id,"beforeModel":employee.model,"model":model,"variant":variant}));
        employee.model = model;
        employee.variant = variant;
        if r.plan_v2.enabled && !r.team.plan_v2.routing.pinned_agents.contains(&agent_id) { r.team.plan_v2.routing.pinned_agents.push(agent_id); }
        Ok(())
    })
}

#[tauri::command]
pub fn team_runs_limits(app: AppHandle, run_id: String, limits: Limits) -> Result<(), String> {
    validate_limits(&limits)?;
    update_run(&app, &run_id, |r| {
        if r.status != "blocked" || runner::unsettled(r) {
            return Err(
                "Ajustá límites solo con la ejecución bloqueada y las sesiones detenidas".into(),
            );
        }
        r.configuration_changes
            .push(serde_json::json!({"at":now(),"beforeLimits":r.team.limits,"limits":limits}));
        r.team.limits = limits;
        Ok(())
    })
}

#[tauri::command]
pub fn team_evidence_read(app: AppHandle, run_id: String, path: String) -> Result<String, String> {
    let r = run(&app, &run_id)?;
    if !r
        .artifacts
        .iter()
        .any(|a| a.relative_path == path && a.status == "captured")
    {
        return Err("Artefacto no registrado".into());
    }
    let file = evidence::safe_path(&r.evidence_dir, &path, true)?;
    if std::fs::metadata(&file).map_err(|e| e.to_string())?.len() > (4 * evidence::LIMIT) as u64 {
        return Err("Archivo demasiado grande".into());
    }
    std::fs::read_to_string(file)
        .map(|s| evidence::sanitize(&s))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn team_evidence_image(
    app: AppHandle,
    run_id: String,
    path: String,
) -> Result<serde_json::Value, String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let r = run(&app, &run_id)?;
    let observation = r
        .observations
        .iter()
        .find(|o| o.artifact_path.as_deref() == Some(&path) && o.status == "captured")
        .ok_or("Captura no registrada")?;
    let file = evidence::safe_path(&r.evidence_dir, &path, true)?;
    let bytes = capture::png(&file)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    if observation.sha256.as_deref() != Some(&hash) {
        return Err(
            "La captura cambió desde su registro; no se presenta como evidencia verificada".into(),
        );
    }
    Ok(
        serde_json::json!({"mime":"image/png","data":base64::engine::general_purpose::STANDARD.encode(&bytes),"sha256":hash}),
    )
}

#[tauri::command]
pub fn team_evidence_open(app: AppHandle, run_id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let r = run(&app, &run_id)?;
    app.opener()
        .open_path(r.evidence_dir, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn new_autonomous_chats_allow_ten_workers_without_preallocating_them() {
        let model = ModelRef { provider_id: "test".into(), model_id: "test".into() };
        let chat = autonomous_chat(&empty(), "D:/repo".into(), model, None).unwrap();
        assert_eq!(chat.team.max_parallel_tasks, 10);
        assert_eq!(chat.team.max_parallel_tasks, staffing::MAX_WORKERS);
        assert_eq!(chat.team.members.len(), 1);
        assert_eq!(chat.team.members[0].id, chat.team.lead_agent_id);
        assert!(chat.runs.is_empty());
        // Loading an explicitly configured team must not apply the new-chat default.
        let mut configured = chat.team;
        configured.max_parallel_tasks = 2;
        let restored: Team = serde_json::from_value(serde_json::to_value(&configured).unwrap()).unwrap();
        validate_team(&restored, &empty().skills).unwrap();
        assert_eq!(restored.max_parallel_tasks, 2);
    }
    #[test]
    fn changing_future_chat_model_preserves_run_snapshots_and_pending_turns() {
        let team = domain::tests::team();
        let mut chat: Chat = serde_json::from_value(serde_json::json!({"id":"chat","title":"chat","team":team,"skills":[],"archived":false,"createdAt":1,"runs":[{"id":"r","goal":"g","team":team,"skills":[],"status":"blocked","startedAt":1,"tasks":[],"summary":"","evidenceDir":"unused","artifacts":[],"baseline":[],"notified":false}]})).unwrap();
        let historical = serde_json::to_value(&chat.runs).unwrap();
        let replacement = ModelRef { provider_id: "another".into(), model_id: "available".into() };
        change_chat_model(&mut chat, "lead", replacement.clone(), None).unwrap();
        assert_eq!(chat.team.members[0].model.provider_id, "another");
        assert_eq!(serde_json::to_value(&chat.runs).unwrap(), historical);
        chat.messages.push(serde_json::from_value(serde_json::json!({"id":"pending","role":"assistant","text":"","createdAt":2,"status":"pending"})).unwrap());
        assert!(change_chat_model(&mut chat, "lead", ModelRef { provider_id:"third".into(), model_id:"model".into() }, None).is_err());
        assert_eq!(chat.team.members[0].model.model_id, replacement.model_id);
    }
    #[test]
    fn settings_cover_every_owned_session_and_legacy_chats_default_safe() {
        let team = domain::tests::team();
        let agent = team.members[0].clone();
        let task = serde_json::json!({"id":"t","title":"t","objective":"t","assignedAgentId":"lead","repository":"C:/demo","dependencies":[],"expectedFiles":[],"acceptanceCriteria":[],"status":"running",
            "attempts":[{"id":"a","agent":agent,"sessionId":"worker","reviewSessionId":"review","startedAt":1,"status":"running","summary":"","commands":[]}]});
        let run = serde_json::json!({"id":"r","goal":"g","team":team,"skills":[],"status":"running","startedAt":1,"planSessionId":"plan","closingSessions":["closing"],
            "supportReports":[{"id":"s","kind":"investigation","agent":agent,"sessionId":"support","repository":"C:/demo","taskId":null,"requestId":null,"startedAt":1,"finishedAt":null,"status":"running","summary":"","result":null}],
            "coordination":[{"id":"c","fromTaskId":"t","message":"","taskIds":[],"status":"pending","summary":"","createdAt":1,"sessions":["coordination"]}],
            "tasks":[task],"summary":"","evidenceDir":"unused","artifacts":[],"baseline":[],"notified":false});
        let chat: Chat = serde_json::from_value(serde_json::json!({
            "id":"chat","title":"chat","team":team,"skills":[],"archived":false,"createdAt":1,
            "messages":[{"id":"m","role":"assistant","text":"","createdAt":1,"status":"complete","runId":null,"sessionId":"conversation"}],
            "runs":[run]})).unwrap();
        assert_eq!(chat.memory, None);
        assert_eq!(chat.auto_approve, None);
        assert_eq!(chat_sessions(&chat), vec!["closing", "conversation", "coordination", "plan", "review", "support", "worker"]);
    }
    #[test]
    fn chrome_workspace_belongs_to_chat_across_lead_workers_and_restart() {
        let team = domain::tests::team();
        let agent = team.members[0].clone();
        let chat: Chat = serde_json::from_value(serde_json::json!({"id":"chat","title":"Original","team":team,"skills":[],"archived":false,"createdAt":1,
            "messages":[{"id":"m","role":"assistant","text":"","createdAt":1,"status":"pending","runId":null,"sessionId":"conversation"}],
            "runs":[{"id":"r","goal":"goal","team":team,"skills":[],"status":"running","startedAt":1,"planSessionId":"plan","closingSessions":["closing"],
                "tasks":[{"id":"t","title":"browse","objective":"browse","assignedAgentId":agent.id,"repository":"C:/demo","dependencies":[],"expectedFiles":[],"acceptanceCriteria":["observed"],
                    "attempts":[{"id":"a","agent":agent,"sessionId":"worker","reviewSessionId":"review","startedAt":1,"status":"running","summary":"","commands":[]}]}],
                "summary":"","evidenceDir":"unused","artifacts":[],"baseline":[],"notified":false}]})).unwrap();
        let mut store = empty(); store.chats.push(chat);
        for session in ["conversation", "worker", "review", "plan", "closing"] {
            assert_eq!(browser_owner(&store, session).as_deref(), Some("team:chat"));
        }
        assert_eq!(browser_owner(&store, "normal-chat"), None);
        assert_eq!(browser_owner(&store, ""), None);
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE team_store(id INTEGER PRIMARY KEY, document TEXT NOT NULL)").unwrap();
        write_db(&mut db, &store).unwrap();
        let mut reopened = read_db(&db).unwrap(); recover(&mut reopened);
        assert_eq!(browser_owner(&reopened, "worker").as_deref(), Some("team:chat"));
        assert_eq!(browser_owner(&reopened, "conversation").as_deref(), Some("team:chat"));
    }
    #[test]
    fn persistence_is_versioned_and_keeps_skills() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE team_store(id INTEGER PRIMARY KEY, document TEXT NOT NULL)")
            .unwrap();
        let mut store = empty();
        store.skills[0].version = 2;
        write_db(&mut db, &store).unwrap();
        assert_eq!(read_db(&db).unwrap().skills[0].version, 2);
        store.schema_version = 900;
        write_db(&mut db, &store).unwrap();
        assert!(read_db(&db).is_err());
    }
    #[test]
    fn schema_one_migrates_without_losing_snapshot_or_history() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE team_store(id INTEGER PRIMARY KEY, document TEXT NOT NULL)")
            .unwrap();
        let mut team = serde_json::to_value(domain::tests::team()).unwrap();
        team.as_object_mut().unwrap().remove("evidenceTargets");
        team.as_object_mut().unwrap().remove("limits");
        team.as_object_mut().unwrap().remove("planV2");
        let legacy = serde_json::json!({"schemaVersion":1,"teams":[team.clone()],"skills":catalog(),"chats":[{"id":"chat","title":"Original","team":team,"skills":[],"archived":false,"createdAt":12,"runs":[{"id":"original-run","goal":"Original goal","team":team,"skills":[],"status":"awaiting_manual_qa","startedAt":12,"finishedAt":13,"planSessionId":null,"tasks":[],"summary":"Entrega original","error":null,"evidenceDir":"original","artifacts":[],"baseline":[],"notified":true}]}]});
        db.execute("INSERT INTO team_store VALUES(1,?1)", [legacy.to_string()])
            .unwrap();
        let migrated = read_db(&db).unwrap();
        assert_eq!(migrated.schema_version, 3);
        let backup: String = db.query_row("SELECT document FROM team_store_migration_backup WHERE schema_version=1",[],|r| r.get(0)).unwrap();
        assert_eq!(backup,legacy.to_string());
        assert!(migrated.teams[0].evidence_targets.is_empty());
        assert!(!migrated.teams[0].plan_v2.enabled);
        let run = &migrated.chats[0].runs[0];
        assert_eq!(run.summary, "Entrega original");
        assert_eq!(run.status, "awaiting_manual_qa");
        assert!(run.notified);
        assert!(run.observations.is_empty());
        assert!(!run.plan_v2.enabled);
        assert!(run.session_usage.is_empty());
        write_db(&mut db, &migrated).unwrap();
        assert_eq!(read_db(&db).unwrap().chats[0].runs[0].id, "original-run");
    }
}
