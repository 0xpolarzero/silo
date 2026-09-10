#!/usr/bin/env python3
"""Run disposable production-runtime tests on Linux; never pretend no KVM passed."""
import fcntl
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
evidence = root / "test-results/linux"
evidence.mkdir(parents=True, exist_ok=True)
report = {"architecture": platform.machine(), "kvm": False, "tests": []}
try:
    with open("/dev/kvm", "rb+", buffering=0) as device:
        assert fcntl.ioctl(device, 0xAE00, 0) == 12, "Unsupported KVM API"
        vm = fcntl.ioctl(device, 0xAE01, 0)
        os.close(vm)
    report["kvm"] = True
except (OSError, AssertionError) as error:
    report["reason"] = str(error)
    (evidence / "runtime.json").write_text(json.dumps(report, indent=2))
    print("Hardware VM tests BLOCKED: " + str(error))
    # Missing hardware is a failed verification, not a successful skipped test.
    sys.exit(2)

target = subprocess.check_output(["rustc", "--print", "host-tuple"], text=True).strip()
environment = dict(os.environ)
environment["SILO_TEST_MSB"] = str(root / f"src-tauri/binaries/msb-{target}")
environment["SILO_TEST_LIBKRUNFW"] = str(root / "src-tauri/runtime/microsandbox/libkrunfw.so.5.6.1")
for test in [
    "live_bundled_image_import_and_cache_reuse",
    "github_guest_bootstrap_and_live_identity",
    "real_backup_restore_preserves_root_and_workspace_without_original_cache",
    "live_secret_adapter_uses_refs_and_preserves_boot_for_live_updates",
]:
    with (evidence / f"{test}.log").open("w") as output:
        result = subprocess.run(
            ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--locked", test,
             "--", "--ignored", "--test-threads=1", "--nocapture"],
            cwd=root, env=environment, stdout=output, stderr=subprocess.STDOUT,
            timeout=600,
        )
    report["tests"].append({"name": test, "passed": result.returncode == 0})
    (evidence / "runtime.json").write_text(json.dumps(report, indent=2))
    if result.returncode:
        print(f"FAILED: {test}; see {evidence}")
        sys.exit(result.returncode)
    print("PASS: " + test)
