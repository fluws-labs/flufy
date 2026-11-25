use crate::{app_data_file, ensure_server, oc::Opencode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const CONFIG_FILE: &str = "memory-config.json";
const SCOPES_FILE: &str = "scopes.json";
const DIGEST_MAX: usize = 7000;
const BODY_MAX: usize = 200_000;
const FIELD_MAX: usize = 4_000;
const CHECKPOINT_MESSAGES: usize = 120;
const CHECKPOINT_FILES: usize = 16;
const CHECKPOINT_COMMANDS: usize = 8;
const CHECKPOINT_ARTIFACTS: usize = 8;
const CHECKPOINT_SUMMARY_MAX: usize = 1600;
const NOTE_STALE_DAYS: i64 = 180;
const SCOPES_MAX: usize = 200;
pub const PROFILE_MAX: usize = 8_000;
pub const LOG_TEXT_MAX: usize = 4_000;
pub const LOG_KINDS: &[&str] = &["decision", "done", "blocked", "learned", "blocked-guard"];
const LOG_RETENTION_DAYS: i64 = 365;
static LOG_LOCK: Mutex<()> = Mutex::new(());

const AGENT_PROFILE_DEFAULT: &str = "# Flufy Bots\n\nSos el agente personal del usuario en esta PC. Editá este perfil para definir el tono, el idioma y en qué trabaja.\n\n## Guía\n\n- \n";

const AGENT_STATE_DEFAULT: &str = "{\n  \"version\": 1,\n  \"firstRun\": true,\n  \"pulse\": {\n    \"enabled\": false,\n    \"quietHours\": { \"from\": \"22:00\", \"to\": \"08:00\" },\n    \"maxPerDay\": 4\n  }\n}\n";

pub fn instructions() -> &'static str {
    INSTRUCTIONS
}

const INSTRUCTIONS: &str = "Memoria local de Flufy: conocimiento y trabajos compartidos entre chats, ventanas y modelos, guardados solo en esta PC. Usá `memory_search` para encontrar decisiones, convenciones o intentos fallidos antes de asumir: por defecto busca en el proyecto actual y `scope:\"*\"` busca en todos. `memory_list` lista notas y trabajos; `memory_read` lee el detalle; `memory_write` deja una decisión durable (no changelog) y acepta `supersedes` con los ids de las notas que reemplaza, que dejan de inyectarse. `memory_delete` borra una nota. Si no sabés el `scope`, omitilo: se usa el proyecto de la ventana principal. Cada conversación guarda un checkpoint con objetivo, plan, archivos y resumen; la memoria se inyecta sola al empezar cada turno.";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MemoryConfig {
    pub root: Option<String>,
    pub sessions: BTreeMap<String, bool>,
}

pub struct MemoryState {
    config: Mutex<MemoryConfig>,
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app_data_file(app, CONFIG_FILE)
}

fn load(app: &AppHandle) -> MemoryConfig {
    config_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, config: &MemoryConfig) {
    if let Some(path) = config_path(app) {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(path, serde_json::to_string_pretty(config).unwrap_or_default());
    }
}

pub fn root(app: &AppHandle) -> PathBuf {
    let configured = app.state::<MemoryState>().config.lock().unwrap().root.clone();
    match configured.filter(|s| !s.trim().is_empty()) {
        Some(path) => PathBuf::from(path),
        None => app_data_file(app, "memory").unwrap_or_else(|| PathBuf::from("memory")),
    }
}

pub fn agent_root(app: &AppHandle) -> PathBuf {
    root(app).join("agent")
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", rest));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

fn normalize_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    // En Windows canonicalize devuelve `//?/C:/...`; el plugin no ve ese prefijo.
    let text = text.strip_prefix("//?/").or_else(|| text.strip_prefix("//./")).unwrap_or(&text);
    text.trim_end_matches('/').to_lowercase()
}

fn sha_hex(value: &str, bytes: usize) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hasher.finalize().iter().take(bytes).map(|byte| format!("{:02x}", byte)).collect()
}

fn hash8(value: &str) -> String {
    sha_hex(value, 4)
}

/// Un worktree comparte la memoria del proyecto principal: su `.git` es un
/// archivo que apunta a `<principal>/.git/worktrees/<nombre>`.
fn worktree_main_root(dir: &Path) -> Option<PathBuf> {
    let dot = dir.join(".git");
    if !dot.is_file() {
        return None;
    }
    let text = fs::read_to_string(&dot).ok()?;
    let gitdir = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("gitdir:").map(str::trim))?;
    let gitdir = PathBuf::from(gitdir);
    let gitdir = if gitdir.is_absolute() { gitdir } else { dir.join(gitdir) };
    let normalized = gitdir.to_string_lossy().replace('\\', "/");
    let marker = normalized.to_ascii_lowercase().find("/.git/worktrees/")?;
    let root = normalized[..marker].trim_end_matches('/');
    if root.is_empty() {
        return None;
    }
    let root = PathBuf::from(root);
    Some(strip_verbatim(fs::canonicalize(&root).unwrap_or(root)))
}

/// Raíz estable para la memoria de un proyecto. Mapea subcarpetas y worktrees
/// al repositorio principal, en lugar de usar el último segmento de la ruta.
pub fn project_root(directory: &str) -> PathBuf {
    if directory.trim().is_empty() {
        return PathBuf::new();
    }
    let dir = strip_verbatim(fs::canonicalize(directory).unwrap_or_else(|_| PathBuf::from(directory)));
    let mut candidate = dir.as_path();
    for _ in 0..6 {
        let dot = candidate.join(".git");
        if dot.is_dir() {
            return strip_verbatim(candidate.to_path_buf());
        }
        if dot.is_file() {
            return worktree_main_root(candidate).unwrap_or_else(|| strip_verbatim(candidate.to_path_buf()));
        }
        let Some(parent) = candidate.parent() else { break };
        candidate = parent;
    }
    dir
}

fn read_scope_root(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join("_scope.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value["root"].as_str().map(|root| root.to_string()))
}

fn workspace_name_at(workspaces: &Path, project: &Path) -> String {
    let base = {
        let path = project.to_string_lossy();
        slug(&path)
    };
    let needle = normalize_path(project);
    let direct = workspaces.join(&base);
    if !direct.exists() {
        // Reclamar la carpeta desde el inicio evita que otro proyecto con el
        // mismo nombre la adopte después como si fuera legacy.
        let _ = write_text(&direct.join("_scope.json"), &json!({ "root": needle, "updated": now() }).to_string());
        return base;
    }
    match read_scope_root(&direct) {
        Some(existing) if existing == needle => return base,
        // Carpeta legacy sin marcador: se adopta una vez. Si otro proyecto con
        // el mismo nombre ya la reclamó, el marcador evita mezclar memorias.
        None => {
            let _ = write_text(&direct.join("_scope.json"), &json!({ "root": needle, "updated": now() }).to_string());
            return base;
        }
        _ => {}
    }
    let mut hashed = format!("{}-{}", base, hash8(&needle));
    let mut hashed_dir = workspaces.join(&hashed);
    if hashed_dir.exists() {
        match read_scope_root(&hashed_dir) {
            Some(existing) if existing == needle => return hashed,
            None => {}
            Some(_) => {
                hashed = format!("{}-{}", base, sha_hex(&needle, 8));
                hashed_dir = workspaces.join(&hashed);
                if hashed_dir.exists() {
                    if read_scope_root(&hashed_dir).as_deref() == Some(needle.as_str()) {
                        return hashed;
                    }
                }
            }
        }
    }
    let _ = write_text(&hashed_dir.join("_scope.json"), &json!({ "root": needle, "updated": now() }).to_string());
    hashed
}

fn workspace_name(app: &AppHandle, project: &Path) -> String {
    workspace_name_at(&root(app).join("workspaces"), project)
}

pub(crate) fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "agent".to_string());
    let tmp = path.with_file_name(format!(".{}.{}.tmp", name, uuid::Uuid::new_v4()));
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&tmp);
            Err(error.to_string())
        }
    }
}

