//! Respuestas habladas locales (Piper).
//!
//! El micrófono ya se transcribe con `voice.rs` (Whisper local o un servicio
//! compatible con OpenAI). Acá va el camino inverso: convertir el texto de una
//! respuesta en un audio WAV, sin nube y sin ffmpeg.
//!
//! `piper.exe` es un ejecutable de una sola pasada que lee texto por stdin y
//! escribe un WAV. Igual que Whisper, lo empaquetamos con la app y lo
//! ejecutamos desde su carpeta (necesita `espeak-ng-data` al lado).
//!
//! Cada bloque de texto del asistente se guarda como una nota de voz en la
//! carpeta de datos de la app, con el id de la parte como nombre. Así la burbuja
//! del celular puede volver a reproducirla sin sintetizar de nuevo, incluso
//! después de recargar o reiniciar.

use crate::{app_data_file, proc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

const HF_BASE: &str = "https://huggingface.co/rhasspy/piper-voices/resolve/main";
const DEFAULT_VOICE: &str = "es_MX-claude-high";
const MAX_TEXT: usize = 4_000;
const MAX_SPEAK: usize = 900;
const MAX_USER_WAV: usize = 30 * 1024 * 1024;
const NOTE_RETENTION_DAYS: u64 = 30;

struct VoiceDef {
    id: &'static str,
    label: &'static str,
    note: &'static str,
    path: &'static str,
    bytes: u64,
}

/// Voces en español empaquetadas como descarga opcional. Los tamaños son los
/// del archivo `.onnx` publicado en Hugging Face.
const VOICES: &[VoiceDef] = &[
    VoiceDef {
        id: "es_MX-claude-high",
        label: "Claude · Latino (femenina)",
        note: "Recomendada: natural y rápida",
        path: "es/es_MX/claude/high/es_MX-claude-high",
        bytes: 63_122_309,
    },
    VoiceDef {
        id: "es_AR-daniela-high",
        label: "Daniela · Argentina (femenina)",
        note: "Acento argentino; tarda más en generar",
        path: "es/es_AR/daniela/high/es_AR-daniela-high",
        bytes: 114_199_011,
    },
    VoiceDef {
        id: "es_ES-davefx-medium",
        label: "Dave · España (masculina)",
        note: "Rápida y clara",
        path: "es/es_ES/davefx/medium/es_ES-davefx-medium",
        bytes: 63_201_294,
    },
    VoiceDef {
        id: "es_MX-ald-x_low",
        label: "Ald · Latino (liviana)",
        note: "La más rápida; menos natural",
        path: "es/es_MX/ald/x_low/es_MX-ald-x_low",
        bytes: 20_986_952,
    },
];

fn voice_def(id: &str) -> Option<&'static VoiceDef> {
    VOICES.iter().find(|v| v.id == id)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
struct SpeechConfig {
    enabled: bool,
    voice: String,
    speed: f32,
}

impl Default for SpeechConfig {
    fn default() -> Self {
        Self { enabled: true, voice: DEFAULT_VOICE.into(), speed: 1.0 }
    }
}

impl SpeechConfig {
    fn voice_id(&self) -> String {
        let id = self.voice.trim();
        if voice_def(id).is_some() {
            id.to_string()
        } else {
            DEFAULT_VOICE.to_string()
        }
    }

    fn speed(&self) -> f32 {
        if self.speed.is_finite() {
            self.speed.clamp(0.7, 1.4)
        } else {
            1.0
        }
    }
}

#[derive(Default)]
pub struct SpeechState {
    download: Mutex<Option<Download>>,
    synth: Mutex<()>,
}

#[derive(Clone)]
struct Download {
    id: String,
    received: u64,
    total: u64,
    error: Option<String>,
    cancel: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceView {
    pub id: String,
    pub label: String,
    pub note: String,
    pub present: bool,
    pub bytes: u64,
    pub total_bytes: u64,
    pub downloading: bool,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechView {
    pub available: bool,
    pub ready: bool,
    pub enabled: bool,
    pub voice: String,
    pub speed: f32,
    pub default_voice: String,
    pub voices_dir: Option<String>,
    pub voices: Vec<VoiceView>,
}

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    app_data_file(app, "speech.json")
}

fn load(app: &AppHandle) -> SpeechConfig {
    config_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, config: &SpeechConfig) {
    if let Some(path) = config_file(app) {
        let _ = std::fs::write(path, serde_json::to_string_pretty(config).unwrap_or_default());
    }
}

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app_data_file(app, "speech")?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

pub fn voices_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = data_dir(app)?.join("voices");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn note_base(app: &AppHandle) -> Option<PathBuf> {
    let dir = data_dir(app)?.join("notes");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

pub fn model_path(app: &AppHandle, id: &str) -> Option<PathBuf> {
    Some(voices_dir(app)?.join(format!("{}.onnx", id)))
}

pub fn model_present(app: &AppHandle, id: &str) -> bool {
    model_path(app, id).map(|p| p.is_file()).unwrap_or(false)
        && model_path(app, id).map(|p| p.with_extension("onnx.json").is_file()).unwrap_or(false)
}

/// `piper.exe` vive en `binaries/piper` durante el desarrollo y en
/// `resources/piper` ya instalado. Necesita toda la carpeta al lado.
fn engine_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join("piper"));
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("piper"));
        candidates.push(res.join("binaries").join("piper"));
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        candidates.push(dir.join("piper"));
    }
    candidates.into_iter().find(|p| p.join("piper.exe").is_file() && p.join("espeak-ng-data").is_dir())
}

