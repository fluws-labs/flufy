use crate::memory;
use std::path::PathBuf;
use tauri::AppHandle;

const MAX_BODY: usize = 50_000;

fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in name.chars().flat_map(|ch| ch.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    out.trim_matches('-').chars().take(48).collect()
}

pub fn dir(app: &AppHandle) -> PathBuf {
    memory::agent_root(app).join("playbooks")
}

fn path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let slug = slug(name);
    if slug.is_empty() {
        return Err("El playbook necesita un nombre.".into());
    }
    Ok(dir(app).join(format!("{}.md", slug)))
}

pub fn read(app: &AppHandle, name: &str) -> Result<String, String> {
    let path = path(app, name)?;
    std::fs::read_to_string(&path).map_err(|error| format!("No se pudo leer el playbook «{}»: {}", name, error))
}

pub fn list(app: &AppHandle) -> Vec<String> {
    let dir = dir(app);
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter_map(|entry| {
                    let path = entry.path();
                    if path.extension().is_some_and(|ext| ext == "md") {
                        path.file_stem().map(|stem| stem.to_string_lossy().to_string())
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn validate(name: &str, body: &str) -> Result<(), String> {
    if slug(name).is_empty() {
        return Err("El playbook necesita un nombre.".into());
    }
    if body.trim().is_empty() {
        return Err("El playbook está vacío.".into());
    }
    if body.chars().count() > MAX_BODY {
        return Err(format!("El playbook no puede superar los {} caracteres.", MAX_BODY));
    }
    if !body.trim_start().starts_with("---") {
        return Err("El playbook necesita frontmatter entre ---.".into());
    }
    if !body.to_lowercase().contains("name:") {
        return Err("El frontmatter del playbook necesita un campo name.".into());
    }
    Ok(())
}

pub fn save(app: &AppHandle, name: &str, body: &str) -> Result<(), String> {
    validate(name, body)?;
    memory::atomic_write(&path(app, name)?, body)
}

const BRIEFING: &str = r#"---
name: briefing
title: Briefing diario
sites: [gmail, calendar]
readOnly: true
commitActions: []
needs: [browser]
version: 1
---
## Objetivo
Leer los mails no leídos de las últimas 24 h y los eventos de hoy, y dejar un resumen breve en la bandeja.

## Pasos
1. Usá `browser_list_pages`. Si no hay una ventana asignada para misiones, terminá con `status: blocked` y `handoff.reason: login` explicando que falta asignar Chrome.
2. Abrí una pestaña nueva para https://mail.google.com/ con `browser_navigate_page` sin `pageId`; no uses `browser_new_page`. Si falla, usá una pestaña `chrome://new-tab-page` o `about:blank` de la ventana asignada y navegala con `pageId`. No uses la pestaña activa del usuario.
3. Si aparece login, 2FA o un captcha, terminá con `status: needs-hands` y explicá qué hacer. No intentes adivinar credenciales.
4. Leé asuntos y remitentes de los no leídos recientes con `browser_take_snapshot` (verbose=false). No abras adjuntos ni enlaces.
5. Repetí con https://calendar.google.com/ para los eventos de hoy. No uses `browser_new_page`; navegá una pestaña nueva o una `chrome://new-tab-page`/`about:blank` con `pageId`.
6. No escribas, no archives, no envíes nada.

## Salida
Devolvé un único bloque JSON con `status: ok`, un `summary` de 2-3 líneas y hasta 5 `items` con `kind: result`.
"#;

const RESEARCH_DOC: &str = r#"---
name: research-doc
title: Investigación con Google Doc
sites: [google, docs.google.com]
readOnly: false
commitActions: [create-document]
needs: [browser]
version: 1
---
## Objetivo
Investigar el tema del pedido y crear un Google Doc con hallazgos, fuentes y conclusiones. No compartas, no envíes y no publiques.

## Pasos
1. Usá `browser_list_pages`. Si no hay una ventana asignada para misiones, terminá con `status: blocked` y explicá que falta asignar Chrome.
2. Abrí una pestaña nueva con `browser_navigate_page` sin `pageId` a `https://www.google.com/search?q=<tema>`. No uses la pestaña activa del usuario.
3. Leé los resultados con `browser_take_snapshot` (verbose=false). Abrí 2 o 3 fuentes en pestañas nuevas y leé lo necesario. Marcá como `untrusted: true` lo que venga de la web.
4. Abrí SIEMPRE una pestaña nueva con `https://docs.new`. No reutilices una pestaña de docs.google.com que ya esté abierta ni un documento de una corrida anterior. Si el documento tiene contenido, abrí otra pestaña nueva y no escribas sobre el anterior. Si pide login, 2FA o captcha, terminá con `status: needs-hands` y el motivo.
5. Creá el documento: título «Investigación — <tema>»; escribí el contenido UNA sola vez: resumen, 3-6 hallazgos con su fuente y una sección de límites o dudas. Verificá que el cuerpo esté vacío antes de escribir. No repitas secciones ni vuelvas a escribir el mismo texto; si el editor ya lo tiene, no lo agregues de nuevo.
6. Verificá que el documento es nuevo, que la URL es de docs.google.com y que el texto aparece una sola vez. No compartas ni envíes.
7. Devolvé `status: ok` con un `item result` cuyo `body` incluya la URL del documento y un resumen de lo investigado.
8. Al terminar, cerrá con `browser_close_page` las pestañas que abriste y no uses (búsquedas, fuentes, documentos vacíos). No cierres pestañas del usuario. Dejá abierta solo la del documento final.

## Salida
Un único bloque JSON con `status`, `summary` e `items`. Si no pudiste crear el documento, `status: blocked` y explicá el paso exacto que falló.
"#;

const DESKTOP_DEMO: &str = r#"---
name: desktop-demo
title: Prueba de escritorio
sites: []
readOnly: false
commitActions: []
needs: [desktop]
version: 1
---
## Objetivo
Comprobar que una misión puede operar una app abierta del escritorio sin tocar Flufy.

## Pasos
1. Usá `desktop_windows` y elegí la ventana **flufy-desktop-test.txt** (Notepad). No uses otras ventanas de Notepad ni ninguna de Flufy. Si no existe, terminá con `status: blocked` y explicá que hace falta abrir el archivo de prueba.
2. `desktop_focus_window`, `desktop_snapshot` y `desktop_click` en el área de texto.
3. Escribí una sola vez: `Prueba de escritorio de Flufy <fecha y hora>`. No cierres la ventana ni toques Flufy.
4. Verificá con `desktop_read` o `desktop_snapshot` que el texto está una sola vez.
5. Devolvé `status: ok` con un `item result` que diga qué ventana usaste y el texto escrito.

## Salida
Un único bloque JSON con `status`, `summary` e `items`.
"#;

const PROJECT_WRITE: &str = r#"---
name: project-write
title: Escritura en proyecto
sites: []
readOnly: false
commitActions: [write]
needs: [files]
version: 1
---
## Objetivo
Escribir un archivo dentro del proyecto declarado y verificarlo. No tocar otros archivos.

## Pasos
1. En la raíz del proyecto, escribí `prueba-escritura.txt` con el texto `ok` usando `write`.
2. Leé el archivo con `read` para verificar que contiene `ok` una sola vez.
3. No modifiques otros archivos, no hagas commit ni push.
4. Devolvé `status: ok` con un `item result` que diga qué archivo escribiste y que lo verificaste.

## Salida
Un único bloque JSON con `status`, `summary` e `items`.
"#;

const HANDOFF_DEMO: &str = r#"---
name: handoff-demo
title: Prueba de manos remotas
sites: []
readOnly: true
commitActions: []
needs: [desktop]
version: 1
---
## Objetivo
Demostrar el ciclo de manos remotas: pedir ayuda y, cuando el usuario la resuelve, continuar.

## Pasos
1. Si el prompt incluye **Aprobación concedida** o **resolvió el bloqueo**: verificá con `desktop_windows` que existe la ventana `flufy-desktop-test.txt` y devolvé `status: ok` con un `item result` que diga “Resuelto”. No escribas en la ventana.
2. Si NO hay resolución: no toques nada. Devolvé `status: needs-hands` con `handoff: {"reason":"other","detail":"Revisá la ventana de prueba y tocá Listo, continuar.","url":""}`.

## Salida
Un único bloque JSON con `status`, `summary` e `items` (y `handoff` cuando corresponda).
"#;

const PROJECT_CHECK: &str = r#"---
name: project-check
title: Revisión de proyecto
sites: []
readOnly: true
commitActions: []
needs: [files, terminal]
version: 1
---
## Objetivo
Revisar un proyecto local sin modificarlo: leer archivos y ejecutar solo comandos de lectura.

## Pasos
1. Leé `package.json` y listá `src-tauri/src/agent` con `read`/`glob`.
2. Ejecutá `git status --short` con `bash` o `terminal_run`. No escribas archivos, no hagas commit, no cambies ramas.
3. Si el comando falla, explicá el error y terminá `blocked`.
4. Devolvé `status: ok` con un `summary` y hasta 3 `items` con lo observado.

## Salida
Un único bloque JSON con `status`, `summary` e `items`.
"#;

const APPROVAL_DEMO: &str = r#"---
name: approval-demo
title: Prueba de aprobación
sites: []
readOnly: false
commitActions: [write]
needs: [desktop]
version: 1
---
## Objetivo
Demostrar el ciclo de aprobación: primero pedir permiso y, después de aprobado, ejecutar el paso una sola vez.

## Pasos
1. Si el prompt incluye **Aprobación concedida**: usá `desktop_windows`, elegí la ventana **flufy-desktop-test.txt** (Notepad), enfocala, tomá un snapshot, hacé clic en el área de texto y escribí `Aprobado <fecha y hora>` una sola vez. Verificá con `desktop_read` que aparece una sola vez. Devolvé `status: ok` con un `item result`.
2. Si NO hay aprobación: no escribas ni toques ninguna ventana. Devolvé `status: needs-approval` con `approval: {"title":"Escribir aprobado en Notepad","preview":"Escribir una línea de prueba en flufy-desktop-test.txt","risk":"bajo","step":"write"}`.

## Salida
Un único bloque JSON con `status`, `summary` e `items` (y `approval` cuando corresponda).
"#;

const PREFLIGHT: &str = r#"---
name: preflight
title: Preflight de navegador
sites: [google]
readOnly: true
commitActions: []
needs: [browser]
version: 1
---
## Objetivo
Comprobar que una misión puede usar Chrome: ventana asignada, permiso de DevTools y sesión utilizable.

## Pasos
1. `browser_list_pages`. Si no hay páginas asignadas, `status: blocked` con `detail: Falta asignar una ventana de Chrome para misiones`.
2. Abrí una pestaña nueva a `https://www.google.com/` con `browser_navigate_page` sin `pageId`.
3. Si carga el buscador, `status: ok`. Si aparece un login o un captcha, `status: needs-hands`.
4. No leas datos personales ni escribas.

## Salida
Un JSON con `status`, `summary` e `items`; un item result por cada comprobación.
"#;

pub fn ensure_defaults(app: &AppHandle) {
    let dir = dir(app);
    let _ = std::fs::create_dir_all(&dir);
    for (name, body) in [("briefing", BRIEFING), ("research-doc", RESEARCH_DOC), ("preflight", PREFLIGHT), ("desktop-demo", DESKTOP_DEMO), ("approval-demo", APPROVAL_DEMO), ("project-check", PROJECT_CHECK), ("project-write", PROJECT_WRITE), ("handoff-demo", HANDOFF_DEMO)] {
        let path = dir.join(format!("{}.md", name));
        if !path.exists() {
            let _ = memory::atomic_write(&path, body);
        }
    }
}

#[tauri::command]
pub fn agent_playbooks_list(app: AppHandle) -> Vec<String> {
    list(&app)
}

#[tauri::command]
pub fn agent_playbook_read(app: AppHandle, name: String) -> Result<String, String> {
    read(&app, &name)
}

#[tauri::command]
pub fn agent_playbook_save(app: AppHandle, name: String, body: String) -> Result<(), String> {
    save(&app, &name, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_is_safe_and_short() {
        assert_eq!(slug("Briefing diario / Gmail"), "briefing-diario-gmail");
        assert_eq!(slug("  "), "");
        assert!(slug(&"a".repeat(120)).len() <= 48);
    }

    #[test]
    fn validation_requires_frontmatter() {
        assert!(validate("briefing", "texto sin frontmatter").is_err());
        assert!(validate("briefing", "---\nname: briefing\n---\n\nPasos").is_ok());
        assert!(validate("", "---\nname: x\n---").is_err());
    }
}
