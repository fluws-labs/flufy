use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const OLLAMA_URL: &str = "http://127.0.0.1:11434";
const CANCELLED: &str = "Descarga cancelada";

static CANCEL: AtomicBool = AtomicBool::new(false);
static DOWNLOAD: Mutex<Option<DownloadProgress>> = Mutex::new(None);
static INSTALLING: AtomicBool = AtomicBool::new(false);
static INSTALL: Mutex<Option<InstallProgress>> = Mutex::new(None);

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub status: String,
    pub completed: u64,
    pub total: u64,
    pub percent: f64,
    pub error: Option<String>,
    pub done: bool,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub model: String,
    pub status: String,
    pub completed: u64,
    pub total: u64,
    pub percent: f64,
    pub error: Option<String>,
    pub done: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub gpu: Option<String>,
    pub vram_mb: u64,
    pub ram_mb: u64,
    pub cpu_cores: usize,
    pub bandwidth_gbs: u32,
    pub source: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub name: String,
    pub params: String,
    pub quant: String,
    pub size_gb: f64,
    pub context_k: u32,
    pub kind: String,
    pub grade: String,
    pub fit: String,
    pub fit_note: String,
    pub tok_s: u32,
    pub installed: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelsState {
    pub hardware: Hardware,
    pub models: Vec<ModelEntry>,
    pub ollama: OllamaStatus,
    pub download: Option<DownloadProgress>,
    pub install: Option<InstallProgress>,
}

pub struct CatalogModel {
    pub id: &'static str,
    pub name: &'static str,
    pub params: &'static str,
    pub size_gb: f64,
    pub context_k: u32,
    pub kind: &'static str,
}

pub const CATALOG: &[CatalogModel] = &[
    CatalogModel { id: "qwen2.5-coder:1.5b", name: "Qwen2.5 Coder 1.5B", params: "1.5B", size_gb: 1.0, context_k: 32, kind: "Código" },
    CatalogModel { id: "llama3.2:3b", name: "Llama 3.2 3B", params: "3B", size_gb: 2.0, context_k: 128, kind: "Chat" },
    CatalogModel { id: "qwen2.5:3b", name: "Qwen2.5 3B", params: "3B", size_gb: 1.9, context_k: 32, kind: "Chat" },
    CatalogModel { id: "qwen2.5-coder:7b", name: "Qwen2.5 Coder 7B", params: "7B", size_gb: 4.7, context_k: 32, kind: "Código" },
    CatalogModel { id: "qwen2.5:7b", name: "Qwen2.5 7B", params: "7B", size_gb: 4.7, context_k: 32, kind: "Chat" },
    CatalogModel { id: "llama3.1:8b", name: "Llama 3.1 8B", params: "8B", size_gb: 4.9, context_k: 128, kind: "Chat" },
    CatalogModel { id: "deepseek-r1:8b", name: "DeepSeek R1 8B", params: "8B", size_gb: 4.9, context_k: 128, kind: "Razonamiento" },
    CatalogModel { id: "llava:7b", name: "LLaVA 7B", params: "7B", size_gb: 4.7, context_k: 4, kind: "Visión" },
    CatalogModel { id: "gemma2:9b", name: "Gemma 2 9B", params: "9B", size_gb: 5.5, context_k: 8, kind: "Chat" },
    CatalogModel { id: "qwen2.5-coder:14b", name: "Qwen2.5 Coder 14B", params: "14B", size_gb: 9.0, context_k: 32, kind: "Código" },
    CatalogModel { id: "qwen2.5:14b", name: "Qwen2.5 14B", params: "14B", size_gb: 9.0, context_k: 32, kind: "Chat" },
    CatalogModel { id: "phi4:14b", name: "Phi-4 14B", params: "14B", size_gb: 9.1, context_k: 16, kind: "Razonamiento" },
    CatalogModel { id: "qwen3:14b", name: "Qwen3 14B", params: "14B", size_gb: 9.3, context_k: 40, kind: "Agente" },
    CatalogModel { id: "gpt-oss:20b", name: "GPT-OSS 20B", params: "20B (3.6B activos)", size_gb: 11.3, context_k: 128, kind: "Agente" },
];

