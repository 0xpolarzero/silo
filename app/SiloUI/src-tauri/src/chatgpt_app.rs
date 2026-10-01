//! The pinned ChatGPT Linux app, kept once per computer for LCU.
//!
//! Silo never publishes OpenAI files. After a one-time notice this downloads the
//! exact `.deb` pinned in `guest/chatgpt-app-lock.json` from OpenAI, verifies its
//! size and SHA-256, extracts only `usr/lib/chatgpt` (never running maintainer
//! scripts) into one immutable folder per version, and publishes it atomically.
//! VMs later mount that folder read-only. See `docs/SiloUI-CHATGPT-APP.md`.
//!
//! Layout under the channel's application data directory:
//!
//! ```text
//! chatgpt/.lock                      cross-process lock (flock)
//! chatgpt/consent.json               the accepted notice
//! chatgpt/downloads/*.deb[.part]     resumable download, deleted after success
//! chatgpt/.staging-*/                extraction in progress, never mounted
//! chatgpt/<version>-<debarch>/       published, immutable app tree
//! ```
//!
//! The package is not wired into VM creation or the UI yet, so the module is
//! allowed to be unused.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

const LOCK_JSON: &str = include_str!("../guest/chatgpt-app-lock.json");
const DOWNLOAD_HOST: &str = "persistent.oaistatic.com";
/// The directory dpkg would fill, relative to the archive root.
const TREE_PREFIX: [&str; 3] = ["usr", "lib", "chatgpt"];
/// A file every real app tree has; a published folder without it is damaged.
const SENTINEL: &str = "ChatGPT";
const NOTICE_VERSION: u32 = 1;
const MAX_ENTRIES: usize = 200_000;
const MAX_UNPACKED_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const STATUS_EVENT: &str = "chatgpt-app-status";

// ----------------------------------------------------------------- lock

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Lock {
    schema_version: u32,
    pub(crate) package: String,
    pub(crate) version: String,
    pub(crate) cua_runtime_version: String,
    /// The LCU release tested with this app; filled in at integration.
    pub(crate) lcu_version: Option<String>,
    architectures: HashMap<String, Asset>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Asset {
    pub(crate) url: String,
    pub(crate) sha256: String,
    pub(crate) bytes: u64,
}

/// Debian architecture names, which equal the guest architecture on this computer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DebArch {
    Arm64,
    Amd64,
}

impl DebArch {
    pub(crate) fn host() -> Result<Self, Error> {
        match std::env::consts::ARCH {
            "aarch64" => Ok(Self::Arm64),
            "x86_64" => Ok(Self::Amd64),
            _ => Err(Error::fatal(
                "The ChatGPT app is only available for 64-bit Intel and Arm computers.",
            )),
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Arm64 => "arm64",
            Self::Amd64 => "amd64",
        }
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.starts_with(|c: char| c.is_ascii_digit())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'~' | b'-'))
}

impl Lock {
    /// The lock compiled into this build, validated.
    pub(crate) fn bundled() -> Result<Self, Error> {
        let lock: Self = serde_json::from_str(LOCK_JSON)
            .map_err(|_| Error::fatal("Silo's ChatGPT app information is invalid."))?;
        lock.validate()?;
        Ok(lock)
    }

    pub(crate) fn validate(&self) -> Result<(), Error> {
        let invalid = || Error::fatal("Silo's ChatGPT app information is invalid.");
        if self.schema_version != 1 || self.package != "chatgpt" || !valid_version(&self.version) {
            return Err(invalid());
        }
        for arch in ["arm64", "amd64"] {
            let asset = self.architectures.get(arch).ok_or_else(invalid)?;
            let url = reqwest::Url::parse(&asset.url).map_err(|_| invalid())?;
            if url.scheme() != "https"
                || url.host_str() != Some(DOWNLOAD_HOST)
                || !valid_sha256(&asset.sha256)
                || asset.bytes == 0
                || asset.bytes > 4 * 1024 * 1024 * 1024
            {
                return Err(invalid());
            }
        }
        Ok(())
    }

