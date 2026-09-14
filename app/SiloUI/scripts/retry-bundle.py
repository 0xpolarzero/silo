#!/usr/bin/env python3
"""Retry only a transient AppImage type2-runtime download failure during bundling.

Pass the bundle-only command as argv after --. Never wrap runtime preparation,
compilation, or a command that also validates/publishes the resulting packages.
The caller owns the log path and must keep potentially private build logs local.
"""
import argparse
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import time


DOWNLOAD = re.compile(r"\[appimage/stderr\] Failed to download runtime: server returned status code (500|502|503|504)")
PLUGIN = "ERROR: Failed to run plugin: appimage (exit code: 1)"
BUNDLE = re.compile(r"(?:Error \[tauri_cli_node\] )?failed to bundle project: `failed to run [^`]*linuxdeploy-[^`]*\.AppImage`")
MANUAL = re.compile(r"\[appimage/stderr\] Failed to download runtime file, please download the runtime manually from https://github\.com/AppImage/type2-runtime/releases and pass it to appimagetool with --runtime-file")


def transient_download(output):
    lines = [line.strip() for line in output.decode("utf8", errors="replace").splitlines() if line.strip()]
    failures = [index for index, line in enumerate(lines) if DOWNLOAD.fullmatch(line)]
    if len(failures) != 1:
        return False
    failure = failures[0]
    if not any(line.startswith("[appimage/stderr] Downloading runtime file from https://github.com/AppImage/type2-runtime/") for line in lines[:failure]):
        return False
    if any(re.match(r"(?:error\b|fatal\b|failed to\b|.*(?:validation|verification) failed\b)", line, re.IGNORECASE)
           and line != PLUGIN and not BUNDLE.fullmatch(line) for line in lines):
        return False
    tail = lines[failure + 1:]
    # Recognize the complete known failure chain; unrelated later failures must
    # not turn a failed compiler, package check or validation into a retry.
    return (PLUGIN in tail and any(BUNDLE.fullmatch(line) for line in tail)
            and all(line == PLUGIN or BUNDLE.fullmatch(line) or MANUAL.fullmatch(line) for line in tail))


def run_attempt(command, log, stdout, stderr):
    output = bytearray()
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as error:
        message = f"Could not start bundle command: {error.strerror}\n".encode()
        stderr.write(message)
        stderr.flush()
        log.write(message)
        log.flush()
        return 127, message
    with process, selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ, stdout)
        selector.register(process.stderr, selectors.EVENT_READ, stderr)
        while selector.get_map():
            for key, _ in selector.select():
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                key.data.write(chunk)
                key.data.flush()
                log.write(chunk)
                log.flush()
                output.extend(chunk)
        code = process.wait()
    return code if code >= 0 else 128 - code, bytes(output)


def retry_bundle(command, log_path, stdout=None, stderr=None, sleep=time.sleep):
    stdout = sys.stdout.buffer if stdout is None else stdout
    stderr = sys.stderr.buffer if stderr is None else stderr
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("ab") as log:
        for attempt in range(1, 4):
            marker = f"\nBundle attempt {attempt}/3\n".encode()
            log.write(marker)
            log.flush()
            stderr.write(marker)
            stderr.flush()
            code, output = run_attempt(command, log, stdout, stderr)
            log.write(f"\nBundle attempt {attempt} exit code: {code}\n".encode())
            log.flush()
            if code == 0 or attempt == 3 or not transient_download(output):
                return code
            delay = attempt * 2
            message = f"Transient AppImage runtime download failure; retrying bundle only in {delay}s.\n".encode()
            stderr.write(message)
            stderr.flush()
            log.write(message)
            log.flush()
            sleep(delay)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", required=True, type=Path)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a bundle-only command is required after --")
    return retry_bundle(command, args.log)


if __name__ == "__main__":
    sys.exit(main())