pub fn catalog() -> &'static [CatalogModel] {
    CATALOG
}

fn wide(s: &[u16]) -> String {
    let end = s.iter().position(|c| *c == 0).unwrap_or(s.len());
    String::from_utf16_lossy(&s[..end])
}

#[cfg(windows)]
fn gpu_info() -> (Option<String>, u64) {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
    unsafe {
        let factory: IDXGIFactory1 = match CreateDXGIFactory1() {
            Ok(factory) => factory,
            Err(_) => return (None, 0),
        };
        let mut best: Option<(String, u64)> = None;
        let mut index = 0;
        while let Ok(adapter) = factory.EnumAdapters1(index) {
            index += 1;
            let Ok(desc) = adapter.GetDesc1() else { continue };
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            let name = wide(&desc.Description);
            let vram = desc.DedicatedVideoMemory as u64 / (1024 * 1024);
            if best.as_ref().map(|(_, value)| vram > *value).unwrap_or(true) {
                best = Some((name, vram));
            }
        }
        match best {
            Some((name, vram)) => (Some(name), vram),
            None => (None, 0),
        }
    }
}

#[cfg(not(windows))]
fn gpu_info() -> (Option<String>, u64) {
    (None, 0)
}

fn bandwidth_for(gpu: &Option<String>, vram_mb: u64) -> u32 {
    let name = gpu.as_deref().unwrap_or("").to_lowercase();
    let table = [
        ("4090", 1008), ("4080", 717), ("4070 ti", 504), ("4070", 504), ("4060 ti", 288), ("4060", 272),
        ("3090", 936), ("3080", 760), ("3070 ti", 608), ("3070", 448), ("3060 ti", 448), ("3060", 360),
        ("2080", 448), ("2070", 448), ("2060", 336), ("1660", 336), ("1650", 192), ("1080", 320), ("1070", 256),
        ("7900", 960), ("7800", 624), ("7700", 432), ("7600", 288), ("6800", 512), ("6700", 384), ("6600", 224),
        ("radeon graphics", 50), ("vega", 200), ("intel", 50), ("arc", 512),
    ];
    for (needle, value) in table {
        if name.contains(needle) {
            return value;
        }
    }
    if vram_mb >= 4096 {
        300
    } else {
        50
    }
}

pub fn hardware() -> Hardware {
    let ram_mb = crate::resources::memory().0;
    let (gpu, vram_mb) = gpu_info();
    let source = if vram_mb >= 2048 { "gpu" } else { "cpu" };
    let bandwidth_gbs = bandwidth_for(&gpu, vram_mb);
    Hardware {
        gpu,
        vram_mb,
        ram_mb,
        cpu_cores: std::thread::available_parallelism().map(|value| value.get()).unwrap_or(0),
        bandwidth_gbs,
        source: source.into(),
    }
}

fn grade_for(need: f64, budget: f64) -> (&'static str, &'static str, &'static str) {
    let ratio = need / budget.max(0.5);
    if ratio <= 0.5 {
        ("S", "cómodo", "Sobra memoria para contexto largo.")
    } else if ratio <= 0.7 {
        ("A", "cómodo", "Entra bien; podés usar contexto amplio.")
    } else if ratio <= 0.85 {
        ("B", "ajustado", "Usa buena parte de la memoria; moderá el contexto.")
    } else if ratio <= 1.0 {
        ("C", "ajustado", "Al límite; bajá el contexto para evitar fallas.")
    } else if ratio <= 1.25 {
        ("D", "muy ajustado", "Puede no entrar si el sistema usa memoria.")
    } else {
        ("F", "no entra", "Necesita más memoria de la disponible.")
    }
}

fn speed_size(model: &CatalogModel) -> f64 {
    match model.id {
        "gpt-oss:20b" => 2.5,
        "qwen3:30b-a3b" => 2.0,
        _ => model.size_gb,
    }
}

