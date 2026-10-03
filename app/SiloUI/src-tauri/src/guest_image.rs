//! Bundled guest image validation and local-only import. No registry fallback.
use super::{RuntimeError, RuntimePaths, RuntimeRunner};
use flate2::read::GzDecoder;
use microsandbox_image::{Digest as ImageDigest, GlobalCache, Reference};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Write},
    path::Path,
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};

static IMPORT_LOCK: Mutex<()> = Mutex::new(());
const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuestImageManifest {
    schema_version: u8,
    #[serde(default)]
    version: String,
    architecture: String,
    pub(crate) image_reference: String,
    image_digest: String,
    archive_sha256: String,
    archive_bytes: u64,
    unpacked_bytes: u64,
}

/// The recipe version of the bundled image (for example `ubuntu-24.04-v4`), if readable.
pub(crate) fn bundled_version(directory: &Path) -> Option<String> {
    validate_directory(directory)
        .ok()
        .map(|manifest| manifest.version)
        .filter(|version| !version.is_empty())
}

#[cfg(test)]
thread_local! {
    static TEST_VERSION: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// The image version tests run against on this thread: v3 unless pinned.
#[cfg(test)]
pub(crate) fn test_version() -> Option<String> {
    Some(TEST_VERSION.with(|slot| {
        slot.borrow()
            .clone()
            .unwrap_or_else(|| "ubuntu-24.04-v3".into())
    }))
}

/// Pins the image version for the current test thread until the guard drops.
#[cfg(test)]
pub(crate) fn pin_test_version(version: &str) -> TestVersionGuard {
    let previous = TEST_VERSION.with(|slot| slot.replace(Some(version.into())));
    TestVersionGuard { previous }
}

#[cfg(test)]
pub(crate) struct TestVersionGuard {
    previous: Option<String>,
}

#[cfg(test)]
impl Drop for TestVersionGuard {
    fn drop(&mut self) {
        TEST_VERSION.with(|slot| *slot.borrow_mut() = self.previous.take());
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn open_bundle_file(path: &Path) -> Result<File, String> {
    let mut options = File::options();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| "Silo's bundled VM image is missing. Reinstall Silo and retry.")?;
    if !file
        .metadata()
        .map_err(|_| "Silo's VM image could not be read.")?
        .is_file()
    {
        return Err(
            "Silo's bundled VM image input is not a regular file. Reinstall Silo and retry.".into(),
        );
    }
    Ok(file)
}

/// Inspect bundled resources only. This never creates/imports a runtime cache.
#[cfg(test)]
pub(crate) fn validate_bundle(resource_dir: &Path) -> Result<GuestImageManifest, String> {
    validate_directory(&resource_dir.join("guest-image"))
}

#[cfg(test)]
pub(crate) fn validate_bundle_until(
    resource_dir: &Path,
    deadline: Instant,
) -> Result<GuestImageManifest, String> {
    validate_directory_until(&resource_dir.join("guest-image"), Some(deadline))
}

fn validate_directory(directory: &Path) -> Result<GuestImageManifest, String> {
    validate_directory_until(directory, None)
}

fn validate_directory_until(
    directory: &Path,
    deadline: Option<Instant>,
) -> Result<GuestImageManifest, String> {
    let (manifest, mut archive) = read_manifest(directory, deadline)?;
    hash_archive(&mut archive, &manifest, deadline)?;
    Ok(manifest)
}

fn deadline_passed(deadline: Option<Instant>) -> Result<(), String> {
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        Err("Silo's VM image check timed out. Retry checks.".to_owned())
    } else {
        Ok(())
    }
}

/// Parses and range-checks the manifest and confirms the archive is a regular
/// file of the expected length. Cheap; never reads the archive contents.
fn read_manifest(
    directory: &Path,
    deadline: Option<Instant>,
) -> Result<(GuestImageManifest, File), String> {
    deadline_passed(deadline)?;
    let file = open_bundle_file(&directory.join("manifest.json"))?;
    let mut bytes = Vec::new();
    file.take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Silo's VM image information could not be read.")?;
    if bytes.len() > 64 * 1024 {
        return Err("Silo's VM image information is invalid. Reinstall Silo.".into());
    }
    let manifest: GuestImageManifest = serde_json::from_slice(&bytes)
        .map_err(|_| "Silo's VM image information is invalid. Reinstall Silo.")?;
    if manifest.schema_version != 1 || manifest.architecture != std::env::consts::ARCH {
        return Err("Silo's bundled VM image does not support this device. Install the matching Silo build.".into());
    }
    if !valid_sha256(&manifest.archive_sha256)
        || !manifest
            .image_digest
            .strip_prefix("sha256:")
            .is_some_and(valid_sha256)
        || manifest.image_reference.parse::<Reference>().is_err()
        || manifest.archive_bytes == 0
        || manifest.archive_bytes > MAX_ARCHIVE_BYTES
        || manifest.unpacked_bytes == 0
        || manifest.unpacked_bytes > MAX_UNPACKED_BYTES
    {
        return Err("Silo's VM image information is invalid. Reinstall Silo.".into());
    }
    let archive = open_bundle_file(&directory.join("image.tar.gz"))?;
    if archive
        .metadata()
        .map_err(|_| "Silo's VM image could not be read.")?
        .len()
        != manifest.archive_bytes
    {
        return Err("Silo's bundled VM image is incomplete. Reinstall Silo and retry.".into());
    }
    Ok((manifest, archive))
}

fn hash_archive(
    archive: &mut File,
    manifest: &GuestImageManifest,
    deadline: Option<Instant>,
) -> Result<(), String> {
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        deadline_passed(deadline)?;
        let count = archive
            .read(&mut buffer)
            .map_err(|_| "Silo's VM image could not be read.")?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    deadline_passed(deadline)?;
    if format!("{:x}", hash.finalize()) != manifest.archive_sha256 {
        return Err(
            "Silo's bundled VM image failed its integrity check. Reinstall Silo and retry.".into(),
        );
    }
    Ok(())
}

/// Identity of the archive a full verification covered: any replacement or
/// edit moves at least one field.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ArchiveStamp {
    path: std::path::PathBuf,
    len: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed: (i64, i64),
    sha256: String,
}

