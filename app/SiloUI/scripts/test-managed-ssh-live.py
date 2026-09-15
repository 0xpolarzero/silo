#!/usr/bin/env python3
"""Opt-in managed SSH acceptance test using only a disposable local VM.

Set SILO_RUN_MANAGED_SSH_LIVE=1. Pass a signed patched msb executable, its
libkrunfw, the bundled guest-image directory, and an ignored evidence directory.
No registry downloads or existing Silo state are used. Failed VM state is kept
under the printed temporary directory after a graceful stop attempt.
"""

import argparse
import gzip
import json
import os
from pathlib import Path
import selectors
import shutil
import socket
import subprocess
import tempfile
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--msb", type=Path, required=True)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--guest-image", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--network-address", help="Optional exact LAN/VPN IPv4 address to test alongside loopback")
    args = parser.parse_args()
    if os.environ.get("SILO_RUN_MANAGED_SSH_LIVE") != "1":
        parser.error("set SILO_RUN_MANAGED_SSH_LIVE=1 to create a disposable VM")
    args.output.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="silo-ssh-live-", dir="/tmp"))
    env = {key: value for key, value in os.environ.items() if not key.startswith("MSB_")}
    env.update(MSB_HOME=str(root / "home"), MSB_BACKEND="local",
               MSB_PATH=str(args.msb.resolve()), MSB_LIBKRUNFW_PATH=str(args.library.resolve()))
    name = "managed-ssh-acceptance"
    machine_id = str(uuid.uuid4())
    listeners, clients = [], []
    created = False
    passed = False
    log = (args.output / "live.log").open("w")

    def record(message):
        print(message, flush=True)
        print(message, file=log, flush=True)

    def run(command, *, check=True, timeout=120):
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=timeout)
        log.write(result.stdout + result.stderr)
        log.flush()
        if check and result.returncode:
            raise RuntimeError(f"Command failed ({result.returncode}): {command[0:3]}; see live.log")
        return result

    def msb(*command, **options):
        return run([str(args.msb.resolve()), *command], **options)

    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    store = root / "client-authorized-keys"
    known_hosts = root / "known-hosts"
    serve_command = [str(args.msb.resolve()), "ssh", "serve", name, "--no-start",
                     "--exit-on-stdin-close", "--authorized-keys", str(store),
                     "--host", "127.0.0.1", "--port", str(port), "--no-inactivity-timeout",
                     "--expected-machine-id", machine_id]

    def listening(address="127.0.0.1"):
        with socket.socket() as probe:
            probe.settimeout(0.5)
            return probe.connect_ex((address, port)) == 0

    def serve(address="127.0.0.1"):
        command = serve_command.copy()
        command[command.index("--host") + 1] = address
        child = subprocess.Popen(command, env=env, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=log)
        listeners.append(child)
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            if not selector.select(15) or child.stdout.readline() != b"SILO_SSH_READY\n":
                raise RuntimeError("Listener did not report successful bind; see live.log")
        return child

    def ssh(key, command, address="127.0.0.1"):
        return ["ssh", "-F", "/dev/null", "-i", str(root / key), "-p", str(port),
                "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
                "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=0", "-o", "TCPKeepAlive=no",
                "-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={known_hosts}",
                f"root@{address}", command]

    def active_session(key):
        child = subprocess.Popen(ssh(key, "printf ready; sleep 120"), env=env,
                                 stdout=subprocess.PIPE, stderr=log)
        clients.append(child)
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            if not selector.select(10) or child.stdout.read(5) != b"ready":
                raise RuntimeError("SSH session did not start")
        return child

    try:
        record(f"Isolated runtime home: {root}")
        manifest = json.loads((args.guest_image / "manifest.json").read_text())
        archive = root / "guest.tar"
        with gzip.open(args.guest_image / "image.tar.gz", "rb") as source, archive.open("wb") as target:
            shutil.copyfileobj(source, target)
        msb("image", "load", "--input", str(archive), "--tag", manifest["imageReference"], "--quiet", timeout=300)
        msb("create", manifest["imageReference"], "--name", name, "--no-start", "--memory", "512M", "--cpus", "1", "--label", f"silo.machine-id={machine_id}")
        created = True
        for key in ("allowed", "replacement", "internal"):
            run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(root / key)])
        store.write_text((root / "allowed.pub").read_text())
        internal_store = root / "home/ssh/authorized_keys"
        internal_store.parent.mkdir(parents=True, exist_ok=True)
        internal_contents = (root / "internal.pub").read_text()
        internal_store.write_text(internal_contents)
        stopped = subprocess.Popen(serve_command, env=env, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=log)
        listeners.append(stopped)
        assert stopped.wait(timeout=10) != 0 and not listening()
        record("PASS stopped sandbox refuses SSH without starting")
        msb("start", name)
        mismatched = serve_command.copy()
        mismatched[-1] = str(uuid.uuid4())
        wrong_identity = subprocess.Popen(mismatched, env=env, stdin=subprocess.PIPE,
                                          stdout=subprocess.PIPE, stderr=log)
        listeners.append(wrong_identity)
        assert wrong_identity.wait(timeout=10) != 0 and not listening()
        record("PASS mismatched machine identity refuses binding")
        endpoint = serve()
        assert run(ssh("allowed", "printf connected")).stdout == "connected"
        assert run(ssh("replacement", "true"), check=False).returncode != 0
        assert run(ssh("internal", "true"), check=False).returncode != 0
        record("PASS authorized key connects; unauthorized and internal keys rejected")
        host_keys = list((root / "home/sandboxes" / name).rglob("host_ed25519"))
        assert len(host_keys) == 1
        host_fingerprint = run(["ssh-keygen", "-lf", str(host_keys[0])]).stdout.split()[1]
        client_fingerprint = run(["ssh-keygen", "-lf", str(known_hosts)]).stdout.split()[1]
        assert host_fingerprint == client_fingerprint
        record("PASS client host-key fingerprint matches sandbox")
        started = time.monotonic()
        assert run(ssh("allowed", "printf before; sleep 65; printf after"), timeout=90).stdout == "beforeafter"
        assert time.monotonic() - started >= 65
        record("PASS SSH survives 65 seconds without traffic or client keepalives")
        session = active_session("allowed")
        endpoint.stdin.close()
        assert endpoint.wait(timeout=10) == 0
        assert session.wait(timeout=10) != 0 and not listening()
        record("PASS owner pipe EOF closes listener and active session")
        store.write_text((root / "replacement.pub").read_text())
        endpoint = serve()
        assert run(ssh("allowed", "true"), check=False).returncode != 0
        assert run(ssh("replacement", "printf rekeyed")).stdout == "rekeyed"
        assert internal_store.read_text() == internal_contents
        record("PASS store replacement revokes old key and preserves internal store")
        network_endpoint = None
        if args.network_address:
            network_endpoint = serve(args.network_address)
            assert run(ssh("replacement", "printf network", args.network_address)).stdout == "network"
            assert run(ssh("allowed", "true", args.network_address), check=False).returncode != 0
            assert run(ssh("replacement", "printf local")).stdout == "local"
            record("PASS exact LAN/VPN address and loopback listeners coexist with key authentication")
        session = active_session("replacement")
        msb("stop", name)
        assert endpoint.wait(timeout=10) == 0
        assert session.wait(timeout=10) != 0 and not listening()
        if network_endpoint:
            assert network_endpoint.wait(timeout=10) == 0 and not listening(args.network_address)
        record("PASS VM stop closes all listeners and active session with owner pipes still open")
        passed = True
    finally:
        for child in listeners + clients:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
        if created:
            msb("stop", name, check=False)
        if passed:
            shutil.rmtree(root)
        else:
            record(f"Failure evidence retained at {root}")
        log.close()


if __name__ == "__main__":
    main()
