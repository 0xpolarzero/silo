//! Platform-neutral launch policy, unit-tested on every host: how a Linux
//! desktop entry maps to the command Silo can run, and the environment child
//! processes receive when Silo runs as an AppImage. `linux.rs` supplies GIO.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Command,
};

/// An editor command that accepts a sandbox folder.
#[derive(Debug, PartialEq)]
pub(crate) struct EditorCommand {
    pub program: PathBuf,
    /// Arguments before Silo's own (for example `run <app id>` for Flatpak).
    pub args: Vec<OsString>,
    /// Zed takes an `ssh://` URI; Visual Studio Code takes a workspace file.
    pub zed: bool,
}

const UNSUPPORTED_EDITOR: &str =
    "Remote folders currently support Zed and Visual Studio Code. Choose one in Settings.";

/// A desktop entry's `Exec` tokens without field codes (`%U`) or Flatpak's
/// file-forwarding markers (`@@`, `@@u`).
pub(crate) fn exec_argv(tokens: impl IntoIterator<Item = String>) -> Vec<String> {
    tokens
        .into_iter()
        .filter(|token| {
            !(token.len() == 2 && token.starts_with('%')) && !matches!(token.as_str(), "@@" | "@@u")
        })
        .collect()
}

/// The program an `Exec` line runs, skipping `env [-i] [NAME=value]...` as
/// snap entries use.
pub(crate) fn exec_program(argv: &[String]) -> Option<&str> {
    let mut tokens = argv.iter().map(String::as_str);
    let first = tokens.next()?;
    if Path::new(first).file_name() != Some(OsStr::new("env")) {
        return Some(first);
    }
    tokens.find(|token| !token.starts_with('-') && !token.contains('='))
}

fn file_name(path: &Path) -> &str {
    path.file_name().and_then(OsStr::to_str).unwrap_or("")
}

fn executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

/// Resolves a Linux editor entry to its command-line launcher (G-06, G-25).
///
/// The Microsoft package's entry runs the Electron app (`/usr/share/code/code`),
/// which never exits; its CLI is `bin/code` beside it. Zed's tarball entry runs
/// `libexec/zed-editor`, whose CLI is `bin/zed`. Flatpak entries run
/// `flatpak run <app id>`, and snap entries prefix `env NAME=value`.
pub(crate) fn linux_editor_command(
    argv: &[String],
    flatpak_app: Option<&str>,
    find_program: &dyn Fn(&str) -> Option<PathBuf>,
) -> Result<EditorCommand, String> {
    if let Some(app) = flatpak_app {
        let zed = match app {
            "com.visualstudio.code" => false,
            "dev.zed.Zed" => true,
            _ => return Err(UNSUPPORTED_EDITOR.into()),
        };
        let program = find_program("flatpak").ok_or("The selected editor is unavailable.")?;
        return Ok(EditorCommand {
            program,
            args: vec!["run".into(), app.into()],
            zed,
        });
    }
    let token = exec_program(argv).ok_or("The selected editor is unavailable.")?;
    let program = if Path::new(token).is_absolute() {
        PathBuf::from(token)
    } else {
        find_program(token).ok_or("The selected editor is unavailable.")?
    };
    let directory = program.parent().unwrap_or(Path::new("/"));
    let (program, zed) = match file_name(&program) {
        name @ ("code" | "code-insiders") => {
            let cli = directory.join("bin").join(name);
            (if executable_file(&cli) { cli } else { program }, false)
        }
        "zed" | "zeditor" => (program, true),
        "zed-editor" => {
            let cli = directory.join("../bin/zed");
            (if executable_file(&cli) { cli } else { program }, true)
        }
        _ => return Err(UNSUPPORTED_EDITOR.into()),
    };
    Ok(EditorCommand {
        program,
        args: Vec::new(),
        zed,
    })
}

