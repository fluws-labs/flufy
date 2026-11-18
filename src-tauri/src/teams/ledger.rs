//! Local coordination ledger. It records why the Lead was woken and how much a
//! run spent. It is observational: a ledger failure never blocks coordination,
//! never calls the model and never stores prompts, credentials or paths.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    // db() opens on every snapshot update; existing installs must not take a
    // schema write on each poll.
    if table(db, "agent_ledger") { return Ok(()); }
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_ledger(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at INTEGER NOT NULL,
            project TEXT NOT NULL DEFAULT '',
            session_id TEXT NOT NULL DEFAULT '',
            chat_id TEXT NOT NULL DEFAULT '',
            run_id TEXT NOT NULL DEFAULT '',
            task_id TEXT NOT NULL DEFAULT '',
            turn_id TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT '',
            tokens_in INTEGER NOT NULL DEFAULT 0,
            tokens_out INTEGER NOT NULL DEFAULT 0,
            tokens_reasoning INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL,
            context_tokens INTEGER,
            context_limit INTEGER,
            tool_calls INTEGER NOT NULL DEFAULT 0,
            tool_errors INTEGER NOT NULL DEFAULT 0,
            notices_grouped INTEGER NOT NULL DEFAULT 0,
            events_preserved INTEGER NOT NULL DEFAULT 0,
            outcome TEXT NOT NULL DEFAULT ''
        );
         CREATE INDEX IF NOT EXISTS agent_ledger_chat ON agent_ledger(chat_id,at);
         CREATE INDEX IF NOT EXISTS agent_ledger_run ON agent_ledger(run_id,at);"
    ).map_err(err)
}

#[derive(Default, Clone, Debug)]
pub(super) struct Entry {
    pub at: i64,
    pub project: String,
    pub session_id: String,
    pub chat_id: String,
    pub run_id: String,
    pub task_id: String,
    pub turn_id: String,
    pub source: String,
    pub reason: String,
    pub kind: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub tokens_reasoning: i64,
    pub cost_usd: Option<f64>,
    pub context_tokens: Option<i64>,
    pub context_limit: Option<i64>,
    pub tool_calls: i64,
    pub tool_errors: i64,
    pub notices_grouped: i64,
    pub events_preserved: i64,
    pub outcome: String,
}

fn err(e: rusqlite::Error) -> String { e.to_string() }

fn table(db: &Connection, name: &str) -> bool {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name], |row| row.get::<_, bool>(0),
    ).unwrap_or(false)
}

/// Best-effort append. The ledger is evidence, never a dependency: without its
/// table (older databases or isolated tests) the coordination continues.
pub(super) fn record(db: &Connection, entry: Entry) -> Result<(), String> {
    if !table(db, "agent_ledger") { return Ok(()); }
    db.execute(
        "INSERT INTO agent_ledger(at,project,session_id,chat_id,run_id,task_id,turn_id,source,reason,kind,
            tokens_in,tokens_out,tokens_reasoning,cost_usd,context_tokens,context_limit,
            tool_calls,tool_errors,notices_grouped,events_preserved,outcome)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
        params![
            entry.at, entry.project, entry.session_id, entry.chat_id, entry.run_id, entry.task_id,
            entry.turn_id, entry.source, entry.reason, entry.kind, entry.tokens_in, entry.tokens_out,
            entry.tokens_reasoning, entry.cost_usd, entry.context_tokens, entry.context_limit,
            entry.tool_calls, entry.tool_errors, entry.notices_grouped, entry.events_preserved, entry.outcome,
        ],
    ).map(|_| ()).map_err(err)
}

/// Binding context for a chat so every entry carries its real session and root.
/// Identity comes from the native binding, never from model-supplied values.
pub(super) fn context(db: &Connection, chat: &str) -> (String, String) {
    db.query_row(
        "SELECT source_session_id,directory FROM team_conversation_bindings WHERE team_chat_id=?1",
        [chat], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    ).optional().ok().flatten().unwrap_or_default()
}

