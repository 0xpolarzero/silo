//! Resolve only Silo-owned tools. Debian's global /usr/bin belongs to the package
//! manager and must never contain, or substitute for, Silo's private Git/runtime.
use std::path::{Path, PathBuf};
use tauri::{utils::config::BundleType, AppHandle, Manager};

pub(crate) fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|_| "Silo could not locate its bundled tools.".to_string())?;
    let resources = app.path().resource_dir()
        .map_err(|_| "Silo could not locate its bundled resources.".to_string())?;
    let appimage_root = std::env::var_os("APPDIR").map(PathBuf::from);
    resolve(
        &executable,
        &resources,
        tauri::utils::platform::bundle_type(),
        appimage_root.as_deref(),
    )
}

pub(crate) fn is_packaged_linux(bundle: Option<BundleType>) -> bool {
    matches!(bundle, Some(BundleType::AppImage | BundleType::Deb | BundleType::Rpm))
}

fn resolve(
    executable: &Path,
    _resources: &Path,
    bundle: Option<BundleType>,
    appimage_root: Option<&Path>,
) -> Result<PathBuf, String> {
    match bundle {
        Some(BundleType::AppImage) => appimage_root
            .map(|root| root.join("usr/libexec/silo/tools"))
            .ok_or_else(|| "Silo could not locate its AppImage tools directory.".into()),
        Some(BundleType::Deb | BundleType::Rpm) => {
            Ok(PathBuf::from("/usr/libexec/silo/tools"))
        }
        _ => executable
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Silo could not locate its bundled tools directory.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packaged_linux_resolves_managed_tools_outside_linuxdeploy_scan_roots() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("usr/bin/silo-ui");
        let resources = root.path().join("usr/lib/Silo");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(executable.with_file_name("git"), "unrelated system Git").unwrap();
        for bundle in [BundleType::AppImage, BundleType::Deb, BundleType::Rpm] {
            let appimage_root = Path::new("/tmp/Silo.AppDir");
            let directory = resolve(&executable, &resources, Some(bundle.clone()), Some(appimage_root)).unwrap();
            let expected = if bundle == BundleType::AppImage {
                appimage_root.join("usr/libexec/silo/tools")
            } else {
                PathBuf::from("/usr/libexec/silo/tools")
            };
            assert_eq!(directory, expected);
            assert!(!directory.join("git").exists());
        }
        assert_eq!(std::fs::read(executable.with_file_name("git")).unwrap(), b"unrelated system Git");
    }
    #[test]
    fn appimage_macos_and_development_keep_their_existing_sibling_tools() {
        for bundle in [Some(BundleType::App), None] {
            assert_eq!(
                resolve(
                    Path::new("/bundle/bin/silo-ui"),
                    Path::new("/bundle/resources"),
                    bundle,
                    None,
                )
                .unwrap(),
                Path::new("/bundle/bin")
            );
        }
    }

    #[test]
    fn appimage_requires_its_runtime_root_instead_of_host_lookup() {
        let error = resolve(
            Path::new("/tmp/AppDir/usr/bin/silo-ui"),
            Path::new("/tmp/AppDir/usr/lib/Silo"),
            Some(BundleType::AppImage),
            None,
        )
        .unwrap_err();
        assert!(error.contains("AppImage tools directory"));
    }
}
