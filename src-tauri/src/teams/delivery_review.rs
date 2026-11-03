//! Human-facing acceptance is backed by worker receipts, never a closing claim alone.
use super::{domain::*, plan_v2::PlanContract};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const PROJECT_RULES: &str = "DECISIONES DEL PROYECTO: Antes de implementar, recuperá de AGENTS.md, la memoria habilitada y el código cercano las decisiones vigentes de arquitectura, diseño, infraestructura/presupuesto, alcance y objetivos. Conservá su fuente y distinguí decisiones del usuario de suposiciones. Reutilizá componentes y lógica existentes. Elegí la solución más simple que satisface el pedido; no agregues abstracciones, dependencias, infraestructura ni casos borde hipotéticos. Una decisión nueva explícita del usuario prevalece sobre una anterior; si hay una contradicción real sin resolver, señalala. Revisá también el diff por duplicación y desvíos de estas decisiones, no solo por tests verdes.";

pub const PLAN_PROMPT: &str = r#"REVISIÓN HUMANA DE LA ENTREGA: Agregá al JSON del plan uiReviewRequired (booleano), uiReviewReason (motivo concreto según el cambio pedido) y projectConstraints:[{decision:"decisión vigente",source:"archivo o memoria que la respalda"}]. No inventes decisiones ni conviertas recomendaciones propias en restricciones del usuario. Si el cambio afecta un flujo visible de una aplicación, uiReviewRequired=true. Planificá una tarea final de recorrido funcional y revisión visual, dependiente de las implementaciones que prueba, expectedFiles:[], category:"visual". Su responsable debe preparar datos de ejemplo en el entorno de prueba y el estado necesario, recorrer el camino por la UI como una persona, observar capturas reales y corregir con los responsables cualquier defecto antes de entregar. No trasladar al usuario la creación de datos ni los flujos previos. Si no hay UI afectada, false con motivo; no inventar una aplicación para cumplir el contrato. Las decisiones y el alcance limitan también la revisión: no ampliar el producto para hipotéticos casos borde."#;

pub const WORKER_PROMPT: &str = "REVISIÓN POR LA INTERFAZ: Si tu tarea verifica un flujo visible, prepará primero el entorno y datos de prueba identificables/reutilizables; usá seeds existentes cuando sirvan. Registrá la preparación exacta y qué datos conservar o limpiar. Usá browser_* para navegar, hacer clic/completar y comprobar resultados reales; una respuesta HTTP o texto del DOM no sustituye el recorrido. Tomá snapshot y screenshot de la misma página y examiná la imagen: jerarquía visual, legibilidad, exceso de texto, acción principal y feedback, coherencia con el diseño existente y viewport relevante. Si el modelo no puede ver imágenes, no declares revisión visual aprobada. Corregí con el Lead los defectos del alcance y repetí el recorrido después de la última corrección. No publiques ni uses datos reales para preparar escenarios; respetá los permisos y el entorno autorizado. En summary dejá por cada flujo: cambio visible, URL final exacta, pasos y preparación ya realizados, qué debe ver una persona, observación real, juicio visual y callId de navegación/acción, snapshot y screenshot, todos con el mismo pageId. Dejá la página y los datos en un estado revisable cuando sea posible, sin cerrar el navegador ni matar servidores necesarios. Si no se puede conservar el estado, explicá cómo reconstruirlo; nunca prometas que seguirá disponible tras reiniciar. Un fallo de UX dentro del alcance es trabajo pendiente del equipo, no QA delegado al usuario.";

