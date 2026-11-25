use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BotCapabilities {
    pub desktop: bool,
    pub files: bool,
    pub terminal: bool,
}

impl BotCapabilities {
    fn defaults() -> Self {
        BotCapabilities { desktop: false, files: true, terminal: true }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub role: String,
    pub instructions: String,
    pub model: Option<crate::routines::ModelRef>,
    pub fallback_model: Option<crate::routines::ModelRef>,
    pub autonomy: String,
    pub capabilities: BotCapabilities,
    pub enabled: bool,
    pub control: String,
    pub color: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Default for Bot {
    fn default() -> Self {
        let now = now_ms();
        Bot {
            id: String::new(),
            name: String::new(),
            role: String::new(),
            instructions: String::new(),
            model: None,
            fallback_model: None,
            autonomy: "alta".into(),
            capabilities: BotCapabilities::defaults(),
            enabled: true,
            control: "playing".into(),
            color: None,
            created_at: now,
            updated_at: now,
        }
    }
}

fn now_ms() -> i64 {
    chrono::Local::now().timestamp_millis()
}

fn bots_dir(app: &AppHandle) -> PathBuf {
    crate::memory::agent_root(app).join("bots")
}

fn bot_path(app: &AppHandle, id: &str) -> PathBuf {
    bots_dir(app).join(format!("{}.json", id))
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    for ch in name.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() { out.push(ch) }
        else if (ch == ' ' || ch == '-' || ch == '_') && !out.ends_with('-') { out.push('-') }
    }
    out.trim_matches('-').chars().take(48).collect()
}

fn load_one(path: &PathBuf) -> Option<Bot> {
    let raw = std::fs::read_to_string(path).ok()?;
    let had_control = serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value.get("control").map(|control| control.is_string()))
        .unwrap_or(false);
    let mut bot: Bot = serde_json::from_str(&raw).ok()?;
    if bot.id.trim().is_empty() || bot.name.trim().is_empty() { return None; }
    // Migración de nombre: el bot principal se llamaba "Mi Flufy".
    if bot.id == "flufy" && bot.name.trim() == "Mi Flufy" {
        bot.name = "Flufy Bots".into();
    }
    if !had_control || !["playing", "paused", "off"].contains(&bot.control.as_str()) {
        bot.control = if bot.enabled { "playing".into() } else { "off".into() };
    }
    bot.enabled = bot.control != "off";
    Some(bot)
}

pub fn control_of(app: &AppHandle, id: Option<&str>) -> String {
    get(app, id).map(|bot| bot.control).unwrap_or_else(|| "playing".into())
}

fn valid_control(value: &str) -> bool {
    matches!(value, "playing" | "paused" | "off")
}

pub fn set_control(app: &AppHandle, id: &str, control: &str) -> Result<Bot, String> {
    if !valid_control(control) {
        return Err("El control del bot debe ser playing, paused u off.".into());
    }
    let mut bot = get(app, Some(id)).ok_or("No existe ese bot.")?;
    bot.control = control.to_string();
    bot.enabled = control != "off";
    bot.updated_at = now_ms();
    std::fs::create_dir_all(bots_dir(app)).map_err(|e| e.to_string())?;
    crate::memory::atomic_write(&bot_path(app, &bot.id), &serde_json::to_string_pretty(&bot).map_err(|e| e.to_string())?)?;
    emit_changed(app);
    Ok(bot)
}

fn default_bot() -> Bot {
    let mut bot = Bot::default();
    bot.id = "flufy".into();
    bot.name = "Flufy Bots".into();
    bot.role = "Agente principal".into();
    bot
}