fn ensure_agent(app: &AppHandle) {
    let agent = agent_root(app);
    for dir in [agent.clone(), agent.join("log"), agent.join("inbox")] {
        let _ = fs::create_dir_all(&dir);
    }
    let profile = agent.join("profile.md");
    if !profile.exists() {
        let _ = atomic_write(&profile, AGENT_PROFILE_DEFAULT);
    }
    let state = agent.join("state.json");
    if !state.exists() {
        let _ = atomic_write(&state, AGENT_STATE_DEFAULT);
    }
    let log = agent.join("log").join("log.ndjson");
    if !log.exists() {
        let _ = atomic_write(&log, "");
    }
    let _ = prune_log(&log);
    crate::agent::playbooks::ensure_defaults(app);
}
pub fn agent_state(app: &AppHandle) -> Value {
    fs::read_to_string(agent_root(app).join("state.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| serde_json::from_str(AGENT_STATE_DEFAULT).unwrap_or(Value::Null))
}

pub(crate) fn save_agent_state(app: &AppHandle, state: &Value) -> Result<(), String> {
    atomic_write(&agent_root(app).join("state.json"), &serde_json::to_string_pretty(state).map_err(|e| e.to_string())?)
}

fn profile_text(app: &AppHandle) -> String {
    let path = agent_root(app).join("profile.md");
    let mut text = read_text(&path);
    if text.trim_start().starts_with("# Mi Flufy") {
        text = text.replacen("# Mi Flufy", "# Flufy Bots", 1);
        let _ = atomic_write(&path, &text);
    }
    text
}

pub fn first_run(app: &AppHandle) -> bool {
    agent_state(app)["firstRun"].as_bool().unwrap_or(true)
}

pub fn profile_get(app: &AppHandle) -> Value {
    let state = agent_state(app);
    json!({ "profile": profile_text(app), "firstRun": first_run(app), "pulse": state["pulse"].clone() })
}

pub fn profile_set(app: &AppHandle, profile: &str) -> Result<Value, String> {
    if profile.chars().count() > PROFILE_MAX {
        return Err(format!("El perfil no puede superar los {} caracteres.", PROFILE_MAX));
    }
    atomic_write(&agent_root(app).join("profile.md"), profile)?;
    let mut state = agent_state(app);
    state["firstRun"] = json!(false);
    state["updated"] = json!(now());
    save_agent_state(app, &state)?;
    Ok(json!({ "ok": true }))
}

pub fn log_path(app: &AppHandle) -> PathBuf {
    agent_root(app).join("log").join("log.ndjson")
}

pub fn log_append(app: &AppHandle, kind: &str, text: &str, session: Option<&str>, project: Option<&str>) -> Result<Value, String> {
    let kind = if kind.trim().is_empty() { "done" } else { kind.trim() };
    if !LOG_KINDS.contains(&kind) {
        return Err(format!("kind inválido: {} (usá decision, done, blocked, learned o blocked-guard)", kind));
    }
    let text: String = text.trim().chars().take(LOG_TEXT_MAX).collect();
    if text.is_empty() {
        return Err("Falta el texto de la entrada.".into());
    }
    let _guard = LOG_LOCK.lock().unwrap();
    let entry = log_entry(kind, &text, session, project);
    let path = log_path(app);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    prune_log(&path)?;
    let mut content = fs::read_to_string(&path).unwrap_or_default();
    content.push_str(&entry.to_string());
    content.push('\n');
    atomic_write(&path, &content)?;
    Ok(entry)
}

fn log_entry(kind: &str, text: &str, session: Option<&str>, project: Option<&str>) -> Value {
    json!({
        "at": now(),
        "kind": kind,
        "text": text,
        "session": session.map(|s| s.trim()).filter(|s| !s.is_empty()),
        "project": project.map(|p| p.trim()).filter(|p| !p.is_empty()),
    })
}

fn retained_log_line(line: &str) -> bool {
    if line.trim().is_empty() {
        return false;
    }
    let Ok(value) = serde_json::from_str::<Value>(line) else { return true };
    let Some(at) = value["at"].as_str() else { return true };
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(at) else { return true };
    parsed.with_timezone(&chrono::Utc) >= chrono::Utc::now() - chrono::Duration::days(LOG_RETENTION_DAYS)
}

fn prune_log(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let kept: Vec<&str> = content.lines().filter(|line| retained_log_line(line)).collect();
    let next = if kept.is_empty() { String::new() } else { format!("{}\n", kept.join("\n")) };
    if next != content {
        atomic_write(path, &next)?;
    }
    Ok(())
}
pub fn log_entries(app: &AppHandle, limit: usize) -> Vec<Value> {
    let all: Vec<Value> = fs::read_to_string(log_path(app))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value["text"].as_str().is_some_and(|text| !text.trim().is_empty()))
        .collect();
    let skip = all.len().saturating_sub(limit);
    all.into_iter().skip(skip).collect()
}

pub fn start(app: &AppHandle) {
    let config = load(app);
    let root = config
        .root
        .clone()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| app_data_file(app, "memory").unwrap_or_else(|| PathBuf::from("memory")));
    for dir in [root.clone(), root.join("global"), root.join("workspaces")] {
        let _ = fs::create_dir_all(&dir);
    }
    let prefs = root.join("global").join("_preferences.md");
    if !prefs.exists() {
        let _ = fs::write(&prefs, "# Preferencias personales\n\n- (escribí acá las convenciones o preferencias que valgan para todos los proyectos)\n");
    }
    app.manage(MemoryState { config: Mutex::new(config) });
    ensure_agent(app);
}

pub fn plugin_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app_data_file(app, "memory-plugin")?;
    fs::create_dir_all(&dir).ok()?;
    let path = dir.join("guillecode-memory.js");
    let _ = fs::write(&path, include_str!("memory_plugin.js"));
    Some(path)
}

pub fn extend_config(app: &AppHandle, config: &mut Value) {
    let Some(plugin) = plugin_file(app) else { return };
    let url = format!("file://{}", plugin.to_string_lossy().replace('\\', "/"));
    let root = root(app).to_string_lossy().to_string();
    let agent = agent_root(app).to_string_lossy().to_string();
    let config_path = config_path(app).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let entry = json!([url, { "root": root, "config": config_path, "agent": agent }]);
    match config.get_mut("plugin") {
        Some(Value::Array(list)) => list.push(entry),
        _ => config["plugin"] = json!([entry]),
    }
}