fn archive_stamp(path: &Path, file: &File, manifest: &GuestImageManifest) -> Option<ArchiveStamp> {
    let metadata = file.metadata().ok()?;
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Some(ArchiveStamp {
        path: path.to_path_buf(),
        len: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
        #[cfg(unix)]
        changed: (metadata.ctime(), metadata.ctime_nsec()),
        sha256: manifest.archive_sha256.clone(),
    })
}

enum Verification {
    Running,
    Done(Result<(), String>),
}

/// Full-hash verification of each bundled archive in this process, replaced
/// when the archive's stamp moves.
static VERIFIED: Mutex<Option<HashMap<std::path::PathBuf, (ArchiveStamp, Verification)>>> =
    Mutex::new(None);
static VERIFIED_CHANGED: Condvar = Condvar::new();

#[cfg(test)]
static HASHED: Mutex<Vec<std::path::PathBuf>> = Mutex::new(Vec::new());

/// Like `validate_bundle_until`, but hashes the archive once per process
/// (and again only if its stamp changes). The hash runs on a background
/// thread that outlives a timed-out check, so a retry waits on the same work
/// instead of restarting it. Preparing the image for use still re-hashes.
pub(crate) fn validate_bundle_cached(
    resource_dir: &Path,
    deadline: Instant,
) -> Result<GuestImageManifest, String> {
    let directory = resource_dir.join("guest-image");
    let (manifest, archive) = read_manifest(&directory, Some(deadline))?;
    let archive_path = directory.join("image.tar.gz");
    let Some(stamp) = archive_stamp(&archive_path, &archive, &manifest) else {
        return Err("Silo's VM image could not be read.".into());
    };
    let mut guard = VERIFIED.lock().unwrap_or_else(|error| error.into_inner());
    if guard
        .get_or_insert_default()
        .get(&archive_path)
        .is_none_or(|(known, _)| *known != stamp)
    {
        guard
            .get_or_insert_default()
            .insert(archive_path.clone(), (stamp.clone(), Verification::Running));
        let worker_manifest = manifest.clone();
        let worker_stamp = stamp.clone();
        std::thread::spawn(move || {
            let mut archive = archive;
            #[cfg(test)]
            HASHED
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(worker_stamp.path.clone());
            let result = hash_archive(&mut archive, &worker_manifest, None);
            let mut guard = VERIFIED.lock().unwrap_or_else(|error| error.into_inner());
            if let Some((known, state)) = guard.get_or_insert_default().get_mut(&worker_stamp.path)
            {
                if *known == worker_stamp {
                    *state = Verification::Done(result);
                }
            }
            VERIFIED_CHANGED.notify_all();
        });
    }
    loop {
        match guard.get_or_insert_default().get(&archive_path) {
            Some((known, Verification::Done(result))) if *known == stamp => {
                return result.clone().map(|()| manifest);
            }
            Some((known, _)) if *known != stamp => {
                return Err("Silo's VM image changed during the check. Retry checks.".into());
            }
            _ => {}
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Err("Silo's VM image check timed out. Retry checks.".into());
        };
        guard = VERIFIED_CHANGED
            .wait_timeout(guard, remaining)
            .unwrap_or_else(|error| error.into_inner())
            .0;
    }
}