    pub(crate) fn asset(&self, arch: DebArch) -> Result<&Asset, Error> {
        self.architectures
            .get(arch.name())
            .ok_or_else(|| Error::fatal("Silo's ChatGPT app information is invalid."))
    }

    /// `<version>-<debarch>`: the published folder name.
    pub(crate) fn directory_name(&self, arch: DebArch) -> String {
        format!("{}-{}", self.version, arch.name())
    }
}

// --------------------------------------------------------------- status

/// What the UI shows. `Ready` carries the canonical folder to mount.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum Status {
    NotConsented,
    /// Consented, nothing present, nothing running.
    Idle,
    #[serde(rename_all = "camelCase")]
    Downloading {
        received_bytes: u64,
        total_bytes: u64,
    },
    Verifying,
    Extracting,
    #[serde(rename_all = "camelCase")]
    Ready {
        path: PathBuf,
        version: String,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        reason: String,
        retryable: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Error {
    pub(crate) message: String,
    pub(crate) retryable: bool,
    pub(crate) not_consented: bool,
}

impl Error {
    fn retry(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
            not_consented: false,
        }
    }
    fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
            not_consented: false,
        }
    }
    fn status(&self) -> Status {
        if self.not_consented {
            Status::NotConsented
        } else {
            Status::Failed {
                reason: self.message.clone(),
                retryable: self.retryable,
            }
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

// -------------------------------------------------------------- consent

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Consent {
    notice_version: u32,
    accepted_at_unix: u64,
}

fn consent_path(root: &Path) -> PathBuf {
    root.join("consent.json")
}

/// Whether the user accepted the download notice on this computer and channel.
pub(crate) fn consent_accepted(root: &Path) -> bool {
    fs::read(consent_path(root))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Consent>(&bytes).ok())
        .is_some_and(|consent| consent.notice_version == NOTICE_VERSION)
}

pub(crate) fn accept_notice(root: &Path) -> Result<(), Error> {
    private_directory(root)?;
    let consent = Consent {
        notice_version: NOTICE_VERSION,
        accepted_at_unix: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs()),
    };
    let bytes =
        serde_json::to_vec(&consent).map_err(|_| Error::fatal("Could not save consent."))?;
    let temporary = root.join(format!(".consent-{}.tmp", std::process::id()));
    let write = || -> std::io::Result<()> {
        let mut file = File::create(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, consent_path(root))
    };
    write().map_err(|_| {
        let _ = fs::remove_file(&temporary);
        Error::retry("Silo could not save your choice. Check disk access and retry.")
    })
}

// ----------------------------------------------------------------- lock

fn private_directory(path: &Path) -> Result<(), Error> {
    let failed = || Error::retry("Silo could not prepare its ChatGPT app folder.");
    fs::create_dir_all(path).map_err(|_| failed())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| failed())
}

/// An exclusive cross-process lock (also excludes other threads, since every
/// holder uses its own open file description).
struct RootLock(File);

impl RootLock {
    fn take(root: &Path) -> Result<Self, Error> {
        private_directory(root)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root.join(".lock"))
            .map_err(|_| Error::retry("Silo could not lock its ChatGPT app folder."))?;
        while unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
                return Err(Error::retry("Silo could not lock its ChatGPT app folder."));
            }
        }
        Ok(Self(file))
    }
}

impl Drop for RootLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

// ------------------------------------------------------------- download

/// Fetches `url` into `part` (resuming if the file already has a prefix) until
/// it holds `total` bytes, reporting the byte count. Tests substitute this.
pub(crate) trait Downloader {
    fn fetch(
        &self,
        url: &str,
        part: &Path,
        total: u64,
        progress: &mut dyn FnMut(u64),
    ) -> Result<(), Error>;
}

pub(crate) struct HttpDownloader {
    attempts: u32,
    backoff: Duration,
}

impl Default for HttpDownloader {
    fn default() -> Self {
        Self {
            attempts: 5,
            backoff: Duration::from_secs(2),
        }
    }
}

