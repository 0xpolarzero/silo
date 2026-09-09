use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Application {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Default, Debug, Serialize)]
pub struct ApplicationCatalog {
    pub terminal: Vec<Application>,
    pub editor: Vec<Application>,
    pub browser: Vec<Application>,
    pub defaults: BTreeMap<String, String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApplicationKind {
    Terminal,
    Editor,
    Browser,
}

/// Open a web address with the current browser preference. Call from a worker.
pub(crate) fn open_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    let url = browser_url(url)?;
    let settings = crate::settings::current_settings(app)?;
    let selection = browser_selection(&settings)?;
    platform::open_browser(selection, &url)
}

fn browser_url(value: &str) -> Result<String, String> {
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return Err("The website address is invalid.".into());
    }
    let url = reqwest::Url::parse(value).map_err(|_| "The website address is invalid.")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only HTTP and HTTPS website addresses can be opened.".into());
    }
    Ok(url.into())
}

fn browser_selection(
    settings: &serde_json::Map<String, serde_json::Value>,
) -> Result<Option<&Path>, String> {
    if settings
        .get("browserUseSystemDefault")
        .and_then(|value| value.as_bool())
        .unwrap_or_else(|| {
            !settings.contains_key("browser") && !settings.contains_key("browserPath")
        })
    {
        return Ok(None);
    }
    let path = settings
        .get("browserPath")
        .and_then(|value| value.as_str())
        .filter(|path| Path::new(path).is_absolute())
        .ok_or("Choose an available browser in Settings.")?;
    Ok(Some(Path::new(path)))
}

pub(crate) fn selected_terminal(app: &AppHandle) -> Result<Application, String> {
    let settings = crate::settings::current_settings(app)?;
    let path = if settings.get("terminalUseSystemDefault").and_then(|v| v.as_bool()).unwrap_or(true) {
        platform::discover()?.defaults.remove("terminal")
    } else { settings.get("terminalPath").and_then(|v| v.as_str()).map(str::to_owned) }
    .ok_or("Choose an available terminal in Settings.")?;
    platform::application_at(Path::new(&path)).ok_or_else(|| "The selected terminal is unavailable. Choose another in Settings.".into())
}
pub(crate) fn open_terminal(app: &AppHandle, application: &Application, command: &str) -> Result<(), String> {
    platform::open_terminal(app, application, command)
}

pub(crate) fn selected_editor(app: &AppHandle) -> Result<Application, String> {
    let settings = crate::settings::current_settings(app)?;
    let path = if settings
        .get("editorUseSystemDefault")
        .and_then(|value| value.as_bool())
        .unwrap_or_else(|| !settings.contains_key("editor") && !settings.contains_key("editorPath"))
    {
        platform::discover()?.defaults.remove("editor")
    } else {
        settings
            .get("editorPath")
            .and_then(|value| value.as_str())
            .map(str::to_owned)
    }
    .ok_or("Choose an available code editor in Settings.")?;
    platform::application_at(Path::new(&path))
        .ok_or_else(|| "The selected editor is unavailable. Choose another in Settings.".into())
}

pub(crate) fn editor_command(
    application: &Application,
) -> Result<(std::path::PathBuf, bool), String> {
    platform::editor_command(application)
}

fn include_selections(
    catalog: &mut ApplicationCatalog,
    selections: BTreeMap<String, String>,
    read: impl Fn(&Path) -> Option<Application>,
) {
    for (kind, applications) in [
        ("terminal", &mut catalog.terminal),
        ("editor", &mut catalog.editor),
        ("browser", &mut catalog.browser),
    ] {
        if let Some(path) = selections.get(kind) {
            if path.encode_utf16().count() <= 4096 && Path::new(path).is_absolute() {
                if let Some(application) = read(Path::new(path)) {
                    applications.push(application);
                }
            }
        }
        applications.retain(|application| {
            !application.name.is_empty()
                && application.name.encode_utf16().count() <= 256
                && application.path.encode_utf16().count() <= 4096
                && Path::new(&application.path).is_absolute()
        });
        applications
            .sort_by_key(|application| (application.name.to_lowercase(), application.path.clone()));
        let mut paths = std::collections::HashSet::new();
        applications.retain(|application| paths.insert(application.path.clone()));
        if catalog.defaults.get(kind).is_some_and(|path| {
            !applications
                .iter()
                .any(|application| &application.path == path)
        }) {
            catalog.defaults.remove(kind);
        }
    }
}

