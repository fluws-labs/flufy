//! Explicit, session-bound delegation from an ordinary chat to the existing team runner.
use super::{domain::*, lead_inbox, update};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    pub session_id: String,
    pub message_id: String,
    pub title: String,
    pub directory: String,
    pub created_at: i64,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_reference: Option<crate::preview::Reference>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    project_root: String,
    #[serde(default)]
    preview_identity: Option<crate::preview::Identity>,
    title: String,
    goal: String,
    plan: String,
    context: String,
    decisions: Vec<super::delivery_review::ProjectConstraint>,
    acceptance_criteria: Vec<String>,
}

struct Source {
    session_id: String,
    message_id: String,
    title: String,
    directory: String,
    user_request: String,
    model: ModelRef,
    variant: Option<String>,
    preview_reference: Option<crate::preview::Reference>,
}

pub fn tools() -> Vec<Value> {
    vec![json!({"name":"delegate","description":"usá start_work para el Lead en esta misma conversación; no abras otro chat. Inicia un equipo para implementar el plan acordado en ESTE chat después de que el usuario elija «Con un equipo» o pida explícitamente esa delegación. Antes de empezar un trabajo de implementación no trivial, si no eligió modo, preguntale una sola vez con question: «¿Querés que lo resuelva un equipo o seguimos en este chat?»; no preguntes en consultas ni cambios triviales. Transfiere objetivo, plan, investigación relevante, decisiones y aceptación; hereda carpeta y modelo, conserva enlace al chat de origen y devuelve el ID de la ejecución real. No usar para preguntas o ejemplos sobre equipos. Reintentos del mismo pedido reutilizan el equipo y no duplican ejecuciones.","inputSchema":{"type":"object","additionalProperties":false,"properties":{
        "projectRoot":{"type":"string","description":"Carpeta absoluta de este chat, incluido su worktree si corresponde. El servidor la contrasta con la sesión real."},
        "previewIdentity":{"type":"object","description":"Identidad exacta de la tarea vigente elegida por el usuario en el panel. Obligatoria si esta conversación tiene diseños; nunca inferir la última fila ni reutilizar otra tarea.","properties":{"projectRoot":{"type":"string"},"sessionId":{"type":"string"},"taskId":{"type":"string"},"designId":{"type":"string"}},"required":["projectRoot","sessionId","taskId","designId"],"additionalProperties":false},
        "title":{"type":"string","description":"Nombre breve del trabajo"},
        "goal":{"type":"string","description":"Resultado que el usuario quiere conseguir"},
        "plan":{"type":"string","description":"Plan concreto acordado, con alcance y pasos de implementación. No basta decir implementá lo conversado."},
        "context":{"type":"string","description":"Hallazgos de investigación, archivos, contratos y referencias necesarios. Resumen pertinente; no copiar toda la conversación ni credenciales."},
        "decisions":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"decision":{"type":"string"},"source":{"type":"string"}},"required":["decision","source"]},"description":"Decisiones vigentes de arquitectura, diseño, presupuesto de infraestructura, alcance y objetivos, con su procedencia. Vacío si no hay decisiones conocidas."},
        "acceptanceCriteria":{"type":"array","items":{"type":"string"},"description":"Comportamientos concretos que definen una entrega aceptable"}
    },"required":["projectRoot","title","goal","plan","context","decisions","acceptanceCriteria"]}}),
        json!({"name":"start_work","description":"Inicia el trabajo del equipo en ESTA misma conversación. Usalo cuando el usuario pida implementar, corregir o verificar algo concreto; el Lead organiza especialistas, no ejecuta tareas. No lo uses para conversar ni para preguntas. Devuelve el trabajo real creado.","inputSchema":{"type":"object","additionalProperties":false,"properties":{
            "goal":{"type":"string","description":"Resultado completo y verificable que debe entregar el equipo, con el alcance acordado en la conversación."}
        },"required":["goal"]}}),
        json!({"name":"adjust_plan","description":"Ajusta el trabajo en curso con una indicación concreta del usuario: alcance, prioridad, una decisión o una corrección. Usalo cuando el usuario pida cambiar algo mientras el equipo trabaja; no implementes la tarea vos. Devuelve si la indicación quedó aplicándose.","inputSchema":{"type":"object","additionalProperties":false,"properties":{
            "guidance":{"type":"string","description":"Indicación concreta y completa del usuario, sin inventar alcance nuevo."}
        },"required":["guidance"]}}),
        json!({"name":"board","description":"Lee el tablero real de esta conversación: estado del run, tareas, bloqueos, coordinación, soporte activo y otros equipos que ocupan las mismas carpetas. Usalo antes de responder sobre tareas, bloqueos, conflictos o próxima acción; nunca inventes ese estado.","inputSchema":{"type":"object","additionalProperties":false,"properties":{
            "runId":{"type":"string","description":"Ejecución a leer. Si se omite, usa la última del trabajo."}
        }}}),
        json!({"name":"control_run","description":"Controla el trabajo de esta conversación: retry/force_retry para reanudar tras una interrupción, pause/resume/cancel. Usalo después de leer teams_board. Si hay una sesión activa, pedí confirmación al usuario antes de force_retry.","inputSchema":{"type":"object","additionalProperties":false,"properties":{"runId":{"type":"string"},"action":{"type":"string","enum":["retry","force_retry","pause","resume","cancel","continue"]}},"required":["action"]}}),
        json!({"name":"system_resources","description":"Lee la memoria fisica, el commit libre, la CPU y las otras instancias de Flufy de esta PC. Usalo antes de iniciar un equipo o de incorporar muchos especialistas. Si pressure es tight, reduci la concurrencia; si es critical, no inicies trabajo nuevo y explica al usuario que cerrar. Flufy solo limita su propio trabajo: no cierra programas del usuario.","inputSchema":{"type":"object","additionalProperties":false,"properties":{}}})]
}

