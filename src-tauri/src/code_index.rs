// Índice de código local: símbolos, imports y búsqueda híbrida para el agente.
// Todo vive en la PC del usuario; el motor solo ve las herramientas MCP.
use crate::{app_data_file, ensure_server};
use ignore::WalkBuilder;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MAX_FILE_BYTES: u64 = 1_500_000;
const MAX_FILES: usize = 20_000;
const CHUNK_LINES: usize = 48;
const CHUNK_OVERLAP: usize = 8;
const HEAVY_DIRS: [&str; 12] = ["node_modules", "target", "dist", "build", ".next", ".turbo", ".git", "coverage", ".venv", "venv", "__pycache__", ".cache"];
const SUPPORTED: [&str; 34] = [
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "kts", "cs", "cpp", "cc", "c", "h", "hpp", "rb", "php", "swift", "scala", "sh", "ps1", "sql", "md", "json", "yaml", "yml", "toml", "css", "scss", "html", "vue",
];

pub const INSTRUCTIONS: &str = "Tenés un índice local del proyecto. Usá code_search para encontrar código por concepto, nombre de símbolo o texto; code_symbols para listar definiciones; code_context para traer fragmentos listos para leer; y code_apply_patch para aplicar ediciones verificadas. Preferí estas herramientas antes de recorrer carpetas a ciegas. code_apply_patch valida el texto original, rechaza coincidencias ambiguas y permite dryRun. Después de aplicar, comprobá con la terminal o los tests del proyecto.";

static BUSY: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
static INDEX_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct CodeIndexConfig {
    pub enabled: bool,
    pub refresh_minutes: u64,
    pub max_files: usize,
    pub max_file_bytes: u64,
    pub include: String,
    pub exclude: String,
}

impl Default for CodeIndexConfig {
    fn default() -> Self {
        CodeIndexConfig {
            enabled: true,
            refresh_minutes: 2,
            max_files: MAX_FILES,
            max_file_bytes: MAX_FILE_BYTES,
            include: String::new(),
            exclude: String::new(),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub enabled: bool,
    pub root: String,
    pub files: usize,
    pub symbols: usize,
    pub chunks: usize,
    pub updated: i64,
    pub busy: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub score: f64,
    pub reason: String,
    pub snippet: String,
    pub symbols: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Edit {
    old_text: String,
    new_text: String,
    #[serde(default)]
    replace_all: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilePatch {
    path: String,
    #[serde(default)]
    edits: Vec<Edit>,
    #[serde(default)]
    create: Option<String>,
    #[serde(default)]
    expected_hash: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn slug(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    let base = normalized.trim_end_matches('/').rsplit('/').next().unwrap_or("workspace").to_lowercase();
    let mut out = String::new();
    let mut dash = false;
    for c in base.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() { "workspace".into() } else { out.chars().take(40).collect() }
}

fn index_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("code-index");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn db_path(app: &AppHandle, root: &Path) -> Result<PathBuf, String> {
    let dir = index_dir(app).ok_or("no encontré la carpeta de datos de Flufy")?;
    let normalized = root.to_string_lossy().to_lowercase();
    let digest = sha256(normalized.as_bytes());
    Ok(dir.join(format!("{}-{}.sqlite", slug(&root.to_string_lossy()), &digest[..12])))
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app_data_file(app, "code-index.json")
}

pub fn load_config(app: &AppHandle) -> CodeIndexConfig {
    config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, config: &CodeIndexConfig) -> Result<(), String> {
    let path = config_path(app).ok_or("no encontré la carpeta de datos de Flufy")?;
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("no pude guardar la configuración del índice: {}", e))
}

fn root_for(app: &AppHandle) -> Result<PathBuf, String> {
    let server = ensure_server(app)?;
    let root = PathBuf::from(server.worktree);
    if !root.is_dir() {
        return Err(format!("la carpeta del proyecto no existe: {}", root.display()));
    }
    Ok(root)
}

fn open_db(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| format!("no pude abrir el índice: {}", e))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, lang TEXT NOT NULL, lines INTEGER NOT NULL, indexed_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS symbols (path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, signature TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
         CREATE INDEX IF NOT EXISTS symbols_path ON symbols(path);
         CREATE TABLE IF NOT EXISTS edges (src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
         CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
         CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(path UNINDEXED, start_line UNINDEXED, end_line UNINDEXED, text);",
    )
    .map_err(|e| format!("no pude preparar el índice: {}", e))?;
    Ok(conn)
}

fn meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |row| row.get(0)).optional().ok().flatten()
}

fn set_meta(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value]);
}

fn lang_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "go" => "go",
        "java" | "kt" | "kts" => "jvm",
        "cs" => "csharp",
        "c" | "h" => "c",
        "cpp" | "cc" | "hpp" => "cpp",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "scala" => "scala",
        "sh" | "ps1" => "shell",
        "sql" => "sql",
        "md" => "markdown",
        "json" | "yaml" | "yml" | "toml" => "config",
        "css" | "scss" | "html" | "vue" => "web",
        _ => "text",
    }
}

fn supported(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).map(|e| SUPPORTED.contains(&e.to_lowercase().as_str())).unwrap_or(false)
}

