use super::{Application, ApplicationCatalog};
use objc2::{
    rc::{autoreleasepool, Retained},
    runtime::AnyObject,
    sel, AnyThread,
};
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSCompositingOperation, NSDeviceRGBColorSpace,
    NSGraphicsContext, NSImage, NSImageInterpolation, NSWorkspace,
};
use objc2_foundation::{
    NSArray, NSBundle, NSCopying, NSData, NSDataBase64EncodingOptions, NSDictionary,
    NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL,
};
use std::{fs, os::unix::fs::PermissionsExt, path::Path};

// Launch Services also advertises editors for shell scripts. Only known terminal
// applications enter that list; Choose… can select any valid application bundle.
const TERMINAL_IDS: &[&str] = &[
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "com.mitchellh.ghostty",
    "dev.warp.Warp-Stable",
    "dev.warp.Warp-Preview",
    "org.alacritty",
    "com.github.wez.wezterm",
];

const EDITOR_IDS: &[&str] = &[
    "com.microsoft.VSCode",
    "com.microsoft.VSCodeInsiders",
    "com.visualstudio.code.oss",
    "com.todesktop.230313mzl4w4u92",
    "dev.zed.Zed",
    "dev.zed.Zed-Preview",
    "dev.zed.Zed-Nightly",
    "dev.zed.Zed-Dev",
];

const BROWSER_IDS: &[&str] = &[
    "com.apple.Safari",
    "com.google.Chrome",
    "org.mozilla.firefox",
    "com.microsoft.edgemac",
    "com.brave.Browser",
    "company.thebrowser.Browser",
    "company.thebrowser.dia",
    "org.torproject.torbrowser",
    "app.zen-browser.zen",
];

#[derive(Clone, Copy)]
enum HandlerFilter {
    Terminal,
    Editor,
    Browser,
    Any,
}

fn thumbnail_png(image: &NSImage) -> Option<Retained<NSData>> {
    // A dedicated bitmap context bounds the output independently of the source
    // image's representations and keeps all drawing on the calling worker.
    let bitmap = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(), std::ptr::null_mut(), 64, 64, 8, 4,
            true, false, NSDeviceRGBColorSpace, 64 * 4, 32,
        )
    }?;
    let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap)?;
    let previous = NSGraphicsContext::currentContext();
    NSGraphicsContext::setCurrentContext(Some(&context));
    context.setImageInterpolation(NSImageInterpolation::High);
    image.drawInRect_fromRect_operation_fraction(
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(64.0, 64.0)),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0)),
        NSCompositingOperation::Copy,
        1.0,
    );
    context.flushGraphics();
    NSGraphicsContext::setCurrentContext(previous.as_deref());
    // The dictionary is empty, so it cannot contain incorrectly typed options.
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    (png.length() <= 64 * 1024).then_some(png)
}

fn application_icon(path: &str) -> Option<String> {
    let icon = NSWorkspace::sharedWorkspace()
        .iconForFile(&NSString::from_str(path))
        .copy();
    let png = thumbnail_png(&icon)?;
    Some(format!(
        "data:image/png;base64,{}",
        png.base64EncodedStringWithOptions(NSDataBase64EncodingOptions::empty())
    ))
}

fn declares_source_editor(bundle: &NSBundle) -> bool {
    let Some(types) =
        bundle.objectForInfoDictionaryKey(&NSString::from_str("CFBundleDocumentTypes"))
    else {
        return false;
    };
    let Some(types) = types.downcast_ref::<NSArray>() else {
        return false;
    };
    types.iter().any(|document| {
        let Some(document) = document.downcast_ref::<NSDictionary>() else {
            return false;
        };
        let role = document.objectForKey(&NSString::from_str("CFBundleTypeRole"));
        if role.and_then(|role| nonempty_string(&role)).as_deref() != Some("Editor") {
            return false;
        }
        // Generic text/data handlers include browsers and word processors.
        // Require an explicit source type or extension when the editor is unknown.
        [
            (
                "LSItemContentTypes",
                &[
                    "public.source-code",
                    "public.swift-source",
                    "public.c-source",
                    "public.c-plus-plus-source",
                    "public.objective-c-source",
                    "public.objective-c-plus-plus-source",
                    "com.sun.java-source",
                    "public.script",
                    "public.shell-script",
                    "public.python-script",
                    "com.netscape.javascript-source",
                ][..],
            ),
            (
                "CFBundleTypeExtensions",
                &[
                    "c", "h", "cc", "cpp", "hpp", "m", "mm", "swift", "rs", "go", "py", "rb", "js",
                    "jsx", "tsx", "java", "kt", "sh", "lua", "ex", "exs", "cs", "php", "scala",
                    "clj",
                ][..],
            ),
        ]
        .into_iter()
        .any(|(key, source_types)| {
            let Some(values) = document.objectForKey(&NSString::from_str(key)) else {
                return false;
            };
            let Some(values) = values.downcast_ref::<NSArray>() else {
                return false;
            };
            values.iter().any(|value| {
                nonempty_string(&value).is_some_and(|value| source_types.contains(&value.as_str()))
            })
        })
    })
}

