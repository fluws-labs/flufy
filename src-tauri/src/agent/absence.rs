use crate::oc::Opencode;
use crate::push::{self, Kind as PushKind, Notice};
use crate::{accounts, ensure_server, machine, memory, remote};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;

const DEFAULT_HOURS: i64 = 12;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AbsenceCheck {
    pub id: String,
    pub status: String,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AbsenceState {
    pub enabled: bool,
    pub started_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub ready: bool,
    pub checks: Vec<AbsenceCheck>,
    pub updated: Option<String>,
}

fn now_ms() -> i64 {
    chrono::Local::now().timestamp_millis()
}

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn check(id: &str, status: &str, detail: impl Into<String>, fix: Option<&str>) -> AbsenceCheck {
    AbsenceCheck {
        id: id.into(),
        status: status.into(),
        detail: detail.into(),
        fix: fix.map(|value| value.to_string()),
    }
}

fn load(app: &AppHandle) -> AbsenceState {
    let state = memory::agent_state(app);
    serde_json::from_value(state["absence"].clone()).unwrap_or_default()
}

fn persist(app: &AppHandle, absence: &AbsenceState) -> Result<AbsenceState, String> {
    let mut state = memory::agent_state(app);
    state["absence"] = serde_json::to_value(absence).map_err(|error| error.to_string())?;
    state["updated"] = json!(now_iso());
    memory::save_agent_state(app, &state)?;
    Ok(absence.clone())
}

fn ready(checks: &[AbsenceCheck]) -> bool {
    checks.iter().all(|item| item.status != "fail")
}

fn autostart_check(app: &AppHandle) -> AbsenceCheck {
    match crate::hub::autostart_get(app.clone()) {
        Ok(true) => check("autostart", "ok", "Flufy arranca con Windows.", None),
        Ok(false) => check(
            "autostart",
            "warn",
            "Flufy no arranca con Windows.",
            Some("Activalo en Ajustes o volvé a ejecutar «Preparar para ausencia»."),
        ),
        Err(error) => check("autostart", "warn", format!("No pude leer el autostart: {}", error), None),
    }
}

fn tray_check() -> AbsenceCheck {
    check(
        "tray",
        "warn",
        "Cerrar la ventana debe dejar Flufy en la bandeja.",
        Some("Revisá «Al cerrar la ventana» en Ajustes; si cierra la app, la ausencia se corta."),
    )
}

fn power_check() -> AbsenceCheck {
    let status = machine::status();
    if status.on_battery && status.battery.map(|battery| battery < 30).unwrap_or(false) {
        return check(
            "power",
            "fail",
            format!("La PC está con batería baja ({}%).", status.battery.unwrap_or(0)),
            Some("Conectá el cargador antes de irte."),
        );
    }
    if status.lid_sleeps {
        return check(
            "power",
            "warn",
            "Cerrar la tapa puede suspender la PC.",
            Some("Dejá la tapa abierta o cambiá la acción de la tapa en Windows."),
        );
    }
    check("power", "ok", "La PC no se va a suspender por inactividad.", None)
}

fn remote_check(app: &AppHandle) -> AbsenceCheck {
    if remote::is_enabled(app) {
        check("remote", "ok", "El acceso desde el celular está habilitado.", None)
    } else {
        check(
            "remote",
            "fail",
            "El acceso desde el celular está apagado.",
            Some("Activalo en la tarjeta «Tu PC» o con «Conectar el celular»."),
        )
    }
}

fn push_check(app: &AppHandle) -> AbsenceCheck {
    let devices = push::device_count(app);
    if devices == 0 {
        return check(
            "push",
            "fail",
            "No hay ningún teléfono suscripto a las notificaciones.",
            Some("Abrí el PWA en el teléfono y activá las notificaciones."),
        );
    }
    let notice = Notice {
        kind: PushKind::Test,
        title: "Flufy: prueba de ausencia".into(),
        body: "Si ves esto, las notificaciones del modo ausencia funcionan.".into(),
        tag: "absence-test".into(),
        url: "/?agent=missions".into(),
    };
    match push::send(app, notice, None) {
        Ok(sent) if sent > 0 => check("push", "ok", format!("Notificación de prueba enviada a {} dispositivo(s).", sent), None),
        Ok(_) => check("push", "warn", "No se envió la prueba a ningún dispositivo.", Some("Revisá las preferencias de notificaciones del PWA.")),
        Err(error) => check("push", "warn", format!("No pude enviar la prueba: {}", error), Some("Revisá la conexión y las notificaciones del teléfono.")),
    }
}

fn model_check(app: &AppHandle) -> AbsenceCheck {
    let result = (|| -> Result<usize, String> {
        let server = ensure_server(app)?;
        let project = crate::current_project(app);
        let client = Opencode::new(&server, &project);
        let providers = client.get("/config/providers")?;
        Ok(accounts::available_models(&providers).len())
    })();
    match result {
        Ok(count) if count > 0 => check("model", "ok", format!("{} modelo(s) disponible(s) para las misiones.", count), None),
        Ok(_) => check(
            "model",
            "fail",
            "No hay modelos disponibles.",
            Some("Conectá una cuenta de IA en Ajustes → Cuentas de IA."),
        ),
        Err(error) => check("model", "fail", format!("No pude verificar el modelo: {}", error), Some("Abrí Flufy y revisá Cuentas de IA.")),
    }
}

fn missions_check(app: &AppHandle) -> AbsenceCheck {
    let armed = crate::agent::missions::list(app)
        .into_iter()
        .filter(|mission| mission.status == "armed")
        .count();
    if armed == 0 {
        return check(
            "missions",
            "warn",
            "No hay misiones armadas.",
            Some("Armá una misión o el modo ausencia no va a tener nada que hacer."),
        );
    }
    check("missions", "ok", format!("{} misión(es) armada(s).", armed), None)
}

fn guard_check() -> AbsenceCheck {
    check(
        "guard",
        "ok",
        "El guard de acciones está activo y no necesita configuración.",
        None,
    )
}

fn browser_check(app: &AppHandle) -> AbsenceCheck {
    match crate::desktop::browser::mission_browser_ready(app) {
        Ok(_) => check(
            "browser",
            "ok",
            "Navegador interno de Flufy listo para las misiones: se abre solo cuando un bot lo usa.",
            None,
        ),
        Err(error) => check(
            "browser",
            "fail",
            format!("No pude preparar el navegador interno: {}", error),
            Some("Activá las herramientas del navegador en Control de la PC y probá desde Flufy Bots."),
        ),
    }
}

fn assemble(app: &AppHandle) -> Vec<AbsenceCheck> {
    vec![
        autostart_check(app),
        tray_check(),
        power_check(),
        remote_check(app),
        push_check(app),
        model_check(app),
        missions_check(app),
        guard_check(),
        browser_check(app),
    ]
}

pub fn status(app: &AppHandle) -> AbsenceState {
    load(app)
}

pub fn prepare(app: &AppHandle) -> Result<AbsenceState, String> {
    machine::keep_awake(true);
    let checks = assemble(app);
    let now = now_ms();
    let state = AbsenceState {
        enabled: true,
        started_at: Some(now),
        expires_at: Some(now + DEFAULT_HOURS * 3_600_000),
        ready: ready(&checks),
        checks,
        updated: Some(now_iso()),
    };
    persist(app, &state)?;
    let fails = state.checks.iter().filter(|item| item.status == "fail").count();
    push::send_in_background(
        app,
        Notice {
            kind: if state.ready { PushKind::Done } else { PushKind::Attention },
            title: if state.ready {
                "Flufy listo para ausencia".into()
            } else {
                "Flufy no está listo para ausencia".into()
            },
            body: if fails == 0 {
                "Todo lo necesario quedó preparado.".into()
            } else {
                format!("{} punto(s) necesitan tu atención.", fails)
            },
            tag: "absence-ready".into(),
            url: "/?agent=missions".into(),
        },
    );
    Ok(state)
}

pub fn stop(app: &AppHandle) -> Result<AbsenceState, String> {
    if !remote::is_enabled(app) {
        machine::keep_awake(false);
    }
    let mut state = load(app);
    state.enabled = false;
    state.ready = false;
    state.updated = Some(now_iso());
    persist(app, &state)
}

pub fn resume(app: &AppHandle) {
    let mut state = load(app);
    if !state.enabled {
        return;
    }
    let alive = state.expires_at.map(|expires| expires > now_ms()).unwrap_or(true);
    if alive {
        machine::keep_awake(true);
        return;
    }
    state.enabled = false;
    state.ready = false;
    state.updated = Some(now_iso());
    let _ = persist(app, &state);
    if !remote::is_enabled(app) {
        machine::keep_awake(false);
    }
}

#[tauri::command]
pub fn agent_absence_status(app: AppHandle) -> AbsenceState {
    status(&app)
}

#[tauri::command]
pub fn agent_absence_prepare(app: AppHandle) -> Result<AbsenceState, String> {
    prepare(&app)
}

#[tauri::command]
pub fn agent_absence_stop(app: AppHandle) -> Result<AbsenceState, String> {
    stop(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, status: &str) -> AbsenceCheck {
        check(id, status, "detalle", None)
    }

    #[test]
    fn ready_requires_no_failures() {
        assert!(ready(&[sample("a", "ok"), sample("b", "warn")]));
        assert!(!ready(&[sample("a", "ok"), sample("b", "fail")]));
        assert!(ready(&[]));
    }

    #[test]
    fn checks_serialize_with_camel_case_and_optional_fix() {
        let value = serde_json::to_value(sample("browser", "warn")).unwrap();
        assert_eq!(value["id"], "browser");
        assert_eq!(value["status"], "warn");
        assert!(value.get("fix").is_none());
    }
}
