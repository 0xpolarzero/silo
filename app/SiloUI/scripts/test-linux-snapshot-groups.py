#!/usr/bin/env python3
"""Exercise persisted snapshot-group policy through the packaged Silo app.

This is an opt-in live test. It imports one verified archive into the same
isolated MSB_HOME, forks that imported workspace, then exports each source
twice through production Tauri IPC. It never uses a fixture-only backend.
"""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
from channel_names import channel_for_identifier
import secrets
import shutil
import socket
import subprocess
import time

from selenium import webdriver
from selenium.common.exceptions import StaleElementReferenceException
from selenium.webdriver.common.options import BaseOptions
from selenium.webdriver.support.ui import WebDriverWait


ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = Path(os.environ.get("SILO_LINUX_EVIDENCE", ""))
APPLICATION = Path(os.environ.get("SILO_LINUX_APPLICATION", ""))
ARCHIVE_DESTINATION = Path(os.environ.get("SILO_LINUX_ARCHIVE_DESTINATION", ""))
FIXTURE_ROOT = Path(os.environ.get("SILO_LINUX_FIXTURE_ROOT", ""))
SOURCE_NAME = os.environ.get("SILO_LINUX_SOURCE_NAME", "")
APPLICATION_ID = os.environ.get("SILO_LINUX_APPLICATION_ID", "")
MSB = Path(os.environ.get("SILO_LINUX_MSB", ""))
MSB_LIBRARY = Path(os.environ.get("SILO_LINUX_MSB_LIBRARY", ""))
EXPECTED_CPUS = os.environ.get("SILO_LINUX_EXPECTED_CPUS", "")
EXPECTED_MEMORY_GIB = os.environ.get("SILO_LINUX_EXPECTED_MEMORY_GIB", "")
EXPECTED_ROOT_GIB = os.environ.get("SILO_LINUX_EXPECTED_ROOT_GIB", "")


class Options(BaseOptions):
    _ignore_local_proxy = True

    @property
    def default_capabilities(self):
        return {}

    def to_capabilities(self):
        return {"tauri:options": {"application": str(APPLICATION)}}


def validate_environment():
    for variable, path in (("SILO_LINUX_EVIDENCE", EVIDENCE),
                           ("SILO_LINUX_APPLICATION", APPLICATION),
                           ("SILO_LINUX_ARCHIVE_DESTINATION", ARCHIVE_DESTINATION),
                           ("SILO_LINUX_FIXTURE_ROOT", FIXTURE_ROOT)):
        if not os.environ.get(variable):
            raise RuntimeError(f"{variable} is required")
    if not APPLICATION.is_file() or not os.access(APPLICATION, os.X_OK):
        raise RuntimeError("SILO_LINUX_APPLICATION must name the exact executable AppRun")
    root = FIXTURE_ROOT.resolve(strict=True)
    if root == Path("/") or not root.is_dir() or not root.name.startswith("silo-linux-"):
        raise RuntimeError("SILO_LINUX_FIXTURE_ROOT must be the dedicated task-owned Linux fixture directory")
    if not ARCHIVE_DESTINATION.is_dir() or not EVIDENCE.is_dir():
        raise RuntimeError("Evidence and archive destination directories must already exist")
    if not SOURCE_NAME or not APPLICATION_ID:
        raise RuntimeError("SILO_LINUX_SOURCE_NAME and SILO_LINUX_APPLICATION_ID are required")
    if not MSB.is_file() or not MSB_LIBRARY.is_file():
        raise RuntimeError("SILO_LINUX_MSB and SILO_LINUX_MSB_LIBRARY must name the exact packaged runtime files")
    try:
        expected = (int(EXPECTED_CPUS), int(EXPECTED_MEMORY_GIB), int(EXPECTED_ROOT_GIB))
    except ValueError as error:
        raise RuntimeError("SILO_LINUX_EXPECTED_CPUS, SILO_LINUX_EXPECTED_MEMORY_GIB, and SILO_LINUX_EXPECTED_ROOT_GIB are required integer fixture values") from error
    if any(value <= 0 for value in expected):
        raise RuntimeError("Expected resource values must be positive")
    roots = []
    for variable in ("XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"):
        value = os.environ.get(variable)
        if not value:
            raise RuntimeError(f"{variable} is required")
        path = Path(value).resolve(strict=True)
        if not path.is_relative_to(root):
            raise RuntimeError(f"{variable} must stay inside SILO_LINUX_FIXTURE_ROOT")
    for path in (ARCHIVE_DESTINATION.resolve(strict=True), EVIDENCE.resolve(strict=True)):
        if not path.is_relative_to(root):
            raise RuntimeError(f"Qualification artifact escapes task fixture: {path}")
    return root


