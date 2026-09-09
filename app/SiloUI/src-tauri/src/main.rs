mod applications;
mod backup;
mod backup_controller;
mod dependencies;
mod github;
mod host_identity;
mod notifications;
mod runtime;
mod settings;
mod startup;
mod status_panel;
mod system_integrations;
mod tray;

use tauri::{Manager, WindowEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            status_panel::open_main,
            status_panel::hide_status,
            status_panel::resize_status,
            status_panel::quit_app,
            tray::update_tray,
            github::read_github_state,
            github::connect_github,
            github::disconnect_github,
            github::set_github_access_enabled,
            github::save_github_configuration,
            github::retry_github_configuration,
            github::refresh_github_repositories,
            settings::initialize_settings,
            settings::read_settings,
            settings::update_settings,
            settings::update_onboarding_draft,
            settings::import_legacy_theme,
            settings::flush_settings,
            settings::begin_settings_flush,
            settings::complete_settings_flush,
            system_integrations::read_system_integrations,
            system_integrations::set_login_item,
            system_integrations::request_notification_authorization,
            system_integrations::open_integration_settings,
            system_integrations::show_integration_error,
            applications::list_applications,
            applications::choose_application,
            dependencies::read_dependencies,
            backup_controller::read_backup_state,
            backup_controller::choose_backup_destination,
            backup_controller::choose_backup_archive,
            backup_controller::inspect_backup_archive,
            backup_controller::start_backup,
            backup_controller::start_restore,
            backup_controller::cancel_backup_operation,
            backup_controller::dismiss_backup_operation,
            runtime::read_application_state,
            runtime::configure_workspace_identities,
            runtime::verify_workspace_identities,
            runtime::workspace_action,
            backup_controller::retry_workspace_start,
            runtime::read_setup_activity,
            runtime::save_machine_configuration
        ])
        .setup(|app| {
            settings::install(app.handle());
            github::install(app.handle());
            backup_controller::install(app.handle())?;
            status_panel::install(app.handle())?;
            tray::install(app.handle())?;
            let window = app
                .get_webview_window("main")
                .expect("main window is configured");
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
            notifications::install(app.handle());
            startup::install(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Silo")
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