fn model_entry(model: &CatalogModel, vram_gb: f64, ram_gb: f64, bandwidth: u32, tags: &[String]) -> ModelEntry {
    let need = model.size_gb + 0.8;
    let total_budget = if vram_gb >= 2.0 { vram_gb + ram_gb * 0.5 } else { ram_gb * 0.7 };
    let offloaded = vram_gb >= 2.0 && need > vram_gb;
    let (grade, fit, fit_note) = if offloaded {
        let ratio = need / total_budget.max(0.5);
        if ratio <= 0.6 {
            ("C", "parcial en RAM", "No entra en VRAM; corre parcial en RAM, más lento.")
        } else if ratio <= 0.9 {
            ("D", "parcial en RAM", "No entra en VRAM; usa bastante RAM y va a ser lento.")
        } else {
            ("F", "no entra", "No hay memoria suficiente entre VRAM y RAM.")
        }
    } else {
        grade_for(need, if vram_gb >= 2.0 { vram_gb } else { ram_gb * 0.7 })
    };
    let effective_bandwidth = if offloaded { 50.0 } else { bandwidth as f64 };
    let tok_s = ((0.5 * effective_bandwidth) / speed_size(model)).round().max(1.0) as u32;
    ModelEntry {
        id: model.id.into(),
        name: model.name.into(),
        params: model.params.into(),
        quant: "Q4_K_M".into(),
        size_gb: model.size_gb,
        context_k: model.context_k,
        kind: model.kind.into(),
        grade: grade.into(),
        fit: fit.into(),
        fit_note: fit_note.into(),
        tok_s,
        installed: tags.iter().any(|tag| tag.as_str() == model.id || tag.starts_with(model.id)),
    }
}

fn ollama_tags() -> Result<Vec<String>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(500))
        .timeout_read(Duration::from_secs(2))
        .build();
    let response = agent
        .get(&format!("{OLLAMA_URL}/api/tags"))
        .call()
        .map_err(|e| format!("Ollama no responde: {e}"))?;
    let value: Value = response.into_json().map_err(|e| e.to_string())?;
    let mut names: Vec<String> = value["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| model["name"].as_str().map(str::to_string))
        .collect();
    names.sort();
    Ok(names)
}

fn ollama_exe() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let path = PathBuf::from(local).join("Programs").join("Ollama").join("ollama.exe");
    path.exists().then_some(path)
}

fn ollama_present() -> bool {
    ollama_exe().is_some()
        || Command::new("ollama")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
}

fn ollama_version() -> Option<String> {
    let mut command = match ollama_exe() {
        Some(path) => Command::new(path),
        None => Command::new("ollama"),
    };
    let output = command.arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Starts the local server when Ollama is installed but closed, then waits a
/// few seconds for it. This makes downloaded models show up without the user
/// having to open the Ollama app first.
pub(crate) fn ensure_running() -> bool {
    if ollama_tags().is_ok() {
        return true;
    }
    if !ollama_present() {
        return false;
    }
    start_ollama();
    for _ in 0..10 {
        std::thread::sleep(Duration::from_millis(500));
        if ollama_tags().is_ok() {
            return true;
        }
    }
    false
}

#[tauri::command]
pub async fn local_models_state() -> Result<LocalModelsState, String> {
    crate::proc::blocking(|| {
        let hardware = hardware();
        let installed = ollama_present();
        if installed {
            ensure_running();
        }
        let (running, tags, error) = match ollama_tags() {
            Ok(tags) => (true, tags, None),
            Err(e) => (false, Vec::new(), Some(e)),
        };
        let version = ollama_version();
        let vram_gb = hardware.vram_mb as f64 / 1024.0;
        let ram_gb = hardware.ram_mb as f64 / 1024.0;
        let models = CATALOG
            .iter()
            .map(|model| model_entry(model, vram_gb, ram_gb, hardware.bandwidth_gbs, &tags))
            .collect();
        let download = DOWNLOAD.lock().ok().and_then(|slot| slot.as_ref().cloned());
        let install = INSTALL.lock().ok().and_then(|slot| slot.as_ref().cloned());
        Ok(LocalModelsState {
            hardware,
            models,
            ollama: OllamaStatus { installed, running, version, error },
            download,
            install,
        })
    })
    .await
}

#[tauri::command]
pub fn local_models_pull(app: AppHandle, model: String) -> Result<(), String> {
    if !CATALOG.iter().any(|entry| entry.id == model.as_str()) {
        return Err("Modelo desconocido".into());
    }
    if DOWNLOAD
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|progress| !progress.done && progress.error.is_none()))
        .unwrap_or(false)
    {
        return Err("Ya hay una descarga en curso".into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    if let Ok(mut slot) = DOWNLOAD.lock() {
        *slot = Some(DownloadProgress { model: model.clone(), status: "Iniciando".into(), ..Default::default() });
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        let result = pull(&handle, &model);
        if let Ok(mut slot) = DOWNLOAD.lock() {
            if let Some(progress) = slot.as_mut() {
                progress.done = true;
                match &result {
                    Ok(()) => {
                        progress.status = "Listo".into();
                        progress.percent = 100.0;
                    }
                    Err(e) => progress.error = Some(e.clone()),
                }
            }
        }
        let payload = match &result {
            Ok(()) => json!({ "model": model, "done": true, "percent": 100.0 }),
            Err(e) => json!({ "model": model, "done": true, "error": e }),
        };
        let _ = handle.emit("local-models:progress", payload);
    });
    Ok(())
}

