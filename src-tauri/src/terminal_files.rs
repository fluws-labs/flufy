//! Local, editor-only terminal references. Never passed to a shell or an opener.

use crate::fs::FileContent;
use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
pub struct TerminalReference {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<FileContent>,
}

#[tauri::command]
pub async fn terminal_file_reference(
    app: tauri::AppHandle, window: tauri::Window, id: String, file: String,
    workspace: String, read: bool,
) -> Result<TerminalReference, String> {
    // Neither the initial cwd nor the allowed roots come from the printed text.
    let cwd = {
        let state = app.state::<crate::term::TermState>();
        state.reference_cwd(&id, window.label())?
    };
    let project = crate::windows::project_of(&app, window.label());
    crate::proc::blocking(move || {
        if project.is_empty() { return Err("no hay un proyecto abierto".into()); }
        let roots = crate::features::navigation_roots(&project, &workspace)?;
        read_reference(&roots, &cwd, &file, read)
    }).await
}

#[cfg(windows)]
fn read_reference(roots: &[String], cwd: &str, file: &str, read: bool) -> Result<TerminalReference, String> {
    safe_windows::read_reference(roots, cwd, file, read)
}

#[cfg(not(windows))]
fn read_reference(_: &[String], _: &str, _: &str, _: bool) -> Result<TerminalReference, String> {
    Err("la apertura segura de referencias de terminal requiere Windows".into())
}

#[cfg(windows)]
mod safe_windows {
    use super::*;
    use std::fs::{File, OpenOptions};
    use std::io::Read;
    use std::os::windows::{fs::{MetadataExt, OpenOptionsExt}, io::AsRawHandle};
    use std::path::PathBuf;
    use std::time::UNIX_EPOCH;
    use windows::{core::PCWSTR, Win32::{Foundation::HANDLE, Storage::FileSystem::{
        GetDriveTypeW, GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
    }}};

    const MAX_SIZE: u64 = 10 * 1024 * 1024;

