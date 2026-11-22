//! Bridges the real Chrome (OpenCode Browse) into the `browser_*` tools.
//!
//! Browse is an MCP server plus a Chromium extension: it drives the user's own
//! Chrome, with their tabs, logins and extensions, and hands tabs back for
//! logins, 2FA and payments. Its model is "tabs are the handle", so this module
//! keeps the existing numeric `pageId` contract of the Chrome DevTools bridge
//! and maps it to the tab ids Browse returns.
//!
//! Only conversations that do not use the internal WebView2 browser (teams)
//! reach this module; `browser.rs` keeps the Chrome DevTools path for those.

use crate::proc::hide_console;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::Manager;

const CALL_TIMEOUT: Duration = Duration::from_secs(110);
const START_TIMEOUT: Duration = Duration::from_secs(30);
const INSTALL_HINT: &str = "Conexión con Chrome (Browse) no disponible. Instalá Browse desde https://opencode.ai/browse (CLI y extensión), pareá la extensión con tu Chrome y volvé a probar.";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BrowseStatus {
    pub available: bool,
    pub enabled: bool,
    pub running: bool,
    pub connected: Option<bool>,
    pub pairing: Option<String>,
    pub next_step: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

struct Inner {
    child: Option<Child>,
    tree: Option<crate::process_tree::ProcessTree>,
    stdin: Option<ChildStdin>,
    state: &'static str,
    error: Option<String>,
    generation: u64,
}

struct Client {
    inner: Mutex<Inner>,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    next: Mutex<u64>,
    starting: Mutex<()>,
}

fn client() -> &'static Arc<Client> {
    static CLIENT: OnceLock<Arc<Client>> = OnceLock::new();
    CLIENT.get_or_init(|| Arc::new(Client {
        inner: Mutex::new(Inner { child: None, tree: None, stdin: None, state: "off", error: None, generation: 0 }),
        pending: Arc::new(Mutex::new(HashMap::new())),
        next: Mutex::new(0),
        starting: Mutex::new(()),
    }))
}

fn exe_name() -> &'static str {
    if cfg!(windows) { "browse.exe" } else { "browse" }
}

fn binary(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(value) = std::env::var("FLUFY_BROWSE_BIN") {
        if !value.trim().is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }
    if let Some(app) = app {
        if let Ok(dir) = app.path().app_local_data_dir() {
            candidates.push(dir.join("browse").join(exe_name()));
        }
    }
    if cfg!(windows) {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            candidates.push(PathBuf::from(home).join(".local").join("bin").join(exe_name()));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join("Programs").join("browse").join(exe_name()));
        }
    } else {
        if let Some(home) = std::env::var_os("HOME") {
            candidates.push(PathBuf::from(home).join(".local").join("bin").join(exe_name()));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(exe_name())));
    }
    candidates.into_iter().find(|path| path.is_file())
}

pub fn available(app: &tauri::AppHandle) -> bool {
    binary(Some(app)).is_some()
}

/// Conversations that use the internal WebView2 browser, or teams, keep the
/// Chrome DevTools bridge: Browse cannot attach to WebView2 surfaces.
pub fn enabled(app: &tauri::AppHandle, workspace: &str) -> bool {
    let config = super::config(app);
    config.browser
        && config.browse
        && !workspace.is_empty()
        && !workspace.starts_with("team:")
        && workspace != "mission-own"
        && !super::internal_browser::selected(workspace)
        && available(app)
}

fn stop_process() {
    let current = client();
    let mut inner = current.inner.lock().unwrap();
    inner.generation += 1;
    inner.stdin = None;
    let tree = inner.tree.take();
    if let Some(mut child) = inner.child.take() {
        if let Some(tree) = tree { tree.terminate(); }
        let _ = child.kill();
        let _ = child.wait();
    }
    inner.state = "off";
    inner.error = None;
    current.pending.lock().unwrap().clear();
}

pub fn stop() {
    stop_process();
    sessions().lock().unwrap().clear();
}

