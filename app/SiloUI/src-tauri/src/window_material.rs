//! Native compositor material. Never capture or synthesize a desktop wallpaper.
#[cfg(target_os = "macos")]
pub(crate) fn install(window: &tauri::WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    use objc2::{runtime::AnyClass, MainThreadMarker};
    use objc2_app_kit::{
        NSAutoresizingMaskOptions, NSColor, NSGlassEffectView, NSGlassEffectViewStyle, NSView,
        NSWindow,
    };

    let mtm =
        MainThreadMarker::new().ok_or("Window material must be installed on the main thread")?;
    // The window belongs to Tauri and remains alive throughout setup.
    let native = unsafe { &*window.ns_window()?.cast::<NSWindow>() };
    native.setOpaque(false);
    native.setBackgroundColor(Some(&NSColor::clearColor()));
    // Check class availability before touching the macOS 26-only API.
    if AnyClass::get(c"NSGlassEffectView").is_some() {
        let content = native
            .contentView()
            .ok_or("Missing main window content view")?;
        let bounds = content.bounds();
        let glass = NSGlassEffectView::initWithFrame(mtm.alloc(), bounds);
        // Regular adapts the material to preserve legibility over busy backgrounds.
        glass.setStyle(NSGlassEffectViewStyle::Regular);
        glass.setCornerRadius(10.0);
        glass.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        native.setContentView(None::<&NSView>);
        content.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        glass.setContentView(Some(&content));
        native.setContentView(Some(&glass));
    } else {
        // macOS 14/15 have desktop vibrancy, not Liquid Glass refraction.
        window.set_effects(tauri::utils::config::WindowEffectsConfig {
            effects: vec![tauri::window::Effect::Sidebar],
            ..Default::default()
        })?;
    }
    // One observer for the main window's application lifetime. NSNotificationCenter
    // retains its block/token; the callback runs on the AppKit main queue.
    let handle = window.clone();
    let changed = block2::RcBlock::new(
        move |_: std::ptr::NonNull<objc2_foundation::NSNotification>| {
            sync_accessibility(&handle);
        },
    );
    unsafe {
        objc2_app_kit::NSWorkspace::sharedWorkspace()
            .notificationCenter()
            .addObserverForName_object_queue_usingBlock(
                Some(objc2_app_kit::NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification),
                None,
                Some(&objc2_foundation::NSOperationQueue::mainQueue()),
                &changed,
            );
    }
    sync_accessibility(window);
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn sync_accessibility(window: &tauri::WebviewWindow) {
    let handle = window.clone();
    let _ = window.run_on_main_thread(move || {
        let workspace = objc2_app_kit::NSWorkspace::sharedWorkspace();
        let opaque = workspace.accessibilityDisplayShouldReduceTransparency()
            || workspace.accessibilityDisplayShouldIncreaseContrast();
        let _ = handle.eval(format!(
            "document.documentElement.classList.toggle('native-opaque', {opaque});"
        ));
    });
}