fn source_from(session_id: &str, session: &Value, messages: &Value) -> Result<Source, String> {
    if session["id"] != session_id { return Err("La sesión de origen no coincide con la conversación enlazada".into()); }
    let messages = messages.as_array().ok_or("No se pudo leer el contexto del chat de origen")?;
    let user = messages.iter().rev().find(|m| m["info"]["role"] == "user")
        .ok_or("No hay un pedido del usuario para delegar")?;
    let user_request = user["parts"].as_array().into_iter().flatten()
        .filter(|p| p["type"] == "text" && p["synthetic"] != true && p["ignored"] != true)
        .filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n");
    let message_id = user["info"]["id"].as_str().filter(|id| !id.is_empty()).ok_or("El pedido de origen no tiene identidad")?;
    if user_request.trim().is_empty() { return Err("La delegación necesita un pedido visible del usuario".into()); }
    let model = serde_json::from_value::<ModelRef>(user["info"]["model"].clone()).ok()
        .or_else(|| messages.iter().rev().find_map(|m| {
            if m["info"]["role"] != "assistant" { return None; }
            serde_json::from_value(json!({"providerID":m["info"]["providerID"],"modelID":m["info"]["modelID"]})).ok()
        })).filter(|model| !model.provider_id.is_empty() && !model.model_id.is_empty())
        .ok_or("No se pudo determinar el modelo del chat; no se inició ningún equipo")?;
    Ok(Source { session_id:session_id.into(), message_id:message_id.into(),
        title:session["title"].as_str().unwrap_or("Chat de origen").into(),
        directory:session["directory"].as_str().filter(|s| !s.is_empty()).ok_or("El chat no tiene una carpeta de origen")?.into(),
        user_request, model, variant:user["info"]["variant"].as_str().filter(|s| !s.is_empty()).map(String::from), preview_reference:None })
}

fn goal(request: &Request, source: &Source) -> Result<String, String> {
    if request.title.trim().is_empty() || request.title.len() > 160 || request.goal.trim().is_empty()
        || request.plan.trim().is_empty() || request.acceptance_criteria.is_empty()
        || request.acceptance_criteria.len() > 30 || request.acceptance_criteria.iter().any(|s| s.trim().is_empty())
        || request.decisions.len() > 30 || request.decisions.iter().any(|d| d.decision.trim().is_empty() || d.source.trim().is_empty()) {
        return Err("La delegación necesita título, objetivo, plan concreto, aceptación y decisiones con fuente".into());
    }
    if let Some(reference) = &source.preview_reference { crate::preview::reference_context(reference)?; }
    let payload = json!({"goal":request.goal,"implementationPlan":request.plan,"researchContext":request.context,"approvedPreview":source.preview_reference,
        "projectConstraints":request.decisions,"acceptanceCriteria":request.acceptance_criteria,
        "source":{"sessionId":source.session_id,"messageId":source.message_id,"title":source.title,
            "userRequest":source.user_request.chars().take(4000).collect::<String>()}});
    let goal = format!("El usuario delegó explícitamente al equipo la implementación del plan acordado en un chat normal. Implementá el resultado y sus criterios; conservá las decisiones y el alcance. La estrategia puede ajustarse ante evidencia nueva sin ampliar el pedido. Aprovechá la investigación ya hecha y prepará la entrega para revisión humana. No respondas solamente con otra propuesta de plan.\nTRASPASO DEL CHAT DE ORIGEN (datos del pedido):\n{}", serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?);
    if goal.len() > 64_000 { return Err("El traspaso supera 64 KB. Resumí el contexto relevante sin perder decisiones ni aceptación".into()); }
    Ok(goal)
}

