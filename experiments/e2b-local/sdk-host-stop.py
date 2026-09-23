#!/usr/bin/env python3
"""Check one prepared SDK snapshot immediately before stopping an owned scratch host.

This command never pauses a guest or stops the host. The Mac driver stops the
owned Lima VM only after this command returns successfully.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from runtime import STATE, configure


HERE = Path(__file__).resolve().parent
EVIDENCE = HERE / "evidence" / "sdk-lifecycle"
STORAGE = Path("/var/lib/e2b/storage")
ORCHESTRATOR_SHA256 = "e5052cb59d4bfef1c2b9d90266f2aa4a061fa5551b52d1853a9895494245a8f7"


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_prepared(run_id):
    if not re.fullmatch(r"[0-9a-f]{32}", run_id):
        raise RuntimeError("Expected an exact 32-character SDK run ID")
    path = EVIDENCE / f"host-restart-prepare-{run_id}.json"
    data = json.loads(path.read_text())
    if (data.get("schema"), data.get("run_id"), data.get("status")) != (
            "sdk-host-restart-prepare/v1", run_id, "prepared"):
        raise RuntimeError("Exact host-restart preparation is not complete")
    sid, build = data.get("sandbox_id"), data.get("build_id")
    if not isinstance(sid, str) or not re.fullmatch(r"[a-z0-9]{21}", sid):
        raise RuntimeError("Prepared sandbox ID is invalid")
    if not isinstance(build, str) or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", build):
        raise RuntimeError("Prepared build ID is invalid")
    events = data.get("events", [])
    pauses = [event for event in events if event.get("name") == "pause-request"]
    responses = [event for event in events if event.get("name") == "pause-response"]
    if len(pauses) != 1 or len(responses) != 1 or responses[0].get("returned") is not True:
        raise RuntimeError("Prepared report lacks one accepted pause")
    marker = data.get("upload_marker")
    if not isinstance(marker, dict) or not re.fullmatch(r"[0-9a-f]{64}", str(marker.get("line_sha256", ""))):
        raise RuntimeError("Prepared report lacks an exact upload marker")
    if not re.fullmatch(r"[0-9a-f]{64}", str(data.get("canonical_manifest_sha256", ""))):
        raise RuntimeError("Prepared report lacks a canonical readback hash")
    return data, pauses[0]["at"]


def catalog_row(sid, build):
    query = (
        "select s.sandbox_id,a.build_id,b.status "
        "from snapshots s join env_build_assignments a on a.env_id=s.env_id "
        "join env_builds b on b.id=a.build_id "
        f"where s.sandbox_id='{sid}' and a.build_id='{build}' and a.tag='default';"
    )
    raw = subprocess.check_output(["docker", "exec", "e2b-postgres-1", "psql", "-U",
                                   "postgres", "-d", "postgres", "-AtF", "|", "-c", query], text=True)
    if raw.splitlines() != [f"{sid}|{build}|success"]:
        raise RuntimeError("Exact snapshot catalog build is not successful")


def upload_marker_matches(sid, since, expected_sha):
    result = subprocess.run(["docker", "logs", "--since", since, "e2b-orchestrator-1"],
                            capture_output=True, text=True, check=True)
    found = []
    for line in (result.stdout + result.stderr).splitlines():
        if "snapshot finished uploading successfully" not in line or sid not in line:
            continue
        try:
            fields = json.loads(line[line.index("{"):])
        except (ValueError, json.JSONDecodeError):
            continue
        if fields.get("sandbox.id") == sid:
            found.append(hashlib.sha256(line.encode()).hexdigest())
    if found != [expected_sha]:
        raise RuntimeError("Exact sandbox upload marker changed or is unavailable")


def verify(run_id):
    if os.geteuid() != 0:
        raise RuntimeError("Run as root for exact guest and local storage checks")
    data, since = load_prepared(run_id)
    sid, build = data["sandbox_id"], data["build_id"]
    boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    if boot_id != data.get("boot_id"):
        raise RuntimeError("Prepared report belongs to a different host boot")
    if sha256_file("/var/lib/e2b/bin/orchestrator") != ORCHESTRATOR_SHA256:
        raise RuntimeError("Running candidate does not match the pinned orchestrator binary")
    health = subprocess.check_output(["docker", "inspect", "-f", "{{.State.Health.Status}}",
                                      "e2b-orchestrator-1"], text=True).strip()
    if health != "healthy":
        raise RuntimeError("Orchestrator is not healthy")
    registry = STATE / "desktops.json"
    if registry.exists():
        desktops = json.loads(registry.read_text()).get("desktops", {})
        if any(item.get("status") != "deleted" for item in desktops.values()):
            raise RuntimeError("PoC desktop registry has an active workspace")
    configure()
    from e2b import Sandbox
    pages = Sandbox.list()
    ids = []
    while pages.has_next:
        ids.extend(item.sandbox_id for item in pages.next_items())
    if ids != [sid]:
        raise RuntimeError("SDK inventory is not exactly the prepared guest")
    info = Sandbox.get_info(sid)
    state = getattr(info.state, "value", info.state)
    if (state != "paused" or (getattr(info, "metadata", None) or {}).get("sdk-repro-run") != run_id
            or info.cpu_count != 1 or info.memory_mb != 512):
        raise RuntimeError("Prepared guest ownership, state or size changed")
    processes = subprocess.run(["pgrep", "-x", "firecracker"], capture_output=True)
    if processes.returncode != 1:
        raise RuntimeError("Firecracker is still running or its process check failed")
    catalog_row(sid, build)
    upload_marker_matches(sid, since, data["upload_marker"]["line_sha256"])
    subprocess.run(["sync", "-f", str(STORAGE)], check=True)
    manifest = subprocess.check_output([sys.executable, str(HERE / "verify-canonical-snapshot.py"),
                                        "--storage-root", str(STORAGE), "--build-id", build],
                                       timeout=180)
    digest = hashlib.sha256(manifest).hexdigest()
    if digest != data["canonical_manifest_sha256"]:
        raise RuntimeError("Canonical build closure changed since preparation")
    receipt = {"schema": "sdk-host-stop-ready/v1", "run_id": run_id,
               "sandbox_id": sid, "build_id": build, "boot_id": boot_id,
               "canonical_manifest_sha256": digest, "checked_at_unix": time.time(),
               "status": "ready"}
    path = EVIDENCE / f"host-stop-ready-{run_id}.json"
    if path.exists():
        raise RuntimeError("Host-stop readiness receipt already exists")
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as stream:
        json.dump(receipt, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    print(json.dumps({key: receipt[key] for key in ("status", "run_id", "build_id",
                                                  "canonical_manifest_sha256")}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_id")
    args = parser.parse_args()
    verify(args.run_id)


if __name__ == "__main__":
    main()