impl HttpDownloader {
    fn attempt(
        &self,
        client: &reqwest::blocking::Client,
        url: &str,
        part: &Path,
        total: u64,
        progress: &mut dyn FnMut(u64),
    ) -> Result<(), Error> {
        let disk = || {
            Error::retry(
                "Silo could not write the ChatGPT download. Check free disk space and retry.",
            )
        };
        let mut have = fs::metadata(part).map_or(0, |m| m.len());
        if have > total {
            fs::remove_file(part).map_err(|_| disk())?;
            have = 0;
        }
        if have == total {
            progress(have);
            return Ok(());
        }
        let mut request = client.get(url);
        if have > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={have}-"));
        }
        let mut response = request.send().map_err(|_| {
            Error::retry("Silo could not reach OpenAI to download the ChatGPT app.")
        })?;
        let status = response.status();
        let append = match status.as_u16() {
            206 => true,
            200 => false,
            416 => {
                let _ = fs::remove_file(part);
                return Err(Error::retry("The ChatGPT download restarted."));
            }
            code if (400..500).contains(&code) && code != 408 && code != 429 => {
                return Err(Error::fatal(format!(
                    "OpenAI no longer serves the pinned ChatGPT app (HTTP {code})."
                )))
            }
            code => {
                return Err(Error::retry(format!(
                    "OpenAI's server answered HTTP {code}."
                )))
            }
        };
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .mode(0o600)
            .open(part)
            .map_err(|_| disk())?;
        let mut written = if append { have } else { 0 };
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            let count = response
                .read(&mut buffer)
                .map_err(|_| Error::retry("The ChatGPT download was interrupted."))?;
            if count == 0 {
                break;
            }
            if written + count as u64 > total {
                drop(file);
                let _ = fs::remove_file(part);
                return Err(Error::retry(
                    "The ChatGPT download was larger than expected.",
                ));
            }
            file.write_all(&buffer[..count]).map_err(|_| disk())?;
            written += count as u64;
            progress(written);
        }
        file.sync_all().map_err(|_| disk())?;
        if written == total {
            Ok(())
        } else {
            Err(Error::retry("The ChatGPT download ended early."))
        }
    }
}