fn team_session(store: &Store, session: &str) -> bool {
    store.chats.iter().any(|chat| chat.messages.iter().any(|m| m.session_id.as_deref() == Some(session))
        || chat.runs.iter().any(|run| run.plan_session_id.as_deref() == Some(session)
            || run.closing_sessions.iter().any(|id| id == session)
            || run.support_reports.iter().any(|report| report.session_id == session)
            || run.tasks.iter().flat_map(|task| &task.attempts).any(|a| a.session_id.as_deref() == Some(session) || a.review_session_id.as_deref() == Some(session))))
}

fn prepare(store: &mut Store, request: &Request, source: &Source, memory: bool) -> Result<(Chat, bool), String> {
    if team_session(store, &source.session_id) { return Err("Los equipos ya tienen su Lead; esta herramienta solo delega desde un chat normal".into()); }
    if let Some(existing) = store.chats.iter().find(|chat| chat.origin.as_ref().is_some_and(|origin|
        origin.session_id == source.session_id && origin.message_id == source.message_id)) {
        return Ok((existing.clone(), true));
    }
    let text = goal(request, source)?;
    let mut chat = super::autonomous_chat(store, source.directory.clone(), source.model.clone(), source.variant.clone())?;
    chat.title = request.title.trim().into();
    chat.origin = Some(Origin { session_id:source.session_id.clone(), message_id:source.message_id.clone(),
        title:source.title.clone(), directory:source.directory.clone(), created_at:now(), error:None, preview_reference:source.preview_reference.clone() });
    chat.memory = Some(memory);
    // New autonomous teams start with full access inside their scoped tools;
    // the chat's own switch can turn it off later.
    chat.auto_approve = Some(true);
    chat.messages.push(ChatMessage { continuous_fallback:None, clarification_start:None, images:vec![], id:id(), role:"user".into(),
        text, created_at:now(), status:"complete".into(), run_id:None, session_id:None });
    store.chats.push(chat.clone());
    Ok((chat, false))
}

// Activation for the conversational Lead. It binds the SOURCE session and
// records the first turn, but deliberately does not patch permissions or start
// work: the durable actor (not yet implemented) owns that step. This keeps a
// half-built feature from silently restricting an ordinary chat.
fn prepare_lead(
    store: &mut Store,
    tx: &rusqlite::Transaction<'_>,
    request: &Request,
    source: &Source,
    memory: bool,
) -> Result<(Chat, bool, Option<lead_inbox::Receipt>), String> {
    if team_session(store, &source.session_id) {
        return Err("Este chat ya pertenece a un equipo; un Lead no puede delegarse dentro de otro".into());
    }
    if let Some(chat_id) = lead_inbox::bound_chat_tx(tx, &source.session_id)? {
        let chat = store.chats.iter().find(|chat| chat.id == chat_id)
            .ok_or("El vínculo del chat apunta a un equipo inexistente")?;
        return Ok((chat.clone(), true, None));
    }
    let text = goal(request, source)?;
    let mut chat = super::autonomous_chat(store, source.directory.clone(), source.model.clone(), source.variant.clone())?;
    chat.title = request.title.trim().into();
    chat.origin = Some(Origin {
        session_id: source.session_id.clone(),
        message_id: source.message_id.clone(),
        title: source.title.clone(),
        directory: source.directory.clone(),
        created_at: now(),
        error: None,
        preview_reference: source.preview_reference.clone(),
    });
    chat.memory = Some(memory);
    chat.auto_approve = Some(false);
    chat.messages.push(ChatMessage {
        continuous_fallback: None,
        clarification_start: None,
        images: vec![],
        id: id(),
        role: "user".into(),
        text,
        created_at: now(),
        status: "complete".into(),
        run_id: None,
        session_id: None,
    });
    store.chats.push(chat.clone());
    lead_inbox::bind(tx, &source.session_id, &chat.id, &source.directory, now())?;
    let receipt = lead_inbox::enqueue(
        tx,
        &chat.id,
        &format!("activate:{}:{}", source.session_id, source.message_id),
        "team.activated",
        &json!({
            "sourceSessionId": source.session_id,
            "sourceMessageId": source.message_id,
            "title": request.title,
            "goal": request.goal,
        }),
        Some(100),
        now(),
    )?;
    Ok((chat, false, Some(receipt)))
}

fn lead_receipt(chat: &Chat, reused: bool, event: Option<lead_inbox::Receipt>) -> Value {
    json!({
        "teamChatId": chat.id,
        "sourceSessionId": chat.origin.as_ref().map(|origin| &origin.session_id),
        "runId": null,
        "status": "lead_bound_pending_actor",
        "reused": reused,
        "event": event,
        "message": "La conversación quedó vinculada a un equipo. El Lead todavía no tomó el control ni inició trabajo porque el actor durable está en implementación."
    })
}

