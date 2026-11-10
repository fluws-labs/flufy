use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub version: u32,
    pub description: String,
    pub instructions: String,
    pub verification_guidelines: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct ModelRef {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct SkillRef {
    pub id: String,
    pub version: u32,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Employee {
    pub id: String,
    pub name: String,
    pub role: String,
    pub model: ModelRef,
    #[serde(default)]
    pub variant: Option<String>,
    pub skill_refs: Vec<SkillRef>,
    #[serde(default)]
    pub instructions: String,
    pub tools: Vec<String>,
    pub max_concurrent_tasks: usize,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    #[serde(default)]
    pub plan_v2: super::plan_v2::PlanV2Config,
    #[serde(default)]
    pub autonomous: bool,
    pub id: String,
    pub name: String,
    pub project_root: String,
    pub allowed_repositories: Vec<String>,
    pub lead_agent_id: String,
    pub members: Vec<Employee>,
    pub max_parallel_tasks: usize,
    pub max_retries_per_task: usize,
    pub updated_at: i64,
    #[serde(default)]
    pub evidence_targets: Vec<CaptureTarget>,
    #[serde(default)]
    pub limits: Limits,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaptureAction {
    pub kind: String,
    pub selector: String,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTarget {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default = "capture_width")]
    pub width: u32,
    #[serde(default = "capture_height")]
    pub height: u32,
    #[serde(default)]
    pub wait_for_selector: Option<String>,
    #[serde(default)]
    pub mask_selectors: Vec<String>,
    #[serde(default)]
    pub actions: Vec<CaptureAction>,
    #[serde(default)]
    pub required: bool,
    /// Explicit visual attribution of the captured result. When present, the
    /// result is only accepted as the implementation of this frozen revision.
    #[serde(default)]
    pub preview: Option<crate::preview::CaptureBinding>,
}
fn capture_width() -> u32 {
    1280
}
fn capture_height() -> u32 {
    800
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_run_minutes: Option<u64>,
    pub max_cost_usd: Option<f64>,
    pub max_tokens: Option<u64>,
    pub retention_days: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub id: String,
    pub target_id: String,
    pub phase: String,
    pub captured_at: i64,
    pub status: String,
    pub artifact_path: Option<String>,
    pub report_path: String,
    pub sha256: Option<String>,
    pub details: serde_json::Value,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ReviewStatus {
    Approved,
    ChangesRequested,
    ReviewError,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub status: ReviewStatus,
    pub summary: String,
    pub criteria_satisfied: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    #[serde(default)]
    pub routing: Option<super::routing::RoutingReceipt>,
    #[serde(default)]
    pub resume_after_message_ids: Vec<String>,
    #[serde(default)]
    pub observations: Vec<serde_json::Value>,
    #[serde(default)]
    pub declared_checks: Vec<String>,
    pub id: String,
    pub agent: Employee,
    pub session_id: Option<String>,
    pub review_session_id: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub status: String,
    pub summary: String,
    pub error: Option<String>,
    pub review: Option<Review>,
    pub commands: Vec<serde_json::Value>,
    #[serde(default)]
    pub recovered: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    #[serde(default, flatten)]
    pub contract: super::plan_v2::TaskContract,
    pub id: String,
    pub title: String,
    pub objective: String,
    pub assigned_agent_id: String,
    pub repository: String,
    pub dependencies: Vec<String>,
    pub expected_files: Vec<String>,
    /// Explicit relative files/directories owned by this task. Empty means exclusive folder.
    #[serde(default)]
    pub write_paths: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    #[serde(default = "pending")]
    pub status: String,
    #[serde(default)]
    pub attempts: Vec<Attempt>,
    #[serde(default)]
    pub error: Option<String>,
}
fn pending() -> String {
    "pending".into()
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    #[serde(default, flatten)]
    pub contract: super::plan_v2::PlanContract,
    #[serde(default)]
    pub agents: Vec<AgentProposal>,
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub evidence_targets: Vec<CaptureTarget>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub task_id: Option<String>,
    pub phase: String,
    pub kind: String,
    pub relative_path: String,
    pub captured_at: i64,
    pub status: String,
    pub source: String,
    pub reason: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuous_fallback: Option<super::fallback::ContinuousFallback>,
    #[serde(default)]
    pub delivery_review_version: u32,
    #[serde(default)]
    pub delivery_review: Option<super::delivery_review::DeliveryReview>,
    #[serde(default)]
    pub plan_v2: super::plan_v2::PlanV2State,
    #[serde(default)]
    pub support_reports: Vec<SupportReport>,
    #[serde(default)]
    pub images: Vec<ChatImage>,
    #[serde(default)]
    pub guidance: Vec<String>,
    #[serde(default)]
    pub chat_summary: Option<ChatSummary>,
    pub id: String,
    pub goal: String,
    pub team: Team,
    pub skills: Vec<Skill>,
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub plan_session_id: Option<String>,
    #[serde(default)]
    pub closing_sessions: Vec<String>,
    #[serde(default)]
    pub closing_reviews: Vec<Review>,
    #[serde(default)]
    pub configuration_changes: Vec<serde_json::Value>,
    #[serde(default)]
    pub coordination: Vec<Coordination>,
    pub tasks: Vec<Task>,
    pub summary: String,
    pub error: Option<String>,
    pub evidence_dir: String,
    pub artifacts: Vec<Artifact>,
    pub baseline: Vec<serde_json::Value>,
    pub notified: bool,
    #[serde(default)]
    pub capture_targets: Vec<CaptureTarget>,
    #[serde(default)]
    pub observations: Vec<Observation>,
    #[serde(default)]
    pub recovered_plan: Option<String>,
    #[serde(default)]
    pub session_usage: std::collections::BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub evidence_expired_at: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all="camelCase")]
pub struct SupportReport {
    #[serde(default)]
    pub routing: Option<super::routing::RoutingReceipt>,
    pub id: String,
    pub kind: String,
    pub agent: Employee,
    pub session_id: String,
    pub repository: String,
    pub task_id: Option<String>,
    pub request_id: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub status: String,
    pub summary: String,
    #[serde(default)]
    pub result: serde_json::Value,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentProposal {
    pub id: String,
    pub role: String,
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub skill_ids: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct ChatSummary {
    pub done: String,
    pub tested: String,
    pub pending: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Coordination {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub attempt_id: Option<String>,
    #[serde(default)]
    pub cycle_task_ids: Vec<String>,
    pub id: String,
    pub from_task_id: String,
    pub message: String,
    pub task_ids: Vec<String>,
    pub status: String,
    pub summary: String,
    pub created_at: i64,
    #[serde(default)]
    pub sessions: Vec<String>,
    #[serde(default)]
    pub replies: Vec<serde_json::Value>,
}

pub fn valid_write_path(path: &str) -> bool {
    let path = path.replace('\\', "/");
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains([':', '*', '?', '[', ']', '{', '}'])
        && path
            .trim_end_matches('/')
            .split('/')
            .all(|c| !c.is_empty() && c != "." && c != ".." && c.trim() == c && !c.ends_with('.'))
}

pub fn task_conflict(a: &Task, b: &Task) -> bool {
    if !overlaps(&a.repository, &b.repository) {
        return false;
    }
    if a.write_paths.is_empty() || b.write_paths.is_empty() {
        return true;
    }
    a.write_paths.iter().any(|p| {
        b.write_paths.iter().any(|q| {
            overlaps(
                &format!(
                    "{}/{}",
                    a.repository.trim_end_matches(['/', '\\']),
                    p.trim_end_matches(['/', '\\'])
                ),
                &format!(
                    "{}/{}",
                    b.repository.trim_end_matches(['/', '\\']),
                    q.trim_end_matches(['/', '\\'])
                ),
            )
        })
    })
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    #[serde(default)]
    pub continuous_mode: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<super::handoff::Origin>,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    pub id: String,
    pub title: String,
    pub archived: bool,
    pub team: Team,
    pub skills: Vec<Skill>,
    pub created_at: i64,
    pub runs: Vec<Run>,
    // Optional so existing chats keep the safe defaults: memory on, approvals manual.
    #[serde(default)]
    pub memory: Option<bool>,
    #[serde(default)]
    pub auto_approve: Option<bool>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuous_fallback: Option<super::fallback::ContinuousFallback>,
    // The first user message of an unresolved preflight conversation. Optional
    // so existing histories load unchanged and survive application restarts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clarification_start: Option<String>,
    #[serde(default)]
    pub images: Vec<ChatImage>,
    pub id: String,
    pub role: String,
    pub text: String,
    pub created_at: i64,
    pub status: String,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatImage {
    pub id: String,
    pub filename: String,
    pub mime: String,
    pub bytes: usize,
    pub sha256: String,
}

#[derive(Clone, Deserialize)]
pub struct ImageInput {
    pub filename: String,
    pub mime: String,
    pub url: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default)]
    pub fallback_models: Vec<ModelRef>,
    pub schema_version: u32,
    pub teams: Vec<Team>,
    pub skills: Vec<Skill>,
    pub chats: Vec<Chat>,
}

pub fn id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn same_path(a: &str, b: &str) -> bool {
    normalize(a) == normalize(b)
}
fn normalize(s: &str) -> String {
    s.replace('\\', "/").trim_end_matches('/').to_lowercase()
}
pub fn overlaps(a: &str, b: &str) -> bool {
    let (a, b) = (normalize(a), normalize(b));
    a == b || a.starts_with(&(b.clone() + "/")) || b.starts_with(&(a + "/"))
}
pub fn active(status: &str) -> bool {
    matches!(
        status,
        "planning" | "plan_ready" | "running" | "paused" | "delivering" | "cancelling"
    )
}

pub fn validate_limits(limits: &Limits) -> Result<(), String> {
    if limits
        .max_run_minutes
        .map(|n| n == 0 || n > 1440)
        .unwrap_or(false)
        || limits
            .max_cost_usd
            .map(|n| !n.is_finite() || n <= 0.0)
            .unwrap_or(false)
        || limits.max_tokens == Some(0)
        || limits
            .retention_days
            .map(|n| n == 0 || n > 3650)
            .unwrap_or(false)
    {
        return Err("Los límites deben ser positivos; duración hasta 1440 minutos y retención hasta 3650 días".into());
    }
    Ok(())
}
pub fn validate_team(t: &Team, skills: &[Skill]) -> Result<(), String> {
    super::routing::validate(&t.plan_v2.routing)?;
    super::capture::validate_targets(&t.evidence_targets)?;
    validate_limits(&t.limits)?;
    if t.name.trim().is_empty()
        || t.name.len() > 160
        || t.members.is_empty()
        || t.members.len() > 100
    {
        return Err("El equipo necesita nombre y al menos un Lead (máximo 100 integrantes)".into());
    }
    if !(1..=16).contains(&t.max_parallel_tasks) || t.max_retries_per_task > 5 {
        return Err("Concurrencia: 1–16; reintentos: 0–5".into());
    }
    if !t.members.iter().any(|m| m.id == t.lead_agent_id) {
        return Err("Falta el Team Lead".into());
    }
    let mut ids = HashSet::new();
    for m in &t.members {
        if m.id.is_empty()
            || !ids.insert(&m.id)
            || m.name.trim().is_empty()
            || m.role.trim().is_empty()
            || m.model.provider_id.is_empty()
            || m.model.model_id.is_empty()
            || !(1..=16).contains(&m.max_concurrent_tasks)
        {
            return Err(
                "Revisá IDs, nombres, roles, modelos y concurrencia de los integrantes".into(),
            );
        }
        for r in &m.skill_refs {
            if !skills
                .iter()
                .any(|s| s.id == r.id && s.version == r.version)
            {
                return Err(format!("Skill no disponible: {} v{}", r.id, r.version));
            }
        }
        if m.tools.iter().any(|s| {
            ![
                "read",
                "glob",
                "grep",
                "edit",
                "write",
                "apply_patch",
                "bash",
            ]
            .contains(&s.as_str())
        }) {
            return Err("Herramienta no admitida por el runner de equipos".into());
        }
    }
    if t.allowed_repositories.is_empty()
        || !t
            .allowed_repositories
            .iter()
            .any(|r| overlaps(&t.project_root, r))
    {
        return Err("Seleccioná al menos una carpeta del proyecto".into());
    }
    Ok(())
}

pub(super) fn duplicate_deliverables(tasks: &[Task]) -> Vec<(&str, &str)> {
    fn text(value: &str) -> String {
        value.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
    }
    fn texts(values: &[String], paths: bool) -> Vec<String> {
        let mut values: Vec<_> = values.iter().map(|v| if paths {
            v.replace('\\', "/").to_lowercase()
        } else { text(v) }).collect();
        values.sort();
        values.dedup();
        values
    }
    let mut duplicates = vec![];
    for (i, a) in tasks.iter().enumerate() {
        for b in tasks.iter().skip(i + 1) {
            if [a, b].iter().any(|t| t.status == "cancelled" || t.contract.task_kind.as_deref() == Some("group"))
                || !same_path(&a.repository, &b.repository)
                || a.contract.correction_for_task_id.as_deref() == Some(&b.id)
                || b.contract.correction_for_task_id.as_deref() == Some(&a.id) {
                continue;
            }
            // Different IDs/owners/dependencies do not make another deliverable.
            // Deliberate stages (implementation, review, correction) remain
            // distinct when their objective and acceptance actually differ.
            let same_outputs = texts(&a.expected_files, true) == texts(&b.expected_files, true);
            let same_scope = texts(&a.write_paths, true) == texts(&b.write_paths, true);
            let same_objective = text(&a.objective) == text(&b.objective);
            let same_acceptance = texts(&a.acceptance_criteria, false) == texts(&b.acceptance_criteria, false);
            if same_outputs && ((!a.expected_files.is_empty() && (same_objective || same_acceptance))
                || (a.expected_files.is_empty() && same_scope && same_objective && same_acceptance)) {
                duplicates.push((a.id.as_str(), b.id.as_str()));
            }
        }
    }
    duplicates
}

pub fn validate_plan(p: &Plan, team: &Team) -> Result<(), String> {
    super::capture::validate_targets(&p.evidence_targets)?;
    if p.tasks.is_empty() || p.tasks.len() > 100 {
        return Err("El plan debe contener entre 1 y 100 tareas".into());
    }
    let ids: HashSet<_> = p.tasks.iter().map(|t| t.id.as_str()).collect();
    if ids.len() != p.tasks.len() || ids.contains("") {
        return Err("IDs de tareas duplicados o vacíos".into());
    }
    if let Some((a, b)) = duplicate_deliverables(&p.tasks).first() {
        return Err(format!("DUPLICATE_DELIVERABLE: {a} y {b} repiten la misma entrega. Reutilizá la tarea existente; no crees otra con un ID o responsable distinto"));
    }
    for t in &p.tasks {
        if t.write_paths.iter().any(|p| !valid_write_path(p)) {
            return Err("writePaths debe contener archivos relativos o directorios terminados en /, sin comodines ni escapes".into());
        }
        if t.title.trim().is_empty()
            || t.objective.trim().is_empty()
            || t.acceptance_criteria.is_empty()
            || t.acceptance_criteria.iter().any(|s| s.trim().is_empty())
            || !team.members.iter().any(|m| m.id == t.assigned_agent_id)
        {
            return Err(format!(
                "Tarea incompleta o responsable inexistente: {}",
                t.id
            ));
        }
        if !team
            .allowed_repositories
            .iter()
            .any(|r| same_path(r, &t.repository))
        {
            return Err(format!("Carpeta no autorizada: {}", t.repository));
        }
        if t.dependencies
            .iter()
            .any(|d| !ids.contains(d.as_str()) || d == &t.id
                || t.status != "cancelled" && p.tasks.iter().any(|v| &v.id == d && v.status == "cancelled"))
        {
            return Err("Dependencia inválida".into());
        }
        if t.expected_files.iter().any(|p| {
            p.starts_with(['/', '\\'])
                || p.contains(':')
                || p.replace('\\', "/").split('/').any(|c| c == "..")
        }) {
            return Err("Alcance de archivos fuera de la carpeta autorizada".into());
        }
    }
    let mut done = HashSet::new();
    loop {
        let n = done.len();
        for t in &p.tasks {
            if t.dependencies.iter().all(|d| done.contains(d.as_str())) {
                done.insert(t.id.as_str());
            }
        }
        if done.len() == p.tasks.len() {
            return Ok(());
        }
        if done.len() == n {
            return Err("El plan contiene un ciclo".into());
        }
    }
}

pub fn parse_json<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, String> {
    let s = text.trim();
    let s = if s.starts_with("```") {
        s.split_once('\n')
            .and_then(|(_, b)| b.strip_suffix("```"))
            .ok_or("JSON incompleto")?
            .trim()
    } else {
        s
    };
    serde_json::from_str(s).map_err(|e| format!("Respuesta estructurada inválida: {}", e))
}

fn brief(value: &str, max: usize) -> String {
    let text: String = value.chars().take(max).collect();
    if text.chars().count() < value.chars().count() { format!("{}…", text) } else { text }
}

// Prompts carry decisions and evidence references, never the raw session log:
// command outputs, reasoning and images already live in each session.
pub fn task_snapshot(r: &Run) -> Vec<serde_json::Value> {
    r.tasks.iter().map(|t| {
        let last = t.attempts.last();
        serde_json::json!({
            "id": t.id,
            "title": t.title,
            "objective": brief(&t.objective, 800),
            "assignedAgentId": t.assigned_agent_id,
            "repository": t.repository,
            "status": t.status,
            "dependencies": t.dependencies,
            "writePaths": t.write_paths,
            "expectedFiles": t.expected_files,
            "acceptanceCriteria": t.acceptance_criteria,
            "error": t.error.as_ref().map(|e| brief(e, 400)),
            "attempt": last.map(|a| serde_json::json!({
                "id": a.id,
                "status": a.status,
                "sessionId": a.session_id,
                "summary": brief(&a.summary, 1200),
                "checks": a.declared_checks,
                "error": a.error.as_ref().map(|e| brief(e, 400)),
                "review": a.review.as_ref().map(|r| serde_json::json!({
                    "status": r.status,
                    "summary": brief(&r.summary, 600),
                    "criteriaSatisfied": r.criteria_satisfied,
                })),
            })),
        })
    }).collect()
}

fn coordination_entry(c: &Coordination) -> serde_json::Value {
    serde_json::json!({
        "id": c.id,
        "kind": c.kind,
        "fromTaskId": c.from_task_id,
        "taskIds": c.task_ids,
        "status": c.status,
        "message": brief(&c.message, 600),
        "summary": brief(&c.summary, 600),
        "replies": c.replies.iter().map(|reply| serde_json::json!({
            "status": reply["status"],
            "at": reply["at"],
            "taskIds": reply["taskIds"],
            "summary": brief(reply["summary"].as_str().unwrap_or(""), 400),
            "reason": brief(reply["reason"].as_str().unwrap_or(""), 400),
            "attempt": reply["attempt"],
        })).collect::<Vec<_>>(),
    })
}

pub fn coordination_history(r: &Run) -> Vec<serde_json::Value> {
    let start = r.coordination.len().saturating_sub(12);
    r.coordination[start..].iter().map(coordination_entry).collect()
}

pub fn coordination_for_task(r: &Run, task_id: &str) -> Vec<serde_json::Value> {
    let mut related: Vec<_> = r.coordination.iter()
        .filter(|c| c.from_task_id == task_id || c.task_ids.iter().any(|id| id == task_id))
        .collect();
    let start = related.len().saturating_sub(3);
    related.drain(..start);
    related.into_iter().map(coordination_entry).collect()
}

pub fn support_snapshot(r: &Run) -> Vec<serde_json::Value> {
    let start = r.support_reports.len().saturating_sub(8);
    r.support_reports[start..].iter().map(|s| serde_json::json!({
        "id": s.id,
        "kind": s.kind,
        "status": s.status,
        "taskId": s.task_id,
        "summary": brief(&s.summary, 800),
        "result": brief(s.result["summary"].as_str().unwrap_or(""), 600),
    })).collect()
}

pub fn catalog() -> Vec<Skill> {
    super::skills::catalog()
}

pub(super) fn legacy_catalog() -> Vec<Skill> {
    [
        ("frontend", "Frontend", "React, TypeScript, estado, accesibilidad, formularios y consumo de API", "Comprobar interacción, errores y estados de carga"),
        ("backend", "Backend", "Servicios, DTOs, validaciones, errores y arquitectura existente", "Pruebas de lógica, validación y autorización"),
        ("graphql", "GraphQL", "Schema, resolvers, queries, mutations y DataLoader", "Ejecutar operaciones y casos de error relevantes"),
        ("aws", "AWS", "Lambda, S3, SQS, ECS, IAM y CloudWatch. No desplegar sin autorización", "Validar planes y privilegios sin inventar estados remotos"),
        ("docker", "Docker", "Builds multietapa, Compose, redes, volúmenes y health checks", "Ejecutar build o health checks disponibles"),
        ("qa", "QA", "Pruebas unitarias, integración, E2E, regresiones y casos borde", "Registrar comandos, resultados observados y limitaciones"),
        ("devops", "DevOps", "CI/CD, GitHub Actions, Terraform y observabilidad", "Validar configuración y cambios sin publicar automáticamente"),
        ("database", "Database", "PostgreSQL, índices, transacciones y migraciones compatibles", "Comprobar integridad y rollback; no borrar datos existentes"),
        ("security", "Security", "Auth, autorización, validación, secretos y mínimo privilegio", "Revisar entradas, límites de acceso y exposición de datos"),
        ("review", "Code Review", "Revisar defectos reales, regresiones y correspondencia con requisitos", "Confirmar findings en archivos y evidencia de herramientas"),
    ].into_iter().map(|(id, name, instructions, check)| Skill { id: id.into(), name: name.into(), version: 1, description: instructions.into(), instructions: format!("{}. Respetar convenciones existentes; evitar dependencias y refactors ajenos al objetivo.", instructions), verification_guidelines: vec![check.into()] }).collect()
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    pub fn team() -> Team {
        Team {
            plan_v2: Default::default(),
            autonomous: false,
            id: id(),
            name: "Team 1".into(),
            project_root: "D:/repo".into(),
            allowed_repositories: vec!["D:/repo".into()],
            lead_agent_id: "lead".into(),
            members: vec![Employee {
                id: "lead".into(),
                name: "Lead".into(),
                role: "Lead".into(),
                model: ModelRef {
                    provider_id: "openai".into(),
                    model_id: "model".into(),
                },
                variant: None,
                skill_refs: vec![],
                instructions: String::new(),
                tools: vec!["read".into()],
                max_concurrent_tasks: 1,
            }],
            max_parallel_tasks: 2,
            max_retries_per_task: 1,
            updated_at: 0,
            evidence_targets: vec![],
            limits: Limits::default(),
        }
    }
    fn task(id: &str, deps: &[&str]) -> Task {
        Task {
            contract: Default::default(),
            id: id.into(),
            title: id.into(),
            objective: format!("Entregar {id}"),
            assigned_agent_id: "lead".into(),
            repository: "D:/repo".into(),
            dependencies: deps.iter().map(|s| s.to_string()).collect(),
            expected_files: vec![],
            write_paths: vec![],
            acceptance_criteria: vec!["Comprobar".into()],
            status: pending(),
            attempts: vec![],
            error: None,
        }
    }
    #[test]
    fn validates_dag_and_assignments() {
        assert!(validate_plan(
            &Plan {
                contract: Default::default(),
                agents: vec![],
                evidence_targets: vec![],
                tasks: vec![task("a", &[]), task("b", &["a"])]
            },
            &team()
        )
        .is_ok());
        for tasks in [
            vec![task("a", &["b"]), task("b", &["a"])],
            vec![task("a", &["missing"])],
            vec![task("a", &[]), task("a", &[])],
        ] {
            assert!(validate_plan(
                &Plan {
                    contract: Default::default(),
                    agents: vec![],
                    tasks,
                    evidence_targets: vec![]
                },
                &team()
            )
            .is_err());
        }
        let mut t = task("a", &[]);
        t.repository = "D:/other".into();
        assert!(validate_plan(
            &Plan {
                contract: Default::default(),
                agents: vec![],
                tasks: vec![t],
                evidence_targets: vec![]
            },
            &team()
        )
        .is_err());
    }
    #[test]
    fn review_fails_closed() {
        for text in [
            "bad json",
            r#"{"status":"approved"}"#,
            r#"{"status":"ok","summary":"ok","criteriaSatisfied":true}"#,
        ] {
            assert!(parse_json::<Review>(text).is_err());
        }
    }
    #[test]
    fn repository_lock_handles_nested_paths() {
        assert!(overlaps("D:\\Repo", "d:/repo/packages/web"));
        assert!(!overlaps("D:/repo", "D:/repo-other"));
    }
    fn run_fixture() -> Run {
        serde_json::from_value(serde_json::json!({"id":"r","goal":"g","team":team(),"skills":[],"status":"running","startedAt":0,"tasks":[],"summary":"","evidenceDir":"unused","artifacts":[],"baseline":[],"notified":false})).unwrap()
    }
    fn coordination(id: &str, from: &str) -> Coordination {
        Coordination {
            kind: String::new(),
            attempt_id: None,
            cycle_task_ids: vec![],
            id: id.into(),
            from_task_id: from.into(),
            message: format!("pedido {id}"),
            task_ids: vec![],
            status: "pending".into(),
            summary: String::new(),
            created_at: 0,
            sessions: vec![],
            replies: vec![],
        }
    }
    #[test]
    fn prompt_snapshots_carry_references_not_raw_session_logs() {
        let mut r = run_fixture();
        let mut t = task("generator", &[]);
        t.status = "completed".into();
        t.attempts.push(serde_json::from_value(serde_json::json!({
            "id":"a1","agent":team().members[0],"sessionId":"ses_1","startedAt":0,"status":"completed",
            "summary":"x".repeat(5000),"commands":[{"command":"npm test","exitCode":0,"output":"y".repeat(300000)}],
            "declaredChecks":["npm test"]
        })).unwrap());
        r.tasks.push(t);
        r.coordination = vec![
            coordination("c1", "generator"),
            coordination("c2", "generator"),
            coordination("c3", "generator"),
            coordination("c4", "generator"),
            coordination("c5", "other"),
        ];
        r.support_reports = (0..10).map(|i| SupportReport {
            routing: None, id: format!("s{i}"), kind: "investigation".into(), agent: team().members[0].clone(),
            session_id: "ses".into(), repository: "D:/repo".into(), task_id: None, request_id: None,
            started_at: 0, finished_at: Some(1), status: "completed".into(), summary: "resumen".into(),
            result: serde_json::json!({"summary":"causa","findings":["z".repeat(200000)]}),
        }).collect();
        let tasks = serde_json::to_string(&task_snapshot(&r)).unwrap();
        assert!(tasks.contains("npm test") && tasks.contains("completed"));
        assert!(!tasks.contains("yyyy"));
        assert!(tasks.len() < 5000, "snapshot acotado: {} chars", tasks.len());
        let related = coordination_for_task(&r, "generator");
        assert_eq!(related.len(), 3);
        assert!(related.iter().all(|c| c["fromTaskId"] == "generator"));
        assert_eq!(related.last().unwrap()["id"], "c4");
        let history = serde_json::to_string(&coordination_history(&r)).unwrap();
        assert!(history.contains("c5") && history.len() < 2000);
        let support = serde_json::to_string(&support_snapshot(&r)).unwrap();
        assert!(support.contains("causa") && !support.contains("zzzz"));
        assert_eq!(support_snapshot(&r).len(), 8);
    }
}
