use crate::memory;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

const MAX_ITEMS: usize = 500;
const RETENTION_DAYS: i64 = 90;
const TITLE_MAX: usize = 200;
const BODY_MAX: usize = 4_000;
const BLOCKED_BODY_MAX: usize = 500;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InboxItem {
    pub id: String,
    pub at: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mission_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommendation: Option<String>,
    /// approve | reject | resume | park. Se aplica al vencer el deadline.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dedupe_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<String>,
    pub untrusted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acked_at: Option<String>,
}

fn inbox_dir(app: &AppHandle) -> PathBuf {
    memory::agent_root(app).join("inbox")
}

pub fn inbox_file(app: &AppHandle) -> PathBuf {
    inbox_dir(app).join("inbox.ndjson")
}

fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn parse_at(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(value).ok().map(|at| at.with_timezone(&chrono::Utc))
}

fn one_line(value: &str, max: usize) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

/// Lee el NDJSON tolerando una última línea truncada o archivos ausentes.
fn read_items(path: &Path) -> Vec<InboxItem> {
    let Ok(text) = fs::read_to_string(path) else { return Vec::new() };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<InboxItem>(line).ok())
        .filter(|item| !item.id.trim().is_empty() && !item.title.trim().is_empty())
        .collect()
}

fn write_items(path: &Path, items: &[InboxItem]) -> Result<(), String> {
    let mut out = String::new();
    for item in items {
        out.push_str(&serde_json::to_string(item).map_err(|e| e.to_string())?);
        out.push('\n');
    }
    memory::atomic_write(path, &out)
}

fn expired(item: &InboxItem, cutoff: chrono::DateTime<chrono::Utc>) -> bool {
    item.acked_at.is_some() && parse_at(&item.at).map_or(false, |at| at < cutoff)
}

fn cutoff() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now() - chrono::Duration::days(RETENTION_DAYS)
}

/// Retención: se descartan los ítems ya leídos con más de 90 días y, si igual
/// se supera el tope, se van los más viejos leídos antes que los pendientes.
fn compact(items: &mut Vec<InboxItem>) {
    let limit = cutoff();
    items.retain(|item| !expired(item, limit));
    if items.len() <= MAX_ITEMS {
        return;
    }
    let mut acked: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, item)| item.acked_at.is_some())
        .map(|(index, _)| index)
        .collect();
    acked.sort_by_key(|index| items[*index].at.clone());
    let mut remove = std::collections::HashSet::new();
    let mut excess = items.len() - MAX_ITEMS;
    for index in acked {
        if excess == 0 {
            break;
        }
        remove.insert(index);
        excess -= 1;
    }
    if !remove.is_empty() {
        let mut kept = Vec::with_capacity(items.len());
        for (index, item) in std::mem::take(items).into_iter().enumerate() {
            if !remove.contains(&index) {
                kept.push(item);
            }
        }
        *items = kept;
    }
    if items.len() > MAX_ITEMS {
        let skip = items.len() - MAX_ITEMS;
        *items = items.split_off(skip);
    }
}

fn count_pending(app: &AppHandle) -> usize {
    read_items(&inbox_file(app)).iter().filter(|item| item.acked_at.is_none()).count()
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit("agent://inbox-changed", json!({ "count": count_pending(app) }));
}

fn trimmed(value: Option<&str>, max: usize) -> Option<String> {
    value.map(str::trim).filter(|value| !value.is_empty()).map(|value| value.chars().take(max).collect())
}

fn sanitize(mut item: InboxItem) -> InboxItem {
    item.kind = if item.kind.trim().is_empty() { "insight".to_string() } else { item.kind.trim().to_string() };
    item.title = one_line(&item.title, TITLE_MAX);
    item.body = item.body.trim().chars().take(BODY_MAX).collect();
    item.session = trimmed(item.session.as_deref(), 200);
    item.directory = trimmed(item.directory.as_deref(), 500);
    item.mission_id = trimmed(item.mission_id.as_deref(), 200);
    item.decision = trimmed(item.decision.as_deref(), 40);
    item.preview = trimmed(item.preview.as_deref(), BODY_MAX).map(|value| redact(&value));
    item.risk = trimmed(item.risk.as_deref(), 40);
    item.cause = trimmed(item.cause.as_deref(), 400);
    item.recommendation = trimmed(item.recommendation.as_deref(), 1000);
    // El vencimiento nunca aprueba: la pre-autorización va por grants. El
    // deadline solo puede rechazar, reanudar o estacionar.
    item.default_action = trimmed(item.default_action.as_deref(), 20).map(|value| match value.as_str() {
        "reject" | "rejected" => "reject".into(),
        "resume" => "resume".into(),
        _ => "park".into(),
    });
    item.scope = trimmed(item.scope.as_deref(), 400);
    item.run_id = trimmed(item.run_id.as_deref(), 200);
    item.dedupe_key = trimmed(item.dedupe_key.as_deref(), 300);
    item.options = item
        .options
        .into_iter()
        .map(|value| one_line(&value, 200))
        .filter(|value| !value.is_empty())
        .take(6)
        .collect();
    item.acked_at = None;
    item
}

