//! UI-only native fixture harness; does not initialize Silo services or touch VM state.
//! Run the frontend on localhost:1422, then `cargo run --example material_preview`.
#[cfg(target_os = "macos")]
#[path = "../src/titlebar.rs"]
mod titlebar;
#[cfg(target_os = "macos")]
#[path = "../src/window_material.rs"]
mod window_material;

fn main() {
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .setup(|app| {
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
