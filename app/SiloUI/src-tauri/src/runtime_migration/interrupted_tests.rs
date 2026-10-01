//! An export or import the previous Silo left unfinished must not hold the storage
//! migration back. The first launch of the upgrade settles it without the runtime
//! and without writing to the previous generation, a pre-upgrade backup; the
//! migration then proceeds, converts only the sandboxes saved in the settings, and
//! leaves the recorded result for the export and import page.
use super::*;
use std::collections::BTreeMap;

const VM_ID: &str = "fcfbc268-ae3f-40ff-8dfa-8af78911e52f";
const IMPORT_ID: &str = "0f6d5c1a-7a63-4b0a-9a36-4a6f1d3f6e11";
const GROUP: &str = "silo-import-0123456789abcdef0123456789abcdef";

fn one_vm(name: &str, id: &str) -> runtime::MachineConfigurationRequest {
    serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "machines": [{"kind":"vm","id":id,"name":name,"cpus":1,"maxCPUs":1,"memoryGiB":1,"maxMemoryGiB":1,"workspaceStorageGiB":1,"runtimeStorageGiB":1}]
    }))
    .unwrap()
}

/// A previous generation with one saved sandbox and the leftovers of an import that
/// never saved its own, plus the staged paths the converter would use.
fn previous_generation() -> (tempfile::TempDir, runtime::RuntimePaths) {
    // The runtime alias must keep Unix socket paths short, so use /tmp, not TMPDIR.
    let dir = tempfile::Builder::new()
        .prefix("si")
        .tempdir_in("/tmp")
        .unwrap();
    let app_data = dir.path();
    let old = app_data.join("runtime");
    fs::create_dir_all(old.join("volumes/dev")).unwrap();
    runtime::write_metadata(&old.join("machines.json"), &one_vm("dev", VM_ID)).unwrap();
    fs::write(old.join("volumes/dev/workspace.raw"), b"workspace").unwrap();
    fs::create_dir_all(old.join("volumes/copy")).unwrap();
    fs::write(old.join("volumes/copy/workspace.raw"), b"partial disk").unwrap();
    fs::create_dir_all(old.join("microsandbox/db")).unwrap();
    fs::write(old.join("microsandbox/db/msb.db"), b"released database").unwrap();
    let stage =
        old.join("microsandbox/snapshots/.msb-snapshot-load-0123456789abcdef0123456789abcdef");
    fs::create_dir_all(stage.join("partial")).unwrap();
    let storage = app_data.join(CONVERTED);
    let storage_home = storage.join("microsandbox");
    let paths = runtime::RuntimePaths {
        guest_image: app_data.join("guest-image"),
        executable: app_data.join("msb"),
        home: runtime::runtime_home_alias(app_data, &storage_home),
        storage_home: Some(storage_home),
        library: app_data.join("libkrunfw"),
        metadata: storage.join("machines.json"),
        volumes: storage.join("volumes"),
    };
    (dir, paths)
}

/// The paths recovery gets while the migration blocks the runtime: the previous
/// generation's files and no way to start `msb`.
fn inert_paths(app_data: &Path) -> runtime::RuntimePaths {
    let old = app_data.join("runtime");
    let storage_home = old.join("microsandbox");
    runtime::without_runtime(runtime::RuntimePaths {
        guest_image: app_data.join("guest-image"),
        executable: app_data.join("msb"),
        home: runtime::runtime_home_alias(app_data, &storage_home),
        storage_home: Some(storage_home),
        library: app_data.join("libkrunfw"),
        metadata: old.join("machines.json"),
        volumes: old.join("volumes"),
    })
}

/// Every entry under `root` with its bytes, link target or a directory marker.
fn tree(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut entries = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(&directory).unwrap() {
            let path = entry.unwrap().path();
            let metadata = fs::symlink_metadata(&path).unwrap();
            let value = if metadata.file_type().is_symlink() {
                fs::read_link(&path)
                    .unwrap()
                    .into_os_string()
                    .into_encoded_bytes()
            } else if metadata.is_dir() {
                stack.push(path.clone());
                b"<directory>".to_vec()
            } else {
                fs::read(&path).unwrap()
            };
            entries.insert(path.strip_prefix(root).unwrap().to_path_buf(), value);
        }
    }
    entries
}

/// The staged runtime: every sandbox is stopped, and `adopt-disk` makes its disk owned.
struct StagedRuntime {
    old_runtime: PathBuf,
    calls: Mutex<Vec<String>>,
}
impl runtime::RuntimeRunner for StagedRuntime {
    fn run(
        &self,
        _: &runtime::RuntimePaths,
        args: &[String],
        _: Duration,
    ) -> Result<runtime::CommandOutput, runtime::RuntimeError> {
        let mut calls = self.calls.lock().unwrap();
        calls.push(args.join(" "));
        let mount = if calls.iter().any(|call| call.starts_with("adopt-disk")) {
            serde_json::json!({"guest":"/workspace","type":"Owned"})
        } else {
            serde_json::json!({"guest":"/workspace","type":"DiskImage","host":self.old_runtime.join("volumes/dev/workspace.raw")})
        };
        Ok(runtime::CommandOutput {
            stdout: serde_json::json!({"name":"dev","status":"Stopped","config":{"labels":{"silo.machine-id":VM_ID},"mounts":[mount]}}).to_string(),
            stderr: String::new(),
        })
    }
}

