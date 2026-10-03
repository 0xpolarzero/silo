use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Arc,
};

fn never() -> Result<(), Failure> {
    panic!("nothing should run");
}

#[test]
fn a_ready_job_runs_nothing_and_announces_itself_once() {
    let job = Job::new();
    let changes = AtomicUsize::new(0);
    let change = || {
        changes.fetch_add(1, Ordering::SeqCst);
    };
    for _ in 0..3 {
        job.ensure(&|| true, &|_| never(), &change, &|_| {})
            .unwrap();
    }
    assert_eq!(job.task().state, TaskState::Ready);
    assert_eq!(changes.load(Ordering::SeqCst), 1);
}

#[test]
fn a_caller_joins_the_run_in_flight_instead_of_starting_another() {
    let job = Arc::new(Job::new());
    let runs = Arc::new(AtomicUsize::new(0));
    let (started_sender, started) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let first = {
        let (job, runs) = (job.clone(), runs.clone());
        std::thread::spawn(move || {
            job.ensure(
                &|| false,
                &|report| {
                    runs.fetch_add(1, Ordering::SeqCst);
                    report(Some(40));
                    started_sender.send(()).unwrap();
                    released.recv().unwrap();
                    Ok(())
                },
                &|| {},
                &|_| {},
            )
        })
    };
    started.recv().unwrap();
    assert_eq!(job.task().state, TaskState::Running);
    assert_eq!(job.task().fraction, Some(40));
    let reported = Arc::new(Mutex::new(Vec::new()));
    let second = {
        let (job, reported) = (job.clone(), reported.clone());
        std::thread::spawn(move || {
            job.ensure(
                &|| panic!("a joiner does not check"),
                &|_| never(),
                &|| {},
                &|fraction| reported.lock().unwrap().push(fraction),
            )
        })
    };
    while reported.lock().unwrap().is_empty() {
        std::thread::yield_now();
    }
    release.send(()).unwrap();
    assert_eq!(first.join().unwrap(), Ok(()));
    assert_eq!(second.join().unwrap(), Ok(()));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert_eq!(reported.lock().unwrap()[0], Some(40));
    assert_eq!(job.task(), PreparationTask::new(TaskState::Ready));
}

#[test]
fn a_failure_is_kept_for_the_ui_and_the_next_call_retries() {
    let job = Job::new();
    let error = job
        .ensure(
            &|| false,
            &|_| {
                Err(Failure {
                    message: "No space left.".into(),
                    retryable: false,
                })
            },
            &|| {},
            &|_| {},
        )
        .unwrap_err();
    assert_eq!(error, "No space left.");
    let task = job.task();
    assert_eq!(task.state, TaskState::Failed);
    assert_eq!(task.message.as_deref(), Some("No space left."));
    assert!(!task.retryable);
    job.ensure(&|| false, &|_| Ok(()), &|| {}, &|_| {}).unwrap();
    assert_eq!(job.task(), PreparationTask::new(TaskState::Ready));
}

#[test]
fn a_joiner_of_a_failed_run_gets_its_failure() {
    let job = Arc::new(Job::new());
    let (started_sender, started) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let first = {
        let job = job.clone();
        std::thread::spawn(move || {
            job.ensure(
                &|| false,
                &|_| {
                    started_sender.send(()).unwrap();
                    released.recv().unwrap();
                    Err("Disk full.".to_owned().into())
                },
                &|| {},
                &|_| {},
            )
        })
    };
    started.recv().unwrap();
    let waiting = Arc::new(AtomicUsize::new(0));
    let second = {
        let (job, waiting) = (job.clone(), waiting.clone());
        std::thread::spawn(move || {
            job.ensure(&|| false, &|_| never(), &|| {}, &|_| {
                waiting.fetch_add(1, Ordering::SeqCst);
            })
        })
    };
    while waiting.load(Ordering::SeqCst) == 0 {
        std::thread::yield_now();
    }
    release.send(()).unwrap();
    assert_eq!(first.join().unwrap(), Err("Disk full.".into()));
    assert_eq!(second.join().unwrap(), Err("Disk full.".into()));
}

#[test]
fn a_panicking_run_releases_the_job() {
    let job = Job::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = job.ensure(&|| false, &|_| panic!("boom"), &|| {}, &|_| {});
    }));
    assert!(result.is_err());
    assert_eq!(job.task().state, TaskState::Failed);
    job.ensure(&|| true, &|_| never(), &|| {}, &|_| {}).unwrap();
}

#[test]
fn the_status_serializes_with_the_documented_names() {
    let value = serde_json::to_value(PreparationStatus {
        image: PreparationTask {
            state: TaskState::Running,
            fraction: Some(5),
            message: None,
            retryable: false,
        },
        lcu: PreparationTask::new(TaskState::Pending),
    })
    .unwrap();
    assert_eq!(value["image"]["state"], "running");
    assert_eq!(value["image"]["fraction"], 5);
    assert_eq!(value["lcu"]["state"], "pending");
    assert_eq!(value["lcu"]["retryable"], false);
}

// ------------------------------------------------------------------ LCU

const BODY: &[u8] = b"pinned lcu archive";

fn spec(version: &str) -> LcuSpec {
    use sha2::{Digest, Sha256};
    LcuSpec {
        version: version.into(),
        archive: format!("lcu-{version}-linux-x64.tar.gz"),
        url: format!("https://example.test/lcu-{version}-linux-x64.tar.gz"),
        sha256: format!("{:x}", Sha256::digest(BODY)),
    }
}