fn walker(root: &Path, config: &CodeIndexConfig) -> Result<ignore::Walk, String> {
    let mut overrides = ignore::overrides::OverrideBuilder::new(root);
    for glob in config.include.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        overrides.add(glob).map_err(|e| format!("glob inválido {}: {}", glob, e))?;
    }
    for glob in config.exclude.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        overrides.add(&format!("!{}", glob)).map_err(|e| format!("glob inválido {}: {}", glob, e))?;
    }
    let overrides = overrides.build().map_err(|e| e.to_string())?;
    Ok(WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .overrides(overrides)
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            !(e.file_type().map(|t| t.is_dir()).unwrap_or(false) && HEAVY_DIRS.contains(&name.as_str()))
        })
        .build())
}

#[derive(Clone)]
struct Symbol {
    name: String,
    kind: &'static str,
    line: usize,
    signature: String,
}

#[derive(Clone)]
struct Chunk {
    start: usize,
    end: usize,
    text: String,
}

struct Pending {
    rel: String,
    mtime: i64,
    size: i64,
    hash: String,
    lang: &'static str,
    lines: usize,
    symbols: Vec<Symbol>,
    imports: Vec<String>,
    chunks: Vec<Chunk>,
}

fn regex_set() -> &'static Vec<(Regex, &'static str)> {
    static SET: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    SET.get_or_init(|| {
        let patterns: Vec<(&str, &'static str)> = vec![
            (r"(?m)^\s*(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+\S+\s+)?(?:fn|function|def|func|fun)\s+([A-Za-z_]\w*)", "function"),
            (r"(?m)^\s*(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:abstract\s+|final\s+|sealed\s+|data\s+)?(?:class|struct|interface|trait|enum|type|record|object|module)\s+([A-Za-z_]\w*)", "type"),
            (r"(?m)^\s*(?:export\s+)?(?:pub\s+)?(?:const|let|var|static)\s+([A-Za-z_]\w*)\s*[:=]", "variable"),
            (r"(?m)^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>,\s]+\s+for\s+)?([A-Za-z_]\w*)", "impl"),
        ];
        patterns.into_iter().filter_map(|(p, kind)| Regex::new(p).ok().map(|r| (r, kind))).collect()
    })
}

fn symbols_for(text: &str) -> Vec<Symbol> {
    let mut out: Vec<Symbol> = Vec::new();
    let mut seen: HashSet<(String, usize)> = HashSet::new();
    for (index, line) in text.lines().enumerate() {
        let number = index + 1;
        if line.len() > 400 {
            continue;
        }
        for (regex, kind) in regex_set() {
            let Some(caps) = regex.captures(line) else { continue };
            let Some(name) = caps.get(1).map(|m| m.as_str()) else { continue };
            if name.len() < 2 || seen.contains(&(name.to_string(), number)) {
                continue;
            }
            seen.insert((name.to_string(), number));
            out.push(Symbol {
                name: name.to_string(),
                kind,
                line: number,
                signature: line.trim().chars().take(200).collect(),
            });
        }
    }
    out
}

fn import_specs(text: &str) -> Vec<String> {
    static RE: OnceLock<Vec<Regex>> = OnceLock::new();
    let regexes = RE.get_or_init(|| {
        [
            r#"(?m)^\s*import\s+[^;]*?\bfrom\s+["']([^"']+)["']"#,
            r#"(?m)^\s*import\s+["']([^"']+)["']"#,
            r#"require\(\s*["']([^"']+)["']\s*\)"#,
            r"(?m)^\s*use\s+([A-Za-z_][\w:]*)",
            r"(?m)^\s*from\s+([\w.]+)\s+import",
            r#"(?m)^\s*#include\s+[<"]([^>"]+)[>"]"#,
            r#"(?m)^\s*using\s+([\w.]+)\s*;"#,
        ]
        .iter()
        .filter_map(|p| Regex::new(p).ok())
        .collect()
    });
    let mut out = Vec::new();
    for regex in regexes {
        for caps in regex.captures_iter(text) {
            if let Some(spec) = caps.get(1) {
                let value = spec.as_str().trim();
                if !value.is_empty() && value.len() < 300 && !out.iter().any(|x: &String| x == value) {
                    out.push(value.to_string());
                }
            }
        }
    }
    out
}

fn normalize_rel(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn resolve_import(src: &str, spec: &str, files: &BTreeSet<String>) -> Option<String> {
    let src_dir = Path::new(src).parent().unwrap_or(Path::new(""));
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut push = |base: PathBuf| {
        let base = base;
        if base.extension().is_none() {
            for ext in ["ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "java", "cs", "cpp", "h", "rb", "php", "swift", "scala"] {
                candidates.push(base.with_extension(ext));
            }
            candidates.push(base.join("index.ts"));
            candidates.push(base.join("index.tsx"));
            candidates.push(base.join("index.js"));
            candidates.push(base.join("mod.rs"));
        } else {
            candidates.push(base.clone());
            if base.extension().and_then(|e| e.to_str()) == Some("js") {
                candidates.push(base.with_extension("ts"));
                candidates.push(base.with_extension("tsx"));
            }
        }
    };
    if spec.starts_with('.') {
        push(src_dir.join(spec));
    } else if let Some(rest) = spec.strip_prefix("crate::").or_else(|| spec.strip_prefix("self::")) {
        push(Path::new("src").join(rest.replace("::", "/")));
    } else if let Some(rest) = spec.strip_prefix("@/").or_else(|| spec.strip_prefix("~/")) {
        push(Path::new("src").join(rest));
    } else if spec.starts_with("src/") || spec.starts_with("app/") {
        push(PathBuf::from(spec));
    } else if spec.contains("::") {
        push(PathBuf::from(spec.replace("::", "/")));
    }
    for candidate in candidates {
        let mut clean = PathBuf::new();
        for comp in candidate.components() {
            match comp {
                Component::ParentDir => {
                    clean.pop();
                }
                Component::CurDir => {}
                other => clean.push(other.as_os_str()),
            }
        }
        let rel = normalize_rel(&clean);
        if files.contains(&rel) {
            return Some(rel);
        }
    }
    None
}

fn chunks_for(text: &str) -> Vec<Chunk> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < lines.len() {
        let end = (start + CHUNK_LINES).min(lines.len());
        let slice = lines[start..end].join("\n");
        if !slice.trim().is_empty() {
            out.push(Chunk { start: start + 1, end, text: slice });
        }
        if end == lines.len() {
            break;
        }
        start = end.saturating_sub(CHUNK_OVERLAP);
    }
    out
}