fn send_line(message: &Value) -> Result<(), String> {
    let current = client();
    let mut inner = current.inner.lock().unwrap();
    let stdin = inner.stdin.as_mut().ok_or("la conexión con Browse no está corriendo")?;
    let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).map_err(|e| format!("no pude hablar con Browse: {}", e))
}

fn request(method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
    let current = client();
    let id = {
        let mut next = current.next.lock().unwrap();
        *next += 1;
        *next
    };
    let (tx, rx) = mpsc::channel();
    current.pending.lock().unwrap().insert(id, tx);
    if let Err(e) = send_line(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })) {
        current.pending.lock().unwrap().remove(&id);
        return Err(e);
    }
    let reply = rx.recv_timeout(timeout).map_err(|_| {
        current.pending.lock().unwrap().remove(&id);
        format!("Browse no respondió a {} a tiempo", method)
    })?;
    if let Some(error) = reply.get("error") {
        return Err(error["message"].as_str().unwrap_or("error de Browse").to_string());
    }
    Ok(reply["result"].clone())
}

fn launch() -> Result<(), String> {
    let path = binary(crate::proc::app()).ok_or_else(|| INSTALL_HINT.to_string())?;
    let current = client();
    let generation = {
        let mut inner = current.inner.lock().unwrap();
        inner.generation += 1;
        inner.state = "starting";
        inner.error = None;
        inner.generation
    };
    let mut cmd = Command::new(&path);
    cmd.arg("mcp")
        .env("OPENCODE_BROWSER_TOOLS", "plain")
        .env("OPENCODE_BROWSER_AUTO_UPDATE", "notify")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("no pude ejecutar Browse: {}", e))?;
    let tree = match crate::process_tree::ProcessTree::attach(child.id()) {
        Ok(tree) => tree,
        Err(e) => { let _ = child.kill(); let _ = child.wait(); return Err(e); }
    };
    let stdout = child.stdout.take().ok_or("sin stdout")?;
    let stderr = child.stderr.take().ok_or("sin stderr")?;
    let stdin = child.stdin.take().ok_or("sin stdin")?;
    {
        let mut inner = current.inner.lock().unwrap();
        if inner.generation != generation {
            tree.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err("se canceló el arranque de Browse".into());
        }
        inner.child = Some(child);
        inner.tree = Some(tree);
        inner.stdin = Some(stdin);
    }
    let pending = current.pending.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<Value>(line.trim()) else { continue };
            let Some(id) = message["id"].as_u64() else { continue };
            if message.get("result").is_none() && message.get("error").is_none() { continue; }
            if let Some(tx) = pending.lock().unwrap().remove(&id) {
                let _ = tx.send(message);
            }
        }
        let current = client();
        let mut inner = current.inner.lock().unwrap();
        if inner.generation == generation {
            inner.child = None;
            inner.stdin = None;
            inner.tree = None;
            if inner.state != "off" {
                inner.state = "error";
                inner.error.get_or_insert_with(|| "el proceso de Browse se cerró".into());
            }
        }
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            if !line.trim().is_empty() { log::info!("[browse] {}", line.trim()); }
        }
    });
    Ok(())
}

fn ensure() -> Result<(), String> {
    let current = client();
    {
        let inner = current.inner.lock().unwrap();
        if inner.child.is_some() {
            return Ok(());
        }
    }
    let _guard = current.starting.lock().unwrap();
    {
        let inner = current.inner.lock().unwrap();
        if inner.child.is_some() {
            return Ok(());
        }
    }
    launch()?;
    let initialized = request("initialize", json!({
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": { "name": "opencode", "version": env!("CARGO_PKG_VERSION") },
    }), START_TIMEOUT);
    match initialized {
        Ok(_) => {
            let mut inner = current.inner.lock().unwrap();
            inner.state = "ready";
            inner.error = None;
            Ok(())
        }
        Err(e) => {
            {
                let mut inner = current.inner.lock().unwrap();
                inner.state = "error";
                inner.error = Some(e.clone());
            }
            stop_process();
            Err(e)
        }
    }
}