fn activate(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let task = crate::desktop::tasks::current(app).ok_or("No hay una conversación de origen enlazada")?;
    crate::desktop::tasks::check_bound(app)?;
    if super::bound_chat(app, &task.session)?.is_some() {
        return Err("Esta conversación ya tiene un equipo vinculado".into());
    }
    let request: Request = serde_json::from_value(args.clone()).map_err(|e| format!("Activación inválida: {}", e))?;
    let root = super::canonical(&request.project_root)?;
    let client = super::runner::client(app, &root)?;
    let session = client.get_resilient(&format!("/session/{}", task.session))?;
    let messages = client.get_resilient(&format!("/session/{}/message", task.session))?;
    let mut source = source_from(&task.session, &session, &messages)?;
    source.directory = super::canonical(&source.directory)?;
    if source.directory != root {
        return Err("El equipo debe trabajar en la carpeta real del chat de origen, incluido su worktree".into());
    }
    let state = app.state::<super::TeamsState>();
    let _dispatch = state.handoffs.lock().map_err(|_| "No se pudo ordenar la activación")?;
    crate::desktop::tasks::check_bound(app)?;
    let memory = crate::memory::session_enabled(app, &source.session_id);
    let (chat, reused, event) = super::update_lead(app, |store, tx| prepare_lead(store, tx, &request, &source, memory))?;
    Ok(lead_receipt(&chat, reused, event))
}

fn receipt(chat: &Chat, reused: bool) -> Value {
    let run = chat.runs.last();
    json!({"teamChatId":chat.id,"runId":run.map(|r| &r.id),"title":chat.title,
        "status":run.map(|r| r.status.as_str()).unwrap_or("not_started"),"reused":reused,
        "sourceSessionId":chat.origin.as_ref().map(|o| &o.session_id),
        "message":"El equipo tomó el plan. El chat original se conserva; podés abrir el equipo para seguir el progreso y revisar la entrega."})
}

fn delegate(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let task = crate::desktop::tasks::current(app).ok_or("No hay una conversación de origen enlazada")?;
    crate::desktop::tasks::check_bound(app)?;
    if super::bound_chat(app, &task.session)?.is_some() {
        return Err("Esta conversación ya tiene un Lead vinculado; no se crea otro equipo".into());
    }
    let request: Request = serde_json::from_value(args.clone()).map_err(|e| format!("Traspaso inválido: {}", e))?;
    let root = super::canonical(&request.project_root)?;
    let client = super::runner::client(app, &root)?;
    let session = client.get_resilient(&format!("/session/{}", task.session))?;
    let messages = client.get_resilient(&format!("/session/{}/message", task.session))?;
    let mut source = source_from(&task.session, &session, &messages)?;
    source.directory = super::canonical(&source.directory)?;
    if source.directory != root { return Err("El equipo debe trabajar en la carpeta real del chat de origen, incluido su worktree".into()); }
    let state = app.state::<super::TeamsState>();
    let _dispatch = state.handoffs.lock().map_err(|_| "No se pudo ordenar el traspaso")?;
    crate::desktop::tasks::check_bound(app)?;
    // A retry resumes the stored snapshot, even if the source has a newer draft.
    // Do not resolve mutable designs again or replace a missing legacy snapshot.
    let existing = super::read(app)?.chats.into_iter().find(|chat| chat.origin.as_ref().is_some_and(|origin|
        origin.session_id == source.session_id && origin.message_id == source.message_id));
    source.preview_reference = if let Some(chat) = existing {
        let origin = chat.origin.as_ref().ok_or("PREVIEW_REFERENCE_MISSING: falta el origen persistido")?;
        if let Some(requested) = &request.preview_identity {
            if let Some(frozen) = &origin.preview_reference {
                if super::canonical(&requested.project_root)? != frozen.identity.project_root || requested.session_id != frozen.identity.session_id
                    || requested.task_id != frozen.identity.task_id || requested.design_id != frozen.identity.design_id {
                    return Err("PREVIEW_SCOPE: la tarea solicitada difiere de la referencia congelada de esta ejecución".into());
                }
            } else {
                return Err("PREVIEW_REFERENCE_MISSING: este traspaso no conserva una referencia; no se sustituye al reanudar".into());
            }
        }
        if let Some(reference) = &origin.preview_reference { crate::preview::reference_context_for_origin(reference,&source.directory,&source.session_id)?; }
        origin.preview_reference.clone()
    } else {
        crate::preview::session_reference(app, &root, &source.session_id, request.preview_identity.clone())?
    };
    let (chat, reused) = update(app, |store| prepare(store, &request, &source, crate::memory::session_enabled(app, &source.session_id)))?;
    if !chat.runs.is_empty() { return Ok(receipt(&chat, true)); }
    if chat.archived { return Err("El equipo de este pedido está archivado; restauralo para continuar".into()); }
    crate::desktop::tasks::check_bound(app)?;
    let result = super::start_run(app.clone(), chat.id.clone(), chat.messages[0].text.clone(), vec![], None);
    let snapshot = update(app, |store| {
        let chat = store.chats.iter_mut().find(|c| c.id == chat.id).ok_or("El equipo del traspaso ya no existe")?;
        match &result {
            Ok(run_id) => { chat.messages[0].run_id = Some(run_id.clone()); if let Some(origin) = &mut chat.origin { origin.error = None; } }
            Err(error) => { if let Some(origin) = &mut chat.origin { origin.error = Some(super::evidence::sanitize(error)); } }
        }
        Ok(chat.clone())
    })?;
    result.map_err(|error| format!("El equipo «{}» quedó enlazado, pero no pudo iniciar: {}. No se duplicará al reintentar este pedido.", snapshot.title, error))?;
    Ok(receipt(&snapshot, reused))
}

