#!/usr/bin/env python3
"""Own one private Lima VM; never use the Mac's Docker context or shared mounts."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tarfile
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
BASE_EVIDENCE = ROOT / 'app/SiloUI/src-tauri/target/verification/e2b-local'
DEPLOYMENT_EXPLICIT = 'SILO_E2B_DEPLOYMENT' in os.environ
DEPLOYMENT = os.environ.get('SILO_E2B_DEPLOYMENT', 'incident')
if DEPLOYMENT == 'incident':
    NAME = 'silo-e2b-poc'
    EVIDENCE = BASE_EVIDENCE
    HOST_PORT = 13800
    VIEWER_HOST_PORT = 13801
    default_home = Path.home() / '.silo-e2b-poc/lima'
else:
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,19}', DEPLOYMENT):
        raise ValueError('Scratch deployment name must be a lowercase short slug')
    NAME = 'silo-e2b-' + DEPLOYMENT
    EVIDENCE = BASE_EVIDENCE / 'deployments' / DEPLOYMENT
    default_home = Path.home() / ('.silo-e2b-' + DEPLOYMENT) / 'lima'
    try:
        HOST_PORT = int(os.environ['SILO_E2B_HOST_PORT'])
    except (KeyError, ValueError) as error:
        raise ValueError('Scratch deployment requires SILO_E2B_HOST_PORT') from error
    if not 1024 <= HOST_PORT <= 65534 or HOST_PORT == 13800 or HOST_PORT + 1 == 13800:
        raise ValueError('Scratch control/viewer ports must be valid and must not reuse incident port 13800')
    VIEWER_HOST_PORT = HOST_PORT + 1
LIMA_HOME = Path(os.environ.get('SILO_E2B_VM_HOME', str(default_home))).expanduser().resolve()
if DEPLOYMENT != 'incident' and LIMA_HOME == (Path.home() / '.silo-e2b-poc/lima').resolve():
    raise ValueError('Scratch deployment cannot reuse the incident Lima home')
RUNTIME = 'a065a4ddb3f2c6a4149634d9acb14b62f65839ac'
LIMA_SHA = 'bbdef91774885a0d05f7b048c4eb89ae2bcf3a0c252ae7ca7934e63df76d93c3'
IMAGE_URL = 'https://cloud-images.ubuntu.com/releases/resolute/release-20260720/ubuntu-26.04-server-cloudimg-arm64.img'
IMAGE_SHA = '7bcf159e29ad0000bfed9c57875908c39268f5ed1257f4958fa6a9f5f60edd54'
COMPOSE_SHA = {'compose.yaml': '0ef4902dc0d8e9aa1f16603d2201ddeab3e21456e2d2c50a6663388788b66666',
               '.env': '58f80d93bc155b8ace1ce196eb6f633bb78527cd033b9c7e0a3c849c6b0d0ba6'}


def resolved_lima_config():
    source = (HERE / 'lima.yaml').read_text()
    control_marker = 'guestPort: 3800\n    hostPort: 13800'
    viewer_marker = 'guestPort: 3801\n    hostPort: 13801'
    if source.count(control_marker) != 1 or source.count(viewer_marker) != 1:
        raise RuntimeError('Expected fixed Lima control and viewer forwards')
    return (source.replace(IMAGE_URL, str(EVIDENCE / 'downloads/ubuntu-26.04-arm64.img'))
            .replace(control_marker, f'guestPort: 3800\n    hostPort: {HOST_PORT}')
            .replace(viewer_marker, f'guestPort: 3801\n    hostPort: {VIEWER_HOST_PORT}'))


def download(url, target, digest=None):
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        temporary = target.with_suffix(target.suffix + '.part')
        with urllib.request.urlopen(url, timeout=120) as response, temporary.open('wb') as out:
            while chunk := response.read(1024 * 1024):
                out.write(chunk)
        temporary.replace(target)
    if digest and hashlib.sha256(target.read_bytes()).hexdigest() != digest:
        raise RuntimeError(f'Checksum mismatch: {target}')


def environment():
    # OpenSSH first binds a temporary socket with '.' plus 16 random bytes.
    if len(str(LIMA_HOME / NAME / 'ssh.sock').encode()) + 17 >= 104:
        raise RuntimeError('VM socket path is too long. Set SILO_E2B_VM_HOME to a shorter durable directory.')
    LIMA_HOME.mkdir(parents=True, exist_ok=True, mode=0o700)
    marker = LIMA_HOME.parent / 'owner.json'
    owner = {'uid': os.getuid(), 'repository': str(ROOT), 'name': NAME}
    if marker.exists():
        if json.loads(marker.read_text()) != owner:
            raise RuntimeError('Refusing to use a VM directory owned by another experiment')
    else:
        if any(LIMA_HOME.iterdir()):
            raise RuntimeError('Refusing to adopt an existing Lima directory')
        marker.write_text(json.dumps(owner))
        marker.chmod(0o600)
    return {**os.environ, 'LIMA_HOME': str(LIMA_HOME)}


def lima(*args, **kwargs):
    return subprocess.run([str(EVIDENCE / 'lima/bin/limactl'), *args],
                          env=environment(), check=True, **kwargs)


def guest(command, **kwargs):
    return lima('shell', '--workdir', '/', NAME, 'sh', '-lc', command, **kwargs)


def prepare():
    archive = EVIDENCE / 'downloads/lima-2.2.0-Darwin-arm64.tar.gz'
    download('https://github.com/lima-vm/lima/releases/download/v2.2.0/' + archive.name,
             archive, LIMA_SHA)
    if not (EVIDENCE / 'lima/bin/limactl').exists():
        with tarfile.open(archive) as tar:
            tar.extractall(EVIDENCE / 'lima', filter='data')
    for filename in ('compose.yaml', '.env'):
        download(f'https://raw.githubusercontent.com/e2b-dev/runtime/{RUNTIME}/embed/compose/{filename}',
                 EVIDENCE / 'upstream/runtime/embed/compose' / filename, COMPOSE_SHA[filename])


def deploy(setup=True):
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode='w') as tar:
        for source in HERE.iterdir():
            if source.is_file():
                tar.add(source, arcname=source.relative_to(HERE), recursive=False)
        for filename in ('compose.yaml', '.env'):
            source = EVIDENCE / 'upstream/runtime/embed/compose' / filename
            if filename == '.env':
                content = source.read_bytes() + b'\nHUGEPAGES=4096\n'
                info = tarfile.TarInfo('runtime/.env')
                info.size = len(content)
                info.mode = 0o600
                tar.addfile(info, io.BytesIO(content))
            else:
                tar.add(source, arcname='runtime/' + filename)
    guest('sudo mkdir -p /opt/silo-e2b-poc && sudo tar -xf - -C /opt/silo-e2b-poc',
          input=payload.getvalue())
    if setup:
        guest('sudo sh /opt/silo-e2b-poc/guest-setup.sh')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'up', 'up-sdk', 'deploy', 'sync', 'build', 'test', 'reset-failed-test', 'serve', 'status', 'stop', 'stop-sdk', 'shell', 'collect'])
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.action not in ('status', 'collect') and not DEPLOYMENT_EXPLICIT:
        parser.error('Set SILO_E2B_DEPLOYMENT explicitly; use incident only for an intentional historical-VM operation')
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    if args.action == 'prepare':
        prepare()
    elif args.action == 'up':
        prepare()
        existing = LIMA_HOME / NAME / 'lima.yaml'
        if existing.exists():
            if 'guestPort: 3801' not in existing.read_text():
                raise RuntimeError(
                    'This Lima instance predates the isolated viewer port. '
                    'Use a new scratch deployment name; the driver will not rewrite an existing VM config.')
            environment()
            lima('start', '--tty=false', NAME)
        else:
            image = EVIDENCE / 'downloads/ubuntu-26.04-arm64.img'
            if not image.exists():
                temporary = image.with_suffix('.part')
                subprocess.run(['curl', '-4', '-fL', '--retry', '2', '--connect-timeout', '30',
                                '-o', str(temporary), IMAGE_URL], check=True)
                temporary.replace(image)
            with image.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != IMAGE_SHA:
                    raise RuntimeError('Ubuntu image checksum mismatch')
            config = EVIDENCE / 'lima-resolved.yaml'
            config.write_text(resolved_lima_config())
            lima('start', '--tty=false', '--name', NAME, str(config))
        # E2B's init services recreate ephemeral network namespaces and rules.
        # Docker restart policies alone do not perform this boot reconciliation.
        guest('if sudo test -f /opt/silo-e2b-poc/runtime/compose.yaml; then '
              'cd /opt/silo-e2b-poc/runtime && sudo docker compose up -d --wait --wait-timeout 900; fi')
    elif args.action == 'up-sdk':
        if DEPLOYMENT == 'incident':
            raise RuntimeError('SDK restart control may start only an owned scratch deployment')
        if len(args.command) != 1 or not re.fullmatch(r'[0-9a-f]{32}', args.command[0]):
            raise RuntimeError('SDK restart control requires one exact 32-character run ID')
        if not (LIMA_HOME / NAME / 'lima.yaml').exists():
            raise RuntimeError('SDK restart control requires the existing owned Lima instance')
        preparation = EVIDENCE / 'evidence' / 'sdk-lifecycle' / ('host-restart-prepare-' + args.command[0] + '.json')
        if not preparation.is_file():
            raise RuntimeError('SDK restart control requires the collected preparation report')
        report = json.loads(preparation.read_text())
        if (report.get('run_id'), report.get('status'), report.get('schema')) != (
                args.command[0], 'prepared', 'sdk-host-restart-prepare/v1'):
            raise RuntimeError('SDK restart preparation is not complete')
        lima('start', '--tty=false', NAME)
        guest('cd /opt/silo-e2b-poc/runtime && sudo docker compose up -d --wait --wait-timeout 900')
    elif args.action == 'deploy':
        deploy()
    elif args.action == 'sync':
        deploy(setup=False)
    elif args.action in ('build', 'test'):
        if args.action == 'build':
            guest('cd /opt/silo-e2b-poc && sudo .venv/bin/python template.py')
        else:
            run_id = uuid.uuid4().hex
            print(f'Qualification run ID: {run_id}', flush=True)
            for script in ('qualification.py', 'credential-qualification.py'):
                guest(f'cd /opt/silo-e2b-poc && sudo .venv/bin/python {script} --run-id {run_id}')
    elif args.action == 'reset-failed-test':
        guest('cd /opt/silo-e2b-poc && sudo .venv/bin/python reset-failed-test.py ' + shlex.join(args.command))
    elif args.action == 'serve':
        guest('sudo systemctl restart silo-e2b-poc silo-e2b-poc-viewer && '
              'curl -fs --retry 20 --retry-connrefused --retry-delay 1 --max-time 3 '
              '-o /dev/null http://127.0.0.1:3800/api/state && '
              'curl -fs --retry 20 --retry-connrefused --retry-delay 1 --max-time 3 '
              '-o /dev/null http://127.0.0.1:3801/healthz')
        subprocess.run(['curl', '-fsS', '--max-time', '3',
                        f'http://127.0.0.1:{VIEWER_HOST_PORT}/healthz'], check=True)
        print(f'Open http://127.0.0.1:{HOST_PORT} (viewer origin: http://127.0.0.1:{VIEWER_HOST_PORT})')
    elif args.action == 'status':
        lima('list', NAME)
        guest('uname -a; getconf PAGESIZE; test -c /dev/kvm; free -m; df -h /; '
              'cd /opt/silo-e2b-poc/runtime && sudo docker compose ps')
    elif args.action == 'stop':
        # Fail closed if live desktops cannot be checkpointed. No force-stop.
        guest('if sudo test -f /opt/silo-e2b-poc/shutdown.py; then '
              'cd /opt/silo-e2b-poc && sudo .venv/bin/python shutdown.py; '
              'elif sudo test -d /opt/silo-e2b-poc/state; then '
              'echo "Missing shutdown helper: sync the experiment before stopping" >&2; exit 1; fi')
        lima('stop', NAME)
    elif args.action == 'stop-sdk':
        if DEPLOYMENT == 'incident':
            raise RuntimeError('SDK restart control may stop only an owned scratch deployment')
        if len(args.command) != 1 or not re.fullmatch(r'[0-9a-f]{32}', args.command[0]):
            raise RuntimeError('SDK restart control requires one exact 32-character run ID')
        guest('cd /opt/silo-e2b-poc && sudo .venv/bin/python sdk-host-stop.py '
              + shlex.quote(args.command[0]))
        lima('stop', NAME)
    elif args.action == 'shell':
        guest(shlex.join(args.command))
    elif args.action == 'collect':
        data = guest('sudo tar -cf - -C /opt/silo-e2b-poc evidence', stdout=subprocess.PIPE).stdout
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            tar.extractall(EVIDENCE, filter='data')


if __name__ == '__main__':
    main()
