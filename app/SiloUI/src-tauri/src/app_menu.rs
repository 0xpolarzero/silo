//! Native macOS menu actions use the same frontend flows and native operation
//! gates as clicks. Unready or busy views cannot receive stale menu commands.
use serde::Deserialize;
use tauri::{AppHandle, WebviewWindow};

#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MenuState {
    ready: bool,
    busy: bool,
    can_go_back: bool,
    can_go_forward: bool,
    can_create_sandbox: bool,
    can_backup: bool,
    can_restore: bool,
    can_check_updates: bool,
    sidebar_collapsed: bool,
}
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
fn enabled(command: &str, state: &MenuState) -> bool {
    if matches!(command, "show-window" | "help" | "issues" | "releases") {
        return true;
    }
    if !state.ready || state.busy {
        return false;
    }
    match command {
        "new-sandbox" => state.can_create_sandbox,
        "create-backup" => state.can_backup,
        "restore-backup" => state.can_restore,
        "check-updates" => state.can_check_updates,
        "go-back" => state.can_go_back,
        "go-forward" => state.can_go_forward,
        "settings" | "search" | "toggle-sidebar" | "go-sandboxes" | "go-github" | "go-secrets"
        | "go-files" | "go-logs" | "go-network" | "go-backup" | "go-activity" => true,
        _ => false,
    }
}
#[tauri::command]
pub(crate) fn set_app_menu_state(
    app: AppHandle,
    window: WebviewWindow,
    state: MenuState,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can update the application menu.".into());
    }
    #[cfg(target_os = "macos")]
    native::set_state(&app, state)?;
    #[cfg(not(target_os = "macos"))]
    let _ = (app, state);
    Ok(())
}
pub(crate) fn install(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    native::install(app)?;
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::sync::Mutex;
    use tauri::{
        menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem as Standard, Submenu},
        Emitter, Manager,
    };
    struct Controller {
        state: Mutex<MenuState>,
        items: Vec<(&'static str, MenuItem<tauri::Wry>)>,
    }
    pub(super) fn set_state(app: &AppHandle, state: MenuState) -> Result<(), String> {
        let menu = app.state::<Controller>();
        // Do not hold a lock while set_enabled dispatches work to the main thread.
        *menu
            .state
            .lock()
            .map_err(|_| "Application menu state is unavailable.")? = state.clone();
        for (command, item) in &menu.items {
            if *command == "toggle-sidebar" {
                item.set_text(if state.sidebar_collapsed {
                    "Show Sidebar"
                } else {
                    "Hide Sidebar"
                })
                .map_err(|_| "Application menu could not be updated.")?;
            }
            item.set_enabled(enabled(command, &state))
                .map_err(|_| "Application menu could not be updated.")?;
        }
        Ok(())
    }
    fn link(command: &str) -> Option<&'static str> {
        match command {
            "issues" => Some("https://github.com/0xpolarzero/silo/issues"),
            "releases" => Some("https://github.com/0xpolarzero/silo/releases"),
            _ => None,
        }
    }
    pub(super) fn install(app: &AppHandle) -> tauri::Result<()> {
        let mut items = Vec::new();
        let mut item = |id: &'static str,
                        title: &str,
                        shortcut: Option<&str>|
         -> tauri::Result<MenuItem<tauri::Wry>> {
            let entry = MenuItem::with_id(
                app,
                format!("silo-menu:{id}"),
                title,
                enabled(id, &MenuState::default()),
                shortcut,
            )?;
            items.push((id, entry.clone()));
            Ok(entry)
        };
        let about = Standard::about(
            app,
            Some("About Silo"),
            Some(AboutMetadata {
                name: Some("Silo".into()),
                version: Some(app.package_info().version.to_string()),
                icon: app.default_window_icon().cloned(),
                ..Default::default()
            }),
        )?;
        let app_menu = Submenu::with_items(
            app,
            "Silo",
            true,
            &[
                &about,
                &item("settings", "Settings…", Some("Cmd+,"))?,
                &item("check-updates", "Check for Updates…", None)?,
                &Standard::separator(app)?,
                &Standard::services(app, None)?,
                &Standard::separator(app)?,
                &Standard::hide(app, Some("Hide Silo"))?,
                &Standard::hide_others(app, None)?,
                &Standard::show_all(app, None)?,
                &Standard::separator(app)?,
                &Standard::quit(app, Some("Quit Silo"))?,
            ],
        )?;
        let file = Submenu::with_items(
            app,
            "File",
            true,
            &[
                &item("new-sandbox", "New Sandbox…", Some("Cmd+N"))?,
                &item("create-backup", "Create Backup…", None)?,
                &item("restore-backup", "Restore Backup…", None)?,
                &Standard::separator(app)?,
                &Standard::close_window(app, None)?,
            ],
        )?;
        let edit = Submenu::with_items(
            app,
            "Edit",
            true,
            &[
                &Standard::undo(app, None)?,
                &Standard::redo(app, None)?,
                &Standard::separator(app)?,
                &Standard::cut(app, None)?,
                &Standard::copy(app, None)?,
                &Standard::paste(app, None)?,
                &Standard::select_all(app, None)?,
            ],
        )?;
        let view = Submenu::with_items(
            app,
            "View",
            true,
            &[
                &item("search", "Search or Jump To…", Some("Cmd+K"))?,
                &Standard::separator(app)?,
                &item("go-back", "Back", Some("Cmd+["))?,
                &item("go-forward", "Forward", Some("Cmd+]"))?,
                &Standard::separator(app)?,
                &item("toggle-sidebar", "Hide Sidebar", None)?,
                &Standard::fullscreen(app, None)?,
            ],
        )?;
        let go = Submenu::with_items(
            app,
            "Go",
            true,
            &[
                &item("go-sandboxes", "Sandboxes", None)?,
                &item("go-files", "Files", None)?,
                &item("go-logs", "Logs", None)?,
                &item("go-network", "Network", None)?,
                &item("go-activity", "Activity", None)?,
                &item("go-github", "GitHub", None)?,
                &item("go-secrets", "Secrets", None)?,
                &item("go-backup", "Backup", None)?,
            ],
        )?;
        let window = Submenu::with_items(
            app,
            "Window",
            true,
            &[
                &item("show-window", "Show Silo", None)?,
                &Standard::separator(app)?,
                &Standard::minimize(app, None)?,
                &Standard::maximize(app, Some("Zoom"))?,
                &Standard::separator(app)?,
                &Standard::bring_all_to_front(app, None)?,
            ],
        )?;
        let help = Submenu::with_items(
            app,
            "Help",
            true,
            &[
                &item("help", "Documentation", None)?,
                &item("issues", "Report an Issue…", None)?,
                &item("releases", "Release Notes", None)?,
            ],
        )?;
        app.set_menu(Menu::with_items(
            app,
            &[&app_menu, &file, &edit, &view, &go, &window, &help],
        )?)?;
        window.set_as_windows_menu_for_nsapp()?;
        help.set_as_help_menu_for_nsapp()?;
        app.manage(Controller {
            state: Mutex::new(MenuState::default()),
            items,
        });
        app.on_menu_event(|app, event| {
            let Some(command) = event.id().as_ref().strip_prefix("silo-menu:") else {
                return;
            };
            let state = app
                .state::<Controller>()
                .state
                .lock()
                .map(|s| s.clone())
                .unwrap_or_default();
            if !enabled(command, &state) {
                return;
            }
            if command == "help" || link(command).is_some() {
                // Help ships with this build; external destinations are fixed project URLs.
                let destination = if command == "help" {
                    app.path()
                        .resource_dir()
                        .map(|p| p.join("docs/silo-help.html").into_os_string())
                        .map_err(|_| "Silo Help could not be located.")
                } else {
                    Ok(std::ffi::OsString::from(link(command).unwrap()))
                };
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let result = destination.and_then(|destination| {
                        std::process::Command::new("/usr/bin/open")
                            .arg(destination)
                            .status()
                            .map_err(|_| "The document or browser could not be opened.")
                            .and_then(|status| {
                                if status.success() {
                                    Ok(())
                                } else {
                                    Err("The document or browser could not be opened.")
                                }
                            })
                    });
                    if let Err(message) = result {
                        if let Some(window) = app.get_webview_window("main") {
                            crate::status_panel::report(
                                crate::system_integrations::show_integration_error(
                                    app.clone(),
                                    window,
                                    message.into(),
                                ),
                            );
                        }
                    }
                });
                return;
            }
            if let Err(error) = crate::status_panel::open_main(app.clone(), None) {
                crate::status_panel::report::<(), _>(Err(error));
                return;
            }
            if command != "show-window" {
                crate::status_panel::report(app.emit_to("main", "silo://menu-command", command));
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unready_or_busy_ui_cannot_receive_navigation_or_mutation_commands() {
        let unready = MenuState::default();
        let busy = MenuState {
            ready: true,
            busy: true,
            can_create_sandbox: true,
            can_backup: true,
            can_restore: true,
            can_check_updates: true,
            can_go_back: true,
            can_go_forward: true,
            sidebar_collapsed: false,
        };
        for state in [unready, busy] {
            for command in [
                "settings",
                "new-sandbox",
                "create-backup",
                "restore-backup",
                "check-updates",
                "search",
                "go-back",
                "go-forward",
                "go-github",
            ] {
                assert!(!enabled(command, &state), "{command}");
            }
            assert!(enabled("show-window", &state));
        }
    }
    #[test]
    fn action_permissions_do_not_disable_unrelated_navigation() {
        let mut state = MenuState {
            ready: true,
            ..Default::default()
        };
        assert!(!enabled("new-sandbox", &state));
        assert!(!enabled("create-backup", &state));
        assert!(!enabled("restore-backup", &state));
        assert!(!enabled("check-updates", &state));
        assert!(enabled("settings", &state));
        assert!(enabled("go-backup", &state));
        state.can_backup = true;
        state.can_go_back = true;
        assert!(enabled("create-backup", &state));
        assert!(enabled("go-back", &state));
        assert!(!enabled("go-forward", &state));
        assert!(!enabled("unknown-command", &state));
    }
}
