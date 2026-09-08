use serde::{Deserialize, Serialize};
#[cfg(target_os = "linux")]
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const PROCESS_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(target_os = "linux")]
const MAX_HASH_BYTES: u64 = 128 * 1024 * 1024;
const MAX_OUTPUT: u64 = 8 * 1024;
const EXPECTED_MSB: &str = "0.6.17";
const EXPECTED_LIBKRUNFW: &str = "5.6.1";
const EXPECTED_MSB_SOURCE: &str = "5eca4de8bf233e57f114140f8c076ea8c96f21ab";
const EXPECTED_MSB_SOURCE_ARCHIVE_SHA: &str =
    "2b31ce2d344c585c859b060874353f0c9a36bcf832f050215776b3ea79695e06";
const EXPECTED_MSB_PATCH_SHA: &str =
    "47bde23de17e34e1af4b3e8c320ca0b2047694a8ae28ad4429d9b3f11b690ec9";
const EXPECTED_MSB_TOOLCHAIN: &str = "1.94.0";
const EXPECTED_MSB_FEATURES: &str = "net,ssh";
const EXPECTED_GIT: &str = "2.53.0";
const EXPECTED_GIT_LFS: &str = "3.7.1";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DependencyReport {
    schema_version: u8,
    request_id: String,
    checked_at_ms: u64,
    checks: Vec<DependencyCheck>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DependencyCheck {
    id: String,
    title: String,
    status: CheckStatus,
    detail: String,
    remediation: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum CheckStatus {
    Pass,
    Failed,
    Unavailable,
    Timeout,
}

impl DependencyCheck {
    fn pass(id: &str, title: &str, detail: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            status: CheckStatus::Pass,
            detail: detail.into(),
            remediation: None,
        }
    }

    fn failure(
        id: &str,
        title: &str,
        status: CheckStatus,
        detail: impl Into<String>,
        remediation: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            status,
            detail: detail.into(),
            remediation: Some(remediation.into()),
        }
    }
}