fn collapse(value: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in value.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn slug(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    let base = normalized.trim_end_matches('/').rsplit('/').next().unwrap_or("workspace");
    let trimmed = collapse(base);
    if trimmed.is_empty() { "workspace".to_string() } else { trimmed }
}

fn default_scope(app: &AppHandle) -> String {
    ensure_server(app)
        .map(|c| project_root(&c.worktree).to_string_lossy().to_string())
        .unwrap_or_default()
}

fn scopes_path(app: &AppHandle) -> PathBuf {
    root(app).join(SCOPES_FILE)
}

/// Registro raíz de proyecto → carpeta de workspace. El plugin del motor lo usa
/// para resolver worktrees sin duplicar la detección de `.git` en JavaScript.
fn remember_scope(app: &AppHandle, project: &Path, workspace: &str) {
    let path = scopes_path(app);
    let mut map: BTreeMap<String, Value> = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let key = normalize_path(project);
    let entry = json!({ "workspace": workspace, "updated": now() });
    if map.get(&key) == Some(&entry) {
        return;
    }
    map.insert(key, entry);
    while map.len() > SCOPES_MAX {
        let Some(oldest) = map
            .iter()
            .min_by(|a, b| a.1["updated"].as_str().unwrap_or("").cmp(b.1["updated"].as_str().unwrap_or("")))
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        map.remove(&oldest);
    }
    let _ = write_text(&path, &serde_json::to_string_pretty(&map).unwrap_or_default());
}

fn workspace_roots(app: &AppHandle) -> Vec<String> {
    let mut roots: Vec<String> = fs::read_to_string(scopes_path(app))
        .ok()
        .and_then(|text| serde_json::from_str::<BTreeMap<String, Value>>(&text).ok())
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default();
    if let Ok(entries) = fs::read_dir(root(app).join("workspaces")) {
        for entry in entries.flatten() {
            if let Some(root) = read_scope_root(&entry.path()) {
                roots.push(root);
            }
        }
    }
    roots.sort();
    roots.dedup();
    roots
}

fn workspace_dir(app: &AppHandle, scope: &str) -> PathBuf {
    let project = project_root(scope);
    root(app).join("workspaces").join(workspace_name(app, &project))
}

fn notes_dir(app: &AppHandle, scope: &str) -> PathBuf {
    workspace_dir(app, scope).join("notes")
}

fn tasks_dir(app: &AppHandle, scope: &str) -> PathBuf {
    workspace_dir(app, scope).join("tasks")
}

fn ensure_workspace(app: &AppHandle, scope: &str) {
    let project = project_root(scope);
    let workspace = workspace_name(app, &project);
    remember_scope(app, &project, &workspace);
    let dir = root(app).join("workspaces").join(&workspace);
    let _ = fs::create_dir_all(dir.join("notes"));
    let _ = fs::create_dir_all(dir.join("tasks"));
    let overview = dir.join("_overview.md");
    if !overview.exists() {
        let name = workspace.clone();
        let _ = fs::write(&overview, format!("# {}\n\n- (qué es este proyecto, arquitectura y convenciones que el agente debe saber)\n", name));
    }
}

fn read_text(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn write_text(path: &Path, content: &str) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(path, content);
}

fn frontmatter(body: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(rest) = body.strip_prefix("---") else { return out };
    let Some(end) = rest.find("\n---") else { return out };
    for line in rest[..end].lines() {
        if let Some((key, value)) = line.split_once(':') {
            out.insert(key.trim().to_lowercase(), value.trim().trim_matches('"').to_string());
        }
    }
    out
}

fn first_line(body: &str) -> String {
    body.lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty() && !l.starts_with("---") && !l.contains(':') && !l.starts_with('#'))
        .or_else(|| body.lines().map(|l| l.trim().trim_start_matches('#').trim()).find(|l| !l.is_empty()))
        .unwrap_or_default()
        .chars()
        .take(140)
        .collect()
}

fn body_of(body: &str) -> String {
    match body.find("\n---") {
        Some(index) => body[index + 4..].trim().to_string(),
        None => body.trim().to_string(),
    }
}

fn note_slug(title: &str) -> String {
    let trimmed = collapse(title);
    if trimmed.is_empty() { format!("nota-{}", chrono::Utc::now().timestamp()) } else { trimmed }
}

fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub fn session_enabled(app: &AppHandle, session: &str) -> bool {
    if session.is_empty() {
        return true;
    }
    // Integration hosts may build a Tauri app without the memory plugin.
    let Some(state) = app.try_state::<MemoryState>() else { return true };
    let config = state.config.lock().unwrap();
    config.sessions.get(session).copied().unwrap_or(true)
}

pub fn set_session(app: &AppHandle, session: &str, enabled: bool) {
    if session.is_empty() {
        return;
    }
    // Integration hosts may build a Tauri app without the memory plugin.
    let Some(state) = app.try_state::<MemoryState>() else { return };
    let mut config = state.config.lock().unwrap();
    if enabled {
        config.sessions.remove(session);
    } else {
        config.sessions.insert(session.to_string(), false);
    }
    save(app, &config);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteView {
    id: String,
    title: String,
    kind: String,
    updated: String,
    preview: String,
    source: String,
    status: String,
    stale: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskView {
    id: String,
    title: String,
    updated: String,
    directory: String,
    progress: String,
    last_user: String,
    source: String,
    summary: String,
    next: String,
    compacted: bool,
}

fn note_is_stale(updated: &str) -> bool {
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(updated) else { return false };
    parsed.with_timezone(&chrono::Utc) < chrono::Utc::now() - chrono::Duration::days(NOTE_STALE_DAYS)
}

fn note_views(app: &AppHandle, scope: &str) -> Vec<NoteView> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(notes_dir(app, scope)) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let content = read_text(&path);
        let meta = frontmatter(&content);
        let status = meta.get("status").cloned().unwrap_or_else(|| "active".to_string());
        let updated = meta.get("updated").cloned().unwrap_or_default();
        out.push(NoteView {
            id: path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            title: meta.get("title").cloned().unwrap_or_else(|| first_line(&content)),
            kind: meta.get("type").cloned().unwrap_or_else(|| "nota".to_string()),
            preview: first_line(&body_of(&content)),
            source: meta.get("source").cloned().unwrap_or_else(|| "agent".to_string()),
            stale: status == "active" && note_is_stale(&updated),
            status,
            updated,
        });
    }
    out.sort_by(|a, b| {
        let a_inactive = a.status != "active";
        let b_inactive = b.status != "active";
        a_inactive.cmp(&b_inactive).then_with(|| b.updated.cmp(&a.updated))
    });
    out
}

fn task_views(app: &AppHandle, scope: &str) -> Vec<TaskView> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(tasks_dir(app, scope)) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
        let progress: String = value["progress"].as_str().unwrap_or_default().chars().take(300).collect();
        out.push(TaskView {
            id: value["id"].as_str().unwrap_or_default().to_string(),
            title: value["title"].as_str().unwrap_or_default().to_string(),
            updated: value["updatedAt"].as_str().unwrap_or_default().to_string(),
            directory: value["directory"].as_str().unwrap_or_default().to_string(),
            summary: value["summary"].as_str().map(|summary| summary.chars().take(300).collect()).unwrap_or_else(|| progress.clone()),
            next: value["next"].as_str().unwrap_or_default().to_string(),
            compacted: value["compacted"].as_bool().unwrap_or(false),
            progress,
            last_user: value["lastUser"].as_str().unwrap_or_default().to_string(),
            source: value["source"].as_str().unwrap_or("agent").to_string(),
        });
    }
    out.sort_by(|a, b| b.updated.cmp(&a.updated));
    out
}

