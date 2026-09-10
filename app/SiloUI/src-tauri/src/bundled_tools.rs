//! Resolve only Silo-owned tools. Debian's global /usr/bin belongs to the package
//! manager and must never contain, or substitute for, Silo's private Git/runtime.
use std::path::{Path, PathBuf};
use tauri::{utils::config::BundleType, AppHandle, Manager};

pub(crate) fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|_| "Silo could not locate its bundled tools.".to_string())?;
    let resources = app.path().resource_dir()
        .map_err(|_| "Silo could not locate its bundled resources.".to_string())?;
    resolve(&executable, &resources, tauri::utils::platform::bundle_type())
}

fn resolve(executable: &Path, resources: &Path, bundle: Option<BundleType>) -> Result<PathBuf, String> {
    if matches!(bundle, Some(BundleType::Deb)) {
        // This marker is patched into the executable by Tauri when making the
        // package. Never infer Debian from PATH, a filename or missing sidecars.
        Ok(resources.join("bin"))
    } else {
        executable.parent().map(Path::to_path_buf)
            .ok_or_else(|| "Silo could not locate its bundled tools directory.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn debian_never_falls_back_to_host_tools_when_private_tools_are_missing() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("usr/bin/silo-ui");
        let resources = root.path().join("usr/lib/Silo");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(executable.with_file_name("git"), "unrelated system Git").unwrap();
        let directory = resolve(&executable, &resources, Some(BundleType::Deb)).unwrap();
        assert_eq!(directory, resources.join("bin"));
        assert!(!directory.join("git").exists());
        assert_eq!(std::fs::read(executable.with_file_name("git")).unwrap(), b"unrelated system Git");
    }
    #[test]
    fn appimage_macos_and_development_keep_their_existing_sibling_tools() {
        for bundle in [Some(BundleType::AppImage), Some(BundleType::App), None] {
            assert_eq!(resolve(Path::new("/bundle/bin/silo-ui"), Path::new("/bundle/resources"), bundle).unwrap(), Path::new("/bundle/bin"));
        }
    }
}