fn cached(cache: &GlobalCache, manifest: &GuestImageManifest) -> bool {
    let Ok(reference) = manifest.image_reference.parse::<Reference>() else {
        return false;
    };
    let Ok(Some(metadata)) = cache.read_image_metadata(&reference) else {
        return false;
    };
    if metadata.config_digest != manifest.image_digest {
        return false;
    }
    let Ok(digest) = metadata.manifest_digest.parse::<ImageDigest>() else {
        return false;
    };
    let Ok(layers) = metadata
        .layers
        .iter()
        .map(|layer| layer.diff_id.parse::<ImageDigest>())
        .collect::<Result<Vec<_>, _>>()
    else {
        return false;
    };
    cache.is_fsmeta_materialized(&digest)
        && cache.is_vmdk_materialized(&digest)
        && cache.all_layers_materialized(&layers)
}

fn check_space(directory: &Path, required: u64) -> Result<(), String> {
    let path = std::ffi::CString::new(directory.as_os_str().as_encoded_bytes())
        .map_err(|_| "Invalid VM image storage location.")?;
    let mut statistics = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(path.as_ptr(), statistics.as_mut_ptr()) } != 0 {
        return Err("Silo could not check free disk space for its VM image. Check storage access and retry.".into());
    }
    let statistics = unsafe { statistics.assume_init() };
    let available = (statistics.f_bavail as u64).saturating_mul(statistics.f_frsize as u64);
    if available < required {
        return Err(format!(
            "Free at least {} MiB to prepare Silo's bundled VM image, then retry.",
            required.div_ceil(1024 * 1024)
        ));
    }
    Ok(())
}

fn unpack(archive: &Path, output: &mut File, expected_bytes: u64) -> Result<(), String> {
    let input = open_bundle_file(archive)?;
    let mut decoder = GzDecoder::new(input).take(expected_bytes + 1);
    let written = std::io::copy(&mut decoder, output).map_err(|_| {
        "Silo's bundled VM image could not be unpacked. Check disk space and retry."
    })?;
    if written != expected_bytes {
        return Err("Silo's bundled VM image has an invalid unpacked size. Reinstall Silo.".into());
    }
    output
        .flush()
        .map_err(|_| "Silo's unpacked VM image could not be saved. Check disk space and retry.")?;
    Ok(())
}

/// Whether the bundled image is already in the runtime's image cache. Reads the manifest and
/// the cache metadata only.
pub(crate) fn is_imported(paths: &RuntimePaths) -> bool {
    let Ok((manifest, _)) = read_manifest(&paths.guest_image, None) else {
        return false;
    };
    GlobalCache::new(&paths.home.join("cache")).is_ok_and(|cache| cached(&cache, &manifest))
}

