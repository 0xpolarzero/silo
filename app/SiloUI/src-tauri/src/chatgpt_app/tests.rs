//! Synthetic packages only: no network and no process-wide Silo state, so these
//! run in parallel without the shared isolation guard.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

enum Item<'a> {
    Dir(&'a str, u32),
    File(&'a str, u32, &'a [u8]),
    Link(&'a str, &'a str),
    Hard(&'a str, &'a str),
    Device(&'a str),
}

fn raw_header(name: &str, kind: tar::EntryType, mode: u32, size: u64) -> tar::Header {
    let mut header = tar::Header::new_gnu();
    // Bypass the builder's own path sanitising: hostile names must reach us.
    header.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
    header.set_entry_type(kind);
    header.set_mode(mode);
    header.set_size(size);
    header
}

fn data_tar(items: &[Item]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for item in items {
        match item {
            Item::Dir(name, mode) => {
                let mut h = raw_header(name, tar::EntryType::Directory, *mode, 0);
                h.set_cksum();
                builder.append(&h, std::io::empty()).unwrap();
            }
            Item::File(name, mode, bytes) => {
                let mut h = raw_header(name, tar::EntryType::Regular, *mode, bytes.len() as u64);
                h.set_cksum();
                builder.append(&h, *bytes).unwrap();
            }
            Item::Link(name, target) | Item::Hard(name, target) => {
                let kind = if matches!(item, Item::Link(..)) {
                    tar::EntryType::Symlink
                } else {
                    tar::EntryType::Link
                };
                let mut h = raw_header(name, kind, 0o777, 0);
                h.as_old_mut().linkname[..target.len()].copy_from_slice(target.as_bytes());
                h.set_cksum();
                builder.append(&h, std::io::empty()).unwrap();
            }
            Item::Device(name) => {
                let mut h = raw_header(name, tar::EntryType::Char, 0o644, 0);
                h.set_cksum();
                builder.append(&h, std::io::empty()).unwrap();
            }
        }
    }
    builder.into_inner().unwrap()
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn ar_member(out: &mut Vec<u8>, name: &str, body: &[u8]) {
    out.extend_from_slice(
        format!(
            "{:<16}{:<12}{:<6}{:<6}{:<8}{:<10}`\n",
            name,
            0,
            0,
            0,
            "100644",
            body.len()
        )
        .as_bytes(),
    );
    out.extend_from_slice(body);
    if body.len() % 2 == 1 {
        out.push(b'\n');
    }
}

/// A real ar container with a gzip data member, readable by bsdtar and dpkg-deb.
fn deb(items: &[Item]) -> Vec<u8> {
    let mut out = b"!<arch>\n".to_vec();
    ar_member(&mut out, "debian-binary", b"2.0\n");
    let control = gzip(&data_tar(&[Item::File(
        "./control",
        0o644,
        b"Package: chatgpt\n",
    )]));
    ar_member(&mut out, "control.tar.gz", &control);
    ar_member(&mut out, "data.tar.gz", &gzip(&data_tar(items)));
    out
}

fn good_items() -> Vec<Item<'static>> {
    vec![
        Item::Dir("./usr/", 0o755),
        Item::Dir("./usr/lib/", 0o755),
        Item::Dir("./usr/lib/chatgpt/", 0o755),
        Item::File("./usr/lib/chatgpt/ChatGPT", 0o755, b"#!/bin/sh\n"),
        Item::Dir("./usr/lib/chatgpt/resources/", 0o700),
        Item::File("./usr/lib/chatgpt/resources/app.asar", 0o644, b"data"),
        Item::Link("./usr/lib/chatgpt/resources/current", "app.asar"),
        Item::Link("./usr/lib/chatgpt/res", "resources"),
        Item::Link("./usr/lib/chatgpt/resources/back", "../ChatGPT"),
        Item::File("./usr/bin/outside", 0o755, b"never extracted"),
        Item::File("./etc/other", 0o644, b"never extracted"),
    ]
}

struct Fake {
    bytes: Vec<u8>,
    calls: AtomicUsize,
    /// Pretend an earlier attempt left this many bytes in the part file.
    delay: Duration,
}

impl Fake {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            bytes,
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
        }
    }
}

impl Downloader for Fake {
    fn fetch(
        &self,
        _url: &str,
        part: &Path,
        total: u64,
        progress: &mut dyn FnMut(u64),
    ) -> Result<(), Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(self.delay);
        fs::write(part, &self.bytes).unwrap();
        progress(total);
        Ok(())
    }
}

