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

#[tauri::command]
pub async fn read_system_integrations(
    _app: AppHandle,
    window: WebviewWindow,
) -> Result<SystemIntegrations, String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || Ok(platform::read()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_login_item(
    _app: AppHandle,
    window: WebviewWindow,
    enabled: bool,
) -> Result<IntegrationStatus, String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || platform::set_login_item(enabled))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn request_notification_authorization(
    _app: AppHandle,
    window: WebviewWindow,
) -> Result<IntegrationStatus, String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || platform::request_notifications())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn open_integration_settings(
    _app: AppHandle,
    window: WebviewWindow,
    integration: String,
) -> Result<(), String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || platform::open_settings(&integration))
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
    app.dialog()
        .message(message)
        .title("Silo couldn’t complete the request")
        .kind(MessageDialogKind::Error)
        .parent(&window)
        .show(|_| {});
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integration_mutations_are_main_window_only() {
        assert!(require_main_label("main").is_ok());
        assert!(require_main_label("status").is_err());
        assert!(require_main_label("other").is_err());
    }
}
