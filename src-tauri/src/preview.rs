//! Persistent visual designs. Revisions are append-only; approval is a frozen snapshot.
//! IPC uses `call(command, {identity, baseRevisionId, ...})` from lib/tauri.ts.
//! Document is JSON: {version:1,root:Node,theme:{tokens,provenance,approximations},viewports}.
//! Node: {id,type,text?,layout?,styles?,mobileStyles?,children:Node[]}.
//! Types: container, text, button, image. Layout and styles are CSS property maps.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, path::{Path, PathBuf}, sync::Mutex};
use tauri::{AppHandle, Emitter};

static LOCK: Mutex<()> = Mutex::new(());
const MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub project_root: String,
    pub session_id: String,
    pub task_id: String,
    pub design_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub id: String,
    pub parent_id: Option<String>,
    pub created_at: i64,
    pub document: Value,
    pub html: String,
    pub css: String,
    pub assets: Vec<Value>,
    pub notes: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Design {
    pub identity: Identity,
    pub choice: String,
    pub status: String,
    pub current_revision_id: Option<String>,
    pub approved_revision_id: Option<String>,
    pub revisions: Vec<Revision>,
    #[serde(default)]
    pub approvals: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDesign {
    identity: Identity,
    title: String,
    status: String,
    current_revision_id: String,
    approved_revision_id: Option<String>,
    revision_count: usize,
    screen_count: usize,
    updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignLibrary { designs: Vec<SavedDesign>, unreadable: usize }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub identity: Identity,
    pub revision: Revision,
}

/// Explicit attribution of an implemented result. The revision and viewport are
/// declared before the capture; nothing is inferred from the image width later.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureBinding {
    pub identity: Identity,
    pub revision_id: String,
    pub viewport: String,
    pub width: u32,
    pub height: u32,
    pub origin: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImplementationCapture {
    pub binding: CaptureBinding,
    pub artifact: String,
    pub sha256: String,
    pub captured_at: i64,
    pub source: String,
    pub status: String,
}

fn canonical(root: &str) -> Result<String, String> {
    let path = std::fs::canonicalize(root).map_err(|_| "PREVIEW_PROJECT: el proyecto no existe")?;
    if !path.is_dir() { return Err("PREVIEW_PROJECT: se requiere una carpeta".into()); }
    Ok(path.to_string_lossy().to_string())
}

fn normalize(mut identity: Identity) -> Result<Identity, String> {
    identity.project_root = canonical(&identity.project_root)?;
    for value in [&identity.session_id, &identity.task_id, &identity.design_id] {
        if value.is_empty() || value.len() > 200 || !value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("PREVIEW_IDENTITY: identidad vacía o inválida".into());
        }
    }
    Ok(identity)
}

fn empty(identity: Identity) -> Design {
    Design { identity, choice:"pending".into(), status:"pending".into(), current_revision_id:None,
        approved_revision_id:None, revisions:vec![], approvals:vec![] }
}

fn database(path: &Path) -> Result<rusqlite::Connection, String> {
    let db = rusqlite::Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS preview_designs (project TEXT NOT NULL, session TEXT NOT NULL, task TEXT NOT NULL, design TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(project,session,task,design));").map_err(|e| e.to_string())?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS preview_transfers (project TEXT NOT NULL, session TEXT NOT NULL, task TEXT NOT NULL, design TEXT NOT NULL, reference TEXT NOT NULL, PRIMARY KEY(project,session,task,design));").map_err(|e| e.to_string())?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS preview_captures (project TEXT NOT NULL, session TEXT NOT NULL, task TEXT NOT NULL, design TEXT NOT NULL, revision TEXT NOT NULL, viewport TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, origin TEXT NOT NULL, artifact TEXT NOT NULL, sha256 TEXT NOT NULL, captured_at INTEGER NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(project,session,task,design,revision,viewport));").map_err(|e| e.to_string())?;
    Ok(db)
}

fn read(db: &rusqlite::Connection, identity: &Identity) -> Result<Design, String> {
    use rusqlite::OptionalExtension;
    let text: Option<String> = db.query_row("SELECT state FROM preview_designs WHERE project=?1 AND session=?2 AND task=?3 AND design=?4",
        rusqlite::params![identity.project_root,identity.session_id,identity.task_id,identity.design_id], |row| row.get(0))
        .optional().map_err(|e| e.to_string())?;
    match text {
        Some(text) => {
            let state: Design = serde_json::from_str(&text).map_err(|_| "PREVIEW_STORAGE: estado incompatible; se conservó el registro")?;
            if &state.identity != identity { return Err("PREVIEW_SCOPE: la identidad persistida no corresponde al registro solicitado".into()); }
            Ok(state)
        },
        None => Ok(empty(identity.clone())),
    }
}

fn base(state: &Design, revision: &Option<String>) -> Result<(), String> {
    if &state.current_revision_id != revision {
        return Err(format!("PREVIEW_CONFLICT:{}", serde_json::to_string(state).map_err(|e| e.to_string())?));
    }
    Ok(())
}

/// The application has one design per visual task (design_id = "design").
/// Return metadata only; opening a design retains the normal session authorization.
fn list_project(db: &rusqlite::Connection, project: &str) -> Result<DesignLibrary,String> {
    fn first_text(node: &Value) -> Option<&str> {
        node["text"].as_str().filter(|text| !text.trim().is_empty()).or_else(|| node["children"].as_array()?.iter().find_map(first_text))
    }
    let mut statement=db.prepare("SELECT session,task,design,state FROM preview_designs WHERE project=?1 AND design='design'").map_err(|e| e.to_string())?;
    let rows=statement.query_map([project],|row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?))).map_err(|e| e.to_string())?;
    let mut result=DesignLibrary { designs:vec![],unreadable:0 };
    for row in rows {
        let (session,task,design,text)=row.map_err(|e| e.to_string())?;
        let expected=Identity { project_root:project.into(),session_id:session,task_id:task,design_id:design };
        let state:Design=match serde_json::from_str(&text) { Ok(state)=>state,Err(_)=>{result.unreadable+=1;continue;} };
        if state.identity!=expected { result.unreadable+=1;continue; }
        let Some(revision_id)=state.current_revision_id.as_ref() else { continue; };
        let Some(revision)=state.revisions.iter().find(|revision| &revision.id==revision_id) else {result.unreadable+=1;continue;};
        if state.choice!="create" {continue;}
        let title=revision.document["title"].as_str().filter(|text| !text.trim().is_empty())
            .or_else(|| revision.document["preview"]["title"].as_str().filter(|text| !text.trim().is_empty()))
            .or_else(|| first_text(&revision.document["root"]))
            .unwrap_or("Diseño sin título").trim().chars().take(120).collect();
        result.designs.push(SavedDesign { identity:state.identity.clone(),title,status:state.status.clone(),
            current_revision_id:revision_id.clone(),approved_revision_id:state.approved_revision_id.clone(),
            revision_count:state.revisions.len(),screen_count:revision.document["screens"].as_array().map(|screens| screens.len()).unwrap_or(1),updated_at:revision.created_at });
    }
    result.designs.sort_by(|a,b| b.updated_at.cmp(&a.updated_at).then_with(|| a.title.cmp(&b.title)));
    Ok(result)
}