def launch_driver(environment):
    driver_path = shutil.which("tauri-driver")
    if not driver_path:
        raise RuntimeError("tauri-driver 2.0.6 is required")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        native_port = probe.getsockname()[1]
    output_path = EVIDENCE / f"snapshot-groups-driver-{secrets.token_hex(3)}.log"
    output = output_path.open("w")
    process = subprocess.Popen(
        [driver_path, "--port", str(port), "--native-port", str(native_port)],
        env=environment, stdout=output, stderr=subprocess.STDOUT,
    )
    try:
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    with socket.create_connection(("127.0.0.1", native_port), timeout=1):
                        break
            except OSError:
                if process.poll() is not None:
                    raise RuntimeError(f"tauri-driver exited; see {output_path}")
                time.sleep(.1)
        else:
            raise RuntimeError(f"tauri-driver did not become ready; see {output_path}")
        browser = webdriver.Remote(f"http://127.0.0.1:{port}", options=Options())
        wait = WebDriverWait(browser, 60, ignored_exceptions=(StaleElementReferenceException,))
        def main_window(_):
            for handle in browser.window_handles:
                browser.switch_to.window(handle)
                if "native-status" not in browser.current_url:
                    return browser.execute_script("return typeof window.__TAURI_INTERNALS__ !== 'undefined'")
            return False
        wait.until(main_window)
        return browser, process, output
    except Exception:
        process.terminate()
        output.close()
        raise


def invoke(browser, command, arguments=None, timeout=300):
    browser.set_script_timeout(timeout)
    result = browser.execute_async_script(
        "const done=arguments[arguments.length-1];"
        "window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]||{})"
        ".then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}));",
        command, arguments or {},
    )
    if not result["ok"]:
        raise RuntimeError(f"{command} failed: {result['error']}")
    return result["value"]


def operation_result(browser, operation, previous_operation_id, previous_archives=None):
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        state = invoke(browser, "read_backup_state")
        result = state.get("operation") or {}
        if (state.get("operationId") != previous_operation_id
                and result.get("kind") == "result" and result.get("operation") == operation):
            if result.get("outcome") != "success":
                raise RuntimeError(f"{operation} failed: {result.get('message')} / {result.get('detail')}")
            paths = set(ARCHIVE_DESTINATION.glob("*.silo-backup"))
            if previous_archives is None or paths - previous_archives:
                return state
        time.sleep(1)
    raise TimeoutError(f"Timed out waiting for {operation}; inspect Silo's persisted operation state")


def records_for_state(state):
    result = {}
    for workspace in state["workspaces"]:
        machine = workspace["machine"]
        if machine.get("kind") == "vm" or "vm" in machine:
            result[machine["name"]] = workspace
    return result


def checkpoint_record(workspace):
    # Tauri's machine config serializes the stable workspace UUID as `id`.
    app_data = Path(os.environ["XDG_DATA_HOME"]) / APPLICATION_ID
    generation_path = app_data / "runtime-generation.json"
    generation = json.loads(generation_path.read_text())["directory"] if generation_path.exists() else "runtime"
    if generation not in {"runtime", "runtime-checkpoints-clean", "runtime-checkpoints-converted"}:
        raise AssertionError(f"Unsupported selected runtime generation: {generation!r}")
    record_path = app_data / generation / "checkpoints" / f"{workspace['machine']['id']}.json"
    data = json.loads(record_path.read_text())
    return record_path, data


