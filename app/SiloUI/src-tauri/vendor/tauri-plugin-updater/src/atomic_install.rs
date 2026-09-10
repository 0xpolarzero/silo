// Copyright 2026 Silo contributors
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Stage on the destination filesystem. The installed path always names a whole
// old or new application, including if the process exits during replacement.
use std::{fs, io, path::Path};
use crate::{Error, Result};

fn parent(path: &Path) -> io::Result<&Path> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Refusing to replace a symlink"));
    }
    path.parent().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Missing install directory"))
}

#[cfg(target_os = "linux")]
pub(crate) fn appimage(destination: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let directory = parent(destination)?;
    let staged = tempfile::Builder::new().prefix(".tauri-update-").tempdir_in(directory)?;
    let next = staged.path().join("next.AppImage");
    #[cfg(feature = "zip")]
    if infer::archive::is_gz(bytes) {
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
        let mut found = false;
        for entry in archive.entries()? {
            let mut entry = entry?;
            if entry.path()?.extension() == Some(std::ffi::OsStr::new("AppImage")) {
                if found || !entry.header().entry_type().is_file() {
                    return Err(Error::InvalidUpdaterFormat);
                }
                entry.unpack(&next)?;
                found = true;
            }
        }
        if !found { return Err(Error::BinaryNotFoundInArchive); }
    } else {
        fs::write(&next, bytes)?;
    }
    #[cfg(not(feature = "zip"))]
    fs::write(&next, bytes)?;
    // Check the staged file, including when using the legacy archive format.
    let mut header = [0; 11];
    std::io::Read::read_exact(&mut fs::File::open(&next)?, &mut header)?;
    if &header[..4] != b"\x7fELF" || &header[8..11] != b"AI\x02" {
        return Err(Error::InvalidUpdaterFormat);
    }
    let mode = fs::metadata(destination)?.permissions().mode();
    fs::set_permissions(&next, fs::Permissions::from_mode(mode))?;
    fs::File::open(&next)?.sync_all()?;
    fs::File::open(staged.path())?.sync_all()?;
    checkpoint("prepared");
    fs::rename(&next, destination)?;
    checkpoint("replaced");
    fs::File::open(directory)?.sync_all()?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn macos(destination: &Path, bytes: &[u8]) -> Result<()> {
    use std::path::Component;
    let directory = parent(destination)?;
    let staged = tempfile::Builder::new().prefix(".tauri-update-").tempdir_in(directory)?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    let mut root = None;
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let mut components = path.components();
        let Some(Component::Normal(name)) = components.next() else {
            return Err(Error::InvalidUpdaterFormat);
        };
        if Path::new(name).extension() != Some(std::ffi::OsStr::new("app"))
            || components.any(|part| !matches!(part, Component::Normal(_) | Component::CurDir)) {
            return Err(Error::InvalidUpdaterFormat);
        }
        if root.as_ref().is_some_and(|old| old != name) {
            return Err(Error::InvalidUpdaterFormat);
        }
        root = Some(name.to_os_string());
        if !entry.unpack_in(staged.path())? { return Err(Error::InvalidUpdaterFormat); }
    }
    let next = staged.path().join(root.ok_or(Error::BinaryNotFoundInArchive)?);
    if fs::symlink_metadata(&next)?.file_type().is_symlink()
        || !next.join("Contents/Info.plist").is_file()
        || !next.join("Contents/MacOS").is_dir() {
        return Err(Error::InvalidUpdaterFormat);
    }
    sync_tree(&next)?;
    fs::File::open(staged.path())?.sync_all()?;
    checkpoint("prepared");
    swap(&next, destination)?;
    checkpoint("replaced");
    // The swap changes both directories; persist both namespace changes.
    fs::File::open(staged.path())?.sync_all()?;
    fs::File::open(directory)?.sync_all()?;
    // The temporary path now holds the old bundle. TempDir removes it only after
    // a successful swap; an interrupted process leaves recoverable old files.
    Ok(())
}

#[cfg(target_os = "macos")]
fn sync_tree(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() { return Ok(()); }
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? { sync_tree(&entry?.path())?; }
    }
    fs::File::open(path)?.sync_all()
}