#[tauri::command]
pub fn local_models_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn local_models_install(app: AppHandle) -> Result<(), String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("Ya hay una instalación en curso".into());
    }
    if let Ok(mut slot) = INSTALL.lock() {
        *slot = Some(InstallProgress { status: "Descargando instalador".into(), ..Default::default() });
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        let result = install(&handle);
        if let Ok(mut slot) = INSTALL.lock() {
            if let Some(progress) = slot.as_mut() {
                progress.done = true;
                match &result {
                    Ok(()) => {
                        progress.status = "Listo".into();
                        progress.percent = 100.0;
                    }
                    Err(e) => progress.error = Some(e.clone()),
                }
            }
        }
        INSTALLING.store(false, Ordering::SeqCst);
        let payload = match &result {
            Ok(()) => json!({ "done": true }),
            Err(e) => json!({ "done": true, "error": e }),
        };
        let _ = handle.emit("local-models:install", payload);
    });
    Ok(())
}

fn install(app: &AppHandle) -> Result<(), String> {
    if ollama_tags().is_ok() {
        return Ok(());
    }
    let installer = std::env::temp_dir().join("OllamaSetup.exe");
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(180))
        .build();
    let response = agent
        .get("https://ollama.com/download/OllamaSetup.exe")
        .call()
        .map_err(|e| format!("No se pudo descargar Ollama: {e}"))?;
    let total = response.header("Content-Length").and_then(|value| value.parse::<u64>().ok()).unwrap_or(0);
    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(&installer).map_err(|e| format!("No se pudo crear el instalador: {e}"))?;
    let mut buffer = [0u8; 65536];
    let mut received = 0u64;
    let mut last = Instant::now();
    loop {
        let read = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
        received += read as u64;
        if last.elapsed() > Duration::from_millis(250) {
            last = Instant::now();
            let percent = if total > 0 { received as f64 * 100.0 / total as f64 } else { 0.0 };
            if let Ok(mut slot) = INSTALL.lock() {
                if let Some(progress) = slot.as_mut() {
                    progress.completed = received;
                    progress.total = total;
                    progress.percent = percent;
                }
            }
            let _ = app.emit(
                "local-models:install",
                json!({ "status": "Descargando instalador", "completed": received, "total": total, "percent": percent }),
            );
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if !verify_signature(&installer)? {
        let _ = std::fs::remove_file(&installer);
        return Err("La firma digital del instalador no es válida; no se instaló.".into());
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let marker = PathBuf::from(local).join("Ollama");
        let _ = std::fs::create_dir_all(&marker);
        let _ = std::fs::write(marker.join("upgraded"), b"");
    }
    if let Ok(mut slot) = INSTALL.lock() {
        if let Some(progress) = slot.as_mut() {
            progress.status = "Instalando Ollama".into();
            progress.completed = 0;
            progress.total = 0;
            progress.percent = 0.0;
        }
    }
    let _ = app.emit("local-models:install", json!({ "status": "Instalando Ollama" }));
    let status = Command::new(&installer)
        .args(["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"])
        .status()
        .map_err(|e| format!("No se pudo ejecutar el instalador: {e}"))?;
    let _ = std::fs::remove_file(&installer);
    if !status.success() {
        return Err(format!(
            "La instalación terminó con código {}. Si cancelaste el permiso de Windows, volvé a intentar.",
            status.code().unwrap_or(-1)
        ));
    }
    start_ollama();
    for _ in 0..60 {
        if ollama_tags().is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
    Err("Ollama se instaló pero no respondió. Abrí la app Ollama y volvé a actualizar.".into())
}

fn verify_signature(path: &Path) -> Result<bool, String> {
    let quoted = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$s = Get-AuthenticodeSignature -LiteralPath '{}'; if ($s.Status -ne 'Valid') {{ Write-Output ('INVALID:' + $s.Status); exit 1 }}; if ($s.SignerCertificate.Subject -notmatch 'O=Ollama Inc') {{ Write-Output ('WRONG:' + $s.SignerCertificate.Subject); exit 1 }}; Write-Output 'OK'",
        quoted
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .output()
        .map_err(|e| format!("No se pudo verificar la firma: {e}"))?;
    Ok(output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "OK")
}

fn start_ollama() {
    if ollama_tags().is_ok() {
        return;
    }
    if let Some(exe) = ollama_exe() {
        let mut command = Command::new(exe);
        command.arg("serve");
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let _ = command.spawn();
        return;
    }
    let mut command = Command::new("ollama");
    command.arg("serve");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let _ = command.spawn();
}

fn pull(app: &AppHandle, model: &str) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(180))
        .build();
    let response = agent
        .post(&format!("{OLLAMA_URL}/api/pull"))
        .send_json(json!({ "model": model, "stream": true }))
        .map_err(|e| format!("No se pudo iniciar la descarga en Ollama: {e}"))?;
    let reader = response.into_reader();
    for line in BufReader::new(reader).lines() {
        if CANCEL.load(Ordering::SeqCst) {
            return Err(CANCELLED.into());
        }
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        if let Some(error) = value["error"].as_str() {
            return Err(error.to_string());
        }
        let status = value["status"].as_str().unwrap_or("Descargando").to_string();
        let completed = value["completed"].as_u64().unwrap_or(0);
        let total = value["total"].as_u64().unwrap_or(0);
        let percent = if total > 0 { completed as f64 * 100.0 / total as f64 } else { 0.0 };
        if let Ok(mut slot) = DOWNLOAD.lock() {
            if let Some(progress) = slot.as_mut() {
                progress.status = status.clone();
                progress.completed = completed;
                progress.total = total;
                progress.percent = percent;
            }
        }
        let _ = app.emit(
            "local-models:progress",
            json!({
                "model": model,
                "status": status,
                "completed": completed,
                "total": total,
                "percent": percent
            }),
        );
    }
    Ok(())
}