impl Downloader for HttpDownloader {
    fn fetch(
        &self,
        url: &str,
        part: &Path,
        total: u64,
        progress: &mut dyn FnMut(u64),
    ) -> Result<(), Error> {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            // The blocking client has no stall timeout; this bounds one attempt
            // (a 450 MB package at 250 KB/s) and a retry resumes where it stopped.
            .timeout(Duration::from_secs(30 * 60))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() < 5 && attempt.url().scheme() == "https" {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .https_only(true)
            .user_agent(concat!("Silo/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| Error::fatal("Silo could not start a secure download."))?;
        let mut last = Error::retry("The ChatGPT download failed.");
        for attempt in 0..self.attempts {
            if attempt > 0 {
                std::thread::sleep(self.backoff * 2u32.pow(attempt - 1));
            }
            match self.attempt(&client, url, part, total, progress) {
                Ok(()) => return Ok(()),
                Err(error) if error.retryable => last = error,
                Err(error) => return Err(error),
            }
        }
        Err(last)
    }
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Size, then SHA-256. A deb that fails is deleted.
fn verify_package(path: &Path, asset: &Asset) -> Result<(), Error> {
    let read = || Error::retry("Silo could not read the downloaded ChatGPT package.");
    let size = fs::metadata(path).map_err(|_| read())?.len();
    if size != asset.bytes {
        let _ = fs::remove_file(path);
        return Err(Error::retry(
            "The downloaded ChatGPT package has the wrong size and was discarded.",
        ));
    }
    if sha256_file(path).map_err(|_| read())? != asset.sha256 {
        let _ = fs::remove_file(path);
        return Err(Error::fatal(
            "The downloaded ChatGPT package does not match Silo's pinned checksum and was discarded.",
        ));
    }
    Ok(())
}

// ----------------------------------------------------------- extraction

/// The decompressed `data.tar` of a deb, produced by an established tool. It
/// never runs maintainer scripts: macOS bsdtar reads the ar container and the
/// compressed member and rewrites it as plain tar; Linux uses `dpkg-deb`.
struct TarStream {
    children: Vec<Child>,
    stdout: std::process::ChildStdout,
}

impl TarStream {
    fn open(deb: &Path) -> Result<Self, Error> {
        let missing =
            || Error::fatal("Silo could not find the system tool that unpacks .deb files.");
        if cfg!(target_os = "macos") {
            let tar = "/usr/bin/tar";
            let list = Command::new(tar)
                .arg("-tf")
                .arg(deb)
                .stderr(Stdio::null())
                .output()
                .map_err(|_| missing())?;
            let member = String::from_utf8_lossy(&list.stdout)
                .lines()
                .find(|name| name.starts_with("data.tar"))
                .map(str::to_owned)
                .ok_or_else(|| Error::fatal("The ChatGPT package has no data archive."))?;
            let mut first = Command::new(tar)
                .arg("-xOf")
                .arg(deb)
                .arg(&member)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| missing())?;
            let input = first.stdout.take().expect("piped");
            let mut second = Command::new(tar)
                .args(["-cf", "-", "@-"])
                .stdin(Stdio::from(input))
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| missing())?;
            let stdout = second.stdout.take().expect("piped");
            Ok(Self {
                children: vec![first, second],
                stdout,
            })
        } else {
            let tool = ["/usr/bin/dpkg-deb", "dpkg-deb"]
                .into_iter()
                .find(|candidate| {
                    Command::new(candidate)
                        .arg("--version")
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .is_ok()
                })
                .ok_or_else(missing)?;
            let mut child = Command::new(tool)
                .arg("--fsys-tarfile")
                .arg(deb)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| missing())?;
            let stdout = child.stdout.take().expect("piped");
            Ok(Self {
                children: vec![child],
                stdout,
            })
        }
    }

    /// Reads the rest of the stream, then requires every tool to have succeeded.
    fn finish(mut self) -> Result<(), Error> {
        let _ = std::io::copy(&mut self.stdout, &mut std::io::sink());
        let mut ok = true;
        for child in &mut self.children {
            ok &= child.wait().is_ok_and(|status| status.success());
        }
        if ok {
            Ok(())
        } else {
            Err(Error::fatal("The ChatGPT package could not be unpacked."))
        }
    }
}

impl Read for TarStream {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.stdout.read(buffer)
    }
}

impl Drop for TarStream {
    fn drop(&mut self) {
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn reject(path: &str, why: &str) -> Error {
    Error::fatal(format!(
        "The ChatGPT package was refused: {why} ({}).",
        path.chars().take(120).collect::<String>()
    ))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Directory,
    File,
    Symlink,
}

/// Path components of an entry below the app root, `None` outside the tree.
fn tree_components(raw: &[u8]) -> Result<Option<Vec<String>>, Error> {
    let text = std::str::from_utf8(raw).map_err(|_| reject("non-UTF-8 name", "invalid name"))?;
    if text.is_empty() || text.contains('\0') {
        return Err(reject(text, "empty or invalid name"));
    }
    if text.starts_with('/') {
        return Err(reject(text, "absolute path"));
    }
    let mut parts = Vec::new();
    for part in text.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(reject(text, "path with `..`")),
            other => parts.push(other),
        }
    }
    if parts.len() < TREE_PREFIX.len() || parts[..TREE_PREFIX.len()] != TREE_PREFIX {
        return Ok(None);
    }
    Ok(Some(
        parts[TREE_PREFIX.len()..]
            .iter()
            .map(|part| (*part).to_owned())
            .collect(),
    ))
}

