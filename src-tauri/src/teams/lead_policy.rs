//! Structured delivery policy for team events. The UI and the durable store are
//! updated by the domain mutation; this policy only decides whether an event
//! additionally needs a user notice or a Lead turn. No text heuristics.
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Delivery {
    /// Store/UI only. Never invokes the model.
    UiOnly,
    /// The existing question/notification flow surfaces it; the Lead is not woken.
    UserNotice,
    /// Queue a conversational Lead turn.
    LeadTurn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum EventClass {
    Activation,
    UserMessage,
    Progress,
    ArtifactPublished,
    TaskFinishedIndependent,
    DependencyUnlocked,
    UserQuestion,
    LeadCoordination,
    RecoverableFailure,
    BlockingFailure,
    ExpectedResponse,
    RunReadyToClose,
    TurnFailure,
}

/// Classifies by structured kind, never by message text.
pub(super) fn classify(kind: &str) -> EventClass {
    match kind {
        "team.activated" => EventClass::Activation,
        "user.message_received" => EventClass::UserMessage,
        "artifact.published" | "capture.published" | "evidence.captured" => EventClass::ArtifactPublished,
        "task.finished_independent" | "attempt.result_submitted" => EventClass::TaskFinishedIndependent,
        "dependency.unlocked" | "task.unblocked" => EventClass::DependencyUnlocked,
        "user.question" | "question.asked" => EventClass::UserQuestion,
        "coordination.requested" | "coordination.updated" | "lead.coordination" => EventClass::LeadCoordination,
        "attempt.recoverable" | "task.retry" => EventClass::RecoverableFailure,
        "run.attention" | "run.blocked" | "task.blocked" | "planning.blocked" => EventClass::BlockingFailure,
        "response.expected" => EventClass::ExpectedResponse,
        "run.completed" | "run.reconciled" => EventClass::RunReadyToClose,
        "lead.turn_failed" => EventClass::TurnFailure,
        _ => EventClass::Progress,
    }
}

pub(super) fn delivery(kind: &str) -> Delivery {
    match classify(kind) {
        EventClass::Activation
        | EventClass::UserMessage
        | EventClass::DependencyUnlocked
        | EventClass::LeadCoordination
        | EventClass::BlockingFailure
        | EventClass::ExpectedResponse
        | EventClass::RunReadyToClose => Delivery::LeadTurn,
        EventClass::UserQuestion => Delivery::UserNotice,
        EventClass::Progress
        | EventClass::ArtifactPublished
        | EventClass::TaskFinishedIndependent
        | EventClass::RecoverableFailure
        | EventClass::TurnFailure => Delivery::UiOnly,
    }
}

/// `None` records durable progress without waking the Lead. Only the classes
/// that require coordination get an inbox priority.
pub(super) fn priority(kind: &str) -> Option<i64> {
    match delivery(kind) {
        Delivery::LeadTurn => Some(match classify(kind) {
            EventClass::Activation => 100,
            EventClass::LeadCoordination => 60,
            EventClass::ExpectedResponse => 55,
            EventClass::UserMessage => 50,
            EventClass::BlockingFailure => 45,
            EventClass::RunReadyToClose => 40,
            EventClass::DependencyUnlocked => 35,
            _ => 40,
        }),
        Delivery::UiOnly | Delivery::UserNotice => None,
    }
}

/// Fingerprint of the material situation carried by one event. Deliberately
/// excludes timestamps, event IDs and message text so a repeated failure is
/// recognized as the same situation.
pub(super) fn situation(kind: &str, payload: &Value) -> String {
    let field = |name: &str| payload.get(name).and_then(Value::as_str).unwrap_or_default();
    let status = field("status");
    let error = field("error");
    let task = field("taskId");
    let run = field("runId");
    let task_title = field("title");
    format!("{kind}|run={run}|task={task}|title={task_title}|status={status}|error={error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn informational_events_never_wake_the_lead() {
        for kind in ["artifact.published", "capture.published", "evidence.captured", "attempt.result_submitted", "attempt.recoverable", "task.finished_independent", "lead.turn_failed", "task.progress"] {
            assert_eq!(delivery(kind), Delivery::UiOnly, "{kind}");
            assert_eq!(priority(kind), None, "{kind} must not enqueue a Lead turn");
        }
    }

    #[test]
    fn a_user_question_uses_its_own_flow_without_a_lead_turn() {
        assert_eq!(delivery("user.question"), Delivery::UserNotice);
        assert_eq!(priority("user.question"), None);
    }

    #[test]
    fn coordination_and_blockers_wake_the_lead() {
        for kind in ["team.activated", "user.message_received", "run.attention", "run.blocked", "run.completed", "run.reconciled", "coordination.requested", "dependency.unlocked"] {
            assert_eq!(delivery(kind), Delivery::LeadTurn, "{kind}");
            assert!(priority(kind).is_some(), "{kind}");
        }
    }

    #[test]
    fn the_situation_ignores_volatile_fields() {
        let first = situation("run.attention", &json!({"runId":"r1","taskId":"T1","status":"blocked","error":"timeout","createdAt":1}));
        let second = situation("run.attention", &json!({"runId":"r1","taskId":"T1","status":"blocked","error":"timeout","createdAt":999,"eventId":"x"}));
        assert_eq!(first, second);
        let other = situation("run.attention", &json!({"runId":"r1","taskId":"T2","status":"blocked","error":"timeout"}));
        assert_ne!(first, other);
    }
}
