//! Durable mailbox for the conversational Lead. No inference or tool dispatch
//! occurs here. One reserved turn survives process loss until reconciled.
//! New conversations are not enrolled until the native actor is connected.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(super) fn migrate(db: &mut Connection) -> Result<(), String> {
    // db() is opened by every snapshot update. Existing installations must not
    // take a schema-writing transaction on every observation/poll.
    let installed: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_lead_schema')", [], |r|r.get(0)).map_err(err)?;
    if installed {
        let version: i64 = db.query_row("SELECT version FROM team_lead_schema", [], |r|r.get(0)).map_err(err)?;
        if version == 2 { return Ok(()); }
        if version == 1 {
            // v2 adds the durable coordination brake; existing bindings, events,
            // inbox rows and reserved turns are preserved.
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS team_lead_guard(
                    chat_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                    repeats INTEGER NOT NULL, next_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 UPDATE team_lead_schema SET version=2;"
            ).map_err(err)?;
            return tx.commit().map_err(err);
        }
        return Err("LEAD_SCHEMA_UNSUPPORTED: no se modificó la base del equipo".into());
    }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS team_lead_schema(version INTEGER NOT NULL);
         INSERT INTO team_lead_schema(version) SELECT 2 WHERE NOT EXISTS(SELECT 1 FROM team_lead_schema);"
    ).map_err(err)?;
    let version: i64 = tx.query_row("SELECT version FROM team_lead_schema", [], |row| row.get(0)).map_err(err)?;
    if version != 2 { return Err("LEAD_SCHEMA_UNSUPPORTED: no se modificó la base del equipo".into()); }
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS team_conversation_bindings(
            source_session_id TEXT PRIMARY KEY, team_chat_id TEXT NOT NULL UNIQUE,
            directory TEXT NOT NULL, activated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS team_events(
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
            chat_id TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE,
            payload_hash TEXT NOT NULL, kind TEXT NOT NULL,
            payload_json TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS team_events_chat_sequence ON team_events(chat_id,sequence);
         CREATE TABLE IF NOT EXISTS team_inbox(
            event_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, priority INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','claimed','processed')),
            lead_turn_id TEXT);
         CREATE INDEX IF NOT EXISTS team_inbox_pending ON team_inbox(chat_id,status,priority);
         CREATE TABLE IF NOT EXISTS team_lead_turns(
            turn_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, session_id TEXT NOT NULL,
            prompt_message_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL
                CHECK(status IN ('prepared','dispatching','uncertain','completed')),
            created_at INTEGER NOT NULL, finished_at INTEGER);
         CREATE UNIQUE INDEX IF NOT EXISTS team_lead_one_active
            ON team_lead_turns(chat_id) WHERE status != 'completed';
         CREATE TABLE IF NOT EXISTS team_lead_guard(
            chat_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
            repeats INTEGER NOT NULL, next_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);"
    ).map_err(err)?;
    tx.commit().map_err(err)
}

fn err(e: rusqlite::Error) -> String { e.to_string() }