fn mutate(path: &Path, identity: &Identity, revision: &Option<String>, f: impl FnOnce(&mut Design) -> Result<(), String>) -> Result<Design, String> {
    let _guard = LOCK.lock().map_err(|_| "PREVIEW_STORAGE: bloqueo no disponible")?;
    let mut db = database(path)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let mut state = read(&tx, identity)?;
    base(&state, revision)?;
    f(&mut state)?;
    let text = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO preview_designs(project,session,task,design,state) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(project,session,task,design) DO UPDATE SET state=excluded.state",
        rusqlite::params![identity.project_root,identity.session_id,identity.task_id,identity.design_id,text]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(state)
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

fn properties(value: &Value) -> Result<String, String> {
    let Some(map) = value.as_object() else { if value.is_null() { return Ok(String::new()); } return Err("PREVIEW_DOCUMENT: estilos inválidos".into()); };
    let allowed = ["display","flexDirection","flexWrap","justifyContent","alignItems","alignSelf","gap","rowGap","columnGap","gridTemplateColumns","gridColumn","width","height","minWidth","maxWidth","minHeight","maxHeight","padding","paddingTop","paddingBottom","paddingLeft","paddingRight","margin","marginTop","marginBottom","marginLeft","marginRight","background","backgroundColor","color","fontFamily","fontSize","fontWeight","lineHeight","letterSpacing","textAlign","border","borderColor","borderWidth","borderStyle","borderRadius","boxShadow","opacity","overflow","objectFit","flex","flexGrow","flexShrink","order","transform","position","left","top"];
    let mut css = String::new();
    for (key, value) in map {
        if !allowed.contains(&key.as_str()) { return Err(format!("PREVIEW_DOCUMENT: propiedad no permitida {key}")); }
        let val = if let Some(text) = value.as_str() { text.to_string() } else if value.is_number() { value.to_string() } else { return Err("PREVIEW_DOCUMENT: valor CSS inválido".into()); };
        let lower = val.to_lowercase();
        if val.len() > 500 || val.contains(['{','}',';','<','>','\\']) || lower.contains("url(") || lower.contains("expression") || lower.contains("@import") { return Err("PREVIEW_DOCUMENT: valor CSS inseguro".into()); }
        let name: String = key.chars().flat_map(|c| if c.is_ascii_uppercase() { vec!['-',c.to_ascii_lowercase()] } else { vec![c] }).collect();
        css.push_str(&format!("{name}:{val};"));
    }
    Ok(css)
}

fn node(value: &Value, ids: &mut HashSet<String>, css: &mut String, depth: usize) -> Result<String, String> {
    if depth > 40 || ids.len() >= 1000 { return Err("PREVIEW_DOCUMENT: documento demasiado grande".into()); }
    let id = value["id"].as_str().filter(|s| !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).ok_or("PREVIEW_DOCUMENT: ID de nodo inválido")?;
    if !ids.insert(id.into()) { return Err("PREVIEW_DOCUMENT: ID de nodo duplicado".into()); }
    let kind = value["type"].as_str().unwrap_or("container");
    let tag = match kind { "container" => "div", "text" => "p", "button" => "button", "image" => "div", _ => return Err("PREVIEW_DOCUMENT: tipo de nodo inválido".into()) };
    css.push_str(&format!("[data-preview-id=\"{id}\"]{{{}{}}}",properties(&value["layout"])?,properties(&value["styles"])?));
    if !value["mobileStyles"].is_null() { css.push_str(&format!("@media(max-width:600px){{[data-preview-id=\"{id}\"]{{{}}}}}",properties(&value["mobileStyles"])?)); }
    let mut contents = escape(value["text"].as_str().unwrap_or(""));
    if let Some(children) = value["children"].as_array() { for child in children { contents.push_str(&node(child,ids,css,depth+1)?); } }
    let target = value["targetScreenId"].as_str().map(|target| format!(" data-target-screen=\"{}\"",escape(target))).unwrap_or_default();
    let slot = if value["placeholderFor"].is_string() { " data-preview-slot aria-hidden=\"true\" style=\"visibility:hidden!important;pointer-events:none\"" } else { "" };
    Ok(format!("<{tag} data-preview-id=\"{id}\"{target}{slot}>{contents}</{tag}>"))
}

fn validate_screens(document: &Value) -> Result<(),String> {
    fn validate_links(node: &Value, screens: &HashSet<String>) -> Result<(),String> {
        if let Some(target) = node.get("targetScreenId") {
            if !target.as_str().is_some_and(|id| screens.contains(id)) { return Err("PREVIEW_DOCUMENT: pantalla de destino inexistente".into()); }
        }
        if let Some(children) = node["children"].as_array() { for child in children { validate_links(child, screens)?; } }
        Ok(())
    }
    let link_targets: HashSet<String> = document["screens"].as_array().map(|screens| screens.iter().filter_map(|screen| screen["id"].as_str().map(String::from)).collect()).unwrap_or_else(|| HashSet::from(["default".to_string()]));
    validate_links(&document["root"], &link_targets)?;
    if let Some(preview) = document.get("preview").filter(|value| value.is_object()) {
        if preview.get("screens") != document.get("screens") { return Err("PREVIEW_DOCUMENT: metadatos de pantallas incompatibles".into()); }
    }
    let Some(value) = document.get("screens") else { return Ok(()); };
    let screens = value.as_array().filter(|s| !s.is_empty() && s.len() <= 40).ok_or("PREVIEW_DOCUMENT: entre 1 y 40 pantallas")?;
    fn find<'a>(node: &'a Value, id: &str) -> Option<&'a Value> {
        if node["id"].as_str() == Some(id) { return Some(node); }
        node["children"].as_array()?.iter().find_map(|child| find(child,id))
    }
    let mut ids = HashSet::new();
    let mut roots = HashSet::new();
    for screen in screens {
        let id = screen["id"].as_str().filter(|s| !s.is_empty() && s.len() <= 200 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).ok_or("PREVIEW_DOCUMENT: ID de pantalla inválido")?;
        screen["name"].as_str().filter(|s| !s.trim().is_empty() && s.chars().count() <= 120).ok_or("PREVIEW_DOCUMENT: nombre de pantalla inválido")?;
        let root_id = screen["nodeId"].as_str().ok_or("PREVIEW_DOCUMENT: pantalla sin contenedor")?;
        let root = find(&document["root"],root_id).ok_or("PREVIEW_DOCUMENT: contenedor de pantalla ausente")?;
        if root["type"].as_str().unwrap_or("container") != "container" || !ids.insert(id) || !roots.insert(root_id) { return Err("PREVIEW_DOCUMENT: pantalla inválida o duplicada".into()); }
    }
    for screen in screens {
        let id = screen["nodeId"].as_str().unwrap();
        let root = find(&document["root"],id).unwrap();
        if roots.iter().any(|other| *other != id && find(root,other).is_some()) { return Err("PREVIEW_DOCUMENT: las pantallas no pueden anidarse".into()); }
    }
    Ok(())
}

fn render(document: &Value) -> Result<(String,String), String> {
    if serde_json::to_vec(document).map_err(|e| e.to_string())?.len() > MAX_BYTES { return Err("PREVIEW_DOCUMENT: supera el límite".into()); }
    let mut css = "*{box-sizing:border-box}body{margin:0}button{font:inherit}p{margin:0}".to_string();
    let body = node(&document["root"], &mut HashSet::new(), &mut css, 0)?;
    validate_screens(document)?;
    let html = format!("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'\"><style>{css}</style></head><body>{body}</body></html>");
    Ok((html,css))
}

fn choose(state: &mut Design, choice: &str) -> Result<(), String> {
    if !["create","skip"].contains(&choice) { return Err("PREVIEW_CHOICE: usar create o skip".into()); }
    if state.choice != "pending" && state.choice != choice { return Err("PREVIEW_CHOICE: esta tarea ya tiene una elección".into()); }
    state.choice = choice.into();
    if state.current_revision_id.is_none() { state.status = if choice == "skip" { "skipped" } else { "draft" }.into(); }
    Ok(())
}

fn apply(state: &mut Design, document: Value, notes: String) -> Result<(), String> {
    if state.choice != "create" { return Err("PREVIEW_CHOICE: elegí crear previsualización antes de editar".into()); }
    if notes.len() > 8000 { return Err("PREVIEW_DOCUMENT: notas demasiado largas".into()); }
    let (html,css) = render(&document)?;
    let revision = Revision { id:uuid::Uuid::new_v4().to_string(),parent_id:state.current_revision_id.clone(),
        created_at:chrono::Utc::now().timestamp_millis(), document,html,css,assets:vec![],notes };
    state.current_revision_id = Some(revision.id.clone());
    state.revisions.push(revision);
    state.status = "draft".into();
    Ok(())
}