def snapshot_record(workspace):
    record_path, data = checkpoint_record(workspace)
    group = data.get("snapshotGroup")
    if not isinstance(group, str) or not group:
        raise AssertionError(f"{workspace['machine']['name']} has no persisted snapshotGroup")
    return record_path, data, group


def verify_vm_capacity(workspace):
    """Check Silo metadata, native config, and the physical root image size."""
    machine = workspace["machine"]
    name = machine["name"]
    expected_cpus = int(EXPECTED_CPUS)
    expected_memory_gib = int(EXPECTED_MEMORY_GIB)
    expected_root_gib = int(EXPECTED_ROOT_GIB)
    if (machine.get("runtimeStorageGiB") != expected_root_gib
            or machine.get("cpus") != expected_cpus
            or machine.get("memoryGiB") != expected_memory_gib):
        raise AssertionError(f"{name} saved resources differ from {expected_cpus}CPU/{expected_memory_gib}GiB/{expected_root_gib}GiB fixture: {machine}")

    app_data = Path(os.environ["XDG_DATA_HOME"]) / APPLICATION_ID
    generation_path = app_data / "runtime-generation.json"
    generation = json.loads(generation_path.read_text())["directory"] if generation_path.exists() else "runtime"
    storage_home = app_data / generation / "microsandbox"
    digest = hashlib.sha256(os.fsencode(str(storage_home))).hexdigest()[:12]
    runtime_home = Path(os.environ["HOME"]) / channel_for_identifier(APPLICATION_ID)["stateDir"] / digest
    runtime_env = {
        **os.environ,
        "MSB_HOME": str(runtime_home),
        "MSB_PATH": str(MSB),
        "MSB_LIBKRUNFW_PATH": str(MSB_LIBRARY),
    }
    inspected = subprocess.run(
        [str(MSB), "inspect", name, "--format", "json"], env=runtime_env,
        check=True, capture_output=True, text=True, timeout=45,
    )
    native = json.loads(inspected.stdout)
    config = native["config"]
    actual = (
        config.get("resources", {}).get("cpus"),
        config.get("resources", {}).get("memory_mib"),
        config.get("image", {}).get("Oci", {}).get("root_disk", {}).get("size_mib"),
    )
    expected = (expected_cpus, expected_memory_gib * 1024, expected_root_gib * 1024)
    if actual != expected:
        raise AssertionError(f"{name} native resources {actual} differ from {expected}; inspect={config}")

    root_image = runtime_home / "sandboxes" / name / "upper.ext4"
    if not root_image.is_file():
        raise AssertionError(f"Native inspect matched but root image is absent at the runtime's recorded upper-layer path: {root_image}")
    image_info = subprocess.run(
        ["qemu-img", "info", "--output=json", str(root_image)], env=runtime_env,
        check=True, capture_output=True, text=True, timeout=45,
    )
    image = json.loads(image_info.stdout)
    expected_virtual_size = expected_root_gib * 1024 ** 3
    if image.get("virtual-size") != expected_virtual_size:
        raise AssertionError(f"{name} root virtual size is {image.get('virtual-size')}, expected {expected_virtual_size}")
    return {
        "name": name,
        "saved": {"cpus": machine["cpus"], "memoryGiB": machine["memoryGiB"], "runtimeStorageGiB": machine["runtimeStorageGiB"]},
        "native": {"cpus": actual[0], "memory_mib": actual[1], "root_size_mib": actual[2]},
        "rootImage": str(root_image),
        "rootVirtualSizeBytes": image["virtual-size"],
        "rootImageFormat": image.get("format"),
    }


def read_state(browser):
    deadline = time.monotonic() + 15
    while True:
        try:
            return invoke(browser, "read_application_state")
        except RuntimeError as error:
            if "SILO_SANDBOX_UPDATE_IN_PROGRESS" not in str(error) or time.monotonic() >= deadline:
                raise
            time.sleep(.25)