fn merge_open(existing: &mut InboxItem, fresh: &InboxItem) {
    existing.at = fresh.at.clone();
    existing.title = fresh.title.clone();
    existing.body = fresh.body.clone();
    if fresh.expires_at.is_some() {
        existing.expires_at = fresh.expires_at.clone();
    }
    if fresh.recommendation.is_some() {
        existing.recommendation = fresh.recommendation.clone();
    }
    if fresh.default_action.is_some() {
        existing.default_action = fresh.default_action.clone();
    }
    if fresh.cause.is_some() {
        existing.cause = fresh.cause.clone();
    }
    if !fresh.options.is_empty() {
        existing.options = fresh.options.clone();
    }
    if fresh.scope.is_some() {
        existing.scope = fresh.scope.clone();
    }
    if fresh.run_id.is_some() {
        existing.run_id = fresh.run_id.clone();
    }
    existing.untrusted = existing.untrusted || fresh.untrusted;
}

pub fn add(app: &AppHandle, item: &InboxItem) -> Result<InboxItem, String> {
    let mut item = sanitize(item.clone());
    if item.id.trim().is_empty() {
        item.id = uuid::Uuid::new_v4().to_string();
    }
    if item.at.trim().is_empty() {
        item.at = now();
    }
    if item.title.is_empty() {
        return Err("El ítem de bandeja necesita un título.".into());
    }
    let path = inbox_file(app);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut all = read_items(&path);
    if let Some(key) = item.dedupe_key.clone() {
        if let Some(existing) = all
            .iter_mut()
            .find(|entry| entry.acked_at.is_none() && entry.dedupe_key.as_deref() == Some(key.as_str()))
        {
            merge_open(existing, &item);
            let saved = existing.clone();
            write_items(&path, &all)?;
            emit_changed(app);
            return Ok(saved);
        }
    }
    use std::io::Write;
    let line = serde_json::to_string(&item).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    writeln!(file, "{}", line).map_err(|e| e.to_string())?;
    all.push(item.clone());
    let limit = cutoff();
    if all.len() > MAX_ITEMS || all.iter().any(|entry| expired(entry, limit)) {
        compact(&mut all);
        write_items(&path, &all)?;
    }
    emit_changed(app);
    Ok(item)
}

/// Decisiones abiertas (aprobaciones y decisiones tipadas), ordenadas por deadline.
pub fn decisions(app: &AppHandle, include_resolved: bool) -> Vec<InboxItem> {
    let mut items = read_items(&inbox_file(app));
    items.retain(|item| matches!(item.kind.as_str(), "approval" | "decision"));
    if !include_resolved {
        items.retain(|item| item.decision.as_deref().unwrap_or("pending") == "pending");
    }
    items.sort_by_key(|item| {
        item.expires_at
            .as_deref()
            .and_then(parse_at)
            .map(|at| at.timestamp_millis())
            .unwrap_or(i64::MAX)
    });
    items
}

/// Marca como vencidas las decisiones cuyo deadline pasó y aplica su acción por
/// defecto (approve | reject | resume | park). Devuelve las que cambiaron.
pub fn expire_due(app: &AppHandle) -> Vec<InboxItem> {
    let path = inbox_file(app);
    let mut items = read_items(&path);
    let now_dt = chrono::Utc::now();
    let mut changed = Vec::new();
    for item in items.iter_mut() {
        if item.acked_at.is_some() || item.decision.as_deref().unwrap_or("pending") != "pending" {
            continue;
        }
        let Some(expires) = item.expires_at.as_deref().and_then(parse_at) else { continue };
        if expires >= now_dt {
            continue;
        }
        let action = item.default_action.as_deref().unwrap_or("park");
        item.decision = Some(
            match action {
                "reject" => "rejected",
                "resume" => "resume",
                _ => "expired",
            }
            .to_string(),
        );
        item.decided_at = Some(now());
        item.decided_by = Some("deadline".into());
        item.acked_at = Some(now());
        changed.push(item.clone());
    }
    if !changed.is_empty() {
        let _ = write_items(&path, &items);
        emit_changed(app);
    }
    changed
}