fn call_tool(tool: &str, arguments: Value) -> Result<Value, String> {
    let mut retried = false;
    loop {
        ensure()?;
        let result = request("tools/call", json!({ "name": tool, "arguments": arguments.clone() }), CALL_TIMEOUT)?;
        if !result["isError"].as_bool().unwrap_or(false) {
            return Ok(result);
        }
        let message = text_of(&result);
        // Starting the relay can lose a race (another MCP instance, a port held
        // for a moment, or a transient Windows access denial). The call never
        // reached a page, so one clean restart is safe.
        if !retried && (message.contains("failed to start the browse relay") || message.contains("os error 5") || message.contains("Acceso denegado")) {
            retried = true;
            stop_process();
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }
        return Err(message);
    }
}

fn text_of(result: &Value) -> String {
    result["content"].as_array()
        .map(|items| items.iter().filter_map(|i| i["text"].as_str()).collect::<Vec<_>>().join("\n"))
        .unwrap_or_default()
}

fn result_text(text: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }] })
}

fn result_error(text: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }], "isError": true })
}

// --- per-conversation tabs -------------------------------------------------

#[derive(Default)]
struct SessionTabs {
    group: String,
    next: u64,
    pages: HashMap<u64, String>,
    by_tab: HashMap<String, u64>,
    lent: HashSet<String>,
}

fn sessions() -> &'static Mutex<HashMap<String, SessionTabs>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, SessionTabs>>> = OnceLock::new();
    SESSIONS.get_or_init(Default::default)
}

fn group_for(session: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("flufy-{}", &format!("{:x}", Sha256::digest(session.as_bytes()))[..8])
}

fn tab_key(value: &Value) -> Option<String> {
    if let Some(id) = value.as_i64() { Some(id.to_string()) } else { value.as_str().map(str::to_string) }
}

/// Browse takes numeric tab ids as JSON numbers; a numeric *string* is read as
/// a chosen id ("work-mail") and rejected. Keep the stored key a string and
/// turn it back into a number when talking to the relay.
fn tab_value(tab: &str) -> Value {
    match tab.parse::<i64>() {
        Ok(id) => json!(id),
        Err(_) => json!(tab),
    }
}

fn with_session<T>(session: &str, f: impl FnOnce(&mut SessionTabs) -> T) -> T {
    let mut all = sessions().lock().unwrap();
    let entry = all.entry(session.to_string()).or_insert_with(|| SessionTabs {
        group: group_for(session),
        next: 1,
        ..Default::default()
    });
    f(entry)
}

fn assign(session: &mut SessionTabs, tab: &str) -> u64 {
    if let Some(id) = session.by_tab.get(tab) {
        return *id;
    }
    let id = session.next;
    session.next += 1;
    session.pages.insert(id, tab.to_string());
    session.by_tab.insert(tab.to_string(), id);
    id
}

fn page_of(session: &SessionTabs, page_id: u64) -> Option<String> {
    session.pages.get(&page_id).cloned()
}

fn owned(session: &SessionTabs, tab: &str) -> bool {
    session.by_tab.contains_key(tab) || session.lent.contains(tab)
}

struct PageInfo { page_id: u64, url: String, lent: bool }

fn sync(session: &mut SessionTabs, value: &Value) -> Vec<PageInfo> {
    let mut seen = HashSet::new();
    let mut pages = Vec::new();
    let group = session.group.clone();
    for tab in value["tabs"].as_array().into_iter().flatten() {
        let Some(key) = tab_key(&tab["tab"]) else { continue };
        let lent = tab["lent"].as_bool().unwrap_or(false);
        if !lent && tab["group"].as_str() != Some(group.as_str()) { continue; }
        let page_id = assign(session, &key);
        if lent {
            session.lent.insert(key.clone());
        }
        seen.insert(key.clone());
        pages.push(PageInfo { page_id, url: tab["url"].as_str().unwrap_or_default().to_string(), lent });
    }
    session.pages.retain(|_, tab| seen.contains(tab));
    let keep: HashSet<u64> = pages.iter().map(|p| p.page_id).collect();
    session.by_tab.retain(|_, id| keep.contains(id));
    session.lent.retain(|tab| seen.contains(tab));
    pages.sort_by_key(|page| page.page_id);
    pages
}

