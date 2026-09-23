#!/usr/bin/env python3
"""SDK-only, non-desktop lifecycle baseline for an owned scratch E2B host.

Run as root inside the scratch Linux host after guest-setup.sh. It uses no Silo
adapter, gateway, credential broker, browser, or LCU. It never cleans up a
failed sandbox; inspect the recorded ID before taking any further action.
"""
import argparse
import base64
from datetime import datetime
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shlex
import subprocess
import time
import uuid

from e2b import Sandbox, SandboxQuery, Template


HERE = Path(__file__).resolve().parent
TEMPLATE = 'silo-sdk-lifecycle-20260923'
EVIDENCE = HERE / 'evidence' / 'sdk-lifecycle'
MEMORY_SERVER = '''from http.server import BaseHTTPRequestHandler, HTTPServer
import secrets
nonce = secrets.token_hex(32)
class Handler(BaseHTTPRequestHandler):
 def log_message(self, *args): pass
 def do_GET(self):
  self.send_response(200); self.end_headers(); self.wfile.write(nonce.encode())
HTTPServer(('127.0.0.1', 8788), Handler).serve_forever()
'''


def configure():
    # Parse the existing scratch-host SDK environment without evaluating shell.
    for line in (HERE / 'state' / 'sdk.env').read_text().splitlines():
        parts = shlex.split(line)
        if len(parts) == 2 and parts[0] == 'export':
            key, value = parts[1].split('=', 1)
            if key in {'E2B_API_KEY', 'E2B_API_URL', 'E2B_SANDBOX_URL'}:
                os.environ[key] = value


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def host_inventory():
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, _, value = line.partition(':')
        if key in ('HugePages_Total', 'HugePages_Free', 'HugePages_Rsvd', 'Hugepagesize'):
            memory[key] = value.strip()
    disk = os.statvfs('/var/lib/e2b')
    binaries = {}
    for path in ('/var/lib/e2b/bin/orchestrator', '/fc-envd/envd',
                 '/fc-versions/v1.14-0.2.0/arm64/firecracker',
                 '/fc-kernels/vmlinux-6.1.177_5008931/arm64/vmlinux.bin'):
        if Path(path).is_file():
            binaries[path] = sha256(path)
    images = {}
    for name in ('e2b-api-1', 'e2b-orchestrator-1', 'e2b-client-proxy-1'):
        try:
            container = json.loads(subprocess.check_output(['docker', 'inspect', name], timeout=5))[0]
            image = json.loads(subprocess.check_output(['docker', 'image', 'inspect', container['Image']], timeout=5))[0]
            images[name] = {'image_id': container['Image'], 'repo_digests': image.get('RepoDigests', [])}
        except (OSError, subprocess.SubprocessError, ValueError, IndexError, KeyError):
            images[name] = {'status': 'unavailable'}
    return {'timestamp_unix': time.time(), 'timestamp_local': datetime.now().astimezone().isoformat(),
            'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'kernel': platform.release(), 'architecture': platform.machine(),
            'sdk_version': importlib.metadata.version('e2b'),
            'script_sha256': sha256(__file__), 'hugepages': memory,
            'disk_available_bytes': disk.f_bavail * disk.f_frsize,
            'disk_total_bytes': disk.f_blocks * disk.f_frsize,
            'binaries': binaries, 'images': images}


def write_report(path, report):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(report, indent=2, default=str))
    with temporary.open('rb') as stream:
        os.fsync(stream.fileno())
    temporary.replace(path)


def event(report, path, name, **detail):
    report['events'].append({'at_unix': time.time(),
                             'at_local': datetime.now().astimezone().isoformat(),
                             'name': name, **detail})
    write_report(path, report)


def candidates(run_id):
    """Passive lookup after an ambiguous create response; never reconnect here."""
    pages = Sandbox.list(query=SandboxQuery(metadata={'sdk-repro-run': run_id}))
    found = []
    while pages.has_next:
        found.extend(item.sandbox_id for item in pages.next_items()
                     if (getattr(item, 'metadata', {}) or {}).get('sdk-repro-run') == run_id)
    return found


