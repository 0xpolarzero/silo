#!/usr/bin/env python3
"""SDK-only host-restart probe for explicitly reported scratch sandboxes.

The checked-in E2B SDK/runtime surface does not expose a per-snapshot canonical
object upload barrier. ``prepare`` therefore records the run-owned inventory
and fails closed before connecting to or pausing any guest. ``verify`` is the
post-reboot half, gated on a future report containing a per-build canonical
object readback attestation. This script never shuts down or reboots a host.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import sys
import time


HEX_256 = re.compile(r"^[0-9a-f]{64}$")
PROOF_LIMIT = (
    "No SDK-only per-build canonical upload barrier is available. The inspected "
    "runtime starts pause snapshot uploads asynchronously; SDK pause returns a "
    "boolean and build status alone does not prove canonical object readback."
)


class ProbeError(RuntimeError):
    pass


def now():
    return {"unix": time.time(), "local": datetime.now().astimezone().isoformat()}


def host_boot_id():
    path = Path("/proc/sys/kernel/random/boot_id")
    return path.read_text().strip() if path.is_file() else None


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_report(path, report):
    """Atomically write and fsync the report and containing directory."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def load_targets(report_paths):
    """Use only explicitly supplied successful SDK lifecycle reports."""
    targets = []
    seen = set()
    if not report_paths:
        raise ProbeError("Supply at least one --run-report from the scratch SDK repro")
    for raw_path in report_paths:
        path = Path(raw_path)
        report = json.loads(path.read_text(encoding="utf-8"))
        run_id = report.get("run_id")
        sandbox_id = report.get("sandbox_id")
        oracles = report.get("oracles")
        if report.get("status") != "passed" or report.get("action") != "pause":
            raise ProbeError(f"{path}: expected a passing action=pause SDK report")
        if not isinstance(run_id, str) or not run_id:
            raise ProbeError(f"{path}: missing run_id")
        if not isinstance(sandbox_id, str) or not sandbox_id:
            raise ProbeError(f"{path}: missing sandbox_id")
        if sandbox_id in seen:
            raise ProbeError(f"Duplicate sandbox ID in supplied reports: {sandbox_id}")
        if not isinstance(oracles, dict):
            raise ProbeError(f"{path}: missing preserved SDK oracles")
        nonce = oracles.get("memory_nonce")
        file_hash = oracles.get("fsynced_file_sha256")
        if not isinstance(nonce, str) or not HEX_256.fullmatch(nonce):
            raise ProbeError(f"{path}: missing 64-character in-memory nonce")
        if not isinstance(file_hash, str) or not HEX_256.fullmatch(file_hash):
            raise ProbeError(f"{path}: missing fsynced file SHA-256")
        seen.add(sandbox_id)
        targets.append({"sandbox_id": sandbox_id, "run_id": run_id,
                        "run_report": str(path.resolve()),
                        "memory_nonce": nonce, "fsynced_file_sha256": file_hash})
    return targets


def _state(info):
    state = getattr(info, "state", None)
    return getattr(state, "value", state)


def _metadata(info):
    return getattr(info, "metadata", None) or {}


def load_sdk():
    """Load the PoC's API environment before the first SDK request."""
    from runtime import configure
    configure()
    import e2b
    return e2b


def inventory_targets(sdk, targets):
    """Passive ownership/state checks. Never connect, which may resume a guest."""
    inventory = []
    errors = []
    for target in targets:
        try:
            info = sdk.Sandbox.get_info(target["sandbox_id"])
            metadata = _metadata(info)
            observed_id = getattr(info, "sandbox_id", target["sandbox_id"])
            state = _state(info)
            item = {"sandbox_id": target["sandbox_id"], "state": state,
                    "metadata_run_id": metadata.get("sdk-repro-run"),
                    "cpu_count": getattr(info, "cpu_count", None),
                    "memory_mb": getattr(info, "memory_mb", None)}
            inventory.append(item)
            if observed_id != target["sandbox_id"]:
                errors.append(f"SDK returned unexpected sandbox ID for {target['sandbox_id']}")
            if metadata.get("sdk-repro-run") != target["run_id"]:
                errors.append(f"{target['sandbox_id']} is not tagged to supplied run {target['run_id']}")
            if state != "running":
                errors.append(f"{target['sandbox_id']} must be passively observed running; found {state}")
            cpus = getattr(info, "cpu_count", None)
            memory = getattr(info, "memory_mb", None)
            if cpus is None or cpus > 1 or memory is None or memory > 512:
                errors.append(f"{target['sandbox_id']} is not confirmed tiny (at most 1 CPU and 512 MiB)")
        except Exception as error:
            inventory.append({"sandbox_id": target["sandbox_id"],
                              "observation_error_type": type(error).__name__})
            errors.append(f"Passive inventory failed for {target['sandbox_id']}: {type(error).__name__}")
    return inventory, errors