/// Copies `pageId` into any JSON result that names a tab, and registers tabs
/// the page opened (popups) so the agent can address them next.
fn annotate(session: &mut SessionTabs, value: &mut Value) {
    if let Some(items) = value["content"].as_array_mut() {
        for item in items.iter_mut() {
            let Some(raw) = item["text"].as_str() else { continue };
            let Ok(parsed) = serde_json::from_str::<Value>(raw) else { continue };
            let Some(object) = parsed.as_object() else { continue };
            let mut changed = false;
            let mut next = object.clone();
            if let Some(tab) = object.get("tab").and_then(tab_key) {
                if owned(session, &tab) {
                    next["pageId"] = json!(assign(session, &tab));
                    changed = true;
                }
            }
            if let Some(new_tabs) = object.get("newTabs").and_then(Value::as_array) {
                let mut annotated = Vec::new();
                for tab in new_tabs {
                    let Some(id) = tab.get("tab").and_then(tab_key) else { continue };
                    let page_id = assign(session, &id);
                    let mut tab = tab.clone();
                    tab["pageId"] = json!(page_id);
                    annotated.push(tab);
                }
                next["newTabs"] = Value::Array(annotated);
                changed = true;
            }
            if changed {
                item["text"] = json!(Value::Object(next).to_string());
            }
        }
    }
}

fn list_tabs(session: &str) -> Result<Vec<PageInfo>, String> {
    let raw = call_tool("tabs", json!({ "action": "list" }))?;
    let value: Value = serde_json::from_str(&text_of(&raw)).unwrap_or_else(|_| json!({ "tabs": [] }));
    Ok(with_session(session, |state| sync(state, &value)))
}

fn page_tab(session: &str, args: &Value) -> Result<String, String> {
    let page_id = args["pageId"].as_u64().ok_or("Falta pageId: usá browser_list_pages y elegí una pestaña de esta conversación.")?;
    with_session(session, |state| page_of(state, page_id))
        .ok_or_else(|| "Esa pestaña no pertenece a esta conversación. Usá browser_list_pages para ver las pestañas disponibles.".to_string())
}

fn known(session: &str, tab: &str) -> String {
    with_session(session, |state| match state.by_tab.get(tab) {
        Some(id) => format!(" (pageId {})", id),
        None => String::new(),
    })
}

// --- argument translation --------------------------------------------------

fn translation_error(tool: &str) -> String {
    format!("Browse no expone un equivalente de {}. Usá browser_take_snapshot y las herramientas de página.", tool)
}