pub fn available(app: &AppHandle) -> bool {
    engine_dir(app).is_some()
}

pub fn ready(app: &AppHandle) -> bool {
    let config = load(app);
    available(app) && model_present(app, &config.voice_id())
}

pub fn enabled(app: &AppHandle) -> bool {
    load(app).enabled
}

pub fn view(app: &AppHandle) -> SpeechView {
    let config = load(app);
    let id = config.voice_id();
    let download = app.try_state::<SpeechState>().and_then(|state| state.download.lock().unwrap().clone());
    let voices = VOICES
        .iter()
        .map(|def| {
            let path = model_path(app, def.id);
            let present = path.as_ref().map(|p| p.is_file()).unwrap_or(false) && path.as_ref().map(|p| p.with_extension("onnx.json").is_file()).unwrap_or(false);
            let bytes = if present {
                path.as_ref().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()).unwrap_or(0)
            } else {
                0
            };
            let active = download.as_ref().filter(|d| d.id == def.id);
            VoiceView {
                id: def.id.to_string(),
                label: def.label.to_string(),
                note: def.note.to_string(),
                present,
                bytes,
                total_bytes: def.bytes,
                downloading: active.map(|d| d.error.is_none()).unwrap_or(false),
                error: active.and_then(|d| d.error.clone()),
            }
        })
        .collect();
    SpeechView {
        available: available(app),
        ready: available(app) && model_present(app, &id),
        enabled: config.enabled,
        voice: id,
        speed: config.speed(),
        default_voice: DEFAULT_VOICE.to_string(),
        voices_dir: voices_dir(app).map(|p| p.to_string_lossy().into_owned()),
        voices,
    }
}

pub fn status_json(app: &AppHandle) -> Value {
    serde_json::to_value(view(app)).unwrap_or_else(|_| json!({ "ready": false }))
}

