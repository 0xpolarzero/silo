use serde::Deserialize;
use tauri::{image::Image, AppHandle};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Success,
    Neutral,
    Warning,
    Error,
    Busy,
}

fn icon(tone: Tone) -> Image<'static> {
    #[cfg(target_os = "macos")]
    let bytes: &[u8] = match tone {
        Tone::Success | Tone::Neutral => include_bytes!("../icons/tray/ready.png"),
        Tone::Warning => include_bytes!("../icons/tray/warning.png"),
        Tone::Error => include_bytes!("../icons/tray/error.png"),
        Tone::Busy => include_bytes!("../icons/tray/busy.png"),
    };
    #[cfg(target_os = "linux")]
    let bytes: &[u8] = match tone {
        Tone::Success | Tone::Neutral => include_bytes!("../icons/tray/ready-linux.png"),
        Tone::Warning => include_bytes!("../icons/tray/warning-linux.png"),
        Tone::Error => include_bytes!("../icons/tray/error-linux.png"),
        Tone::Busy => include_bytes!("../icons/tray/busy-linux.png"),
    };
    Image::from_bytes(bytes).expect("bundled status icon is valid")
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use crate::status_panel;
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    pub fn install(app: &AppHandle) -> tauri::Result<()> {
        TrayIconBuilder::with_id("silo")
            .icon(icon(Tone::Neutral))
            .icon_as_template(true)
            .tooltip("Silo")
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left | MouseButton::Right,
                    button_state: MouseButtonState::Up,
                    rect,
                    position,
                    ..
                } = event
                {
                    let scale = tray
                        .app_handle()
                        .monitor_from_point(position.x, position.y)
                        .ok()
                        .flatten()
                        .map_or(1.0, |monitor| monitor.scale_factor());
                    let origin = rect.position.to_physical::<f64>(scale);
                    let size = rect.size.to_physical::<f64>(scale);
                    status_panel::report(status_panel::toggle(
                        tray.app_handle(),
                        tauri::PhysicalPosition::new(
                            origin.x + size.width / 2.0,
                            origin.y + size.height,
                        ),
                    ));
                }
            })
            .build(app)?;
        Ok(())
    }

    pub async fn update(app: &AppHandle, tone: Tone, label: String) -> Result<(), String> {
        let tray = app.tray_by_id("silo").ok_or("Status item is unavailable")?;
        // Replacing the image must preserve native appearance tinting in one redraw.
        tray.set_icon_with_as_template(Some(icon(tone)), true)
            .map_err(|e| e.to_string())?;
        tray.set_tooltip(Some(format!("Silo · {label}")))
            .map_err(|e| e.to_string())
    }

    pub fn available(_: &AppHandle) -> bool {
        true
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use crate::status_panel;
    use ksni::TrayMethods;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tauri::Manager;

    struct LinuxTray {
        app: AppHandle,
        online: Arc<AtomicBool>,
        tone: Tone,
        label: String,
    }

    impl ksni::Tray for LinuxTray {
        fn id(&self) -> String {
            "org.silo.preview".into()
        }
        fn title(&self) -> String {
            "Silo".into()
        }
        fn icon_pixmap(&self) -> Vec<ksni::Icon> {
            let image = icon(self.tone);
            let mut argb = image.rgba().to_vec();
            for pixel in argb.chunks_exact_mut(4) {
                pixel.rotate_right(1);
            }
            vec![ksni::Icon {
                width: image.width() as i32,
                height: image.height() as i32,
                data: argb,
            }]
        }
        fn tool_tip(&self) -> ksni::ToolTip {
            ksni::ToolTip {
                title: "Silo".into(),
                description: self.label.clone(),
                ..Default::default()
            }
        }
        fn activate(&mut self, x: i32, y: i32) {
            let app = self.app.clone();
            status_panel::report(self.app.run_on_main_thread(move || {
                status_panel::report(status_panel::toggle(
                    &app,
                    tauri::PhysicalPosition::new(x as f64, y as f64),
                ));
            }));
        }
        fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
            vec![
                ksni::menu::StandardItem {
                    label: "Open Silo…".into(),
                    activate: Box::new(|tray: &mut Self| {
                        status_panel::report(status_panel::open_main(tray.app.clone()))
                    }),
                    ..Default::default()
                }
                .into(),
                ksni::menu::StandardItem {
                    label: "Quit Silo".into(),
                    activate: Box::new(|tray: &mut Self| tray.app.exit(0)),
                    ..Default::default()
                }
                .into(),
            ]
        }
        fn watcher_online(&self) {
            self.online.store(true, Ordering::Relaxed);
        }
        fn watcher_offline(&self, _: ksni::OfflineReason) -> bool {
            self.online.store(false, Ordering::Relaxed);
            // A desktop without a tray must never strand an invisible app.
            status_panel::report(status_panel::open_main(self.app.clone()));
            true
        }
    }

    struct TrayState {
        online: Arc<AtomicBool>,
        handle: std::sync::Mutex<Option<ksni::Handle<LinuxTray>>>,
    }

    pub fn install(app: &AppHandle) -> tauri::Result<()> {
        // ksni only calls watcher_online after a prior watcher_offline callback.
        let online = Arc::new(AtomicBool::new(true));
        app.manage(TrayState {
            online: online.clone(),
            handle: std::sync::Mutex::new(None),
        });
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            match (LinuxTray {
                app: app.clone(),
                online,
                tone: Tone::Neutral,
                label: "Silo".into(),
            })
            .assume_sni_available(true)
            .spawn()
            .await
            {
                Ok(handle) => *app.state::<TrayState>().handle.lock().unwrap() = Some(handle),
                Err(error) => {
                    app.state::<TrayState>()
                        .online
                        .store(false, Ordering::Relaxed);
                    status_panel::report(status_panel::open_main(app.clone()));
                    eprintln!("Silo tray: {error}");
                }
            }
        });
        Ok(())
    }

    pub async fn update(app: &AppHandle, tone: Tone, label: String) -> Result<(), String> {
        let handle = app.state::<TrayState>().handle.lock().unwrap().clone();
        if let Some(handle) = handle {
            handle
                .update(move |tray| {
                    tray.tone = tone;
                    tray.label = label;
                })
                .await;
        }
        Ok(())
    }

    pub fn available(app: &AppHandle) -> bool {
        app.state::<TrayState>().online.load(Ordering::Relaxed)
    }
}

pub use platform::{available, install};

#[tauri::command]
pub async fn update_tray(app: AppHandle, tone: Tone, label: String) -> Result<(), String> {
    platform::update(&app, tone, label).await
}