fn lock_for(bytes: &[u8]) -> Lock {
    let asset = Asset {
        url: format!("https://{DOWNLOAD_HOST}/chatgpt.deb"),
        sha256: format!("{:x}", Sha256::digest(bytes)),
        bytes: bytes.len() as u64,
    };
    Lock {
        schema_version: 1,
        package: "chatgpt".into(),
        version: "1.2.3".into(),
        cua_runtime_version: "0.0.1/x".into(),
        lcu_version: None,
        architectures: HashMap::from([
            ("arm64".to_owned(), asset.clone()),
            ("amd64".to_owned(), asset),
        ]),
    }
}

fn root() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    accept_notice(&dir.path().join("chatgpt")).unwrap();
    dir
}

fn run(
    dir: &tempfile::TempDir,
    package: &[u8],
    lock: &Lock,
) -> (Result<PathBuf, Error>, Vec<Status>) {
    let statuses = Mutex::new(Vec::new());
    let fake = Fake::new(package.to_vec());
    let result = ensure(
        &dir.path().join("chatgpt"),
        lock,
        DebArch::Arm64,
        &fake,
        &|s| statuses.lock().unwrap().push(s),
    );
    (result, statuses.into_inner().unwrap())
}

fn assert_nothing_published(dir: &tempfile::TempDir) {
    let root = dir.path().join("chatgpt");
    assert!(!root.join("1.2.3-arm64").exists());
    let leftovers: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(".staging-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn bundled_lock_is_valid_and_pins_both_architectures() {
    let lock = Lock::bundled().unwrap();
    assert_eq!(lock.version, "26.928.31416");
    assert_eq!(
        lock.cua_runtime_version,
        "0.0.27/20260927214556-b77d38801cca"
    );
    assert_eq!(lock.lcu_version, None);
    let arm = lock.asset(DebArch::Arm64).unwrap();
    assert_eq!(arm.bytes, 453121290);
    assert!(arm
        .url
        .ends_with("pool/main/c/chatgpt/chatgpt_26.928.31416_arm64.deb"));
    assert_eq!(lock.asset(DebArch::Amd64).unwrap().bytes, 474894546);
    assert_eq!(lock.directory_name(DebArch::Arm64), "26.928.31416-arm64");
}

#[test]
fn lock_rejects_plain_http_and_foreign_hosts() {
    for url in [
        "http://persistent.oaistatic.com/a.deb",
        "https://example.com/a.deb",
    ] {
        let mut lock = Lock::bundled().unwrap();
        lock.architectures.get_mut("arm64").unwrap().url = url.into();
        assert!(lock.validate().is_err(), "{url}");
    }
    let mut lock = Lock::bundled().unwrap();
    lock.architectures.get_mut("amd64").unwrap().sha256 = "ABC".into();
    assert!(lock.validate().is_err());
}

#[test]
fn nothing_is_downloaded_without_consent() {
    let dir = tempfile::tempdir().unwrap();
    let package = deb(&good_items());
    let fake = Fake::new(package.clone());
    let root = dir.path().join("chatgpt");
    assert_eq!(
        current_status(&root, &lock_for(&package), DebArch::Arm64),
        Status::NotConsented
    );
    let error = ensure(&root, &lock_for(&package), DebArch::Arm64, &fake, &|_| {}).unwrap_err();
    assert!(error.not_consented);
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
    accept_notice(&root).unwrap();
    assert!(consent_accepted(&root));
    assert_eq!(
        current_status(&root, &lock_for(&package), DebArch::Arm64),
        Status::Idle
    );
}

#[test]
fn valid_package_is_published_with_modes_links_and_a_canonical_path() {
    let dir = root();
    let package = deb(&good_items());
    let (result, statuses) = run(&dir, &package, &lock_for(&package));
    let path = result.unwrap();
    assert_eq!(
        path,
        fs::canonicalize(dir.path().join("chatgpt/1.2.3-arm64")).unwrap()
    );
    assert_eq!(
        fs::metadata(path.join("ChatGPT"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    assert_eq!(
        fs::metadata(path.join("resources/app.asar"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
    assert_eq!(
        fs::metadata(path.join("resources"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    assert_eq!(
        fs::read_link(path.join("resources/current")).unwrap(),
        Path::new("app.asar")
    );
    assert_eq!(fs::read(path.join("res/app.asar")).unwrap(), b"data");
    assert_eq!(
        fs::read_link(path.join("resources/back")).unwrap(),
        Path::new("../ChatGPT")
    );
    assert!(!path.join("usr").exists() && !path.join("etc").exists());
    assert!(!dir
        .path()
        .join("chatgpt/downloads/chatgpt_1.2.3_arm64.deb")
        .exists());
    assert_nothing_published_staging_clean(&dir);
    assert!(matches!(statuses.first(), Some(Status::Downloading { .. })));
    let tail: Vec<_> = statuses.iter().rev().take(3).rev().collect();
    assert_eq!(tail[0], &Status::Verifying);
    assert_eq!(tail[1], &Status::Extracting);
    assert!(matches!(tail[2], Status::Ready { version, .. } if version == "1.2.3"));
}

fn assert_nothing_published_staging_clean(dir: &tempfile::TempDir) {
    for entry in fs::read_dir(dir.path().join("chatgpt")).unwrap().flatten() {
        assert!(!entry.file_name().to_string_lossy().starts_with(".staging-"));
    }
}

#[test]
fn hash_mismatch_is_refused_and_discarded() {
    let dir = root();
    let package = deb(&good_items());
    let mut lock = lock_for(&package);
    lock.architectures.get_mut("arm64").unwrap().sha256 = "0".repeat(64);
    let (result, statuses) = run(&dir, &package, &lock);
    let error = result.unwrap_err();
    assert!(
        !error.retryable && error.message.contains("checksum"),
        "{error}"
    );
    assert!(matches!(
        statuses.last(),
        Some(Status::Failed {
            retryable: false,
            ..
        })
    ));
    assert!(!dir
        .path()
        .join("chatgpt/downloads/chatgpt_1.2.3_arm64.deb")
        .exists());
    assert_nothing_published(&dir);
}

#[test]
fn size_mismatch_is_refused_and_discarded() {
    let dir = root();
    let package = deb(&good_items());
    let mut lock = lock_for(&package);
    lock.architectures.get_mut("arm64").unwrap().bytes += 1;
    let (result, _) = run(&dir, &package, &lock);
    // The fake writes the real (shorter) bytes, so verification sees the size.
    let error = result.unwrap_err();
    assert!(error.retryable && error.message.contains("size"), "{error}");
    assert!(!dir
        .path()
        .join("chatgpt/downloads/chatgpt_1.2.3_arm64.deb")
        .exists());
    assert_nothing_published(&dir);
}

#[test]
fn malicious_entries_are_refused_and_publish_nothing() {
    let cases: Vec<(&str, Vec<Item>)> = vec![
        (
            "absolute",
            vec![Item::File("/usr/lib/chatgpt/ChatGPT", 0o755, b"x")],
        ),
        (
            "absolute elsewhere",
            vec![Item::File("/etc/passwd", 0o644, b"x")],
        ),
        (
            "dotdot",
            vec![Item::File("./usr/lib/chatgpt/../../../x", 0o644, b"x")],
        ),
        ("dotdot outside", vec![Item::File("../x", 0o644, b"x")]),
        (
            "symlink up out",
            vec![Item::Link("./usr/lib/chatgpt/l", "../../../..")],
        ),
        (
            "symlink at root up",
            vec![Item::Link("./usr/lib/chatgpt/l", "..")],
        ),
        (
            "symlink absolute",
            vec![Item::Link("./usr/lib/chatgpt/l", "/etc/passwd")],
        ),
        (
            "symlink via link",
            vec![
                Item::Link("./usr/lib/chatgpt/d", "."),
                Item::Link("./usr/lib/chatgpt/e", "d/../.."),
            ],
        ),
        (
            "write through symlink",
            vec![
                Item::File("./usr/lib/chatgpt/ChatGPT", 0o755, b"x"),
                Item::Link("./usr/lib/chatgpt/d", "."),
                Item::File("./usr/lib/chatgpt/d/evil", 0o644, b"x"),
            ],
        ),
        (
            "setuid",
            vec![Item::File("./usr/lib/chatgpt/ChatGPT", 0o4755, b"x")],
        ),
        ("setgid dir", vec![Item::Dir("./usr/lib/chatgpt/d", 0o2755)]),
        ("device", vec![Item::Device("./usr/lib/chatgpt/null")]),
        (
            "hard link",
            vec![
                Item::File("./usr/lib/chatgpt/ChatGPT", 0o755, b"x"),
                Item::Hard("./usr/lib/chatgpt/h", "./usr/lib/chatgpt/ChatGPT"),
            ],
        ),
        (
            "case collision",
            vec![
                Item::File("./usr/lib/chatgpt/ChatGPT", 0o755, b"x"),
                Item::File("./usr/lib/chatgpt/Readme", 0o644, b"a"),
                Item::File("./usr/lib/chatgpt/README", 0o644, b"b"),
            ],
        ),
        (
            "case collision in directory",
            vec![
                Item::File("./usr/lib/chatgpt/ChatGPT", 0o755, b"x"),
                Item::File("./usr/lib/chatgpt/Dir/a", 0o644, b"a"),
                Item::File("./usr/lib/chatgpt/dir/b", 0o644, b"b"),
            ],
        ),
        (
            "duplicate file",
            vec![
                Item::File("./usr/lib/chatgpt/ChatGPT", 0o755, b"x"),
                Item::File("./usr/lib/chatgpt/ChatGPT", 0o755, b"y"),
            ],
        ),
        (
            "no executable",
            vec![Item::File("./usr/lib/chatgpt/other", 0o644, b"x")],
        ),
    ];
    for (label, items) in cases {
        // The extractor itself, on the raw tar: bsdtar rewrites some hostile
        // names (for example it strips a leading `/`), dpkg-deb does not.
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("tree");
        fs::create_dir(&dest).unwrap();
        let error = extract_tree(&data_tar(&items)[..], &dest).expect_err(label);
        assert!(!error.retryable, "{label}: {error}");
        // Nothing was written outside the destination.
        let outside: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().collect();
        assert_eq!(outside.len(), 1, "{label}");
    }
}

#[test]
fn a_hostile_package_publishes_nothing() {
    for items in [
        vec![Item::File("./usr/lib/chatgpt/ChatGPT", 0o4755, b"x")],
        vec![Item::Device("./usr/lib/chatgpt/null")],
        vec![
            Item::File("./usr/lib/chatgpt/ChatGPT", 0o755, b"x"),
            Item::Link("./usr/lib/chatgpt/l", "../../.."),
        ],
    ] {
        let dir = root();
        let package = deb(&items);
        let (result, statuses) = run(&dir, &package, &lock_for(&package));
        assert!(!result.unwrap_err().retryable);
        assert!(matches!(
            statuses.last(),
            Some(Status::Failed {
                retryable: false,
                ..
            })
        ));
        assert_nothing_published(&dir);
    }
}

#[test]
fn damaged_published_folder_is_replaced_and_good_one_is_never_touched() {
    let dir = root();
    let package = deb(&good_items());
    let lock = lock_for(&package);
    let target = dir.path().join("chatgpt/1.2.3-arm64");
    fs::create_dir_all(target.join("partial")).unwrap();
    let (result, _) = run(&dir, &package, &lock);
    let path = result.unwrap();
    assert!(path.join("ChatGPT").is_file() && !path.join("partial").exists());
    // A published folder is returned as is, even if something was added to it.
    fs::write(path.join("marker"), b"kept").unwrap();
    let fake = Fake::new(Vec::new());
    let again = ensure(
        &dir.path().join("chatgpt"),
        &lock,
        DebArch::Arm64,
        &fake,
        &|_| {},
    )
    .unwrap();
    assert_eq!(again, path);
    assert_eq!(fs::read(path.join("marker")).unwrap(), b"kept");
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn concurrent_calls_download_and_extract_once() {
    let dir = root();
    let package = deb(&good_items());
    let lock = lock_for(&package);
    let mut fake = Fake::new(package);
    fake.delay = Duration::from_millis(300);
    let root = dir.path().join("chatgpt");
    let paths: Vec<PathBuf> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..4)
            .map(|_| scope.spawn(|| ensure(&root, &lock, DebArch::Arm64, &fake, &|_| {}).unwrap()))
            .collect();
        workers.into_iter().map(|w| w.join().unwrap()).collect()
    });
    assert!(paths.windows(2).all(|pair| pair[0] == pair[1]));
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn an_existing_complete_download_is_reused_after_an_interruption() {
    let dir = root();
    let package = deb(&good_items());
    let lock = lock_for(&package);
    let downloads = dir.path().join("chatgpt/downloads");
    fs::create_dir_all(&downloads).unwrap();
    fs::write(downloads.join("chatgpt_1.2.3_arm64.deb"), &package).unwrap();
    // A stale staging folder from a crash is removed.
    fs::create_dir_all(dir.path().join("chatgpt/.staging-old/x")).unwrap();
    let fake = Fake::new(Vec::new());
    ensure(
        &dir.path().join("chatgpt"),
        &lock,
        DebArch::Arm64,
        &fake,
        &|_| {},
    )
    .unwrap();
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
    assert_nothing_published_staging_clean(&dir);
}

#[test]
fn garbage_collection_keeps_pinned_and_in_use_versions() {
    let dir = root();
    let package = deb(&good_items());
    let lock = lock_for(&package);
    let (result, _) = run(&dir, &package, &lock);
    result.unwrap();
    let root = dir.path().join("chatgpt");
    for name in ["1.0.0-arm64", "1.1.0-arm64", "1.1.0-amd64"] {
        fs::create_dir_all(root.join(name).join("sub")).unwrap();
    }
    fs::create_dir_all(root.join("unrelated")).unwrap();
    fs::create_dir_all(root.join(".staging-x")).unwrap();
    let in_use = HashSet::from(["1.1.0-arm64".to_owned()]);
    let removed = collect_garbage(&root, &lock, DebArch::Arm64, &in_use).unwrap();
    assert_eq!(removed, ["1.0.0-arm64", "1.1.0-amd64"]);
    assert!(root.join("1.1.0-arm64").exists() && root.join("1.2.3-arm64/ChatGPT").exists());
    assert!(root.join("unrelated").exists() && !root.join(".staging-x").exists());
    assert!(
        collect_garbage(&dir.path().join("missing"), &lock, DebArch::Arm64, &in_use)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn path_and_link_rules() {
    assert_eq!(
        tree_components(b"./usr/lib/chatgpt/a/b").unwrap(),
        Some(vec!["a".into(), "b".into()])
    );
    assert_eq!(tree_components(b"usr/lib/chatgpt/").unwrap(), Some(vec![]));
    assert_eq!(tree_components(b"./usr/share/doc").unwrap(), None);
    assert!(tree_components(b"/usr/lib/chatgpt/a").is_err());
    assert!(tree_components(b"./usr/lib/chatgpt/a/../b").is_err());
    assert!(tree_components(b"./usr/../etc").is_err());
    assert!(check_link_target(b"../x", 1, "p").is_ok());
    assert!(check_link_target(b"../x", 0, "p").is_err());
    assert!(check_link_target(b"a/../x", 3, "p").is_err());
    assert!(check_link_target(b"/a", 3, "p").is_err());
    assert!(check_link_target(b"", 3, "p").is_err());
}

#[test]
fn status_serializes_for_the_ui() {
    let value = serde_json::to_value(Status::Downloading {
        received_bytes: 5,
        total_bytes: 10,
    })
    .unwrap();
    assert_eq!(
        value,
        serde_json::json!({"state": "downloading", "receivedBytes": 5, "totalBytes": 10})
    );
    let value = serde_json::to_value(Status::Failed {
        reason: "x".into(),
        retryable: true,
    })
    .unwrap();
    assert_eq!(
        value,
        serde_json::json!({"state": "failed", "reason": "x", "retryable": true})
    );
    assert_eq!(
        serde_json::to_value(Status::NotConsented).unwrap(),
        serde_json::json!({"state": "notConsented"})
    );
}

/// Opt-in: downloads the real pinned arm64 package from OpenAI (453 MB) into a
/// temporary directory and checks the extracted layout. Run with
/// `SILO_LIVE_TEST_CONFIRM=disposable-test-fixtures cargo test --locked
/// chatgpt_app::tests::live -- --ignored --nocapture`. Needs about 3 GB free.
#[test]
#[ignore = "downloads 453 MB from OpenAI and extracts about 1.5 GB"]
fn live_download_of_the_pinned_arm64_package() {
    crate::test_support::live::require_confirmation();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("chatgpt");
    accept_notice(&root).unwrap();
    let lock = Lock::bundled().unwrap();
    let started = Instant::now();
    let last = Mutex::new(None);
    let path = ensure(
        &root,
        &lock,
        DebArch::Arm64,
        &HttpDownloader::default(),
        &|s| {
            *last.lock().unwrap() = Some(s);
        },
    )
    .unwrap();
    println!("ready in {:?} at {}", started.elapsed(), path.display());
    assert_eq!(
        path,
        fs::canonicalize(root.join("26.928.31416-arm64")).unwrap()
    );
    let executable = path.join("ChatGPT");
    assert!(fs::metadata(&executable).unwrap().permissions().mode() & 0o111 != 0);
    assert!(path.join("resources").is_dir());
    assert!(path.join("resources/cua_node/manifest.json").is_file());
    assert!(!root
        .join("downloads/chatgpt_26.928.31416_arm64.deb")
        .exists());
    assert!(matches!(
        last.into_inner().unwrap(),
        Some(Status::Ready { .. })
    ));
    // Idempotent: a second call neither downloads nor changes anything.
    let again = ensure(
        &root,
        &lock,
        DebArch::Arm64,
        &Fake::new(Vec::new()),
        &|_| {},
    )
    .unwrap();
    assert_eq!(again, path);
}
