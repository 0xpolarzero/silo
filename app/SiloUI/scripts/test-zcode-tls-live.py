#!/usr/bin/env python3
"""Opt-in real MicroSandbox/SSH/Node 22 ZCode launch-boundary regression.

Requires a signed msb, libkrunfw, bundled guest image, and an assets directory
containing verified Linux Node 22.16.0 (node) and build-live-probe.mjs output
(probe.cjs). Creates and stops only a disposable VM. No real provider credentials.
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
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('msb', 'library', 'guest-image', 'assets', 'output'):
        parser.add_argument('--' + key, type=Path, required=True)
    parser.add_argument('--expect', choices=['broken', 'fixed'], required=True)
    parser.add_argument('--debug-runtime', action='store_true')
    args = parser.parse_args()
    if os.environ.get('SILO_RUN_ZCODE_TLS_LIVE') != '1':
        parser.error('set SILO_RUN_ZCODE_TLS_LIVE=1')
    args.output.mkdir(parents=True, exist_ok=False)
    root = Path(tempfile.mkdtemp(prefix='silo-zcode-live-', dir='/tmp'))
    env = {key: value for key, value in os.environ.items() if not key.startswith('MSB_')}
    env.update(MSB_HOME=str(root / 'home'), MSB_BACKEND='local',
               MSB_LIBKRUNFW_PATH=str(args.library.resolve()), SILO_GITHUB='synthetic-unused-test-value')
    name, machine_id = 'zcode-tls-regression', str(uuid.uuid4())
    log = (args.output / 'commands.log').open('w')
    listener = None
    created = False
    passed = False

    def run(command, check=True, timeout=180):
        result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=timeout)
        log.write(result.stdout + result.stderr)
        log.flush()
        if check and result.returncode:
            raise RuntimeError(f'{command[:2]} failed ({result.returncode}); see {args.output}')
        return result

    def msb(*command, **kwargs):
        return run([str(args.msb.resolve()), *command], **kwargs)

    try:
        manifest = json.loads((args.guest_image / 'manifest.json').read_text())
        with gzip.open(args.guest_image / 'image.tar.gz', 'rb') as source, (root / 'guest.tar').open('wb') as dest:
            shutil.copyfileobj(source, dest)
        msb('image', 'load', '--input', str(root / 'guest.tar'), '--tag', manifest['imageReference'], '--quiet', timeout=300)
        # Express the production interception and secret-host policy through the
        # CLI. The saved runtime JSON is not the CLI's sparse network schema.
        msb('create', manifest['imageReference'], '--name', name, '--no-start', '--memory', '1G', '--cpus', '1',
            '--tls-intercept', '--secret', 'SILO_GITHUB@github.com,api.github.com,uploads.github.com',
            '--mount-dir', f'{args.assets.resolve()}:/test:ro',
            '--label', f'silo.machine-id={machine_id}', *(['--log-level', 'debug'] if args.debug_runtime else []))
        created = True
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(root / 'key')])
        msb('start', name)
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        listener = subprocess.Popen([str(args.msb.resolve()), 'ssh', 'serve', name, '--no-start',
            '--exit-on-stdin-close', '--authorized-keys', str(root / 'key.pub'), '--host', '127.0.0.1',
            '--port', str(port), '--no-inactivity-timeout', '--expected-machine-id', machine_id],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
        with selectors.DefaultSelector() as selector:
            selector.register(listener.stdout, selectors.EVENT_READ)
            if not selector.select(15) or listener.stdout.readline() != b'SILO_SSH_READY\n':
                raise RuntimeError('SSH listener failed to become ready')
        ssh = ['ssh', '-F', '/dev/null', '-i', str(root / 'key'), '-p', str(port),
            '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
            '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new',
            '-o', f'UserKnownHostsFile={root / "known-hosts"}', 'root@127.0.0.1',
            '/test/node /test/probe.cjs']
        result = run(ssh)
        (args.output / 'result.json').write_text(result.stdout)
        data = json.loads(result.stdout)
        assert data['node'] == 'v22.16.0', data
        assert data['bundleSha256'] == 'e9f1868c0fdb863537ed910ee3828b9be96b8c2fd805473f63b439e1113266b8', data
        assert data['certificates']['api.github.com']['issuer'] == 'microsandbox CA', data
        intercepted = data['certificates']['api.z.ai']['issuer'] == 'microsandbox CA'
        assert intercepted == (args.expect == 'broken'), data
        for transport in ('native', 'provider'):
            provider = data['original']['api.z.ai'][transport]
            if args.expect == 'broken':
                assert provider['codes'] == ['MODEL_TLS_VALIDATION_FAILED', 'SELF_SIGNED_CERT_IN_CHAIN'], data
            else:
                assert 'status' in provider, data
            assert 'status' in data['restored']['api.z.ai'][transport], data
            # GitHub still requires the sandbox CA, even after the runtime fix.
            assert 'SELF_SIGNED_CERT_IN_CHAIN' in data['original']['api.github.com'][transport]['codes'], data
            assert 'status' in data['restored']['api.github.com'][transport], data
        if args.expect == 'fixed':
            # Existing secret assignments change live, without restarting the VM.
            msb('modify', name, '--secret', 'SILO_GITHUB@api.z.ai', '--format', 'json')
            changed = run(ssh)
            (args.output / 'changed-host.json').write_text(changed.stdout)
            changed = json.loads(changed.stdout)
            assert changed['certificates']['api.z.ai']['issuer'] == 'microsandbox CA', changed
            assert changed['certificates']['api.github.com']['issuer'] != 'microsandbox CA', changed
            for transport in ('native', 'provider'):
                assert 'SELF_SIGNED_CERT_IN_CHAIN' in changed['original']['api.z.ai'][transport]['codes'], changed
                assert 'status' in changed['original']['api.github.com'][transport], changed
            msb('modify', name, '--secret-rm', 'SILO_GITHUB', '--format', 'json')
            removed = run(ssh)
            (args.output / 'removed-secret.json').write_text(removed.stdout)
            removed = json.loads(removed.stdout)
            for hostname in ('api.z.ai', 'api.github.com'):
                assert removed['certificates'][hostname]['issuer'] != 'microsandbox CA', removed
                for transport in ('native', 'provider'):
                    assert 'status' in removed['original'][hostname][transport], removed
        print(f'PASS {args.expect}: real Linux VM, SSH, Node {data["node"]}, ZCode launch and provider transport', flush=True)
        passed = True
    finally:
        if listener and listener.poll() is None:
            listener.stdin.close()
            try:
                listener.wait(timeout=10)
            except subprocess.TimeoutExpired:
                listener.terminate()
                listener.wait(timeout=10)
        if created:
            stopped = msb('stop', name, check=False)
            if stopped.returncode:
                passed = False
        log.close()
        if passed:
            shutil.rmtree(root)
            print(f'Evidence: {args.output}; disposable VM removed', flush=True)
        else:
            print(f'Evidence: {args.output}; isolated runtime state retained: {root}', flush=True)


if __name__ == '__main__':
    main()