/// Called only by the native activation transaction, after checking the real
/// session/directory and creating the team in team_store. Never from model IDs.
pub(super) fn bind(tx: &rusqlite::Transaction<'_>, session: &str, chat: &str, directory: &str, now: i64) -> Result<(), String> {
    if session.is_empty() || chat.is_empty() || directory.is_empty() { return Err("INVALID_BINDING".into()); }
    let previous: Option<(String, String)> = tx.query_row(
        "SELECT team_chat_id,directory FROM team_conversation_bindings WHERE source_session_id=?1",
        [session], |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional().map_err(err)?;
    if let Some((id, root)) = previous {
        return if id == chat && super::domain::same_path(&root, directory) { Ok(()) }
            else { Err("CONVERSATION_ALREADY_BOUND".into()) };
    }
    tx.execute("INSERT INTO team_conversation_bindings VALUES(?1,?2,?3,?4)", params![session,chat,directory,now]).map_err(err)?;
    Ok(())
}

pub(super) fn bound_chat_tx(tx: &rusqlite::Transaction<'_>, session: &str) -> Result<Option<String>, String> {
    tx.query_row(
        "SELECT team_chat_id FROM team_conversation_bindings WHERE source_session_id=?1",
        [session], |r| r.get(0),
    ).optional().map_err(err)
}

/// Removes the conversational binding. Pending work for that chat is dropped
/// so a future activation cannot replay old events against a new turn.
pub(super) fn unbind(tx: &rusqlite::Transaction<'_>, session: &str) -> Result<Option<String>, String> {
    let chat: Option<String> = bound_chat_tx(tx, session)?;
    let Some(chat) = chat else { return Ok(None) };
    tx.execute("DELETE FROM team_inbox WHERE chat_id=?1 AND status!='processed'", [&chat]).map_err(err)?;
    tx.execute("DELETE FROM team_lead_turns WHERE chat_id=?1 AND status!='completed'", [&chat]).map_err(err)?;
    tx.execute("DELETE FROM team_conversation_bindings WHERE source_session_id=?1", [session]).map_err(err)?;
    Ok(Some(chat))
}

fn payload_hash(chat: &str, kind: &str, payload: &Value, priority: Option<i64>) -> String {
    // Stable across serde_json preserve_order changes and retries with a
    // different object-key insertion order. Arrays remain ordered.
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(object) => {
                let sorted: std::collections::BTreeMap<_,_> = object.iter().map(|(k,v)| (k.clone(),canonical(v))).collect();
                serde_json::to_value(sorted).expect("JSON object")
            }
            Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
            other => other.clone(),
        }
    }
    format!("{:x}", Sha256::digest(serde_json::to_vec(&canonical(&serde_json::json!([chat,kind,payload,priority]))).expect("JSON payload")))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Receipt {
    pub event_id: String,
    pub sequence: i64,
}

