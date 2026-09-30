//! UI-only native fixture harness; does not initialize Silo services or touch VM state.
//! Run the frontend on localhost:1422, then `cargo run --example material_preview`.
#[cfg(target_os = "macos")]
#[path = "../src/titlebar.rs"]
mod titlebar;
#[cfg(target_os = "macos")]
#[path = "../src/window_material.rs"]
mod window_material;

use tauri::Manager;

#[tauri::command]
async fn set_preview_theme(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    theme: String,
) -> Result<serde_json::Value, String> {
    if window.label() != "material-preview" {
        return Err("Only the material preview can change its appearance".into());
    }
    let native_theme = match theme.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        "system" => None,
        _ => return Err("Invalid preview theme".into()),
    };
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        handle.set_theme(native_theme);
        #[cfg(target_os = "macos")]
        let result = (|| {
            use objc2::MainThreadMarker;
            use objc2_app_kit::{NSAppearanceCustomization, NSApplication, NSWindow};
            let mtm = MainThreadMarker::new().ok_or("Missing AppKit main thread")?;
            // Tauri owns the window. Read it only on AppKit's main thread, after
            // the same supported app theme API used by production settings.
            let pointer = window.ns_window().map_err(|error| error.to_string())?;
            let native = unsafe { &*pointer.cast::<NSWindow>() };
            Ok::<_, String>(serde_json::json!({
                "requestedTheme": theme,
                "appOverride": NSApplication::sharedApplication(mtm)
                    .appearance().map(|appearance| appearance.name().to_string()),
                "windowAppearance": native.effectiveAppearance().name().to_string(),
                "materialAppearance": native.contentView()
                    .map(|view| view.effectiveAppearance().name().to_string()),
            }))
        })();
        #[cfg(not(target_os = "macos"))]
        let result = window
            .theme()
            .map(|appearance| {
                serde_json::json!({
                    "requestedTheme": theme,
                    "windowAppearance": appearance.to_string(),
                })
            })
            .map_err(|error| error.to_string());
        if let Ok(appearance) = &result {
            eprintln!("Silo material preview appearance: {appearance}");
        }
        let _ = send.send(result);
    })
    .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())?
}

fn main() {
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_preview_theme])
        .setup(|app| {
            app.add_capability(r#"{
                "identifier": "material-preview-theme",
                "description": "Apply and inspect the isolated native material fixture appearance.",
                "windows": ["material-preview"],
                "local": true,
                "remote": {"urls": ["http://localhost:1422/*"]},
                "permissions": ["allow-set-preview-theme"]
            }"#)?;
            app.set_theme(Some(tauri::Theme::Dark));
            let builder = tauri::WebviewWindowBuilder::new(app, "material-preview",
                tauri::WebviewUrl::External("http://localhost:1422/glass.html?production=1&appearance=dark".parse()?))
                .title("Silo Material Preview — sample data")
                .inner_size(1160.0, 820.0)
                .transparent(true)
                .visible(false)
                .on_page_load(|window, _| {
                    #[cfg(target_os = "macos")]
                    window_material::sync_accessibility(&window);
                    #[cfg(not(target_os = "macos"))]
                    let _ = window;
                });
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .initialization_script("document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('native-material'));");
            let window = builder.build()?;
            #[cfg(target_os = "macos")]
            window_material::install(&window)?;
            window.show()?;
            #[cfg(target_os = "macos")]
            titlebar::install(&window)?;
            Ok(())
        })
        .run(context)
        .expect("native material fixture preview failed");
}