/// The journal a Silo build writes while an operation is unfinished.
fn pending_journal(app_data: &Path, request: serde_json::Value) {
    let archive = app_data.join("exports/dev.silo-backup");
    let journal = serde_json::json!({
        "version": 1,
        "id": "5b0c8e3e-3b8e-4c4c-9a0b-1f0f5f2d2b77",
        "archive": {
            "name": "dev.silo-backup",
            "archivePath": archive,
            "completedLabel": "In progress",
            "size": "Unknown",
            "destination": archive.parent().unwrap(),
            "sandboxes": ["dev"],
        },
        "request": request,
        "cancelled": false,
        "terminal": null,
    });
    fs::write(app_data.join("backup-operation.json"), journal.to_string()).unwrap();
}

#[test]
fn an_unfinished_operation_no_longer_blocks_the_conversion_and_is_never_converted() {
    let cases = [
        (
            "import by the released 0.9.0 that wrote its disk",
            serde_json::json!({"kind":"restore","name":"copy","source":"dev","id":IMPORT_ID}),
            "Import interrupted before the upgrade",
            "No sandbox was added. Silo did not clean up the data it had started. Import the file again, under another name if Silo says the name is taken.",
        ),
        (
            "import of a development build that loaded a snapshot group",
            serde_json::json!({"kind":"restore","name":"copy","source":"dev","id":IMPORT_ID,"group":GROUP}),
            "Import interrupted before the upgrade",
            "No sandbox was added. Silo did not clean up the data it had started. Import the file again, under another name if Silo says the name is taken.",
        ),
        (
            "export of a development build in the middle of a capture",
            serde_json::json!({"kind":"backup","names":["dev"],"machines":[],"running":[],"pending_capture":{"workspaceId":VM_ID,"group":"dev","member":"silo-backup-0-1-2"}}),
            "Export interrupted before the upgrade",
            "No export file was saved. Silo did not clean up the data it had started. Export the sandbox again.",
        ),
    ];
    for (state, request, title, detail) in cases {
        let (dir, paths) = previous_generation();
        let app_data = dir.path();
        let old = app_data.join("runtime");
        pending_journal(app_data, request);
        let runner = StagedRuntime {
            old_runtime: old.clone(),
            calls: Mutex::new(Vec::new()),
        };
        // The safety net: a journal still pending refuses the conversion.
        let refusal = convert_with(&runner, app_data, &paths, &|_| Ok(())).unwrap_err();
        assert!(refusal.contains("interrupted backup"), "{state}: {refusal}");
        assert!(runner.calls.lock().unwrap().is_empty(), "{state}");
        let before = tree(&old);

        // First launch of the upgrade: recovery settles it without the runtime.
        let result = crate::backup_controller::settle_journal_before_migration(
            app_data,
            &inert_paths(app_data),
        )
        .expect("the journal is pending");
        assert_eq!(result["outcome"], "failed", "{state}");
        assert_eq!(result["title"], title, "{state}");
        assert_eq!(result["detail"], detail, "{state}");
        assert_eq!(
            tree(&old),
            before,
            "{state}: recovery left the backup as it was"
        );

        // The migration now proceeds, and only the saved sandbox is converted.
        convert_with(&runner, app_data, &paths, &|_| Ok(())).unwrap();
        assert_eq!(
            *runner.calls.lock().unwrap(),
            [
                "inspect dev --format json",
                "adopt-disk dev",
                "inspect dev --format json"
            ],
            "{state}"
        );
        let converted =
            runtime::read_metadata(&app_data.join(CONVERTED).join("machines.json")).unwrap();
        assert_eq!(converted.machines.len(), 1, "{state}");
        assert_eq!(converted.machines[0].name(), "dev", "{state}");
        assert_eq!(
            selected_runtime_storage(app_data).unwrap(),
            app_data.join(CONVERTED),
            "{state}"
        );
        // The previous generation is byte-identical after the whole migration, and the
        // result stays for the export and import page to show after the upgrade.
        assert_eq!(
            tree(&old),
            before,
            "{state}: the pre-upgrade backup is an exact copy"
        );
        let journal: serde_json::Value =
            serde_json::from_slice(&fs::read(app_data.join("backup-operation.json")).unwrap())
                .unwrap();
        assert_eq!(journal["terminal"]["title"], title, "{state}");
        assert!(
            !old.join("before-checkpoints-backup-operation.json")
                .exists(),
            "{state}"
        );
    }
}

#[test]
fn a_journal_with_a_result_stays_for_the_export_page_but_pending_progress_is_isolated() {
    let dir = tempfile::tempdir().unwrap();
    let app_data = dir.path();
    let old = app_data.join("runtime");
    fs::create_dir(&old).unwrap();
    let journal = app_data.join("backup-operation.json");
    fs::write(&journal, br#"{"terminal":{"outcome":"failed"}}"#).unwrap();
    quarantine_previous_backup_state(app_data).unwrap();
    assert!(
        journal.exists(),
        "a result nothing can resume is not hidden from the user"
    );
    assert!(!old
        .join("before-checkpoints-backup-operation.json")
        .exists());

    fs::write(&journal, br#"{"terminal":null}"#).unwrap();
    quarantine_previous_backup_state(app_data).unwrap();
    assert!(!journal.exists());
    assert_eq!(
        fs::read(old.join("before-checkpoints-backup-operation.json")).unwrap(),
        br#"{"terminal":null}"#
    );

    // An unreadable file is not known to be finished, so it is isolated too.
    fs::remove_file(old.join("before-checkpoints-backup-operation.json")).unwrap();
    fs::write(&journal, b"{not json").unwrap();
    quarantine_previous_backup_state(app_data).unwrap();
    assert!(!journal.exists());
}