/// Adds every model Ollama already has installed as an OpenAI-compatible
/// provider, so the engine can list and run them like the cloud providers.
pub(crate) fn extend_config(config: &mut Value) {
    if let Ok(tags) = ollama_tags() {
        apply_provider(config, tags);
        return;
    }
    if !ollama_present() {
        return;
    }
    start_ollama();
    for _ in 0..10 {
        std::thread::sleep(Duration::from_millis(500));
        if let Ok(tags) = ollama_tags() {
            apply_provider(config, tags);
            return;
        }
    }
}

fn apply_provider(config: &mut Value, tags: Vec<String>) {
    if tags.is_empty() {
        return;
    }
    if !config["provider"].is_object() {
        config["provider"] = json!({});
    }
    let mut models = serde_json::Map::new();
    for tag in &tags {
        let meta = CATALOG.iter().find(|model| tag.as_str() == model.id || tag.starts_with(model.id));
        let name = meta.map(|model| model.name.to_string()).unwrap_or_else(|| tag.clone());
        let context = meta.map(|model| model.context_k as u64 * 1024).unwrap_or(32768);
        models.insert(tag.clone(), json!({ "name": name, "limit": { "context": context, "output": 4096 } }));
    }
    config["provider"]["ollama"] = json!({
        "npm": "@ai-sdk/openai-compatible",
        "name": "Ollama (local)",
        "options": { "baseURL": format!("{OLLAMA_URL}/v1"), "apiKey": "ollama" },
        "models": models
    });
}
