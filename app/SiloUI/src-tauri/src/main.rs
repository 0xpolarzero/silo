mod applications;
mod dependencies;
mod settings;
mod status_panel;
mod system_integrations;
mod tray;

use tauri::{Manager, WindowEvent};

#[cfg(debug_assertions)]
fn debug_fixture_url() -> Option<tauri::Url> {
    let query = std::env::var("SILO_DEBUG_FIXTURE_QUERY").ok()?;
    if !query.starts_with('?') || query.len() > 512 || query.contains(['\n', '\r', '#']) {
        return None;
    }
    let allowed = [
        "view",
        "scenario",
        "github",
        "sandbox-state",
        "sandbox-change",
        "system-issue",
        "repository-push",
        "activity",
        "github-operation",
        "backup-operation",
        "resource-notice",
    ];
    let valid = query[1..].split('&').all(|pair| {
        let key = pair.split('=').next().unwrap_or_default();
        !key.is_empty() && allowed.contains(&key)
    });
    if !valid {
        return None;
    }
    format!("tauri://localhost/{query}").parse().ok()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            status_panel::open_main,
            status_panel::hide_status,
            status_panel::resize_status,
            status_panel::quit_app,
            tray::update_tray,
            settings::initialize_settings,
            settings::read_settings,
            settings::update_settings,
            settings::update_onboarding_draft,
            settings::import_legacy_theme,
            settings::flush_settings,
            settings::begin_settings_flush,
            settings::complete_settings_flush,
            system_integrations::system_integrations_fixture,
            system_integrations::read_system_integrations,
            system_integrations::set_login_item,
            system_integrations::request_notification_authorization,
            system_integrations::open_integration_settings,
            system_integrations::show_integration_error,
            system_integrations::debug_onboarding_complete,
            applications::list_applications,
            applications::choose_application,
            dependencies::read_dependencies
        ])
        .setup(|app| {
            settings::install(app.handle());
            status_panel::install(app.handle())?;
            tray::install(app.handle())?;
            let window = app
                .get_webview_window("main")
                .expect("main window is configured");
            #[cfg(debug_assertions)]
            if let Some(url) = debug_fixture_url() {
                window.navigate(url)?;
            }
            #[cfg(target_os = "linux")]
            window.set_decorations(false)?;
            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if tray::available(&handle) {
                        if let Some(window) = handle.get_webview_window("main") {
                            status_panel::report(window.hide());
                        }
                    } else {
                        handle.exit(0);
                    }
                }
            });
            window.show()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Silo Preview")
        .run(|_app, _event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = &_event {
                settings::prevent_exit_until_saved(_app, api);
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = _event
            {
                status_panel::report(status_panel::open_main(_app.clone()));
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_fixture_query_rejects_unowned_keys() {
        std::env::set_var("SILO_DEBUG_FIXTURE_QUERY", "?view=app&unknown=1");
        assert!(debug_fixture_url().is_none());
        std::env::remove_var("SILO_DEBUG_FIXTURE_QUERY");
    }
}
