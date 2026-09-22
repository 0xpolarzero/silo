use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};
use tauri::{WebviewWindow, WindowEvent};

// WindowToolbar and WindowTitleBar both use h-11 (44 logical pixels).
const TOOLBAR_CENTER_Y: f64 = 22.0;

fn align(window: &WebviewWindow) -> tauri::Result<()> {
    let window = window.clone();
    window.clone().run_on_main_thread(move || {
        let Ok(pointer) = window.ns_window() else {
            return;
        };
        // Tauri owns the NSWindow; this closure runs on its AppKit thread.
        let native = unsafe { &*pointer.cast::<NSWindow>() };
        if native.styleMask().contains(NSWindowStyleMask::FullScreen) {
            return;
        }
        let Some(close) = native.standardWindowButton(NSWindowButton::CloseButton) else {
            return;
        };
        let Some(minimize) = native.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
            return;
        };
        let spacing = minimize.frame().origin.x - close.frame().origin.x;
        for (index, kind) in [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ]
        .into_iter()
        .enumerate()
        {
            let Some(button) = native.standardWindowButton(kind) else {
                continue;
            };
            let rect = button.convertRect_toView(button.bounds(), None);
            let center_from_top =
                native.frame().size.height - rect.origin.y - rect.size.height / 2.0;
            let mut origin = button.frame().origin;
            // Keep all placement here. A configured trafficLightPosition would
            // make Tao reposition the title-bar container on every redraw.
            origin.x = 12.0 + index as f64 * spacing;
            let correction = center_from_top - TOOLBAR_CENTER_Y;
            origin.y += if unsafe { button.superview() }.is_some_and(|view| view.isFlipped()) {
                -correction
            } else {
                correction
            };
            button.setFrameOrigin(origin);
        }
    })
}

pub(crate) fn install(window: &WebviewWindow) -> tauri::Result<()> {
    align(window)?;
    let handle = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
                | WindowEvent::Focused(_)
        ) {
            if let Err(error) = align(&handle) {
                eprintln!("Window button alignment failed: {error}");
            }
        }
    });
    Ok(())
}