/// Run and task carried by an event payload, when present.
pub(super) fn ids(payload: &Value) -> (String, String) {
    let field = |name: &str| payload.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
    (field("runId"), field("taskId"))
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerReason {
    pub reason: String,
    pub count: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunLedger {
    pub run_id: String,
    pub chat_id: String,
    pub tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    pub lead_turns: i64,
    pub ui_only_events: i64,
    pub notices_grouped: i64,
    pub events_preserved: i64,
    pub tool_calls: i64,
    pub tool_errors: i64,
    pub reasons: Vec<LedgerReason>,
    pub outcome: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GuardState {
    pub chat_id: String,
    pub fingerprint: String,
    pub reason: String,
    pub repeats: i64,
    pub next_at: i64,
    pub updated_at: i64,
}

/// Per-run summary. Tokens and cost come from the engine's own message metadata
/// (`Run.session_usage`), so the ledger never invents a number.
pub(super) fn run_summary(
    db: &Connection,
    run_id: &str,
    chat_id: &str,
    tokens: Option<u64>,
    cost_usd: Option<f64>,
) -> Result<RunLedger, String> {
    let mut summary = RunLedger {
        run_id: run_id.into(), chat_id: chat_id.into(), tokens, cost_usd,
        lead_turns: 0, ui_only_events: 0, notices_grouped: 0, events_preserved: 0,
        tool_calls: 0, tool_errors: 0, reasons: vec![], outcome: None,
    };
    if !table(db, "agent_ledger") { return Ok(summary); }
    let (turns, ui_only, grouped, preserved, tool_calls, tool_errors): (i64, i64, i64, i64, i64, i64) = db.query_row(
        "SELECT
            COALESCE(SUM(kind='lead.turn'),0),
            COALESCE(SUM(kind='event.ui'),0),
            COALESCE(SUM(notices_grouped),0),
            COALESCE(SUM(kind IN ('lead.turn','event.ui')),0),
            COALESCE(SUM(tool_calls),0),
            COALESCE(SUM(tool_errors),0)
         FROM agent_ledger WHERE run_id=?1",
        [run_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    ).map_err(err)?;
    summary.lead_turns = turns;
    summary.ui_only_events = ui_only;
    summary.notices_grouped = grouped;
    summary.events_preserved = preserved;
    summary.tool_calls = tool_calls;
    summary.tool_errors = tool_errors;
    let mut reasons = db.prepare(
        "SELECT reason,COUNT(*) FROM agent_ledger
         WHERE run_id=?1 AND kind='lead.turn' AND reason!=''
         GROUP BY reason ORDER BY COUNT(*) DESC,reason LIMIT 6",
    ).map_err(err)?;
    summary.reasons = reasons.query_map([run_id], |row| Ok(LedgerReason { reason: row.get(0)?, count: row.get(1)? }))
        .map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
    summary.outcome = db.query_row(
        "SELECT outcome FROM agent_ledger WHERE run_id=?1 AND outcome!='' ORDER BY id DESC LIMIT 1",
        [run_id], |row| row.get(0),
    ).optional().map_err(err)?;
    Ok(summary)
}

/// Active brakes only: a guard whose wait already elapsed is not shown. A user
/// message deletes the row, so the wait disappears when it is released.
pub(super) fn guards(db: &Connection, now: i64) -> Result<Vec<GuardState>, String> {
    if !table(db, "team_lead_guard") { return Ok(vec![]); }
    let mut query = db.prepare(
        "SELECT chat_id,fingerprint,repeats,next_at,updated_at FROM team_lead_guard
         WHERE next_at>?1 ORDER BY next_at",
    ).map_err(err)?;
    let rows = query.query_map([now], |row| Ok((
        row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?,
        row.get::<_, i64>(3)?, row.get::<_, i64>(4)?,
    ))).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
    Ok(rows.into_iter().map(|(chat_id, fingerprint, repeats, next_at, updated_at)| GuardState {
        reason: guard_reason(&fingerprint),
        chat_id, fingerprint, repeats, next_at, updated_at,
    }).collect())
}

/// The fingerprint is `kind|run=..|task=..|title=..|status=..|error=..`. It is
/// already free of timestamps and IDs, so it can be shown as the wait reason.
fn guard_reason(fingerprint: &str) -> String {
    let mut segments = fingerprint.split('|');
    let kind = segments.next().unwrap_or_default();
    let mut title = "";
    let mut status = "";
    for part in segments {
        if let Some(value) = part.strip_prefix("title=") { title = value; }
        if let Some(value) = part.strip_prefix("status=") { status = value; }
    }
    let label = match kind {
        "run.attention" => "Atención del trabajo",
        "run.blocked" => "Trabajo bloqueado",
        "run.completed" => "Trabajo terminado",
        "user.message_received" => "Mensaje del usuario",
        "coordination.requested" | "coordination.updated" | "lead.coordination" => "Coordinación",
        "dependency.unlocked" | "task.unblocked" => "Dependencia liberada",
        "response.expected" => "Respuesta esperada",
        "team.activated" => "Activación del equipo",
        "" => "Espera de coordinación",
        other => other,
    };
    let mut reason = label.to_string();
    if !title.is_empty() { reason.push_str(&format!(" · {title}")); }
    if !status.is_empty() { reason.push_str(&format!(" ({status})")); }
    reason
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn database() -> Connection {
        let mut db = Connection::open_in_memory().unwrap();
        migrate(&mut db).unwrap();
        db.execute_batch(
            "CREATE TABLE team_conversation_bindings(
                source_session_id TEXT PRIMARY KEY, team_chat_id TEXT NOT NULL UNIQUE,
                directory TEXT NOT NULL, activated_at INTEGER NOT NULL);
             CREATE TABLE team_lead_guard(
                chat_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                repeats INTEGER NOT NULL, next_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
        ).unwrap();
        db
    }

    #[test]
    fn entries_are_appended_with_real_binding_context() {
        let db = database();
        db.execute("INSERT INTO team_conversation_bindings VALUES('ses','chat','C:/repo',1)", []).unwrap();
        record(&db, Entry {
            at: 10, chat_id: "chat".into(), kind: "lead.turn".into(), reason: "run.attention".into(),
            events_preserved: 1, outcome: "queued".into(), ..Default::default()
        }).unwrap();
        let (session, project) = context(&db, "chat");
        assert_eq!(session, "ses");
        assert_eq!(project, "C:/repo");
        let count: i64 = db.query_row("SELECT COUNT(*) FROM agent_ledger", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn summary_counts_turns_reasons_notices_and_keeps_engine_tokens() {
        let db = database();
        for (kind, reason, grouped) in [
            ("lead.turn", "run.attention", 0),
            ("lead.turn", "run.attention", 0),
            ("lead.turn", "user.message_received", 0),
            ("event.ui", "capture.published", 0),
            ("turn.dispatch", "run.attention", 10),
        ] {
            record(&db, Entry {
                at: 10, chat_id: "chat".into(), run_id: "run".into(), kind: kind.into(),
                reason: reason.into(), notices_grouped: grouped, events_preserved: if kind == "event.ui" { 1 } else { 0 },
                outcome: if kind == "lead.turn" { "queued".into() } else { "observed".into() },
                ..Default::default()
            }).unwrap();
        }
        let summary = run_summary(&db, "run", "chat", Some(1200), Some(0.02)).unwrap();
        assert_eq!(summary.lead_turns, 3);
        assert_eq!(summary.ui_only_events, 1);
        assert_eq!(summary.notices_grouped, 10);
        assert_eq!(summary.events_preserved, 4, "every durable event is preserved once");
        assert_eq!(summary.tokens, Some(1200));
        assert_eq!(summary.cost_usd, Some(0.02));
        assert_eq!(summary.reasons.first().map(|r| r.reason.as_str()), Some("run.attention"));
        assert_eq!(summary.reasons.first().map(|r| r.count), Some(2));
    }

    #[test]
    fn only_active_guards_are_exposed_with_a_readable_reason() {
        let db = database();
        db.execute(
            "INSERT INTO team_lead_guard VALUES('chat','run.attention|run=r1|task=T1|title=Pantallas|status=blocked|error=timeout',3,5000,4000)",
            [],
        ).unwrap();
        let active = guards(&db, 4000).unwrap();
        assert_eq!(active.len(), 1);
        assert!(active[0].reason.contains("Atención del trabajo"));
        assert!(active[0].reason.contains("Pantallas"));
        assert_eq!(active[0].repeats, 3);
        assert!(guards(&db, 5001).unwrap().is_empty(), "an elapsed wait disappears");
    }

    #[test]
    fn a_missing_ledger_table_never_breaks_coordination() {
        let db = Connection::open_in_memory().unwrap();
        assert!(record(&db, Entry { at: 1, kind: "lead.turn".into(), ..Default::default() }).is_ok());
        let summary = run_summary(&db, "run", "chat", None, None).unwrap();
        assert_eq!(summary.lead_turns, 0);
        assert!(guards(&db, 1).unwrap().is_empty());
    }

    #[test]
    fn payload_ids_are_read_without_inventing_identity() {
        assert_eq!(ids(&json!({"runId":"r1","taskId":"T1"})), ("r1".into(), "T1".into()));
        assert_eq!(ids(&json!({})), (String::new(), String::new()));
    }
}