fn render_digest(app: &AppHandle, scope: &str) {
    let prefs = read_text(&root(app).join("global").join("_preferences.md"));
    let overview = read_text(&workspace_dir(app, scope).join("_overview.md"));
    let notes: Vec<NoteView> = note_views(app, scope).into_iter().filter(|note| note.status == "active").collect();
    let tasks = task_views(app, scope);
    let prefs_body = body_of(&prefs);
    let overview_body = body_of(&overview);
    let path = workspace_dir(app, scope).join("_digest.md");
    if prefs_body.is_empty() && overview_body.is_empty() && notes.is_empty() && tasks.is_empty() {
        let _ = fs::remove_file(&path);
        return;
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push("# Memoria local de Flufy".into());
    lines.push(String::new());
    lines.push(format!("- **Proyecto:** {} (workspace `{}`)", scope, slug(scope)));
    lines.push(String::new());
    if !prefs_body.is_empty() {
        lines.push("## Preferencias".into());
        lines.push(prefs_body.chars().take(1200).collect());
        lines.push(String::new());
    }
    if !overview_body.is_empty() {
        lines.push(format!("## Proyecto {}", slug(scope)));
        lines.push(overview_body.chars().take(1500).collect());
        lines.push(String::new());
    }
    if !tasks.is_empty() {
        lines.push("## Trabajos recientes".into());
        for task in tasks.iter().take(10) {
            let mut line = format!("- **{}** (act. {})", if task.title.is_empty() { &task.id } else { &task.title }, task.updated);
            if !task.progress.is_empty() {
                line.push_str(&format!(" — {}", task.progress.replace('\n', " ")));
            }
            lines.push(line);
        }
        lines.push(String::new());
    }
    if !notes.is_empty() {
        lines.push("## Notas y decisiones".into());
        for note in notes.iter().take(12) {
            let stale = if note.stale { " [revisar]" } else { "" };
            lines.push(format!("- **{}** ({}) - {}{}", note.title, note.kind, note.preview, stale));
        }
        lines.push(String::new());
    }
    lines.push("Usá `memory_search`, `memory_list` y `memory_read` para el detalle; `memory_write` para dejar una decisión durable y `supersedes` para retirar la que reemplaza.".into());

    let digest = truncate_chars(&lines.join("\n"), DIGEST_MAX);
    write_text(&path, &digest);
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value.chars().take(max).collect()
}

fn extract_text(parts: &Value) -> String {
    extract_text_with(parts, false)
}

fn extract_text_all(parts: &Value) -> String {
    extract_text_with(parts, true)
}

fn extract_text_with(parts: &Value, include_synthetic: bool) -> String {
    parts
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|p| p["type"] == "text" && (include_synthetic || p["synthetic"] != true))
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
        .trim()
        .chars()
        .take(FIELD_MAX)
        .collect()
}

fn add_unique(list: &mut Vec<String>, value: &str, max: usize) {
    let value = value.trim();
    if value.is_empty() || list.len() >= max || list.iter().any(|item| item == value) {
        return;
    }
    list.push(value.chars().take(400).collect());
}

fn first_line_of(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .chars()
        .take(240)
        .collect()
}

fn input_path(input: &Value) -> Option<String> {
    ["filePath", "path", "file", "filename"]
        .iter()
        .find_map(|key| input[*key].as_str().filter(|value| !value.trim().is_empty()).map(|value| value.trim().to_string()))
}

fn patch_paths(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            ["*** Update File:", "*** Add File:", "*** Move to:", "*** Delete File:"]
                .iter()
                .find_map(|prefix| line.strip_prefix(prefix).map(|rest| rest.trim().to_string()))
                .filter(|path| !path.is_empty())
        })
        .collect()
}

fn url_list(text: &str) -> Vec<String> {
    let Ok(regex) = regex::Regex::new(r"https?://[^\s)<>\]]+") else { return Vec::new() };
    regex
        .find_iter(text)
        .map(|found| found.as_str().trim_end_matches([',', '.', ';', ':']).to_string())
        .collect()
}

/// Checkpoint determinista de una conversación: no hace otra llamada al modelo.
/// Si el motor compactó el historial, conserva ese resumen como contexto durable.
pub fn checkpoint_from_messages(title: &str, messages: &Value, todos: &Value) -> Value {
    let mut first_user = String::new();
    let mut last_user = String::new();
    let mut last_assistant = String::new();
    let mut compaction_summary = String::new();
    let mut compacted_at: Option<String> = None;
    let mut turns = 0u64;
    let mut files: Vec<String> = Vec::new();
    let mut commands: Vec<Value> = Vec::new();
    let mut artifacts: Vec<String> = Vec::new();

    for message in messages.as_array().into_iter().flatten() {
        let role = message["info"]["role"].as_str().unwrap_or("");
        let summary = message["info"]["summary"].as_bool().unwrap_or(false);
        let text = if summary { extract_text_all(&message["parts"]) } else { extract_text(&message["parts"]) };
        if role == "user" && !text.is_empty() {
            turns += 1;
            if first_user.is_empty() {
                first_user = text.clone();
            }
            last_user = text;
        } else if role == "assistant" && !text.is_empty() {
            for url in url_list(&text) {
                add_unique(&mut artifacts, &url, CHECKPOINT_ARTIFACTS);
            }
            if summary {
                compaction_summary = text;
                compacted_at = message["info"]["time"]["completed"].as_i64().and_then(|ms| {
                    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
                        .map(|date| date.format("%Y-%m-%dT%H:%M:%SZ").to_string())
                });
            } else {
                last_assistant = text;
            }
        }
        for part in message["parts"].as_array().into_iter().flatten() {
            if part["type"] == "file" {
                if let Some(name) = part["filename"].as_str() {
                    add_unique(&mut files, name, CHECKPOINT_FILES);
                }
            }
            if part["type"] != "tool" {
                continue;
            }
            let tool = part["tool"].as_str().unwrap_or("");
            let input = &part["state"]["input"];
            if matches!(tool, "edit" | "write" | "apply_patch" | "patch") {
                if let Some(path) = input_path(input) {
                    add_unique(&mut files, &path, CHECKPOINT_FILES);
                }
                if tool == "apply_patch" {
                    if let Some(patch) = input["patchText"].as_str() {
                        for path in patch_paths(patch) {
                            add_unique(&mut files, &path, CHECKPOINT_FILES);
                        }
                    }
                }
            }
            if matches!(tool, "bash" | "terminal_run") {
                let command = input["command"].as_str().unwrap_or("").trim();
                if !command.is_empty() {
                    commands.push(json!({
                        "command": command.chars().take(240).collect::<String>(),
                        "ok": part["state"]["status"].as_str() != Some("error"),
                    }));
                    if commands.len() > CHECKPOINT_COMMANDS {
                        commands.remove(0);
                    }
                }
            }
        }
    }

    let mut plan: Vec<Value> = Vec::new();
    let mut done: Vec<String> = Vec::new();
    for todo in todos.as_array().into_iter().flatten() {
        let content = todo["content"].as_str().unwrap_or("").trim();
        if content.is_empty() {
            continue;
        }
        let status = todo["status"].as_str().unwrap_or("pending");
        plan.push(json!({ "content": content, "status": status }));
        if status == "completed" {
            done.push(content.to_string());
        }
    }
    let next = plan
        .iter()
        .find(|step| step["status"] == "in_progress")
        .or_else(|| plan.iter().find(|step| step["status"] == "pending"))
        .and_then(|step| step["content"].as_str())
        .unwrap_or("")
        .to_string();

    let objective = first_line_of(&last_user);
    let mut summary = String::new();
    if !objective.is_empty() {
        summary.push_str(&format!("Objetivo: {}\n", objective));
    }
    if !done.is_empty() {
        summary.push_str(&format!("Hecho: {}\n", truncate_chars(&done.join("; "), 500)));
    } else if !last_assistant.is_empty() {
        summary.push_str(&format!("Hecho: {}\n", truncate_chars(&first_line_of(&last_assistant), 400)));
    }
    if !next.is_empty() {
        summary.push_str(&format!("Próximo: {}\n", next));
    }
    if !files.is_empty() {
        summary.push_str(&format!("Archivos: {}\n", files.join(", ")));
    }
    if !compaction_summary.is_empty() {
        summary.push_str(&format!("\nContexto compactado:\n{}", truncate_chars(&compaction_summary, 900)));
    }
    let summary = truncate_chars(summary.trim(), CHECKPOINT_SUMMARY_MAX);

    json!({
        "schema": 2,
        "title": title,
        "objective": objective,
        "openedWith": truncate_chars(&first_user, 600),
        "lastUser": truncate_chars(&last_user, FIELD_MAX),
        "lastAssistant": truncate_chars(&last_assistant, FIELD_MAX),
        "progress": summary,
        "summary": summary,
        "next": next,
        "plan": plan,
        "done": done,
        "files": files,
        "commands": commands,
        "artifacts": artifacts,
        "turns": turns,
        "compacted": !compaction_summary.is_empty(),
        "compactedAt": compacted_at,
    })
}