def prepare(report_paths, output_path, sdk=None):
    """Inventory exact report-owned IDs, then fail closed before the first pause."""
    targets = load_targets(report_paths)
    if sdk is None:
        sdk = load_sdk()  # Synthetic tests inject an SDK and avoid local credentials.
    report = {"schema": "sdk-host-restart-probe/v1", "phase": "prepare",
              "started": now(), "host_boot_id_before": host_boot_id(),
              "targets": targets, "events": [],
              "restart_authorized": False}
    inventory, errors = inventory_targets(sdk, targets)
    report["passive_inventory"] = inventory
    if errors:
        report["status"] = "blocked"
        report["block_reason"] = "run ownership or scratch-resource preflight failed"
        report["preflight_errors"] = errors
        report["pause_attempted"] = False
    else:
        # Fail before connect/write/pause: the pause-generated build ID is not
        # surfaced by Sandbox.pause(), and the SDK lacks canonical object
        # readback for that build. A sleep or READY/SUCCESS status is not proof.
        report["status"] = "blocked"
        report["block_reason"] = "canonical per-build upload barrier unavailable"
        report["proof_limit"] = PROOF_LIMIT
        report["pause_attempted"] = False
        report["guest_mutations_attempted"] = False
        report["required_before_pause"] = (
            "An independently implemented barrier must identify the pause build "
            "and verify its complete canonical artifact/dependency set by readback."
        )
    report["finished"] = now()
    write_report(Path(output_path), report)
    return report


def validate_upload_attestation(report, verifier=None):
    """Require a per-target build and object readback record before resume."""
    barrier = report.get("upload_barrier")
    if not isinstance(barrier, dict) or barrier.get("status") != "complete":
        raise ProbeError("No complete per-build canonical upload attestation; refusing resume")
    if barrier.get("condition") != "canonical-object-readback":
        raise ProbeError("Upload attestation is not canonical object readback")
    by_sandbox = barrier.get("sandboxes")
    if not isinstance(by_sandbox, dict):
        raise ProbeError("Upload attestation is missing per-sandbox records")
    for target in report.get("targets", []):
        item = by_sandbox.get(target.get("sandbox_id"))
        if not isinstance(item, dict) or not item.get("build_id"):
            raise ProbeError(f"Upload attestation is missing build ID for {target.get('sandbox_id')}")
        if item.get("status") != "complete" or not HEX_256.fullmatch(str(item.get("manifest_sha256", ""))):
            raise ProbeError(f"Upload attestation is incomplete for {target.get('sandbox_id')}")
        if not item.get("canonical_objects_read_back"):
            raise ProbeError(f"Canonical artifact readback is not recorded for {target.get('sandbox_id')}")
    # The fields above constrain the report shape; they do not authenticate it.
    # The CLI intentionally has no verifier configured until a real storage
    # readback implementation is qualified. Never trust a hand-edited boolean.
    if verifier is None or verifier(report) is not True:
        raise ProbeError("No trusted canonical object readback verifier is installed; refusing resume")


def command_output(sandbox, text):
    result = sandbox.commands.run(text, timeout=30)
    if result.exit_code != 0:
        raise ProbeError(f"Guest command failed ({result.exit_code}): {result.stderr[:300]}")
    return result.stdout.strip()