/// A relative link target that can never leave the tree: any leading `..` stays
/// within the link's own (symlink-free) directory depth, and no `..` follows a
/// normal component (which could pass through another symlink).
fn check_link_target(target: &[u8], parent_depth: usize, path: &str) -> Result<(), Error> {
    let text = std::str::from_utf8(target).map_err(|_| reject(path, "non-UTF-8 symlink target"))?;
    if text.is_empty() || text.starts_with('/') || text.contains('\0') {
        return Err(reject(path, "absolute or empty symlink target"));
    }
    let mut up = 0usize;
    let mut normal = false;
    for part in text.split('/') {
        match part {
            "" | "." => {}
            ".." if normal => return Err(reject(path, "symlink target escapes the tree")),
            ".." => up += 1,
            _ => normal = true,
        }
    }
    if up > parent_depth {
        return Err(reject(path, "symlink target escapes the tree"));
    }
    Ok(())
}

/// Validates and writes the `usr/lib/chatgpt` entries of a tar stream into the
/// empty directory `dest`. The first violation aborts; the caller discards `dest`.
fn extract_tree(reader: impl Read, dest: &Path) -> Result<(), Error> {
    let io = |_: std::io::Error| {
        Error::retry("Silo could not write the ChatGPT app. Check free disk space and retry.")
    };
    let mut archive = tar::Archive::new(reader);
    let entries = archive
        .entries()
        .map_err(|_| Error::fatal("The ChatGPT package could not be read."))?;
    // Lower-cased relative path -> (exact path, kind).
    let mut seen: HashMap<String, (String, Kind)> = HashMap::new();
    let mut symlinks: HashSet<String> = HashSet::new();
    let mut directories: Vec<PathBuf> = Vec::new();
    let (mut count, mut unpacked) = (0usize, 0u64);
    for entry in entries {
        let mut entry =
            entry.map_err(|_| Error::fatal("The ChatGPT package could not be read."))?;
        count += 1;
        if count > MAX_ENTRIES {
            return Err(reject("archive", "too many entries"));
        }
        let raw = entry.path_bytes().into_owned();
        let Some(rel) = tree_components(&raw)? else {
            continue; // Outside usr/lib/chatgpt: never extracted.
        };
        let shown = String::from_utf8_lossy(&raw).into_owned();
        let kind = match entry.header().entry_type() {
            tar::EntryType::Regular | tar::EntryType::Continuous => Kind::File,
            tar::EntryType::Directory => Kind::Directory,
            tar::EntryType::Symlink => Kind::Symlink,
            tar::EntryType::XGlobalHeader | tar::EntryType::XHeader => continue,
            _ => return Err(reject(&shown, "hard link, device or other special file")),
        };
        let mode = entry
            .header()
            .mode()
            .map_err(|_| reject(&shown, "invalid mode"))?;
        if mode & 0o6000 != 0 {
            return Err(reject(&shown, "setuid or setgid bit"));
        }
        if rel.is_empty() {
            if kind != Kind::Directory {
                return Err(reject(&shown, "app root is not a directory"));
            }
            continue;
        }
        // Parents: must be directories we made, never symlinks, never colliding.
        let mut joined = String::new();
        for (index, part) in rel.iter().enumerate() {
            if !joined.is_empty() {
                joined.push('/');
            }
            joined.push_str(part);
            let lower = joined.to_lowercase();
            let last = index + 1 == rel.len();
            if !last && symlinks.contains(&lower) {
                return Err(reject(&shown, "path passes through a symlink"));
            }
            match seen.get(&lower) {
                Some((exact, _)) if *exact != joined => {
                    return Err(reject(&shown, "case-insensitive name collision"))
                }
                Some((_, existing)) if !last && *existing != Kind::Directory => {
                    return Err(reject(&shown, "parent is not a directory"))
                }
                Some((_, existing))
                    if last && !(*existing == Kind::Directory && kind == Kind::Directory) =>
                {
                    return Err(reject(&shown, "duplicate entry"))
                }
                Some(_) => {}
                None => {
                    let entry_kind = if last { kind } else { Kind::Directory };
                    seen.insert(lower.clone(), (joined.clone(), entry_kind));
                    if entry_kind == Kind::Symlink {
                        symlinks.insert(lower);
                    }
                }
            }
        }
        let target: PathBuf = rel
            .iter()
            .fold(dest.to_path_buf(), |path, part| path.join(part));
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(io)?;
        }
        match kind {
            Kind::Directory => match fs::create_dir(&target) {
                Ok(()) => directories.push(target),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if !fs::symlink_metadata(&target).is_ok_and(|m| m.is_dir()) {
                        return Err(reject(&shown, "name collision"));
                    }
                }
                Err(error) => return Err(io(error)),
            },
            Kind::File => {
                unpacked += entry.header().size().unwrap_or(0);
                if unpacked > MAX_UNPACKED_BYTES {
                    return Err(reject(&shown, "package is too large"));
                }
                let permissions = if mode & 0o111 != 0 { 0o755 } else { 0o644 };
                // create_new refuses an existing name, including a name the
                // filesystem folds together (case or normalization).
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(permissions)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(&target)
                    .map_err(|error| {
                        if error.kind() == std::io::ErrorKind::AlreadyExists {
                            reject(&shown, "name collision")
                        } else {
                            io(error)
                        }
                    })?;
                std::io::copy(&mut entry, &mut file).map_err(io)?;
                file.set_permissions(fs::Permissions::from_mode(permissions))
                    .map_err(io)?;
                file.sync_data().map_err(io)?;
            }
            Kind::Symlink => {
                let link = entry
                    .link_name_bytes()
                    .ok_or_else(|| reject(&shown, "symlink without a target"))?
                    .into_owned();
                check_link_target(&link, rel.len() - 1, &shown)?;
                let link = std::str::from_utf8(&link).expect("checked");
                std::os::unix::fs::symlink(link, &target).map_err(|error| {
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        reject(&shown, "name collision")
                    } else {
                        io(error)
                    }
                })?;
            }
        }
    }
    // Created directories get a fixed mode; nothing in the tree is group/world writable.
    for directory in directories.iter().rev() {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o755)).map_err(io)?;
    }
    fs::set_permissions(dest, fs::Permissions::from_mode(0o755)).map_err(io)?;
    if !fs::symlink_metadata(dest.join(SENTINEL)).is_ok_and(|m| m.is_file()) {
        return Err(reject(SENTINEL, "the package has no ChatGPT executable"));
    }
    Ok(())
}