fn page_tool(session: &str, tool: &str, args: &Value) -> Result<(&'static str, Value), String> {
    let tab = page_tab(session, args)?;
    let mut out = serde_json::Map::new();
    out.insert("tab".into(), tab_value(&tab));
    let take = |key: &str| -> Option<Value> {
        let value = args.get(key)?;
        if value.is_null() { None } else { Some(value.clone()) }
    };
    let (name, extra): (&'static str, Value) = match tool {
        "click" => {
            let mut value = json!({});
            if let Some(uid) = take("uid") { value["ref"] = uid; }
            if args["dblClick"].as_bool().unwrap_or(false) { value["clickCount"] = json!(2); }
            for key in ["button", "force", "timeout"] {
                if let Some(v) = take(key) { value[key] = v; }
            }
            ("click", value)
        }
        "fill" => {
            let mut value = json!({});
            if let Some(uid) = take("uid") { value["ref"] = uid; }
            if let Some(v) = take("value") { value["value"] = v; }
            if let Some(v) = take("submit") { value["submit"] = v; }
            ("fill", value)
        }
        "fill_form" => {
            let fields: Vec<Value> = args["elements"].as_array().map(|items| items.iter().filter_map(|item| {
                let uid = item["uid"].as_str()?;
                let mut field = json!({ "ref": uid });
                if let Some(value) = item.get("value") { field["value"] = value.clone(); }
                Some(field)
            }).collect()).unwrap_or_default();
            if fields.is_empty() { return Err("fill_form necesita elements con uid y value.".into()); }
            ("fill", json!({ "fields": fields }))
        }
        "hover" => {
            let mut value = json!({});
            if let Some(uid) = take("uid") { value["ref"] = uid; }
            ("hover", value)
        }
        "press_key" => {
            let key = take("key").ok_or("Falta key.")?;
            ("press", json!({ "key": key }))
        }
        "type_text" => {
            let mut value = json!({ "text": take("text").ok_or("Falta text.")? });
            if let Some(key) = take("submitKey") {
                value["submit"] = json!(key.as_str() == Some("Enter"));
            }
            ("type", value)
        }
        "drag" => {
            let from = take("from_uid").or_else(|| take("fromUid")).ok_or("Falta from_uid.")?;
            let to = take("to_uid").or_else(|| take("toUid")).ok_or("Falta to_uid.")?;
            ("drag", json!({ "from": { "ref": from }, "to": { "ref": to } }))
        }
        "upload_file" => {
            let mut value = json!({});
            if let Some(uid) = take("uid") { value["ref"] = uid; }
            let files = take("filePaths").ok_or("Falta filePaths.")?;
            value["files"] = files;
            ("upload", value)
        }
        "handle_dialog" => {
            let action = take("action").ok_or("Falta action.")?;
            let mut value = json!({ "action": action });
            if let Some(text) = take("promptText") { value["promptText"] = text; }
            ("dialog", value)
        }
        "wait_for" => {
            let mut value = json!({});
            match take("text") {
                Some(Value::Array(items)) if items.len() == 1 => value["text"] = items[0].clone(),
                Some(Value::Array(_)) => return Err("Browse espera un solo texto por espera: llamá browser_wait_for una vez por texto.".into()),
                Some(text) => value["text"] = text,
                None => {}
            }
            if let Some(text) = take("textGone") { value["textGone"] = text; }
            if let Some(timeout) = take("timeout") { value["timeout"] = timeout; }
            ("wait_for", value)
        }
        "evaluate_script" => {
            let mut value = json!({ "expression": take("function").ok_or("Falta function.")? });
            if let Some(arg) = take("args") {
                value["arg"] = match arg {
                    Value::Array(items) if items.len() == 1 => items[0].clone(),
                    other => other,
                };
            }
            ("eval", value)
        }
        "take_snapshot" => {
            let mut value = json!({});
            if args["verbose"].as_bool().unwrap_or(false) { value["compact"] = json!(false); }
            ("snapshot", value)
        }
        "take_screenshot" => {
            let mut value = json!({});
            if let Some(uid) = take("uid") { value["ref"] = uid; }
            if let Some(v) = take("fullPage") { value["fullPage"] = v; }
            if let Some(v) = take("format") { value["format"] = v; }
            if let Some(v) = take("quality") { value["quality"] = v; }
            if let Some(v) = take("filePath") { value["path"] = v; }
            ("screenshot", value)
        }
        other => return Err(translation_error(other)),
    };
    for (key, value) in extra.as_object().into_iter().flatten() {
        out.insert(key.clone(), value.clone());
    }
    Ok((name, Value::Object(out)))
}

fn navigation(session: &str, args: &Value) -> Result<Value, String> {
    let mut value = serde_json::Map::new();
    if let Some(url) = args["url"].as_str().filter(|url| !url.trim().is_empty()) {
        value.insert("url".into(), json!(url));
    }
    match args["type"].as_str().unwrap_or("url") {
        "url" | "" => { value.insert("action".into(), json!("goto")); }
        other @ ("back" | "forward" | "reload") => { value.insert("action".into(), json!(other)); }
        _other => { value.insert("action".into(), json!("goto")); }
    }
    if args["type"].as_str() == Some("reload") && args["ignoreCache"].as_bool().unwrap_or(false) {
        value.insert("ignoreCache".into(), json!(true));
    }
    if let Some(timeout) = args["timeout"].as_u64() { value.insert("timeout".into(), json!(timeout)); }
    // A navigation without pageId opens a new tab in this conversation's group.
    match args["pageId"].as_u64() {
        Some(_) => {
            let tab = page_tab(session, args)?;
            value.insert("tab".into(), tab_value(&tab));
        }
        None => {
            let group = with_session(session, |state| state.group.clone());
            value.insert("group".into(), json!(group));
            if value.get("url").is_none() {
                return Err("Falta url para abrir una pestaña nueva.".into());
            }
        }
    }
    call_tool("navigate", Value::Object(value))
}

