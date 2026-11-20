pub mod absence;
pub mod fluws;
pub mod guard;
pub mod inbox;
pub mod missions;
pub mod playbooks;
pub mod pulse;

pub fn hub_state(app: &tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({
        "missions": missions::list(app),
        "absence": absence::status(app),
        "inbox": inbox::list(app, false),
        "profile": crate::memory::profile_get(app),
    })
}