/// Same transaction as the domain mutation. priority=None records progress
/// without waking the Lead. Replays return the original receipt.
pub(super) fn enqueue(tx: &rusqlite::Transaction<'_>, chat: &str, command: &str, kind: &str, payload: &Value, priority: Option<i64>, now: i64) -> Result<Receipt,String> {
    if command.is_empty() || kind.is_empty() { return Err("INVALID_EVENT".into()); }
    let hash = payload_hash(chat,kind,payload,priority);
    let previous: Option<(String,i64,String)> = tx.query_row(
        "SELECT event_id,sequence,payload_hash FROM team_events WHERE command_id=?1", [command],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    ).optional().map_err(err)?;
    if let Some((event_id,sequence,previous_hash)) = previous {
        return if hash == previous_hash { Ok(Receipt {event_id,sequence}) } else { Err("COMMAND_PAYLOAD_CONFLICT".into()) };
    }
    let bound: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM team_conversation_bindings WHERE team_chat_id=?1)",[chat],|r|r.get(0)).map_err(err)?;
    if !bound { return Err("CONVERSATION_NOT_BOUND".into()); }
    let event_id = super::domain::id();
    tx.execute("INSERT INTO team_events(event_id,chat_id,command_id,payload_hash,kind,payload_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![event_id,chat,command,hash,kind,payload.to_string(),now]).map_err(err)?;
    let sequence = tx.last_insert_rowid();
    if let Some(priority) = priority {
        tx.execute("INSERT INTO team_inbox(event_id,chat_id,priority,status) VALUES(?1,?2,?3,'pending')",params![event_id,chat,priority]).map_err(err)?;
    }
    Ok(Receipt {event_id,sequence})
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LeadTurn {
    pub turn_id: String,
    pub session_id: String,
    pub prompt_message_id: String,
    pub status: String,
    pub event_ids: Vec<String>,
}

pub(super) fn current(db: &Connection, chat: &str) -> Result<Option<LeadTurn>,String> {
    let turn: Option<(String,String,String,String)> = db.query_row(
        "SELECT turn_id,session_id,prompt_message_id,status FROM team_lead_turns WHERE chat_id=?1 AND status!='completed'",
        [chat],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
    ).optional().map_err(err)?;
    let Some((turn_id,session_id,prompt_message_id,status)) = turn else { return Ok(None) };
    let mut query = db.prepare("SELECT i.event_id FROM team_inbox i JOIN team_events e ON e.event_id=i.event_id WHERE lead_turn_id=?1 ORDER BY i.priority DESC,e.sequence").map_err(err)?;
    let event_ids = query.query_map([&turn_id],|r|r.get(0)).map_err(err)?.collect::<Result<Vec<String>,_>>().map_err(err)?;
    Ok(Some(LeadTurn {turn_id,session_id,prompt_message_id,status,event_ids}))
}

/// Native dispatch reservation. None means idle OR already owned: callers must
/// inspect current() for recovery, never start a second turn or silently steal.
pub(super) fn claim(db: &mut Connection, chat: &str, now: i64) -> Result<Option<LeadTurn>,String> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(err)?;
    if current(&tx,chat)?.is_some() { return Ok(None); }
    // Repeated automatic wakes for the same material situation wait instead of
    // producing a new turn. Pending events stay pending; a user message clears
    // the brake and any newly arrived information changes the fingerprint.
    if let Some((fingerprint, has_user_message)) = super::lead_guard::pending_signature(&tx, chat)? {
        if !super::lead_guard::admit(&tx, chat, &fingerprint, has_user_message, now)? {
            tx.commit().map_err(err)?;
            return Ok(None);
        }
    }
    let session: Option<String> = tx.query_row("SELECT source_session_id FROM team_conversation_bindings WHERE team_chat_id=?1",[chat],|r|r.get(0)).optional().map_err(err)?;
    let session_id = session.ok_or("CONVERSATION_NOT_BOUND")?;
    let rows = {
        let mut query = tx.prepare("SELECT e.event_id,e.kind,e.payload_json FROM team_inbox i JOIN team_events e ON e.event_id=i.event_id WHERE i.chat_id=?1 AND i.status='pending' ORDER BY i.priority DESC,e.sequence LIMIT 64").map_err(err)?;
        let mapped = query.query_map([chat],|r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?))).map_err(err)?;
        let rows = mapped.collect::<Result<Vec<_>,_>>().map_err(err)?;
        rows
    };
    if rows.is_empty() { return Ok(None); }
    // A user message keeps its own client message ID so the optimistic bubble
    // in the conversation matches the engine message. It travels alone; other
    // events wait for the next turn instead of being fused into the user's text.
    let user = rows.iter().find(|(_, kind, _)| kind == "user.message_received");
    let event_ids = match user {
        Some((id, _, _)) => vec![id.clone()],
        None => rows.iter().map(|(id, _, _)| id.clone()).collect(),
    };
    let prompt_message_id = user
        .and_then(|(_, _, payload)| serde_json::from_str::<Value>(payload).ok())
        .and_then(|payload| payload["messageId"].as_str().filter(|id| !id.is_empty()).map(String::from))
        .unwrap_or_else(|| format!("msg_{}",super::domain::id()));
    let turn = LeadTurn { turn_id:super::domain::id(), session_id, prompt_message_id, status:"prepared".into(), event_ids };
    tx.execute("INSERT INTO team_lead_turns VALUES(?1,?2,?3,?4,'prepared',?5,NULL)",params![turn.turn_id,chat,turn.session_id,turn.prompt_message_id,now]).map_err(err)?;
    for event in &turn.event_ids {
        tx.execute("UPDATE team_inbox SET status='claimed',lead_turn_id=?1 WHERE event_id=?2 AND status='pending'",params![turn.turn_id,event]).map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(Some(turn))
}

/// CAS prevents a second dispatcher from sending a reserved turn. An uncertain
/// attempt is deliberately NOT sendable: reconciliation is observational.
pub(super) fn dispatching(db: &Connection, turn: &str) -> Result<(),String> {
    let changed = db.execute("UPDATE team_lead_turns SET status='dispatching' WHERE turn_id=?1 AND status='prepared'",[turn]).map_err(err)?;
    if changed != 1 { return Err("LEAD_TURN_NOT_SENDABLE".into()); }
    Ok(())
}