pub(crate) fn prepare<R: RuntimeRunner + ?Sized>(
    runner: &R,
    paths: &RuntimePaths,
) -> Result<String, RuntimeError> {
    let _lock = IMPORT_LOCK.lock().map_err(|_| {
        RuntimeError::Unavailable(
            "VM image preparation is unavailable. Restart Silo and retry.".into(),
        )
    })?;
    let (manifest, mut bundled) =
        read_manifest(&paths.guest_image, None).map_err(RuntimeError::Unavailable)?;
    let cache = GlobalCache::new(&paths.home.join("cache")).map_err(|_| {
        RuntimeError::Unavailable(
            "Silo's VM image storage could not be opened. Check storage access and retry.".into(),
        )
    })?;
    // An image already in the cache is not read from the bundle again, so the bundled
    // archive is only hashed when it is about to be imported.
    if cached(&cache, &manifest) {
        return Ok(manifest.image_reference);
    }
    hash_archive(&mut bundled, &manifest, None).map_err(RuntimeError::Unavailable)?;
    // Tar staging plus uncompressed layers and materialized filesystem data. This
    // is temporary import space, not a minimum capacity imposed on each computer.
    check_space(cache.tmp_dir(), manifest.unpacked_bytes.saturating_mul(4))
        .map_err(RuntimeError::Unavailable)?;
    let mut archive = tempfile::NamedTempFile::new_in(cache.tmp_dir()).map_err(|_| {
        RuntimeError::Unavailable("Silo could not prepare temporary VM image storage.".into())
    })?;
    unpack(
        &paths.guest_image.join("image.tar.gz"),
        archive.as_file_mut(),
        manifest.unpacked_bytes,
    )
    .map_err(RuntimeError::Unavailable)?;
    runner
        .run(
            paths,
            &[
                "image".into(),
                "load".into(),
                "--input".into(),
                archive.path().to_string_lossy().into_owned(),
                "--tag".into(),
                manifest.image_reference.clone(),
                "--quiet".into(),
            ],
            Duration::from_secs(300),
        )
        .map_err(|_| {
            RuntimeError::Unavailable(
                "Silo could not prepare its bundled VM image. Check disk space and retry.".into(),
            )
        })?;
    if !cached(&cache, &manifest) {
        return Err(RuntimeError::Unavailable(
            "The imported VM image did not pass verification. Retry image preparation.".into(),
        ));
    }
    Ok(manifest.image_reference)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use serde_json::json;
    use std::fs;

    fn fixture(directory: &Path) -> serde_json::Value {
        fs::create_dir_all(directory.join("guest-image")).unwrap();
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(b"test archive").unwrap();
        let archive = encoder.finish().unwrap();
        fs::write(directory.join("guest-image/image.tar.gz"), &archive).unwrap();
        let manifest = json!({"schemaVersion":1,"architecture":std::env::consts::ARCH,
            "imageReference":"ghcr.io/0xpolarzero/silo-guest:test", "imageDigest":format!("sha256:{}", "a".repeat(64)),
            "archiveSha256":format!("{:x}",Sha256::digest(&archive)),"archiveBytes":archive.len(),"unpackedBytes":12});
        fs::write(
            directory.join("guest-image/manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        manifest
    }
    #[test]
    fn bundled_version_reads_the_recipe_version_when_present() {
        let dir = tempfile::tempdir().unwrap();
        let mut manifest = fixture(dir.path());
        assert_eq!(bundled_version(&dir.path().join("guest-image")), None);
        manifest["version"] = json!("ubuntu-24.04-v4");
        fs::write(
            dir.path().join("guest-image/manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert_eq!(
            bundled_version(&dir.path().join("guest-image")).as_deref(),
            Some("ubuntu-24.04-v4")
        );
        assert_eq!(bundled_version(&dir.path().join("missing")), None);
    }
    #[test]
    fn bundle_preflight_is_read_only_and_rejects_corruption() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        assert!(validate_bundle(dir.path()).is_ok());
        assert!(!dir.path().join("cache").exists());
        fs::write(dir.path().join("guest-image/image.tar.gz"), b"corrupt").unwrap();
        assert!(validate_bundle(dir.path())
            .unwrap_err()
            .contains("incomplete"));
    }
    #[test]
    fn preflight_stops_validating_when_its_collection_deadline_expires() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let error = validate_bundle_until(dir.path(), std::time::Instant::now()).unwrap_err();
        assert!(error.contains("timed out"), "{error}");
        assert!(validate_bundle(dir.path()).is_ok());
    }

    #[test]
    fn cached_validation_hashes_once_and_detects_a_changed_archive() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let archive = dir.path().join("guest-image/image.tar.gz");
        let hashes = || {
            HASHED
                .lock()
                .unwrap()
                .iter()
                .filter(|path| **path == archive)
                .count()
        };
        let later = || Instant::now() + Duration::from_secs(30);
        assert!(validate_bundle_cached(dir.path(), later()).is_ok());
        assert!(validate_bundle_cached(dir.path(), later()).is_ok());
        assert_eq!(hashes(), 1);
        // Same length, different content.
        let mut bytes = fs::read(&archive).unwrap();
        *bytes.last_mut().unwrap() ^= 0xff;
        fs::write(&archive, bytes).unwrap();
        let error = validate_bundle_cached(dir.path(), later()).unwrap_err();
        assert!(error.contains("integrity"), "{error}");
        assert_eq!(hashes(), 2);
        assert!(validate_bundle_cached(dir.path(), later())
            .unwrap_err()
            .contains("integrity"));
        assert_eq!(hashes(), 2);
    }

    #[test]
    fn cached_validation_honours_its_deadline() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let error = validate_bundle_cached(dir.path(), Instant::now()).unwrap_err();
        assert!(error.contains("timed out"), "{error}");
    }

    #[test]
    fn nested_image_version_guards_restore_the_outer_fixture() {
        let original = test_version();
        {
            let _outer = pin_test_version("ubuntu-24.04-v4");
            {
                let _inner = pin_test_version("ubuntu-24.04-v3");
                assert_eq!(test_version().as_deref(), Some("ubuntu-24.04-v3"));
            }
            assert_eq!(test_version().as_deref(), Some("ubuntu-24.04-v4"));
        }
        assert_eq!(test_version(), original);
    }

    #[test]
    fn missing_and_wrong_architecture_never_pass() {
        let dir = tempfile::tempdir().unwrap();
        assert!(validate_bundle(dir.path()).is_err());
        let mut manifest = fixture(dir.path());
        manifest["architecture"] = json!("other");
        fs::write(
            dir.path().join("guest-image/manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(validate_bundle(dir.path())
            .unwrap_err()
            .contains("does not support"));
    }
    #[test]
    fn decompression_checks_exact_size_and_removes_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let mut output = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        let path = output.path().to_owned();
        assert!(unpack(
            &dir.path().join("guest-image/image.tar.gz"),
            output.as_file_mut(),
            11
        )
        .is_err());
        drop(output);
        assert!(!path.exists());
        let mut output = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        unpack(
            &dir.path().join("guest-image/image.tar.gz"),
            output.as_file_mut(),
            12,
        )
        .unwrap();
    }
    #[test]
    fn failed_import_is_not_successful_and_retry_reimports() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct FailingImporter(AtomicUsize);
        impl RuntimeRunner for FailingImporter {
            fn run(
                &self,
                _paths: &RuntimePaths,
                args: &[String],
                _timeout: Duration,
            ) -> Result<super::super::CommandOutput, RuntimeError> {
                assert_eq!(&args[..2], ["image", "load"]);
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(RuntimeError::Unavailable("interrupted".into()))
            }
        }
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let paths = RuntimePaths {
            guest_image: dir.path().join("guest-image"),
            executable: dir.path().join("msb"),
            home: dir.path().join("home"),
            storage_home: None,
            library: dir.path().join("lib"),
            metadata: dir.path().join("metadata"),
            volumes: dir.path().join("volumes"),
        };
        let runner = FailingImporter(AtomicUsize::new(0));
        for _ in 0..2 {
            assert!(prepare(&runner, &paths)
                .unwrap_err()
                .to_string()
                .contains("could not prepare"));
            assert_eq!(
                fs::read_dir(paths.home.join("cache/tmp")).unwrap().count(),
                0
            );
        }
        assert_eq!(runner.0.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn an_uncached_image_is_not_imported_and_a_tampered_bundle_is_never_loaded() {
        struct Unreachable;
        impl RuntimeRunner for Unreachable {
            fn run(
                &self,
                _: &RuntimePaths,
                _: &[String],
                _: Duration,
            ) -> Result<super::super::CommandOutput, RuntimeError> {
                panic!("a bundle that fails its checksum must not be imported");
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let mut manifest = fixture(dir.path());
        let paths = RuntimePaths {
            guest_image: dir.path().join("guest-image"),
            executable: dir.path().join("msb"),
            home: dir.path().join("home"),
            storage_home: None,
            library: dir.path().join("lib"),
            metadata: dir.path().join("metadata"),
            volumes: dir.path().join("volumes"),
        };
        assert!(!is_imported(&paths));
        manifest["archiveSha256"] = json!("b".repeat(64));
        fs::write(
            dir.path().join("guest-image/manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(prepare(&Unreachable, &paths)
            .unwrap_err()
            .to_string()
            .contains("integrity"));
    }

    #[test]
    fn insufficient_space_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(check_space(dir.path(), u64::MAX)
            .unwrap_err()
            .contains("Free at least"));
    }

    #[test]
    #[ignore = "requires signed bundled msb, hypervisor access and staged guest image"]
    fn live_bundled_image_import_and_cache_reuse() {
        crate::test_support::live::require_confirmation();
        use super::super::{CommandOutput, ProcessRunner};
        struct NoImport;
        impl RuntimeRunner for NoImport {
            fn run(
                &self,
                _: &RuntimePaths,
                _: &[String],
                _: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                panic!("A verified cached image must not be imported again");
            }
        }
        let directory = tempfile::Builder::new()
            .prefix("silo-image-live-")
            .tempdir_in(crate::test_support::live::temp_root())
            .unwrap();
        let paths = RuntimePaths {
            guest_image: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("runtime/guest-image"),
            executable: std::env::var("SILO_TEST_MSB")
                .expect("set SILO_TEST_MSB")
                .into(),
            library: std::env::var("SILO_TEST_LIBKRUNFW")
                .expect("set SILO_TEST_LIBKRUNFW")
                .into(),
            home: directory.path().join("msb"),
            storage_home: None,
            metadata: directory.path().join("computers.json"),
            volumes: directory.path().join("volumes"),
        };
        struct CountingImporter(std::sync::atomic::AtomicUsize);
        impl RuntimeRunner for CountingImporter {
            fn run(
                &self,
                paths: &RuntimePaths,
                args: &[String],
                timeout: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ProcessRunner.run(paths, args, timeout)
            }
        }
        let runner = CountingImporter(std::sync::atomic::AtomicUsize::new(0));
        let image = std::thread::scope(|scope| {
            let first = scope.spawn(|| prepare(&runner, &paths));
            let second = scope.spawn(|| prepare(&runner, &paths));
            let image = first.join().unwrap().unwrap();
            assert_eq!(second.join().unwrap().unwrap(), image);
            image
        });
        assert_eq!(runner.0.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(prepare(&NoImport, &paths).unwrap(), image);
        assert_eq!(
            fs::read_dir(paths.home.join("cache/tmp")).unwrap().count(),
            0
        );
        let cache = GlobalCache::new(&paths.home.join("cache")).unwrap();
        assert!(cached(
            &cache,
            &validate_directory(&paths.guest_image).unwrap()
        ));
    }
}