pub const CLOSEOUT_PROMPT: &str = r#"GUÍA DE REVISIÓN: Para aprobar, agregá deliveryReview:{uiRequired:boolean,summary:"qué revisar en una frase",reason:"por qué no aplica UI si uiRequired=false",decisions:[{decision:"texto exacto de projectConstraints",source:"fuente exacta",status:"respected|violated|unverified",evidence:"archivo/diff/comprobación concreta"}],flows:[{title:"cambio visible",change:"qué cambió para la persona",url:"URL final exacta observada",taskId:"tarea de recorrido",attemptId:"su último intento",pageId:123,preparation:["datos/estado ya preparados y cómo reconstruirlos"],steps:["pasos breves por la interfaz"],expected:"resultado que debe ver el usuario",observed:"resultado realmente observado",visualReview:"juicio sobre la imagen, jerarquía, legibilidad y diseño, sin presentar texto DOM como visión",evidenceCallIds:["callId navegación/acción","callId snapshot","callId screenshot"],ready:true,stateNote:"qué quedó preparado o por qué hay que reconstruirlo"}]}. flows solo contiene recorridos ya completados y revisados DESPUÉS de todas las implementaciones/correcciones: tarea sin expectedFiles y último intento aprobado. Las referencias deben existir en sus herramientas, sobre el mismo pageId. No inventes datos, capturas ni URLs. Si faltan recorridos, datos o revisión visual, pedí changes_requested con tareas concretas de preparación/QA o corrección, no un informe ficticio. Un seed o una captura automática antes/después no sustituyen esta revisión. uiRequired debe coincidir con el plan; false no permite omitir una UI afectada. Solo después de estas comprobaciones corresponde la aceptación del usuario. El motor comprueba las referencias y la vigencia de la evidencia; el juicio de UX sigue siendo una evaluación del agente, no una garantía de calidad humana."#;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConstraint { pub decision: String, pub source: String }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionCheck {
    pub decision: String,
    pub source: String,
    pub status: String,
    pub evidence: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFlow {
    pub title: String,
    pub change: String,
    pub url: String,
    pub task_id: String,
    pub attempt_id: String,
    pub page_id: u64,
    pub preparation: Vec<String>,
    pub steps: Vec<String>,
    pub expected: String,
    pub observed: String,
    pub visual_review: String,
    pub evidence_call_ids: Vec<String>,
    pub ready: bool,
    pub state_note: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryReview {
    pub ui_required: bool,
    pub summary: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub decisions: Vec<DecisionCheck>,
    #[serde(default)]
    pub flows: Vec<ReviewFlow>,
}

pub fn validate_plan(contract: &PlanContract) -> Result<(), String> {
    if contract.ui_review_required.is_none() || contract.ui_review_reason.trim().is_empty() {
        return Err("El plan debe declarar uiReviewRequired y uiReviewReason según el cambio visible pedido".into());
    }
    if contract.project_constraints.len() > 30 || contract.project_constraints.iter().any(|c| {
        c.decision.trim().is_empty() || c.source.trim().is_empty()
    }) {
        return Err("projectConstraints necesita decisiones concretas con su fuente (máximo 30)".into());
    }
    let unique: HashSet<_> = contract.project_constraints.iter().map(|c| (&c.decision, &c.source)).collect();
    if unique.len() != contract.project_constraints.len() {
        return Err("projectConstraints contiene decisiones duplicadas".into());
    }
    Ok(())
}

pub fn validate(run: &Run, report: Option<&DeliveryReview>) -> Result<(), String> {
    if run.delivery_review_version == 0 && report.is_none() { return Ok(()); }
    let report = report.ok_or("Falta deliveryReview: prepará y probá los escenarios antes de pedir revisión al usuario")?;
    if report.summary.trim().is_empty() || report.flows.len() > 20 {
        return Err("La guía necesita un resumen y hasta 20 flujos concretos".into());
    }
    if run.plan_v2.contract.ui_review_required.is_some_and(|required| required != report.ui_required) {
        return Err("La revisión no puede omitir ni inventar la UI declarada en el plan".into());
    }
    for constraint in &run.plan_v2.contract.project_constraints {
        if !report.decisions.iter().any(|check| check.decision == constraint.decision
            && check.source == constraint.source && decision_checked(run, check)) {
            return Err(format!("Falta comprobar la decisión vigente: {} ({})", constraint.decision, constraint.source));
        }
    }
    if report.decisions.iter().any(|check| !decision_checked(run, check)) {
        return Err("Hay decisiones incumplidas o sin comprobar; corregí el trabajo antes de cerrar".into());
    }
    if !report.ui_required {
        return if !report.reason.trim().is_empty() && report.flows.is_empty() { Ok(()) }
        else { Err("Explicá por qué no hay UI afectada; no adjuntes recorridos ficticios".into()) };
    }
    if report.flows.is_empty() { return Err("Falta recorrer la UI y preparar al menos un escenario de revisión".into()); }
    // Browser QA must start after code tasks finish. Evidence from before a
    // correction cannot approve the corrected implementation.
    let last_implementation = run.tasks.iter().filter(|task| !task.expected_files.is_empty())
        .flat_map(|task| &task.attempts).filter_map(|attempt| attempt.finished_at).max().unwrap_or(0);
    let mut titles = HashSet::new();
    for flow in &report.flows {
        if !titles.insert(flow.title.trim().to_lowercase()) || [flow.title.as_str(), &flow.change, &flow.expected,
            &flow.observed, &flow.visual_review, &flow.state_note].iter().any(|s| s.trim().is_empty())
            || flow.preparation.is_empty() || flow.steps.is_empty()
            || flow.preparation.iter().chain(&flow.steps).any(|s| s.trim().is_empty()) {
            return Err("Cada flujo necesita cambio, preparación, pasos, resultado observado y evaluación visual concretos".into());
        }
        let url = tauri::Url::parse(&flow.url).map_err(|_| "La URL del escenario no es válida")?;
        if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none()
            || !url.username().is_empty() || url.password().is_some() {
            return Err("El escenario necesita una URL HTTP(S) observada sin credenciales".into());
        }
        let task = run.tasks.iter().find(|task| task.id == flow.task_id)
            .ok_or("El recorrido referencia una tarea inexistente")?;
        let attempt = task.attempts.last().filter(|a| a.id == flow.attempt_id)
            .ok_or("El recorrido no corresponde al último intento de la tarea")?;
        if task.status != "completed" || !task.expected_files.is_empty() || attempt.status != "completed"
            || attempt.session_id.is_none() || attempt.finished_at.is_none()
            || !attempt.review.as_ref().is_some_and(|r| matches!(r.status, ReviewStatus::Approved) && r.criteria_satisfied)
            || attempt.started_at < last_implementation {
            return Err("El recorrido necesita una tarea de QA aprobada y posterior a la última implementación/corrección".into());
        }
        let ids: HashSet<_> = flow.evidence_call_ids.iter().collect();
        if ids.len() != flow.evidence_call_ids.len() || ids.len() < 3 {
            return Err("Faltan referencias distintas a interacción, snapshot y screenshot reales".into());
        }
        let mut tools = HashSet::new();
        let mut observed_url = false;
        for call_id in &flow.evidence_call_ids {
            let receipt = attempt.observations.iter().find(|o| o["callId"] == *call_id)
                .ok_or("La guía cita una herramienta no observada en esa tarea")?;
            let tool = receipt["tool"].as_str().unwrap_or("");
            if !tool.starts_with("browser_") || receipt["input"]["pageId"].as_u64() != Some(flow.page_id) {
                return Err("La interacción y las capturas deben pertenecer a la misma página del revisor".into());
            }
            tools.insert(tool);
            observed_url |= receipt["input"]["url"] == flow.url
                || receipt["output"].as_str().is_some_and(|text| text.contains(&flow.url));
        }
        let interacted = tools.iter().any(|tool| matches!(*tool, "browser_navigate_page" | "browser_click"
            | "browser_fill" | "browser_fill_form" | "browser_press_key" | "browser_type_text"));
        if !interacted || !tools.contains("browser_take_snapshot") || !tools.contains("browser_take_screenshot") || !observed_url {
            return Err("La guía requiere interacción real, estado final y captura visual de la URL declarada; el DOM solo no alcanza".into());
        }
    }
    Ok(())
}

fn decision_checked(run: &Run, check: &DecisionCheck) -> bool {
    if check.evidence.trim().is_empty() { return false; }
    check.status == "respected" || (check.status == "superseded" && run.guidance.iter()
        .any(|instruction| !instruction.trim().is_empty() && check.evidence.contains(instruction.as_str())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> (Run, DeliveryReview) {
        let run: Run = serde_json::from_value(json!({"id":"r","goal":"Filtrar consultas","deliveryReviewVersion":1,
            "planV2":{"contract":{"uiReviewRequired":true,"uiReviewReason":"Cambió el filtro visible","projectConstraints":[{"decision":"Reutilizar el panel existente","source":"AGENTS.md"}]}},
            "team":super::super::domain::tests::team(),"skills":[],"status":"running","startedAt":0,"tasks":[
                {"id":"code","title":"Filtro","objective":"Filtro","assignedAgentId":"lead","repository":"D:/repo","dependencies":[],"expectedFiles":["page.tsx"],"acceptanceCriteria":["Filtro"],"status":"completed","attempts":[{"id":"code-1","agent":super::super::domain::tests::team().members[0],"startedAt":1,"finishedAt":10,"status":"completed","summary":"Filtro","commands":[]}]},
                {"id":"qa","title":"Recorrido","objective":"Recorrer UI","assignedAgentId":"lead","repository":"D:/repo","dependencies":["code"],"expectedFiles":[],"acceptanceCriteria":["Filtro visible"],"status":"completed","attempts":[{"id":"qa-1","agent":super::super::domain::tests::team().members[0],"sessionId":"review-session","startedAt":11,"finishedAt":20,"status":"completed","summary":"Recorrido real","commands":[],"review":{"status":"approved","criteriaSatisfied":true,"summary":"Flujo revisado"},"observations":[
                    {"tool":"browser_navigate_page","callId":"nav","input":{"pageId":7,"url":"http://localhost:3000/consultas"},"output":"Navegación terminada"},
                    {"tool":"browser_take_snapshot","callId":"dom","input":{"pageId":7},"output":"Filtro aplicado"},
                    {"tool":"browser_take_screenshot","callId":"image","input":{"pageId":7},"output":"Captura real"}]}]}
            ],"summary":"","evidenceDir":"unused","artifacts":[],"baseline":[],"notified":false})).unwrap();
        let report = serde_json::from_value(json!({"uiRequired":true,"summary":"Filtro de consultas listo",
            "decisions":[{"decision":"Reutilizar el panel existente","source":"AGENTS.md","status":"respected","evidence":"Se reutiliza FilterBar en page.tsx"}],
            "flows":[{"title":"Consultas pendientes","change":"Nuevo filtro","url":"http://localhost:3000/consultas","taskId":"qa","attemptId":"qa-1","pageId":7,"preparation":["Dos consultas de ejemplo ya creadas con el seed existente"],"steps":["Elegir Pendientes"],"expected":"Una consulta pendiente","observed":"Una consulta pendiente visible","visualReview":"Acción principal visible, feedback claro y tipografía coherente","evidenceCallIds":["nav","dom","image"],"ready":true,"stateNote":"Página abierta con las consultas de ejemplo"}]})).unwrap();
        (run, report)
    }
    #[test]
    fn accepts_real_review_and_keeps_legacy_runs_readable() {
        let (mut run, report) = fixture();
        assert!(validate(&run, Some(&report)).is_ok());
        assert!(validate(&run, None).is_err());
        run.delivery_review_version = 0;
        assert!(validate(&run, None).is_ok());
        let restored: Run = serde_json::from_str(&serde_json::to_string(&run).unwrap()).unwrap();
        assert!(validate(&restored, Some(&report)).is_ok());
    }
    #[test]
    fn rejects_invented_cross_page_or_dom_only_evidence() {
        for mutate in 0..4 {
            let (mut run, mut report) = fixture();
            match mutate {
                0 => report.flows[0].evidence_call_ids[2] = "invented".into(),
                1 => run.tasks[1].attempts[0].observations[2]["input"]["pageId"] = json!(9),
                2 => run.tasks[1].attempts[0].observations[2]["tool"] = json!("browser_take_snapshot"),
                _ => report.flows[0].url = "http://localhost:3000/inventada".into(),
            }
            assert!(validate(&run, Some(&report)).is_err(), "case {mutate}");
        }
    }
    #[test]
    fn corrections_invalidate_old_qa_and_decisions_cannot_disappear() {
        let (mut run, report) = fixture();
        run.tasks[0].attempts[0].finished_at = Some(25);
        assert!(validate(&run, Some(&report)).unwrap_err().contains("posterior"));
        let (run, mut report) = fixture();
        report.decisions.clear();
        assert!(validate(&run, Some(&report)).unwrap_err().contains("decisión"));
        report.ui_required = false;
        assert!(validate(&run, Some(&report)).is_err());
    }
    #[test]
    fn non_ui_work_has_an_explicit_reason_and_no_fake_browser_requirement() {
        let (mut run, _) = fixture();
        run.plan_v2.contract.ui_review_required = Some(false);
        run.plan_v2.contract.project_constraints.clear();
        let mut report = DeliveryReview { ui_required:false, summary:"Validación de API".into(), reason:"Solo cambia un endpoint sin UI afectada".into(), flows:vec![], decisions:vec![] };
        assert!(validate(&run, Some(&report)).is_ok());
        report.reason.clear();
        assert!(validate(&run, Some(&report)).is_err());
    }
    #[test]
    fn legacy_contract_keeps_its_digest_shape_and_new_plans_require_a_reason() {
        let mut contract = PlanContract::default();
        let legacy = serde_json::to_value(&contract).unwrap();
        assert!(legacy.get("uiReviewRequired").is_none());
        assert!(legacy.get("uiReviewReason").is_none());
        assert!(legacy.get("projectConstraints").is_none());
        assert!(validate_plan(&contract).is_err());
        contract.ui_review_required = Some(false);
        contract.ui_review_reason = "Cambio de API sin interfaz afectada".into();
        assert!(validate_plan(&contract).is_ok());
        contract.project_constraints.push(ProjectConstraint { decision:"Reutilizar lógica".into(), source:String::new() });
        assert!(validate_plan(&contract).is_err());
    }
    #[test]
    fn only_recorded_user_guidance_can_supersede_an_agreed_decision() {
        let (mut run, mut report) = fixture();
        report.decisions[0].status = "superseded".into();
        report.decisions[0].evidence = "Ahora usá el nuevo panel aprobado".into();
        assert!(validate(&run, Some(&report)).is_err());
        run.guidance.push("Ahora usá el nuevo panel aprobado".into());
        assert!(validate(&run, Some(&report)).is_ok());
        report.decisions[0].evidence = "Lo decidió el agente".into();
        assert!(validate(&run, Some(&report)).is_err());
    }
}