#[tauri::command]
pub async fn list_applications(
    app: AppHandle,
    window: WebviewWindow,
    selections: BTreeMap<String, String>,
) -> Result<ApplicationCatalog, String> {
    if !matches!(window.label(), "main" | "status") {
        return Err("This window cannot discover applications".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let _ = &app;
        let mut catalog = platform::discover()?;
        include_selections(&mut catalog, selections, platform::application_at);
        #[cfg(target_os = "linux")]
        let catalog = {
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            app.run_on_main_thread(move || {
                platform::load_icons(&mut catalog);
                let _ = send.send(catalog);
            })
            .map_err(|error| error.to_string())?;
            receive.recv().map_err(|error| error.to_string())?
        };
        Ok(catalog)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn choose_application(
    app: AppHandle,
    window: WebviewWindow,
    kind: ApplicationKind,
) -> Result<Option<Application>, String> {
    if window.label() != "main" {
        return Err("Only the main window can choose applications".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let title = match kind {
            ApplicationKind::Terminal => "Choose a terminal",
            ApplicationKind::Editor => "Choose a code editor",
            ApplicationKind::Browser => "Choose a browser",
        };
        let dialog = app.dialog().file().set_title(title).set_parent(&window);
        #[cfg(target_os = "macos")]
        let dialog = dialog
            .set_directory("/Applications")
            .add_filter("Applications", &["app"]);
        #[cfg(target_os = "linux")]
        let dialog = dialog.set_directory("/usr/share/applications");
        let Some(file) = dialog.blocking_pick_file() else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|error| error.to_string())?;
        let application = platform::application_at(&path)
            .ok_or("The selected item is not an available application")?;
        if application.name.encode_utf16().count() > 256
            || application.path.encode_utf16().count() > 4096
        {
            return Err("The selected application's name or location is too long".into());
        }
        #[cfg(target_os = "linux")]
        let application = {
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            app.run_on_main_thread(move || {
                let mut application = application;
                platform::load_icon(&mut application);
                let _ = send.send(application);
            })
            .map_err(|error| error.to_string())?;
            receive.recv().map_err(|error| error.to_string())?
        };
        Ok(Some(application))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_addresses_are_web_only_without_embedded_credentials() {
        for invalid in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:secret@localhost/",
            "http://localhost/\n",
            "--args",
        ] {
            assert!(browser_url(invalid).is_err());
        }
        assert_eq!(
            browser_url("http://127.0.0.1:3000/a?x=$(touch)").unwrap(),
            "http://127.0.0.1:3000/a?x=$(touch)"
        );
    }

    #[test]
    fn browser_preference_honors_default_and_requires_explicit_available_selection() {
        let settings =
            serde_json::json!({"browserUseSystemDefault": true, "browserPath": "/old/browser.app"});
        assert_eq!(
            browser_selection(settings.as_object().unwrap()).unwrap(),
            None
        );
        let settings = serde_json::json!({"browserUseSystemDefault": false, "browserPath": "/Applications/Selected.app"});
        assert_eq!(
            browser_selection(settings.as_object().unwrap()).unwrap(),
            Some(Path::new("/Applications/Selected.app"))
        );
        let settings = serde_json::json!({"browserUseSystemDefault": false});
        assert!(browser_selection(settings.as_object().unwrap()).is_err());
        let settings = serde_json::json!({"browserPath": "/Applications/Selected.app"});
        assert_eq!(
            browser_selection(settings.as_object().unwrap()).unwrap(),
            Some(Path::new("/Applications/Selected.app"))
        );
    }

    #[test]
    fn custom_choices_survive_discovery_without_offering_removed_apps() {
        let chosen = Application {
            name: "Custom Editor".into(),
            path: "/Applications/Custom.app".into(),
            icon: None,
        };
        let mut catalog = ApplicationCatalog::default();
        include_selections(
            &mut catalog,
            BTreeMap::from([
                ("editor".into(), chosen.path.clone()),
                ("terminal".into(), "/Applications/Removed.app".into()),
            ]),
            |path| (path == Path::new(&chosen.path)).then(|| chosen.clone()),
        );
        assert_eq!(catalog.editor, [chosen]);
        assert!(catalog.terminal.is_empty());
    }

    #[test]
    fn installed_and_custom_choices_are_deduplicated_by_exact_location() {
        let application = Application {
            name: "Editor".into(),
            path: "/Applications/Editor.app".into(),
            icon: None,
        };
        let mut catalog = ApplicationCatalog {
            editor: vec![application.clone()],
            ..Default::default()
        };
        include_selections(
            &mut catalog,
            BTreeMap::from([("editor".into(), application.path.clone())]),
            |_| Some(application.clone()),
        );
        assert_eq!(catalog.editor, [application]);
    }
}