/// Commands that run the user's preferred terminal (G-07). The freedesktop
/// `xdg-terminal-exec` comes first, then Debian's `x-terminal-emulator`.
pub(crate) const TERMINAL_LAUNCHERS: [&str; 2] = ["xdg-terminal-exec", "x-terminal-emulator"];

/// The terminal default: a system launcher when one exists, otherwise the
/// first listed terminal Silo can drive.
pub(crate) fn linux_terminal_default(
    find_program: &dyn Fn(&str) -> Option<PathBuf>,
    supported_in_order: &[String],
) -> Option<String> {
    TERMINAL_LAUNCHERS
        .iter()
        .find_map(|launcher| find_program(launcher))
        .and_then(|path| path.to_str().map(str::to_owned))
        .or_else(|| supported_in_order.first().cloned())
}

/// The AppImage's mount point, when this process runs from one.
fn appimage_root() -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var_os("APPDIR")?);
    std::env::var_os("APPIMAGE")?;
    let executable = std::env::current_exe().ok()?;
    (root.is_absolute() && executable.starts_with(&root)).then_some(root)
}

fn inside(entry: &str, root: &str) -> bool {
    entry == root
        || entry
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Environment changes that undo the AppImage's AppRun hooks for a child
/// (G-24): every variable naming the mount point loses those entries (and is
/// removed when nothing remains), so children such as gnome-terminal use the
/// system's GSettings schemas, GTK modules, GStreamer plugins and libraries.
pub(crate) fn appimage_child_environment(
    variables: impl IntoIterator<Item = (OsString, OsString)>,
    root: &Path,
) -> Vec<(OsString, Option<OsString>)> {
    let Some(root) = root.to_str().map(|root| root.trim_end_matches('/')) else {
        return Vec::new();
    };
    if root.is_empty() {
        return Vec::new();
    }
    let mut changes = Vec::new();
    for (name, value) in variables {
        if matches!(name.to_str(), Some("APPDIR" | "APPIMAGE" | "ARGV0" | "OWD")) {
            changes.push((name, None));
            continue;
        }
        let Some(text) = value.to_str() else { continue };
        if !text.contains(root) {
            continue;
        }
        let entries: Vec<_> = text.split(':').collect();
        let kept: Vec<_> = entries
            .iter()
            .copied()
            .filter(|entry| !inside(&entry.replace("//", "/"), root))
            .collect();
        if kept.len() == entries.len() {
            continue;
        }
        let kept: Vec<_> = kept.into_iter().filter(|entry| !entry.is_empty()).collect();
        changes.push((name, (!kept.is_empty()).then(|| kept.join(":").into())));
    }
    changes
}

/// The changes for this process's children; empty outside an AppImage.
pub(crate) fn child_environment() -> Vec<(OsString, Option<OsString>)> {
    appimage_root()
        .map(|root| appimage_child_environment(std::env::vars_os(), &root))
        .unwrap_or_default()
}

/// Gives a child the system environment instead of the AppImage's (G-24).
pub(crate) fn sanitize_child(command: &mut Command) -> &mut Command {
    for (name, value) in child_environment() {
        match value {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
    command
}

/// A path to Silo that outlives this process: the AppImage file rather than
/// its temporary mount (G-12). Elsewhere, the running executable.
pub(crate) fn stable_executable() -> Result<PathBuf, String> {
    if appimage_root().is_some() {
        if let Some(image) = std::env::var_os("APPIMAGE").map(PathBuf::from) {
            if image.is_absolute() && executable_file(&image) {
                return Ok(image);
            }
        }
    }
    std::env::current_exe().map_err(|_| "Silo could not locate its executable.".into())
}

/// Whether persisted commands must go through `stable_executable` because
/// bundled tool paths are temporary (AppImage mounts).
pub(crate) fn tools_are_temporary() -> bool {
    appimage_root().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn tokens(line: &str) -> Vec<String> {
        exec_argv(line.split_whitespace().map(str::to_owned))
    }
    fn executable(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    fn nowhere(_: &str) -> Option<PathBuf> {
        None
    }

    #[test]
    fn exec_lines_drop_field_codes_and_skip_env_prefixes() {
        assert_eq!(tokens("/usr/share/code/code %F"), ["/usr/share/code/code"]);
        let snap = tokens("env BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/code.desktop /snap/bin/code --force-user-env %F");
        assert_eq!(exec_program(&snap), Some("/snap/bin/code"));
        assert_eq!(
            exec_program(&tokens("/usr/bin/env -i A=b zed %U")),
            Some("zed")
        );
        let flatpak = tokens(
            "/usr/bin/flatpak run --branch=stable --command=code com.visualstudio.code @@ %F @@",
        );
        assert!(!flatpak.iter().any(|token| token == "@@" || token == "%F"));
    }

    #[test]
    fn the_microsoft_package_entry_resolves_to_the_code_cli() {
        let root = tempfile::tempdir().unwrap();
        let electron = root.path().join("usr/share/code/code");
        executable(&electron);
        let cli = root.path().join("usr/share/code/bin/code");
        executable(&cli);
        let argv = vec![electron.to_str().unwrap().to_owned()];
        let command = linux_editor_command(&argv, None, &nowhere).unwrap();
        assert_eq!(
            command,
            EditorCommand {
                program: cli,
                args: Vec::new(),
                zed: false
            }
        );
        // A CLI on PATH (the package's /usr/bin/code link) is used as is.
        let path_cli = root.path().join("bin/code");
        executable(&path_cli);
        let found = path_cli.clone();
        let command =
            linux_editor_command(&["code".into()], None, &move |_: &str| Some(found.clone()))
                .unwrap();
        assert_eq!(command.program, path_cli);
    }

    #[test]
    fn snap_flatpak_and_zed_tarball_entries_are_launchable() {
        let snap = tokens("env BAMF_DESKTOP_FILE_HINT=x /snap/bin/code --force-user-env %F");
        let command = linux_editor_command(&snap, None, &nowhere).unwrap();
        assert_eq!(
            (command.program, command.zed),
            (PathBuf::from("/snap/bin/code"), false)
        );

        let flatpak = |_: &str| Some(PathBuf::from("/usr/bin/flatpak"));
        let command = linux_editor_command(
            &tokens("/usr/bin/flatpak run dev.zed.Zed %U"),
            Some("dev.zed.Zed"),
            &flatpak,
        )
        .unwrap();
        assert_eq!(
            command,
            EditorCommand {
                program: "/usr/bin/flatpak".into(),
                args: vec!["run".into(), "dev.zed.Zed".into()],
                zed: true
            }
        );
        let command = linux_editor_command(&[], Some("com.visualstudio.code"), &flatpak).unwrap();
        assert_eq!(
            command.args,
            [
                OsString::from("run"),
                OsString::from("com.visualstudio.code")
            ]
        );
        assert!(!command.zed);
        assert!(linux_editor_command(&[], Some("org.gnome.TextEditor"), &flatpak).is_err());

        let root = tempfile::tempdir().unwrap();
        let editor = root.path().join("zed.app/libexec/zed-editor");
        executable(&editor);
        executable(&root.path().join("zed.app/bin/zed"));
        let command =
            linux_editor_command(&[editor.to_str().unwrap().into()], None, &nowhere).unwrap();
        assert!(command.zed);
        assert!(command.program.ends_with("zed.app/libexec/../bin/zed"));
    }

    #[test]
    fn text_editors_that_cannot_open_sandboxes_are_refused() {
        for line in [
            "gnome-text-editor %U",
            "/usr/bin/gedit %U",
            "codium %F",
            "/usr/bin/env A=b kate",
        ] {
            let found = |name: &str| Some(PathBuf::from("/usr/bin").join(name));
            assert!(
                linux_editor_command(&tokens(line), None, &found).is_err(),
                "{line}"
            );
        }
    }

    #[test]
    fn the_terminal_default_prefers_system_launchers() {
        let listed = ["/usr/share/applications/org.gnome.Ptyxis.desktop".to_string()];
        let both = |name: &str| Some(PathBuf::from("/usr/bin").join(name));
        assert_eq!(
            linux_terminal_default(&both, &listed).as_deref(),
            Some("/usr/bin/xdg-terminal-exec")
        );
        let debian = |name: &str| {
            (name == "x-terminal-emulator").then(|| PathBuf::from("/usr/bin/x-terminal-emulator"))
        };
        assert_eq!(
            linux_terminal_default(&debian, &listed).as_deref(),
            Some("/usr/bin/x-terminal-emulator")
        );
        assert_eq!(
            linux_terminal_default(&nowhere, &listed).as_deref(),
            Some(listed[0].as_str())
        );
        assert_eq!(linux_terminal_default(&nowhere, &[]), None);
    }

    #[test]
    fn appimage_hooks_are_undone_for_children() {
        let root = Path::new("/tmp/.mount_SiloAbC");
        let environment = [
            ("APPDIR", "/tmp/.mount_SiloAbC"),
            ("APPIMAGE", "/home/me/Silo.AppImage"),
            (
                "GSETTINGS_SCHEMA_DIR",
                "/tmp/.mount_SiloAbC//usr/share/glib-2.0/schemas",
            ),
            ("GTK_PATH", "/tmp/.mount_SiloAbC//usr/lib/gtk-3.0"),
            (
                "GDK_PIXBUF_MODULE_FILE",
                "/tmp/.mount_SiloAbC//usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache",
            ),
            (
                "GST_PLUGIN_SYSTEM_PATH_1_0",
                "/tmp/.mount_SiloAbC/usr/lib/gstreamer-1.0",
            ),
            (
                "XDG_DATA_DIRS",
                "/tmp/.mount_SiloAbC/usr/share:/usr/share:/usr/local/share",
            ),
            ("PATH", "/tmp/.mount_SiloAbC/usr/bin:/usr/bin:/bin"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_SiloAbC/usr/lib"),
            ("HOME", "/home/me"),
            ("OTHER_MOUNT", "/tmp/.mount_SiloAbCdef/usr/lib"),
        ]
        .map(|(name, value)| (OsString::from(name), OsString::from(value)));
        let changes: std::collections::HashMap<_, _> =
            appimage_child_environment(environment, root)
                .into_iter()
                .map(|(name, value)| {
                    (
                        name.into_string().unwrap(),
                        value.map(|value| value.into_string().unwrap()),
                    )
                })
                .collect();
        for removed in [
            "APPDIR",
            "APPIMAGE",
            "GSETTINGS_SCHEMA_DIR",
            "GTK_PATH",
            "GDK_PIXBUF_MODULE_FILE",
            "GST_PLUGIN_SYSTEM_PATH_1_0",
            "LD_LIBRARY_PATH",
        ] {
            assert_eq!(changes.get(removed), Some(&None), "{removed}");
        }
        assert_eq!(
            changes["XDG_DATA_DIRS"].as_deref(),
            Some("/usr/share:/usr/local/share")
        );
        assert_eq!(changes["PATH"].as_deref(), Some("/usr/bin:/bin"));
        assert!(!changes.contains_key("HOME"));
        assert!(
            !changes.contains_key("OTHER_MOUNT"),
            "a different mount is not this AppImage"
        );
    }

    #[test]
    fn children_outside_an_appimage_keep_their_environment() {
        // The test runner is not an AppImage.
        assert!(child_environment().is_empty());
        let mut command = Command::new("/usr/bin/true");
        sanitize_child(&mut command);
        assert_eq!(command.get_envs().count(), 0);
        assert!(!tools_are_temporary());
        assert_eq!(
            stable_executable().unwrap(),
            std::env::current_exe().unwrap()
        );
    }
}
