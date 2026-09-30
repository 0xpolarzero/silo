#[cfg(target_os = "macos")]
mod titlebar;
#[cfg(target_os = "macos")]
mod window_material;
mod applications;
mod bridge_error;
mod app_menu;
mod backup;
mod bundled_tools;
mod backup_controller;
mod dependencies;
mod desktop;
mod desktop_proxy;
mod desktop_viewer;
mod editor;
mod files;
mod github;
mod github_http;
#[cfg(test)]
mod github_build_tests;
#[cfg(test)]
mod command_permissions_tests;
#[cfg(test)]
mod github_permissions_tests;
#[cfg(test)]
mod github_live_tests;
mod github_tokens;
mod host_identity;
mod host_push;
mod host_push_cache;
mod host_push_transport;
mod host_push_operations;
mod network;
mod health_watch;
mod notifications;
mod runtime;
mod runtime_migration;
mod log_export;
mod log_retention;
mod remote;
mod remote_access;
mod remote_network;
mod remote_ssh_access;
mod secrets;
mod ssh_access;
mod ssh_connection;
mod settings;
mod single_instance;
mod startup;
mod status_panel;
mod sync;
#[cfg(test)]
mod test_support;
mod system_integrations;
mod system_shutdown;
mod tray;
mod terminal;
mod updates;
mod working_account;

use tauri::{Emitter, Manager, WindowEvent};