pub fn capture(app: &AppHandle, session: &str) {
    if session.is_empty() || !session_enabled(app, session) {
        return;
    }
    let Ok(server) = ensure_server(app) else { return };
    let directory = server.worktree.clone();
    let client = Opencode::new(&server, &directory);
    let Ok(info) = client.get(&format!("/session/{}", session)) else { return };
    if info["parentID"].is_string() {
        return;
    }
    let session_dir = info["directory"]
        .as_str()
        .filter(|value| !value.is_empty())
        .unwrap_or(&directory)
        .to_string();
    if session_dir.is_empty() {
        return;
    }
    let title = info["title"].as_str().unwrap_or("").to_string();
    if title.starts_with("guillecode\u{00b7}") {
        return;
    }
    let project = project_root(&session_dir);
    if project.as_os_str().is_empty() {
        return;
    }
    let workspace = workspace_name(app, &project);
    remember_scope(app, &project, &workspace);
    let scope = project.to_string_lossy().to_string();
    let messages = client
        .get(&format!("/session/{}/message?limit={}", session, CHECKPOINT_MESSAGES))
        .unwrap_or(Value::Null);
    if !messages.is_array() {
        return;
    }
    let todos = client.get(&format!("/session/{}/todo", session)).unwrap_or(Value::Null);
    let mut checkpoint = checkpoint_from_messages(&title, &messages, &todos);
    if checkpoint["lastUser"].as_str().unwrap_or("").is_empty()
        && checkpoint["lastAssistant"].as_str().unwrap_or("").is_empty()
    {
        return;
    }
    checkpoint["id"] = json!(session);
    checkpoint["directory"] = json!(session_dir);
    checkpoint["project"] = json!(scope.clone());
    checkpoint["projectName"] = json!(slug(&scope));
    checkpoint["updatedAt"] = json!(now());
    checkpoint["source"] = json!("agent");
    ensure_workspace(app, &scope);
    write_text(
        &tasks_dir(app, &scope).join(format!("{}.json", slug(session))),
        &serde_json::to_string_pretty(&checkpoint).unwrap_or_default(),
    );
    render_digest(app, &scope);
}

fn walk_md(dir: &Path, limit: usize, out: &mut Vec<PathBuf>) {
    if out.len() >= limit {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_md(&path, limit, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            out.push(path);
            if out.len() >= limit {
                return;
            }
        }
    }
}

fn relative(app: &AppHandle, path: &Path) -> String {
    path.strip_prefix(root(app)).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| path.to_string_lossy().to_string())
}

fn search(app: &AppHandle, query: &str, scope: &str) -> Value {
    let tokens: Vec<String> = query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| token.len() >= 2)
        .map(|token| token.to_string())
        .collect();
    if tokens.is_empty() {
        return json!({ "results": [] });
    }
    let mut files = Vec::new();
    if scope.trim().is_empty() || scope.trim() == "*" {
        walk_md(&root(app), 400, &mut files);
    } else {
        walk_md(&workspace_dir(app, scope), 200, &mut files);
        walk_md(&root(app).join("global"), 40, &mut files);
    }
    let mut scored: Vec<(usize, String, String, String, bool)> = Vec::new();
    for path in files {
        let content = read_text(&path);
        let meta = frontmatter(&content);
        let status = meta.get("status").cloned().unwrap_or_else(|| "active".to_string());
        if status != "active" {
            continue;
        }
        let title = meta.get("title").cloned().unwrap_or_else(|| first_line(&content));
        let lower = content.to_lowercase();
        let lower_title = title.to_lowercase();
        let mut score = 0usize;
        for token in &tokens {
            score += lower.matches(token.as_str()).count();
            score += lower_title.matches(token.as_str()).count() * 4;
        }
        if score == 0 {
            continue;
        }
        let snippet: String = content
            .lines()
            .find(|line| tokens.iter().any(|token| line.to_lowercase().contains(token)))
            .unwrap_or("")
            .trim()
            .chars()
            .take(200)
            .collect();
        let updated = meta.get("updated").cloned().unwrap_or_default();
        let stale = note_is_stale(&updated);
        scored.push((score, relative(app, &path), title, snippet, stale));
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    let results: Vec<Value> = scored
        .into_iter()
        .take(20)
        .map(|(score, path, title, snippet, stale)| {
            json!({ "path": path, "title": title, "snippet": snippet, "score": score, "stale": stale })
        })
        .collect();
    json!({ "results": results, "scope": scope })
}

fn read_entry(app: &AppHandle, id: &str) -> Value {
    let resolved = resolve(app, id);
    match resolved {
        Some(path) if path.exists() => json!({ "path": relative(app, &path), "content": read_text(&path) }),
        _ => json!({ "error": "no existe" }),
    }
}

fn walk_files(dir: &Path, limit: usize, out: &mut Vec<PathBuf>) {
    if out.len() >= limit {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, limit, out);
        } else if matches!(path.extension().and_then(|e| e.to_str()), Some("md" | "json")) {
            out.push(path);
            if out.len() >= limit {
                return;
            }
        }
    }
}

fn resolve(app: &AppHandle, id: &str) -> Option<PathBuf> {
    let root = root(app);
    let normalized = id.replace('\\', "/");
    let trimmed = normalized.trim_start_matches('/');
    if trimmed.is_empty() || trimmed.contains(':') {
        return None;
    }
    let direct = root.join(trimmed);
    if direct.is_file() && inside(&root, &direct) {
        return Some(direct);
    }
    if !trimmed.contains("..") {
        let rel = trimmed.to_lowercase();
        let mut files = Vec::new();
        walk_files(&root, 600, &mut files);
        for path in files {
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            if stem == rel || relative(app, &path).to_lowercase() == rel {
                return Some(path);
            }
        }
    }
    None
}

fn resolve_note(app: &AppHandle, id: &str) -> Option<PathBuf> {
    resolve(app, id).filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
}

/// Comprueba que un archivo existente quede dentro de la raíz (resuelve `..` y symlinks).
fn inside(root: &Path, candidate: &Path) -> bool {
    match (fs::canonicalize(candidate), fs::canonicalize(root)) {
        (Ok(real), Ok(real_root)) => real.starts_with(real_root),
        _ => false,
    }
}

/// Las ediciones de la UI se resuelven en su colección, nunca por un id global ambiguo.
fn existing_memory_file(dir: &Path, id: &str, extension: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains(['/', '\\', ':']) || matches!(id, "." | "..") {
        return Err("Id de memoria inválido".into());
    }
    let path = dir.join(format!("{}.{}", id, extension));
    if !path.is_file() || !inside(dir, &path) {
        return Err("No existe esta entrada de memoria en el proyecto".into());
    }
    Ok(path)
}