#[cfg(target_os = "macos")]
fn swap(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    extern "C" { fn renamex_np(from: *const std::ffi::c_char, to: *const std::ffi::c_char, flags: u32) -> i32; }
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    // RENAME_SWAP atomically exchanges two existing paths, including directories.
    if unsafe { renamex_np(source.as_ptr(), destination.as_ptr(), 0x00000002) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn checkpoint(_stage: &str) {
    #[cfg(test)]
    if std::env::var("TAURI_TEST_INSTALL_EXIT").as_deref() == Ok(_stage) {
        std::process::exit(86);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payload() -> Vec<u8> {
        #[cfg(target_os = "linux")]
        { let mut bytes = b"\x7fELF\x02\x01\x01\x00AI\x02".to_vec(); bytes.extend_from_slice(b"new version"); bytes }
        #[cfg(target_os = "macos")]
        {
            let mut archive = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default()));
            for (name, body) in [("Silo.app/Contents/Info.plist", "new version"), ("Silo.app/Contents/MacOS/Silo", "new executable")] {
                let mut header = tar::Header::new_gnu(); header.set_size(body.len() as u64); header.set_mode(0o755); header.set_cksum();
                archive.append_data(&mut header, name, body.as_bytes()).unwrap();
            }
            archive.into_inner().unwrap().finish().unwrap()
        }
    }
    fn create_old(base: &Path) -> std::path::PathBuf {
        #[cfg(target_os = "linux")]
        { let path = base.join("Silo.AppImage"); fs::write(&path, "old version").unwrap(); path }
        #[cfg(target_os = "macos")]
        { let path = base.join("Silo.app"); fs::create_dir_all(path.join("Contents")).unwrap(); fs::write(path.join("Contents/Info.plist"), "old version").unwrap(); path }
    }
    fn installed(path: &Path) -> Vec<u8> {
        #[cfg(target_os = "linux")]
        { fs::read(path).unwrap() }
        #[cfg(target_os = "macos")]
        { fs::read(path.join("Contents/Info.plist")).unwrap() }
    }
    fn install(path: &Path, bytes: &[u8]) -> Result<()> {
        #[cfg(target_os = "linux")]
        { appimage(path, bytes) }
        #[cfg(target_os = "macos")]
        { macos(path, bytes) }
    }
    #[test]
    fn malformed_payload_preserves_installed_app() {
        let temp = tempfile::tempdir().unwrap(); let path = create_old(temp.path());
        assert!(install(&path, b"broken signed payload").is_err());
        assert_eq!(installed(&path), b"old version");
    }
    #[test]
    fn install_rejects_symlink_destination() {
        let temp = tempfile::tempdir().unwrap(); let path = create_old(temp.path());
        let alias = temp.path().join("alias"); std::os::unix::fs::symlink(&path, &alias).unwrap();
        assert!(install(&alias, &payload()).is_err()); assert_eq!(installed(&path), b"old version");
    }
    #[test]
    fn child_exit_leaves_whole_old_or_new_app() {
        for stage in ["prepared", "replaced"] {
            let temp = tempfile::tempdir().unwrap(); let path = create_old(temp.path());
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "atomic_install::tests::crash_child", "--ignored"])
                .env("TAURI_TEST_INSTALL_PATH", &path).env("TAURI_TEST_INSTALL_EXIT", stage).status().unwrap();
            assert_eq!(status.code(), Some(86));
            if stage == "prepared" { assert_eq!(installed(&path), b"old version"); }
            else { assert!(String::from_utf8_lossy(&installed(&path)).contains("new version")); }
        }
    }
    #[test]
    fn successful_install_cleans_staging_and_preserves_executable_mode() {
        let temp = tempfile::tempdir().unwrap();
        let path = create_old(temp.path());
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o751)).unwrap();
        }
        install(&path, &payload()).unwrap();
        assert!(String::from_utf8_lossy(&installed(&path)).contains("new version"));
        let entries = fs::read_dir(temp.path()).unwrap().map(|e| e.unwrap().path()).collect::<Vec<_>>();
        assert_eq!(entries, vec![path.clone()]);
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o7777, 0o751);
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn invalid_archive_roots_and_traversal_preserve_app_and_siblings() {
        // Raw header names deliberately bypass tar::Builder's own traversal check,
        // so this exercises the installer's boundary, not the archive writer.
        for names in [
            vec!["Silo.app/Contents/Info.plist", "Other.app/Contents/Info.plist"],
            vec!["Silo.app/../../untouched"],
        ] {
            let temp = tempfile::tempdir().unwrap();
            let path = create_old(temp.path());
            let sibling = temp.path().join("untouched");
            fs::write(&sibling, "keep sibling").unwrap();
            let mut archive = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default()));
            for name in names {
                let mut header = tar::Header::new_gnu();
                header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
                header.set_size(3); header.set_mode(0o644); header.set_cksum();
                archive.append(&header, b"new".as_slice()).unwrap();
            }
            let bytes = archive.into_inner().unwrap().finish().unwrap();
            assert!(install(&path, &bytes).is_err());
            assert_eq!(installed(&path), b"old version");
            assert_eq!(fs::read(&sibling).unwrap(), b"keep sibling");
            assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
        }
    }
    #[test]
    #[ignore = "subprocess of crash test"]
    fn crash_child() {
        let path = std::env::var_os("TAURI_TEST_INSTALL_PATH").unwrap();
        install(Path::new(&path), &payload()).unwrap();
        panic!("checkpoint did not terminate worker");
    }
}