def info(sandbox_id):
    try:
        item = Sandbox.get_info(sandbox_id)  # Passive; connect is an explicit later step.
        state = getattr(item.state, 'value', item.state)
        return {'state': state, 'sandbox_id': item.sandbox_id,
                'cpu_count': getattr(item, 'cpu_count', None),
                'memory_mb': getattr(item, 'memory_mb', None)}
    except Exception as error:
        return {'observation_error_type': type(error).__name__}


def processes(sandbox_id):
    matches = []
    for directory in Path('/proc').iterdir():
        if not directory.name.isdigit():
            continue
        try:
            if (directory / 'comm').read_text().strip() != 'firecracker':
                continue
            cgroup = (directory / 'cgroup').read_text().strip()
            if f'sbx-{sandbox_id}-' not in cgroup:
                continue
            stat = (directory / 'stat').read_text().split(') ', 1)[1].split()
            matches.append({'pid': int(directory.name), 'start_ticks': int(stat[19]),
                            'cgroup': cgroup})
        except (OSError, ValueError, IndexError):
            continue
    return matches


def command(sandbox, code):
    result = sandbox.commands.run(code, timeout=30)
    if result.exit_code != 0:
        raise RuntimeError(f'Guest command exited {result.exit_code}: {result.stderr[:200]}')
    return result.stdout.strip()


def ready_nonce(sandbox):
    sandbox.files.write('/home/user/memory-server.py', MEMORY_SERVER)
    command(sandbox, 'python3 /home/user/memory-server.py >/tmp/memory-server.log 2>&1 &')
    for _ in range(30):
        try:
            nonce = command(sandbox, 'curl -fsS --max-time 1 http://127.0.0.1:8788')
            if len(nonce) == 64:
                return nonce
        except Exception:
            time.sleep(0.2)
    raise RuntimeError('Process-only nonce server did not become ready')


def fsynced_file(sandbox):
    data = os.urandom(64)
    encoded = base64.b64encode(data).decode()
    program = ('import base64,os; p="/home/user/state.bin"; '
               f'd=base64.b64decode("{encoded}"); '
               'f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600); '
               'os.write(f,d); os.fsync(f); os.close(f)')
    command(sandbox, 'python3 -c ' + shlex.quote(program))
    expected = hashlib.sha256(data).hexdigest()
    actual = command(sandbox, 'sha256sum /home/user/state.bin').split()[0]
    if actual != expected:
        raise AssertionError('Acknowledged fsynced file hash differs immediately')
    return expected


def verify(sandbox, nonce, file_hash):
    actual_nonce = command(sandbox, 'curl -fsS --max-time 2 http://127.0.0.1:8788')
    actual_hash = command(sandbox, 'sha256sum /home/user/state.bin').split()[0]
    if actual_nonce != nonce or actual_hash != file_hash:
        raise AssertionError('Latest process memory or fsynced file was not preserved')
    command(sandbox, 'python3 -c ' + shlex.quote('import os; f=os.open("/home/user/post-operation",os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600); os.write(f,b"writable"); os.fsync(f); os.close(f)'))
    return {'memory_nonce_matches': True, 'fsynced_file_matches': True, 'new_write_succeeded': True}


def build():
    configure()
    template = (Template().from_image('debian:trixie-slim')
                .set_user('root')
                .run_cmd('apt-get update && apt-get install -y --no-install-recommends python3 curl ca-certificates && rm -rf /var/lib/apt/lists/*')
                .run_cmd('mkdir -p /home/user')
                .set_start_cmd('sleep infinity', 'test -x /usr/bin/python3'))
    result = Template.build(template, TEMPLATE, cpu_count=1, memory_mb=512,
                            min_free_disk_mb=512)
    report = {'template': TEMPLATE, 'build': vars(result), 'inventory': host_inventory()}
    write_report(EVIDENCE / 'template-build.json', report)
    print(json.dumps({'template': TEMPLATE, 'build_record': str(EVIDENCE / 'template-build.json')}))


