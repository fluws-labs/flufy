//! System resource awareness for the local engine and the team scheduler.
//!
//! Flufy can only throttle its own work; it never kills user processes. The
//! monitor keeps a reserve of commit/RAM and the team scheduler refuses to
//! dispatch new agents when the PC is at the limit.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const SAMPLE_MS: u64 = 3_000;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub total_memory_mb: u64,
    pub available_memory_mb: u64,
    pub commit_limit_mb: u64,
    pub commit_available_mb: u64,
    pub cpu_percent: f32,
    pub process_count: usize,
    pub other_flufy_instances: usize,
    pub pressure: String,
    pub updated_at: i64,
}

impl Default for ResourceSnapshot {
    fn default() -> Self {
        Self {
            total_memory_mb: 0,
            available_memory_mb: 0,
            commit_limit_mb: 0,
            commit_available_mb: 0,
            cpu_percent: 0.0,
            process_count: 0,
            other_flufy_instances: 0,
            pressure: "normal".into(),
            updated_at: 0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ResourceConfig {
    pub auto_throttle: bool,
    /// Commit (virtual memory) that Flufy must leave free for the rest of the PC.
    pub reserve_commit_mb: u64,
    /// Physical RAM that Flufy must leave free.
    pub reserve_memory_mb: u64,
    /// Conservative estimate per agent session.
    pub per_agent_mb: u64,
    /// Hard cap even if the user configured a larger team.
    pub max_agents: usize,
}

impl Default for ResourceConfig {
    fn default() -> Self {
        Self {
            auto_throttle: true,
            reserve_commit_mb: 2048,
            reserve_memory_mb: 1536,
            per_agent_mb: 700,
            max_agents: 10,
        }
    }
}

impl ResourceConfig {
    pub fn clamped(mut self) -> Self {
        self.reserve_commit_mb = self.reserve_commit_mb.clamp(512, 16_384);
        self.reserve_memory_mb = self.reserve_memory_mb.clamp(512, 16_384);
        self.per_agent_mb = self.per_agent_mb.clamp(128, 4_096);
        self.max_agents = self.max_agents.clamp(1, 16);
        self
    }
}

pub struct ResourceState {
    snapshot: Mutex<ResourceSnapshot>,
    config: Mutex<ResourceConfig>,
    last_pressure: Mutex<String>,
}

impl ResourceState {
    fn new(config: ResourceConfig) -> Self {
        Self {
            snapshot: Mutex::new(ResourceSnapshot::default()),
            config: Mutex::new(config),
            last_pressure: Mutex::new(String::new()),
        }
    }
}

fn config_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::app_data_file(app, "resources.json")
}

fn load_config(app: &AppHandle) -> ResourceConfig {
    config_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<ResourceConfig>(&text).ok())
        .unwrap_or_default()
        .clamped()
}

fn save_config(app: &AppHandle, config: &ResourceConfig) -> Result<(), String> {
    let Some(path) = config_path(app) else {
        return Err("No se pudo localizar la carpeta de datos".into());
    };
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

pub fn start(app: &AppHandle) {
    let config = load_config(app);
    app.manage(ResourceState::new(config));
    let handle = app.clone();
    let _ = std::thread::Builder::new()
        .name("flufy-resources".into())
        .spawn(move || loop {
            let config = handle
                .try_state::<ResourceState>()
                .map(|state| state.config.lock().map(|c| c.clone()).unwrap_or_default())
                .unwrap_or_default();
            let snapshot = sample(&config);
            if let Some(state) = handle.try_state::<ResourceState>() {
                if let Ok(mut current) = state.snapshot.lock() {
                    *current = snapshot.clone();
                }
                let changed = state
                    .last_pressure
                    .lock()
                    .map(|mut last| {
                        if *last == snapshot.pressure {
                            false
                        } else {
                            *last = snapshot.pressure.clone();
                            true
                        }
                    })
                    .unwrap_or(false);
                if changed {
                    let _ = handle.emit("resources://changed", snapshot.clone());
                }
            }
            std::thread::sleep(Duration::from_millis(SAMPLE_MS));
        });
}

fn pressure_for(snapshot: &ResourceSnapshot, config: &ResourceConfig) -> &'static str {
    let commit = snapshot.commit_available_mb;
    let memory = snapshot.available_memory_mb;
    if commit < config.reserve_commit_mb || memory < config.reserve_memory_mb {
        return "critical";
    }
    if commit < config.reserve_commit_mb.saturating_mul(2)
        || memory < config.reserve_memory_mb.saturating_mul(2)
        || snapshot.cpu_percent >= 95.0
    {
        return "tight";
    }
    "normal"
}

/// Total worker budget for a team. `0` means "do not dispatch new work".
pub fn limit_for(
    snapshot: &ResourceSnapshot,
    config: &ResourceConfig,
    configured: usize,
) -> usize {
    if !config.auto_throttle {
        return configured.min(config.max_agents);
    }
    if snapshot.pressure == "critical" {
        return 0;
    }
    let per_agent = config.per_agent_mb.max(128);
    let commit_budget = snapshot
        .commit_available_mb
        .saturating_sub(config.reserve_commit_mb)
        / per_agent;
    let memory_budget = snapshot
        .available_memory_mb
        .saturating_sub(config.reserve_memory_mb)
        / per_agent;
    let mut limit = configured
        .min(config.max_agents)
        .min(commit_budget as usize)
        .min(memory_budget as usize);
    if snapshot.pressure == "tight" {
        limit = limit.min(2);
    }
    // Another Flufy instance already contributes to the system pressure. Keep
    // this instance conservative instead of competing for the same reserve.
    if snapshot.other_flufy_instances > 0 {
        limit = limit.min(2);
    }
    limit
}

pub fn worker_limit(app: &AppHandle, configured: usize) -> usize {
    let Some(state) = app.try_state::<ResourceState>() else {
        return configured;
    };
    let snapshot = state.snapshot.lock().map(|s| s.clone()).unwrap_or_default();
    let config = state.config.lock().map(|c| c.clone()).unwrap_or_default();
    limit_for(&snapshot, &config, configured)
}

pub fn pressure(app: &AppHandle) -> String {
    app.try_state::<ResourceState>()
        .and_then(|state| state.snapshot.lock().ok().map(|s| s.pressure.clone()))
        .unwrap_or_else(|| "normal".into())
}

pub fn tool_payload(app: &AppHandle) -> Value {
    let (snapshot, config) = match app.try_state::<ResourceState>() {
        Some(state) => (
            state.snapshot.lock().map(|s| s.clone()).unwrap_or_default(),
            state.config.lock().map(|c| c.clone()).unwrap_or_default(),
        ),
        None => (ResourceSnapshot::default(), ResourceConfig::default()),
    };
    json!({
        "snapshot": snapshot,
        "config": config,
        "recommendedWorkers": limit_for(&snapshot, &config, config.max_agents),
        "note": "Flufy solo limita su propio trabajo; no cierra programas del usuario. Si pressure es critical, no inicies trabajo nuevo."
    })
}

#[tauri::command]
pub fn resources_status(state: State<'_, ResourceState>) -> ResourceSnapshot {
    state.snapshot.lock().map(|s| s.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn resources_config_get(state: State<'_, ResourceState>) -> ResourceConfig {
    state.config.lock().map(|c| c.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn resources_config_set(
    app: AppHandle,
    state: State<'_, ResourceState>,
    config: ResourceConfig,
) -> Result<ResourceConfig, String> {
    let config = config.clamped();
    save_config(&app, &config)?;
    if let Ok(mut current) = state.config.lock() {
        *current = config.clone();
    }
    let snapshot = state.snapshot.lock().map(|s| s.clone()).unwrap_or_default();
    let _ = app.emit("resources://changed", snapshot);
    Ok(config)
}

#[cfg(windows)]
fn sample(config: &ResourceConfig) -> ResourceSnapshot {
    let (total_memory_mb, available_memory_mb, commit_limit_mb, commit_available_mb) = memory();
    let (process_count, other_flufy_instances) = processes();
    let mut snapshot = ResourceSnapshot {
        total_memory_mb,
        available_memory_mb,
        commit_limit_mb,
        commit_available_mb,
        cpu_percent: cpu(),
        process_count,
        other_flufy_instances,
        pressure: String::new(),
        updated_at: chrono::Utc::now().timestamp_millis(),
    };
    snapshot.pressure = pressure_for(&snapshot, config).to_string();
    snapshot
}

#[cfg(not(windows))]
fn sample(config: &ResourceConfig) -> ResourceSnapshot {
    let mut snapshot = ResourceSnapshot {
        updated_at: chrono::Utc::now().timestamp_millis(),
        ..Default::default()
    };
    snapshot.pressure = pressure_for(&snapshot, config).to_string();
    snapshot
}

#[cfg(windows)]
fn memory() -> (u64, u64, u64, u64) {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    if unsafe { GlobalMemoryStatusEx(&mut status) }.is_err() {
        return (0, 0, 0, 0);
    }
    let mb = |bytes: u64| bytes / (1024 * 1024);
    (
        mb(status.ullTotalPhys),
        mb(status.ullAvailPhys),
        mb(status.ullTotalPageFile),
        mb(status.ullAvailPageFile),
    )
}

#[cfg(windows)]
fn filetime(value: windows::Win32::Foundation::FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

#[cfg(windows)]
fn cpu() -> f32 {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetSystemTimes;
    static PREVIOUS: OnceLock<Mutex<Option<(u64, u64, u64)>>> = OnceLock::new();
    let mut idle = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.is_err() {
        return 0.0;
    }
    let (idle, kernel, user) = (filetime(idle), filetime(kernel), filetime(user));
    let lock = PREVIOUS.get_or_init(|| Mutex::new(None));
    let Ok(mut previous) = lock.lock() else {
        return 0.0;
    };
    let percent = previous.map(|(pi, pk, pu)| {
        let total = kernel.saturating_sub(pk) + user.saturating_sub(pu);
        if total == 0 {
            0.0
        } else {
            ((total.saturating_sub(idle.saturating_sub(pi))) as f64 / total as f64 * 100.0) as f32
        }
    }).unwrap_or(0.0);
    *previous = Some((idle, kernel, user));
    percent.clamp(0.0, 100.0)
}

#[cfg(windows)]
fn processes() -> (usize, usize) {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return (0, 0);
    };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let current = std::process::id();
    let mut total = 0usize;
    let mut other_flufy = 0usize;
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
        loop {
            total += 1;
            if entry.th32ProcessID != current {
                let name = String::from_utf16_lossy(&entry.szExeFile)
                    .trim_end_matches('\0')
                    .to_ascii_lowercase();
                if name == "app.exe" || name == "flufy.exe" {
                    if let Ok(handle) = unsafe {
                        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, entry.th32ProcessID)
                    } {
                        let mut buffer = [0u16; 1024];
                        let mut length = buffer.len() as u32;
                        if unsafe {
                            QueryFullProcessImageNameW(
                                handle,
                                PROCESS_NAME_WIN32,
                                PWSTR(buffer.as_mut_ptr()),
                                &mut length,
                            )
                        }
                        .is_ok()
                        {
                            let path = String::from_utf16_lossy(&buffer[..length as usize])
                                .to_ascii_lowercase();
                            if path.contains("flufy") || path.contains("guillecode") {
                                other_flufy += 1;
                            }
                        }
                        let _ = unsafe { CloseHandle(handle) };
                    }
                }
            }
            if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }
    let _ = unsafe { CloseHandle(snapshot) };
    (total, other_flufy)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(commit: u64, memory: u64, cpu: f32, others: usize) -> ResourceSnapshot {
        ResourceSnapshot {
            commit_available_mb: commit,
            available_memory_mb: memory,
            cpu_percent: cpu,
            other_flufy_instances: others,
            ..Default::default()
        }
    }

    #[test]
    fn pressure_keeps_a_reserve() {
        let config = ResourceConfig::default();
        let mut normal = snapshot(20_000, 16_000, 10.0, 0);
        normal.pressure = pressure_for(&normal, &config).into();
        assert_eq!(normal.pressure, "normal");
        let tight = snapshot(3_500, 2_500, 10.0, 0);
        assert_eq!(pressure_for(&tight, &config), "tight");
        let critical = snapshot(1_500, 1_000, 10.0, 0);
        assert_eq!(pressure_for(&critical, &config), "critical");
    }

    #[test]
    fn critical_pressure_blocks_new_workers() {
        let config = ResourceConfig::default();
        let mut critical = snapshot(1_500, 1_000, 10.0, 0);
        critical.pressure = "critical".into();
        assert_eq!(limit_for(&critical, &config, 10), 0);
    }

    #[test]
    fn tight_pressure_and_another_instance_cap_the_team() {
        let config = ResourceConfig::default();
        let mut tight = snapshot(4_000, 3_000, 10.0, 0);
        tight.pressure = "tight".into();
        assert_eq!(limit_for(&tight, &config, 10), 2);
        let mut normal = snapshot(20_000, 16_000, 10.0, 1);
        normal.pressure = "normal".into();
        assert_eq!(limit_for(&normal, &config, 10), 2);
    }

    #[test]
    fn low_commit_reduces_the_budget() {
        let config = ResourceConfig::default();
        let mut normal = snapshot(4_100, 16_000, 10.0, 0);
        normal.pressure = "normal".into();
        // (4100 - 2048) / 700 = 2
        assert_eq!(limit_for(&normal, &config, 10), 2);
    }

    #[cfg(windows)]
    #[test]
    fn reads_real_memory_and_processes() {
        let snapshot = sample(&ResourceConfig::default());
        assert!(snapshot.total_memory_mb > 0, "total memory");
        assert!(snapshot.commit_limit_mb > 0, "commit limit");
        assert!(snapshot.process_count > 0, "process count");
    }

    #[test]
    fn config_is_clamped() {
        let config = ResourceConfig {
            reserve_commit_mb: 1,
            reserve_memory_mb: 999_999,
            per_agent_mb: 1,
            max_agents: 99,
            ..Default::default()
        }
        .clamped();
        assert_eq!(config.reserve_commit_mb, 512);
        assert_eq!(config.reserve_memory_mb, 16_384);
        assert_eq!(config.per_agent_mb, 128);
        assert_eq!(config.max_agents, 16);
    }
}