pub fn update(app: &AppHandle, enabled: Option<bool>, voice: Option<String>, speed: Option<f64>) -> SpeechView {
    let mut config = load(app);
    if let Some(value) = enabled {
        config.enabled = value;
    }
    if let Some(value) = voice {
        let clean = value.trim();
        if voice_def(clean).is_some() {
            config.voice = clean.to_string();
        }
    }
    if let Some(value) = speed {
        if value.is_finite() {
            config.speed = (value as f32).clamp(0.7, 1.4);
        }
    }
    save(app, &config);
    view(app)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn session_dir(app: &AppHandle, session: &str) -> Option<PathBuf> {
    if !valid_id(session) {
        return None;
    }
    let dir = note_base(app)?.join(session);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn assistant_path(app: &AppHandle, session: &str, part: &str) -> Option<PathBuf> {
    if !valid_id(part) {
        return None;
    }
    Some(session_dir(app, session)?.join(format!("{}.wav", part)))
}

fn user_path(app: &AppHandle, session: &str, message: &str) -> Option<PathBuf> {
    if !valid_id(message) {
        return None;
    }
    Some(session_dir(app, session)?.join(format!("{}.user.wav", message)))
}

fn hash_sidecar(path: &Path) -> PathBuf {
    path.with_extension("hash")
}

fn text_hash(text: &str, voice: &str, speed: f32) -> String {
    let mut hasher = Sha256::new();
    hasher.update(voice.as_bytes());
    hasher.update(format!("{:.3}", speed).as_bytes());
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Texto que tiene sentido leer en voz alta: sin markdown, sin código, sin
/// URLs ni tablas. Si el bloque es solo código, devuelve vacío.
pub fn speakable(text: &str) -> String {
    static FENCED: OnceLock<regex::Regex> = OnceLock::new();
    static INLINE: OnceLock<regex::Regex> = OnceLock::new();
    static IMAGE: OnceLock<regex::Regex> = OnceLock::new();
    static LINK: OnceLock<regex::Regex> = OnceLock::new();
    static URL: OnceLock<regex::Regex> = OnceLock::new();
    static RULE: OnceLock<regex::Regex> = OnceLock::new();
    static HEADING: OnceLock<regex::Regex> = OnceLock::new();
    static QUOTE: OnceLock<regex::Regex> = OnceLock::new();
    static BULLET: OnceLock<regex::Regex> = OnceLock::new();
    static TABLE: OnceLock<regex::Regex> = OnceLock::new();
    static EMPHASIS: OnceLock<regex::Regex> = OnceLock::new();
    static CODE_WORD: OnceLock<regex::Regex> = OnceLock::new();

    let fenced = FENCED.get_or_init(|| regex::Regex::new(r"(?s)```.*?```").unwrap());
    let inline = INLINE.get_or_init(|| regex::Regex::new(r"`([^`]*)`").unwrap());
    let image = IMAGE.get_or_init(|| regex::Regex::new(r"!\[[^\]]*\]\([^)]*\)").unwrap());
    let link = LINK.get_or_init(|| regex::Regex::new(r"\[([^\]]+)\]\([^)]*\)").unwrap());
    let url = URL.get_or_init(|| regex::Regex::new(r"https?://\S+").unwrap());
    let rule = RULE.get_or_init(|| regex::Regex::new(r"(?m)^\s*([-*_]\s*){3,}$").unwrap());
    let heading = HEADING.get_or_init(|| regex::Regex::new(r"(?m)^\s{0,3}#{1,6}\s*").unwrap());
    let quote = QUOTE.get_or_init(|| regex::Regex::new(r"(?m)^\s{0,3}>\s?").unwrap());
    let bullet = BULLET.get_or_init(|| regex::Regex::new(r"(?m)^\s{0,3}(?:[-*+]|\d+[.)])\s+").unwrap());
    let table = TABLE.get_or_init(|| regex::Regex::new(r"(?m)^\s*\|.*\|\s*$").unwrap());
    let emphasis = EMPHASIS.get_or_init(|| regex::Regex::new(r"[*_~]{1,3}").unwrap());
    let code_word = CODE_WORD.get_or_init(|| regex::Regex::new(r"^\p{L}[\p{L}\p{N}_.\-]*$").unwrap());

    let mut clean = fenced.replace_all(text, " ").into_owned();
    clean = image.replace_all(&clean, " ").into_owned();
    clean = link.replace_all(&clean, "$1").into_owned();
    clean = url.replace_all(&clean, " ").into_owned();
    clean = rule.replace_all(&clean, " ").into_owned();
    clean = table.replace_all(&clean, " ").into_owned();
    clean = heading.replace_all(&clean, " ").into_owned();
    clean = quote.replace_all(&clean, " ").into_owned();
    clean = bullet.replace_all(&clean, " ").into_owned();
    // El contenido de código en línea suele ser rutas o identificadores que se
    // leen mal; se conserva solo si es una palabra normal.
    clean = inline
        .replace_all(&clean, |caps: &regex::Captures| {
            let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("").trim();
            // Nombres de archivo o palabras sueltas se leen; comandos, banderas
            // y valores simbólicos se descartan porque suenan mal.
            if code_word.is_match(inner) {
                inner.to_string()
            } else {
                " ".to_string()
            }
        })
        .into_owned();
    clean = emphasis.replace_all(&clean, "").into_owned();

    let mut out = String::with_capacity(clean.len());
    for ch in clean.chars() {
        if ch.is_alphanumeric()
            || ch.is_whitespace()
            || matches!(ch, '.' | ',' | ';' | ':' | '!' | '?' | '¡' | '¿' | '(' | ')' | '"' | '\'' | '-' | '%' | '/')
        {
            out.push(ch);
        } else {
            out.push(' ');
        }
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_SPEAK {
        return collapsed;
    }
    let mut cut = MAX_SPEAK;
    let sliced: String = collapsed.chars().take(MAX_SPEAK).collect();
    if let Some(at) = sliced.rfind(|c: char| matches!(c, '.' | '!' | '?')) {
        if at > MAX_SPEAK / 2 {
            cut = sliced[..at + 1].chars().count();
        }
    }
    let mut short: String = collapsed.chars().take(cut).collect();
    short = short.trim().to_string();
    format!("{}. El resto quedó en pantalla.", short.trim_end_matches(|c: char| matches!(c, '.' | '!' | '?')))
}

/// Duración de un WAV PCM/float leyendo sus chunks. Devuelve milisegundos.
pub fn wav_duration_ms(bytes: &[u8]) -> Option<u64> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut offset = 12usize;
    let mut byte_rate: Option<u32> = None;
    let mut data_size: Option<u32> = None;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().ok()?) as usize;
        let body = offset + 8;
        if id == b"fmt " && body + 12 <= bytes.len() {
            byte_rate = Some(u32::from_le_bytes(bytes[body + 8..body + 12].try_into().ok()?));
        }
        if id == b"data" {
            // Se usa el tamaño declarado: al leer solo la cabecera de una nota
            // grande, el bloque de datos completo no está en memoria.
            data_size = Some(size as u32);
            break;
        }
        offset = body.saturating_add(size).saturating_add(size & 1);
    }
    let rate = byte_rate.filter(|r| *r > 0)?;
    let size = data_size?;
    Some((size as u64) * 1000 / rate as u64)
}

fn is_wav(bytes: &[u8]) -> bool {
    bytes.len() > 44 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE"
}

fn run_piper(app: &AppHandle, voice: &str, text: &str, speed: f32, out: &Path) -> Result<(), String> {
    let dir = engine_dir(app).ok_or_else(|| "El motor de voz (Piper) no está instalado en esta PC".to_string())?;
    let model = model_path(app, voice).filter(|p| p.is_file()).ok_or_else(|| {
        format!("Falta descargar la voz «{}» (Flufy › Audios)", voice)
    })?;
    if !model.with_extension("onnx.json").is_file() {
        return Err(format!("Falta la configuración de la voz «{}»", voice));
    }
    let text = text.replace('\r', " ").replace('\n', " ").split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err("No hay texto para leer".into());
    }
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let _ = std::fs::remove_file(out);
    let mut cmd = Command::new(dir.join("piper.exe"));
    cmd.arg("-m")
        .arg(&model)
        .arg("-f")
        .arg(out)
        .arg("-q")
        .arg("--length_scale")
        .arg(format!("{:.3}", 1.0 / speed.clamp(0.6, 1.6)))
        .arg("--sentence_silence")
        .arg("0.12")
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    proc::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("No se pudo iniciar la voz local: {}", e))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes()).map_err(|e| format!("No se pudo enviar el texto a la voz: {}", e))?;
        stdin.write_all(b"\n").ok();
    }
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() > Duration::from_secs(120) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("La voz local tardó demasiado en responder".into());
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(e) => return Err(format!("No se pudo esperar a la voz local: {}", e)),
        }
    };
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    if !status.success() || !out.is_file() {
        let detail = stderr.lines().last().unwrap_or("sin detalle");
        return Err(format!("La voz local falló: {}", detail));
    }
    Ok(())
}

