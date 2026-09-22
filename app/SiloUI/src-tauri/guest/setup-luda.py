#!/usr/bin/python3
"""Provision the pinned desktop tools for the VM's Silo working account."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import tarfile
import tempfile

STATE = Path('/var/lib/silo-desktop')
POLICY = Path('/var/lib/silo/working-account.json')
LOCK = Path('/usr/local/share/silo/luda-lock.json')
PREFIX = Path('/opt/luda')
LOG = Path('/var/log/silo-luda-install.log')


def validate_account():
    if os.geteuid() != 0:
        raise RuntimeError('Luda installation requires guest root')
    try:
        info = POLICY.lstat()
    except FileNotFoundError:
        raise RuntimeError('Luda requires the Silo working account; migrate this VM or create a new VM') from None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('Invalid Silo working account policy permissions')
    if json.loads(POLICY.read_text()) != dict(schemaVersion=1, user='silo', home='/home/silo'):
        raise RuntimeError('Unsupported Silo working account policy')
    account = pwd.getpwnam('silo')
    if (account.pw_uid, account.pw_gid, account.pw_dir) != (1001, 1001, '/home/silo'):
        raise RuntimeError('Unexpected Silo working account')


def read_lock():
    lock = json.loads(LOCK.read_text())
    if (lock.get('version') != '0.3.4' or
            not re.fullmatch('[0-9a-f]{40}', lock.get('commit', '')) or
            not re.fullmatch('[0-9a-f]{64}', lock.get('sha256', ''))):
        raise RuntimeError('Invalid bundled Luda release lock')
    return lock


def read_state():
    try:
        data = json.loads((STATE / 'luda.json').read_text())
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}


def write_state(state, lock):
    path = STATE / 'luda.tmp'
    path.write_text(json.dumps(dict(state=state, version=lock['version'], commit=lock['commit'])) + '\n')
    path.chmod(0o600)
    path.replace(STATE / 'luda.json')


def run(arguments, output):
    subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=output,
                   stderr=subprocess.STDOUT, check=True, timeout=1800,
                   env=dict(os.environ, DEBIAN_FRONTEND='noninteractive'))


def install_release(lock, output):
    with tempfile.TemporaryDirectory(prefix='luda-', dir=STATE) as directory:
        root = Path(directory)
        archive = root / 'source.tar.gz'
        run(['curl', '--silent', '--show-error', '--fail', '--location',
             '--retry', '2', '--connect-timeout', '30', '--max-time', '600',
             '--proto', '=https', '--tlsv1.2',
             'https://codeload.github.com/0xpolarzero/luda/tar.gz/' + lock['commit'],
             '--output', str(archive)], output)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != lock['sha256']:
            raise RuntimeError('Luda download checksum mismatch')
        source = root / ('luda-' + lock['commit'])
        with tarfile.open(archive, 'r:gz') as contents:
            # The release contains source files only. Reject links and paths
            # outside its single expected top-level directory before extraction.
            for member in contents.getmembers():
                parts = Path(member.name).parts
                if (not parts or parts[0] != source.name or '..' in parts or
                        not (member.isfile() or member.isdir())):
                    raise RuntimeError('Invalid Luda source archive')
            contents.extractall(root, filter='data')
        run(['bash', str(source / 'scripts/install.sh'), '--prefix', str(PREFIX),
             '--user', 'silo', '--agent', 'all', '--yes'], output)


def provision(repair=False):
    validate_account()
    lock = read_lock()
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / 'luda.lock').open('w') as guard:
        try:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Luda installation is already running') from None
        previous = read_state()
        python = PREFIX / 'current/.venv/bin/python'
        matches = (previous.get('state') == 'ready' and previous.get('commit') == lock['commit']
                   and python.is_file() and os.access(python, os.X_OK))
        if matches and previous.get('state') == 'ready' and not repair:
            return
        write_state('installing', lock)
        try:
            # Replace each attempt's private log rather than accumulating output.
            fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as output:
                if repair and matches:
                    run([str(python), '-m', 'luda.setup', '--prefix', str(PREFIX),
                         '--user', 'silo', '--agent', 'all', '--yes'], output)
                else:
                    install_release(lock, output)
            write_state('ready', lock)
        except Exception:
            write_state('failed', lock)
            raise RuntimeError('Desktop tools installation failed; retry setup or inspect /var/log/silo-luda-install.log') from None


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repair', action='store_true', help='Reapply agent setup using the installed runtime')
    args = parser.parse_args()
    try:
        provision(args.repair)
    except Exception as error:
        parser.exit(1, str(error) + '\n')