fn approve(state: &mut Design, notes: &str) -> Result<(), String> {
    let revision = state.current_revision_id.clone().ok_or("PREVIEW_APPROVAL: no hay revisión para aprobar")?;
    if notes.len() > 8000 { return Err("PREVIEW_APPROVAL: notas demasiado largas".into()); }
    state.approved_revision_id = Some(revision.clone());
    state.approvals.push(json!({"revisionId":revision,"createdAt":chrono::Utc::now().timestamp_millis(),"notes":notes}));
    state.status = "approved".into();
    Ok(())
}

fn storage(app: &AppHandle) -> Result<PathBuf, String> { crate::app_data_file(app,"previews.db").ok_or("PREVIEW_STORAGE: sin carpeta de datos".into()) }

fn authorize(app: &AppHandle, window: &tauri::Window, identity: Identity) -> Result<Identity,String> {
    let identity = normalize(identity)?;
    if canonical(&crate::windows::project_of(app,window.label()))? != identity.project_root { return Err("PREVIEW_SCOPE: el diseño pertenece a otro proyecto".into()); }
    let client = crate::oc::Opencode::new(&crate::ensure_server(app)?, &identity.project_root);
    let session = client.get_resilient(&format!("/session/{}",identity.session_id))?;
    if session["id"].as_str() != Some(identity.session_id.as_str()) || canonical(session["directory"].as_str().unwrap_or(""))? != identity.project_root { return Err("PREVIEW_SCOPE: conversación incompatible".into()); }
    Ok(identity)
}

fn emit(app: &AppHandle, state: Design) -> Result<Design,String> { let _ = app.emit("preview://changed", &state); Ok(state) }

#[tauri::command]
pub fn preview_get(app: AppHandle, window: tauri::Window, identity: Identity) -> Result<Design,String> {
    let identity = authorize(&app,&window,identity)?;
    read(&database(&storage(&app)?)?, &identity)
}

#[tauri::command]
pub fn preview_list(app: AppHandle, window: tauri::Window, project_root: String) -> Result<DesignLibrary,String> {
    let project=canonical(&project_root)?;
    if canonical(&crate::windows::project_of(&app,window.label()))?!=project { return Err("PREVIEW_SCOPE: no se pueden listar diseños de otro proyecto".into()); }
    list_project(&database(&storage(&app)?)?,&project)
}

#[tauri::command]
pub fn preview_choose(app: AppHandle, window: tauri::Window, identity: Identity, base_revision_id: Option<String>, choice: String) -> Result<Design,String> {
    let identity = authorize(&app,&window,identity)?;
    emit(&app,mutate(&storage(&app)?,&identity,&base_revision_id,|s| choose(s,&choice))?)
}

#[tauri::command]
pub fn preview_apply(app: AppHandle, window: tauri::Window, identity: Identity, base_revision_id: Option<String>, document: Value, notes: Option<String>) -> Result<Design,String> {
    let identity = authorize(&app,&window,identity)?;
    emit(&app,mutate(&storage(&app)?,&identity,&base_revision_id,|s| apply(s,document,notes.unwrap_or_default()))?)
}

#[tauri::command]
pub fn preview_approve(app: AppHandle, window: tauri::Window, identity: Identity, base_revision_id: Option<String>, notes: Option<String>) -> Result<Design,String> {
    let identity = authorize(&app,&window,identity)?;
    emit(&app,mutate(&storage(&app)?,&identity,&base_revision_id,|s| approve(s,&notes.unwrap_or_default()))?)
}

/// Identity discovery is deliberately limited to source styling files. No env,
/// manifests, configuration, hidden directories or arbitrary asset paths are read.
fn extract(root: &Path) -> Result<Value,String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    let mut queue = vec![root.clone()];
    let mut visited = 0;
    while let Some(dir) = queue.pop() {
        if visited >= 300 || files.len() >= 24 { break; }
        visited += 1;
        let mut entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?.filter_map(Result::ok).collect::<Vec<_>>();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || ["node_modules","target","dist","build","vendor"].contains(&name.as_str()) { continue; }
            let ty = entry.file_type().map_err(|e| e.to_string())?;
            if ty.is_symlink() { continue; }
            let path = entry.path();
            if ty.is_dir() { if path.strip_prefix(&root).map(|p| p.components().count() <= 4).unwrap_or(false) { queue.push(path); } continue; }
            if ![Some("css"),Some("scss")].contains(&path.extension().and_then(|e| e.to_str())) || files.len() >= 24 { continue; }
            let resolved = path.canonicalize().map_err(|e| e.to_string())?;
            if !resolved.starts_with(&root) || entry.metadata().map_err(|e| e.to_string())?.len() > 128_000 { continue; }
            let source = std::fs::read_to_string(&resolved).map_err(|e| e.to_string())?;
            let re = regex::Regex::new(r"(?m)(--[A-Za-z0-9_-]+|font-family|background-color|color)\s*:\s*([^;{}\n]+)").map_err(|e| e.to_string())?;
            let tokens = re.captures_iter(&source).take(120).map(|c| json!({"name":&c[1],"value":c[2].trim()})).collect::<Vec<_>>();
            if !tokens.is_empty() { files.push(json!({"file":resolved.strip_prefix(&root).unwrap().to_string_lossy().replace('\\',"/"),"tokens":tokens})); }
        }
    }
    Ok(json!({"provenance":files,"approximations":["Extracción acotada a CSS/SCSS locales; las fuentes y recursos no incrustados usan alternativas del sistema."],"assets":[]}))
}

#[tauri::command]
pub fn preview_identity(app: AppHandle, window: tauri::Window, identity: Identity) -> Result<Value,String> {
    let identity = authorize(&app,&window,identity)?;
    extract(Path::new(&identity.project_root))
}

pub fn reference(state: &Design) -> Result<Option<Reference>,String> {
    if state.choice == "skip" || state.choice == "pending" { return Ok(None); }
    let id = state.approved_revision_id.as_ref().ok_or("PREVIEW_APPROVAL_REQUIRED: aprobá el diseño antes de implementar o delegar")?;
    let revision = state.revisions.iter().find(|r| &r.id == id).ok_or("PREVIEW_REFERENCE_MISSING: falta la revisión aprobada")?;
    if state.current_revision_id.as_ref() != Some(id) { return Err("PREVIEW_APPROVAL_REQUIRED: hay cambios visuales posteriores pendientes de aprobación".into()); }
    Ok(Some(Reference { identity:state.identity.clone(),revision:revision.clone() }))
}

fn selected_reference(db: &rusqlite::Connection, project: &str, session: &str, identity: Option<&Identity>) -> Result<Option<Reference>,String> {
    let Some(identity) = identity else {
        let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM preview_designs WHERE project=?1 AND session=?2)",rusqlite::params![project,session],|r| r.get(0)).map_err(|e| e.to_string())?;
        return if exists { Err("PREVIEW_IDENTITY_REQUIRED: indicá la identidad de la tarea vigente; no se selecciona otro diseño automáticamente".into()) } else { Ok(None) };
    };
    if identity.project_root != project || identity.session_id != session { return Err("PREVIEW_SCOPE: la referencia no corresponde al proyecto y conversación de origen".into()); }
    let state = read(db,identity)?;
    if state.choice == "pending" { return Err("PREVIEW_REFERENCE_MISSING: falta la elección de esta tarea y diseño".into()); }
    let frozen = reference(&state)?;
    if let Some(reference) = &frozen { reference_context(reference)?; }
    Ok(frozen)
}

pub fn session_reference(app: &AppHandle, project: &str, session: &str, identity: Option<Identity>) -> Result<Option<Reference>,String> {
    let identity = identity.map(normalize).transpose()?;
    transfer_reference(&storage(app)?,&canonical(project)?,session,identity.as_ref())
}