fn collect_pending(root: &Path, config: &CodeIndexConfig, existing: &HashMap<String, (i64, i64, String)>) -> Result<(Vec<Pending>, BTreeSet<String>, usize), String> {
    let mut pending = Vec::new();
    let mut seen = BTreeSet::new();
    let mut skipped = 0usize;
    for entry in walker(root, config)?.flatten() {
        if seen.len() >= config.max_files {
            skipped += 1;
            continue;
        }
        let path = entry.path();
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) || !supported(path) {
            continue;
        }
        let rel = match path.strip_prefix(root) {
            Ok(value) => normalize_rel(value),
            Err(_) => continue,
        };
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > config.max_file_bytes || meta.len() == 0 {
            continue;
        }
        seen.insert(rel.clone());
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
        let size = meta.len() as i64;
        if let Some((old_mtime, old_size, old_hash)) = existing.get(&rel) {
            if *old_mtime == mtime && *old_size == size {
                continue;
            }
            let _ = old_hash;
        }
        let Ok(bytes) = std::fs::read(path) else { continue };
        if bytes.iter().take(8000).any(|b| *b == 0) {
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else { continue };
        let hash = sha256(text.as_bytes());
        if let Some((_, _, old_hash)) = existing.get(&rel) {
            if old_hash == &hash {
                continue;
            }
        }
        pending.push(Pending {
            rel,
            mtime,
            size,
            hash,
            lang: lang_for(path),
            lines: text.lines().count(),
            symbols: symbols_for(&text),
            imports: import_specs(&text),
            chunks: chunks_for(&text),
        });
    }
    Ok((pending, seen, skipped))
}