fn read_note(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|_| "Esa nota de voz todavía no existe".to_string())
}

/// Genera (o reutiliza) la nota de voz de una parte de texto del asistente.
pub fn ensure_note(app: &AppHandle, session: &str, part: &str, text: &str) -> Result<Vec<u8>, String> {
    if !valid_id(session) || !valid_id(part) {
        return Err("Conversación inválida".into());
    }
    let config = load(app);
    let voice = config.voice_id();
    let speed = config.speed();
    let spoken = speakable(&text.chars().take(MAX_TEXT).collect::<String>());
    if spoken.is_empty() {
        return Err("Este bloque no tiene texto para leer".into());
    }
    let path = assistant_path(app, session, part).ok_or("Conversación inválida")?;
    let hash_path = hash_sidecar(&path);
    let wanted = text_hash(&spoken, &voice, speed);
    let current = std::fs::read_to_string(&hash_path).ok().map(|s| s.trim().to_string());
    if path.is_file() && current.as_deref() == Some(wanted.as_str()) {
        return read_note(&path);
    }
    let state = app.state::<SpeechState>();
    let _guard = state.synth.lock().unwrap();
    // Otra petición pudo generarla mientras esperábamos el turno.
    if path.is_file() && std::fs::read_to_string(&hash_path).ok().map(|s| s.trim().to_string()).as_deref() == Some(wanted.as_str()) {
        return read_note(&path);
    }
    let tmp = path.with_extension("tmp.wav");
    run_piper(app, &voice, &spoken, speed, &tmp)?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("No se pudo guardar la nota de voz: {}", e))?;
    let _ = std::fs::write(&hash_path, &wanted);
    read_note(&path)
}