fn write_memory_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

fn normalize_title(value: &str) -> String {
    value.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn note_file(dir: &Path, title: &str, id: Option<&str>) -> Result<PathBuf, String> {
    match id {
        Some(id) => existing_memory_file(dir, id, "md"),
        None => {
            let id = note_slug(title);
            let path = dir.join(format!("{}.md", id));
            if !path.exists() {
                return Ok(path);
            }
            let existing = frontmatter(&read_text(&path));
            let same_title = existing
                .get("title")
                .map(|current| normalize_title(current) == normalize_title(title))
                .unwrap_or(false);
            if same_title {
                return existing_memory_file(dir, &id, "md");
            }
            // Dos títulos distintos que colapsan al mismo slug no deben pisarse.
            Ok(dir.join(format!("{}-{}.md", id, hash8(&normalize_title(title)))))
        }
    }
}

fn rewrite_frontmatter(content: &str, updates: &[(&str, String)]) -> String {
    let Some(rest) = content.strip_prefix("---") else { return content.to_string() };
    let Some(end) = rest.find("\n---") else { return content.to_string() };
    let header = rest[..end].trim_matches('\n');
    let body = &rest[end + 4..];
    let keys: Vec<&str> = updates.iter().map(|(key, _)| *key).collect();
    let mut lines: Vec<String> = header
        .lines()
        .filter(|line| {
            line.split_once(':')
                .map(|(key, _)| !keys.contains(&key.trim().to_lowercase().as_str()))
                .unwrap_or(true)
        })
        .map(|line| line.to_string())
        .collect();
    for (key, value) in updates {
        lines.push(format!("{}: {}", key, value.replace(['\n', '\r'], " ")));
    }
    format!("---\n{}\n---{}", lines.join("\n"), body)
}

fn supersede_note(path: &Path, new_id: &str) -> Result<(), String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let next = rewrite_frontmatter(
        &content,
        &[
            ("status", "superseded".to_string()),
            ("superseded_by", new_id.to_string()),
            ("updated", now()),
        ],
    );
    atomic_write(path, &next)
}

fn task_file(app: &AppHandle, scope: &str, id: &str) -> Result<(PathBuf, Value), String> {
    let path = existing_memory_file(&tasks_dir(app, scope), &slug(id), "json")?;
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if value["id"].as_str() != Some(id) {
        return Err("El id del trabajo no coincide con el estado guardado".into());
    }
    Ok((path, value))
}

pub fn tool_list() -> Vec<Value> {
    vec![
        json!({
            "name": "search",
            "description": "Busca en la memoria local de Flufy. Por defecto busca en el proyecto actual; usá scope:\"*\" para buscar en todos los proyectos.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "scope": { "type": "string", "description": "Carpeta del proyecto; '*' para todos" }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "list",
            "description": "Lista las notas y trabajos de la memoria del proyecto.",
            "inputSchema": { "type": "object", "properties": { "scope": { "type": "string", "description": "Carpeta del proyecto; si falta, la de la ventana principal" } } }
        }),
        json!({
            "name": "read",
            "description": "Lee el contenido completo de una nota o trabajo por su id o ruta relativa.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
        }),
        json!({
            "name": "write",
            "description": "Guarda una nota durable (decisión, convención, gotcha o intento fallido). No uses esto para changelog.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "body": { "type": "string" },
                    "kind": { "type": "string", "enum": ["decision", "convencion", "gotcha", "failure", "nota"] },
                    "scope": { "type": "string" },
                    "supersedes": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Ids de notas que esta nota reemplaza; dejan de inyectarse"
                    }
                },
                "required": ["title", "body"]
            }
        }),
        json!({
            "name": "delete",
            "description": "Elimina una nota de la memoria por su id.",
            "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] }
        }),
    ]
}

pub fn call_tool(app: &AppHandle, name: &str, args: &Value) -> Value {
    let text = |value: Value| json!({ "content": [{ "type": "text", "text": value.as_str().map(|s| s.to_string()).unwrap_or_else(|| value.to_string()) }] });
    match name {
        "search" => {
            let query = args["query"].as_str().unwrap_or("");
            if query.trim().is_empty() {
                return json!({ "content": [{ "type": "text", "text": "Falta el parámetro query." }], "isError": true });
            }
            let scope = args["scope"].as_str().map(|s| s.to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| default_scope(app));
            text(search(app, query, &scope))
        }
        "list" => {
            let scope = args["scope"].as_str().map(|s| s.to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| default_scope(app));
            let notes = note_views(app, &scope);
            let tasks = task_views(app, &scope);
            text(json!({
                "scope": scope,
                "notes": notes.iter().map(|n| json!({ "id": n.id, "title": n.title, "kind": n.kind, "updated": n.updated, "preview": n.preview, "status": n.status, "stale": n.stale })).collect::<Vec<_>>(),
                "tasks": tasks.iter().map(|t| json!({ "id": t.id, "title": t.title, "updated": t.updated, "next": t.next, "compacted": t.compacted })).collect::<Vec<_>>(),
            }))
        }
        "read" => text(read_entry(app, args["id"].as_str().unwrap_or(""))),
        "write" => {
            let title = args["title"].as_str().unwrap_or("").trim();
            if title.is_empty() {
                return json!({ "content": [{ "type": "text", "text": "Falta title." }], "isError": true });
            }
            let title: String = title.replace(['\n', '\r'], " ");
            let scope = args["scope"].as_str().map(|s| s.to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| default_scope(app));
            let kind = args["kind"].as_str().unwrap_or("nota").replace(['\n', '\r'], " ");
            let body = args["body"].as_str().unwrap_or("");
            ensure_workspace(app, &scope);
            let path = match note_file(&notes_dir(app, &scope), &title, None) {
                Ok(path) => path,
                Err(error) => return json!({ "content": [{ "type": "text", "text": error }], "isError": true }),
            };
            let id = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
            let content = format!("---\ntitle: {}\ntype: {}\nupdated: {}\nsource: agent\nstatus: active\n---\n\n{}\n", title, kind, now(), truncate_chars(body, BODY_MAX));
            write_text(&path, &content);
            let mut superseded: Vec<String> = Vec::new();
            for old in args["supersedes"].as_array().into_iter().flatten().filter_map(|value| value.as_str()) {
                if let Ok(old_path) = existing_memory_file(&notes_dir(app, &scope), old.trim(), "md") {
                    if supersede_note(&old_path, &id).is_ok() {
                        superseded.push(old.trim().to_string());
                    }
                }
            }
            render_digest(app, &scope);
            text(json!({ "ok": true, "id": id, "scope": scope, "superseded": superseded }))
        }
        "delete" => {
            let id = args["id"].as_str().unwrap_or("");
            match resolve_note(app, id) {
                Some(path) if path.exists() => {
                    let _ = fs::remove_file(&path);
                    for scope in workspace_roots(app) {
                        render_digest(app, &scope);
                    }
                    text(json!({ "ok": true }))
                }
                _ => json!({ "content": [{ "type": "text", "text": "No existe esa nota (solo se pueden borrar notas, no trabajos)." }], "isError": true }),
            }
        }
        other => json!({ "content": [{ "type": "text", "text": format!("Herramienta desconocida: {}", other) }], "isError": true }),
    }
}