fn replace_file(conn: &Connection, item: &Pending, files: &BTreeSet<String>) -> Result<(), String> {
    conn.execute("DELETE FROM symbols WHERE path = ?1", params![item.rel]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM edges WHERE src = ?1", params![item.rel]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM chunks WHERE path = ?1", params![item.rel]).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO files (path, mtime, size, hash, lang, lines, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, hash = excluded.hash, lang = excluded.lang, lines = excluded.lines, indexed_at = excluded.indexed_at",
        params![item.rel, item.mtime, item.size, item.hash, item.lang, item.lines as i64, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    for symbol in &item.symbols {
        conn.execute(
            "INSERT INTO symbols (path, name, kind, line, signature) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![item.rel, symbol.name, symbol.kind, symbol.line as i64, symbol.signature],
        )
        .map_err(|e| e.to_string())?;
    }
    for spec in &item.imports {
        if let Some(dst) = resolve_import(&item.rel, spec, files) {
            if dst != item.rel {
                conn.execute("INSERT INTO edges (src, dst, kind) VALUES (?1, ?2, 'import')", params![item.rel, dst]).map_err(|e| e.to_string())?;
            }
        }
    }
    for chunk in &item.chunks {
        conn.execute(
            "INSERT INTO chunks (path, start_line, end_line, text) VALUES (?1, ?2, ?3, ?4)",
            params![item.rel, chunk.start as i64, chunk.end as i64, chunk.text],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn counts(conn: &Connection) -> (usize, usize, usize) {
    let one = |sql: &str| conn.query_row(sql, [], |row| row.get::<_, i64>(0)).unwrap_or(0) as usize;
    (one("SELECT COUNT(*) FROM files"), one("SELECT COUNT(*) FROM symbols"), one("SELECT COUNT(*) FROM chunks"))
}

fn index_into(root: &Path, db: &Path, config: &CodeIndexConfig) -> Result<(usize, usize, usize), String> {
    let _serialized = INDEX_LOCK.lock().map_err(|_| "no pude bloquear el índice de código".to_string())?;
    let mut conn = open_db(db)?;
    let mut existing = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT path, mtime, size, hash FROM files").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?))).map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            existing.insert(row.0, (row.1, row.2, row.3));
        }
    }
    let (pending, seen, _skipped) = collect_pending(root, config, &existing)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for item in &pending {
        replace_file(&tx, item, &seen)?;
    }
    let stale: Vec<String> = existing.keys().filter(|path| !seen.contains(*path)).cloned().collect();
    for path in &stale {
        let _ = tx.execute("DELETE FROM files WHERE path = ?1", params![path]);
        let _ = tx.execute("DELETE FROM symbols WHERE path = ?1", params![path]);
        let _ = tx.execute("DELETE FROM edges WHERE src = ?1", params![path]);
        let _ = tx.execute("DELETE FROM chunks WHERE path = ?1", params![path]);
    }
    set_meta(&tx, "root", &root.to_string_lossy());
    set_meta(&tx, "updated", &now_ms().to_string());
    tx.commit().map_err(|e| e.to_string())?;

    Ok(counts(&conn))
}

fn ensure_fresh(app: &AppHandle, root: &Path, config: &CodeIndexConfig) -> Result<PathBuf, String> {
    if !config.enabled {
        return Err("El índice de código está desactivado. Activalo desde «Índice de código» en la paleta de comandos.".into());
    }
    let key = root.to_string_lossy().to_lowercase();
    if BUSY.lock().map(|b| b.contains(&key)).unwrap_or(false) {
        return Err("El índice de código se está construyendo en este momento. Probá de nuevo en unos segundos.".into());
    }
    let db = db_path(app, root)?;
    if crate::resources::pressure(app) == "critical" {
        if db.exists() {
            // Serve the current index instead of rebuilding under memory pressure.
            return Ok(db);
        }
        return Err("El índice de código está pausado porque la PC está al límite de memoria. Probá de nuevo cuando haya recursos.".into());
    }
    let needs = if !db.exists() {
        true
    } else {
        let conn = open_db(&db)?;
        let updated = meta(&conn, "updated").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
        let age = now_ms() - updated;
        age < 0 || age > (config.refresh_minutes as i64) * 60_000
    };
    if needs {
        let guard = BusyGuard::new(key);
        index_into(root, &db, config)?;
        drop(guard);
    }
    Ok(db)
}

struct BusyGuard {
    key: String,
}

impl BusyGuard {
    fn new(key: String) -> Self {
        if let Ok(mut busy) = BUSY.lock() {
            busy.insert(key.clone());
        }
        BusyGuard { key }
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        if let Ok(mut busy) = BUSY.lock() {
            busy.remove(&self.key);
        }
    }
}

fn fts_query(query: &str) -> String {
    let mut tokens: Vec<String> = Vec::new();
    for token in query.split(|c: char| !c.is_alphanumeric() && c != '_').filter(|s| !s.is_empty()) {
        if token.len() > 64 {
            continue;
        }
        let value = format!("\"{}\"", token.replace('"', ""));
        if !tokens.contains(&value) {
            tokens.push(value);
        }
        if tokens.len() >= 12 {
            break;
        }
    }
    tokens.join(" OR ")
}

fn snippet_of(conn: &Connection, path: &str, line: usize) -> Option<(usize, usize, String)> {
    conn.query_row(
        "SELECT start_line, end_line, text FROM chunks WHERE path = ?1 AND start_line <= ?2 AND end_line >= ?2 ORDER BY start_line DESC LIMIT 1",
        params![path, line as i64],
        |row| Ok((row.get::<_, i64>(0)? as usize, row.get::<_, i64>(1)? as usize, row.get::<_, String>(2)?)),
    )
    .optional()
    .ok()
    .flatten()
}

fn symbols_in(conn: &Connection, path: &str, start: usize, end: usize) -> Vec<String> {
    let mut stmt = match conn.prepare("SELECT name, kind FROM symbols WHERE path = ?1 AND line BETWEEN ?2 AND ?3 ORDER BY line LIMIT 12") {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![path, start as i64, end as i64], |row| Ok(format!("{} ({})", row.get::<_, String>(0)?, row.get::<_, String>(1)?)));
    rows.map(|r| r.flatten().collect()).unwrap_or_default()
}

fn search_into(db: &Path, query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
    let conn = open_db(db)?;
    let fts = fts_query(query);
    let mut hits: HashMap<(String, usize), SearchHit> = HashMap::new();
    if !fts.is_empty() {
        let mut stmt = conn
            .prepare("SELECT path, start_line, end_line, snippet(chunks, 3, '«', '»', ' … ', 16), bm25(chunks) FROM chunks WHERE chunks MATCH ?1 ORDER BY bm25(chunks) LIMIT ?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![fts, (limit * 4) as i64], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize, row.get::<_, i64>(2)? as usize, row.get::<_, String>(3)?, row.get::<_, f64>(4)?))
        });
        for row in rows.map_err(|e| e.to_string())?.flatten() {
            let score = (-row.4).max(0.0) + 1.0;
            hits.entry((row.0.clone(), row.1)).or_insert(SearchHit {
                path: row.0,
                start_line: row.1,
                end_line: row.2,
                score,
                reason: "texto".into(),
                snippet: row.3,
                symbols: Vec::new(),
            });
        }
    }
    let mut tokens: Vec<String> = query.split(|c: char| !c.is_alphanumeric() && c != '_').filter(|s| !s.is_empty()).map(|s| s.to_lowercase()).collect();
    tokens.sort();
    tokens.dedup();
    for token in tokens.iter().take(8) {
        let like = format!("%{}%", token);
        let mut stmt = conn.prepare("SELECT path, name, kind, line, signature FROM symbols WHERE lower(name) LIKE ?1 ORDER BY length(name) LIMIT 40").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![like], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)? as usize, row.get::<_, String>(4)?)));
        for row in rows.map_err(|e| e.to_string())?.flatten() {
            let name = row.1.to_lowercase();
            let boost = if name == *token { 8.0 } else if name.starts_with(token) { 5.0 } else { 2.0 };
            let entry = snippet_of(&conn, &row.0, row.3).unwrap_or((row.3, row.3, row.4.clone()));
            hits.entry((row.0.clone(), entry.0)).and_modify(|hit| {
                hit.score += boost;
                hit.reason = format!("símbolo {}", row.1);
            }).or_insert(SearchHit {
                path: row.0,
                start_line: entry.0,
                end_line: entry.1,
                score: boost,
                reason: format!("símbolo {}", row.1),
                snippet: entry.2,
                symbols: Vec::new(),
            });
        }
    }
    let mut ranked: Vec<SearchHit> = hits.into_values().collect();
    ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    ranked.truncate(limit.max(1));
    let seeds: Vec<String> = ranked.iter().take(5).map(|hit| hit.path.clone()).collect();
    for seed in seeds {
        let mut stmt = conn
            .prepare("SELECT CASE WHEN src = ?1 THEN dst ELSE src END FROM edges WHERE src = ?1 OR dst = ?1 LIMIT 12")
            .map_err(|e| e.to_string())?;
        let neighbors: Vec<String> = stmt.query_map(params![seed], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?.flatten().collect();
        for neighbor in neighbors {
            if ranked.iter().any(|hit| hit.path == neighbor) {
                continue;
            }
            let first = conn.query_row("SELECT start_line, end_line, text FROM chunks WHERE path = ?1 ORDER BY start_line LIMIT 1", params![neighbor], |row| {
                Ok((row.get::<_, i64>(0)? as usize, row.get::<_, i64>(1)? as usize, row.get::<_, String>(2)?))
            }).optional().ok().flatten();
            if let Some((start, end, text)) = first {
                ranked.push(SearchHit {
                    path: neighbor,
                    start_line: start,
                    end_line: end,
                    score: 0.6,
                    reason: "relacionado por import".into(),
                    snippet: text.lines().take(6).collect::<Vec<_>>().join("\n"),
                    symbols: Vec::new(),
                });
            }
        }
    }
    ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    ranked.truncate(limit.max(1));
    for hit in &mut ranked {
        hit.symbols = symbols_in(&conn, &hit.path, hit.start_line, hit.end_line);
    }
    Ok(ranked)
}

