//! Persistent brake for repeated automatic Lead wakes. It complements event
//! deduplication: the same material situation (run, task, kind, status, error)
//! that keeps coming back without progress gets a progressive wait instead of a
//! new turn. The wait is a context/decision hint; it never drops events.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

/// Progressive wait after each repeated automatic wake, in milliseconds.
const BACKOFF_MS: [i64; 5] = [0, 15_000, 60_000, 300_000, 900_000];

/// Records the pending batch situation before a claim. Returns whether the Lead
/// may run now. A user message always releases the brake and is never deferred.
pub(super) fn admit(db: &Connection, chat: &str, fingerprint: &str, has_user_message: bool, now: i64) -> Result<bool, String> {
    if has_user_message {
        db.execute("DELETE FROM team_lead_guard WHERE chat_id=?1", [chat]).map_err(err)?;
        log::info!("[teams-lead] freno de coordinación liberado por mensaje del usuario (chat={chat})");
        record(db, chat, "guard.released", "user_message", "released", now);
        return Ok(true);
    }
    let existing: Option<(String, i64, i64)> = db.query_row(
        "SELECT fingerprint,repeats,next_at FROM team_lead_guard WHERE chat_id=?1",
        [chat], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(err)?;
    let Some((saved, repeats, next_at)) = existing else {
        db.execute(
            "INSERT INTO team_lead_guard(chat_id,fingerprint,repeats,next_at,updated_at) VALUES(?1,?2,1,?3,?3)",
            params![chat, fingerprint, now],
        ).map_err(err)?;
        return Ok(true);
    };
    if saved != fingerprint {
        // Materially new information (different task, status or error) releases
        // the brake and starts a new count.
        db.execute(
            "UPDATE team_lead_guard SET fingerprint=?2,repeats=1,next_at=?3,updated_at=?3 WHERE chat_id=?1",
            params![chat, fingerprint, now],
        ).map_err(err)?;
        log::info!("[teams-lead] freno de coordinación liberado por información nueva (chat={chat})");
        record(db, chat, "guard.released", "new_information", "released", now);
        return Ok(true);
    }
    if now < next_at {
        log::info!("[teams-lead] despertar automático diferido (chat={chat}, repeticiones={repeats}, espera_ms={})", next_at.saturating_sub(now));
        record(db, chat, "guard.deferred", fingerprint, "deferred", now);
        return Ok(false);
    }
    let repeats = (repeats + 1).clamp(1, BACKOFF_MS.len() as i64);
    let next = now.saturating_add(BACKOFF_MS[(repeats - 1) as usize]);
    db.execute(
        "UPDATE team_lead_guard SET repeats=?2,next_at=?3,updated_at=?4 WHERE chat_id=?1",
        params![chat, repeats, next, now],
    ).map_err(err)?;
    record(db, chat, "guard.waiting", fingerprint, "waiting", now);
    Ok(true)
}

/// Best-effort ledger note for a brake decision. It never changes admission.
fn record(db: &Connection, chat: &str, kind: &str, reason: &str, outcome: &str, now: i64) {
    let (session_id, project) = super::ledger::context(db, chat);
    let _ = super::ledger::record(db, super::ledger::Entry {
        at: now,
        project,
        session_id,
        chat_id: chat.into(),
        source: "guard".into(),
        reason: reason.into(),
        kind: kind.into(),
        outcome: outcome.into(),
        ..Default::default()
    });
}

/// Fingerprint of the pending inbox batch plus whether a real user message is
/// waiting. Volatile fields (timestamps, IDs, text) are excluded by
/// [`super::lead_policy::situation`].
pub(super) fn pending_signature(db: &Connection, chat: &str) -> Result<Option<(String, bool)>, String> {
    let mut query = db.prepare(
        "SELECT e.kind,e.payload_json FROM team_inbox i
         JOIN team_events e ON e.event_id=i.event_id
         WHERE i.chat_id=?1 AND i.status='pending'
         ORDER BY i.priority DESC,e.sequence LIMIT 64",
    ).map_err(err)?;
    let rows = query.query_map([chat], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
    if rows.is_empty() { return Ok(None); }
    let has_user_message = rows.iter().any(|(kind, _)| kind == "user.message_received");
    let mut parts: Vec<String> = rows.iter().map(|(kind, payload)| {
        let payload = serde_json::from_str::<Value>(payload).unwrap_or(Value::Null);
        super::lead_policy::situation(kind, &payload)
    }).collect();
    parts.sort();
    parts.dedup();
    Ok(Some((parts.join("\n"), has_user_message)))
}

fn err(error: rusqlite::Error) -> String { error.to_string() }

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE team_lead_guard(
                chat_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                repeats INTEGER NOT NULL, next_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
        ).unwrap();
        db
    }

    #[test]
    fn the_same_situation_waits_progressively_and_keeps_the_brake() {
        let db = database();
        assert!(admit(&db, "chat", "same", false, 1_000).unwrap());
        assert!(admit(&db, "chat", "same", false, 2_000).unwrap(), "the second occurrence is still admitted");
        assert!(!admit(&db, "chat", "same", false, 3_000).unwrap(), "a third wake inside the window waits");
        assert!(admit(&db, "chat", "same", false, 70_000).unwrap(), "the 15 s wait expired and is re-evaluated");
        assert!(!admit(&db, "chat", "same", false, 80_000).unwrap(), "the next step is longer (60 s)");
        assert!(admit(&db, "chat", "same", false, 131_000).unwrap(), "the longer wait also expires");
    }

    #[test]
    fn new_information_releases_the_brake() {
        let db = database();
        assert!(admit(&db, "chat", "fail", false, 1_000).unwrap());
        assert!(admit(&db, "chat", "fail", false, 2_000).unwrap());
        assert!(!admit(&db, "chat", "fail", false, 3_000).unwrap());
        assert!(admit(&db, "chat", "other-task", false, 3_500).unwrap(), "a different situation is not blocked");
        assert!(admit(&db, "chat", "fail", false, 3_600).unwrap(), "the counter restarted with the new situation");
    }

    #[test]
    fn a_user_message_always_wakes_and_clears_the_brake() {
        let db = database();
        assert!(admit(&db, "chat", "fail", false, 1_000).unwrap());
        assert!(admit(&db, "chat", "fail", false, 2_000).unwrap());
        assert!(!admit(&db, "chat", "fail", false, 3_000).unwrap());
        assert!(admit(&db, "chat", "fail", true, 3_100).unwrap());
        let exists: Option<String> = db.query_row("SELECT chat_id FROM team_lead_guard WHERE chat_id='chat'", [], |r| r.get(0)).optional().unwrap();
        assert!(exists.is_none());
    }
}
