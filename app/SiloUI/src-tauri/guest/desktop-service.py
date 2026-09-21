#!/usr/bin/python3
"""Guest-only desktop lifecycle. No harness or host credentials are involved."""
import fcntl
import json
import os
import pwd
import re
from pathlib import Path
import signal
import socket
import stat
import subprocess
import sys
import time

STATE = Path('/var/lib/silo-desktop')
RUN = Path('/run/silo-desktop')
USER = 'silo'
HOME = Path('/home/silo')
SELF = '/usr/local/bin/silo-desktop'
LOG = Path('/var/log/silo-desktop.log')
WORKING_ACCOUNT = Path('/var/lib/silo/working-account.json')


def validate_policy_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('Working account policy must be a root-owned regular file without group or other write access')


def desktop_account():
    try:
        WORKING_ACCOUNT.lstat()
    except FileNotFoundError:
        raise RuntimeError('Desktop requires the Silo working account; migrate this VM or create a new VM') from None
    validate_policy_file(WORKING_ACCOUNT)
    policy = json.loads(WORKING_ACCOUNT.read_text())
    if policy != dict(schemaVersion=1, user='silo', home='/home/silo'):
        raise RuntimeError('Unsupported Silo working account policy')
    try:
        account = pwd.getpwnam('silo')
    except KeyError:
        raise RuntimeError('Silo working account is missing') from None
    if account.pw_uid != 1001 or account.pw_gid != 1001 or account.pw_dir != '/home/silo':
        raise RuntimeError('Silo working account has an unexpected UID or home')
    return 'silo', Path(account.pw_dir)


def prepare_configuration(home):
    # Only files claimed before an installation attempt may be replaced on retry.
    # The account's unrelated files and directory permissions remain untouched.
    managed = read('configuration-managed.json')
    if managed is not None and managed != {'home': str(home)}:
        raise RuntimeError('Desktop configuration belongs to a different home')
    directory = home / '.vnc'
    paths = [directory / 'kasmvnc.yaml', directory / 'xstartup', home / '.kasmpasswd']
    if home.is_symlink() or directory.is_symlink() or any(path.is_symlink() for path in paths):
        raise RuntimeError('Desktop configuration paths must not be symbolic links')
    if directory.exists() and not directory.is_dir():
        raise RuntimeError('Desktop configuration directory is not a directory')
    if managed is None:
        if any(path.exists() for path in paths):
            raise RuntimeError('Existing desktop configuration conflicts with the Silo desktop; preserve or move it before installing')
        write(STATE / 'configuration-managed.json', {'home': str(home)})


def read(name, default=None):
    try:
        return json.loads((STATE / name).read_text())
    except FileNotFoundError:
        return default


def write(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def identity(pid):
    try:
        # Field 22, accounting for spaces in the parenthesized process name.
        return (Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' +
                Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19])
    except (FileNotFoundError, ProcessLookupError):
        return None


def supervisor():
    try:
        saved = json.loads((RUN / 'supervisor.json').read_text())
        return saved['pid'] if identity(saved['pid']) == saved['start'] else None
    except FileNotFoundError:
        return None


def listening():
    try:
        with socket.create_connection(('127.0.0.1', 6901), timeout=0.3):
            return True
    except OSError:
        return False