    // Only ordinary, fully-qualified local disk paths. No Win32 namespace, ADS,
    // drive-relative/root-relative paths, reserved DOS devices or ambiguous names.
    fn local_path(input: &str, base: Option<&str>) -> Result<String, String> {
        let p = input.replace('\\', "/");
        if p.is_empty() || p.len() > 32768 || p.chars().any(|c| c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')) {
            return Err("ruta inválida".into());
        }
        let absolute = p.as_bytes().get(1) == Some(&b':') && p.as_bytes().get(2) == Some(&b'/') && p.as_bytes()[0].is_ascii_alphabetic();
        let full = if absolute { p } else {
            if p.starts_with('/') || p.contains(':') { return Err("no se permiten rutas de red, protocolos ni rutas especiales".into()); }
            format!("{}/{}", base.ok_or("se requiere una ruta local absoluta")?.replace('\\', "/"), p)
        };
        if full[2..].contains(':') { return Err("no se permiten protocolos ni flujos alternativos".into()); }
        let mut parts = Vec::new();
        for part in full[3..].split('/') {
            if part.is_empty() || part == "." { continue; }
            if part == ".." {
                if parts.pop().is_none() { return Err("la ruta sale de la unidad".into()); }
                continue;
            }
            let stem = part.split('.').next().unwrap_or("").trim_end_matches(' ').to_uppercase();
            if part.ends_with([' ', '.']) || part.chars().any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*')) ||
                matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$") ||
                ((stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(&stem[3..], "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")) {
                return Err("nombre de archivo especial o ambiguo".into());
            }
            parts.push(part);
        }
        Ok(format!("{}:/{}", full[..1].to_uppercase(), parts.join("/")))
    }

    fn inside(path: &str, root: &str) -> bool {
        path.eq_ignore_ascii_case(root) || path.get(..root.len()).is_some_and(|prefix| prefix.eq_ignore_ascii_case(root)) &&
            (root.ends_with('/') || path.as_bytes().get(root.len()) == Some(&b'/'))
    }

    fn fixed_drive(path: &str) -> Result<(), String> {
        let drive: Vec<u16> = format!("{}\\", &path[..2]).encode_utf16().chain(Some(0)).collect();
        // Reject mapped network drives as well as UNC names, before filesystem lookup.
        if unsafe { GetDriveTypeW(PCWSTR(drive.as_ptr())) } != 3 {
            return Err("solo se permiten archivos de unidades locales fijas".into());
        }
        Ok(())
    }

    fn link_target(link: &str, parent: &str) -> Result<String, String> {
        if let Some(disk) = link.strip_prefix(r"\\?\") {
            // Verbatim disk paths returned by read_link are trusted syntax, not
            // authorization. UNC/volume namespaces must not become relative names.
            local_path(disk, None)
        } else {
            local_path(link, Some(parent))
        }
    }

    #[test]
    fn reparse_targets_never_reinterpret_network_namespaces_as_relative_files() {
        assert_eq!(link_target(r"\\?\C:\project\src", "C:/project").unwrap(), "C:/project/src");
        assert_eq!(link_target("src", "C:/project").unwrap(), "C:/project/src");
        for target in [r"\\?\UNC\server\share", r"\\server\share", r"\\?\Volume{123}\src", r"\Device\Mup\server\share"] {
            assert!(link_target(target, "C:/project").is_err(), "accepted {target}");
        }
    }

    fn final_path(file: &File) -> Result<String, String> {
        let mut buf = vec![0u16; 32768];
        let len = unsafe { GetFinalPathNameByHandleW(HANDLE(file.as_raw_handle()), &mut buf, FILE_NAME_NORMALIZED) } as usize;
        if len == 0 || len >= buf.len() { return Err("no se pudo verificar la ubicación real".into()); }
        let raw = String::from_utf16(&buf[..len]).map_err(|_| "ruta Unicode inválida")?;
        let disk = raw.strip_prefix(r"\\?\").ok_or("destino no local")?;
        local_path(disk, None)
    }

    fn walk(path: &str, roots: &[String], data: bool, guards: &mut Vec<File>, depth: usize) -> Result<File, String> {
        if depth > 32 || !roots.iter().any(|r| inside(path, r)) { return Err("el destino está fuera del espacio de trabajo permitido".into()); }
        fixed_drive(path)?;
        let parts: Vec<_> = path[3..].split('/').filter(|p| !p.is_empty()).collect();
        let mut current = PathBuf::from(&path[..3]);
        for i in 0..=parts.len() {
            if i > 0 { current.push(parts[i - 1]); }
            let last = i == parts.len();
            // Pin every ancestor while inspecting links and reading. Denying write/delete
            // sharing prevents replacing an already-checked component with a junction.
            let handle = OpenOptions::new()
                .access_mode(if last && data { 0x80000000 } else { FILE_READ_ATTRIBUTES.0 })
                .share_mode(FILE_SHARE_READ.0)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0 | FILE_FLAG_BACKUP_SEMANTICS.0)
                .open(&current).map_err(|e| format!("no se pudo abrir la referencia de forma segura: {e}"))?;
            let meta = handle.metadata().map_err(|e| e.to_string())?;
            if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
                guards.push(handle);
                // read_link inspects the reparse point, without accessing its target.
                // Unknown reparse types fail closed. Validate targets before following.
                let link = std::fs::read_link(&current).map_err(|_| "tipo de enlace no permitido")?;
                let link = link.to_str().ok_or("ruta Unicode inválida")?;
                let parent = current.parent().and_then(|p| p.to_str()).ok_or("enlace inválido")?;
                let mut target = link_target(link, parent)?;
                for tail in &parts[i..] { target.push('/'); target.push_str(tail); }
                let target = local_path(&target, None)?;
                return walk(&target, roots, data, guards, depth + 1);
            }
            if last { return Ok(handle); }
            if !meta.is_dir() { return Err("la ruta contiene un componente que no es una carpeta".into()); }
            guards.push(handle);
        }
        Err("ruta inválida".into())
    }

