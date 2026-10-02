//! One Silo instance runs per channel. The single-instance plugin keys its
//! claim by bundle identifier before setup can touch channel state. A second
//! launch focuses the running copy and explains if its executable differs.
use std::{
    ffi::OsString,
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// Register this before every other plugin: the plugin exits a second instance
/// while plugins initialize, and plugins initialize in registration order.
pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_single_instance::init(|app, argv, cwd| {
        let app = app.clone();
        // Comparing executables reads files; keep the plugin's listener responsive.
        std::thread::spawn(move || second_launch(&app, argv, cwd));
    })
}

/// Give up the single-instance claim before replacing this process image, so the
/// replacement does not find the old claim and exit (Debian update restart).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn release(app: &AppHandle) {
    tauri_plugin_single_instance::destroy(app);
}

fn second_launch(app: &AppHandle, argv: Vec<String>, cwd: String) {
    let other = argv
        .first()
        .and_then(|program| resolve_program(program, Path::new(&cwd), std::env::var_os("PATH")));
    crate::status_panel::report(crate::status_panel::open_main(app.clone(), None));
    let Some(other) = other else { return };
    if same_build(&own_executable(), &other) {
        return;
    }
    let name = crate::channel::current().product_name();
    let mut dialog = app
        .dialog()
        .message(format!(
            "{name} is already running. Quit it first.\n\nThe other copy of {name} was not opened: {}",
            other.display()
        ))
        .title(name)
        .kind(MessageDialogKind::Warning);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    dialog.show(|_| {});
}

fn own_executable() -> PathBuf {
    // Still readable after a package update replaced or removed the file on disk.
    #[cfg(target_os = "linux")]
    return PathBuf::from("/proc/self/exe");
    #[cfg(not(target_os = "linux"))]
    return std::env::current_exe().unwrap_or_default();
}

/// Resolve the other launch's `argv[0]` the way its shell or launcher did.
fn resolve_program(program: &str, cwd: &Path, path: Option<OsString>) -> Option<PathBuf> {
    if program.is_empty() {
        return None;
    }
    let program = Path::new(program);
    if program.is_absolute() {
        return Some(program.to_path_buf());
    }
    if program.components().count() > 1 {
        return cwd.is_absolute().then(|| cwd.join(program));
    }
    std::env::split_paths(&path?)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(program))
        .find(|candidate| {
            use std::os::unix::fs::PermissionsExt;
            candidate.metadata().is_ok_and(|metadata| {
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            })
        })
}

/// Two launches are the same build when they run the same executable bytes. An
/// AppImage mounts at a new path on every launch, so paths alone cannot decide.
/// When either file cannot be read, assume the same build: focusing the running
/// Silo is always correct, the warning is only a hint.
fn same_build(own: &Path, other: &Path) -> bool {
    if let (Ok(own), Ok(other)) = (own.canonicalize(), other.canonicalize()) {
        if own == other {
            return true;
        }
    }
    identical_files(own, other).unwrap_or(true)
}

fn identical_files(first: &Path, second: &Path) -> io::Result<bool> {
    let (mut first, mut second) = (File::open(first)?, File::open(second)?);
    if first.metadata()?.len() != second.metadata()?.len() {
        return Ok(false);
    }
    let (mut left, mut right) = (vec![0; 64 * 1024], vec![0; 64 * 1024]);
    loop {
        let read = first.read(&mut left)?;
        if read == 0 {
            return Ok(second.read(&mut right[..1])? == 0);
        }
        second.read_exact(&mut right[..read])?;
        if left[..read] != right[..read] {
            return Ok(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_lookup_skips_non_executable_copies_like_the_launcher() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let decoy = root.path().join("decoy");
        let bin = root.path().join("bin");
        std::fs::create_dir(&decoy).unwrap();
        std::fs::create_dir(&bin).unwrap();
        std::fs::write(decoy.join("silo-ui"), b"not an executable build").unwrap();
        std::fs::set_permissions(
            decoy.join("silo-ui"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let selected = bin.join("silo-ui");
        std::fs::write(&selected, b"#!/bin/sh\nprintf selected").unwrap();
        std::fs::set_permissions(&selected, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = std::env::join_paths([&decoy, &bin]).unwrap();
        let launch = std::process::Command::new("silo-ui")
            .env("PATH", &path)
            .output()
            .unwrap();
        assert!(launch.status.success());
        assert_eq!(launch.stdout, b"selected");
        assert_eq!(
            resolve_program("silo-ui", root.path(), Some(path)),
            Some(selected)
        );
    }

    #[test]
    fn resolves_absolute_relative_and_path_launches() {
        let directory = tempfile::tempdir().unwrap();
        let bin = directory.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        std::fs::write(bin.join("silo-ui"), b"build").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(bin.join("silo-ui"), std::fs::Permissions::from_mode(0o700))
            .unwrap();
        let path = Some(OsString::from(format!("relative:{}", bin.display())));
        assert_eq!(
            resolve_program("/opt/Silo/silo-ui", directory.path(), None),
            Some(PathBuf::from("/opt/Silo/silo-ui"))
        );
        assert_eq!(
            resolve_program("./target/silo-ui", Path::new("/home/me/silo"), None),
            Some(PathBuf::from("/home/me/silo/./target/silo-ui"))
        );
        assert_eq!(resolve_program("target/silo-ui", Path::new(""), None), None);
        assert_eq!(
            resolve_program("silo-ui", directory.path(), path.clone()),
            Some(bin.join("silo-ui"))
        );
        assert_eq!(resolve_program("missing", directory.path(), path), None);
        assert_eq!(resolve_program("", directory.path(), None), None);
    }

    #[test]
    fn same_bytes_are_the_same_build_even_at_another_path() {
        let directory = tempfile::tempdir().unwrap();
        let installed = directory.path().join("installed");
        let mounted = directory.path().join("mount-1");
        let development = directory.path().join("development");
        let longer = directory.path().join("longer");
        std::fs::write(&installed, vec![7u8; 200_000]).unwrap();
        std::fs::write(&mounted, vec![7u8; 200_000]).unwrap();
        let mut changed = vec![7u8; 200_000];
        changed[150_000] = 8;
        std::fs::write(&development, changed).unwrap();
        std::fs::write(&longer, vec![7u8; 200_001]).unwrap();
        assert!(same_build(&installed, &installed));
        assert!(same_build(&installed, &mounted));
        assert!(!same_build(&installed, &development));
        assert!(!same_build(&installed, &longer));
        assert!(same_build(&installed, &directory.path().join("unreadable")));
    }

    #[test]
    fn single_instance_is_registered_before_any_other_plugin_or_setup_work() {
        let main = include_str!("main.rs");
        let builder = &main[main.find("tauri::Builder::default()").unwrap()..];
        let guard = builder.find(".plugin(single_instance::plugin())").unwrap();
        for later in [".plugin(tauri_plugin_", ".setup(", ".on_page_load("] {
            let position = builder.find(later).unwrap_or(usize::MAX);
            assert!(
                guard < position,
                "{later} must follow the single-instance plugin"
            );
        }
    }
}