fn search_full(db: &Path, query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
    let mut hits = search_into(db, query, limit)?;
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit.max(1));
    Ok(hits)
}

fn context_into(db: &Path, query: &str, max_chars: usize) -> Result<String, String> {
    let hits = search_full(db, query, 8)?;
    let conn = open_db(db)?;
    let mut out = String::new();
    for hit in hits {
        if out.len() >= max_chars {
            break;
        }
        let text: String = conn
            .query_row("SELECT text FROM chunks WHERE path = ?1 AND start_line = ?2", params![hit.path, hit.start_line as i64], |row| row.get(0))
            .unwrap_or_default();
        let header = format!("--- {}:{}-{} ({})\n", hit.path, hit.start_line, hit.end_line, hit.reason);
        out.push_str(&header);
        let remaining = max_chars.saturating_sub(out.len());
        if text.len() > remaining {
            out.push_str(&text.chars().take(remaining).collect::<String>());
            out.push_str("\n…\n");
            break;
        }
        out.push_str(&text);
        out.push_str("\n\n");
    }
    if out.is_empty() {
        Ok("No encontré fragmentos para esa búsqueda.".into())
    } else {
        Ok(out)
    }
}

fn normalize_for_match(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn line_offsets(content: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0usize;
    for line in content.split_inclusive('\n') {
        let end = start + line.len();
        out.push((start, end));
        start = end;
    }
    if out.is_empty() {
        out.push((0, 0));
    }
    out
}

fn normalized_find(content: &str, needle: &str) -> Option<(usize, usize, usize)> {
    let needle_lines: Vec<String> = needle.lines().map(normalize_for_match).filter(|l| !l.is_empty()).collect();
    if needle_lines.is_empty() {
        return None;
    }
    let lines: Vec<&str> = content.lines().collect();
    let offsets = line_offsets(content);
    let mut found: Option<(usize, usize)> = None;
    let mut count = 0usize;
    for start in 0..lines.len() {
        if start + needle_lines.len() > lines.len() {
            break;
        }
        let mut matched = true;
        for (index, expected) in needle_lines.iter().enumerate() {
            if normalize_for_match(lines[start + index]) != *expected {
                matched = false;
                break;
            }
        }
        if matched {
            count += 1;
            if found.is_none() {
                found = Some((offsets[start].0, offsets[start + needle_lines.len() - 1].1));
            }
        }
    }
    found.map(|(from, to)| (from, to, count))
}

fn apply_edit(content: &str, old: &str, new: &str, replace_all: bool) -> Result<String, String> {
    if old.is_empty() {
        return Ok(format!("{}{}", content, new));
    }
    let count = content.matches(old).count();
    if count == 1 || (count > 1 && replace_all) {
        return Ok(content.replace(old, new));
    }
    if count > 1 {
        return Err("El texto original aparece más de una vez. Agregá contexto o usá replaceAll.".into());
    }
    if let Some((start, end, count)) = normalized_find(content, old) {
        if count > 1 {
            return Err("El texto original aparece más de una vez aunque se ignoren los espacios. Agregá contexto para desambiguar.".into());
        }
        return Ok(format!("{}{}{}", &content[..start], new, &content[end..]));
    }
    Err("No encontré el texto original en el archivo. Leé el archivo actual antes de editar.".into())
}

fn safe_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        return Err("La ruta debe ser relativa al proyecto.".into());
    }
    let mut clean = PathBuf::new();
    for comp in candidate.components() {
        match comp {
            Component::ParentDir => {
                if !clean.pop() {
                    return Err("La ruta sale del proyecto.".into());
                }
            }
            Component::CurDir => {}
            other => clean.push(other.as_os_str()),
        }
    }
    if clean.as_os_str().is_empty() {
        return Err("Falta la ruta del archivo.".into());
    }
    let root_norm = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let full = root_norm.join(&clean);
    if let Ok(existing) = full.canonicalize() {
        if !existing.starts_with(&root_norm) {
            return Err("La ruta sale del proyecto.".into());
        }
        return Ok(existing);
    }
    let full_norm = full.to_string_lossy().to_lowercase();
    let root_text = root_norm.to_string_lossy().to_lowercase();
    if !full_norm.starts_with(&root_text) {
        return Err("La ruta sale del proyecto.".into());
    }
    Ok(full)
}