pub fn call_session(session: &str, name: &str, args: Value) -> Value {
    match dispatch(session, name, &args) {
        Ok(mut value) => {
            with_session(session, |state| annotate(state, &mut value));
            value
        }
        Err(error) => result_error(error),
    }
}

fn dispatch(session: &str, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "list_pages" => {
            let pages = list_tabs(session)?;
            if pages.is_empty() {
                return Ok(result_text("No hay pestañas abiertas para esta conversación. Usá browser_new_page para abrir una; Browse la crea en segundo plano, agrupada con esta conversación."));
            }
            let lines: Vec<String> = pages.iter().map(|page| format!("{}: {}{}", page.page_id, page.url, if page.lent { " [prestada]" } else { "" })).collect();
            Ok(result_text(lines.join("\n")))
        }
        "new_page" => {
            let group = with_session(session, |state| state.group.clone());
            let mut value = json!({ "action": "new", "group": group });
            if let Some(url) = args["url"].as_str().filter(|url| !url.trim().is_empty()) { value["url"] = json!(url); }
            let result = match call_tool("tabs", value.clone()) {
                Ok(result) => result,
                Err(error) if error.contains("Tabs cannot be edited right now") => {
                    // Chrome locks tab groups for a moment while the user drags
                    // a tab; the tab was not created, so retrying is safe.
                    std::thread::sleep(Duration::from_millis(350));
                    call_tool("tabs", value)?
                }
                Err(error) => return Err(error),
            };
            let mut parsed: Value = serde_json::from_str(&text_of(&result)).unwrap_or(Value::Null);
            if let Some(tab) = parsed.get("tab").and_then(tab_key) {
                let page_id = with_session(session, |state| assign(state, &tab));
                parsed["pageId"] = json!(page_id);
            }
            let mut out = result_text(parsed.to_string());
            with_session(session, |state| annotate(state, &mut out));
            Ok(out)
        }
        "close_page" => {
            let tab = page_tab(session, args)?;
            let result = call_tool("tabs", json!({ "action": "close", "tab": tab_value(&tab) }))?;
            with_session(session, |state| {
                if let Some((page_id, _)) = state.pages.iter().find(|(_, value)| **value == tab).map(|(id, value)| (*id, value.clone())) {
                    state.pages.remove(&page_id);
                    state.by_tab.remove(&tab);
                    state.lent.remove(&tab);
                }
            });
            Ok(result_text(text_of(&result)))
        }
        "select_page" => {
            let tab = page_tab(session, args)?;
            Ok(result_text(format!("Pestaña de esta conversación lista{}: {}.", known(session, &tab), tab)))
        }
        "navigate_page" => {
            let result = navigation(session, args)?;
            // A navigation without pageId opens a new tab: register it before the
            // result is annotated so the agent gets its pageId back.
            if args["pageId"].as_u64().is_none() {
                let parsed: Value = serde_json::from_str(&text_of(&result)).unwrap_or(Value::Null);
                if let Some(tab) = parsed.get("tab").and_then(tab_key) {
                    with_session(session, |state| { assign(state, &tab); });
                }
            }
            Ok(result_text(text_of(&result)))
        }
        "list_console_messages" => Ok(result_error("Browse captura la consola solo cuando se inicia esa captura; todavía no hay una herramienta equivalente en Flufy. Usá browser_evaluate_script para leer lo que necesitás.")),
        "list_network_requests" => Ok(result_error("Browse captura la red solo cuando se inicia esa captura; todavía no hay una herramienta equivalente en Flufy. Usá browser_evaluate_script para leer lo que necesitás.")),
        "get_console_message" | "get_network_request" => Ok(result_error("Esa herramienta de Chrome DevTools no tiene equivalente en Browse por ahora.")),
        other => {
            let (tool, mut value) = page_tool(session, other, args)?;
            if let Some(tab) = value.get("tab").and_then(tab_key) {
                if !with_session(session, |state| owned(state, &tab)) {
                    return Err("Esa pestaña no pertenece a esta conversación. Usá browser_list_pages.".into());
                }
            }
            if tool == "dialog" && value["action"].is_null() { value["action"] = json!("accept"); }
            let result = call_tool(tool, value)?;
            if result["content"].as_array().is_some_and(|items| items.iter().any(|item| item["type"] == "image")) {
                return Ok(result);
            }
            Ok(result_text(text_of(&result)))
        }
    }
}