pub fn note_exists(app: &AppHandle, session: &str, part: &str) -> bool {
    assistant_path(app, session, part).map(|p| p.is_file()).unwrap_or(false)
}

fn note_file(app: &AppHandle, session: &str, key: &str) -> Option<PathBuf> {
    if let Some(base) = key.strip_suffix(".user") {
        return valid_id(base).then(|| user_path(app, session, base)).flatten();
    }
    assistant_path(app, session, key)
}

pub fn read_existing(app: &AppHandle, session: &str, part: &str) -> Result<Vec<u8>, String> {
    let path = note_file(app, session, part).ok_or("Conversación inválida")?;
    read_note(&path)
}

/// Guarda el audio original que mandó la persona desde el celular.
pub fn save_user_note(app: &AppHandle, session: &str, message: &str, wav: &[u8]) -> Result<Value, String> {
    if !is_wav(wav) {
        return Err("El audio no es un WAV válido".into());
    }
    if wav.len() > MAX_USER_WAV {
        return Err("El audio es demasiado largo".into());
    }
    let path = user_path(app, session, message).ok_or("Conversación inválida")?;
    std::fs::write(&path, wav).map_err(|e| format!("No se pudo guardar tu audio: {}", e))?;
    Ok(json!({
        "durationMs": wav_duration_ms(wav).unwrap_or(0),
        "bytes": wav.len() as u64,
    }))
}