/// A transfer belongs to a task, not to the mutable approval pointer. Both chat
/// and team handoff use this transaction; retries and restarts read its snapshot.
fn transfer_reference(path: &Path, project: &str, session: &str, identity: Option<&Identity>) -> Result<Option<Reference>,String> {
    let _guard = LOCK.lock().map_err(|_| "PREVIEW_STORAGE: bloqueo no disponible")?;
    let mut db = database(path)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let Some(identity) = identity else { return selected_reference(&tx,project,session,None); };
    if identity.project_root != project || identity.session_id != session { return Err("PREVIEW_SCOPE: la transferencia pertenece a otro origen".into()); }
    if let Some(frozen) = frozen_transfer(&tx, identity)? { return Ok(Some(frozen)); }
    let frozen = selected_reference(&tx,project,session,Some(identity))?;
    if let Some(reference) = &frozen {
        tx.execute("INSERT INTO preview_transfers(project,session,task,design,reference) VALUES(?1,?2,?3,?4,?5)",
            rusqlite::params![project,session,identity.task_id,identity.design_id,serde_json::to_string(reference).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(frozen)
}

fn frozen_transfer(db: &rusqlite::Connection, identity: &Identity) -> Result<Option<Reference>,String> {
    use rusqlite::OptionalExtension;
    let stored: Option<String> = db.query_row("SELECT reference FROM preview_transfers WHERE project=?1 AND session=?2 AND task=?3 AND design=?4",
        rusqlite::params![identity.project_root,identity.session_id,identity.task_id,identity.design_id], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
    let Some(stored) = stored else { return Ok(None) };
    let frozen: Reference = serde_json::from_str(&stored).map_err(|_| "PREVIEW_REFERENCE_INCOMPATIBLE: transferencia persistida inválida")?;
    if &frozen.identity != identity { return Err("PREVIEW_SCOPE: identidad congelada incompatible".into()); }
    reference_context(&frozen)?;
    Ok(Some(frozen))
}

/// Canonical local origin only: the capture may not point at another host or
/// carry credentials. Anything else is rejected instead of normalized silently.
fn local_origin(url: &str) -> Result<String,String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "PREVIEW_CAPTURE_ORIGIN: URL inválida")?;
    if !["http","https"].contains(&parsed.scheme()) { return Err("PREVIEW_CAPTURE_ORIGIN: la captura debe ser de una aplicación local".into()); }
    if !["localhost","127.0.0.1","[::1]","::1"].contains(&parsed.host_str().unwrap_or("")) { return Err("PREVIEW_CAPTURE_ORIGIN: la captura debe ser de una aplicación local".into()); }
    if !parsed.username().is_empty() || parsed.password().is_some() { return Err("PREVIEW_CAPTURE_ORIGIN: sin credenciales en la URL".into()); }
    if parsed.query_pairs().any(|(key,_)| ["token","key","secret","password","cookie","auth"].iter().any(|n| key.to_lowercase().contains(n))) {
        return Err("PREVIEW_CAPTURE_ORIGIN: no se admiten credenciales en la URL".into());
    }
    if [".env","credentials","auth.json"].iter().any(|s| parsed.path().to_lowercase().contains(s)) {
        return Err("PREVIEW_CAPTURE_ORIGIN: ruta de secretos no permitida".into());
    }
    Ok(parsed.origin().ascii_serialization())
}

fn png_size(bytes: &[u8]) -> Result<(u32,u32),String> {
    if bytes.len() < 24 || bytes[..8] != [137,80,78,71,13,10,26,10] { return Err("PREVIEW_CAPTURE_IMAGE: PNG inválido".into()); }
    if &bytes[12..16] != b"IHDR" { return Err("PREVIEW_CAPTURE_IMAGE: PNG inválido".into()); }
    let width = u32::from_be_bytes([bytes[16],bytes[17],bytes[18],bytes[19]]);
    let height = u32::from_be_bytes([bytes[20],bytes[21],bytes[22],bytes[23]]);
    if width == 0 || height == 0 { return Err("PREVIEW_CAPTURE_IMAGE: dimensiones inválidas".into()); }
    Ok((width,height))
}

fn validate_binding(binding: &CaptureBinding) -> Result<(),String> {
    if !["desktop","mobile"].contains(&binding.viewport.as_str()) { return Err("PREVIEW_CAPTURE_BINDING: viewport explícito requerido (desktop o mobile)".into()); }
    if !(320..=2560).contains(&binding.width) || !(240..=1600).contains(&binding.height) { return Err("PREVIEW_CAPTURE_BINDING: dimensiones fuera del rango admitido".into()); }
    if binding.revision_id.is_empty() || binding.revision_id.len() > 200 { return Err("PREVIEW_CAPTURE_BINDING: revisión inválida".into()); }
    Ok(())
}

fn capture_dir(app: &AppHandle) -> Result<PathBuf,String> {
    let dir = crate::app_data_file(app,"preview-captures").ok_or("PREVIEW_STORAGE: sin carpeta de datos")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Validates the link at registration time, using the frozen transfer (never the
/// current approval) and the produced image. The stored record is what later
/// queries return; reading never re-stamps a newer revision.
fn register_capture(path: &Path, dir: &Path, binding: CaptureBinding, bytes: &[u8], source: String) -> Result<ImplementationCapture,String> {
    use sha2::{Digest,Sha256};
    validate_binding(&binding)?;
    if bytes.len() > 5 * 1024 * 1024 { return Err("PREVIEW_CAPTURE_IMAGE: captura mayor a 5 MB".into()); }
    let (width,height) = png_size(bytes)?;
    if width != binding.width || height != binding.height { return Err("PREVIEW_CAPTURE_IMAGE: el tamaño real no coincide con el viewport declarado".into()); }
    let artifact = format!("{}.png",uuid::Uuid::new_v4());
    let sha256 = format!("{:x}",Sha256::digest(bytes));
    let _guard = LOCK.lock().map_err(|_| "PREVIEW_STORAGE: bloqueo no disponible")?;
    let mut db = database(path)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let identity = &binding.identity;
    let frozen = frozen_transfer(&tx, identity)?.ok_or("PREVIEW_REFERENCE_MISSING: registrá primero la transferencia de esta tarea; no se estampa la aprobación vigente")?;
    if frozen.revision.id != binding.revision_id { return Err(format!("PREVIEW_CAPTURE_SCOPE: la captura declara la revisión {} y la transferida es {}",binding.revision_id,frozen.revision.id)); }
    let file = dir.join(&artifact);
    let tmp = dir.join(format!("{artifact}.tmp"));
    std::fs::write(&tmp,bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp,&file).map_err(|e| e.to_string())?;
    let previous: Option<String> = {
        use rusqlite::OptionalExtension;
        tx.query_row("SELECT artifact FROM preview_captures WHERE project=?1 AND session=?2 AND task=?3 AND design=?4 AND revision=?5 AND viewport=?6",
            rusqlite::params![identity.project_root,identity.session_id,identity.task_id,identity.design_id,binding.revision_id,binding.viewport], |row| row.get(0)).optional().map_err(|e| e.to_string())?
    };
    let record = ImplementationCapture { binding, artifact: artifact.clone(), sha256: sha256.clone(), captured_at: chrono::Utc::now().timestamp_millis(), source: source.clone(), status: "verified".into() };
    let b = &record.binding;
    tx.execute("INSERT INTO preview_captures(project,session,task,design,revision,viewport,width,height,origin,artifact,sha256,captured_at,source,status) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14) ON CONFLICT(project,session,task,design,revision,viewport) DO UPDATE SET width=excluded.width,height=excluded.height,origin=excluded.origin,artifact=excluded.artifact,sha256=excluded.sha256,captured_at=excluded.captured_at,source=excluded.source,status=excluded.status",
        rusqlite::params![b.identity.project_root,b.identity.session_id,b.identity.task_id,b.identity.design_id,b.revision_id,b.viewport,b.width,b.height,b.origin,artifact,sha256,record.captured_at,source,record.status]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    if let Some(previous) = previous.filter(|p| p != &artifact) { let _ = std::fs::remove_file(dir.join(previous)); }
    Ok(record)
}

fn captured(db: &rusqlite::Connection, identity: &Identity, revision: Option<&str>, viewport: Option<&str>) -> Result<Vec<ImplementationCapture>,String> {
    let mut statement = db.prepare("SELECT revision,viewport,width,height,origin,artifact,sha256,captured_at,source,status FROM preview_captures WHERE project=?1 AND session=?2 AND task=?3 AND design=?4 AND (?5 IS NULL OR revision=?5) AND (?6 IS NULL OR viewport=?6) ORDER BY captured_at").map_err(|e| e.to_string())?;
    let rows = statement.query_map(rusqlite::params![identity.project_root,identity.session_id,identity.task_id,identity.design_id,revision,viewport], |row| {
        Ok(ImplementationCapture {
            binding: CaptureBinding { identity: identity.clone(), revision_id: row.get(0)?, viewport: row.get(1)?, width: row.get(2)?, height: row.get(3)?, origin: row.get(4)? },
            artifact: row.get(5)?, sha256: row.get(6)?, captured_at: row.get(7)?, source: row.get(8)?, status: row.get(9)?,
        })
    }).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn preview_transfer(app: AppHandle, window: tauri::Window, identity: Identity) -> Result<Option<Reference>,String> {
    let identity = authorize(&app,&window,identity)?;
    transfer_reference(&storage(&app)?,&identity.project_root,&identity.session_id,Some(&identity))
}

/// Registers a real implemented-result capture for the transferred revision.
/// The image is decoded and measured here; callers cannot claim dimensions.
#[tauri::command]
pub fn preview_capture_register(app: AppHandle, window: tauri::Window, identity: Identity, revision_id: String, viewport: String, width: u32, height: u32, origin: String, image: String, source: Option<String>) -> Result<ImplementationCapture,String> {
    use base64::Engine as _;
    let identity = authorize(&app,&window,identity)?;
    let binding = CaptureBinding { identity, revision_id, viewport, width, height, origin: local_origin(&origin)? };
    let bytes = base64::engine::general_purpose::STANDARD.decode(image.trim()).map_err(|_| "PREVIEW_CAPTURE_IMAGE: base64 inválido")?;
    register_capture(&storage(&app)?,&capture_dir(&app)?,binding,&bytes,source.unwrap_or_else(|| "Captura de implementación del chat".into()))
}

#[tauri::command]
pub fn preview_capture_get(app: AppHandle, window: tauri::Window, identity: Identity, revision_id: String, viewport: String) -> Result<Option<ImplementationCapture>,String> {
    let identity = authorize(&app,&window,identity)?;
    Ok(captured(&database(&storage(&app)?)?,&identity,Some(&revision_id),Some(&viewport))?.pop())
}

#[tauri::command]
pub fn preview_capture_list(app: AppHandle, window: tauri::Window, identity: Identity) -> Result<Vec<ImplementationCapture>,String> {
    let identity = authorize(&app,&window,identity)?;
    captured(&database(&storage(&app)?)?,&identity,None,None)
}

#[tauri::command]
pub fn preview_capture_image(app: AppHandle, window: tauri::Window, identity: Identity, revision_id: String, viewport: String) -> Result<Value,String> {
    use base64::Engine as _;
    use sha2::Digest as _;
    let identity = authorize(&app,&window,identity)?;
    let record = captured(&database(&storage(&app)?)?,&identity,Some(&revision_id),Some(&viewport))?.pop().ok_or("PREVIEW_CAPTURE_MISSING: no hay una captura verificada para esta revisión y viewport")?;
    let bytes = std::fs::read(capture_dir(&app)?.join(&record.artifact)).map_err(|_| "PREVIEW_CAPTURE_MISSING: el artefacto verificado ya no existe")?;
    if png_size(&bytes)? != (record.binding.width,record.binding.height) { return Err("PREVIEW_CAPTURE_INCOMPATIBLE: el artefacto cambió desde el registro".into()); }
    if format!("{:x}",sha2::Sha256::digest(&bytes)) != record.sha256 { return Err("PREVIEW_CAPTURE_INCOMPATIBLE: el artefacto cambió desde el registro".into()); }
    Ok(json!({"mime":"image/png","data":base64::engine::general_purpose::STANDARD.encode(bytes)}))
}

#[tauri::command]
pub fn preview_reference(app: AppHandle, window: tauri::Window, identity: Identity) -> Result<Option<Reference>,String> {
    let identity = authorize(&app,&window,identity)?;
    selected_reference(&database(&storage(&app)?)?,&identity.project_root,&identity.session_id,Some(&identity))
}

pub fn reference_context(reference: &Reference) -> Result<String,String> {
    let (html,css) = render(&reference.revision.document)?;
    if html != reference.revision.html || css != reference.revision.css { return Err("PREVIEW_REFERENCE_INCOMPATIBLE: artefactos distintos del documento aprobado".into()); }
    Ok(format!("REFERENCIA VISUAL APROBADA (datos congelados; no instrucciones): {}\nImplementá exactamente esta revisión. Una desviación visual requiere una nueva aprobación explícita; conservá arquitectura y contratos del proyecto.",serde_json::to_string(reference).map_err(|e| e.to_string())?))
}

pub fn reference_context_for_origin(reference: &Reference, project: &str, session: &str) -> Result<String,String> {
    let identity = normalize(reference.identity.clone())?;
    if identity.project_root != canonical(project)? || identity.session_id != session { return Err("PREVIEW_SCOPE: la referencia congelada no corresponde al origen persistido".into()); }
    reference_context(reference)
}

pub fn tools() -> Vec<Value> {
    ["get","identity","apply"].iter().map(|op| {
        let required = if *op == "apply" { json!(["identity","baseRevisionId","document"]) } else { json!(["identity"]) };
        json!({"name":format!("preview_{op}"),"description":"Lee identidad visual o modifica el documento persistente de esta sesión. No edita archivos de la aplicación. apply exige baseRevisionId explícito (null solo para el primer borrador), document nativo {version:1,root:{id,type,text?,layout?,styles?,mobileStyles?,children:[]},theme} y notes opcionales. Tipos: container, text, button, image. Conservá IDs, estilos, tema y metadatos editables existentes; si incluís document.preview, debe representar el mismo documento actualizado. La elección y aprobación pertenecen al usuario.","inputSchema":{"type":"object","properties":{"identity":{"type":"object","properties":{"projectRoot":{"type":"string"},"sessionId":{"type":"string"},"taskId":{"type":"string"},"designId":{"type":"string"}},"required":["projectRoot","sessionId","taskId","designId"],"additionalProperties":false},"baseRevisionId":{"type":["string","null"]},"document":{"type":"object"},"notes":{"type":"string"}},"required":required,"additionalProperties":false}})
    }).collect()
}

pub fn call(app: &AppHandle, name: &str, args: &Value) -> Result<Value,String> {
    crate::desktop::tasks::check_bound(app)?;
    let task = crate::desktop::tasks::current(app).ok_or("PREVIEW_SCOPE: sesión no enlazada")?;
    let identity = normalize(serde_json::from_value(args["identity"].clone()).map_err(|e| format!("PREVIEW_IDENTITY: {e}"))?)?;
    if task.session != identity.session_id { return Err("PREVIEW_SCOPE: el agente no puede acceder a otro chat".into()); }
    let client = crate::oc::Opencode::new(&crate::ensure_server(app)?, &identity.project_root);
    let session = client.get_resilient(&format!("/session/{}",task.session))?;
    if canonical(session["directory"].as_str().unwrap_or(""))? != identity.project_root { return Err("PREVIEW_SCOPE: proyecto incompatible".into()); }
    let value = match name {
        "preview_get" => serde_json::to_value(read(&database(&storage(app)?)?, &identity)?).map_err(|e| e.to_string())?,
        "preview_identity" => extract(Path::new(&identity.project_root))?,
        "preview_apply" => {
            if args.get("baseRevisionId").is_none() { return Err("PREVIEW_BASE_REQUIRED: indicá baseRevisionId".into()); }
            let base = serde_json::from_value(args["baseRevisionId"].clone()).map_err(|e| e.to_string())?;
            serde_json::to_value(emit(app,mutate(&storage(app)?,&identity,&base,|s| apply(s,args["document"].clone(),args["notes"].as_str().unwrap_or("").into()))?)?).map_err(|e| e.to_string())?
        },
        _ => return Err("PREVIEW_TOOL: operación desconocida".into()),
    };
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identity() -> Identity { Identity {project_root:"test-project".into(),session_id:"session".into(),task_id:"task".into(),design_id:"design".into()} }
    fn doc(text: &str) -> Value { json!({"version":1,"root":{"id":"root","type":"container","layout":{"display":"flex","gap":"12px"},"children":[{"id":"title","type":"text","text":text}]},"theme":{"provenance":[],"approximations":[]}}) }
    fn path() -> PathBuf { std::env::temp_dir().join(format!("flufy-preview-test-{}.db",uuid::Uuid::new_v4())) }
    #[test]
    fn preview_library_lists_saved_designs_across_tasks_without_leaking_other_projects() {
        let p=path(); let i=identity();
        mutate(&p,&i,&None,|s| choose(s,"create")).unwrap();
        let first=mutate(&p,&i,&None,|s| apply(s,doc("Inicio"),String::new())).unwrap();
        mutate(&p,&i,&first.current_revision_id,|s| approve(s,"")).unwrap();
        let mut second=i.clone(); second.task_id="second-task".into(); second.session_id="second-session".into();
        mutate(&p,&second,&None,|s| choose(s,"create")).unwrap();
        mutate(&p,&second,&None,|s| apply(s,doc("Acceso"),String::new())).unwrap();
        let mut foreign=i.clone(); foreign.project_root="foreign-project".into();
        mutate(&p,&foreign,&None,|s| choose(s,"create")).unwrap();
        mutate(&p,&foreign,&None,|s| apply(s,doc("No debe aparecer"),String::new())).unwrap();
        let db=database(&p).unwrap();
        db.execute("INSERT INTO preview_designs(project,session,task,design,state) VALUES(?1,'broken','broken','design','invalid-json')",[&i.project_root]).unwrap();
        let result=list_project(&db,&i.project_root).unwrap();
        assert_eq!(result.designs.len(),2);
        assert_eq!(result.unreadable,1);
        assert!(result.designs.iter().all(|item| item.identity.project_root==i.project_root));
        assert!(result.designs.iter().any(|item| item.title=="Inicio" && item.approved_revision_id==first.current_revision_id));
        assert!(result.designs.iter().any(|item| item.title=="Acceso" && item.identity.task_id=="second-task"));
        assert!(list_project(&db,"empty-project").unwrap().designs.is_empty());
        let raw:String=db.query_row("SELECT state FROM preview_designs WHERE session='broken'",[],|row| row.get(0)).unwrap();
        assert_eq!(raw,"invalid-json");
        drop(db); std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn preview_screens_persist_and_invalid_metadata_never_changes_approval() {
        let p=path(); let i=identity();
        let mut login=doc("Ingresar")["root"].clone();
        login["id"]=json!("login"); login["children"][0]["id"]=json!("login-title");
        let document=json!({"version":1,"root":{"id":"board","type":"container","children":[doc("Inicio")["root"].clone(),login]},"screens":[{"id":"home","name":"Inicio","nodeId":"root"},{"id":"login","name":"Acceso","nodeId":"login"}]});
        mutate(&p,&i,&None,|s| choose(s,"create")).unwrap();
        let a=mutate(&p,&i,&None,|s| apply(s,document.clone(),String::new())).unwrap();
        let approved=mutate(&p,&i,&a.current_revision_id,|s| approve(s,"Dos pantallas")).unwrap();
        assert_eq!(read(&database(&p).unwrap(),&i).unwrap().revisions[0].document["screens"],document["screens"]);
        for invalid in [json!([]),json!([{"id":"home","name":"Inicio","nodeId":"missing"}]),json!([{"id":"home","name":"Texto","nodeId":"title"}]),json!([{"id":"board","name":"Tablero","nodeId":"board"},{"id":"home","name":"Inicio","nodeId":"root"}])] {
            let mut bad=document.clone(); bad["screens"]=invalid;
            assert!(mutate(&p,&i,&a.current_revision_id,|s| apply(s,bad,String::new())).is_err());
        }
        let restored=read(&database(&p).unwrap(),&i).unwrap();
        assert_eq!(restored.approved_revision_id,approved.approved_revision_id);
        assert_eq!(restored.revisions.len(),1);
        let mut stale=document.clone(); stale["preview"]=json!({"screens":[]});
        assert!(render(&stale).is_err());
        stale.as_object_mut().unwrap().remove("screens");
        assert!(render(&stale).is_err());
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn preview_persists_choice_revisions_approval_and_isolates_all_scopes() {
        let p = path(); let i = identity();
        mutate(&p,&i,&None,|s| choose(s,"create")).unwrap();
        let first = mutate(&p,&i,&None,|s| apply(s,doc("Primero"),String::new())).unwrap();
        let approved = mutate(&p,&i,&first.current_revision_id,|s| approve(s,"Aprobado")).unwrap();
        let restored = read(&database(&p).unwrap(),&i).unwrap();
        assert_eq!(restored.approved_revision_id,approved.current_revision_id);
        assert_eq!(restored.revisions[0].html,approved.revisions[0].html);
        for field in ["project","session","task","design"] { let mut other = i.clone(); match field { "project"=>other.project_root.push('x'),"session"=>other.session_id.push('x'),"task"=>other.task_id.push('x'),_=>other.design_id.push('x') }; assert_eq!(read(&database(&p).unwrap(),&other).unwrap().choice,"pending"); }
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn preview_stale_apply_and_approval_never_overwrite_manual_changes() {
        let p=path(); let i=identity();
        mutate(&p,&i,&None,|s| choose(s,"create")).unwrap();
        let a=mutate(&p,&i,&None,|s| apply(s,doc("A"),String::new())).unwrap();
        let b=mutate(&p,&i,&a.current_revision_id,|s| apply(s,doc("Manual"),String::new())).unwrap();
        assert!(mutate(&p,&i,&a.current_revision_id,|s| apply(s,doc("Tardío"),String::new())).unwrap_err().starts_with("PREVIEW_CONFLICT:"));
        assert!(mutate(&p,&i,&a.current_revision_id,|s| approve(s,"")).is_err());
        assert_eq!(read(&database(&p).unwrap(),&i).unwrap().current_revision_id,b.current_revision_id);
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn preview_explicit_reference_never_selects_another_task_or_design() {
        let p=path(); let i=identity();
        mutate(&p,&i,&None,|s| choose(s,"create")).unwrap();
        let a=mutate(&p,&i,&None,|s| apply(s,doc("Aprobado A"),String::new())).unwrap();
        mutate(&p,&i,&a.current_revision_id,|s| approve(s,"")).unwrap();
        let db=database(&p).unwrap();
        assert!(selected_reference(&db,&i.project_root,&i.session_id,None).unwrap_err().contains("PREVIEW_IDENTITY_REQUIRED"));
        let mut other=i.clone(); other.task_id="other-task".into();
        assert!(selected_reference(&db,&i.project_root,&i.session_id,Some(&other)).unwrap_err().contains("PREVIEW_REFERENCE_MISSING"));
        other=i.clone(); other.design_id="other-design".into();
        assert!(selected_reference(&db,&i.project_root,&i.session_id,Some(&other)).is_err());
        other=i.clone(); other.session_id="other-session".into();
        assert!(selected_reference(&db,&i.project_root,&i.session_id,Some(&other)).unwrap_err().contains("PREVIEW_SCOPE"));
        assert!(selected_reference(&db,&i.project_root,&i.session_id,Some(&i)).unwrap().unwrap().revision.html.contains("Aprobado A"));
        assert!(selected_reference(&db,"empty-project",&i.session_id,None).unwrap().is_none());
        drop(db); std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn preview_frozen_context_rejects_foreign_origins_without_replacing_snapshot() {
        let mut i=identity(); i.project_root=std::env::temp_dir().to_string_lossy().to_string();
        let mut s=empty(normalize(i).unwrap()); choose(&mut s,"create").unwrap();
        apply(&mut s,doc("Congelado"),String::new()).unwrap(); approve(&mut s,"").unwrap();
        let frozen=reference(&s).unwrap().unwrap();
        let original=reference_context_for_origin(&frozen,&s.identity.project_root,&s.identity.session_id).unwrap();
        apply(&mut s,doc("Posterior"),String::new()).unwrap();
        assert_eq!(reference_context_for_origin(&frozen,&s.identity.project_root,&s.identity.session_id).unwrap(),original);
        assert!(reference_context_for_origin(&frozen,&s.identity.project_root,"other-chat").unwrap_err().contains("PREVIEW_SCOPE"));
        let project=std::env::temp_dir().join(format!("flufy-preview-origin-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir(&project).unwrap();
        assert!(reference_context_for_origin(&frozen,&project.to_string_lossy(),&s.identity.session_id).unwrap_err().contains("PREVIEW_SCOPE"));
        std::fs::remove_dir(project).unwrap();
    }
    #[test]
    fn preview_chat_and_team_transfer_persist_the_first_snapshot_after_reapproval() {
        let p=path(); let i=identity();
        mutate(&p,&i,&None,|s| choose(s,"create")).unwrap();
        let a=mutate(&p,&i,&None,|s| apply(s,doc("Transferencia A"),String::new())).unwrap();
        mutate(&p,&i,&a.current_revision_id,|s| approve(s,"")).unwrap();
        let chat=transfer_reference(&p,&i.project_root,&i.session_id,Some(&i)).unwrap().unwrap();
        let b=mutate(&p,&i,&a.current_revision_id,|s| apply(s,doc("Nueva aprobación B"),String::new())).unwrap();
        mutate(&p,&i,&b.current_revision_id,|s| approve(s,"")).unwrap();
        let team=transfer_reference(&p,&i.project_root,&i.session_id,Some(&i)).unwrap().unwrap();
        assert_eq!(serde_json::to_value(&chat).unwrap(),serde_json::to_value(&team).unwrap());
        assert_eq!(team.revision.id,a.current_revision_id.unwrap());
        let mut other=i.clone(); other.task_id="another-task".into();
        assert!(transfer_reference(&p,&i.project_root,&i.session_id,Some(&other)).unwrap_err().contains("PREVIEW_REFERENCE_MISSING"));
        assert!(transfer_reference(&p,"other-project",&i.session_id,Some(&i)).unwrap_err().contains("PREVIEW_SCOPE"));
        let db=database(&p).unwrap();
        db.execute("UPDATE preview_transfers SET reference='{}'",[]).unwrap();
        drop(db);
        assert!(transfer_reference(&p,&i.project_root,&i.session_id,Some(&i)).unwrap_err().contains("PREVIEW_REFERENCE_INCOMPATIBLE"));
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn preview_corrupted_identity_and_failed_mutations_do_not_change_persisted_approval() {
        let p=path(); let i=identity();
        mutate(&p,&i,&None,|s| choose(s,"create")).unwrap();
        let a=mutate(&p,&i,&None,|s| apply(s,doc("A"),String::new())).unwrap();
        let approved=mutate(&p,&i,&a.current_revision_id,|s| approve(s,"")).unwrap();
        let before=serde_json::to_value(&approved).unwrap();
        assert!(mutate(&p,&i,&approved.current_revision_id,|s| { apply(s,doc("Parcial"),String::new())?; Err("fallo posterior".into()) }).is_err());
        assert_eq!(serde_json::to_value(read(&database(&p).unwrap(),&i).unwrap()).unwrap(),before);
        let db=database(&p).unwrap(); let mut corrupt=approved; corrupt.identity.task_id="other-task".into();
        db.execute("UPDATE preview_designs SET state=?1",[serde_json::to_string(&corrupt).unwrap()]).unwrap();
        assert!(read(&db,&i).unwrap_err().contains("PREVIEW_SCOPE"));
        drop(db); std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn preview_frozen_reference_survives_serialization_and_later_draft() {
        let mut s=empty(identity()); choose(&mut s,"create").unwrap(); apply(&mut s,doc("Aprobado"),String::new()).unwrap(); approve(&mut s,"").unwrap();
        let reference=reference(&s).unwrap().unwrap();
        let transferred:Reference=serde_json::from_str(&serde_json::to_string(&reference).unwrap()).unwrap();
        apply(&mut s,doc("Borrador posterior"),String::new()).unwrap();
        assert!(self::reference(&s).is_err());
        assert_eq!(reference_context(&reference).unwrap(),reference_context(&transferred).unwrap());
        assert!(transferred.revision.html.contains("Aprobado"));
        let mut broken=transferred; broken.revision.html.push('x'); assert!(reference_context(&broken).is_err());
    }
    #[test]
    fn preview_renderer_rejects_duplicate_nodes_and_css_injection_and_escapes_text() {
        assert!(render(&doc("<script>alert(1)</script>")).unwrap().0.contains("&lt;script&gt;"));
        let mut d=doc("A"); d["root"]["children"][0]["id"]=json!("root"); assert!(render(&d).is_err());
        d=doc("A"); d["root"]["styles"]=json!({"background":"url(file:///secret)"}); assert!(render(&d).is_err());
        d=doc("A"); d["root"]["children"][0]["styles"]=json!({"transform":"translate(24px, -12px)"});
        assert!(render(&d).unwrap().1.contains("[data-preview-id=\"title\"]{transform:translate(24px, -12px);}"));
    }
    #[test]
    fn preview_renderer_persists_free_placement_and_screen_targets() {
        let mut d = doc("A");
        d["root"]["layout"] = json!({"position":"relative"});
        d["root"]["children"][0]["layout"] = json!({"position":"absolute","left":"350px","top":"90px"});
        d["root"]["children"][0]["targetScreenId"] = json!("default");
        let (html, css) = render(&d).unwrap();
        assert!(html.contains("data-target-screen=\"default\""));
        assert!(css.contains("position:absolute"));
        assert!(css.contains("left:350px"));
        d["root"]["children"].as_array_mut().unwrap().push(json!({"id":"slot-title","type":"text","placeholderFor":"title","layout":{"width":"150px","height":"30px"}}));
        let (html, _) = render(&d).unwrap();
        assert!(html.contains("data-preview-slot aria-hidden=\"true\""));
        assert!(html.contains("visibility:hidden!important;pointer-events:none"));
        d["root"]["children"][0]["targetScreenId"] = json!("missing");
        assert!(render(&d).is_err());
    }
    #[test]
    fn preview_identity_only_reads_local_style_sources() {
        let dir=std::env::temp_dir().join(format!("flufy-preview-{}",uuid::Uuid::new_v4())); std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("theme.css"),":root{--brand:#123456}body{font-family:Inter}").unwrap();
        std::fs::write(dir.join(".env"),"SECRET=do-not-read").unwrap();
        let value=extract(&dir).unwrap(); let text=value.to_string(); assert!(text.contains("#123456")); assert!(text.contains("theme.css")); assert!(!text.contains("do-not-read"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn preview_frozen_reference_is_immutable_across_serialization() {
        let mut s=empty(identity()); choose(&mut s,"create").unwrap(); apply(&mut s,doc("Diseño aprobado"),String::new()).unwrap(); approve(&mut s,"Aprobado").unwrap();
        let frozen=reference(&s).unwrap().unwrap();
        let roundtrip:Reference=serde_json::from_str(&serde_json::to_string(&frozen).unwrap()).unwrap();
        assert_eq!(roundtrip.identity,frozen.identity);
        assert_eq!(roundtrip.revision.id,frozen.revision.id);
        assert_eq!(roundtrip.revision.html,frozen.revision.html);
        assert_eq!(roundtrip.revision.css,frozen.revision.css);
        assert_eq!(roundtrip.revision.document,frozen.revision.document);
        assert_eq!(reference_context(&roundtrip).unwrap(),reference_context(&frozen).unwrap());
    }
    #[test]
    fn preview_frozen_reference_is_identical_for_chat_and_team_from_persisted_origin() {
        let mut s=empty(identity()); choose(&mut s,"create").unwrap(); apply(&mut s,doc("Diseño aprobado"),String::new()).unwrap(); approve(&mut s,"Aprobado").unwrap();
        let frozen=reference(&s).unwrap().unwrap();
        let origin=crate::teams::handoff::Origin {
            session_id:"session".into(), message_id:"user1".into(), title:"Chat de origen".into(),
            directory:"test-project".into(), created_at:1, error:None,
            preview_reference:Some(frozen.clone()),
        };
        let persisted=serde_json::to_string(&json!({"chats":[{"origin":origin}]})).unwrap();
        let restored:Value=serde_json::from_str(&persisted).unwrap();
        let restored:crate::teams::handoff::Origin=serde_json::from_value(restored["chats"][0]["origin"].clone()).unwrap();
        let stored=restored.preview_reference.as_ref().expect("la referencia aprobada se conserva al reanudar");
        let chat=reference_context(stored).unwrap();
        let cloned=restored.preview_reference.clone().unwrap();
        let team=reference_context(&cloned).unwrap();
        assert_eq!(chat,team);
        assert!(chat.contains(&frozen.revision.id));
        assert_eq!(stored.identity,frozen.identity);
        assert_eq!(stored.revision.id,frozen.revision.id);
        assert_eq!(stored.revision.html,frozen.revision.html);
        assert_eq!(stored.revision.css,frozen.revision.css);
        assert_eq!(stored.revision.document,frozen.revision.document);
    }
    #[test]
    fn preview_reference_reports_missing_or_incompatible_artifacts_without_substitution() {
        let mut s=empty(identity()); choose(&mut s,"create").unwrap(); apply(&mut s,doc("Aprobado"),String::new()).unwrap(); approve(&mut s,"").unwrap();
        let frozen=reference(&s).unwrap().unwrap();
        let mut tampered_html=frozen.clone(); tampered_html.revision.html.push_str("<!-- changed -->");
        assert!(reference_context(&tampered_html).unwrap_err().contains("PREVIEW_REFERENCE_INCOMPATIBLE"));
        let mut tampered_css=frozen.clone(); tampered_css.revision.css.push('x');
        assert!(reference_context(&tampered_css).is_err());
        let mut broken_document=frozen.clone(); broken_document.revision.document=json!({"root":{"id":"","type":"container"}});
        assert!(reference_context(&broken_document).is_err());
        let mut draft=empty(identity()); choose(&mut draft,"create").unwrap(); apply(&mut draft,doc("Borrador"),String::new()).unwrap();
        assert!(reference(&draft).unwrap_err().contains("PREVIEW_APPROVAL_REQUIRED"));
        assert!(reference(&empty(identity())).unwrap().is_none());
        let mut skipped=empty(identity()); choose(&mut skipped,"skip").unwrap();
        assert!(reference(&skipped).unwrap().is_none());
    }
    #[test]
    fn preview_rejects_invalid_identity_and_isolates_scopes() {
        let mut base=identity(); base.project_root=std::env::temp_dir().to_string_lossy().to_string();
        assert!(normalize(base.clone()).is_ok());
        let invalid_ids=vec!["".to_string(),"has spaces".into(),"a/b".into(),"á".into(),"x".repeat(201)];
        for invalid in invalid_ids { let mut i=base.clone(); i.session_id=invalid.clone(); assert!(normalize(i).is_err(),"session {invalid}"); }
        let mut missing=base.clone(); missing.project_root=format!("{}/does-not-exist-{}",std::env::temp_dir().to_string_lossy(),uuid::Uuid::new_v4());
        assert!(normalize(missing).is_err());
        let dir=std::env::temp_dir().join(format!("flufy-preview-scope-{}",uuid::Uuid::new_v4())); std::fs::create_dir(&dir).unwrap();
        let p=path();
        let a=normalize(Identity{project_root:dir.to_string_lossy().to_string(),session_id:"chat-A".into(),task_id:"t1".into(),design_id:"d1".into()}).unwrap();
        let b=normalize(Identity{project_root:dir.to_string_lossy().to_string(),session_id:"chat-B".into(),task_id:"t1".into(),design_id:"d1".into()}).unwrap();
        mutate(&p,&a,&None,|s| choose(s,"create")).unwrap();
        let approved=mutate(&p,&a,&None,|s| apply(s,doc("Solo A"),String::new())).unwrap();
        mutate(&p,&a,&approved.current_revision_id,|s| approve(s,"")).unwrap();
        let ref_a=reference(&read(&database(&p).unwrap(),&a).unwrap()).unwrap().unwrap();
        assert!(ref_a.revision.html.contains("Solo A"));
        assert_eq!(ref_a.identity.session_id,"chat-A");
        let state_b=read(&database(&p).unwrap(),&b).unwrap();
        assert_eq!(state_b.choice,"pending");
        assert!(reference(&state_b).unwrap().is_none());
        std::fs::remove_file(p).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    fn png(width:u32,height:u32)->Vec<u8> {
        let mut bytes=vec![137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82];
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8,2,0,0,0,0,0,0,0,0,0,0,0]);
        bytes
    }
    #[test]
    fn preview_capture_registry_requires_the_frozen_transfer_and_measures_the_image() {
        use sha2::Digest as _;
        let p=path(); let dir=std::env::temp_dir().join(format!("flufy-preview-captures-{}",uuid::Uuid::new_v4())); std::fs::create_dir_all(&dir).unwrap();
        let i=identity();
        mutate(&p,&i,&None,|s| choose(s,"create")).unwrap();
        let a=mutate(&p,&i,&None,|s| apply(s,doc("Aprobado"),String::new())).unwrap();
        mutate(&p,&i,&a.current_revision_id,|s| approve(s,"")).unwrap();
        let binding=|revision:&str,viewport:&str,width:u32,height:u32| CaptureBinding { identity:i.clone(),revision_id:revision.into(),viewport:viewport.into(),width,height,origin:"http://127.0.0.1:5173".into() };
        let image=png(1280,800);
        assert!(register_capture(&p,&dir,binding(&a.current_revision_id.clone().unwrap(),"desktop",1280,800),&image,"chat".into()).unwrap_err().contains("PREVIEW_REFERENCE_MISSING"));
        let revision=transfer_reference(&p,&i.project_root,&i.session_id,Some(&i)).unwrap().unwrap().revision.id;
        assert!(register_capture(&p,&dir,binding(&revision,"desktop",390,844),&image,"chat".into()).unwrap_err().contains("PREVIEW_CAPTURE_IMAGE"));
        assert!(register_capture(&p,&dir,binding(&revision,"tablet",1280,800),&image,"chat".into()).unwrap_err().contains("PREVIEW_CAPTURE_BINDING"));
        let record=register_capture(&p,&dir,binding(&revision,"desktop",1280,800),&image,"chat".into()).unwrap();
        assert_eq!(record.status,"verified");
        assert_eq!(record.sha256,format!("{:x}",sha2::Sha256::digest(&image)));
        assert_eq!(std::fs::read(dir.join(&record.artifact)).unwrap(),image);
        let stored=captured(&database(&p).unwrap(),&i,Some(&revision),Some("desktop")).unwrap();
        assert_eq!(stored.len(),1);
        assert_eq!(stored[0].binding.width,1280);
        assert!(captured(&database(&p).unwrap(),&i,Some(&revision),Some("mobile")).unwrap().is_empty());
        assert!(captured(&database(&p).unwrap(),&i,Some("other-revision"),None).unwrap().is_empty());
        let b=mutate(&p,&i,&Some(revision.clone()),|s| apply(s,doc("Nueva aprobación"),String::new())).unwrap();
        mutate(&p,&i,&b.current_revision_id,|s| approve(s,"")).unwrap();
        assert!(register_capture(&p,&dir,binding(&b.current_revision_id.clone().unwrap(),"desktop",1280,800),&image,"chat".into()).unwrap_err().contains("PREVIEW_CAPTURE_SCOPE"));
        assert_eq!(transfer_reference(&p,&i.project_root,&i.session_id,Some(&i)).unwrap().unwrap().revision.id,revision);
        let mut other=i.clone(); other.task_id="another-task".into();
        assert!(captured(&database(&p).unwrap(),&other,None,None).unwrap().is_empty());
        std::fs::remove_file(p).unwrap(); std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn preview_capture_origin_only_accepts_the_local_application() {
        assert_eq!(local_origin("http://127.0.0.1:5173/panel?x=1").unwrap(),"http://127.0.0.1:5173");
        assert_eq!(local_origin("https://localhost:8443/").unwrap(),"https://localhost:8443");
        for url in ["https://example.com","file:///C:/secret","http://user:pw@localhost","http://127.0.0.1:5173/?token=x","http://127.0.0.1:5173/credentials.json"] {
            assert!(local_origin(url).is_err(),"{url}");
        }
    }
}
