use serde::Serialize;
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    pub state: String,
    pub error: Option<String>,
}

impl IntegrationStatus {
    fn new(state: &str) -> Self {
        Self {
            state: state.into(),
            error: None,
        }
    }

    fn error(message: impl Into<String>) -> Self {
        Self {
            state: "error".into(),
            error: Some(message.into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemIntegrations {
    pub platform: &'static str,
    pub login_item: IntegrationStatus,
    pub notifications: IntegrationStatus,
}

fn fixture_snapshot() -> SystemIntegrations {
    SystemIntegrations {
        platform: "fixture",
        login_item: IntegrationStatus::new("notRegistered"),
        notifications: IntegrationStatus::new("notDetermined"),
    }
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    require_main_label(window.label())
}

fn require_main_label(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("Only the main window can change system integrations".into())
    }
}

fn fixture(app: &AppHandle) -> Result<bool, String> {
    crate::settings::uses_fixture_storage(app)
}

#[tauri::command]
pub async fn system_integrations_fixture(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<bool, String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || fixture(&app))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_system_integrations(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<SystemIntegrations, String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        if fixture(&app)? {
            Ok(fixture_snapshot())
        } else {
            Ok(platform::read())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_login_item(
    app: AppHandle,
    window: WebviewWindow,
    enabled: bool,
) -> Result<IntegrationStatus, String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        if fixture(&app)? {
            return Err("System integrations are unavailable in fixture mode".into());
        }
        platform::set_login_item(enabled)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn request_notification_authorization(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<IntegrationStatus, String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        if fixture(&app)? {
            return Err("System integrations are unavailable in fixture mode".into());
        }
        platform::request_notifications()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn open_integration_settings(
    app: AppHandle,
    window: WebviewWindow,
    integration: String,
) -> Result<(), String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        if fixture(&app)? {
            return Err("System integrations are unavailable in fixture mode".into());
        }
        platform::open_settings(&integration)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn show_integration_error(
    app: AppHandle,
    window: WebviewWindow,
    message: String,
) -> Result<(), String> {
    require_main(&window)?;
    if fixture(&app)? {
        return Ok(());
    }
    app.dialog()
        .message(message)
        .title("Silo couldn’t complete the request")
        .kind(MessageDialogKind::Error)
        .parent(&window)
        .show(|_| {});
    Ok(())
}

#[tauri::command]
pub fn debug_onboarding_complete(app: AppHandle, window: WebviewWindow) -> Result<bool, String> {
    require_main(&window)?;
    #[cfg(debug_assertions)]
    {
        if fixture(&app)? {
            return Ok(false);
        }
        return Ok(std::env::var("SILO_NATIVE_ONBOARDING_COMPLETE").as_deref() == Ok("1"));
    }
    #[cfg(not(debug_assertions))]
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_authority_is_off_without_consulting_a_platform_adapter() {
        assert_eq!(fixture_snapshot().login_item.state, "notRegistered");
        assert_eq!(fixture_snapshot().notifications.state, "notDetermined");
        assert_eq!(fixture_snapshot().platform, "fixture");
    }

    #[test]
    fn integration_mutations_are_main_window_only() {
        assert!(require_main_label("main").is_ok());
        assert!(require_main_label("status").is_err());
        assert!(require_main_label("other").is_err());
    }
}