pub fn workspace(app: &tauri::AppHandle, session: &str, quiet: bool) -> Result<Value, String> {
    if quiet && binary(Some(app)).is_none() {
        return Ok(json!({ "browse": true, "assigned": false, "missing": false, "windowId": null, "pages": [] }));
    }
    if quiet && client().inner.lock().unwrap().child.is_none() {
        return Ok(json!({ "browse": true, "assigned": false, "missing": false, "windowId": null, "pages": [] }));
    }
    let pages = list_tabs(session)?;
    let values: Vec<Value> = pages.iter().map(|page| json!({ "id": page.page_id, "windowId": 0, "url": page.url })).collect();
    Ok(json!({
        "browse": true,
        "assigned": !values.is_empty(),
        "missing": false,
        "windowId": if values.is_empty() { Value::Null } else { json!(0) },
        "pages": values,
    }))
}

pub fn status(app: &tauri::AppHandle, probe: bool) -> BrowseStatus {
    let available = available(app);
    let mut status = BrowseStatus {
        available,
        enabled: app.try_state::<super::DesktopState>().is_some_and(|state| state.config.lock().unwrap().browse),
        running: client().inner.lock().unwrap().child.is_some(),
        connected: None,
        pairing: None,
        next_step: if available { None } else { Some(INSTALL_HINT.into()) },
        version: None,
        error: None,
    };
    if !available || !probe {
        return status;
    }
    match call_tool("status", json!({})) {
        Ok(value) => {
            let parsed: Value = serde_json::from_str(&text_of(&value)).unwrap_or(Value::Null);
            status.running = client().inner.lock().unwrap().child.is_some();
            status.connected = parsed["connected"].as_bool();
            status.pairing = parsed["pairingState"].as_str().map(str::to_string);
            status.version = parsed["relay"]["version"].as_str().map(str::to_string);
            status.next_step = parsed["nextStep"].as_str().or_else(|| parsed["extension"]["nextStep"].as_str()).map(str::to_string);
        }
        Err(error) => {
            status.error = Some(error);
            status.running = client().inner.lock().unwrap().child.is_some();
        }
    }
    status
}