fn session_root(app: &AppHandle, session: &str) -> Result<String, String> {
    let client = crate::oc::Opencode::new(&crate::ensure_server(app)?, "");
    let value = client.get_resilient(&format!("/session/{}", session))?;
    value["directory"].as_str().filter(|directory| !directory.trim().is_empty())
        .map(String::from)
        .ok_or_else(|| "La conversación no tiene una carpeta de trabajo".to_string())
}

fn board(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let task = crate::desktop::tasks::current(app).ok_or("No hay una conversación de origen enlazada")?;
    crate::desktop::tasks::check_bound(app)?;
    let chat_id = super::bound_chat(app, &task.session)?
        .ok_or("Esta conversación todavía no tiene un trabajo de equipo")?;
    let store = super::read(app)?;
    let chat = store.chats.iter().find(|chat| chat.id == chat_id)
        .ok_or("El vínculo apunta a un equipo inexistente")?;
    let requested = args["runId"].as_str().filter(|id| !id.is_empty());
    let run = requested
        .and_then(|id| chat.runs.iter().find(|run| run.id == id))
        .or_else(|| chat.runs.last())
        .ok_or("El trabajo todavía no tiene una ejecución")?;
    let tasks: Vec<Value> = run.tasks.iter().filter(|task| task.contract.task_kind.as_deref() != Some("group"))
        .map(|task| {
            let attempt = task.attempts.last();
            json!({
                "id": task.id,
                "title": &task.title,
                "status": &task.status,
                "agent": run.team.members.iter().find(|agent| agent.id == task.assigned_agent_id)
                    .map(|agent| json!({"name": agent.name, "role": agent.role})),
                "objective": task.objective.chars().take(500).collect::<String>(),
                "acceptanceCriteria": &task.acceptance_criteria,
                "error": task.error.as_ref().map(|error| error.chars().take(500).collect::<String>()),
                "attempt": attempt.map(|attempt| json!({
                    "status": attempt.status,
                    "summary": attempt.summary.chars().take(500).collect::<String>(),
                    "review": attempt.review,
                    "running": attempt.finished_at.is_none() && (attempt.session_id.is_some() || attempt.review_session_id.is_some()),
                    "failedCommands": attempt.commands.iter().filter(|command| command["exitCode"].as_i64().is_some_and(|code| code != 0))
                        .map(|command| command["command"].clone()).collect::<Vec<_>>(),
                })),
            })
        }).collect();
    let unresolved: Vec<Value> = run.coordination.iter()
        .filter(|request| !["resolved", "cancelled"].contains(&request.status.as_str()))
        .map(|request| json!({
            "fromTaskId": request.from_task_id,
            "toTaskIds": request.task_ids,
            "status": request.status,
            "summary": request.summary.chars().take(500).collect::<String>(),
        })).collect();
    let activeSupport: Vec<Value> = run.support_reports.iter().filter(|report| report.finished_at.is_none())
        .map(|report| json!({"kind": report.kind, "status": report.status, "agent": report.agent.name}))
        .collect();
    // Other teams that currently hold the same folders are part of the real
    // blocker; the user-facing Lead must be able to name them, not guess.
    let other_teams: Vec<Value> = store.chats.iter()
        .filter(|owner| owner.id != chat.id)
        .flat_map(|owner| owner.runs.iter().map(move |run| (owner, run)))
        .filter(|(_, run)| super::conflicts::occupies(run) && super::conflicts::in_scope(chat, run))
        .map(|(owner, run)| json!({
            "chat": owner.title,
            "run": run.id,
            "status": run.status,
            "tasks": run.tasks.iter().filter(|task| task.status != "completed").map(|task| task.title.clone()).take(8).collect::<Vec<_>>(),
        })).collect();
    Ok(json!({
        "chat": chat.title,
        "conversation": chat.origin.as_ref().map(|origin| &origin.title),
        "run": {
            "id": run.id,
            "goal": run.goal.chars().take(1000).collect::<String>(),
            "status": run.status,
            "error": run.error.as_ref().map(|error| error.chars().take(800).collect::<String>()),
            "stage": run.plan_v2.stage,
            "revision": run.plan_v2.revision_number,
            "pendingChange": run.plan_v2.pending_change,
            "completed": tasks.iter().filter(|task| task["status"] == "completed").count(),
            "total": tasks.len(),
        },
        "tasks": tasks,
        "unresolvedCoordination": unresolved,
        "activeSupport": activeSupport,
        "otherTeamsInFolder": other_teams,
    }))
}