def baseline(action):
    configure()
    run_id = uuid.uuid4().hex
    path = EVIDENCE / (run_id + '.json')
    report = {'run_id': run_id, 'action': action, 'template': TEMPLATE,
              'status': 'running', 'events': [], 'before': host_inventory()}
    write_report(path, report)
    sandbox = None
    try:
        event(report, path, 'create-request', sdk_call={'template': TEMPLATE, 'timeout': 600,
              'metadata': {'sdk-repro-run': run_id}, 'lifecycle': {'on_timeout': 'pause', 'auto_resume': False}})
        sandbox = Sandbox.create(TEMPLATE, timeout=600,
            metadata={'sdk-repro-run': run_id},
            lifecycle={'on_timeout': 'pause', 'auto_resume': False})
        report['sandbox_id'] = sandbox.sandbox_id
        event(report, path, 'create-accepted', sandbox_id=sandbox.sandbox_id,
              observed=info(sandbox.sandbox_id), processes=processes(sandbox.sandbox_id))
        nonce = ready_nonce(sandbox)
        file_hash = fsynced_file(sandbox)  # Acknowledged immediately before operation.
        report['oracles'] = {'memory_nonce': nonce, 'fsynced_file_sha256': file_hash}
        event(report, path, 'pre-operation-oracles-ready', observed=info(sandbox.sandbox_id),
              processes=processes(sandbox.sandbox_id))
        if action == 'checkpoint':
            event(report, path, 'checkpoint-request', sdk_call={'sandbox_id': sandbox.sandbox_id, 'method': 'create_snapshot'})
            snapshot = sandbox.create_snapshot()
            report['snapshot_id'] = snapshot.snapshot_id
            event(report, path, 'checkpoint-response', snapshot_id=snapshot.snapshot_id,
                  observed=info(sandbox.sandbox_id), processes=processes(sandbox.sandbox_id))
            event(report, path, 'snapshot-restore-request',
                  sdk_call={'snapshot_id': snapshot.snapshot_id, 'timeout': 600,
                            'metadata': {'sdk-repro-run': run_id, 'sdk-repro-role': 'restored'}})
            restored = Sandbox.create(snapshot.snapshot_id, timeout=600,
                metadata={'sdk-repro-run': run_id, 'sdk-repro-role': 'restored'},
                lifecycle={'on_timeout': 'pause', 'auto_resume': False})
            report['restored_sandbox_id'] = restored.sandbox_id
            event(report, path, 'snapshot-restore-response', sandbox_id=restored.sandbox_id,
                  observed=info(restored.sandbox_id), processes=processes(restored.sandbox_id))
            report['restored_postconditions'] = verify(restored, nonce, file_hash)
        else:
            event(report, path, 'pause-request', sdk_call={'sandbox_id': sandbox.sandbox_id, 'keep_memory': True})
            paused = sandbox.pause(keep_memory=True)
            event(report, path, 'pause-response', returned=paused,
                  observed=info(sandbox.sandbox_id), processes=processes(sandbox.sandbox_id))
            if paused is not True:
                raise AssertionError('Pause did not accept a running sandbox')
            event(report, path, 'explicit-connect-request', sdk_call={'sandbox_id': sandbox.sandbox_id})
            sandbox = Sandbox.connect(sandbox.sandbox_id, timeout=600)
            event(report, path, 'explicit-connect-response', observed=info(sandbox.sandbox_id),
                  processes=processes(sandbox.sandbox_id))
        report['postconditions'] = verify(sandbox, nonce, file_hash)
        report['status'] = 'passed'
    except Exception as error:
        report['status'] = 'failed'
        report['error_type'] = type(error).__name__
        report['error_summary'] = str(error)[:500]
        if sandbox is not None:
            report['passive_after_error'] = info(sandbox.sandbox_id)
            report['processes_after_error'] = processes(sandbox.sandbox_id)
        try:
            report['run_candidates_after_error'] = candidates(run_id)
        except Exception as lookup_error:
            report['candidate_lookup_error_type'] = type(lookup_error).__name__
        raise
    finally:
        report['after'] = host_inventory()
        write_report(path, report)
        print(json.dumps({'run_id': run_id, 'status': report['status'],
                          'evidence': str(path), 'sandbox_id': report.get('sandbox_id'),
                          'snapshot_id': report.get('snapshot_id'),
                          'restored_sandbox_id': report.get('restored_sandbox_id')}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('build', 'checkpoint', 'pause'))
    args = parser.parse_args()
    if args.action == 'build':
        build()
    else:
        baseline(args.action)


if __name__ == '__main__':
    main()