#[derive(Debug)]
enum ProbeError {
    Missing(String),
    Unreadable(String),
    Timeout,
    Malformed(String),
    Unsupported(String),
    Unavailable(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MicrosandboxManifest {
    schema_version: u8,
    microsandbox_version: String,
    libkrunfw_version: String,
    target_triple: String,
    executable: PatchedRuntimeFile,
    library: RuntimeFile,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeFile {
    bundled_name: String,
    release_asset: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatchedRuntimeFile {
    bundled_name: String,
    sha256: String,
    source_commit: String,
    source_archive_sha256: String,
    patch_sha256: String,
    toolchain: String,
    features: String,
    official_release_asset: String,
    official_release_sha256: String,
    embedded_agentd_release_asset: String,
    embedded_agentd_release_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitManifest {
    schema_version: u8,
    target_triple: String,
    distribution: String,
    distribution_release: String,
    distribution_commit: String,
    git_version: String,
    git_version_output: String,
    git_lfs_version: String,
    archive: GitArchive,
    minimum_platform: String,
    paths: GitPaths,
    executable_sha256: GitExecutableHashes,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitArchive {
    name: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitPaths {
    git: String,
    git_exec_path: String,
    git_lfs: String,
    templates: String,
    certificate_bundle: Option<String>,
    packaged_executables: GitExecutables,
    packaged_resource_directory: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitExecutables {
    directory: String,
    git: String,
    git_lfs: String,
    git_remote_http: String,
    git_remote_https: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitExecutableHashes {
    git: String,
    git_lfs: String,
    git_remote_http: String,
    git_remote_https: String,
}

struct ProbePaths {
    executable_dir: PathBuf,
    resource_dir: PathBuf,
    frameworks_dir: Option<PathBuf>,
}

fn expected_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        _ => None,
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, ProbeError> {
    let bytes = fs::read(path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => ProbeError::Missing(format!("{} is missing", path.display())),
        io::ErrorKind::PermissionDenied => {
            ProbeError::Unreadable(format!("{} cannot be read", path.display()))
        }
        _ => ProbeError::Unreadable(format!("{} could not be read: {error}", path.display())),
    })?;
    serde_json::from_slice(&bytes).map_err(|_| {
        ProbeError::Malformed(format!("{} is not a valid Silo manifest", path.display()))
    })
}

fn readable_file(path: &Path) -> Result<(), ProbeError> {
    let metadata = fs::metadata(path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => ProbeError::Missing(format!("{} is missing", path.display())),
        io::ErrorKind::PermissionDenied => {
            ProbeError::Unreadable(format!("{} cannot be read", path.display()))
        }
        _ => ProbeError::Unreadable(format!(
            "{} could not be inspected: {error}",
            path.display()
        )),
    })?;
    if !metadata.is_file() {
        return Err(ProbeError::Malformed(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    File::open(path)
        .map_err(|_| ProbeError::Unreadable(format!("{} cannot be read", path.display())))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn sha256_file(path: &Path) -> Result<String, ProbeError> {
    let mut file = File::open(path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => ProbeError::Missing(format!("{} is missing", path.display())),
        io::ErrorKind::PermissionDenied => {
            ProbeError::Unreadable(format!("{} cannot be read", path.display()))
        }
        _ => ProbeError::Unreadable(format!("{} could not be read: {error}", path.display())),
    })?;
    let length = file
        .metadata()
        .map_err(|error| {
            ProbeError::Unreadable(format!(
                "{} could not be inspected: {error}",
                path.display()
            ))
        })?
        .len();
    if length > MAX_HASH_BYTES {
        return Err(ProbeError::Malformed(format!(
            "{} exceeds the packaged file-size limit",
            path.display()
        )));
    }
    let deadline = Instant::now() + PROCESS_TIMEOUT;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if Instant::now() >= deadline {
            return Err(ProbeError::Timeout);
        }
        let count = file.read(&mut buffer).map_err(|error| {
            ProbeError::Unreadable(format!("{} could not be read: {error}", path.display()))
        })?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn expected_runtime_assets(
    target: &str,
) -> Option<(
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
)> {
    match target {
        "aarch64-apple-darwin" => Some((
            "msb",
            "msb-darwin-aarch64",
            "2d3b8883da496ca7ec54f4ea122984022160295f9e4df2af198348fd1f24cdde",
            "libkrunfw.5.dylib",
            "libkrunfw-darwin-aarch64.dylib",
            "20b588c2031519cee3ad93fee4b2a0ca4805f2a3c721198911a6248fd34f65e0",
        )),
        "aarch64-unknown-linux-gnu" => Some((
            "msb",
            "msb-linux-aarch64",
            "bab283cb12902838cff629f10b28683d322ae8ce09cc2d720e90d1b169857878",
            "libkrunfw.so.5.6.1",
            "libkrunfw-linux-aarch64.so",
            "b5d205d504c3e1876c47dbb674534436b7aabc09b0fdb32d98b5fff438d9a5b6",
        )),
        "x86_64-unknown-linux-gnu" => Some((
            "msb",
            "msb-linux-x86_64",
            "7f79c9d0996fac42b4879f4798c6f985f7981b005af0a9b4b8b1ab5e590daee4",
            "libkrunfw.so.5.6.1",
            "libkrunfw-linux-x86_64.so",
            "d395efaa21984cc6934c900519909a12c8148d9688cfc88f9da3b42132ae32c2",
        )),
        _ => None,
    }
}

fn expected_agentd_asset(target: &str) -> Option<(&'static str, &'static str)> {
    match target {
        "aarch64-apple-darwin" | "aarch64-unknown-linux-gnu" => Some((
            "agentd-aarch64",
            "04bd19fcc184edc8323f588eb0fbfb9ffec00ae457bd9f6d1c62377223db5f4c",
        )),
        "x86_64-unknown-linux-gnu" => Some((
            "agentd-x86_64",
            "c6c5e7f719cbde966b4a2a366bff8f6bdec8a45a0fd8afe3fcab27243d01d1f8",
        )),
        _ => None,
    }
}

fn expected_git_archive(
    target: &str,
) -> Option<(&'static str, &'static str, &'static str, &'static str)> {
    match target {
        "aarch64-apple-darwin" => Some((
            "dugite-native-v2.53.0-4098283-macOS-arm64.tar.gz",
            "f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe",
            "git version 2.53.0",
            "macOS 12.0 (Silo declares macOS 14.0)",
        )),
        "aarch64-unknown-linux-gnu" => Some((
            "dugite-native-v2.53.0-4098283-ubuntu-arm64.tar.gz",
            "a161f45af4626bb7e0c688854bd4a9aee47cc514bca404cff0a5e3536ef1c0af",
            "git version 2.53.0.dirty",
            "glibc 2.34",
        )),
        "x86_64-unknown-linux-gnu" => Some((
            "dugite-native-v2.53.0-4098283-ubuntu-x64.tar.gz",
            "cca76aa31ad9e835e771ee7f55b73934777fbd8d16757a10d307ba06de860901",
            "git version 2.53.0",
            "glibc 2.34",
        )),
        _ => None,
    }
}

fn expected_git_executable_hashes(target: &str) -> Option<[&'static str; 4]> {
    match target {
        "aarch64-apple-darwin" => Some([
            "8b0c175c430d35d8a790ca907a37ca8742966a15f0da0b75e6747e640e24460a",
            "48bb6497160105ef852044da75147acee19502efd5f164b9a4429c3a60be7d4a",
            "a0119fd412990a160b9dd9c6866449970836801a78eef1e9dbc823a32a054690",
            "a0119fd412990a160b9dd9c6866449970836801a78eef1e9dbc823a32a054690",
        ]),
        "aarch64-unknown-linux-gnu" => Some([
            "1639d4cbfd7d27c49cbc414e7ec297919c52aade7cb91a64d4b8408f66dbb53c",
            "83a0e15428950cf52d8806223f05cc61788f965ed90fb634226a5610c852bba3",
            "3c453f3cef77616602ce893cfef9c3cefe2d8eb1860c7cd131f130f90778042e",
            "3c453f3cef77616602ce893cfef9c3cefe2d8eb1860c7cd131f130f90778042e",
        ]),
        "x86_64-unknown-linux-gnu" => Some([
            "74ea93260192ffae64e47c70c9fc54c8ca3609fcc746dc6518e1d92a54951fd4",
            "6b92b05c4588b4a5373b2b4102dbb302757d8ec6671da67cf9e4f9ccb01cd349",
            "c6ae57d2bee04dcaf52616b6915674ea51bee539a7ab22609ece4e70773d20a8",
            "c6ae57d2bee04dcaf52616b6915674ea51bee539a7ab22609ece4e70773d20a8",
        ]),
        _ => None,
    }
}

fn run_bounded_with_timeout(
    path: &Path,
    arguments: &[&str],
    environment: &[(&str, &Path)],
    timeout: Duration,
) -> Result<String, ProbeError> {
    readable_file(path)?;
    let mut stdout_file = tempfile::tempfile().map_err(|error| {
        ProbeError::Unavailable(format!("Could not isolate version output: {error}"))
    })?;
    let mut stderr_file = tempfile::tempfile().map_err(|error| {
        ProbeError::Unavailable(format!("Could not isolate version errors: {error}"))
    })?;
    let mut command = Command::new(path);
    command
        .args(arguments)
        .env_clear()
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file.try_clone().map_err(|error| {
            ProbeError::Unavailable(format!("Could not capture version output: {error}"))
        })?))
        .stderr(Stdio::from(stderr_file.try_clone().map_err(|error| {
            ProbeError::Unavailable(format!("Could not capture version errors: {error}"))
        })?));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    for (name, value) in environment {
        command.env(name, value);
    }
    let mut child = command.spawn().map_err(|error| match error.kind() {
        io::ErrorKind::PermissionDenied => {
            ProbeError::Unreadable(format!("{} is not executable", path.display()))
        }
        _ => ProbeError::Unavailable(format!("{} could not run: {error}", path.display())),
    })?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| ProbeError::Unavailable(format!("version check failed: {error}")))?
        {
            break status;
        }
        if Instant::now() >= deadline {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            #[cfg(not(unix))]
            let _ = child.kill();
            let _ = child.wait();
            return Err(ProbeError::Timeout);
        }
        thread::sleep(Duration::from_millis(20));
    };
    stdout_file.seek(SeekFrom::Start(0)).map_err(|error| {
        ProbeError::Unreadable(format!("version output could not be read: {error}"))
    })?;
    stderr_file.seek(SeekFrom::Start(0)).map_err(|error| {
        ProbeError::Unreadable(format!("version error output could not be read: {error}"))
    })?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    stdout_file
        .take(MAX_OUTPUT + 1)
        .read_to_end(&mut stdout)
        .map_err(|error| {
            ProbeError::Unreadable(format!("version output could not be read: {error}"))
        })?;
    stderr_file
        .take(MAX_OUTPUT + 1)
        .read_to_end(&mut stderr)
        .map_err(|error| {
            ProbeError::Unreadable(format!("version error output could not be read: {error}"))
        })?;
    if stdout.len() > MAX_OUTPUT as usize || stderr.len() > MAX_OUTPUT as usize {
        return Err(ProbeError::Malformed(
            "version output exceeded 8 KiB".into(),
        ));
    }
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr).trim().to_owned();
        return Err(ProbeError::Unsupported(if detail.is_empty() {
            format!("version check exited with {status}")
        } else {
            detail
        }));
    }
    String::from_utf8(stdout)
        .map(|value| value.trim().to_owned())
        .map_err(|_| ProbeError::Malformed("version output was not UTF-8".into()))
}

fn run_bounded(
    path: &Path,
    arguments: &[&str],
    environment: &[(&str, &Path)],
) -> Result<String, ProbeError> {
    run_bounded_with_timeout(path, arguments, environment, PROCESS_TIMEOUT)
}

// Local extension keeps the user-facing mapping exhaustive without leaking paths into group captions.
impl ProbeError {
    fn to_check(self, id: &str, title: &str, reinstall: bool) -> DependencyCheck {
        let recovery = if reinstall {
            "Reinstall this Silo build from a trusted package."
        } else {
            "Check this host requirement, then retry checks."
        };
        match self {
            Self::Timeout => DependencyCheck::failure(
                id,
                title,
                CheckStatus::Timeout,
                "The check did not finish in time. No successful result was recorded.",
                "Retry checks. If it times out again, reinstall Silo from a trusted package.",
            ),
            Self::Missing(detail) => {
                DependencyCheck::failure(id, title, CheckStatus::Unavailable, detail, recovery)
            }
            Self::Unreadable(detail) => {
                DependencyCheck::failure(id, title, CheckStatus::Unavailable, detail, recovery)
            }
            Self::Malformed(detail) => {
                DependencyCheck::failure(id, title, CheckStatus::Failed, detail, recovery)
            }
            Self::Unsupported(detail) => {
                DependencyCheck::failure(id, title, CheckStatus::Failed, detail, recovery)
            }
            Self::Unavailable(detail) => {
                DependencyCheck::failure(id, title, CheckStatus::Unavailable, detail, recovery)
            }
        }
    }
}

fn system_check() -> DependencyCheck {
    let id = "system-os";
    let title = "Supported OS";
    if expected_target().is_none() {
        return DependencyCheck::failure(
            id,
            title,
            CheckStatus::Failed,
            format!(
                "{} {} is not supported by this Silo build.",
                std::env::consts::OS,
                std::env::consts::ARCH
            ),
            "Use Silo on macOS 14 or later on Apple silicon, or a supported Linux build.",
        );
    }
    #[cfg(target_os = "macos")]
    {
        let output = run_bounded(Path::new("/usr/bin/sw_vers"), &["-productVersion"], &[]);
        let version = match output {
            Ok(value) => value,
            Err(error) => return error.to_check(id, title, false),
        };
        let major = version
            .split('.')
            .next()
            .and_then(|value| value.parse::<u32>().ok());
        if major.is_none() {
            return ProbeError::Malformed("macOS returned an invalid version.".into())
                .to_check(id, title, false);
        }
        if major.unwrap() < 14 {
            return ProbeError::Unsupported(format!(
                "macOS {version} is not supported by this Silo build."
            ))
            .to_check(id, title, false);
        }
        return DependencyCheck::pass(id, title, format!("macOS {version} · Apple silicon"));
    }
    #[cfg(target_os = "linux")]
    {
        let target = expected_target().expect("supported Linux target");
        let version = glibc_version();
        return linux_system_version_result(&version, target);
    }
}

#[cfg(target_os = "linux")]
fn glibc_version() -> String {
    use std::ffi::CStr;
    unsafe extern "C" {
        fn gnu_get_libc_version() -> *const libc::c_char;
    }
    // SAFETY: glibc owns a process-lifetime NUL-terminated version string.
    unsafe {
        CStr::from_ptr(gnu_get_libc_version())
            .to_string_lossy()
            .into_owned()
    }
}

#[cfg(any(target_os = "linux", test))]
fn parse_major_minor(value: &str) -> Option<(u32, u32)> {
    let mut parts = value.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

#[cfg(any(target_os = "linux", test))]
fn linux_system_version_result(version: &str, target: &str) -> DependencyCheck {
    let Some((major, minor)) = parse_major_minor(version) else {
        return ProbeError::Malformed("glibc returned an invalid version.".into()).to_check(
            "system-os",
            "Supported OS",
            false,
        );
    };
    if (major, minor) < (2, 34) {
        return ProbeError::Unsupported(format!(
            "glibc {version} is older than the required 2.34 for {target}."
        ))
        .to_check("system-os", "Supported OS", false);
    }
    let architecture = if target.starts_with("aarch64") {
        "arm64"
    } else {
        "x86_64"
    };
    DependencyCheck::pass(
        "system-os",
        "Supported OS",
        format!("Linux {architecture} · glibc {version}"),
    )
}

fn virtualization_check() -> DependencyCheck {
    let id = "system-virtualization";
    let title = "Virtualization";
    #[cfg(target_os = "macos")]
    {
        return match run_bounded(
            Path::new("/usr/sbin/sysctl"),
            &["-n", "kern.hv_support"],
            &[],
        ) {
            Ok(value) if value == "1" => {
                DependencyCheck::pass(id, title, "Apple Hypervisor available")
            }
            Ok(_) => ProbeError::Unsupported(
                "Apple Hypervisor support is unavailable on this Mac.".into(),
            )
            .to_check(id, title, false),
            Err(error) => error.to_check(id, title, false),
        };
    }
    #[cfg(target_os = "linux")]
    {
        let device = match std::fs::OpenOptions::new().read(true).write(true).open("/dev/kvm") {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return DependencyCheck::failure(id, title, CheckStatus::Unavailable, "/dev/kvm is unavailable on this host.", "Enable KVM for this Linux host, then retry checks."),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return DependencyCheck::failure(id, title, CheckStatus::Failed, "Silo cannot open /dev/kvm for this user.", "Grant this user KVM access using the host's documented policy, sign out, and retry checks."),
            Err(error) => return DependencyCheck::failure(id, title, CheckStatus::Unavailable, format!("Silo could not open /dev/kvm: {error}"), "Check the host KVM device, then retry checks."),
        };
        use std::os::fd::AsRawFd;
        // KVM_GET_API_VERSION is _IO(KVMIO, 0x00). It queries only and never creates a VM.
        let version = unsafe { libc::ioctl(device.as_raw_fd(), 0xAE00) };
        return if version == 12 {
            DependencyCheck::pass(id, title, "KVM API 12 available")
        } else if version < 0 {
            DependencyCheck::failure(
                id,
                title,
                CheckStatus::Unavailable,
                format!("KVM API query failed: {}", io::Error::last_os_error()),
                "Check KVM access on this host, then retry checks.",
            )
        } else {
            DependencyCheck::failure(
                id,
                title,
                CheckStatus::Failed,
                format!("KVM API {version} is incompatible; Silo requires API 12."),
                "Update or replace the host KVM implementation, then retry checks.",
            )
        };
    }
}

#[cfg(target_os = "macos")]
fn verify_macos_signature(path: &Path) -> Result<(), ProbeError> {
    run_bounded(
        Path::new("/usr/bin/codesign"),
        &["--verify", "--strict", path.to_string_lossy().as_ref()],
        &[],
    )
    .map(|_| ())
}

#[cfg(target_os = "linux")]
fn verify_linux_hash(path: &Path, expected: &str) -> Result<(), ProbeError> {
    let actual = sha256_file(path)?;
    if actual == expected {
        Ok(())
    } else {
        Err(ProbeError::Malformed(format!(
            "{} failed its packaged checksum.",
            path.file_name().unwrap_or_default().to_string_lossy()
        )))
    }
}

fn microsandbox_check(paths: &ProbePaths) -> DependencyCheck {
    let id = "runtime-microsandbox";
    let title = "MicroSandbox runtime";
    let manifest_path = paths.resource_dir.join("microsandbox/manifest.json");
    let manifest: MicrosandboxManifest = match read_json(&manifest_path) {
        Ok(value) => value,
        Err(error) => return error.to_check(id, title, true),
    };
    if !runtime_manifest_matches(&manifest) {
        return ProbeError::Malformed(
            "The bundled MicroSandbox manifest does not match this Silo build.".into(),
        )
        .to_check(id, title, true);
    }
    let executable = paths.executable_dir.join(&manifest.executable.bundled_name);
    #[cfg(target_os = "macos")]
    let library = paths
        .frameworks_dir
        .as_ref()
        .expect("macOS frameworks path")
        .join(&manifest.library.bundled_name);
    #[cfg(target_os = "linux")]
    let library = paths
        .resource_dir
        .join("microsandbox")
        .join(&manifest.target_triple)
        .join("lib")
        .join(&manifest.library.bundled_name);
    for candidate in [&executable, &library] {
        if let Err(error) = readable_file(candidate) {
            return error.to_check(id, title, true);
        }
    }
    #[cfg(target_os = "macos")]
    for candidate in [&executable, &library] {
        if let Err(error) = verify_macos_signature(candidate) {
            return error.to_check(id, title, true);
        }
    }
    #[cfg(target_os = "linux")]
    for (candidate, expected) in [
        (&executable, manifest.executable.sha256.as_str()),
        (&library, manifest.library.sha256.as_str()),
    ] {
        if let Err(error) = verify_linux_hash(candidate, expected) {
            return error.to_check(id, title, true);
        }
    }
    let home = match tempfile::tempdir() {
        Ok(value) => value,
        Err(error) => {
            return ProbeError::Unavailable(format!("Could not isolate the version check: {error}"))
                .to_check(id, title, true)
        }
    };
    let output = run_bounded(
        &executable,
        &["--version"],
        &[
            ("HOME", home.path()),
            ("MSB_HOME", home.path()),
            ("MSB_PATH", &executable),
            ("MSB_LIBKRUNFW_PATH", &library),
        ],
    );
    microsandbox_version_result(output)
}

fn runtime_manifest_matches(manifest: &MicrosandboxManifest) -> bool {
    manifest.schema_version == 2
        && manifest.microsandbox_version == EXPECTED_MSB
        && manifest.libkrunfw_version == EXPECTED_LIBKRUNFW
        && Some(manifest.target_triple.as_str()) == expected_target()
        && expected_runtime_assets(&manifest.target_triple).is_some_and(
            |(
                executable_name,
                executable_asset,
                executable_sha,
                library_name,
                library_asset,
                library_sha,
            )| {
                manifest.executable.bundled_name == executable_name
                    && valid_sha256(&manifest.executable.sha256)
                    && manifest.executable.source_commit == EXPECTED_MSB_SOURCE
                    && manifest.executable.source_archive_sha256 == EXPECTED_MSB_SOURCE_ARCHIVE_SHA
                    && manifest.executable.patch_sha256 == EXPECTED_MSB_PATCH_SHA
                    && manifest.executable.toolchain == EXPECTED_MSB_TOOLCHAIN
                    && manifest.executable.features == EXPECTED_MSB_FEATURES
                    && manifest.executable.official_release_asset == executable_asset
                    && manifest.executable.official_release_sha256 == executable_sha
                    && expected_agentd_asset(&manifest.target_triple).is_some_and(|(asset, sha)| {
                        manifest.executable.embedded_agentd_release_asset == asset
                            && manifest.executable.embedded_agentd_release_sha256 == sha
                    })
                    && manifest.library.bundled_name == library_name
                    && manifest.library.release_asset == library_asset
                    && manifest.library.sha256 == library_sha
            },
        )
}

fn microsandbox_version_result(output: Result<String, ProbeError>) -> DependencyCheck {
    match output {
        Ok(value) if value == format!("msb {EXPECTED_MSB}") => DependencyCheck::pass(
            "runtime-microsandbox",
            "MicroSandbox runtime",
            format!("Bundled msb {EXPECTED_MSB} · libkrunfw {EXPECTED_LIBKRUNFW}"),
        ),
        Ok(value) => ProbeError::Malformed(format!(
            "Bundled msb returned an unexpected version: {value}"
        ))
        .to_check("runtime-microsandbox", "MicroSandbox runtime", true),
        Err(error) => error.to_check("runtime-microsandbox", "MicroSandbox runtime", true),
    }
}

fn git_checks(paths: &ProbePaths) -> [DependencyCheck; 2] {
    let manifest_path = paths.resource_dir.join("git-support/manifest.json");
    let manifest: GitManifest = match read_json(&manifest_path) {
        Ok(value) => value,
        Err(error) => {
            return [
                error.to_check("tool-git", "Git", true),
                DependencyCheck::failure(
                    "tool-git-lfs",
                    "Git LFS",
                    CheckStatus::Unavailable,
                    "Git LFS was not checked because the bundled Git manifest is unavailable.",
                    "Reinstall this Silo build from a trusted package.",
                ),
            ]
        }
    };
    let expected_archive = expected_git_archive(&manifest.target_triple);
    let expected_hashes = expected_git_executable_hashes(&manifest.target_triple);
    let hashes = &manifest.executable_sha256;
    let paths_are_fixed = git_paths_are_fixed(&manifest);
    let executable_hashes = [
        hashes.git.as_str(),
        hashes.git_lfs.as_str(),
        hashes.git_remote_http.as_str(),
        hashes.git_remote_https.as_str(),
    ];
    let executable_hashes_match = executable_hashes.into_iter().all(valid_sha256)
        && expected_hashes.is_some_and(|expected| executable_hashes == expected);
    if manifest.schema_version != 1
        || manifest.distribution != "desktop/dugite-native"
        || manifest.distribution_release != "v2.53.0-4"
        || manifest.distribution_commit != "4098283a7ecb8a227b9d43580336c78a06f90e5d"
        || manifest.git_version != EXPECTED_GIT
        || manifest.git_lfs_version != EXPECTED_GIT_LFS
        || Some(manifest.target_triple.as_str()) != expected_target()
        || !paths_are_fixed
        || !executable_hashes_match
        || expected_archive.is_none()
        || expected_archive.is_some_and(|(name, sha, version, platform)| {
            manifest.archive.name != name
                || manifest.archive.sha256 != sha
                || manifest.git_version_output != version
                || manifest.minimum_platform != platform
        })
    {
        let error = ProbeError::Malformed(
            "The bundled Git manifest does not match this Silo build.".into(),
        );
        return [
            error.to_check("tool-git", "Git", true),
            DependencyCheck::failure(
                "tool-git-lfs",
                "Git LFS",
                CheckStatus::Unavailable,
                "Git LFS was not checked because the bundled Git manifest is invalid.",
                "Reinstall this Silo build from a trusted package.",
            ),
        ];
    }
    let executables = &manifest.paths.packaged_executables;
    let git = paths.executable_dir.join(&executables.git);
    let lfs = paths.executable_dir.join(&executables.git_lfs);
    let http = paths.executable_dir.join(&executables.git_remote_http);
    let https = paths.executable_dir.join(&executables.git_remote_https);
    #[cfg(target_os = "macos")]
    for candidate in [&git, &lfs, &http, &https] {
        if let Err(error) = verify_macos_signature(candidate) {
            return [
                error.to_check("tool-git", "Git", true),
                DependencyCheck::failure(
                    "tool-git-lfs",
                    "Git LFS",
                    CheckStatus::Unavailable,
                    "Git LFS was not checked because packaged Git integrity failed.",
                    "Reinstall this Silo build from a trusted package.",
                ),
            ];
        }
    }
    #[cfg(target_os = "linux")]
    for (candidate, expected) in [
        (&git, manifest.executable_sha256.git.as_str()),
        (&lfs, manifest.executable_sha256.git_lfs.as_str()),
        (&http, manifest.executable_sha256.git_remote_http.as_str()),
        (&https, manifest.executable_sha256.git_remote_https.as_str()),
    ] {
        if let Err(error) = verify_linux_hash(candidate, expected) {
            return [
                error.to_check("tool-git", "Git", true),
                DependencyCheck::failure(
                    "tool-git-lfs",
                    "Git LFS",
                    CheckStatus::Unavailable,
                    "Git LFS was not checked because packaged Git integrity failed.",
                    "Reinstall this Silo build from a trusted package.",
                ),
            ];
        }
    }
    let home = match tempfile::tempdir() {
        Ok(value) => value,
        Err(error) => {
            return [
                ProbeError::Unavailable(format!("Could not isolate the Git checks: {error}"))
                    .to_check("tool-git", "Git", true),
                DependencyCheck::failure(
                    "tool-git-lfs",
                    "Git LFS",
                    CheckStatus::Unavailable,
                    "Git LFS was not checked.",
                    "Retry checks.",
                ),
            ]
        }
    };
    let exec_path = paths.executable_dir.as_path();
    let template_path = paths
        .resource_dir
        .join("git-support")
        .join(&manifest.paths.templates);
    let null = Path::new("/dev/null");
    let environment = [
        ("HOME", home.path()),
        ("XDG_CONFIG_HOME", home.path()),
        ("GIT_CONFIG_NOSYSTEM", Path::new("1")),
        ("GIT_CONFIG_SYSTEM", null),
        ("GIT_CONFIG_GLOBAL", null),
        ("GIT_EXEC_PATH", exec_path),
        ("GIT_TEMPLATE_DIR", template_path.as_path()),
        ("PATH", exec_path),
    ];
    let git_result = git_version_result(
        run_bounded(&git, &["--version"], &environment),
        &manifest.git_version_output,
    );
    let lfs_result = git_lfs_version_result(run_bounded(&lfs, &["version"], &environment));
    [git_result, lfs_result]
}

fn git_paths_are_fixed(manifest: &GitManifest) -> bool {
    manifest.paths.git == "bin/git"
        && manifest.paths.git_exec_path == "libexec/git-core"
        && manifest.paths.git_lfs == "libexec/git-core/git-lfs"
        && manifest.paths.templates == "share/git-core/templates"
        && manifest.paths.packaged_resource_directory == "git-support"
        && manifest.paths.packaged_executables.directory == "executableSibling"
        && manifest.paths.packaged_executables.git == "git"
        && manifest.paths.packaged_executables.git_lfs == "git-lfs"
        && manifest.paths.packaged_executables.git_remote_http == "git-remote-http"
        && manifest.paths.packaged_executables.git_remote_https == "git-remote-https"
        && ((manifest.target_triple.contains("linux")
            && manifest.paths.certificate_bundle.as_deref() == Some("ssl/cacert.pem"))
            || (manifest.target_triple.contains("apple")
                && manifest.paths.certificate_bundle.is_none()))
}

fn git_version_result(
    output: Result<String, ProbeError>,
    expected_output: &str,
) -> DependencyCheck {
    match output {
        Ok(value) if value == expected_output => {
            DependencyCheck::pass("tool-git", "Git", format!("Bundled Git {EXPECTED_GIT}"))
        }
        Ok(value) => ProbeError::Malformed(format!(
            "Bundled Git returned an unexpected version: {value}"
        ))
        .to_check("tool-git", "Git", true),
        Err(error) => error.to_check("tool-git", "Git", true),
    }
}

fn git_lfs_version_result(output: Result<String, ProbeError>) -> DependencyCheck {
    match output {
        Ok(value)
            if value.starts_with(&format!("git-lfs/{EXPECTED_GIT_LFS} "))
                || value == format!("git-lfs/{EXPECTED_GIT_LFS}") =>
        {
            DependencyCheck::pass(
                "tool-git-lfs",
                "Git LFS",
                format!("Bundled Git LFS {EXPECTED_GIT_LFS}"),
            )
        }
        Ok(value) => ProbeError::Malformed(format!(
            "Bundled Git LFS returned an unexpected version: {value}"
        ))
        .to_check("tool-git-lfs", "Git LFS", true),
        Err(error) => error.to_check("tool-git-lfs", "Git LFS", true),
    }
}

fn collect(request_id: String, paths: ProbePaths) -> DependencyReport {
    let mut checks = vec![
        system_check(),
        virtualization_check(),
        microsandbox_check(&paths),
    ];
    checks.extend(git_checks(&paths));
    DependencyReport {
        schema_version: 1,
        request_id,
        checked_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        checks,
    }
}

#[tauri::command]
pub async fn read_dependencies(
    app: AppHandle,
    request_id: String,
) -> Result<DependencyReport, String> {
    eprintln!("dependency check request: {request_id}");
    if request_id.trim().is_empty() || request_id.len() > 128 {
        return Err("Invalid dependency-check request ID".into());
    }
    let executable = std::env::current_exe()
        .map_err(|error| format!("Silo executable path is unavailable: {error}"))?;
    let executable_dir = executable
        .parent()
        .ok_or("Silo executable directory is unavailable")?
        .to_path_buf();
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Silo resource directory is unavailable: {error}"))?;
    #[cfg(target_os = "macos")]
    let frameworks_dir = executable_dir
        .parent()
        .map(|contents| contents.join("Frameworks"));
    #[cfg(not(target_os = "macos"))]
    let frameworks_dir = None;
    let report = tauri::async_runtime::spawn_blocking(move || {
        collect(
            request_id,
            ProbePaths {
                executable_dir,
                resource_dir,
                frameworks_dir,
            },
        )
    })
    .await
    .map_err(|error| format!("Dependency checks could not run: {error}"))?;
    eprintln!("dependency check response: {}", report.checks.len());
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_linux_glibc_boundaries_to_actual_check_results() {
        assert_eq!(
            linux_system_version_result("2.34", "aarch64-unknown-linux-gnu"),
            DependencyCheck::pass("system-os", "Supported OS", "Linux arm64 · glibc 2.34")
        );
        assert_eq!(
            linux_system_version_result("2.33", "x86_64-unknown-linux-gnu").status,
            CheckStatus::Failed
        );
        assert_eq!(
            linux_system_version_result("broken", "x86_64-unknown-linux-gnu").status,
            CheckStatus::Failed
        );
    }

    #[test]
    fn strict_manifests_reject_missing_integrity_evidence() {
        let input = r#"{"schemaVersion":1,"targetTriple":"x86_64-unknown-linux-gnu"}"#;
        assert!(serde_json::from_str::<GitManifest>(input).is_err());
    }

    #[test]
    fn missing_files_remain_unavailable() {
        let path = Path::new("/definitely/not/a/silo/runtime");
        assert!(matches!(readable_file(path), Err(ProbeError::Missing(_))));
        let check = readable_file(path)
            .unwrap_err()
            .to_check("runtime", "Runtime", true);
        assert_eq!(check.status, CheckStatus::Unavailable);
    }

    #[test]
    fn maps_actual_version_results_to_specific_states_and_captions() {
        assert_eq!(
            microsandbox_version_result(Ok("msb 0.6.17".into())),
            DependencyCheck::pass(
                "runtime-microsandbox",
                "MicroSandbox runtime",
                "Bundled msb 0.6.17 · libkrunfw 5.6.1"
            )
        );
        assert_eq!(
            git_version_result(Ok("git version 2.53.0".into()), "git version 2.53.0"),
            DependencyCheck::pass("tool-git", "Git", "Bundled Git 2.53.0")
        );
        assert_eq!(
            git_lfs_version_result(Ok("git-lfs/3.7.1 (GitHub; darwin arm64; go 1.24)".into())),
            DependencyCheck::pass("tool-git-lfs", "Git LFS", "Bundled Git LFS 3.7.1")
        );
        assert_eq!(
            microsandbox_version_result(Ok("msb 0.6.16".into())).status,
            CheckStatus::Failed
        );
        assert_eq!(
            git_lfs_version_result(Err(ProbeError::Timeout)).status,
            CheckStatus::Timeout
        );
    }

    #[test]
    fn rejects_manifest_filenames_outside_packaged_locations() {
        let target = expected_target().expect("tests run on a supported target");
        let (
            executable_name,
            executable_asset,
            executable_sha,
            library_name,
            library_asset,
            library_sha,
        ) = expected_runtime_assets(target).unwrap();
        let mut runtime: MicrosandboxManifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 2,
            "microsandboxVersion": EXPECTED_MSB,
            "libkrunfwVersion": EXPECTED_LIBKRUNFW,
            "targetTriple": target,
            "executable": {
                "bundledName": executable_name,
                "sha256": "1".repeat(64),
                "sourceCommit": EXPECTED_MSB_SOURCE,
                "sourceArchiveSha256": EXPECTED_MSB_SOURCE_ARCHIVE_SHA,
                "patchSha256": EXPECTED_MSB_PATCH_SHA,
                "toolchain": EXPECTED_MSB_TOOLCHAIN,
                "features": EXPECTED_MSB_FEATURES,
                "officialReleaseAsset": executable_asset,
                "officialReleaseSha256": executable_sha,
                "embeddedAgentdReleaseAsset": expected_agentd_asset(target).unwrap().0,
                "embeddedAgentdReleaseSha256": expected_agentd_asset(target).unwrap().1
            },
            "library": { "bundledName": library_name, "releaseAsset": library_asset, "sha256": library_sha }
        })).unwrap();
        assert!(runtime_manifest_matches(&runtime));
        runtime.executable.bundled_name = "../../bin/sh".into();
        assert!(!runtime_manifest_matches(&runtime));
    }

    #[test]
    fn kills_a_version_probe_at_its_deadline() {
        let started = Instant::now();
        let result = run_bounded_with_timeout(
            Path::new("/bin/sh"),
            &["-c", "sleep 2"],
            &[],
            Duration::from_millis(40),
        );
        assert!(matches!(result, Err(ProbeError::Timeout)));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
