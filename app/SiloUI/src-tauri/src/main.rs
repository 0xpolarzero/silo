mod applications;
mod app_menu;
mod backup;
mod bundled_tools;
mod backup_controller;
mod dependencies;
mod editor;
mod files;
mod github;
mod github_http;
#[cfg(test)]
mod github_live_tests;
mod github_tokens;
mod host_identity;
mod host_push;
mod network;
mod notifications;
mod runtime;
mod remote;
mod remote_access;
mod remote_network;
mod secrets;
mod settings;
mod startup;
mod status_panel;
mod system_integrations;
mod tray;
mod terminal;
mod updates;

use tauri::{Manager, WindowEvent};

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let bridge = match args.get(1).map(String::as_str) {
        Some("--remote-bridge") => Some(remote::run_bridge()),
        Some("--remote-guest") => Some(if args.len() == 4 {
            remote::run_remote_stream(&args[2], "guest.ssh", serde_json::json!({"vmId": args[3]}))
        } else { Err("Expected a computer and VM identity.".into()) }),
        _ => None,
    };
    if let Some(result) = bridge {
        if let Err(error) = result { eprintln!("{error}"); std::process::exit(1); }
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            app_menu::set_app_menu_state,
            updates::get_update_state,
            updates::check_for_update,
            updates::download_update,
            updates::install_update,
            updates::set_update_automatic_checks,
            updates::open_update_release,
            status_panel::open_main,
            status_panel::take_main_route,
            status_panel::hide_status,
            status_panel::resize_status,
            status_panel::quit_app,
            tray::update_tray,
            host_push::push_repository,
            host_push::dismiss_repository_push,
            files::list_workspace_directory,
            network::read_network_state,
            network::save_network_port,
            network::remove_network_port,
            network::open_network_port,
            secrets::read_secrets_state,
            secrets::save_secret,
            secrets::remove_secret,
            secrets::retry_secret,
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
            settings::cancel_settings_flush,
            settings::read_shutdown_state,
            remote::remote_management_status,
            remote::remote_authorize_ssh,
            remote::remote_setup_ssh_key,
            remote_network::remote_network_state,
            remote_network::remote_save_network_port,
            remote_network::remote_remove_network_port,
            remote_network::remote_open_network_port,
            remote::set_remote_management,
            remote::remote_host_list,
            remote::connect_remote_host,
            remote::remove_remote_host,
            remote::remote_host_snapshot,
            remote::remote_workspace_action,
            remote::remote_upsert_machine,
            remote::remote_delete_machine,
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
            runtime::read_application_shell,
            runtime::read_machine_configuration,
            runtime::configure_workspace_identities,
            runtime::verify_workspace_identities,
            runtime::workspace_action,
            backup_controller::retry_workspace_start,
            runtime::read_setup_activity,
            runtime::save_machine_configuration
        ])
        .setup(|app| {
            settings::install(app.handle());
            remote::start(app.handle().clone())?;
            secrets::install(app.handle())?;
            github::install(app.handle());
            backup_controller::install(app.handle())?;
            status_panel::install(app.handle())?;
            tray::install(app.handle())?;
            app_menu::install(app.handle())?;
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
            updates::install(app.handle())?;
            startup::install(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Silo")
        .run(|_app, _event| {
            if let tauri::RunEvent::Exit = &_event { remote_network::close_all(); }
            if let tauri::RunEvent::ExitRequested { api, .. } = &_event {
                settings::prevent_exit_until_saved(_app, api);
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = _event
            {
                status_panel::report(status_panel::open_main(_app.clone(), None));
            }
        });
}