def seed_archive_for_run(browser):
    resumed = os.environ.get("SILO_LINUX_SEED_ARCHIVE")
    if not resumed:
        return export_seed(browser, SOURCE_NAME)
    archive = Path(resumed).resolve(strict=True)
    if not archive.is_relative_to(ARCHIVE_DESTINATION.resolve(strict=True)):
        raise RuntimeError("SILO_LINUX_SEED_ARCHIVE must be inside the task archive destination")
    if archive.suffix != ".silo-backup":
        raise RuntimeError("SILO_LINUX_SEED_ARCHIVE must be a .silo-backup file")
    inspection = invoke(browser, "inspect_backup_archive", {"archivePath": str(archive)})
    if not inspection.get("valid") or inspection.get("archive", {}).get("sandboxes") != [SOURCE_NAME]:
        raise AssertionError(f"Resumed seed archive is invalid: {inspection}")
    return archive


def start_stop(browser, name):
    invoke(browser, "workspace_action", {"action": "start", "name": name, "path": None})
    state = records_for_state(read_state(browser))
    if name not in state or state[name]["state"] != "running":
        raise AssertionError(f"{name} did not start: {state.get(name)}")
    invoke(browser, "workspace_action", {"action": "stop", "name": name, "path": None})
    state = records_for_state(read_state(browser))
    if name not in state or state[name]["state"] != "stopped":
        raise AssertionError(f"{name} did not stop: {state.get(name)}")
    return state[name]


def export_twice(browser, name, expected_group, evidence):
    for attempt in (1, 2):
        record_path, record, group = snapshot_record(records_for_state(read_state(browser))[name])
        if group != expected_group:
            raise AssertionError(f"{name} group changed before export {attempt}: {group} != {expected_group}")
        previous = set(ARCHIVE_DESTINATION.glob("*.silo-backup"))
        state = invoke(browser, "read_backup_state")
        if Path(state.get("destination") or "").resolve() != ARCHIVE_DESTINATION.resolve():
            raise AssertionError(f"The production Backup page destination is not selected: {state}")
        operation_id = state.get("operationId")
        invoke(browser, "start_backup", {
            "destination": str(ARCHIVE_DESTINATION), "sandboxes": [name],
        })
        operation_result(browser, "backup", operation_id, previous)
        created = sorted(set(ARCHIVE_DESTINATION.glob("*.silo-backup")) - previous)
        if len(created) != 1:
            raise AssertionError(f"Expected one new archive for {name} export {attempt}; found {created}")
        archive = created[0]
        inspection = invoke(browser, "inspect_backup_archive", {"archivePath": str(archive)})
        if not inspection.get("valid") or inspection.get("archive", {}).get("sandboxes") != [name]:
            raise AssertionError(f"Archive validation failed for {name} export {attempt}: {inspection}")
        evidence.append({
            "workspace": name, "attempt": attempt, "snapshotGroup": group,
            "archiveBytes": archive.stat().st_size,
            "archiveName": archive.name,
            "recordPath": str(record_path),
            "checkpointCount": len(record.get("checkpoints", [])),
        })
        archive.unlink()


def export_seed(browser, name):
    state = invoke(browser, "read_backup_state")
    if Path(state.get("destination") or "").resolve() != ARCHIVE_DESTINATION.resolve():
        raise AssertionError(f"The production Backup page destination is not selected: {state}")
    previous = set(ARCHIVE_DESTINATION.glob("*.silo-backup"))
    previous_operation_id = state.get("operationId")
    invoke(browser, "start_backup", {
        "destination": str(ARCHIVE_DESTINATION), "sandboxes": [name],
    })
    operation_result(browser, "backup", previous_operation_id, previous)
    created = sorted(set(ARCHIVE_DESTINATION.glob("*.silo-backup")) - previous)
    if len(created) != 1:
        raise AssertionError(f"Expected one seed archive for {name}; found {created}")
    archive = created[0]
    inspection = invoke(browser, "inspect_backup_archive", {"archivePath": str(archive)})
    if not inspection.get("valid") or inspection.get("archive", {}).get("sandboxes") != [name]:
        raise AssertionError(f"Seed archive is invalid: {inspection}")
    return archive