fn unified_diff(path: &str, before: &str, after: &str) -> String {
    if before == after {
        return String::new();
    }
    let diff = similar::TextDiff::from_lines(before, after);
    diff.unified_diff().context_radius(3).header(&format!("a/{}", path), &format!("b/{}", path)).to_string()
}

fn apply_files(root: &Path, patches: &[FilePatch], dry_run: bool) -> Result<Value, String> {
    let mut staged: Vec<(PathBuf, String, String, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for patch in patches {
        let rel = patch.path.trim().replace('\\', "/");
        if rel.is_empty() {
            return Err("Cada archivo necesita un path.".into());
        }
        if !seen.insert(rel.to_lowercase()) {
            return Err(format!("El archivo {} aparece dos veces en el mismo pedido.", rel));
        }
        let full = safe_path(root, &rel)?;
        let before = std::fs::read_to_string(&full).unwrap_or_default();
        if let Some(expected) = &patch.expected_hash {
            let actual = sha256(before.as_bytes());
            if !expected.eq_ignore_ascii_case(&actual) {
                return Err(format!("{} cambió desde que lo leíste (hash distinto). Volvé a leerlo antes de editar.", rel));
            }
        }
        let mut after = match &patch.create {
            Some(content) => {
                if full.exists() && !before.is_empty() {
                    return Err(format!("{} ya existe; no se puede crear de nuevo.", rel));
                }
                content.clone()
            }
            None => before.clone(),
        };
        if patch.create.is_none() && !full.exists() {
            return Err(format!("{} no existe. Usá create para archivos nuevos.", rel));
        }
        for edit in &patch.edits {
            after = apply_edit(&after, &edit.old_text, &edit.new_text, edit.replace_all).map_err(|e| format!("{}: {}", rel, e))?;
        }
        if after == before {
            continue;
        }
        staged.push((full, rel, before, after));
    }
    if staged.is_empty() {
        return Ok(json!({ "changed": [], "dryRun": dry_run, "diff": "" }));
    }
    let mut diff = String::new();
    let mut changed = Vec::new();
    for (_, rel, before, after) in &staged {
        diff.push_str(&unified_diff(rel, before, after));
        changed.push(rel.clone());
    }
    if dry_run {
        return Ok(json!({ "changed": changed, "dryRun": true, "diff": diff }));
    }
    let mut written: Vec<(PathBuf, String)> = Vec::new();
    for (full, rel, before, after) in &staged {
        let result = (|| -> Result<(), String> {
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("{}: {}", rel, e))?;
            }
            let temp = full.with_file_name(format!(".{}.flufy-{}.tmp", full.file_name().unwrap_or_default().to_string_lossy(), std::process::id()));
            std::fs::write(&temp, after).map_err(|e| format!("{}: {}", rel, e))?;
            std::fs::rename(&temp, full).map_err(|e| format!("{}: {}", rel, e))?;
            Ok(())
        })();
        if let Err(error) = result {
            for (path, content) in written.iter().rev() {
                let _ = std::fs::write(path, content);
            }
            return Err(error);
        }
        written.push((full.clone(), before.clone()));
    }
    Ok(json!({ "changed": changed, "dryRun": false, "diff": diff }))
}

pub fn tool_list() -> Vec<Value> {
    vec![
        json!({
            "name": "code_search",
            "description": "Busca en el índice local del proyecto por concepto, nombre de símbolo, texto o ruta. Devuelve fragmentos rankeados con archivo y líneas.",
            "inputSchema": { "type": "object", "properties": {
                "query": { "type": "string", "description": "Qué buscar (lenguaje natural, símbolo, texto)" },
                "limit": { "type": "integer", "description": "Máximo de resultados (1-40, por defecto 12)" }
            }, "required": ["query"] }
        }),
        json!({
            "name": "code_symbols",
            "description": "Lista definiciones del proyecto (funciones, clases, tipos, variables) filtradas por nombre o ruta.",
            "inputSchema": { "type": "object", "properties": {
                "query": { "type": "string", "description": "Nombre o parte del nombre" },
                "path": { "type": "string", "description": "Filtro por ruta relativa" },
                "limit": { "type": "integer" }
            } }
        }),
        json!({
            "name": "code_context",
            "description": "Devuelve fragmentos de código listos para leer, rankeados por relevancia y con un presupuesto de caracteres.",
            "inputSchema": { "type": "object", "properties": {
                "query": { "type": "string" },
                "maxChars": { "type": "integer", "description": "Presupuesto de salida (por defecto 6000)" }
            }, "required": ["query"] }
        }),
        json!({
            "name": "code_apply_patch",
            "description": "Aplica ediciones verificadas a uno o varios archivos. Valida el texto original, rechaza coincidencias ambiguas y permite dryRun. Devuelve el diff.",
            "inputSchema": { "type": "object", "properties": {
                "dryRun": { "type": "boolean", "description": "Solo mostrar el diff, sin escribir" },
                "files": { "type": "array", "items": { "type": "object", "properties": {
                    "path": { "type": "string", "description": "Ruta relativa al proyecto" },
                    "expectedHash": { "type": "string", "description": "Hash SHA256 opcional del contenido leído" },
                    "create": { "type": "string", "description": "Contenido para un archivo nuevo" },
                    "edits": { "type": "array", "items": { "type": "object", "properties": {
                        "oldText": { "type": "string" },
                        "newText": { "type": "string" },
                        "replaceAll": { "type": "boolean" }
                    }, "required": ["oldText", "newText"] } }
                }, "required": ["path"] } }
            }, "required": ["files"] }
        }),
        json!({
            "name": "code_status",
            "description": "Estado del índice local: archivos, símbolos, fragmentos y última actualización.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
    ]
}

fn text_result(value: Value, error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": value.as_str().map(|s| s.to_string()).unwrap_or_else(|| value.to_string()) }],
        "isError": error
    })
}