def verify(report_path, output_path, sdk=None, host_boot_id=None, barrier_verifier=None):
    """After manual external reboot, explicitly resume and check both oracles."""
    path = Path(report_path)
    report = json.loads(path.read_text(encoding="utf-8"))
    if report.get("schema") != "sdk-host-restart-probe/v1" or report.get("phase") != "prepare":
        raise ProbeError("Input is not an SDK host-restart prepare report")
    if report.get("status") != "prepared":
        raise ProbeError("Prepare report is not in prepared state; refusing guest resume")
    validate_upload_attestation(report, verifier=barrier_verifier)
    before = report.get("host_boot_id_before")
    if not isinstance(before, str) or not before:
        raise ProbeError("Prepare report has no host boot ID")
    if host_boot_id is None:
        boot_path = Path("/proc/sys/kernel/random/boot_id")
        if not boot_path.is_file():
            raise ProbeError("Host boot ID is unavailable")
        host_boot_id = boot_path.read_text().strip()
    if host_boot_id == before:
        raise ProbeError("Host boot ID did not change; refusing to label this a host restart")
    if sdk is None:
        sdk = load_sdk()

    targets = report.get("targets")
    if not isinstance(targets, list) or not targets:
        raise ProbeError("Prepared report has no explicit targets")
    inventory, errors = inventory_targets_for_verify(sdk, targets)
    if errors:
        raise ProbeError("Post-reboot passive preflight failed: " + "; ".join(errors))

    result = {"schema": report["schema"], "phase": "verify", "started": now(),
              "prepare_report": str(path.resolve()), "host_boot_id_before": before,
              "host_boot_id_after": host_boot_id, "targets": [], "events": []}
    write_report(Path(output_path), result)
    try:
        for target in targets:
            sid = target["sandbox_id"]
            result["events"].append({"name": "explicit-connect-resume", "sandbox_id": sid, **now()})
            write_report(Path(output_path), result)
            sandbox = sdk.Sandbox.connect(sid, on_resume="restore")
            nonce = command_output(sandbox, "curl -fsS --max-time 3 http://127.0.0.1:8788")
            file_hash = command_output(sandbox, "sha256sum /home/user/state.bin").split()[0]
            if nonce != target["memory_nonce"]:
                raise ProbeError(f"In-memory nonce mismatch for {sid}")
            if file_hash != target["fsynced_file_sha256"]:
                raise ProbeError(f"Fsynced file hash mismatch for {sid}")
            new_write = secrets.token_hex(32)
            guest_code = (
                "import os; p='/home/user/host-restart-probe-write'; "
                f"d=bytes.fromhex('{new_write}'); "
                "f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600); "
                "os.write(f,d); os.fsync(f); os.close(f)"
            )
            command_output(sandbox, "python3 -c " + shlex.quote(guest_code))
            observed = command_output(sandbox, "sha256sum /home/user/host-restart-probe-write").split()[0]
            if observed != hashlib.sha256(bytes.fromhex(new_write)).hexdigest():
                raise ProbeError(f"Post-restart fsynced write failed for {sid}")
            result["targets"].append({"sandbox_id": sid, "run_id": target["run_id"],
                "memory_nonce_matches": True, "fsynced_file_matches": True,
                "new_fsynced_write_matches": True})
            result["events"].append({"name": "oracles-verified", "sandbox_id": sid, **now()})
            write_report(Path(output_path), result)
        result.update(status="passed", finished=now())
    except Exception as error:
        result.update(status="failed", error_type=type(error).__name__,
                      error_summary=str(error)[:500], finished=now())
        write_report(Path(output_path), result)
        raise
    write_report(Path(output_path), result)
    return result


def inventory_targets_for_verify(sdk, targets):
    """Passive post-boot ownership/state checks; require paused before connect."""
    errors = []
    observed = []
    for target in targets:
        try:
            info = sdk.Sandbox.get_info(target["sandbox_id"])
            state = _state(info)
            metadata = _metadata(info)
            observed.append({"sandbox_id": target["sandbox_id"], "state": state,
                             "metadata_run_id": metadata.get("sdk-repro-run")})
            if state != "paused":
                errors.append(f"{target['sandbox_id']} must be paused before explicit connect; found {state}")
            if metadata.get("sdk-repro-run") != target.get("run_id"):
                errors.append(f"{target['sandbox_id']} run ownership tag changed or is missing")
        except Exception as error:
            observed.append({"sandbox_id": target["sandbox_id"],
                             "observation_error_type": type(error).__name__})
            errors.append(f"Passive inventory failed for {target['sandbox_id']}: {type(error).__name__}")
    return observed, errors


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="phase", required=True)
    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--run-report", action="append", required=True,
                                help="explicit successful SDK lifecycle report; repeat for each scratch guest")
    prepare_parser.add_argument("--output", required=True, help="durable JSON probe report")
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--prepare-report", required=True)
    verify_parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        if args.phase == "prepare":
            report = prepare(args.run_report, args.output)
        else:
            report = verify(args.prepare_report, args.output)
        print(json.dumps({"phase": args.phase, "status": report.get("status"),
                          "report": args.output, "restart_authorized": report.get("restart_authorized", False)}))
        return 0 if report.get("status") == "passed" else 2
    except (ProbeError, OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