fn sync_directory(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
}

// --------------------------------------------------------------- ensure

fn published(root: &Path, name: &str) -> Option<PathBuf> {
    let path = root.join(name);
    let meta = fs::symlink_metadata(&path).ok()?;
    (meta.is_dir() && fs::symlink_metadata(path.join(SENTINEL)).is_ok_and(|m| m.is_file()))
        .then_some(path)
}

fn clean_staging(root: &Path) {
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(".staging-") {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
}

fn throttled<'a>(mut report: impl FnMut(u64) + 'a) -> impl FnMut(u64) + 'a {
    let mut last = Instant::now() - Duration::from_secs(1);
    move |bytes| {
        if last.elapsed() >= Duration::from_millis(250) {
            last = Instant::now();
            report(bytes);
        }
    }
}

/// Makes the pinned app present under `root` and returns its canonical path.
/// Idempotent; concurrent calls (threads or processes) serialize on the root
/// lock and the later ones find the published folder.
pub(crate) fn ensure(
    root: &Path,
    lock: &Lock,
    arch: DebArch,
    downloader: &dyn Downloader,
    report: &dyn Fn(Status),
) -> Result<PathBuf, Error> {
    let result = ensure_inner(root, lock, arch, downloader, report);
    if let Err(error) = &result {
        report(error.status());
    }
    result
}