fn status_for(app: &AppHandle) -> Result<IndexStatus, String> {
    let config = load_config(app);
    let root = root_for(app)?;
    let db = db_path(app, &root)?;
    let (files, symbols, chunks) = if db.exists() {
        match open_db(&db) {
            Ok(conn) => counts(&conn),
            Err(_) => (0, 0, 0),
        }
    } else {
        (0, 0, 0)
    };
    let updated = if db.exists() {
        let conn = open_db(&db)?;
        meta(&conn, "updated").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0)
    } else {
        0
    };
    Ok(IndexStatus {
        enabled: config.enabled,
        root: root.to_string_lossy().to_string(),
        files,
        symbols,
        chunks,
        updated,
        busy: BUSY.lock().map(|b| b.contains(&root.to_string_lossy().to_lowercase())).unwrap_or(false),
    })
}

pub fn call_tool(app: &AppHandle, name: &str, args: &Value) -> Value {
    let config = load_config(app);
    let result = (|| -> Result<Value, String> {
        let root = root_for(app)?;
        match name {
            "code_status" => {
                let status = status_for(app)?;
                Ok(json!(status))
            }
            "code_search" => {
                let query = args["query"].as_str().unwrap_or("").trim();
                if query.is_empty() {
                    return Err("Falta query.".into());
                }
                let limit = args["limit"].as_u64().unwrap_or(12).clamp(1, 40) as usize;
                let db = ensure_fresh(app, &root, &config)?;
                Ok(json!(search_full(&db, query, limit)?))
            }
            "code_symbols" => {
                let query = args["query"].as_str().unwrap_or("").trim().to_lowercase();
                let path = args["path"].as_str().unwrap_or("").trim().replace('\\', "/");
                let limit = args["limit"].as_u64().unwrap_or(40).clamp(1, 200) as usize;
                let db = ensure_fresh(app, &root, &config)?;
                let conn = open_db(&db)?;
                let mut stmt = conn.prepare("SELECT path, name, kind, line, signature FROM symbols WHERE (?1 = '' OR lower(name) LIKE ?2) AND (?3 = '' OR path LIKE ?4) ORDER BY path, line LIMIT ?5").map_err(|e| e.to_string())?;
                let rows = stmt.query_map(params![query, format!("%{}%", query), path, format!("%{}%", path), limit as i64], |row| {
                    Ok(json!({ "path": row.get::<_, String>(0)?, "name": row.get::<_, String>(1)?, "kind": row.get::<_, String>(2)?, "line": row.get::<_, i64>(3)?, "signature": row.get::<_, String>(4)? }))
                }).map_err(|e| e.to_string())?;
                Ok(Value::Array(rows.flatten().collect()))
            }
            "code_context" => {
                let query = args["query"].as_str().unwrap_or("").trim();
                if query.is_empty() {
                    return Err("Falta query.".into());
                }
                let max = args["maxChars"].as_u64().unwrap_or(6000).clamp(500, 40_000) as usize;
                let db = ensure_fresh(app, &root, &config)?;
                Ok(Value::String(context_into(&db, query, max)?))
            }
            "code_apply_patch" => {
                let dry_run = args["dryRun"].as_bool().unwrap_or(false);
                let files: Vec<FilePatch> = serde_json::from_value(args["files"].clone()).map_err(|e| format!("files inválido: {}", e))?;
                if files.is_empty() {
                    return Err("Falta files.".into());
                }
                let result = apply_files(&root, &files, dry_run)?;
                if !dry_run {
                    if let Ok(db) = db_path(app, &root) {
                        if db.exists() {
                            if let Ok(conn) = open_db(&db) {
                                set_meta(&conn, "updated", "0");
                            }
                        }
                    }
                }
                Ok(result)
            }
            other => Err(format!("herramienta desconocida: {}", other)),
        }
    })();
    match result {
        Ok(value) => text_result(value, false),
        Err(error) => text_result(Value::String(error), true),
    }
}

#[tauri::command]
pub fn code_index_get(app: AppHandle) -> CodeIndexConfig {
    load_config(&app)
}

#[tauri::command]
pub fn code_index_set(app: AppHandle, config: CodeIndexConfig) -> Result<CodeIndexConfig, String> {
    let mut config = config;
    config.refresh_minutes = config.refresh_minutes.clamp(1, 1440);
    config.max_files = config.max_files.clamp(100, 100_000);
    config.max_file_bytes = config.max_file_bytes.clamp(10_000, 20_000_000);
    save_config(&app, &config)?;
    Ok(config)
}