pub fn list(app: &AppHandle, include_acked: bool) -> Vec<InboxItem> {
    let mut items = read_items(&inbox_file(app));
    if !include_acked {
        items.retain(|item| item.acked_at.is_none());
    }
    items.reverse();
    items
}

pub fn decide(app: &AppHandle, id: &str, decision: &str, note: Option<&str>) -> Result<InboxItem, String> {
    let path = inbox_file(app);
    let mut items = read_items(&path);
    let index = items.iter().position(|item| item.id == id).ok_or("No existe ese ítem de bandeja.")?;
    let item = &mut items[index];
    let current = item.decision.as_deref().unwrap_or("pending");
    if current != "pending" {
        return Err(format!("La decisión ya fue tomada ({}).", current));
    }
    if item.expires_at.as_deref().and_then(parse_at).map(|expires| expires < chrono::Utc::now()).unwrap_or(false) {
        item.decision = Some("expired".into());
        item.decided_at = Some(now());
        item.acked_at = Some(now());
        write_items(&path, &items)?;
        emit_changed(app);
        return Err("La aprobación venció. Pedí una nueva desde la misión.".into());
    }
    let decision = match decision.trim() {
        "approved" | "rejected" | "expired" | "resume" => decision.trim(),
        _ => return Err("La decisión debe ser approved, rejected, expired o resume.".into()),
    };
    item.decision = Some(decision.to_string());
    item.decided_at = Some(now());
    item.decided_by = Some("usuario".into());
    item.acked_at = Some(now());
    if let Some(note) = note.map(str::trim).filter(|note| !note.is_empty()) {
        item.body = format!("{}\n\n{}", item.body, note).chars().take(BODY_MAX).collect();
    }
    let saved = item.clone();
    write_items(&path, &items)?;
    emit_changed(app);
    Ok(saved)
}

#[tauri::command]
pub fn agent_inbox_decide(app: AppHandle, id: String, decision: String, note: Option<String>) -> Result<InboxItem, String> {
    decide(&app, &id, &decision, note.as_deref())
}

pub fn ack(app: &AppHandle, id: &str) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("Falta el id del ítem de bandeja.".into());
    }
    let path = inbox_file(app);
    let mut items = read_items(&path);
    let Some(item) = items.iter_mut().find(|item| item.id == id) else {
        return Err("No existe ese ítem de bandeja.".into());
    };
    item.acked_at = Some(now());
    write_items(&path, &items)?;
    emit_changed(app);
    Ok(())
}

/// Redactor para el log y la bandeja: no deja tokens, claves, contraseñas ni cookies.
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    if let Ok(re) = regex::Regex::new(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+") {
        out = re.replace_all(&out, "$1 ***").to_string();
    }
    if let Ok(re) = regex::Regex::new(r"(?i)\b(authorization|cookie|token|api[_-]?key|apikey|secret|password|passwd|pwd)\b\s*[:=]\s*[^\s,;]+") {
        out = re.replace_all(&out, "$1=***").to_string();
    }
    if let Ok(re) = regex::Regex::new(r"(?i)((?:access|refresh|id)[_-]?token)\s*[:=]\s*[^\s,;]+") {
        out = re.replace_all(&out, "$1=***").to_string();
    }
    one_line(&out, BLOCKED_BODY_MAX)
}

/// Texto de una línea para registrar un rechazo del guard en el log, ya redactado.
pub fn blocked_text(reason: &str, props: &Value) -> String {
    let reason = one_line(reason, TITLE_MAX);
    let detail = redact(&format!("{} · {}", reason, props));
    if detail.trim().is_empty() {
        reason
    } else {
        detail
    }
}

#[tauri::command]
pub fn agent_inbox_state(app: AppHandle) -> Value {
    let items = list(&app, true);
    let count = items.iter().filter(|item| item.acked_at.is_none()).count();
    json!({ "items": items, "count": count })
}

