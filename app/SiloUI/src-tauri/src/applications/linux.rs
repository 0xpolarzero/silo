use std::fs::File;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use base64::Engine;
use gio::prelude::*;
use gio::{AppInfo, DesktopAppInfo};
use gtk::prelude::IconThemeExt;

use super::{Application, ApplicationCatalog};

pub fn discover() -> Result<ApplicationCatalog, String> {
    let mut catalog = ApplicationCatalog::default();
    // GIO owns XDG precedence, hidden overrides, and desktop-entry parsing.
    // https://docs.gtk.org/gio/type_func.AppInfo.get_all.html
    for candidate in AppInfo::all() {
        let Ok(candidate) = candidate.downcast::<DesktopAppInfo>() else {
            continue;
        };
        let Some(path) = candidate.filename() else {
            continue;
        };
        // Reopen the file so removed executables and changed metadata are rechecked.
        let Some(info) = desktop_at(&path) else {
            continue;
        };
        if !info.should_show() {
            continue;
        }
        let [terminal, editor, browser] = roles(info.categories().as_deref().unwrap_or(""));
        for (included, applications) in [
            (terminal, &mut catalog.terminal),
            (editor, &mut catalog.editor),
            (browser, &mut catalog.browser),
        ] {
            if included {
                applications.push(Application {
                    name: info.display_name().to_string(),
                    path: path
                        .to_str()
                        .expect("desktop_at validated UTF-8")
                        .to_owned(),
                    icon: None,
                });
            }
        }
    }

    if let Some(path) = ["https", "http"].into_iter().find_map(|scheme| {
        include_browser_default(
            AppInfo::default_for_uri_scheme(scheme),
            &mut catalog.browser,
        )
    }) {
        catalog.defaults.insert("browser".into(), path);
    }
    if let Some(path) = listed_default(
        AppInfo::default_for_type("text/plain", false),
        &catalog.editor,
    ) {
        catalog.defaults.insert("editor".into(), path);
    }
    // GAppInfo has no standard terminal-default association.
    for applications in [
        &mut catalog.terminal,
        &mut catalog.editor,
        &mut catalog.browser,
    ] {
        applications.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.path.cmp(&right.path))
        });
        applications.dedup_by(|left, right| left.path == right.path);
    }
    Ok(catalog)
}

pub fn application_at(path: &Path) -> Option<Application> {
    if !path.is_absolute() || !path.is_file() {
        return None;
    }
    let exact_path = path.to_str()?.to_owned();
    let name = if path
        .extension()
        .is_some_and(|extension| extension == "desktop")
    {
        // NoDisplay/OnlyShowIn affect discovery menus; an explicit choice can
        // still use that entry. Hidden entries remain unavailable.
        desktop_at(path)?.display_name().to_string()
    } else {
        if path.metadata().ok()?.permissions().mode() & 0o111 == 0
            || gio::glib::find_program_in_path(path).is_none()
        {
            return None;
        }
        path.file_name()?.to_str()?.to_owned()
    };
    Some(Application {
        name,
        path: exact_path,
        icon: None,
    })
}

/// Run after discovery on the GTK main thread.
pub fn load_icons(catalog: &mut ApplicationCatalog) {
    if !gtk::is_initialized_main_thread() {
        return;
    }
    for application in catalog
        .terminal
        .iter_mut()
        .chain(&mut catalog.editor)
        .chain(&mut catalog.browser)
    {
        load_icon(application);
    }
}

/// Run on the GTK main thread after the user chooses an application.
pub fn load_icon(application: &mut Application) {
    if !gtk::is_initialized_main_thread() {
        return;
    }
    application.icon = icon_at(Path::new(&application.path));
}