    pub(super) fn read_reference(roots: &[String], cwd: &str, input: &str, read: bool) -> Result<TerminalReference, String> {
        let roots = roots.iter().map(|r| local_path(r, None)).collect::<Result<Vec<_>, _>>()?;
        let cwd = local_path(cwd, None)?;
        let path = local_path(input, Some(&cwd))?;
        let mut guards = Vec::new();
        let mut actual_roots = Vec::new();
        for root in &roots {
            let handle = walk(root, &roots, false, &mut guards, 0)?;
            if !handle.metadata().map_err(|e| e.to_string())?.is_dir() { return Err("raíz de proyecto inválida".into()); }
            actual_roots.push(final_path(&handle)?);
            guards.push(handle);
        }
        let mut handle = walk(&path, &roots, read, &mut guards, 0)?;
        let actual = final_path(&handle)?;
        // Final normalized names come from open handles, not string canonicalization.
        // Exact component checks also fail closed for case-sensitive Windows folders.
        if !actual_roots.iter().any(|r| actual == *r || actual.strip_prefix(r).is_some_and(|rest| rest.starts_with('/') || r.ends_with('/'))) {
            return Err("el destino real está fuera del espacio de trabajo permitido".into());
        }
        let meta = handle.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() { return Err("la referencia no es un archivo regular".into()); }
        if meta.len() > MAX_SIZE { return Err("archivo demasiado grande para abrir (máximo 10 MB)".into()); }
        let file = if read {
            let mut bytes = Vec::new();
            (&mut handle).take(MAX_SIZE + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            if bytes.len() as u64 > MAX_SIZE { return Err("archivo demasiado grande".into()); }
            let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
            let body = if bom { &bytes[3..] } else { &bytes[..] };
            if body.contains(&0) { return Err("la referencia apunta a un archivo binario".into()); }
            let content = std::str::from_utf8(body).map_err(|_| "el archivo no es texto UTF-8 compatible")?.to_owned();
            Some(FileContent { content, bom, size: meta.len(), mtime: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0) })
        } else { None };
        Ok(TerminalReference { path: actual, file })
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join("opencode").join(format!("terminal-links-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(base.join("project/src")).unwrap();
            std::fs::create_dir_all(base.join("project-sibling")).unwrap();
            std::fs::write(base.join("project/src/file.ts"), "first\nsecond\n").unwrap();
            std::fs::write(base.join("project-sibling/secret.txt"), "outside").unwrap();
            Self(base)
        }
        fn root(&self) -> String { self.0.join("project").to_string_lossy().into_owned() }
        fn read(&self, file: &str, read: bool) -> Result<TerminalReference, String> {
            read_reference(&[self.root()], &self.root(), file, read)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn opens_only_text_and_can_resolve_without_reading_content() {
        let f = Fixture::new();
        let resolved = f.read("src/file.ts", false).unwrap();
        assert!(resolved.file.is_none());
        assert_eq!(f.read(&resolved.path, true).unwrap().file.unwrap().content, "first\nsecond\n");
        assert_eq!(f.read("src/../src/file.ts", true).unwrap().path, resolved.path);
        std::fs::write(f.0.join("project/script.cmd"), "echo do not execute").unwrap();
        assert_eq!(f.read("script.cmd", true).unwrap().file.unwrap().content, "echo do not execute");
    }

    #[test]
    fn rejects_escape_sibling_prefix_and_missing_files() {
        let f = Fixture::new();
        for path in ["../project-sibling/secret.txt".to_string(), f.0.join("project-sibling/secret.txt").to_string_lossy().into_owned(), "missing.ts".into(), "src".into()] {
            assert!(f.read(&path, true).is_err(), "accepted {path}");
        }
    }

    #[test]
    fn relative_paths_use_only_the_initial_cwd_and_absolute_paths_can_target_another_allowed_repo() {
        let f = Fixture::new();
        let roots = vec![f.root(), f.0.join("project-sibling").to_string_lossy().into_owned()];
        let cwd = f.0.join("project/src").to_string_lossy().into_owned();
        assert_eq!(read_reference(&roots, &cwd, "file.ts", true).unwrap().file.unwrap().content, "first\nsecond\n");
        assert!(f.read("file.ts", true).is_err()); // no recursive guessing under src/
        assert_eq!(read_reference(&roots, &cwd, &format!("{}/secret.txt", roots[1]), true).unwrap().file.unwrap().content, "outside");
    }

    #[test]
    fn rejects_network_protocol_device_ads_and_ambiguous_windows_names() {
        let f = Fixture::new();
        for path in [r"\\server\share\file.ts", "//server/share/file.ts", r"\\?\C:\file.ts", r"\\.\NUL", "file:///C:/file.ts", "https://host/file.ts", "C:file.ts", r"\src\file.ts", "src/file.ts:stream", "NUL.txt", "CON", "src/file.ts.", "src/file.ts ", "src/evil\u{202e}.ts"] {
            assert!(f.read(path, true).is_err(), "accepted {path}");
        }
    }

    #[test]
    fn rejects_binary_invalid_utf8_and_oversized_files() {
        let f = Fixture::new();
        for bytes in [&b"MZ\0binary"[..], &b"\xff\xfeinvalid"[..]] {
            std::fs::write(f.0.join("project/binary.exe"), bytes).unwrap();
            assert!(f.read("binary.exe", true).is_err());
        }
        let file = std::fs::File::create(f.0.join("project/huge.txt")).unwrap();
        file.set_len(10 * 1024 * 1024 + 1).unwrap();
        drop(file);
        assert!(f.read("huge.txt", true).is_err());
    }

    #[test]
    fn resolves_internal_junctions_but_rejects_escape_before_following() {
        let f = Fixture::new();
        for (alias, target) in [("internal", f.0.join("project/src")), ("escape", f.0.join("project-sibling"))] {
            let output = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"])
                .arg(f.0.join("project").join(alias)).arg(target.to_string_lossy().replace('/', "\\")).output().unwrap();
            assert!(output.status.success(), "could not create junction fixture: {} {}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        }
        assert!(f.read("escape/secret.txt", true).is_err());
        assert_eq!(f.read("internal/file.ts", true).unwrap().file.unwrap().content, "first\nsecond\n");
    }
}