def luda_status():
    try:
        data = read('luda.json', {})
        state = data.get('state', 'missing')
        version = data.get('version')
        if state not in ('missing', 'installing', 'ready', 'failed'):
            state = 'failed'
        if not isinstance(version, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
            version = None
        return dict(ludaState=state, ludaVersion=version)
    except (ValueError, AttributeError):
        return dict(ludaState='failed', ludaVersion=None)


def status():
    config = read('config.json', {'autoStart': True})
    state = 'running' if supervisor() and listening() else 'starting' if supervisor() else 'failed' if (RUN / 'failed').exists() else 'stopped'
    return dict(installed=(STATE / 'installed.json').exists(), version='1', state=state,
                autoStart=config['autoStart'], port=6901, user=USER, display=':1', **luda_status())


def start():
    if supervisor():
        return
    (RUN / 'failed').unlink(missing_ok=True)
    account = pwd.getpwnam(USER)
    runtime = RUN / 'user'
    runtime.mkdir(mode=0o700, exist_ok=True)
    os.chown(runtime, account.pw_uid, account.pw_gid)
    os.chmod(runtime, 0o700)
    subprocess.Popen([SELF, 'supervise'], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(100):
        if supervisor() and listening():
            return
        if (RUN / 'failed').exists():
            raise RuntimeError('Desktop failed to start; inspect /var/log/silo-desktop.log')
        time.sleep(0.1)
    raise RuntimeError('Desktop is still starting; check status before retrying')


def stop():
    pid = supervisor()
    if pid:
        os.kill(pid, signal.SIGTERM)
        for _ in range(150):
            if not supervisor():
                break
            time.sleep(0.1)
        else:
            raise RuntimeError('Desktop did not stop; inspect its service log')
    (RUN / 'failed').unlink(missing_ok=True)


def trim_logs():
    # Bound logs without following links writable by the desktop user.
    for path in [LOG, *HOME.glob('.vnc/*.log')]:
        try:
            fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'r+b') as log:
                info = os.fstat(log.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size <= 1024 * 1024:
                    continue
                log.seek(-256 * 1024, os.SEEK_END)
                tail = log.read()
                log.seek(0)
                log.write(tail)
                log.truncate()
        except OSError:
            continue


def stop_display():
    subprocess.run(['runuser', '-u', USER, '--', 'env', f'HOME={HOME}',
                    'vncserver', '-kill', ':1'], stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)


def supervise():
    with (RUN / 'supervisor.lock').open('w') as guard:
        try:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        write(RUN / 'supervisor.json', {'pid': os.getpid(), 'start': identity(os.getpid())})
        stopping = False
        child = None

        def terminate(_signum, _frame):
            nonlocal stopping
            stopping = True
            if child and child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)

        signal.signal(signal.SIGTERM, terminate)
        signal.signal(signal.SIGINT, terminate)
        try:
            for attempt in range(3):
                if stopping:
                    break
                log = LOG
                if log.exists() and log.stat().st_size > 1024 * 1024:
                    log.replace(log.with_suffix('.log.1'))
                with log.open('ab') as output:
                    child = subprocess.Popen(['runuser', '-u', USER, '--', 'env',
                        f'HOME={HOME}', 'USER=' + USER, 'LOGNAME=' + USER,
                        'XDG_RUNTIME_DIR=/run/silo-desktop/user',
                        'vncserver', ':1', '-fg', '-autokill', '-prompt', '0',
                        '-xstartup', str(HOME / '.vnc/xstartup')],
                        stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
                    if stopping and child.poll() is None:
                        os.killpg(child.pid, signal.SIGTERM)
                    while child.poll() is None:
                        trim_logs()
                        try:
                            child.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            continue
                    # A desktop exit ends its own session, never unrelated terminal jobs.
                    try:
                        os.killpg(child.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                stop_display()
                if not stopping:
                    time.sleep(attempt + 1)
            if not stopping:
                (RUN / 'failed').write_text('Desktop exited after three attempts\n')
        except Exception as error:
            (RUN / 'failed').write_text('Desktop service failed; inspect /var/log/silo-desktop.log\n')
            with LOG.open('a') as output:
                output.write(str(error) + '\n')
            raise
        finally:
            try:
                stop_display()
            finally:
                (RUN / 'supervisor.json').unlink(missing_ok=True)


def main():
    global USER, HOME
    if os.geteuid() != 0:
        raise RuntimeError('Run sudo silo-desktop to manage the desktop')
    USER, HOME = desktop_account()
    action = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if action == 'prepare-install':
        prepare_configuration(HOME)
        print(USER, HOME)
        return
    RUN.mkdir(mode=0o755, parents=True, exist_ok=True)
    if action == 'supervise':
        supervise()
        return
    with (RUN / 'operation.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        boot = Path('/proc/sys/kernel/random/boot_id')
        if boot.exists():
            epoch = boot.read_text()
            marker = RUN / 'boot-id'
            if not marker.exists() or marker.read_text() != epoch:
                (RUN / 'failed').unlink(missing_ok=True)
                marker.write_text(epoch)
        if action == 'status':
            pass
        elif action == 'connection':
            print(json.dumps(read('connection.json')))
            return
        elif action == 'start':
            start()
        elif action == 'stop':
            stop()
        elif action == 'restart':
            stop()
            start()
        elif action == 'autostart' and len(sys.argv) == 3 and sys.argv[2] in ('true', 'false'):
            enabled = sys.argv[2] == 'true'
            write(STATE / 'config.json', {'autoStart': enabled})
            if enabled:
                start()
        elif action == 'repair-luda':
            subprocess.run(['python3', '/usr/local/libexec/silo-setup-luda.py', '--repair'], check=True)
        elif action == 'boot':
            if read('config.json', {'autoStart': True})['autoStart']:
                start()
        else:
            raise RuntimeError('Usage: silo-desktop status|connection|start|stop|restart|boot|repair-luda|autostart true|false')
        print(json.dumps(status()))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