fn control_run(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let task = crate::desktop::tasks::current(app).ok_or("No hay una conversación de origen enlazada")?;
    crate::desktop::tasks::check_bound(app)?;
    let chat_id = super::bound_chat(app, &task.session)?
        .ok_or("Esta conversación todavía no tiene un trabajo de equipo")?;
    let action = args["action"].as_str().map(str::trim).filter(|action| !action.is_empty())
        .ok_or("Falta la acción de control")?;
    if !["retry", "force_retry", "pause", "resume", "cancel", "continue"].contains(&action) {
        return Err("Acción de control inválida".into());
    }
    let chat = read_chat(app, &chat_id)?;
    let run = args["runId"].as_str().filter(|id| !id.is_empty())
        .and_then(|id| chat.runs.iter().find(|run| run.id == id))
        .or_else(|| chat.runs.last())
        .ok_or("El trabajo todavía no tiene una ejecución")?;
    super::control(app, &run.id, action)?;
    Ok(json!({ "runId": run.id, "action": action, "status": "ok" }))
}

fn adjust_plan(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let task = crate::desktop::tasks::current(app).ok_or("No hay una conversación de origen enlazada")?;
    crate::desktop::tasks::check_bound(app)?;
    let chat_id = super::bound_chat(app, &task.session)?
        .ok_or("Esta conversación todavía no tiene un trabajo de equipo")?;
    let guidance = args["guidance"].as_str().map(str::trim).filter(|text| !text.is_empty())
        .ok_or("La indicación necesita un texto concreto")?;
    if guidance.len() > 8_000 { return Err("La indicación es demasiado larga".into()); }
    let chat = read_chat(app, &chat_id)?;
    let run = chat.runs.last().ok_or("El trabajo todavía no tiene una ejecución")?;
    if !matches!(run.status.as_str(), "planning" | "plan_ready" | "running" | "paused" | "blocked" | "planning_blocked") {
        return Err("El trabajo ya no está en una etapa que acepte cambios".into());
    }
    let apply_now = run.plan_v2.enabled && run.plan_v2.revision_number > 0;
    let run_id = run.id.clone();
    super::update_run(app, &run_id, |current| {
        current.guidance.push(guidance.into());
        if apply_now { current.plan_v2.pending_change = true; }
        Ok(())
    })?;
    if apply_now {
        let app = app.clone();
        let run_id = run_id.clone();
        std::thread::spawn(move || {
            if let Err(error) = super::plan_v2::apply_guidance(&app, &run_id) {
                log::warn!("[teams-lead] no se pudo aplicar la indicación: {}", error);
            }
        });
        return Ok(json!({ "status": "applying", "message": "La indicación se está aplicando al plan; las tareas ya iniciadas conservan su trabajo." }));
    }
    if matches!(run.status.as_str(), "blocked" | "failed") {
        super::control(app, &run_id, "retry")?;
        return Ok(json!({ "status": "retrying", "message": "Guardé la indicación y reanudé el trabajo." }));
    }
    Ok(json!({ "status": "recorded", "message": "Guardé la indicación para las próximas tareas y la revisión del Lead." }))
}