fn icon_at(path: &Path) -> Option<String> {
    if !path
        .extension()
        .is_some_and(|extension| extension == "desktop")
    {
        return None;
    }
    let icon = desktop_at(path)?.icon()?;
    // Use the current screen's icon theme, including its XDG search paths and
    // inheritance, for the application's actual GIcon (themed or file-based).
    // https://docs.gtk.org/gtk3/method.IconTheme.lookup_by_gicon.html
    let info =
        gtk::IconTheme::default()?.lookup_by_gicon(&icon, 32, gtk::IconLookupFlags::FORCE_SIZE)?;
    icon_data_url(&info.filename()?)
}

const MAX_ICON_BYTES: usize = 256 * 1024;

fn icon_data_url(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take((MAX_ICON_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > MAX_ICON_BYTES {
        return None;
    }
    // Decode with the installed image loaders and send only a small PNG to
    // the webview. This also renders SVG icons without embedding SVG markup.
    // https://docs.gtk.org/gdk-pixbuf/ctor.Pixbuf.new_from_stream_at_scale.html
    let stream = gio::MemoryInputStream::from_bytes(&gio::glib::Bytes::from_owned(bytes));
    let pixbuf = gtk::gdk_pixbuf::Pixbuf::from_stream_at_scale(
        &stream,
        32,
        32,
        true,
        None::<&gio::Cancellable>,
    )
    .ok()?;
    let png = pixbuf.save_to_bufferv("png", &[]).ok()?;
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    );
    (data_url.len() <= MAX_ICON_BYTES).then_some(data_url)
}

fn desktop_at(path: &Path) -> Option<DesktopAppInfo> {
    if !path.is_absolute() || !path.is_file() || path.to_str().is_none() {
        return None;
    }
    // The GIO constructor validates TryExec and parses/resolves Exec, including
    // quoted paths, PATH lookup, and the entry's working directory, without
    // launching anything. Keep that established parser authoritative.
    // https://docs.gtk.org/gio-unix/ctor.DesktopAppInfo.new_from_filename.html
    // https://github.com/GNOME/glib/blob/2.78.6/gio/gdesktopappinfo.c#L1752-L1831
    let info = DesktopAppInfo::from_filename(path)?;
    if info.is_hidden() || info.string("Name")?.trim().is_empty() {
        return None;
    }
    let has_exec = info
        .string("Exec")
        .is_some_and(|exec| !exec.trim().is_empty());
    let can_activate = info.boolean("DBusActivatable")
        && path
            .file_stem()
            .and_then(|name| name.to_str())
            .is_some_and(|name| gio::dbus_is_name(name) && !name.starts_with(':'));
    // Exec is optional only for a valid D-Bus-activatable desktop entry.
    // https://specifications.freedesktop.org/desktop-entry/latest/recognized-keys.html
    (has_exec || can_activate).then_some(info)
}

fn roles(categories: &str) -> [bool; 3] {
    let mut result = [false; 3];
    for category in categories.split(';') {
        match category {
            "TerminalEmulator" => result[0] = true,
            "IDE" | "TextEditor" => result[1] = true,
            "WebBrowser" => result[2] = true,
            _ => {}
        }
    }
    result
}

fn listed_default(info: Option<AppInfo>, applications: &[Application]) -> Option<String> {
    let path = info?.downcast::<DesktopAppInfo>().ok()?.filename()?;
    applications
        .iter()
        .find(|application| Path::new(&application.path) == path)
        .map(|application| application.path.clone())
}

fn include_browser_default(
    info: Option<AppInfo>,
    applications: &mut Vec<Application>,
) -> Option<String> {
    let path = info?.downcast::<DesktopAppInfo>().ok()?.filename()?;
    let info = desktop_at(&path)?;
    let path = path.to_str()?.to_owned();
    // The actual system default remains usable even without WebBrowser metadata.
    // Other unclassified scheme handlers stay out of the suggested applications.
    if !applications
        .iter()
        .any(|application| application.path == path)
    {
        applications.push(Application {
            name: info.display_name().to_string(),
            path: path.clone(),
            icon: None,
        });
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn icon_encoding_produces_a_small_png_and_rejects_invalid_images() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("icon.png");
        let image = gtk::gdk_pixbuf::Pixbuf::new(gtk::gdk_pixbuf::Colorspace::Rgb, true, 8, 64, 64)
            .unwrap();
        image.fill(0xff8844ff);
        fs::write(&path, image.save_to_bufferv("png", &[]).unwrap()).unwrap();
        let data_url = icon_data_url(&path).unwrap();
        assert!(data_url.len() <= MAX_ICON_BYTES);
        let png = base64::engine::general_purpose::STANDARD
            .decode(data_url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 32);
        assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), 32);
        fs::write(&path, b"not an image").unwrap();
        assert!(icon_data_url(&path).is_none());
        assert!(icon_data_url(directory.path()).is_none());
    }

    #[test]
    fn icon_encoding_rejects_valid_images_larger_than_the_input_limit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.png");
        let mut state = 1u32;
        let pixels: Vec<u8> = (0..384 * 384 * 4)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as u8
            })
            .collect();
        let image = gtk::gdk_pixbuf::Pixbuf::from_mut_slice(
            pixels,
            gtk::gdk_pixbuf::Colorspace::Rgb,
            true,
            8,
            384,
            384,
            384 * 4,
        );
        let png = image.save_to_bufferv("png", &[]).unwrap();
        assert!(png.len() > MAX_ICON_BYTES);
        fs::write(&path, png).unwrap();
        assert!(icon_data_url(&path).is_none());
    }

    #[test]
    fn icon_enrichment_outside_gtk_main_thread_leaves_assets_unchanged() {
        let application = Application {
            name: "Fixture editor".into(),
            path: "/fixture/editor.desktop".into(),
            icon: Some("data:image/png;base64,fixture".into()),
        };
        let mut catalog = ApplicationCatalog {
            editor: vec![application.clone()],
            ..Default::default()
        };
        load_icons(&mut catalog);
        assert_eq!(catalog.editor, [application]);
    }

    #[test]
    fn classifies_exact_categories() {
        assert_eq!(roles("System;TerminalEmulator;"), [true, false, false]);
        assert_eq!(roles("Development;IDE;"), [false, true, false]);
        assert_eq!(roles("TextEditor;WebBrowser;"), [false, true, true]);
        assert_eq!(roles(""), [false; 3]);
        assert_eq!(roles("Network;FileTransfer;"), [false; 3]);
        assert_eq!(roles("NotATextEditor;NotAWebBrowser;"), [false; 3]);
    }

    #[test]
    fn https_handlers_require_web_browser_category_but_remain_selectable() {
        let directory = tempfile::tempdir().unwrap();
        for (name, categories, expected_roles) in [
            ("terminal", "System;TerminalEmulator;", [true, false, false]),
            ("helper", "Network;FileTransfer;", [false; 3]),
            ("browser", "Network;WebBrowser;", [false, false, true]),
        ] {
            let path = directory.path().join(format!("{name}.desktop"));
            fs::write(
                &path,
                format!(
                    "[Desktop Entry]\nType=Application\nName={name}\nExec=/bin/true\nCategories={categories}\nMimeType=x-scheme-handler/https;\n"
                ),
            )
            .unwrap();
            let info = desktop_at(&path).unwrap();
            assert!(info
                .supported_types()
                .iter()
                .any(|mime| mime == "x-scheme-handler/https"));
            assert_eq!(
                roles(info.categories().as_deref().unwrap_or("")),
                expected_roles
            );
            assert!(application_at(&path).is_some());
        }
    }

    #[test]
    fn includes_the_valid_current_browser_default_without_a_browser_category() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("default.desktop");
        fs::write(
            &path,
            "[Desktop Entry]\nType=Application\nName=Current browser\nExec=/bin/true\nMimeType=x-scheme-handler/https;\n",
        )
        .unwrap();
        let info = desktop_at(&path).unwrap();
        assert_eq!(
            roles(info.categories().as_deref().unwrap_or("")),
            [false; 3]
        );
        let default = info.upcast::<AppInfo>();
        let mut applications = Vec::new();
        assert_eq!(
            include_browser_default(Some(default.clone()), &mut applications),
            Some(path.to_str().unwrap().to_owned())
        );
        assert_eq!(
            applications,
            [Application {
                name: "Current browser".into(),
                path: path.to_str().unwrap().to_owned(),
                icon: None,
            }]
        );
        include_browser_default(Some(default), &mut applications);
        assert_eq!(applications.len(), 1);
    }

    #[test]
    fn rechecks_hidden_and_removed_executables_before_including_the_browser_default() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("Browser");
        fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.path().join("default.desktop");
        let entry = format!(
            "[Desktop Entry]\nType=Application\nName=Current browser\nExec=\"{}\" %U\nMimeType=x-scheme-handler/https;\n",
            executable.display()
        );
        fs::write(&path, &entry).unwrap();
        let default = desktop_at(&path).unwrap().upcast::<AppInfo>();
        let mut applications = Vec::new();
        fs::write(&path, format!("{entry}Hidden=true\n")).unwrap();
        assert!(include_browser_default(Some(default.clone()), &mut applications).is_none());
        fs::write(&path, &entry).unwrap();
        fs::remove_file(executable).unwrap();
        assert!(include_browser_default(Some(default), &mut applications).is_none());
        assert!(applications.is_empty());
    }

    #[test]
    fn selected_executable_keeps_its_exact_path_and_requires_execute_permission() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("My editor.AppImage");
        fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(application_at(&executable).is_none());
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let selected = application_at(&executable).unwrap();
        assert_eq!(selected.name, "My editor.AppImage");
        assert_eq!(selected.path, executable.to_str().unwrap());
        let alias = directory.path().join("Editor alias");
        std::os::unix::fs::symlink(&executable, &alias).unwrap();
        assert_eq!(
            application_at(&alias).unwrap().path,
            alias.to_str().unwrap()
        );
        assert!(application_at(directory.path()).is_none());
        assert!(application_at(&directory.path().join("missing")).is_none());
    }

    #[test]
    fn gio_parses_quoted_exec_and_rejects_missing_tryexec_without_running_it() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("Test editor");
        let marker = directory.path().join("must-not-exist");
        fs::write(
            &executable,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.path().join("test.desktop");
        let entry = format!(
            "[Desktop Entry]\nType=Application\nName=Test editor\nExec=\"{}\" %F\nCategories=TextEditor;\n",
            executable.display()
        );
        fs::write(&path, &entry).unwrap();
        let selected = application_at(&path).unwrap();
        assert_eq!(selected.name, "Test editor");
        assert_eq!(selected.path, path.to_str().unwrap());
        assert!(!marker.exists());
        fs::write(
            &path,
            format!("{entry}TryExec=/silo-test-missing-executable\n"),
        )
        .unwrap();
        assert!(application_at(&path).is_none());
        fs::write(&path, &entry).unwrap();
        fs::remove_file(executable).unwrap();
        assert!(application_at(&path).is_none());
    }

    #[test]
    fn gio_applies_visibility_rules_while_hidden_entries_cannot_be_selected() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("test.desktop");
        let entry = "[Desktop Entry]\nType=Application\nName=Test\nExec=/bin/true\n";
        fs::write(&path, format!("{entry}NoDisplay=true\n")).unwrap();
        assert!(!desktop_at(&path).unwrap().should_show());
        assert!(application_at(&path).is_some());
        fs::write(&path, format!("{entry}OnlyShowIn=SiloTestDesktop;\n")).unwrap();
        let info = desktop_at(&path).unwrap();
        assert!(info.shows_in(Some("SiloTestDesktop")));
        assert!(!info.shows_in(Some("DifferentDesktop")));
        fs::write(&path, format!("{entry}Hidden=true\n")).unwrap();
        assert!(application_at(&path).is_none());
    }
}
