use crate::agent::missions::Mission;
use crate::memory;
use serde_json::Value;
use std::process::Command;
use tauri::AppHandle;

fn config(app: &AppHandle) -> Option<Value> {
    let path = memory::agent_root(app).join("fluws.json");
    serde_json::from_str::<Value>(&std::fs::read_to_string(path).ok()?).ok()
}

/// Registro durable y opcional en fluws. Nunca bloquea ni falla la misión.
pub fn mission_event(app: &AppHandle, mission: &Mission, event: &str, detail: &str) {
    let Some(config) = config(app) else { return };
    if !config["enabled"].as_bool().unwrap_or(false) {
        return;
    }
    let script = config["script"].as_str().unwrap_or_default().trim().to_string();
    if script.is_empty() {
        return;
    }
    let cli = config["cli"].as_str().unwrap_or("node").to_string();
    let agent = config["agent"].as_str().unwrap_or("opencode").trim().to_string();
    let project = config["project"].as_str().unwrap_or("flufy").trim().to_string();
    let name = format!("{}/mision-{}", project, mission.id);
    let body = format!(
        "# Misión: {}\n\n- id: {}\n- estado: {}\n- evento: {}\n- actualizado: {}\n\n{}\n",
        mission.title, mission.id, mission.status, event, chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ"), detail
    );
    std::thread::spawn(move || {
        let path = std::env::temp_dir().join(format!("fluws-mision-{}.md", uuid::Uuid::new_v4()));
        if std::fs::write(&path, body.as_bytes()).is_err() {
            return;
        }
        let output = Command::new(cli)
            .arg(&script)
            .arg("write")
            .arg("--agent")
            .arg(&agent)
            .arg("--name")
            .arg(name)
            .arg("--body-file")
            .arg(&path)
            .output();
        let _ = std::fs::remove_file(&path);
        match output {
            Ok(result) if result.status.success() => {}
            Ok(result) => log::warn!("[fluws] {}", String::from_utf8_lossy(&result.stderr).chars().take(300).collect::<String>()),
            Err(error) => log::warn!("[fluws] no pude ejecutar {}: {}", script, error),
        }
    });
}