fn start_work(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let task = crate::desktop::tasks::current(app).ok_or("No hay una conversación de origen enlazada")?;
    crate::desktop::tasks::check_bound(app)?;
    let goal = args["goal"].as_str().map(str::trim).filter(|goal| !goal.is_empty())
        .ok_or("El trabajo necesita un objetivo concreto")?;
    if goal.len() > 64_000 { return Err("El objetivo supera 64 KB".into()); }
    // A normal conversation becomes the Lead the first time real work starts.
    // This is the only activation path exposed to the model: no second chat.
    let chat_id = match super::bound_chat(app, &task.session)? {
        Some(chat_id) => chat_id,
        None => {
            let root = session_root(app, &task.session)?;
            let title: String = goal.lines().next().unwrap_or("Equipo").chars().take(120).collect();
            let request = json!({
                "projectRoot": root,
                "title": title,
                "goal": goal,
                "plan": "El equipo acordará el plan con el usuario y lo confirmará en el tablero antes de ejecutar.",
                "context": "",
                "decisions": [],
                "acceptanceCriteria": ["El objetivo completo se implementa y se verifica con evidencia"]
            });
            let receipt = activate(app, &request)?;
            receipt["teamChatId"].as_str().ok_or("La activación no devolvió el equipo")?.to_string()
        }
    };
    if read_chat(app, &chat_id)?.runs.iter().any(|run| active(&run.status)) {
        return Err("El equipo ya tiene un trabajo en curso en esta conversación".into());
    }
    let run_id = super::start_conversation_run(app, &chat_id, goal)?;
    Ok(json!({
        "teamChatId": chat_id,
        "runId": run_id,
        "status": "planning",
        "message": "El equipo empezó a planificar en esta misma conversación. El tablero muestra el avance; el plan interno no se muestra como chat."
    }))
}

fn read_chat(app: &AppHandle, chat_id: &str) -> Result<Chat, String> {
    super::read(app)?.chats.into_iter()
        .find(|chat| chat.id == chat_id)
        .ok_or("Chat de equipo inexistente".into())
}

/// Registered as a native command. Not yet exposed to the model or UI.
pub fn activate_lead(app: &AppHandle, args: &Value) -> Result<Value, String> {
    activate(app, args)
}