fn ensure_inner(
    root: &Path,
    lock: &Lock,
    arch: DebArch,
    downloader: &dyn Downloader,
    report: &dyn Fn(Status),
) -> Result<PathBuf, Error> {
    let name = lock.directory_name(arch);
    let asset = lock.asset(arch)?;
    let ready = |path: PathBuf| -> Result<PathBuf, Error> {
        let path = fs::canonicalize(path)
            .map_err(|_| Error::retry("Silo could not resolve the ChatGPT app folder."))?;
        report(Status::Ready {
            path: path.clone(),
            version: lock.version.clone(),
        });
        Ok(path)
    };
    // Fast path without the lock: a published folder is immutable.
    if let Some(path) = published(root, &name) {
        return ready(path);
    }
    if !consent_accepted(root) {
        return Err(Error {
            message: "Accept the ChatGPT download notice first.".into(),
            retryable: false,
            not_consented: true,
        });
    }
    let _lock = RootLock::take(root)?;
    if let Some(path) = published(root, &name) {
        return ready(path);
    }
    // A damaged folder (no executable) is not a published version; replace it.
    let target = root.join(&name);
    if fs::symlink_metadata(&target).is_ok() {
        let _ = fs::remove_dir_all(&target);
        let _ = fs::remove_file(&target);
    }
    clean_staging(root);

    let downloads = root.join("downloads");
    private_directory(&downloads)?;
    let deb = downloads.join(format!("chatgpt_{}_{}.deb", lock.version, arch.name()));
    let part = deb.with_extension("deb.part");
    free_space_check(root, asset.bytes)?;

    if !deb.exists() {
        report(Status::Downloading {
            received_bytes: fs::metadata(&part).map_or(0, |m| m.len()),
            total_bytes: asset.bytes,
        });
        let mut progress = throttled(|received| {
            report(Status::Downloading {
                received_bytes: received,
                total_bytes: asset.bytes,
            })
        });
        downloader.fetch(&asset.url, &part, asset.bytes, &mut progress)?;
        fs::rename(&part, &deb)
            .map_err(|_| Error::retry("Silo could not finish the ChatGPT download."))?;
    }
    report(Status::Verifying);
    verify_package(&deb, asset)?;

    report(Status::Extracting);
    let staging = tempfile::Builder::new()
        .prefix(".staging-")
        .tempdir_in(root)
        .map_err(|_| Error::retry("Silo could not prepare space for the ChatGPT app."))?;
    let mut stream = TarStream::open(&deb)?;
    let extracted = extract_tree(&mut stream, staging.path());
    let finished = stream.finish();
    extracted?;
    finished?;

    // Publish: flush the staged tree's directory, then one atomic rename.
    sync_directory(staging.path());
    let staged = staging.keep();
    if let Err(error) = fs::rename(&staged, &target) {
        let _ = fs::remove_dir_all(&staged);
        // Another actor published it (never expected under the lock): accept it.
        return match published(root, &name) {
            Some(path) => ready(path),
            None => Err(Error::retry(format!(
                "Silo could not publish the ChatGPT app: {error}"
            ))),
        };
    }
    sync_directory(root);
    let _ = fs::remove_file(&deb);
    ready(target)
}

fn free_space_check(root: &Path, download_bytes: u64) -> Result<(), Error> {
    let path = std::ffi::CString::new(root.as_os_str().as_encoded_bytes())
        .map_err(|_| Error::fatal("Invalid ChatGPT app folder."))?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Ok(()); // Not fatal; writes report their own errors.
    }
    let stats = unsafe { stats.assume_init() };
    let available = (stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64);
    // The package plus roughly its unpacked tree (about 3.5x the package).
    let required = download_bytes.saturating_mul(5);
    if available < required {
        return Err(Error::retry(format!(
            "Free at least {} MB to download the ChatGPT app, then retry.",
            required.div_ceil(1024 * 1024)
        )));
    }
    Ok(())
}

/// The status for a computer where no operation is running.
pub(crate) fn current_status(root: &Path, lock: &Lock, arch: DebArch) -> Status {
    match published(root, &lock.directory_name(arch)) {
        Some(path) => Status::Ready {
            path: fs::canonicalize(path).unwrap_or_default(),
            version: lock.version.clone(),
        },
        None if !consent_accepted(root) => Status::NotConsented,
        None => Status::Idle,
    }
}