fn scopes(app: &AppHandle) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root(app).join("workspaces")) else { return out };
    for entry in entries.flatten() {
        if entry.path().is_dir() {
            if let Some(name) = entry.file_name().to_str() {
                out.push(name.to_string());
            }
        }
    }
    out
}

// ---- Tauri commands ----

#[tauri::command]
pub fn memory_status(app: AppHandle) -> Value {
    let root = root(&app);
    let scopes = scopes(&app);
    let sessions = app.state::<MemoryState>().config.lock().unwrap().sessions.clone();
    json!({ "root": root.to_string_lossy(), "scopes": scopes, "sessions": sessions })
}

pub fn overview(app: &AppHandle, scope: &str) -> Value {
    let scope = if scope.trim().is_empty() { default_scope(app) } else { scope.to_string() };
    let project = project_root(&scope);
    let workspace = workspace_name(app, &project);
    remember_scope(app, &project, &workspace);
    let notes = note_views(app, &scope);
    let tasks = task_views(app, &scope);
    let prefs = read_text(&root(app).join("global").join("_preferences.md"));
    json!({
        "scope": scope,
        "slug": workspace,
        "preferences": body_of(&prefs),
        "overview": body_of(&read_text(&workspace_dir(app, &scope).join("_overview.md"))),
        "notes": notes.iter().map(|n| json!({ "id": n.id, "title": n.title, "kind": n.kind, "updated": n.updated, "preview": n.preview, "source": n.source, "status": n.status, "stale": n.stale })).collect::<Vec<_>>(),
        "tasks": tasks.iter().map(|t| json!({ "id": t.id, "title": t.title, "updated": t.updated, "directory": t.directory, "progress": t.progress, "summary": t.summary, "next": t.next, "compacted": t.compacted, "lastUser": t.last_user, "source": t.source })).collect::<Vec<_>>(),
    })
}

pub fn hub_state(app: &AppHandle, scope: &str, session: &str) -> Value {
    let mut value = overview(app, scope);
    value["enabled"] = json!(session_enabled(app, session));
    value
}

#[tauri::command]
pub fn memory_overview(app: AppHandle, scope: String) -> Value {
    overview(&app, &scope)
}

#[tauri::command]
pub fn memory_write_note(app: AppHandle, scope: String, title: String, body: String, kind: Option<String>, id: Option<String>) -> Result<Value, String> {
    let scope = if scope.trim().is_empty() { default_scope(&app) } else { scope };
    if title.trim().is_empty() {
        return Err("Falta el título".into());
    }
    let kind = kind.unwrap_or_else(|| "nota".to_string()).replace(['\n', '\r'], " ");
    let title = title.trim().replace(['\n', '\r'], " ");
    let dir = notes_dir(&app, &scope);
    let path = note_file(&dir, &title, id.as_deref())?;
    let id = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    ensure_workspace(&app, &scope);
    let content = format!("---\ntitle: {}\ntype: {}\nupdated: {}\nsource: user\nstatus: active\n---\n\n{}\n", title.trim(), kind, now(), body.chars().take(BODY_MAX).collect::<String>());
    write_memory_file(&path, &content)?;
    render_digest(&app, &scope);
    Ok(json!({ "ok": true, "id": id }))
}