pub fn call(app: &AppHandle, name: &str, args: &Value) -> Value {
    let result = match name {
        "delegate" => delegate(app, args),
        "start_work" => start_work(app, args),
        "adjust_plan" => adjust_plan(app, args),
        "board" => board(app, args),
        "control_run" => control_run(app, args),
        "system_resources" => Ok(crate::resources::tool_payload(app)),
        _ => Err("Herramienta de equipos desconocida".into()),
    };
    match result {
        Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}]}),
        Err(error) => json!({"content":[{"type":"text","text":error}],"isError":true}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exposes_system_resources_to_the_lead() {
        assert!(tools().iter().any(|tool| tool["name"] == "system_resources"));
    }
    fn request() -> Request { serde_json::from_value(json!({"projectRoot":"C:/repo","title":"Filtro de consultas","goal":"Filtrar por estado","plan":"Reutilizar el filtro existente, persistir estado y probar el recorrido","context":"El panel usa componentes compartidos","decisions":[{"decision":"Conservar arquitectura y diseño","source":"AGENTS.md"}],"acceptanceCriteria":["El filtro se conserva al volver"]})).unwrap() }
    fn source() -> Source { source_from("ses_source", &json!({"id":"ses_source","directory":"C:/repo","title":"Investigación"}), &json!([
        {"info":{"id":"user1","role":"user","model":{"providerID":"openai","modelID":"lead"},"variant":"high"},"parts":[{"type":"text","text":"Quiero que un equipo implemente este plan"}]}
    ])).unwrap() }
    #[test]
    fn transfers_plan_context_and_decisions_once_and_preserves_settings() {
        let mut store = super::super::empty();
        let request = request(); let source = source();
        let (first, reused) = prepare(&mut store, &request, &source, false).unwrap();
        assert!(!reused);
        assert_eq!(first.memory, Some(false)); assert_eq!(first.auto_approve, Some(true));
        assert_eq!(first.team.members[0].model.model_id, "lead");
        assert_eq!(first.team.members[0].variant.as_deref(), Some("high"));
        assert!(first.messages[0].text.contains("Conservar arquitectura y diseño"));
        assert!(first.messages[0].text.contains("El filtro se conserva al volver"));
        assert!(first.messages[0].text.contains("componentes compartidos"));
        let persisted = serde_json::to_string(&store).unwrap();
        let mut restored: Store = serde_json::from_str(&persisted).unwrap();
        let (retry, reused) = prepare(&mut restored, &request, &source, true).unwrap();
        assert!(reused); assert_eq!(retry.id, first.id); assert_eq!(restored.chats.len(), 1);
        assert_eq!(retry.memory, Some(false));
    }
    #[test]
    fn distinct_user_requests_can_delegate_new_work_but_teams_cannot_nest() {
        let mut store = super::super::empty(); let mut source = source();
        prepare(&mut store, &request(), &source, true).unwrap();
        source.message_id = "user2".into();
        prepare(&mut store, &request(), &source, true).unwrap();
        assert_eq!(store.chats.len(), 2);
        store.chats[0].messages[0].session_id = Some(source.session_id.clone());
        assert!(prepare(&mut store, &request(), &source, true).is_err());
    }
    fn lead_database() -> rusqlite::Connection {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        super::super::lead_inbox::migrate(&mut db).unwrap();
        db
    }

    #[test]
    fn activation_binds_the_source_session_once_and_records_one_event() {
        let mut db = lead_database();
        let mut store = super::super::empty();
        let request = request();
        let source = source();
        let chat_id;
        {
            let tx = db.transaction().unwrap();
            let (chat, reused, event) = prepare_lead(&mut store, &tx, &request, &source, true).unwrap();
            assert!(!reused);
            assert!(event.is_some());
            assert_eq!(chat.origin.as_ref().unwrap().session_id, "ses_source");
            assert_eq!(chat.memory, Some(true));
            assert_eq!(chat.auto_approve, Some(false));
            chat_id = chat.id.clone();
            tx.commit().unwrap();
        }
        assert_eq!(store.chats.len(), 1);
        {
            let tx = db.transaction().unwrap();
            let (again, reused, event) = prepare_lead(&mut store, &tx, &request, &source, false).unwrap();
            assert!(reused);
            assert!(event.is_none(), "A retry must not enqueue another activation");
            assert_eq!(again.id, chat_id);
            assert_eq!(again.memory, Some(true), "A retry must not rewrite accepted settings");
            tx.commit().unwrap();
        }
        assert_eq!(store.chats.len(), 1);
        let events: i64 = db.query_row("SELECT COUNT(*) FROM team_events", [], |r| r.get(0)).unwrap();
        assert_eq!(events, 1);
        assert_eq!(
            db.query_row("SELECT source_session_id FROM team_conversation_bindings", [], |r| r.get::<_, String>(0)).unwrap(),
            "ses_source"
        );
    }

    #[test]
    fn activation_rolls_back_without_leaving_a_binding_or_event() {
        let mut db = lead_database();
        let original = super::super::empty();
        let mut staged = original.clone();
        {
            let tx = db.transaction().unwrap();
            prepare_lead(&mut staged, &tx, &request(), &source(), true).unwrap();
            // Process loss before commit: the caller never installs `staged`
            // and SQLite rolls the transaction back.
        }
        assert!(original.chats.is_empty());
        let events: i64 = db.query_row("SELECT COUNT(*) FROM team_events", [], |r| r.get(0)).unwrap();
        let bindings: i64 = db.query_row("SELECT COUNT(*) FROM team_conversation_bindings", [], |r| r.get(0)).unwrap();
        assert_eq!((events, bindings), (0, 0));
    }

    #[test]
    fn activation_refuses_nested_teams_and_conflicting_bindings() {
        let mut db = lead_database();
        let mut store = super::super::empty();
        let source = source();
        {
            let tx = db.transaction().unwrap();
            super::super::lead_inbox::bind(&tx, "ses_source", "other-chat", "C:/repo", 1).unwrap();
            tx.commit().unwrap();
        }
        let mut staged = store.clone();
        let tx = db.transaction().unwrap();
        assert!(prepare_lead(&mut staged, &tx, &request(), &source, true).is_err());
        tx.rollback().unwrap();
        assert!(staged.chats.is_empty(), "A bind conflict must not leave a new chat");

        store.chats.push(Chat {
            continuous_mode: false,
            origin: None,
            messages: vec![ChatMessage {
                continuous_fallback: None,
                clarification_start: None,
                images: vec![],
                id: id(),
                role: "user".into(),
                text: "Equipo existente".into(),
                created_at: 1,
                status: "complete".into(),
                run_id: None,
                session_id: Some("ses_source".into()),
            }],
            id: id(),
            title: "Equipo existente".into(),
            archived: false,
            team: super::super::domain::tests::team(),
            skills: vec![],
            created_at: 1,
            runs: vec![],
            memory: None,
            auto_approve: None,
        });
        let tx = db.transaction().unwrap();
        assert!(prepare_lead(&mut store.clone(), &tx, &request(), &source, true).is_err());
        tx.rollback().unwrap();
    }

    #[test]
    fn rejects_empty_plans_or_forged_origin_without_creating_work() {
        let mut store = super::super::empty(); let mut request = request(); request.plan.clear();
        assert!(prepare(&mut store, &request, &source(), true).is_err());
        assert!(store.chats.is_empty());
        assert!(source_from("other", &json!({"id":"ses_source"}), &json!([])).is_err());
        let mut injected = serde_json::to_value(request).unwrap(); injected["sessionId"] = json!("another");
        assert!(serde_json::from_value::<Request>(injected).is_err());
    }
}