fn main() {
    #[cfg(target_os = "linux")]
    if std::env::current_exe().is_ok_and(|path| path == std::path::Path::new("/usr/bin/silo-ui"))
        && std::path::Path::new(system_integrations::PACKAGE_UPDATE_MARKER).exists()
    {
        system_integrations::explain_unfinished_package_update();
        return;
    }

    let args: Vec<_> = std::env::args().collect();
    let bridge = match args.get(1).map(String::as_str) {
        Some("--remote-bridge") => Some(remote::run_bridge()),
        Some("--remote-guest") => Some(if args.len() == 4 {
            remote::run_remote_stream(&args[2], "guest.ssh", serde_json::json!({"vmId": args[3]}))
        } else { Err("Expected a computer and VM identity.".into()) }),
        Some(editor::TRANSPORT_MODE) => Some(editor::run_transport(&args[2..])),
        _ => None,
    };
    if let Some(result) = bridge {
        if let Err(error) = result { eprintln!("{error}"); std::process::exit(1); }
        return;
    }
    // Plugins initialize while the app is built, in registration order, and the
    // setup hook runs only after that. A second launch therefore exits inside
    // the single-instance plugin before any migration, remote-management or VM work.
    let app = tauri::Builder::default()
        .plugin(single_instance::plugin())
        .on_page_load(|webview, _| {
            #[cfg(target_os = "macos")]
            if webview.label() == "main" {
                if let Some(window) = webview.get_webview_window("main") {
                    window_material::sync_accessibility(&window);
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = webview;
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            desktop::read_desktop_state,
            desktop::desktop_action,
            desktop_viewer::open_desktop,
            desktop_viewer::desktop_viewer_attach,
            desktop_viewer::desktop_viewer_detach,
            app_menu::set_app_menu_state,
            app_menu::show_app_menu,
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
            settings::enable_quit_confirmation,
            settings::answer_quit_request,
            tray::update_tray,
            host_push_operations::start_repository_push,
            host_push_operations::repository_push_status,
            host_push::dismiss_repository_push,
            files::list_workspace_directory,
            network::read_network_state,
            network::save_network_port,
            network::remove_network_port,
            network::open_network_port,
            ssh_access::read_ssh_access_state,
            ssh_access::save_ssh_access,
            ssh_connection::ssh_connection,
            secrets::read_secrets_state,
            secrets::save_secret,
            secrets::remove_secret,
            secrets::retry_secret,
            github::read_github_state,
            github::personal_token::save_github_personal_token,
            github::personal_token::remove_github_personal_token,
            github::connect_github,
            github::cancel_github_connection,
            github::reopen_github_authorization,
            github::manage_github_repositories,
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
            remote_ssh_access::remote_ssh_access_state,
            remote_ssh_access::remote_save_ssh_access,
            remote_network::remote_save_network_port,
            remote_network::remote_remove_network_port,
            remote_network::remote_open_network_port,
            remote::set_remote_management,
            remote::remote_host_list,
            remote::connect_remote_host,
            remote::remove_remote_host,
            remote::remote_host_snapshot,
            remote::remote_workspace_action,
            remote::remote_checkpoint_action,
            remote::remote_upsert_machine,
            remote::remote_delete_machine,
            system_integrations::read_system_integrations,
            system_integrations::set_login_item,
            system_integrations::request_notification_authorization,
            notifications::deliver_notice,
            notifications::clear_sandbox_notices,
            system_integrations::open_integration_settings,
            system_integrations::show_integration_error,
            applications::list_applications,
            applications::choose_application,
            dependencies::read_dependencies,
            backup_controller::read_backup_state,
            runtime_migration::read_runtime_migration_state,
            runtime_migration::retry_runtime_migration,
            runtime_migration::continue_after_migration_failure,
            backup_controller::choose_backup_destination,
            backup_controller::choose_backup_archive,
            backup_controller::inspect_backup_archive,
            backup_controller::cancel_backup_inspection,
            backup_controller::reveal_backup_archive,
            backup_controller::start_backup,
            backup_controller::start_restore,
            backup_controller::cancel_backup_operation,
            backup_controller::dismiss_backup_operation,
            runtime::read_application_state,
            runtime::storage::read_workspace_storage,
            runtime::storage::reclaim_workspace_storage,
            runtime::runtime_logs::query_sandbox_logs,
            log_export::export_workspace_logs,
            log_export::cancel_log_export,
            runtime::read_application_shell,
            runtime::read_machine_configuration,
            runtime::configure_workspace_identities,
            runtime::verify_workspace_identities,
            runtime::workspace_action,
            runtime::checkpoints::create_checkpoint,
            runtime::checkpoints::fork_checkpoint,
            runtime::checkpoints::restore_checkpoint,
            runtime::checkpoints::delete_checkpoint,
            runtime::checkpoints::abandon_restore,
            runtime::checkpoints::read_checkpoint_usage,
            runtime::read_setup_activity,
            runtime::read_operation_queue,
            runtime::cancel_operation,
            runtime::retry_machine_configuration,
            runtime::change_machine_configuration
        ])
        .setup(|app| {
            // Tauri panics on a setup error. Explain the failure and exit instead.
            let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            settings::install(app.handle());
            system_shutdown::install(app.handle());
            let queue_app = app.handle().clone();
            runtime::OPERATIONS.set_listener(move || {
                let _ = queue_app.emit("silo://operation-queue-changed", ());
            });
            runtime_migration::install(app.handle())?;
            remote::start(app.handle().clone());
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
                if matches!(event, WindowEvent::Focused(true)) { updates::focused(&handle); }
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if tray::available(&handle) {
                        if let Some(window) = handle.get_webview_window("main") {
                            status_panel::report(window.hide());
                        }
                    } else {
                        settings::request_quit(&handle);
                    }
                }
            });
            #[cfg(target_os = "macos")]
            window_material::install(&window)?;
            window.show()?;
            #[cfg(target_os = "macos")]
            titlebar::install(&window)?;
            notifications::install(app.handle());
            updates::install(app.handle())?;
            ssh_access::start_monitor(app.handle());
            editor::refresh_transports(app.handle());
            runtime::storage::start_monitor(app.handle());
            startup::install(app.handle());
            Ok(())
            })();
            if let Err(error) = result {
                startup_failed(app.handle(), &error.to_string());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| {
            eprintln!("Silo could not start: {error}");
            std::process::exit(1);
        });
    // tao installs its AppKit delegate while the event loop is created; add the
    // terminate handler before AppKit finishes launching.
    #[cfg(target_os = "macos")]
    system_shutdown::install_terminate_handler(app.handle());
    app.run(|_app, _event| {
        if let tauri::RunEvent::Exit = &_event {
            settings::exit_backstop(_app);
            ssh_access::close_all();
            remote_network::close_all();
        }
        if let tauri::RunEvent::ExitRequested { api, code, .. } = &_event {
            settings::prevent_exit_until_saved(_app, api, *code);
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

/// Setup stopped part-way, so some native state the UI relies on is missing. Stop
/// the UI from using it, explain the failure, and exit without the Quit path: it
/// would stop VMs that this process never managed.
fn startup_failed(app: &tauri::AppHandle, error: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    eprintln!("Silo could not start: {error}");
    settings::exit_without_shutdown(app);
    if let Ok(blank) = "about:blank".parse::<tauri::Url>() {
        for window in app.webview_windows().values() {
            let _ = window.navigate(blank.clone());
        }
    }
    app.dialog()
        .message(format!("Silo could not start.\n\n{error}"))
        .title("Silo")
        .kind(MessageDialogKind::Error)
        .show(|_| std::process::exit(1));
}