#[tauri::command]
pub fn memory_write_overview(app: AppHandle, scope: String, body: String) -> Result<Value, String> {
    let scope = if scope.trim().is_empty() { default_scope(&app) } else { scope };
    ensure_workspace(&app, &scope);
    let content = if body.trim().is_empty() { String::new() } else { format!("# {}\n\n{}\n", workspace_name(&app, &project_root(&scope)), body) };
    write_memory_file(&workspace_dir(&app, &scope).join("_overview.md"), &content)?;
    render_digest(&app, &scope);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn memory_write_preferences(app: AppHandle, body: String) -> Result<Value, String> {
    let content = if body.trim().is_empty() { String::new() } else { format!("# Preferencias personales\n\n{}\n", body) };
    write_memory_file(&root(&app).join("global").join("_preferences.md"), &content)?;
    for scope in workspace_roots(&app) {
        render_digest(&app, &scope);
    }
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn memory_read_note(app: AppHandle, id: String) -> Value {
    read_entry(&app, &id)
}

#[tauri::command]
pub fn memory_delete_note(app: AppHandle, id: String) -> Result<Value, String> {
    match resolve_note(&app, &id) {
        Some(path) if path.exists() => {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
            for scope in workspace_roots(&app) {
                render_digest(&app, &scope);
            }
            Ok(json!({ "ok": true }))
        }
        _ => Err("No existe o no es una nota".into()),
    }
}

#[tauri::command]
pub fn memory_write_task(app: AppHandle, scope: String, id: String, title: String, last_user: String, progress: String) -> Result<Value, String> {
    let scope = if scope.trim().is_empty() { default_scope(&app) } else { scope };
    let (path, mut value) = task_file(&app, &scope, &id)?;
    let changed = value["progress"].as_str() != Some(progress.as_str());
    value["title"] = json!(truncate_chars(&title, FIELD_MAX));
    value["lastUser"] = json!(truncate_chars(&last_user, BODY_MAX));
    value["progress"] = json!(truncate_chars(&progress, BODY_MAX));
    if changed {
        // La edición del usuario reemplaza el estado y el resumen compactado.
        value["summary"] = json!(truncate_chars(&progress, BODY_MAX));
        value["compacted"] = json!(false);
        value["compactedAt"] = Value::Null;
    }
    value["updatedAt"] = json!(now());
    value["source"] = json!("user");
    write_memory_file(&path, &serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?)?;
    render_digest(&app, &scope);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn memory_delete_task(app: AppHandle, scope: String, id: String) -> Result<Value, String> {
    let scope = if scope.trim().is_empty() { default_scope(&app) } else { scope };
    let (path, _) = task_file(&app, &scope, &id)?;
    fs::remove_file(&path).map_err(|e| e.to_string())?;
    render_digest(&app, &scope);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn memory_search_cmd(app: AppHandle, query: String, scope: Option<String>) -> Value {
    let scope = scope.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| default_scope(&app));
    search(&app, &query, &scope)
}

#[tauri::command]
pub fn memory_set_session(app: AppHandle, session: String, enabled: bool) -> Value {
    set_session(&app, &session, enabled);
    json!({ "ok": true, "enabled": enabled })
}

#[tauri::command]
pub fn memory_session_enabled(app: AppHandle, session: String) -> bool {
    session_enabled(&app, &session)
}

#[tauri::command]
pub fn agent_profile_get(app: AppHandle) -> Value {
    profile_get(&app)
}

#[tauri::command]
pub fn agent_profile_set(app: AppHandle, profile: String) -> Result<Value, String> {
    profile_set(&app, &profile)
}

#[tauri::command]
pub fn agent_log_list(app: AppHandle, limit: Option<usize>) -> Value {
    let limit = limit.unwrap_or(50).clamp(1, 200);
    json!({ "entries": log_entries(&app, limit) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_normalizes_directories() {
        assert_eq!(slug("C:\\\\Users\\\\guill\\\\proyecto"), "proyecto");
        assert_eq!(slug("/home/guill/Mi Proyecto/"), "mi-proyecto");
        assert_eq!(slug(""), "workspace");
    }

    #[test]
    fn note_slug_is_stable() {
        assert_eq!(note_slug("Decisión: base de datos"), "decisi-n-base-de-datos");
        assert!(note_slug("!!").starts_with("nota-"));
    }

    #[test]
    fn frontmatter_reads_fields() {
        let body = "---\ntitle: Hola\ntype: decision\nupdated: 2026-01-01\n---\n\ncuerpo";
        let meta = frontmatter(body);
        assert_eq!(meta.get("title").unwrap(), "Hola");
        assert_eq!(body_of(body), "cuerpo");
    }

    #[test]
    fn inside_rejects_escapes() {
        let base = std::env::temp_dir().join(format!("gc-memory-test-{}", std::process::id()));
        let root = base.join("memory");
        let notes = root.join("workspaces/demo/notes");
        fs::create_dir_all(&notes).unwrap();
        let note = notes.join("a.md");
        fs::write(&note, "x").unwrap();
        let secret = base.join("secret.txt");
        fs::write(&secret, "x").unwrap();
        assert!(inside(&root, &note));
        assert!(!inside(&root, &secret));
        assert!(!inside(&root, &root.join("..").join("secret.txt")));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn edits_keep_note_identity_and_stay_in_the_selected_project() {
        let base = std::env::temp_dir().join(format!("gc-memory-edit-test-{}", uuid::Uuid::new_v4()));
        let notes = base.join("demo/notes");
        let other = base.join("other/notes");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(notes.join("original.md"), "nota original").unwrap();
        fs::write(other.join("solo-otro.md"), "nota de otro proyecto").unwrap();
        assert_eq!(note_file(&notes, "Título nuevo", Some("original")).unwrap(), notes.join("original.md"));
        assert!(note_file(&notes, "Título nuevo", Some("solo-otro")).is_err());
        assert!(note_file(&notes, "Título nuevo", Some("../other/notes/solo-otro")).is_err());
        assert!(existing_memory_file(&notes, "C:\\otra-nota", "md").is_err());
        assert!(note_file(&notes, "original", Some("borrada")).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn log_entries_keep_project_and_prune_older_than_a_year() {
        let entry = log_entry("done", "listo", Some("ses-1"), Some("C:/proyecto"));
        assert_eq!(entry["kind"], "done");
        assert_eq!(entry["project"], "C:/proyecto");
        assert!(log_entry("done", "sin proyecto", None, None)["project"].is_null());

        let old = (chrono::Utc::now() - chrono::Duration::days(400))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string();
        let fresh = (chrono::Utc::now() - chrono::Duration::days(10))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string();
        let content = format!(
            "{{\"at\":\"{}\",\"text\":\"viejo\"}}\n{{\"at\":\"{}\",\"text\":\"nuevo\"}}\nlinea rota\n",
            old, fresh
        );
        let kept: Vec<&str> = content.lines().filter(|line| retained_log_line(line)).collect();
        assert!(!kept.iter().any(|line| line.contains("viejo")));
        assert!(kept.iter().any(|line| line.contains("nuevo")));
        assert!(kept.iter().any(|line| line.contains("linea rota")));
    }

    #[test]
    fn project_root_maps_worktrees_and_subfolders_to_the_main_repo() {
        let base = std::env::temp_dir().join(format!("gc-scope-{}", uuid::Uuid::new_v4()));
        let repo = base.join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let sub = repo.join("app").join("src");
        fs::create_dir_all(&sub).unwrap();
        assert_eq!(project_root(sub.to_str().unwrap()), strip_verbatim(fs::canonicalize(&repo).unwrap()));

        let worktree = base.join("worktree");
        fs::create_dir_all(&worktree).unwrap();
        let gitdir = repo.join(".git").join("worktrees").join("wt");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.to_string_lossy())).unwrap();
        assert_eq!(project_root(worktree.to_str().unwrap()), strip_verbatim(fs::canonicalize(&repo).unwrap()));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn normalize_path_drops_the_windows_verbatim_prefix() {
        assert_eq!(normalize_path(Path::new(r"\\?\C:\Demo\Repo")), "c:/demo/repo");
        assert_eq!(normalize_path(Path::new("/home/demo/Repo/")), "/home/demo/repo");
    }

    #[test]
    fn workspace_name_isolates_projects_that_share_a_folder_name() {
        let base = std::env::temp_dir().join(format!("gc-workspace-{}", uuid::Uuid::new_v4()));
        let workspaces = base.join("workspaces");
        let first = base.join("cliente-a").join("ui");
        let second = base.join("cliente-b").join("ui");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        assert_eq!(workspace_name_at(&workspaces, &first), "ui");
        fs::create_dir_all(workspaces.join("ui")).unwrap();
        fs::write(
            workspaces.join("ui").join("_scope.json"),
            json!({ "root": normalize_path(&first) }).to_string(),
        )
        .unwrap();
        assert_eq!(workspace_name_at(&workspaces, &first), "ui");
        let other = workspace_name_at(&workspaces, &second);
        assert_ne!(other, "ui");
        assert!(other.starts_with("ui-"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn distinct_titles_never_overwrite_each_other() {
        let base = std::env::temp_dir().join(format!("gc-note-dedup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        fs::write(
            base.join("decisi-n-base-de-datos.md"),
            "---\ntitle: Decisión base de datos\n---\n\nPostgreSQL",
        )
        .unwrap();
        let path = note_file(&base, "Decisión: base de datos!", None).unwrap();
        assert_ne!(path, base.join("decisi-n-base-de-datos.md"));
        assert!(path.file_stem().unwrap().to_string_lossy().starts_with("decisi-n-base-de-datos-"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn supersede_marks_the_old_note_and_keeps_its_body() {
        let base = std::env::temp_dir().join(format!("gc-note-supersede-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let path = base.join("vieja.md");
        fs::write(&path, "---\ntitle: Vieja\ntype: decision\nupdated: 2026-01-01\n---\n\nCuerpo original\n").unwrap();
        supersede_note(&path, "nueva").unwrap();
        let content = read_text(&path);
        let meta = frontmatter(&content);
        assert_eq!(meta.get("status").unwrap(), "superseded");
        assert_eq!(meta.get("superseded_by").unwrap(), "nueva");
        assert!(body_of(&content).contains("Cuerpo original"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn checkpoint_extracts_objective_plan_files_commands_and_compaction() {
        let messages = json!([
            {
                "info": { "role": "user" },
                "parts": [{ "type": "text", "text": "Implementá el login" }]
            },
            {
                "info": { "role": "assistant" },
                "parts": [
                    { "type": "text", "text": "Listo, probé el login y falta desplegar." },
                    { "type": "tool", "tool": "edit", "state": { "status": "completed", "input": { "filePath": "src/login.ts" } } },
                    { "type": "tool", "tool": "bash", "state": { "status": "completed", "input": { "command": "npm test" } } }
                ]
            },
            {
                "info": { "role": "assistant", "summary": true, "time": { "completed": 1700000000000i64 } },
                "parts": [{ "type": "text", "text": "Resumen compactado: se implementó el login." }]
            }
        ]);
        let todos = json!([
            { "content": "Implementar login", "status": "completed" },
            { "content": "Desplegar", "status": "pending" }
        ]);
        let checkpoint = checkpoint_from_messages("Login", &messages, &todos);
        assert_eq!(checkpoint["objective"], "Implementá el login");
        assert_eq!(checkpoint["next"], "Desplegar");
        assert_eq!(checkpoint["files"][0], "src/login.ts");
        assert_eq!(checkpoint["commands"][0]["command"], "npm test");
        assert_eq!(checkpoint["turns"], 1);
        assert!(checkpoint["compacted"].as_bool().unwrap());
        assert!(checkpoint["summary"].as_str().unwrap().contains("Contexto compactado"));
        assert!(checkpoint["summary"].as_str().unwrap().contains("se implementó el login"));
    }
}
