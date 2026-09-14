#!/usr/bin/env python3
"""Record build phase timings without recording arguments, environment or output."""
import argparse
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time


def measure(label, command, output):
    started = time.monotonic()
    try:
        result = subprocess.run(command, check=False)
        code = result.returncode
    except OSError as error:
        print(f"Could not start measured command: {error.strerror}", file=sys.stderr)
        code = 127
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    record = {
        "phase": label,
        "seconds": round(time.monotonic() - started, 3),
        "exitCode": code,
        "cpuCount": os.cpu_count(),
        "userSeconds": round(usage.ru_utime, 3),
        "systemSeconds": round(usage.ru_stime, 3),
        "peakRssBytes": usage.ru_maxrss * (1 if sys.platform == "darwin" else 1024),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("a") as stream:
        stream.write(json.dumps(record) + "\n")
    print(f"Measured {label}: {record['seconds']:.3f}s (exit {code})")
    return code if code >= 0 else 128 - code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("label")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required")
    default_output = Path(os.environ.get("RUNNER_TEMP", "src-tauri/target/verification")) / "build-phases.jsonl"
    output = Path(os.environ.get("SILO_BUILD_METRICS", default_output))
    return measure(args.label, command, output)


if __name__ == "__main__":
    sys.exit(main())