#[tauri::command]
pub fn code_index_status(app: AppHandle) -> Result<IndexStatus, String> {
    status_for(&app)
}

#[tauri::command]
pub async fn code_index_rebuild(app: AppHandle) -> Result<IndexStatus, String> {
    crate::proc::blocking(move || {
        if crate::resources::pressure(&app) == "critical" {
            return Err("El índice de código está pausado porque la PC está al límite de memoria. Cerrá otros programas o esperá un momento.".into());
        }
        let config = load_config(&app);
        let root = root_for(&app)?;
        let db = db_path(&app, &root)?;
        let guard = BusyGuard::new(root.to_string_lossy().to_lowercase());
        index_into(&root, &db, &config)?;
        drop(guard);
        status_for(&app)
    })
    .await
}

#[tauri::command]
pub async fn code_index_search(app: AppHandle, query: String, limit: Option<usize>) -> Result<Vec<SearchHit>, String> {
    crate::proc::blocking(move || {
        let config = load_config(&app);
        let root = root_for(&app)?;
        let db = ensure_fresh(&app, &root, &config)?;
        search_full(&db, &query, limit.unwrap_or(12).clamp(1, 40))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_are_exact_and_reject_ambiguity() {
        let content = "fn a() {}\nfn b() {}\n";
        assert_eq!(apply_edit(content, "fn a() {}", "fn c() {}", false).unwrap(), "fn c() {}\nfn b() {}\n");
        assert!(apply_edit("x\nx\n", "x", "y", false).is_err());
        assert_eq!(apply_edit("x\nx\n", "x", "y", true).unwrap(), "y\ny\n");
    }

    #[test]
    fn edits_fall_back_to_trimmed_lines() {
        let content = "fn main() {\n    let value = 1;\n}\n";
        let edited = apply_edit(content, "let value = 1;", "let value = 2;", false).unwrap();
        assert!(edited.contains("let value = 2;"));
    }

    #[test]
    fn trimmed_fallback_rejects_multiple_matches() {
        let content = "  const value = 1;\n    const value = 1;\n";
        assert!(apply_edit(content, "const value = 1;", "const value = 2;", false).is_err());
    }

    #[test]
    fn imports_resolve_relative_and_crate_paths() {
        let files: BTreeSet<String> = ["src/lib.rs", "src/util/math.rs", "src/app.ts", "src/util/index.ts"].iter().map(|s| s.to_string()).collect();
        assert_eq!(resolve_import("src/app.ts", "./util", &files).as_deref(), Some("src/util/index.ts"));
        assert_eq!(resolve_import("src/lib.rs", "crate::util::math", &files).as_deref(), Some("src/util/math.rs"));
        assert_eq!(resolve_import("src/app.ts", "react", &files), None);
    }

    #[test]
    fn symbols_and_chunks_are_extracted() {
        let text = "export function add(a: number) {\n  return a + 1;\n}\nclass Store {}\n";
        let symbols = symbols_for(text);
        assert!(symbols.iter().any(|s| s.name == "add" && s.kind == "function"));
        assert!(symbols.iter().any(|s| s.name == "Store" && s.kind == "type"));
        assert_eq!(chunks_for(text).len(), 1);
    }

    #[test]
    fn index_and_search_round_trip() {
        let dir = std::env::temp_dir().join(format!("flufy-index-{}", uuid::Uuid::new_v4()));
        let root = dir.join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n").unwrap();
        std::fs::write(root.join("src/use.ts"), "import { add } from './math'\nconsole.log(add(1, 2))\n").unwrap();
        let config = CodeIndexConfig { include: String::new(), exclude: String::new(), ..Default::default() };
        let db = dir.join("index.sqlite");
        let (files, symbols, chunks) = index_into(&root, &db, &config).unwrap();
        assert_eq!(files, 2);
        assert!(symbols >= 1);
        assert!(chunks >= 2);
        let hits = search_into(&db, "add", 10).unwrap();
        assert!(hits.iter().any(|hit| hit.path == "src/math.ts"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn apply_files_is_atomic_and_supports_dry_run() {
        let dir = std::env::temp_dir().join(format!("flufy-apply-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "uno\ndos\n").unwrap();
        let patches = vec![FilePatch {
            path: "a.txt".into(),
            edits: vec![Edit { old_text: "dos".into(), new_text: "tres".into(), replace_all: false }],
            create: None,
            expected_hash: None,
        }];
        let preview = apply_files(&dir, &patches, true).unwrap();
        assert_eq!(preview["dryRun"], true);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "uno\ndos\n");
        let applied = apply_files(&dir, &patches, false).unwrap();
        assert_eq!(applied["dryRun"], false);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "uno\ntres\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mcp_tools_are_well_formed() {
        let tools = tool_list();
        let names: Vec<&str> = tools.iter().filter_map(|tool| tool["name"].as_str()).collect();
        assert!(names.contains(&"code_search"));
        assert!(names.contains(&"code_apply_patch"));
        for tool in tools {
            assert!(tool["description"].as_str().map(|text| !text.is_empty()).unwrap_or(false));
            assert_eq!(tool["inputSchema"]["type"], "object");
        }
    }

    #[test]
    fn safe_path_rejects_escapes() {
        let root = std::env::temp_dir();
        assert!(safe_path(&root, "../secret.txt").is_err());
        assert!(safe_path(&root, "sub/file.txt").is_ok());
    }
}
