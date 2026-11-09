//! Explicit, session-bound delegation from an ordinary chat to the existing team runner.
use super::{domain::*, update};
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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    project_root: String,
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
}

pub fn tools() -> Vec<Value> {
    vec![json!({"name":"delegate","description":"Inicia un equipo para implementar el plan acordado en ESTE chat después de que el usuario elija «Con un equipo» o pida explícitamente esa delegación. Antes de empezar un trabajo de implementación no trivial, si no eligió modo, preguntale una sola vez con question: «¿Querés que lo resuelva un equipo o seguimos en este chat?»; no preguntes en consultas ni cambios triviales. Transfiere objetivo, plan, investigación relevante, decisiones y aceptación; hereda carpeta y modelo, conserva enlace al chat de origen y devuelve el ID de la ejecución real. No usar para preguntas o ejemplos sobre equipos. Reintentos del mismo pedido reutilizan el equipo y no duplican ejecuciones.","inputSchema":{"type":"object","additionalProperties":false,"properties":{
        "projectRoot":{"type":"string","description":"Carpeta absoluta de este chat, incluido su worktree si corresponde. El servidor la contrasta con la sesión real."},
        "title":{"type":"string","description":"Nombre breve del trabajo"},
        "goal":{"type":"string","description":"Resultado que el usuario quiere conseguir"},
        "plan":{"type":"string","description":"Plan concreto acordado, con alcance y pasos de implementación. No basta decir implementá lo conversado."},
        "context":{"type":"string","description":"Hallazgos de investigación, archivos, contratos y referencias necesarios. Resumen pertinente; no copiar toda la conversación ni credenciales."},
        "decisions":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"decision":{"type":"string"},"source":{"type":"string"}},"required":["decision","source"]},"description":"Decisiones vigentes de arquitectura, diseño, presupuesto de infraestructura, alcance y objetivos, con su procedencia. Vacío si no hay decisiones conocidas."},
        "acceptanceCriteria":{"type":"array","items":{"type":"string"},"description":"Comportamientos concretos que definen una entrega aceptable"}
    },"required":["projectRoot","title","goal","plan","context","decisions","acceptanceCriteria"]}})]
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
        user_request, model, variant:user["info"]["variant"].as_str().filter(|s| !s.is_empty()).map(String::from) })
}

fn goal(request: &Request, source: &Source) -> Result<String, String> {
    if request.title.trim().is_empty() || request.title.len() > 160 || request.goal.trim().is_empty()
        || request.plan.trim().is_empty() || request.acceptance_criteria.is_empty()
        || request.acceptance_criteria.len() > 30 || request.acceptance_criteria.iter().any(|s| s.trim().is_empty())
        || request.decisions.len() > 30 || request.decisions.iter().any(|d| d.decision.trim().is_empty() || d.source.trim().is_empty()) {
        return Err("La delegación necesita título, objetivo, plan concreto, aceptación y decisiones con fuente".into());
    }
    let payload = json!({"goal":request.goal,"implementationPlan":request.plan,"researchContext":request.context,
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
        title:source.title.clone(), directory:source.directory.clone(), created_at:now(), error:None });
    chat.memory = Some(memory);
    // Ordinary chat auto-approval is not a grant to a new autonomous team.
    chat.auto_approve = Some(false);
    chat.messages.push(ChatMessage { continuous_fallback:None, clarification_start:None, images:vec![], id:id(), role:"user".into(),
        text, created_at:now(), status:"complete".into(), run_id:None, session_id:None });
    store.chats.push(chat.clone());
    Ok((chat, false))
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

pub fn call(app: &AppHandle, name: &str, args: &Value) -> Value {
    let result = match name { "delegate" => delegate(app, args), _ => Err("Herramienta de equipos desconocida".into()) };
    match result {
        Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}]}),
        Err(error) => json!({"content":[{"type":"text","text":error}],"isError":true}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(first.memory, Some(false)); assert_eq!(first.auto_approve, Some(false));
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