def run():
    fixture_root = validate_environment()
    evidence = {
        "passed": False,
        "fixtureRoot": str(fixture_root),
        "source": SOURCE_NAME,
        "results": [],
    }
    environment = dict(os.environ)
    report_path = EVIDENCE / "snapshot-groups-result.json"
    stop_app = None
    spec = importlib.util.spec_from_file_location("linux_desktop_helpers", ROOT / "scripts/test-linux-desktop.py")
    helper_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper_module)
    stop_app = helper_module.stop_test_app
    browser = process = output = None
    try:
        print("[snapshot-groups] attach to the exact packaged app", flush=True)
        browser, process, output = launch_driver(environment)
        state = read_state(browser)
        workspaces = records_for_state(state)
        if SOURCE_NAME not in workspaces:
            raise AssertionError(f"Expected source {SOURCE_NAME}; found {sorted(workspaces)}")

        # Create and inspect one production archive, then import it once into
        # the same runtime home while the original lineage remains present.
        # The first capture initializes the source's persistent group.
        resumed_seed = os.environ.get("SILO_LINUX_SEED_ARCHIVE")
        print(f"[snapshot-groups] {'reuse validated seed archive' if resumed_seed else 'seed export'} for {SOURCE_NAME}", flush=True)
        seed_archive = seed_archive_for_run(browser)
        state = read_state(browser)
        workspaces = records_for_state(state)
        source_record_path, source_record, source_group = snapshot_record(workspaces[SOURCE_NAME])
        if source_record.get("pendingCheckpointRestore"):
            raise AssertionError("Source must be fully started before group qualification")
        evidence["sourceCapacity"] = verify_vm_capacity(workspaces[SOURCE_NAME])
        evidence["seedArchiveName"] = seed_archive.name
        evidence["seedArchiveBytes"] = seed_archive.stat().st_size
        inspected = invoke(browser, "inspect_backup_archive", {"archivePath": str(seed_archive)})
        if not inspected.get("valid") or inspected.get("archive", {}).get("sandboxes") != [SOURCE_NAME]:
            raise AssertionError(f"Seed archive is not a valid single-source archive: {inspected}")
        suffix = secrets.token_hex(3)
        imported_name = f"lineage-import-{suffix}"
        fork_name = f"lineage-fork-{suffix}"
        if len(imported_name) > 32 or len(fork_name) > 32:
            raise AssertionError("Generated Silo workspace names exceed the supported limit")
        print(f"[snapshot-groups] one same-home import as {imported_name}", flush=True)
        restore_operation_id = invoke(browser, "read_backup_state").get("operationId")
        invoke(browser, "start_restore", {
            "archivePath": str(seed_archive), "newName": imported_name, "sourceName": SOURCE_NAME,
        })
        operation_result(browser, "restore", restore_operation_id)
        seed_archive.unlink()
        state = read_state(browser)
        workspaces = records_for_state(state)
        if imported_name not in workspaces:
            raise AssertionError(f"Import did not register {imported_name}: {sorted(workspaces)}")
        imported_path, imported_record, imported_group = snapshot_record(workspaces[imported_name])
        if not imported_group.startswith("silo-import-"):
            raise AssertionError(f"Imported workspace did not retain its native group: {imported_group}")
        start_stop(browser, imported_name)
        print("[snapshot-groups] imported VM Start/Stop passed", flush=True)
        state = read_state(browser)
        evidence["importedCapacity"] = verify_vm_capacity(records_for_state(state)[imported_name])
        _, imported_record, group_after_start = snapshot_record(records_for_state(state)[imported_name])
        if group_after_start != imported_group or records_for_state(state)[imported_name].get("pendingCheckpointRestore"):
            raise AssertionError("Imported lineage changed or remained pending after Start")
        invoke(browser, "workspace_action", {"action": "start", "name": imported_name, "path": None})
        state = read_state(browser)
        imported_workspace = records_for_state(state)[imported_name]
        if imported_workspace["state"] != "running":
            raise AssertionError("Imported workspace did not return to Running for checkpoint capture")

        # Capture one checkpoint in the imported workspace's saved group, then
        # fork from it. The fork must inherit that exact native group.
        checkpoint_name = f"lineage-{suffix}"
        print(f"[snapshot-groups] capture {checkpoint_name} and create fork {fork_name}", flush=True)
        created_state = invoke(browser, "create_checkpoint", {
            "workspaceId": imported_workspace["machine"]["id"],
            "name": checkpoint_name,
        })
        imported_workspace = records_for_state(created_state)[imported_name]
        _, imported_record, group_after_capture = snapshot_record(imported_workspace)
        if group_after_capture != imported_group:
            raise AssertionError("Checkpoint capture changed the imported native group")
        checkpoint_ids = [item["id"] for item in imported_workspace.get("checkpoints", [])
                          if item.get("name") == checkpoint_name]
        if len(checkpoint_ids) != 1:
            raise AssertionError(f"Expected one created checkpoint; found {checkpoint_ids}")
        invoke(browser, "workspace_action", {"action": "stop", "name": imported_name, "path": None})
        forked_state = invoke(browser, "fork_checkpoint", {
            "workspaceId": imported_workspace["machine"]["id"],
            "checkpointId": checkpoint_ids[0], "newName": fork_name,
        })
        fork_workspace = records_for_state(forked_state)[fork_name]
        fork_path, fork_record, fork_group = snapshot_record(fork_workspace)
        if fork_group != imported_group:
            raise AssertionError(f"Fork did not inherit source group: {fork_group} != {imported_group}")
        start_stop(browser, fork_name)
        print(f"[snapshot-groups] fork {fork_name} Start/Stop passed", flush=True)
        state = read_state(browser)
        evidence["forkCapacity"] = verify_vm_capacity(records_for_state(state)[fork_name])

        # Each source is exported twice, in the same appdata/runtime home. The
        # archive itself is validated by Silo then removed before the next run.
        for workspace_name, expected_group in (
            (SOURCE_NAME, source_group), (imported_name, imported_group), (fork_name, fork_group),
        ):
            print(f"[snapshot-groups] export {workspace_name} twice in group {expected_group}", flush=True)
            export_twice(browser, workspace_name, expected_group, evidence["results"])

        # A real app relaunch must preserve all three selected groups.
        evidence["groupsBeforeRelaunch"] = {
            SOURCE_NAME: source_group, imported_name: imported_group, fork_name: fork_group,
        }
        for name in (SOURCE_NAME, imported_name, fork_name):
            current = records_for_state(read_state(browser)).get(name)
            if current and current["state"] == "running":
                invoke(browser, "workspace_action", {"action": "stop", "name": name, "path": None})
        browser.quit()
        browser = None
        stop_app(environment)
        process.terminate()
        process.wait(timeout=15)
        output.close()
        process = output = None

        print("[snapshot-groups] relaunch and verify persisted groups", flush=True)
        browser, process, output = launch_driver(environment)
        state = read_state(browser)
        workspaces = records_for_state(state)
        for name, expected_group in evidence["groupsBeforeRelaunch"].items():
            if name not in workspaces:
                raise AssertionError(f"{name} disappeared after app relaunch")
            _, _, actual_group = snapshot_record(workspaces[name])
            if actual_group != expected_group:
                raise AssertionError(f"{name} group changed after relaunch: {actual_group} != {expected_group}")
            verify_vm_capacity(workspaces[name])
            start_stop(browser, name)
            restarted = records_for_state(read_state(browser))[name]
            _, _, restarted_group = snapshot_record(restarted)
            if restarted_group != expected_group:
                raise AssertionError(f"{name} group changed after Start following app relaunch: {restarted_group} != {expected_group}")
            verify_vm_capacity(restarted)
        evidence["passed"] = True
        evidence["results"].append({"appRelaunch": "all three persisted groups unchanged"})
    except Exception as error:
        evidence["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        report_path.write_text(json.dumps(evidence, indent=2) + "\n")
        if browser is not None:
            try:
                browser.quit()
            except Exception:
                pass
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                raise RuntimeError("tauri-driver did not exit cleanly")
        if output is not None:
            output.close()
        if stop_app:
            stop_app(environment)
        print(f"Snapshot group evidence: {report_path}")
        print(f"Snapshot group qualification passed: {evidence['passed']}")


if __name__ == "__main__":
    run()