#[tauri::command]
pub fn agent_inbox_ack(app: AppHandle, id: String) -> Result<Value, String> {
    ack(&app, &id)?;
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gc-inbox-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn item(id: &str, at: &str, acked_at: Option<&str>) -> InboxItem {
        InboxItem {
            id: id.into(),
            at: at.into(),
            kind: "insight".into(),
            title: format!("Ítem {}", id),
            acked_at: acked_at.map(|value| value.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn tolerates_a_truncated_last_line() {
        let path = temp_file("inbox.ndjson");
        fs::write(&path, "{\"id\":\"ok\",\"title\":\"Válido\",\"body\":\"\",\"kind\":\"insight\",\"at\":\"2026-11-19T10:00:00Z\",\"untrusted\":false}\n{\"id\":\"cortado\",\"title\":\"a med").unwrap();
        let items = read_items(&path);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "ok");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn compaction_drops_old_acked_and_keeps_pending() {
        let old = (chrono::Utc::now() - chrono::Duration::days(120)).format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let recent = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let mut items: Vec<InboxItem> = (0..MAX_ITEMS + 20)
            .map(|index| {
                if index < 20 {
                    item(&format!("viejo-leido-{}", index), &old, Some(&recent))
                } else {
                    item(&format!("pendiente-{}", index), &recent, None)
                }
            })
            .collect();
        assert_eq!(items.len(), MAX_ITEMS + 20);
        compact(&mut items);
        assert_eq!(items.len(), MAX_ITEMS);
        assert!(items.iter().all(|entry| entry.acked_at.is_none()));
        assert!(!items.iter().any(|entry| entry.id.starts_with("viejo-leido-")));
    }

    #[test]
    fn compaction_keeps_unread_even_when_dropping_acked_overflow() {
        let recent = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let mut items: Vec<InboxItem> = (0..MAX_ITEMS)
            .map(|index| item(&format!("pendiente-{}", index), &recent, None))
            .collect();
        items.push(item("leido-0", &recent, Some(&recent)));
        items.push(item("leido-1", &recent, Some(&recent)));
        compact(&mut items);
        assert_eq!(items.len(), MAX_ITEMS);
        assert_eq!(items.iter().filter(|entry| entry.acked_at.is_none()).count(), MAX_ITEMS);
    }

    #[test]
    fn redaction_removes_secrets_from_the_log_entry() {
        let text = redact(r#"falló curl -H "Authorization: Bearer abc123.def" --data token=secreto&password=hunter2"#);
        assert!(!text.contains("abc123"));
        assert!(!text.contains("secreto"));
        assert!(!text.contains("hunter2"));
        assert!(text.len() <= BLOCKED_BODY_MAX);
    }

    #[test]
    fn blocked_text_is_redacted_and_capped() {
        let reason = "Lectura de credenciales fuera del proyecto";
        let props = json!({
            "command": "curl -H \"Authorization: Bearer sk-live.abc123\" token=secreto123 --upload-file /home/guill/.aws/credentials",
            "directory": "/home/guill",
        });
        let text = blocked_text(reason, &props);
        assert!(!text.contains("sk-live"));
        assert!(!text.contains("abc123"));
        assert!(!text.contains("secreto123"));
        assert!(text.contains(".aws/credentials"));
        assert!(text.contains("Lectura de credenciales"));
        assert!(!text.contains('\n') && !text.contains('\r'));
        assert!(text.len() <= BLOCKED_BODY_MAX);
    }

    #[test]
    fn default_action_is_normalized() {
        let item = InboxItem {
            title: "Aprobar envio".into(),
            default_action: Some("approved".into()),
            ..Default::default()
        };
        assert_eq!(sanitize(item).default_action.as_deref(), Some("park"));
        let item = InboxItem {
            title: "Otra".into(),
            default_action: Some("cualquier-cosa".into()),
            ..Default::default()
        };
        assert_eq!(sanitize(item).default_action.as_deref(), Some("park"));
    }

    #[test]
    fn merge_open_refreshes_deadline_and_recommendation() {
        let mut existing = InboxItem {
            id: "1".into(),
            title: "Vieja".into(),
            dedupe_key: Some("bloqueo".into()),
            ..Default::default()
        };
        let fresh = InboxItem {
            id: "2".into(),
            title: "Nueva".into(),
            recommendation: Some("Revisar el certificado".into()),
            default_action: Some("reject".into()),
            expires_at: Some("2026-12-01T00:00:00Z".into()),
            dedupe_key: Some("bloqueo".into()),
            ..Default::default()
        };
        merge_open(&mut existing, &fresh);
        assert_eq!(existing.title, "Nueva");
        assert_eq!(existing.recommendation.as_deref(), Some("Revisar el certificado"));
        assert_eq!(existing.default_action.as_deref(), Some("reject"));
        assert_eq!(existing.expires_at.as_deref(), Some("2026-12-01T00:00:00Z"));
    }
}