fn nonempty_string(value: &AnyObject) -> Option<String> {
    let text = value.downcast_ref::<NSString>()?.to_string();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn bundle_name(bundle: &NSBundle, path: &Path) -> Option<String> {
    for dictionary in [bundle.localizedInfoDictionary(), bundle.infoDictionary()]
        .into_iter()
        .flatten()
    {
        for key in ["CFBundleDisplayName", "CFBundleName"] {
            if let Some(name) = dictionary
                .objectForKey(&NSString::from_str(key))
                .and_then(|value| nonempty_string(&value))
            {
                return Some(name);
            }
        }
    }
    let name = path.file_stem()?.to_str()?.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

fn inspect_application(path: &Path) -> Option<(Application, Retained<NSBundle>)> {
    if !path.is_absolute() {
        return None;
    }
    let path = fs::canonicalize(path).ok()?;
    if !path.is_dir() || !path.extension()?.to_str()?.eq_ignore_ascii_case("app") {
        return None;
    }
    let bundle = NSBundle::bundleWithPath(&NSString::from_str(path.to_str()?))?;
    let package = bundle
        .objectForInfoDictionaryKey(&NSString::from_str("CFBundlePackageType"))
        .and_then(|value| nonempty_string(&value))?;
    if package != "APPL" {
        return None;
    }
    let executable = bundle.executablePath()?.to_string();
    let metadata = fs::metadata(executable).ok()?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return None;
    }
    let application = Application {
        name: bundle_name(&bundle, &path)?,
        path: path.to_str()?.to_owned(),
        icon: None,
    };
    Some((application, bundle))
}

pub fn application_at(path: &Path) -> Option<Application> {
    autoreleasepool(|_| {
        inspect_application(path).map(|(mut application, _)| {
            application.icon = application_icon(&application.path);
            application
        })
    })
}

fn add_url(
    applications: &mut Vec<Application>,
    url: &NSURL,
    filter: HandlerFilter,
) -> Option<String> {
    if !url.isFileURL() {
        return None;
    }
    let path = url.path()?.to_string();
    let (mut application, bundle) = inspect_application(Path::new(&path))?;
    let identifier = bundle.bundleIdentifier().map(|value| value.to_string());
    let is_terminal = identifier
        .as_deref()
        .is_some_and(|id| TERMINAL_IDS.contains(&id));
    let eligible = match filter {
        HandlerFilter::Terminal => is_terminal,
        HandlerFilter::Editor => {
            !is_terminal
                && (identifier
                    .as_deref()
                    .is_some_and(|id| EDITOR_IDS.contains(&id))
                    || declares_source_editor(&bundle))
        }
        // Terminals, download managers and virtual-machine helpers also register
        // HTTPS, so a URL scheme alone does not establish browser relevance.
        HandlerFilter::Browser => identifier
            .as_deref()
            .is_some_and(|id| BROWSER_IDS.contains(&id)),
        HandlerFilter::Any => true,
    };
    if !eligible {
        return None;
    }
    let path = application.path.clone();
    if !applications.iter().any(|current| current.path == path) {
        application.icon = application_icon(&path);
        applications.push(application);
    }
    Some(path)
}

fn add_known(workspace: &NSWorkspace, applications: &mut Vec<Application>, identifiers: &[&str]) {
    for identifier in identifiers {
        if let Some(url) =
            workspace.URLForApplicationWithBundleIdentifier(&NSString::from_str(identifier))
        {
            add_url(applications, &url, HandlerFilter::Any);
        }
    }
}

fn add_default_handler(
    applications: &mut Vec<Application>,
    url: &NSURL,
    filter: HandlerFilter,
) -> Option<String> {
    // The current HTTPS association is an explicit system choice, including
    // browsers outside the curated suggestions. The bundle must still be valid.
    let filter = match filter {
        HandlerFilter::Browser => HandlerFilter::Any,
        other => other,
    };
    add_url(applications, url, filter)
}

fn add_handlers(
    workspace: &NSWorkspace,
    url: &NSURL,
    applications: &mut Vec<Application>,
    filter: HandlerFilter,
) -> Option<String> {
    // All-handler enumeration arrived in macOS 12; the default-handler query is
    // available since 10.6. Known installed bundles supplement the older result.
    if workspace.respondsToSelector(sel!(URLsForApplicationsToOpenURL:)) {
        for application in workspace.URLsForApplicationsToOpenURL(url) {
            add_url(applications, &application, filter);
        }
    }
    workspace
        .URLForApplicationToOpenURL(url)
        .and_then(|application| add_default_handler(applications, &application, filter))
}

pub fn discover() -> Result<ApplicationCatalog, String> {
    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let mut catalog = ApplicationCatalog::default();
        for (kind, applications, extensions, filter) in [
            (
                "terminal",
                &mut catalog.terminal,
                &["command"][..],
                HandlerFilter::Terminal,
            ),
            (
                "editor",
                &mut catalog.editor,
                &["swift", "rs"][..],
                HandlerFilter::Editor,
            ),
        ] {
            for extension in extensions {
                // NSWorkspace requires file URLs to exist. These private empty
                // files provide content types by extension and are never opened.
                let probe = tempfile::Builder::new()
                    .prefix("silo-application-discovery-")
                    .suffix(&format!(".{extension}"))
                    .tempfile()
                    .map_err(|error| format!("Could not prepare application discovery: {error}"))?;
                let path = probe
                    .path()
                    .to_str()
                    .ok_or("The temporary application discovery path is invalid")?;
                let url = NSURL::fileURLWithPath(&NSString::from_str(path));
                if let Some(path) = add_handlers(&workspace, &url, applications, filter) {
                    catalog.defaults.entry(kind.into()).or_insert(path);
                }
            }
        }
        add_known(&workspace, &mut catalog.terminal, TERMINAL_IDS);
        add_known(&workspace, &mut catalog.editor, EDITOR_IDS);
        // Querying URL handlers does not open the URL or launch an application.
        let https = NSURL::URLWithString(&NSString::from_str("https://example.invalid"))
            .ok_or("macOS could not construct an HTTPS handler query")?;
        if let Some(path) = add_handlers(
            &workspace,
            &https,
            &mut catalog.browser,
            HandlerFilter::Browser,
        ) {
            catalog.defaults.insert("browser".into(), path);
        }
        add_known(&workspace, &mut catalog.browser, BROWSER_IDS);
        Ok(catalog)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(root: &Path, name: &str, package: &str, executable: bool) -> std::path::PathBuf {
        let path = root.join(format!("{name}.app"));
        fs::create_dir_all(path.join("Contents/MacOS")).unwrap();
        fs::write(path.join("Contents/Info.plist"), format!(r#"<?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0"><dict>
              <key>CFBundlePackageType</key><string>{package}</string>
              <key>CFBundleExecutable</key><string>fixture</string>
              <key>CFBundleIdentifier</key><string>org.silo.tests.{name}</string>
              <key>CFBundleDisplayName</key><string>  Display {name}  </string>
              <key>CFBundleName</key><string>Fallback</string>
              <key>CFBundleDevelopmentRegion</key><string>en</string>
            </dict></plist>"#)).unwrap();
        if executable {
            let binary = path.join("Contents/MacOS/fixture");
            fs::write(&binary, "#!/bin/sh\nexit 99\n").unwrap();
            fs::set_permissions(binary, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[test]
    fn chosen_application_uses_bundle_name_without_a_known_category_identifier() {
        let directory = tempfile::tempdir().unwrap();
        let path = bundle(directory.path(), "Custom", "APPL", true);
        let application = application_at(&path).unwrap();
        assert_eq!(application.name, "Display Custom");
        assert_eq!(
            application.path,
            fs::canonicalize(path).unwrap().to_str().unwrap()
        );
        assert!(application
            .icon
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    #[test]
    fn thumbnail_is_a_bounded_png_and_restores_the_worker_context() {
        autoreleasepool(|_| {
            let source = unsafe {
                NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                    NSBitmapImageRep::alloc(), std::ptr::null_mut(), 128, 128, 8, 4,
                    true, false, NSDeviceRGBColorSpace, 128 * 4, 32,
                )
            }.unwrap();
            // The allocated non-planar RGBA bitmap owns exactly these bytes.
            unsafe {
                source.bitmapData().write_bytes(255, 128 * 128 * 4);
            }
            let image = NSImage::initWithSize(NSImage::alloc(), NSSize::new(128.0, 128.0));
            image.addRepresentation(&source);
            let before = NSGraphicsContext::currentContext();
            let png = thumbnail_png(&image).unwrap();
            assert_eq!(NSGraphicsContext::currentContext(), before);
            assert!(png.length() <= 64 * 1024);
            let decoded = tauri::image::Image::from_bytes(&png.to_vec()).unwrap();
            assert_eq!((decoded.width(), decoded.height()), (64, 64));
            assert!(decoded.rgba().iter().all(|component| *component == 255));
        });
    }

    #[test]
    fn https_handlers_do_not_make_helpers_or_terminals_browser_choices() {
        autoreleasepool(|_| {
            let directory = tempfile::tempdir().unwrap();
            for (name, identifier, expected) in [
                ("Browser", "com.apple.Safari", true),
                ("Terminal", "com.googlecode.iterm2", false),
                ("Chat", "com.openai.codex", false),
                ("Downloader", "org.freedownloadmanager.fdm6", false),
                ("VirtualMachine", "com.parallels.desktop.console", false),
                ("Other", "org.silo.tests.Other", false),
            ] {
                let path = bundle(directory.path(), name, "APPL", true);
                let info = path.join("Contents/Info.plist");
                let contents = fs::read_to_string(&info).unwrap()
                    .replace(&format!("org.silo.tests.{name}"), identifier)
                    .replace("</dict></plist>", r#"
                        <key>CFBundleURLTypes</key><array><dict>
                        <key>CFBundleURLSchemes</key><array><string>http</string><string>https</string></array>
                        </dict></array></dict></plist>"#);
                fs::write(info, contents).unwrap();
                let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
                assert_eq!(
                    add_url(&mut Vec::new(), &url, HandlerFilter::Browser).is_some(),
                    expected,
                    "{name}"
                );
                assert!(
                    application_at(&path).is_some(),
                    "explicit choices remain valid: {name}"
                );
            }
        });
    }

    #[test]
    fn current_browser_default_is_preserved_outside_the_suggested_browser_list() {
        autoreleasepool(|_| {
            let directory = tempfile::tempdir().unwrap();
            let path = bundle(directory.path(), "UnlistedBrowser", "APPL", true);
            let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
            let mut browsers = Vec::new();
            assert!(add_url(&mut browsers, &url, HandlerFilter::Browser).is_none());
            let default = add_default_handler(&mut browsers, &url, HandlerFilter::Browser).unwrap();
            assert_eq!(browsers.len(), 1);
            assert_eq!(browsers[0].path, default);
            assert_eq!(browsers[0].name, "Display UnlistedBrowser");
            assert!(browsers[0]
                .icon
                .as_deref()
                .unwrap()
                .starts_with("data:image/png;base64,"));
            assert!(add_default_handler(&mut Vec::new(), &url, HandlerFilter::Terminal).is_none());
        });
    }

    #[test]
    fn rejects_stale_non_application_and_non_executable_bundles() {
        let directory = tempfile::tempdir().unwrap();
        assert!(application_at(&directory.path().join("Missing.app")).is_none());
        assert!(application_at(directory.path()).is_none());
        assert!(application_at(&bundle(directory.path(), "Framework", "FMWK", true)).is_none());
        assert!(application_at(&bundle(directory.path(), "NoExecutable", "APPL", false)).is_none());
        let path = bundle(directory.path(), "NotExecutable", "APPL", true);
        fs::set_permissions(
            path.join("Contents/MacOS/fixture"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(application_at(&path).is_none());
    }

    #[test]
    fn alias_selection_resolves_to_the_same_application_path() {
        let directory = tempfile::tempdir().unwrap();
        let path = bundle(directory.path(), "Target", "APPL", true);
        let alias = directory.path().join("Alias.app");
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        assert_eq!(
            application_at(&path).unwrap().path,
            application_at(&alias).unwrap().path
        );
    }

    #[test]
    fn localized_name_precedes_unlocalized_display_name() {
        let directory = tempfile::tempdir().unwrap();
        let path = bundle(directory.path(), "Localized", "APPL", true);
        let resources = path.join("Contents/Resources/en.lproj");
        fs::create_dir_all(&resources).unwrap();
        fs::write(
            resources.join("InfoPlist.strings"),
            r#""CFBundleName" = "Localized application";"#,
        )
        .unwrap();
        assert_eq!(application_at(&path).unwrap().name, "Localized application");
    }

    #[test]
    fn shell_script_handlers_do_not_make_editors_terminal_choices() {
        autoreleasepool(|_| {
            let directory = tempfile::tempdir().unwrap();
            let path = bundle(directory.path(), "Editor", "APPL", true);
            let info = path.join("Contents/Info.plist");
            let contents = fs::read_to_string(&info)
                .unwrap()
                .replace("org.silo.tests.Editor", "com.microsoft.VSCode");
            fs::write(info, contents).unwrap();
            let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
            let mut terminals = Vec::new();
            assert!(add_url(&mut terminals, &url, HandlerFilter::Terminal).is_none());
            assert!(terminals.is_empty());
            let mut editors = Vec::new();
            assert!(add_url(&mut editors, &url, HandlerFilter::Editor).is_some());
            assert_eq!(editors.len(), 1);
        });
    }

    #[test]
    fn editor_discovery_rejects_generic_handlers_viewers_and_terminals() {
        autoreleasepool(|_| {
            let directory = tempfile::tempdir().unwrap();
            for (name, role, key, value, identifier, expected) in [
                (
                    "GenericText",
                    "Editor",
                    "LSItemContentTypes",
                    "public.text",
                    "org.silo.tests.GenericText",
                    false,
                ),
                (
                    "GenericData",
                    "Editor",
                    "LSItemContentTypes",
                    "public.data",
                    "org.silo.tests.GenericData",
                    false,
                ),
                (
                    "SourceViewer",
                    "Viewer",
                    "LSItemContentTypes",
                    "public.source-code",
                    "org.silo.tests.SourceViewer",
                    false,
                ),
                (
                    "VideoEditor",
                    "Editor",
                    "CFBundleTypeExtensions",
                    "ts",
                    "org.silo.tests.VideoEditor",
                    false,
                ),
                (
                    "SourceType",
                    "Editor",
                    "LSItemContentTypes",
                    "public.source-code",
                    "org.silo.tests.SourceType",
                    true,
                ),
                (
                    "SourceExtension",
                    "Editor",
                    "CFBundleTypeExtensions",
                    "rs",
                    "org.silo.tests.SourceExtension",
                    true,
                ),
                (
                    "Terminal",
                    "Editor",
                    "LSItemContentTypes",
                    "public.source-code",
                    "dev.warp.Warp-Stable",
                    false,
                ),
            ] {
                let path = bundle(directory.path(), name, "APPL", true);
                let info = path.join("Contents/Info.plist");
                let contents = fs::read_to_string(&info)
                    .unwrap()
                    .replace(&format!("org.silo.tests.{name}"), identifier)
                    .replace(
                        "</dict></plist>",
                        &format!(
                            r#"
                        <key>CFBundleDocumentTypes</key><array><dict>
                        <key>CFBundleTypeRole</key><string>{role}</string>
                        <key>{key}</key><array><string>{value}</string></array>
                        </dict></array></dict></plist>"#
                        ),
                    );
                fs::write(info, contents).unwrap();
                let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
                assert_eq!(
                    add_url(&mut Vec::new(), &url, HandlerFilter::Editor).is_some(),
                    expected,
                    "{name}"
                );
                assert!(
                    application_at(&path).is_some(),
                    "explicit choices remain valid: {name}"
                );
            }
        });
    }
}