fn ensure_default(app: &AppHandle) -> Result<(), String> {
    let dir = bots_dir(app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let has = std::fs::read_dir(&dir)
        .map(|entries| entries.filter_map(|e| e.ok()).any(|e| e.path().extension().is_some_and(|ext| ext == "json")))
        .unwrap_or(false);
    if !has {
        crate::memory::atomic_write(&bot_path(app, "flufy"), &serde_json::to_string_pretty(&default_bot()).map_err(|e| e.to_string())?)?;
    }
    Ok(())
}

pub fn list(app: &AppHandle) -> Vec<Bot> {
    let _ = ensure_default(app);
    let mut bots = std::fs::read_dir(bots_dir(app))
        .map(|entries| entries.filter_map(|e| e.ok()).filter_map(|e| load_one(&e.path())).collect::<Vec<_>>())
        .unwrap_or_default();
    bots.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    bots
}

pub fn get(app: &AppHandle, id: Option<&str>) -> Option<Bot> {
    let id = id.unwrap_or("flufy");
    list(app).into_iter().find(|bot| bot.id == id)
}

pub fn get_or_default(app: &AppHandle, id: Option<&str>) -> Bot {
    get(app, id).or_else(|| get(app, Some("flufy"))).unwrap_or_else(default_bot)
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit("agent://bots-changed", json!({}));
}

pub fn save(app: &AppHandle, input: &Value) -> Result<Bot, String> {
    let existing = input["id"].as_str().and_then(|id| get(app, Some(id)));
    let name = input["name"].as_str().map(str::trim).filter(|name| !name.is_empty()).ok_or("El bot necesita un nombre.")?;
    let id = match input["id"].as_str().map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => id.to_string(),
        None => {
            let base = slug(name);
            if base.is_empty() { return Err("No pude generar un id para el bot.".into()); }
            let mut candidate = base.clone();
            let mut index = 2;
            while bot_path(app, &candidate).exists() {
                candidate = format!("{}-{}", base, index);
                index += 1;
            }
            candidate
        }
    };
    let now = now_ms();
    let mut bot = existing.unwrap_or_else(|| Bot { id: id.clone(), created_at: now, updated_at: now, ..Bot::default() });
    bot.id = id;
    bot.name = name.chars().take(80).collect();
    bot.role = input["role"].as_str().unwrap_or("").chars().take(120).collect();
    bot.instructions = input["instructions"].as_str().unwrap_or("").chars().take(6000).collect();
    bot.autonomy = if input["autonomy"].as_str() == Some("manual") { "manual".into() } else { "alta".into() };
    let requested_control = input["control"].as_str().filter(|value| valid_control(value));
    bot.control = requested_control
        .map(str::to_string)
        .unwrap_or_else(|| {
            if input["enabled"].as_bool().unwrap_or(true) { "playing".into() } else { "off".into() }
        });
    bot.enabled = bot.control != "off";
    bot.color = input["color"].as_str().map(|value| value.chars().take(32).collect());
    if let Some(model) = input.get("model") {
        if model.is_null() {
            bot.model = None;
        } else if model.is_object() {
            let provider = model["providerID"].as_str().unwrap_or("");
            let model_id = model["modelID"].as_str().unwrap_or("");
            bot.model = if provider.is_empty() || model_id.is_empty() { None } else { Some(crate::routines::ModelRef { provider_id: provider.into(), model_id: model_id.into() }) };
        }
    }
    if let Some(model) = input.get("fallbackModel") {
        if model.is_null() {
            bot.fallback_model = None;
        } else if model.is_object() {
            let provider = model["providerID"].as_str().unwrap_or("");
            let model_id = model["modelID"].as_str().unwrap_or("");
            bot.fallback_model = if provider.is_empty() || model_id.is_empty() { None } else { Some(crate::routines::ModelRef { provider_id: provider.into(), model_id: model_id.into() }) };
        }
    }
    if let Some(caps) = input.get("capabilities").filter(|value| value.is_object()) {
        bot.capabilities = BotCapabilities {
            desktop: caps["desktop"].as_bool().unwrap_or(false),
            files: caps["files"].as_bool().unwrap_or(true),
            terminal: caps["terminal"].as_bool().unwrap_or(true),
        };
    }
    bot.updated_at = now;
    std::fs::create_dir_all(bots_dir(app)).map_err(|e| e.to_string())?;
    crate::memory::atomic_write(&bot_path(app, &bot.id), &serde_json::to_string_pretty(&bot).map_err(|e| e.to_string())?)?;
    emit_changed(app);
    let _ = crate::agent::missions::apply_bot_control(app, &bot.id, &bot.control);
    Ok(bot)
}

#[tauri::command]
pub fn agent_bots_list(app: AppHandle) -> Vec<Bot> {
    list(&app)
}

#[tauri::command]
pub fn agent_bot_save(app: AppHandle, bot: Value) -> Result<Bot, String> {
    save(&app, &bot)
}

#[tauri::command]
pub fn agent_bot_get(app: AppHandle, id: String) -> Option<Bot> {
    get(&app, Some(&id))
}

#[tauri::command]
pub fn agent_bot_control(app: AppHandle, id: String, action: String) -> Result<Bot, String> {
    let control = match action.as_str() {
        "play" | "resume" => "playing",
        "pause" => "paused",
        "off" | "stop" => "off",
        other => return Err(format!("Acción de bot desconocida: {other}")),
    };
    let bot = set_control(&app, &id, control)?;
    crate::agent::missions::apply_bot_control(&app, &id, control)?;
    Ok(bot)
}

#[allow(dead_code)]
pub fn bot_prompt(app: &AppHandle, id: Option<&str>) -> String {
    let bot = get_or_default(app, id);
    if bot.instructions.trim().is_empty() {
        format!("## Bot\nNombre: {}\nRol: {}\n", bot.name, bot.role)
    } else {
        format!("## Bot\nNombre: {}\nRol: {}\nInstrucciones del bot:\n{}\n", bot.name, bot.role, bot.instructions)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_is_stable_and_safe() {
        assert_eq!(slug("Revisor de calidad"), "revisor-de-calidad");
        assert_eq!(slug("  Flufy Bots!  "), "flufy-bots");
    }
}
