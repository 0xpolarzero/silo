#!/usr/bin/env python3
"""Migrate one standard pre-0.8 Silo VM. Dry-run unless --apply is supplied."""
import argparse
import json
import os
from pathlib import Path
import subprocess

GUEST = Path(__file__).resolve().parents[1] / 'src-tauri/guest'


def inspect_legacy(data):
    config = data['config']
    labels = config.get('labels', {})
    if labels.get('silo.managed') != 'true' or not labels.get('silo.machine-id'):
        raise ValueError('Select a Silo-managed VM.')
    if labels.get('silo.working-account') == '1':
        raise ValueError('This VM already uses the silo account.')
    if 'silo.working-account' in labels:
        raise ValueError('Unknown working-account version.')
    mounts = [mount for mount in config.get('mounts', []) if mount.get('type') != 'Tmpfs']
    if len(mounts) != 1 or any(mounts[0].get(k) != v for k, v in {
        'type': 'DiskImage', 'guest': '/workspace', 'format': 'Raw', 'fstype': 'ext4'
    }.items()):
        raise ValueError('Migration requires the standard ext4 workspace disk.')
    if data['status'] not in ('Running', 'Stopped', 'Created'):
        raise ValueError('VM must be running or cleanly stopped.')
    return Path(mounts[0]['host'])


def copy_disk(source, destination):
    # Preserve zero extents in Silo's sparse raw workspace disks.
    with source.open('rb') as reader, destination.open('xb') as writer:
        while chunk := reader.read(1024 * 1024):
            if chunk.count(0) == len(chunk):
                writer.seek(len(chunk), 1)
            else:
                writer.write(chunk)
        writer.truncate(reader.tell())
    destination.chmod(0o600)


def migrate(msb, name, backup, apply=False, run=subprocess.run, resume=False):
    def command(*args):
        result = run([str(msb), *args], check=True, capture_output=True, text=True)
        return result.stdout

    if command('--silo-working-account-protocol').strip() != '1':
        raise ValueError('Use the msb runtime bundled with Silo 0.8 or later.')
    state = json.loads(command('inspect', name, '--format', 'json'))
    workspace = inspect_legacy(state)
    print(f'{name}: copy root and desktop homes into /home/silo (UID/GID 1001), migrate workspace ownership, verify, then set the account label.')
    if not apply:
        print('Dry run: no VM changes. --apply stops sessions, backs up the root and workspace disks, and leaves the VM stopped.')
        return
    if backup is None:
        raise ValueError('--backup-dir is required with --apply.')
    backup = backup.resolve()
    if resume:
        saved = json.loads((backup / 'inspect.json').read_text())
        original_workspace = inspect_legacy(saved)
        if (saved['config']['labels']['silo.machine-id'] != state['config']['labels']['silo.machine-id']
                or original_workspace != workspace
                or (backup / 'workspace.raw').stat().st_size != workspace.stat().st_size):
            raise ValueError('The backup does not match this VM and workspace.')
        command('snapshot', 'verify', str(backup / 'root'))
    else:
        backup.mkdir(parents=True, exist_ok=False)
        backup.chmod(0o700)
    if state['status'] == 'Running':
        command('stop', name)
    if not resume:
        # msb snapshots capture the root upper layer, not attached workspace disks.
        command('snapshot', 'create', '--from', name, '--dest-dir', str(backup), 'root', '--integrity')
        copy_disk(workspace, backup / 'workspace.raw')
        (backup / 'inspect.json').write_text(json.dumps(state, indent=2) + '\n')
        (backup / 'workspace-source.txt').write_text(str(workspace) + '\n')
    print(f'Backup: {backup}')
    command('start', name)
    try:
        command('exec', name, '--no-start', '--no-tty', '--timeout', '30m', '--user', 'root', '--', '/bin/sh', '-ec',
                '. /etc/os-release; test "$ID $VERSION_ID" = "ubuntu 24.04"; '
                'if ! command -v python3 >/dev/null || ! command -v sudo >/dev/null || ! test -x /usr/lib/openssh/sftp-server; then '
                'apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 sudo openssh-sftp-server; fi')
        payload = (GUEST / 'migrate-working-account.py').read_text()
        helper = (GUEST / 'desktop-service.py').read_text()
        command('exec', name, '--no-start', '--no-tty', '--timeout', '30m', '--user', 'root', '--', 'python3', '-c', payload, helper, *(['--resume'] if resume else []))
    finally:
        command('stop', name)
    # Never advertise the new account until guest verification and clean stop succeed.
    command('modify', name, '--label', 'silo.working-account=1')
    verified = json.loads(command('inspect', name, '--format', 'json'))
    if verified['config']['labels'].get('silo.working-account') != '1':
        raise RuntimeError('Guest migrated, but the VM label was not saved.')
    print('Migration complete. Start the VM in Silo. Keep the backup until you have checked your agents and files.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('name', help='Exact msb sandbox name')
    parser.add_argument('--msb', type=Path, required=True, help='Silo bundled msb executable')
    parser.add_argument('--runtime-home', type=Path, required=True, help='Silo runtime MSB_HOME on this computer')
    parser.add_argument('--library', type=Path, help='Bundled libkrunfw when required by the host')
    parser.add_argument('--backup-dir', type=Path, help='New directory for the automatic backup')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--resume', action='store_true', help='Resume an interrupted migration using its original --backup-dir')
    args = parser.parse_args()
    os.environ.update(MSB_HOME=str(args.runtime_home.absolute()), MSB_BACKEND='local', MSB_PATH=str(args.msb.resolve()))
    if args.library:
        os.environ['MSB_LIBKRUNFW_PATH'] = str(args.library.resolve())
    try:
        migrate(args.msb.resolve(), args.name, args.backup_dir, args.apply, resume=args.resume)
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        detail = f'command exited {error.returncode}' if isinstance(error, subprocess.CalledProcessError) else str(error)
        if isinstance(error, subprocess.CalledProcessError) and args.backup_dir and args.backup_dir.is_dir():
            diagnostics = args.backup_dir / 'migration-error.log'
            fd = os.open(diagnostics, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as output:
                output.write((error.stdout or '') + (error.stderr or ''))
            detail += f'; private diagnostics: {diagnostics}'

        parser.exit(1, f'Migration stopped: {detail}\nKeep the backup; do not relabel the VM manually.\n')


if __name__ == '__main__':
    main()