struct Fake {
    body: Vec<u8>,
    error: Option<chatgpt_app::Error>,
    calls: AtomicUsize,
}

impl Fake {
    fn serving(body: &[u8]) -> Self {
        Self {
            body: body.to_vec(),
            error: None,
            calls: AtomicUsize::new(0),
        }
    }
}

impl Downloader for Fake {
    fn fetch(
        &self,
        url: &str,
        part: &Path,
        total: u64,
        _progress: &mut dyn FnMut(u64),
    ) -> Result<(), chatgpt_app::Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(url.starts_with("https://"));
        assert_eq!(total, 0, "the archive size is not pinned");
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        fs::write(part, &self.body).unwrap();
        Ok(())
    }
}

fn error(retryable: bool) -> chatgpt_app::Error {
    chatgpt_app::Error {
        message: "OpenAI-specific text".into(),
        retryable,
    }
}

fn part_of(root: &Path, spec: &LcuSpec) -> PathBuf {
    root.join(DOWNLOAD_DIR)
        .join(format!("{}.part", spec.archive))
}

#[test]
fn the_bundled_lock_names_an_https_archive_for_each_architecture() {
    for arch in [DebArch::Arm64, DebArch::Amd64] {
        let spec = LcuSpec::parse(LCU_LOCK, arch).unwrap();
        assert!(spec.url.ends_with(&spec.archive));
        assert!(spec.archive.contains(&spec.version));
    }
    let plain = LCU_LOCK.replace("https://", "http://");
    assert!(LcuSpec::parse(&plain, DebArch::Amd64).is_err());
    let traversal = LCU_LOCK.replace("lcu-0.8.8-linux-x64.tar.gz", "..");
    assert!(LcuSpec::parse(&traversal, DebArch::Amd64).is_err());
}

#[test]
fn a_verified_archive_is_published_read_only_and_older_versions_are_removed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lcu");
    let old = spec("0.8.1");
    fs::create_dir_all(root.join(&old.version)).unwrap();
    fs::write(root.join(&old.version).join(&old.archive), b"old").unwrap();
    fs::create_dir_all(root.join(".publish-1-1")).unwrap();
    let current = spec("0.8.8");
    assert!(published(&root, &current).is_none());
    let downloader = Fake::serving(BODY);
    download_and_publish(&root, &current, &downloader)
        .map_err(|f| f.message)
        .unwrap();
    let folder = published(&root, &current).unwrap();
    assert_eq!(folder, root.join("0.8.8"));
    let file = folder.join(&current.archive);
    assert_eq!(fs::read(&file).unwrap(), BODY);
    assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o222, 0);
    assert_eq!(
        fs::metadata(&folder).unwrap().permissions().mode() & 0o222,
        0
    );
    assert!(!root.join("0.8.1").exists());
    assert!(!root.join(".publish-1-1").exists());
    assert!(!part_of(&root, &current).exists());
    // A later run replaces the published copy and ends read-only again.
    download_and_publish(&root, &current, &downloader)
        .map_err(|f| f.message)
        .unwrap();
    assert!(published(&root, &current).is_some());
    remove_tree(&root);
}

#[test]
fn an_archive_that_fails_its_checksum_is_discarded_and_not_published() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lcu");
    let current = spec("0.8.8");
    let failure = download_and_publish(&root, &current, &Fake::serving(b"tampered"))
        .err()
        .unwrap();
    assert!(failure.retryable);
    assert!(failure.message.contains("checksum"));
    assert!(published(&root, &current).is_none());
    assert!(!root.join("0.8.8").exists());
    assert!(!part_of(&root, &current).exists());
}

#[test]
fn a_published_archive_that_changed_is_no_longer_ready() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lcu");
    let current = spec("0.8.8");
    download_and_publish(&root, &current, &Fake::serving(BODY))
        .map_err(|f| f.message)
        .unwrap();
    let folder = root.join("0.8.8");
    fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
    let file = folder.join(&current.archive);
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    fs::write(&file, b"another file of the same size").unwrap();
    assert!(published(&root, &current).is_none());
    remove_tree(&root);
}

#[test]
fn download_failures_say_what_to_do_without_naming_another_vendor() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lcu");
    let current = spec("0.8.8");
    let mut downloader = Fake::serving(BODY);
    downloader.error = Some(error(true));
    let transient = download_and_publish(&root, &current, &downloader)
        .err()
        .unwrap();
    assert!(transient.retryable);
    assert!(transient.message.contains("retry") && !transient.message.contains("OpenAI"));
    downloader.error = Some(error(false));
    let removed = download_and_publish(&root, &current, &downloader)
        .err()
        .unwrap();
    assert!(!removed.retryable);
    assert!(removed.message.contains("Update Silo"));
}

#[test]
fn ensuring_the_archive_through_a_job_downloads_once_then_is_ready() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("lcu");
    let current = spec("0.8.8");
    let job = Job::new();
    let downloader = Fake::serving(BODY);
    for _ in 0..2 {
        job.ensure(
            &|| published(&root, &current).is_some(),
            &|_| download_and_publish(&root, &current, &downloader),
            &|| {},
            &|_| {},
        )
        .unwrap();
    }
    assert_eq!(downloader.calls.load(Ordering::SeqCst), 1);
    remove_tree(&root);
}