/// Removes version folders that are neither the pinned one nor named in
/// `in_use` (folder names like `26.928.31416-arm64`), plus stale staging and
/// downloads of other versions. Returns the removed folder names.
pub(crate) fn collect_garbage(
    root: &Path,
    lock: &Lock,
    arch: DebArch,
    in_use: &HashSet<String>,
) -> Result<Vec<String>, Error> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let _lock = RootLock::take(root)?;
    clean_staging(root);
    let pinned = lock.directory_name(arch);
    let mut removed = Vec::new();
    let entries =
        fs::read_dir(root).map_err(|_| Error::retry("Could not list ChatGPT app versions."))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_version = ["-arm64", "-amd64"]
            .iter()
            .any(|suffix| name.strip_suffix(suffix).is_some_and(valid_version));
        if !is_version || name == pinned || in_use.contains(&name) {
            continue;
        }
        if entry.file_type().is_ok_and(|t| t.is_dir()) && fs::remove_dir_all(entry.path()).is_ok() {
            removed.push(name);
        }
    }
    if let Ok(entries) = fs::read_dir(root.join("downloads")) {
        let keep = format!("chatgpt_{}_{}.deb", lock.version, arch.name());
        for entry in entries.flatten() {
            if !entry.file_name().to_string_lossy().starts_with(&keep) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    removed.sort();
    Ok(removed)
}

// ------------------------------------------------------ Tauri commands

/// The ChatGPT app folder of this channel: `<app data>/chatgpt`.
pub(crate) fn storage_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("chatgpt"))
        .map_err(|error| format!("Silo could not locate its application storage: {error}"))
}

static LIVE_STATUS: Mutex<Option<Status>> = Mutex::new(None);

fn publish(app: &tauri::AppHandle, status: Status) {
    use tauri::Emitter;
    *LIVE_STATUS.lock().unwrap_or_else(|p| p.into_inner()) = Some(status.clone());
    let _ = app.emit(STATUS_EVENT, status);
}

#[tauri::command]
pub(crate) fn chatgpt_app_status(app: tauri::AppHandle) -> Result<Status, String> {
    let live = LIVE_STATUS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if let Some(status @ (Status::Downloading { .. } | Status::Verifying | Status::Extracting)) =
        live
    {
        return Ok(status);
    }
    let root = storage_root(&app)?;
    let lock = Lock::bundled().map_err(|e| e.message)?;
    let arch = DebArch::host().map_err(|e| e.message)?;
    Ok(match current_status(&root, &lock, arch) {
        Status::Idle => LIVE_STATUS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .filter(|s| matches!(s, Status::Failed { .. }))
            .unwrap_or(Status::Idle),
        other => other,
    })
}

#[tauri::command]
pub(crate) fn chatgpt_app_accept_notice(app: tauri::AppHandle) -> Result<Status, String> {
    let root = storage_root(&app)?;
    accept_notice(&root).map_err(|e| e.message)?;
    let status = chatgpt_app_status(app.clone())?;
    publish(&app, status.clone());
    Ok(status)
}

/// Ensures the pinned app, reporting progress through the `chatgpt-app-status`
/// event. Resolves with the final status (never rejects for expected failures).
#[tauri::command]
pub(crate) async fn chatgpt_app_prepare(app: tauri::AppHandle) -> Result<Status, String> {
    let root = storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let lock = Lock::bundled().map_err(|e| e.message)?;
        let arch = DebArch::host().map_err(|e| e.message)?;
        let announcer = app.clone();
        let report = move |status: Status| publish(&announcer, status);
        Ok(
            match ensure(&root, &lock, arch, &HttpDownloader::default(), &report) {
                Ok(path) => Status::Ready {
                    path,
                    version: lock.version.clone(),
                },
                Err(error) => error.status(),
            },
        )
    })
    .await
    .map_err(|_| "The ChatGPT app task stopped unexpectedly.".to_owned())?
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests;