pub fn prepare(app: &tauri::AppHandle) {
    if !available(app) {
        log::info!("[browse] no está instalado; las conversaciones usan Chrome DevTools");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> SessionTabs {
        SessionTabs { group: group_for("ses_test"), next: 1, ..Default::default() }
    }

    #[test]
    fn groups_are_stable_and_distinct_per_conversation() {
        assert_eq!(group_for("ses_a"), group_for("ses_a"));
        assert_ne!(group_for("ses_a"), group_for("ses_b"));
        assert!(group_for("ses_a").starts_with("flufy-"));
    }

    #[test]
    fn sync_keeps_this_conversation_and_lent_tabs_only() {
        let mut state = session();
        let group = state.group.clone();
        let value = json!({ "tabs": [
            { "tab": 7, "url": "https://a.test", "group": group },
            { "tab": 8, "url": "https://b.test", "group": "otra" },
            { "tab": 9, "url": "https://c.test", "group": "otra", "lent": true },
        ]});
        let pages = sync(&mut state, &value);
        assert_eq!(pages.iter().map(|page| page.url.as_str()).collect::<Vec<_>>(), ["https://a.test", "https://c.test"]);
        assert_eq!(pages[0].page_id, 1);
        assert_eq!(pages[1].page_id, 2);
        assert!(owned(&state, "9"));
        assert!(!owned(&state, "8"));
    }

    #[test]
    fn page_ids_survive_a_refresh_and_are_pruned_when_the_tab_closes() {
        let mut state = session();
        let group = state.group.clone();
        let one = sync(&mut state, &json!({ "tabs": [{ "tab": 5, "url": "https://a.test", "group": group }] }));
        let two = sync(&mut state, &json!({ "tabs": [{ "tab": 5, "url": "https://a.test/b", "group": group }] }));
        assert_eq!(one[0].page_id, two[0].page_id);
        assert_eq!(page_of(&state, 1).as_deref(), Some("5"));
        sync(&mut state, &json!({ "tabs": [] }));
        assert!(page_of(&state, 1).is_none());
        assert!(!owned(&state, "5"));
    }

    #[test]
    fn click_fill_and_eval_translate_to_browse_arguments() {
        with_session("ses_test", |state| { state.by_tab.insert("11".into(), 1); state.pages.insert(1, "11".into()); });
        let (tool, args) = page_tool("ses_test", "click", &json!({ "pageId": 1, "uid": "e12", "dblClick": true })).unwrap();
        assert_eq!(tool, "click");
        assert_eq!(args["tab"], 11);
        assert_eq!(args["ref"], "e12");
        assert_eq!(args["clickCount"], 2);
        let (tool, args) = page_tool("ses_test", "fill_form", &json!({ "pageId": 1, "elements": [{ "uid": "e1", "value": "Ana" }] })).unwrap();
        assert_eq!(tool, "fill");
        assert_eq!(args["fields"][0]["ref"], "e1");
        let (tool, args) = page_tool("ses_test", "evaluate_script", &json!({ "pageId": 1, "function": "() => document.title" })).unwrap();
        assert_eq!(tool, "eval");
        assert_eq!(args["expression"], "() => document.title");
        let (tool, args) = page_tool("ses_test", "press_key", &json!({ "pageId": 1, "key": "Enter" })).unwrap();
        assert_eq!(tool, "press");
        assert_eq!(args["key"], "Enter");
    }

    #[test]
    fn a_page_from_another_conversation_is_refused() {
        with_session("ses_other", |state| { state.group = group_for("ses_other"); });
        assert!(page_tab("ses_test", &json!({ "pageId": 999 })).is_err());
    }
}

#[tauri::command]
pub async fn browse_status(app: tauri::AppHandle, probe: Option<bool>) -> Result<BrowseStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status(&app, probe.unwrap_or(false))).await.map_err(|e| e.to_string())
}

/// Enriches the observed URL with the pageId of a tab this conversation opened.
/// It never starts Browse on its own: context capture must not open a browser
/// connection in conversations that have not used one yet.
pub fn context_for_url(session: &str, url: &str) -> Value {
    if client().inner.lock().unwrap().child.is_none() {
        return json!({ "url": url, "pageId": null, "hint": "Browse no está corriendo en esta conversación; usá browser_list_pages si necesitás la pestaña." });
    }
    let normalize = |s: &str| s.trim().trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/').to_string();
    let wanted = normalize(url);
    match list_tabs(session) {
        Ok(pages) => {
            let candidates: Vec<Value> = pages.iter().filter(|page| normalize(&page.url) == wanted).map(|page| json!({ "pageId": page.page_id, "url": page.url })).collect();
            json!({
                "url": url,
                "pageId": if candidates.len() == 1 { candidates[0]["pageId"].clone() } else { Value::Null },
                "candidates": candidates,
                "hint": "Un pageId sólo se identifica con coincidencia única de URL. Si hay varias pestañas iguales, pedí elegir; no adivines.",
            })
        }
        Err(error) => json!({ "url": url, "pageId": null, "hint": format!("No pude consultar las pestañas de Chrome (Browse): {}", error) }),
    }
}