/// Inventario liviano de las notas de una conversación para pintar las
/// burbujas sin descargar cada audio. Las claves son el id de la parte; el
/// audio de la persona usa `<mensaje>.user`.
pub fn notes_json(app: &AppHandle, session: &str) -> Value {
    let mut out = Map::new();
    let Some(dir) = session_dir(app, session) else {
        return Value::Object(out);
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Value::Object(out);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        let Some(key) = name.strip_suffix(".wav") else { continue };
        if key.ends_with(".tmp") || key.contains('.') && !key.ends_with(".user") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let mut head = Vec::new();
        if let Ok(mut file) = std::fs::File::open(&path) {
            head.resize(2048, 0);
            let n = file.read(&mut head).unwrap_or(0);
            head.truncate(n);
        }
        let at = meta.modified().ok().and_then(|m| m.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        out.insert(
            key.to_string(),
            json!({
                "durationMs": wav_duration_ms(&head).unwrap_or(0),
                "bytes": meta.len(),
                "at": at,
            }),
        );
    }
    Value::Object(out)
}

pub fn test_audio(app: &AppHandle, text: Option<String>) -> Result<Vec<u8>, String> {
    let config = load(app);
    let speech = text.unwrap_or_else(|| "Hola, soy Flufy. Así te voy a responder cuando me hables.".to_string());
    let spoken = speakable(&speech);
    if spoken.is_empty() {
        return Err("No hay texto para leer".into());
    }
    let dir = data_dir(app).ok_or("Sin carpeta de datos")?;
    let out = dir.join(format!("test-{}.wav", uuid::Uuid::new_v4().simple()));
    let result = run_piper(app, &config.voice_id(), &spoken, config.speed(), &out).and_then(|_| read_note(&out));
    let _ = std::fs::remove_file(&out);
    result
}

/// Borra notas viejas para que la carpeta no crezca sin límite.
pub fn prune(app: &AppHandle) {
    let Some(base) = note_base(app) else { return };
    let cutoff = SystemTime::now() - Duration::from_secs(NOTE_RETENTION_DAYS * 86_400);
    let Ok(entries) = std::fs::read_dir(&base) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let Ok(files) = std::fs::read_dir(&path) else { continue };
            for file in files.flatten() {
                let p = file.path();
                if let Ok(meta) = file.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified < cutoff {
                            let _ = std::fs::remove_file(p);
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Descarga de voces
// ---------------------------------------------------------------------------

fn spawn_download(app: &AppHandle, def: &'static VoiceDef) -> Result<(), String> {
    let state = app.state::<SpeechState>();
    {
        let current = state.download.lock().unwrap();
        if let Some(d) = current.as_ref() {
            if d.error.is_none() {
                return Ok(());
            }
        }
    }
    if model_present(app, def.id) {
        return Ok(());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    *state.download.lock().unwrap() = Some(Download {
        id: def.id.to_string(),
        received: 0,
        total: def.bytes,
        error: None,
        cancel: cancel.clone(),
    });
    let app = app.clone();
    std::thread::spawn(move || {
        let result = download_voice(&app, def, &cancel);
        if let Some(state) = app.try_state::<SpeechState>() {
            match &result {
                Ok(()) => *state.download.lock().unwrap() = None,
                Err(e) if e == "__cancel__" => *state.download.lock().unwrap() = None,
                Err(e) => {
                    if let Some(d) = state.download.lock().unwrap().as_mut() {
                        d.error = Some(e.clone());
                    }
                }
            }
        }
        match result {
            Ok(()) => {
                let _ = app.emit("speech:download", json!({ "id": def.id, "done": true }));
            }
            Err(e) if e == "__cancel__" => {
                let _ = app.emit("speech:download", json!({ "id": def.id, "cancelled": true }));
            }
            Err(e) => {
                let _ = app.emit("speech:download", json!({ "id": def.id, "error": e }));
            }
        }
    });
    Ok(())
}

fn download_voice(app: &AppHandle, def: &'static VoiceDef, cancel: &AtomicBool) -> Result<(), String> {
    let dir = voices_dir(app).ok_or("Sin carpeta de voces")?;
    let model = dir.join(format!("{}.onnx", def.id));
    let config = dir.join(format!("{}.onnx.json", def.id));
    let part = dir.join(format!("{}.onnx.part", def.id));
    let _ = std::fs::remove_file(&part);
    let url = format!("{}/{}.onnx", HF_BASE, def.path);
    let response = ureq::get(&url).call().map_err(|e| format!("No se pudo descargar la voz: {}", e))?;
    let total: u64 = response.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(def.bytes);
    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 65_536];
    let mut received: u64 = 0;
    let mut last = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            let _ = std::fs::remove_file(&part);
            return Err("__cancel__".into());
        }
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        received += n as u64;
        if last.elapsed() > Duration::from_millis(250) {
            last = Instant::now();
            if let Some(state) = app.try_state::<SpeechState>() {
                if let Some(d) = state.download.lock().unwrap().as_mut() {
                    d.received = received;
                    d.total = total;
                }
            }
            let _ = app.emit("speech:download", json!({ "id": def.id, "received": received, "total": total }));
        }
    }
    file.flush().ok();
    drop(file);
    if received < 10_000 {
        let _ = std::fs::remove_file(&part);
        return Err("La descarga de la voz llegó incompleta".into());
    }
    std::fs::rename(&part, &model).map_err(|e| e.to_string())?;
    let json_url = format!("{}/{}.onnx.json", HF_BASE, def.path);
    let body = ureq::get(&json_url).call().map_err(|e| format!("No se pudo descargar la configuración de la voz: {}", e))?.into_string().map_err(|e| e.to_string())?;
    std::fs::write(&config, body).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Comandos de escritorio
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn speech_get(app: AppHandle) -> SpeechView {
    view(&app)
}

#[tauri::command]
pub async fn speech_set(app: AppHandle, enabled: bool, voice: String, speed: f64) -> Result<SpeechView, String> {
    tauri::async_runtime::spawn_blocking(move || Ok::<SpeechView, String>(update(&app, Some(enabled), Some(voice), Some(speed))))
        .await
        .unwrap()
}

#[tauri::command]
pub fn speech_download_voice(app: AppHandle, id: String) -> Result<(), String> {
    let def = voice_def(&id).ok_or_else(|| format!("Voz desconocida: {}", id))?;
    spawn_download(&app, def)
}

#[tauri::command]
pub fn speech_cancel_download(app: AppHandle) {
    if let Some(state) = app.try_state::<SpeechState>() {
        if let Some(d) = state.download.lock().unwrap().as_ref() {
            d.cancel.store(true, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
pub fn speech_delete_voice(app: AppHandle, id: String) -> Result<(), String> {
    let def = voice_def(&id).ok_or_else(|| format!("Voz desconocida: {}", id))?;
    if let Some(dir) = voices_dir(&app) {
        let _ = std::fs::remove_file(dir.join(format!("{}.onnx", def.id)));
        let _ = std::fs::remove_file(dir.join(format!("{}.onnx.json", def.id)));
        let _ = std::fs::remove_file(dir.join(format!("{}.onnx.part", def.id)));
    }
    Ok(())
}

#[tauri::command]
pub async fn speech_test(app: AppHandle, text: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        test_audio(&app, text).map(|bytes| STANDARD.encode(bytes))
    })
    .await
    .unwrap()
}

/// Descarga una voz desde el hub del celular, sin pasar por la app de escritorio.
pub fn hub_download(app: &AppHandle, id: &str) -> Result<Value, String> {
    let def = voice_def(id).ok_or_else(|| format!("Voz desconocida: {}", id))?;
    spawn_download(app, def)?;
    Ok(status_json(app))
}

pub fn hub_update(app: &AppHandle, body: &Value) -> Value {
    let view = update(
        app,
        body["enabled"].as_bool(),
        body["voice"].as_str().map(|s| s.to_string()),
        body["speed"].as_f64(),
    );
    serde_json::to_value(view).unwrap_or_else(|_| json!({ "ready": false }))
}

pub fn hub_save_user(app: &AppHandle, session: &str, message: &str, wav: &[u8]) -> Result<Value, String> {
    save_user_note(app, session, message, wav)
}

pub fn hub_note(app: &AppHandle, session: &str, part: &str, text: &str) -> Result<Vec<u8>, String> {
    ensure_note(app, session, part, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speakable_strips_code_and_markdown() {
        let text = "Listo. Cambié `voice.rs`.\n\n```ts\nconst x = 1\n```\n\nMás detalles en [la guía](https://example.com).";
        assert_eq!(speakable(text), "Listo. Cambié voice.rs. Más detalles en la guía.");
    }

    #[test]
    fn speakable_drops_urls_and_tables() {
        let text = "Mirá https://example.com/x y esto:\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
        assert_eq!(speakable(text), "Mirá y esto:");
    }

    #[test]
    fn speakable_returns_empty_for_pure_code() {
        assert_eq!(speakable("```sh\nnpm run build\n```"), "");
    }

    #[test]
    fn speakable_drops_commands_but_keeps_file_names() {
        assert_eq!(speakable("Corré `npm run build` y mirá `voice.rs`."), "Corré y mirá voice.rs.");
    }

    #[test]
    fn speakable_keeps_spanish_punctuation() {
        assert_eq!(speakable("¿Listo? ¡Sí!"), "¿Listo? ¡Sí!");
    }

    #[test]
    fn speakable_caps_long_text() {
        let text = "palabra ".repeat(400);
        let out = speakable(&text);
        assert!(out.chars().count() < 1_100, "quedó demasiado largo: {}", out.chars().count());
        assert!(out.ends_with("El resto quedó en pantalla."));
    }

    #[test]
    fn wav_duration_reads_byte_rate() {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&0u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&22_050u32.to_le_bytes());
        wav.extend_from_slice(&44_100u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&44_100u32.to_le_bytes());
        assert_eq!(wav_duration_ms(&wav), Some(1_000));
    }

    #[test]
    fn ids_reject_traversal() {
        assert!(valid_id("prt_abc123"));
        assert!(valid_id("msg-123_AB"));
        assert!(!valid_id("../secret"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id(""));
        assert!(!valid_id("x".repeat(200).as_str()));
    }
}