pub(super) fn uncertain(db: &Connection, turn: &str) -> Result<(),String> {
    let changed = db.execute("UPDATE team_lead_turns SET status='uncertain' WHERE turn_id=?1 AND status IN ('dispatching','uncertain')",[turn]).map_err(err)?;
    if changed != 1 { return Err("LEAD_TURN_NOT_DISPATCHED".into()); }
    Ok(())
}

/// Must share the decision/domain commit transaction. Only the claimed input
/// batch is consumed; concurrent incoming messages remain pending.
pub(super) fn complete(tx: &rusqlite::Transaction<'_>, chat: &str, turn: &str, now: i64) -> Result<(),String> {
    let changed = tx.execute("UPDATE team_lead_turns SET status='completed',finished_at=?1 WHERE turn_id=?2 AND chat_id=?3 AND status IN ('dispatching','uncertain')",params![now,turn,chat]).map_err(err)?;
    if changed != 1 { return Err("LEAD_TURN_NOT_DISPATCHED".into()); }
    tx.execute("UPDATE team_inbox SET status='processed' WHERE lead_turn_id=?1 AND chat_id=?2 AND status='claimed'",params![turn,chat]).map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn database() -> Connection {
        let mut db = Connection::open_in_memory().unwrap(); migrate(&mut db).unwrap();
        let tx = db.transaction().unwrap(); bind(&tx,"ses_origin","chat","C:/repo",1).unwrap(); tx.commit().unwrap(); db
    }
    fn event(db: &mut Connection, id: &str, priority: Option<i64>) -> Receipt {
        let tx = db.transaction().unwrap();
        let receipt = enqueue(&tx,"chat",id,"test",&json!({"id":id}),priority,2).unwrap();
        tx.commit().unwrap(); receipt
    }
    #[test]
    fn binding_and_payload_replays_do_not_duplicate_work() {
        let mut db = database();
        let first = event(&mut db,"command",Some(1));
        assert_eq!(first,event(&mut db,"command",Some(1)));
        let tx = db.transaction().unwrap();
        bind(&tx,"ses_origin","chat","c:\\repo",2).unwrap();
        assert!(bind(&tx,"ses_origin","other","C:/repo",2).is_err());
        assert!(bind(&tx,"other","chat","C:/repo",2).is_err());
        assert!(enqueue(&tx,"chat","command","test",&json!({"different":true}),Some(1),3).unwrap_err().contains("CONFLICT"));
        assert!(enqueue(&tx,"wrong","new","test",&json!({}),Some(1),3).is_err());
    }
    #[test]
    fn unbind_removes_the_binding_and_pending_work() {
        let mut db = database();
        event(&mut db,"pending",Some(10));
        let turn = claim(&mut db,"chat",3).unwrap().unwrap();
        dispatching(&db,&turn.turn_id).unwrap();
        let tx = db.transaction().unwrap();
        assert_eq!(unbind(&tx,"ses_origin").unwrap().as_deref(),Some("chat"));
        tx.commit().unwrap();
        let tx = db.transaction().unwrap();
        assert_eq!(bound_chat_tx(&tx,"ses_origin").unwrap(),None);
        tx.commit().unwrap();
        assert!(current(&db,"chat").unwrap().is_none());
        assert!(claim(&mut db,"chat",4).is_err(), "an unbound chat cannot be claimed");
        let tx = db.transaction().unwrap();
        assert_eq!(unbind(&tx,"ses_origin").unwrap(),None);
    }
    #[test]
    fn rollback_keeps_domain_snapshot_and_event_atomic() {
        let mut db = database();
        db.execute_batch("CREATE TABLE team_store(document TEXT); INSERT INTO team_store VALUES('before');").unwrap();
        {
            let tx = db.transaction().unwrap();
            tx.execute("UPDATE team_store SET document='after'",[]).unwrap();
            enqueue(&tx,"chat","rollback","test",&json!({}),Some(1),3).unwrap();
            // Simulate failure before commit: neither snapshot nor event survives.
        }
        assert_eq!(db.query_row("SELECT document FROM team_store",[],|r|r.get::<_,String>(0)).unwrap(),"before");
        assert!(claim(&mut db,"chat",4).unwrap().is_none());
        let tx = db.transaction().unwrap();
        tx.execute("UPDATE team_store SET document='after'",[]).unwrap();
        enqueue(&tx,"chat","commit","test",&json!({}),Some(1),3).unwrap(); tx.commit().unwrap();
        assert!(claim(&mut db,"chat",4).unwrap().is_some());
        assert_eq!(db.query_row("SELECT document FROM team_store",[],|r|r.get::<_,String>(0)).unwrap(),"after");
    }
    #[test]
    fn progress_does_not_wake_and_messages_received_while_busy_are_not_lost() {
        let mut db = database();
        for n in 0..100 { event(&mut db,&format!("progress-{n}"),None); }
        assert!(claim(&mut db,"chat",3).unwrap().is_none());
        let low = event(&mut db,"result",Some(1)); let high = event(&mut db,"user",Some(10));
        let turn = claim(&mut db,"chat",4).unwrap().unwrap();
        assert_eq!(turn.session_id,"ses_origin"); assert_eq!(turn.event_ids,vec![high.event_id,low.event_id]);
        assert!(claim(&mut db,"chat",5).unwrap().is_none());
        let later = event(&mut db,"later",Some(10));
        dispatching(&db,&turn.turn_id).unwrap();
        assert!(dispatching(&db,&turn.turn_id).is_err());
        uncertain(&db,&turn.turn_id).unwrap();
        assert!(dispatching(&db,&turn.turn_id).is_err(),"Uncertain prompts must never be resent");
        let tx = db.transaction().unwrap();
        assert!(complete(&tx,"wrong-chat",&turn.turn_id,6).is_err());
        complete(&tx,"chat",&turn.turn_id,6).unwrap(); tx.commit().unwrap();
        assert_eq!(claim(&mut db,"chat",7).unwrap().unwrap().event_ids,vec![later.event_id]);
    }
    #[test]
    fn reopening_preserves_reservation_and_blocks_a_second_writer() {
        let path = std::env::temp_dir().join(format!("flufy-lead-{}.sqlite",super::super::domain::id()));
        {
            let mut db = Connection::open(&path).unwrap(); migrate(&mut db).unwrap();
            let tx = db.transaction().unwrap(); bind(&tx,"ses","chat","C:/repo",1).unwrap(); tx.commit().unwrap();
            event(&mut db,"event",Some(1));
            let turn = claim(&mut db,"chat",2).unwrap().unwrap(); dispatching(&db,&turn.turn_id).unwrap();
            let mut other = Connection::open(&path).unwrap();
            assert!(claim(&mut other,"chat",3).unwrap().is_none());
            assert_eq!(current(&other,"chat").unwrap().unwrap().prompt_message_id,turn.prompt_message_id);
        }
        {
            let mut db = Connection::open(&path).unwrap(); migrate(&mut db).unwrap();
            assert!(claim(&mut db,"chat",4).unwrap().is_none());
            assert_eq!(current(&db,"chat").unwrap().unwrap().status,"dispatching");
        }
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn simultaneous_claims_have_one_winner_and_no_dropped_events() {
        let path = std::env::temp_dir().join(format!("flufy-lead-race-{}.sqlite",super::super::domain::id()));
        {
            let mut db = Connection::open(&path).unwrap(); migrate(&mut db).unwrap();
            let tx = db.transaction().unwrap(); bind(&tx,"ses","chat","C:/repo",1).unwrap(); tx.commit().unwrap();
            event(&mut db,"event",Some(1));
        }
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = (0..2).map(|_| {
            let path = path.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut db = Connection::open(path).unwrap();
                db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
                barrier.wait();
                claim(&mut db,"chat",2).unwrap()
            })
        }).collect();
        let results: Vec<_> = threads.into_iter().map(|thread|thread.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|result|result.is_some()).count(),1);
        {
            let db = Connection::open(&path).unwrap();
            assert_eq!(current(&db,"chat").unwrap().unwrap().event_ids.len(),1);
        }
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn unsupported_schema_is_not_overwritten() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE team_lead_schema(version INTEGER NOT NULL); INSERT INTO team_lead_schema VALUES(99);").unwrap();
        assert!(migrate(&mut db).unwrap_err().contains("UNSUPPORTED"));
        assert_eq!(db.query_row("SELECT version FROM team_lead_schema",[],|r|r.get::<_,i64>(0)).unwrap(),99);
    }
    #[test]
    fn a_user_message_keeps_its_client_id_and_is_not_fused_with_other_events() {
        let mut db = database();
        let tx = db.transaction().unwrap();
        enqueue(&tx, "chat", "user-command", "user.message_received", &json!({"messageId":"msg_client","text":"Hola"}), Some(50), 5).unwrap();
        enqueue(&tx, "chat", "run-command", "run.completed", &json!({"summary":"listo"}), Some(40), 5).unwrap();
        tx.commit().unwrap();
        let turn = claim(&mut db, "chat", 6).unwrap().unwrap();
        assert_eq!(turn.prompt_message_id, "msg_client");
        assert_eq!(turn.event_ids.len(), 1, "the user message travels alone so its optimistic bubble matches");
        dispatching(&db, &turn.turn_id).unwrap();
        let tx = db.transaction().unwrap();
        complete(&tx, "chat", &turn.turn_id, 7).unwrap();
        tx.commit().unwrap();
        assert_eq!(claim(&mut db, "chat", 8).unwrap().unwrap().event_ids.len(), 1);
    }
    fn notice(db: &mut Connection, command: &str, task: &str) -> Receipt {
        let tx = db.transaction().unwrap();
        let receipt = enqueue(&tx, "chat", command, "run.attention", &json!({
            "runId": "r1", "taskId": task, "status": "blocked", "error": "timeout",
        }), super::super::lead_policy::priority("run.attention"), 2).unwrap();
        tx.commit().unwrap();
        receipt
    }
    fn finish_turn(db: &mut Connection, at: i64) {
        let turn = claim(db, "chat", at).unwrap().unwrap();
        dispatching(db, &turn.turn_id).unwrap();
        let tx = db.transaction().unwrap();
        complete(&tx, "chat", &turn.turn_id, at + 1).unwrap();
        tx.commit().unwrap();
    }
    #[test]
    fn repeated_notices_wait_before_another_wake_and_new_information_releases() {
        let mut db = database();
        notice(&mut db, "n1", "T1");
        finish_turn(&mut db, 1_000);
        notice(&mut db, "n2", "T1");
        finish_turn(&mut db, 2_000);
        notice(&mut db, "n3", "T1");
        assert!(claim(&mut db, "chat", 3_000).unwrap().is_none(), "the third identical wake waits");
        finish_turn(&mut db, 17_000);
        notice(&mut db, "n4", "T2");
        assert!(claim(&mut db, "chat", 17_100).unwrap().is_some(), "a different task is materially new information");
    }
    #[test]
    fn a_pending_user_message_always_wakes_and_clears_the_brake() {
        let mut db = database();
        notice(&mut db, "n1", "T1");
        finish_turn(&mut db, 1_000);
        notice(&mut db, "n2", "T1");
        finish_turn(&mut db, 2_000);
        notice(&mut db, "n3", "T1");
        assert!(claim(&mut db, "chat", 3_000).unwrap().is_none());
        let tx = db.transaction().unwrap();
        enqueue(&tx, "chat", "user", "user.message_received", &json!({"messageId":"msg_1","text":"Seguí"}), Some(50), 3_100).unwrap();
        tx.commit().unwrap();
        let turn = claim(&mut db, "chat", 3_100).unwrap().unwrap();
        assert_eq!(turn.prompt_message_id, "msg_1");
        assert_eq!(turn.event_ids.len(), 1, "the user message is dispatched alone");
        let exists: Option<String> = db.query_row("SELECT chat_id FROM team_lead_guard WHERE chat_id='chat'", [], |r| r.get(0)).optional().unwrap();
        assert!(exists.is_none(), "the user instruction releases the brake");
    }
}
