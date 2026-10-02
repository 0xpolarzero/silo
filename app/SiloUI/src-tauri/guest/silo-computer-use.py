#!/usr/bin/python3
"""Built-in computer use for a Silo guest: LCU against the host's read-only ChatGPT app.

Silo pushes this helper and the pinned pair (`pinned.json`) into the guest, then runs
`apply --approval ask|auto` after each boot, whenever the app becomes ready and when the
user changes the VM's approval switch. The helper is a plain executor: the host decides
the mode, serializes the runs and keeps the result. `apply` is idempotent and cheap when
nothing changed:

* the pinned ChatGPT app folder must be mounted read-only at /opt/silo/chatgpt;
* the pinned LCU archive (staged in the guest image, or downloaded and hash-checked)
  is extracted to local disk and installed in place against that folder;
* `lcu setup --agent auto --session direct --yes --approval <mode>` runs as `silo`;
* `lcu status --json` and `lcu doctor` (inside the desktop session) are recorded. After a
  boot the helper waits for the session (bounded) and, when the session ended up failed
  or stopped although the desktop starts with the VM, asks `silo-desktop start` for it
  again a few times with backoff instead of failing the receipt.

The result is a receipt under /var/lib/silo-computer-use that `status` projects
for the host, and `apply` prints that status plus this run's approval outcome
(`applied`, `partial` when `lcu setup` configured some agents and failed for others, or
`failed`). Nothing here talks to the host or holds credentials. The approval switch
configures agents' own approval prompts; agents in the VM have root, so it is a
convenience and not a security boundary, and the helper keeps no record to defend.
"""
import argparse
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

STATE = Path('/var/lib/silo-computer-use')
PINNED = STATE / 'pinned.json'
RECEIPT = STATE / 'receipt.json'
LOCK = STATE / 'lock'
STAGE = STATE / 'stage'
LOG = Path('/var/log/silo-computer-use.log')
IMAGE_DIR = Path('/usr/local/share/silo/lcu')
PREFIX = Path('/opt/lcu')
MOUNT = Path('/opt/silo/chatgpt')
DESKTOP_COMMAND = '/usr/local/bin/silo-desktop'
DESKTOP = [DESKTOP_COMMAND, 'status']
DESKTOP_CONFIG = Path('/var/lib/silo-desktop/config.json')
USER = 'silo'
HOME = '/home/silo'
SCHEMA = 1
APP_NAME = re.compile(r'[0-9][0-9A-Za-z.+~-]{0,63}-(arm64|amd64)')
VERSION = re.compile(r'[0-9][0-9A-Za-z.+~-]{0,63}')
SHA256 = re.compile(r'[0-9a-f]{64}')
ARCHIVE_NAME = re.compile(r'lcu-[0-9][0-9A-Za-z.+~-]{0,31}-linux-(arm64|x64)\.tar\.gz')
APPROVALS = ('ask', 'auto')
COMPATIBILITY = ('tested', 'untested', 'unknown')
SESSION_WAIT_BOOT = 300
SESSION_WAIT = 90
# After a boot a failed or stopped session is started again this many times, waiting
# SESSION_REPAIR_BASE * 2 ** (n - 1) seconds before attempt n.
SESSION_REPAIR_ATTEMPTS = 3
SESSION_REPAIR_BASE = 2
LOCK_WAIT = 1800


class Failure(Exception):
    """A step failed in a way the receipt can name (`reason` is a stable code)."""

    def __init__(self, reason, detail=''):
        super().__init__(detail or reason)
        self.reason = reason


def now():
    return int(time.time())


def log(text):
    try:
        fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as output:
            output.write(text if text.endswith('\n') else text + '\n')
    except OSError:
        pass


def write_json(path, value):
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.tmp-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(json.dumps(value, sort_keys=True) + '\n')
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def read_json(path):
    try:
        info = path.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or not path.is_file():
            return None
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def load_pinned():
    """The pair the host pinned, or None when absent or malformed."""
    value = read_json(PINNED)
    if not value or value.get('schemaVersion') != SCHEMA:
        return None
    app, lcu = value.get('app'), value.get('lcu')
    try:
        if (not APP_NAME.fullmatch(app['dir']) or not VERSION.fullmatch(app['version']) or
                not VERSION.fullmatch(lcu['version']) or not SHA256.fullmatch(lcu['sha256']) or
                not ARCHIVE_NAME.fullmatch(lcu['archive']) or
                not str(lcu['url']).startswith('https://') or
                not (app.get('runtime') is None or isinstance(app['runtime'], str))):
            return None
    except (KeyError, TypeError):
        return None
    return value


def mount_state(mount=MOUNT, mounts=Path('/proc/mounts')):
    """`ok` for a read-only mount at the app folder, else `missing` or `writable`."""
    try:
        lines = mounts.read_text().splitlines()
    except OSError:
        return 'missing'
    found = None
    for line in lines:
        fields = line.split()
        if len(fields) >= 4 and fields[1] == str(mount):
            found = fields[3].split(',')
    if found is None:
        return 'missing'
    return 'ok' if 'ro' in found else 'writable'


def app_folder(pinned):
    return MOUNT / pinned['app']['dir']


def app_present(pinned):
    folder = app_folder(pinned)
    try:
        info = folder.lstat()
    except OSError:
        return False
    return folder.is_dir() and not folder.is_symlink() and bool(info)


def lock_held():
    """True while another process runs `sync` (the lock is taken without waiting)."""
    try:
        STATE.mkdir(mode=0o755, parents=True, exist_ok=True)
        with open(LOCK, 'a') as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            fcntl.flock(handle, fcntl.LOCK_UN)
    except OSError:
        return False
    return False


def matches_pair(receipt, pinned):
    return (receipt.get('schemaVersion') == SCHEMA and receipt.get('appDir') == pinned['app']['dir']
            and receipt.get('lcuVersion') == pinned['lcu']['version']
            and receipt.get('archiveSha256') == pinned['lcu']['sha256'])


def matches(receipt, pinned, approval):
    """Whether the receipt shows a run for this pair that applied `approval` completely."""
    return (matches_pair(receipt, pinned) and receipt.get('approval') == approval
            and receipt.get('approvalOutcome') == 'applied')


def clean(value, pattern=VERSION):
    return value if isinstance(value, str) and pattern.fullmatch(value) else None


def clean_text(value, limit=300):
    if not isinstance(value, str):
        return None
    value = ''.join(ch for ch in value if ch.isprintable())[:limit].strip()
    return value or None


def status(pinned=None, receipt=None):
    """What the host shows, from the receipt alone. Never runs LCU."""
    pinned = pinned or load_pinned()
    mount = mount_state()
    result = {'schemaVersion': SCHEMA, 'state': 'not-set-up', 'reason': None, 'mount': mount,
              'compatibility': None, 'warning': None, 'appVersion': None,
              'runtimeVersion': None, 'lcuVersion': None, 'agents': None, 'readiness': None}
    if pinned is None:
        result['reason'] = 'not-configured'
        return result
    if not app_present(pinned):
        result.update(state='needs-app', reason='app-missing')
        return result
    receipt = receipt if receipt is not None else read_json(RECEIPT)
    held = lock_held()
    # The receipt describes the last run, whatever mode it applied.
    if receipt and matches_pair(receipt, pinned):
        state = receipt.get('state')
        if state == 'installing' and not held:
            result.update(state='failed', reason='interrupted')
        elif state in ('installing', 'ready', 'failed'):
            result.update(state=state, reason=clean(receipt.get('reason'), re.compile(r'[a-z0-9-]{1,40}')))
        if state in ('ready', 'failed'):
            compat = receipt.get('compatibility')
            result.update(
                compatibility=compat if compat in COMPATIBILITY else None,
                warning=clean_text(receipt.get('warning')),
                appVersion=clean(receipt.get('appVersion')),
                runtimeVersion=clean_text(receipt.get('runtimeVersion'), 64),
                lcuVersion=clean(receipt.get('lcuVersion')),
                readiness=receipt.get('readiness') if receipt.get('readiness') in ('ready', 'failed', 'unverified') else None,
                agents=sorted(a for a in receipt.get('agents') or []
                              if isinstance(a, str) and re.fullmatch(r'[a-z0-9-]{1,32}', a)))
    elif held:
        result.update(state='installing')
    if mount != 'ok' and result['state'] in ('ready', 'not-set-up'):
        result.update(state='failed', reason='mount-' + mount)
    return result


def run(argv, *, user=False, timeout=900, check=True, cwd=None, extra_env=None, quiet=False):
    """Runs a command with no stdin, appending its output to the log (except a listing)."""
    if user:
        argv = ['runuser', '-u', USER, '--', 'env', f'HOME={HOME}', f'USER={USER}',
                f'LOGNAME={USER}', *argv]
    environment = dict(os.environ, DEBIAN_FRONTEND='noninteractive')
    if extra_env:
        environment.update(extra_env)
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, timeout=timeout,
                                cwd=cwd, env=environment, errors='replace')
    except subprocess.TimeoutExpired:
        log(f'$ {" ".join(argv)}\ntimed out after {timeout}s')
        raise Failure('timed-out', ' '.join(argv[:3])) from None
    log(f'$ {" ".join(argv)}\n{"" if quiet else result.stdout[-4000:]}exit {result.returncode}')
    if check and result.returncode != 0:
        raise Failure('command-failed', f'{argv[0]} exited {result.returncode}')
    return result


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def archive_path(pinned, stage):
    """The pinned archive: the one staged in the image when it matches, else a hash-checked download."""
    lcu = pinned['lcu']
    staged = IMAGE_DIR / lcu['archive']
    if staged.is_file() and not staged.is_symlink() and sha256_file(staged) == lcu['sha256']:
        return staged
    target = stage / lcu['archive']
    try:
        run(['curl', '--silent', '--show-error', '--fail', '--location', '--retry', '2',
             '--connect-timeout', '30', '--max-time', '600', '--proto', '=https',
             '--tlsv1.2', lcu['url'], '--output', str(target)], timeout=700)
    except Failure:
        raise Failure('lcu-archive-unavailable') from None
    if sha256_file(target) != lcu['sha256']:
        target.unlink(missing_ok=True)
        raise Failure('lcu-archive-mismatch')
    return target


def member_is_safe(name):
    parts = Path(name).parts
    return bool(parts) and not name.startswith('/') and '..' not in parts


def extract(archive, stage, root_name):
    listing = run(['tar', '-tzf', str(archive)], timeout=300, quiet=True).stdout.splitlines()
    if not listing or any(not member_is_safe(line) or line.split('/')[0] != root_name for line in listing):
        raise Failure('lcu-archive-invalid')
    run(['tar', '-xzf', str(archive), '-C', str(stage), '--no-same-owner'], timeout=600)
    source = stage / root_name
    if not (source / 'scripts/install.sh').is_file():
        raise Failure('lcu-archive-invalid')
    return source


def lcu_command(name):
    return str(PREFIX / 'current/bin' / name)


def lcu_status():
    """`lcu status --json` as the working account, or None when LCU is not usable."""
    try:
        result = run([lcu_command('lcu'), 'status', '--json'], user=True, timeout=120, check=False)
    except (Failure, OSError):
        return None
    if result.returncode != 0:
        return None
    try:
        value = json.loads(result.stdout)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def install(pinned, stage):
    lcu = pinned['lcu']
    root_name = lcu['archive'][:-len('.tar.gz')]
    archive = archive_path(pinned, stage)
    source = extract(archive, stage, root_name)
    run(['./scripts/install.sh', '--user', USER, '--runtime-only', '--skip-system', '--offline',
         '--existing-app', str(app_folder(pinned)), '--yes'], cwd=source, timeout=900)


def setup(approval):
    """Runs `lcu setup` for the working account and reports this run's outcome:
    `(outcome, agents, reason)`, see `classify_setup`."""
    result = run([lcu_command('lcu'), 'setup', '--agent', 'auto', '--session', 'direct', '--yes',
                  '--approval', approval], user=True, timeout=600, check=False)
    return classify_setup(result.returncode, result.stdout, approval)


AGENT_LABEL = r'([A-Z][A-Za-z ]{1,24})'
# LCU v0.8.1 `configure` (lcu/setup.py) prints `<label>: <phase> failed: <error>` for each
# failed phase to stderr (merged into the output here), and `<label>: approval <mode>:
# <outcome>.` once the approval of an agent whose final registration phase succeeded was
# applied.
FAILED_LINE = re.compile(AGENT_LABEL + r': ([A-Za-z ]{2,24}) failed: ')
APPROVED_LINE = re.compile(AGENT_LABEL + r': approval (?:ask|auto): ')
# `configure` carries on after this phase fails: the agent's registration and approval
# still run, so its failure says nothing about the approval.
UNRELATED_PHASES = {'old skill cleanup'}


def agent_name(label):
    return re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-')


def classify_setup(returncode, output, approval):
    """`(outcome, agents, reason)` of one `lcu setup` run from its exit status and its
    per-agent lines (`Codex: MCP registered.`, `Codex: approval ask: ...`,
    `Codex: approval failed: ...`, `Codex: old skill cleanup failed: ...`).

    The outcome is about the approval, tracked per agent and phase. `applied`: no agent
    failed in a phase that matters (the old skill cleanup does not, nor does a failure
    after the configuration was saved), and it either exited 0 or every agent it names had
    its approval applied. `partial`: some agents were configured and others failed, or it
    failed in a way the lines do not explain after configuring some (when unsure, partial:
    a guess of `failed` would claim nothing changed). `failed`: nothing was configured."""
    failed, approved, seen = set(), set(), set()
    for line in (output or '').splitlines():
        line = line.strip()
        if match := FAILED_LINE.match(line):
            name = agent_name(match.group(1))
            seen.add(name)
            if match.group(2).strip() not in UNRELATED_PHASES:
                failed.add(name)
        elif match := APPROVED_LINE.match(line):
            approved.add(agent_name(match.group(1)))
    agents = registered_agents(output)
    seen |= approved | set(agents)
    if not failed and (returncode == 0 or (approved and seen <= approved)):
        # An explicit approval success is kept whatever else went wrong around it.
        return 'applied', agents, None
    configured = (approved | set(agents)) - failed
    if configured:
        return 'partial', agents, 'setup-partial'
    return 'failed', agents, 'setup-failed'


def registered_agents(output):
    """Agents whose registration `lcu setup` confirmed (`Codex: MCP registered.`)."""
    names = []
    for line in (output or '').splitlines():
        match = re.fullmatch(AGENT_LABEL + r': [A-Za-z ]{2,24} registered\.', line.strip())
        if match:
            name = agent_name(match.group(1))
            if name not in names:
                names.append(name)
    return sorted(names)


def desktop_session():
    """The session state `silo-desktop status` reports (`running`, `starting`, `failed`,
    `stopped`), or None when it cannot be read."""
    try:
        result = subprocess.run(DESKTOP, stdin=subprocess.DEVNULL, capture_output=True,
                                text=True, timeout=30)
        state = json.loads(result.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    value = state.get('sessionState', state.get('state')) if isinstance(state, dict) else None
    return value if isinstance(value, str) else None


def session_running():
    return desktop_session() == 'running'


def desktop_autostart():
    """Whether the desktop starts with the VM (the default when never configured)."""
    value = read_json(DESKTOP_CONFIG)
    return not value or value.get('autoStart') is not False


def start_desktop():
    run([DESKTOP_COMMAND, 'start'], timeout=180, check=False, quiet=True)


def wait_for_session(wait, repair):
    """Waits (bounded) for the desktop session; with `repair`, a session that failed or
    stopped is started again up to SESSION_REPAIR_ATTEMPTS times, then the wait ends."""
    deadline = time.monotonic() + wait
    repairs = 0
    while True:
        state = desktop_session()
        if state == 'running':
            return
        if repair and state in ('failed', 'stopped') and desktop_autostart():
            if repairs >= SESSION_REPAIR_ATTEMPTS:
                raise Failure('desktop-session-not-running')
            repairs += 1
            log(f'desktop session is {state}; starting it again ({repairs} of {SESSION_REPAIR_ATTEMPTS})')
            time.sleep(SESSION_REPAIR_BASE * 2 ** (repairs - 1))
            start_desktop()
            continue
        if time.monotonic() >= deadline:
            raise Failure('desktop-session-not-running')
        time.sleep(2)


def doctor(wait, repair=False):
    """True when `lcu doctor` reports ready inside the desktop session."""
    wait_for_session(wait, repair)
    # The launcher must run as the desktop account itself.
    result = run([lcu_command('lcu-session'), '--user', USER, '--', lcu_command('lcu'),
                  'doctor', '--non-interactive', '--require-ready'], user=True, timeout=300,
                 check=False)
    return result.returncode == 0


def digest(report):
    """The fields of `lcu status --json` Silo shows."""
    report = report or {}
    compat = report.get('compatibility') if isinstance(report.get('compatibility'), dict) else {}
    app = report.get('app') if isinstance(report.get('app'), dict) else {}
    return {
        'compatibility': compat.get('status') if compat.get('status') in COMPATIBILITY else 'unknown',
        'warning': clean_text(compat.get('warning')),
        'appVersion': clean(app.get('version')),
        'runtimeVersion': clean_text(app.get('runtime'), 64),
    }


def write_receipt(pinned, approval, state, reason=None, **fields):
    receipt = {'schemaVersion': SCHEMA, 'state': state, 'reason': reason,
               'appDir': pinned['app']['dir'], 'lcuVersion': pinned['lcu']['version'],
               'archiveSha256': pinned['lcu']['sha256'], 'approval': approval,
               'updatedAt': now()}
    receipt.update(fields)
    write_json(RECEIPT, receipt)
    return receipt


def report(approval, outcome, reason=None):
    """This run's approval outcome, as the host records it."""
    return {'approval': approval, 'outcome': outcome, 'reason': reason}


def apply(approval, force=False, boot=False):
    """Brings computer use up to date for the pinned pair with `approval` configured in
    the agents. Returns the public status plus `apply`, this run's approval outcome.

    The host decides the mode, serializes runs for the VM and keeps the result; nothing is
    remembered here beyond the receipt, so a request is never ignored as stale."""
    pinned = load_pinned()
    if pinned is None:
        return dict(status(None), apply=report(approval, 'failed', 'not-configured'))
    STATE.mkdir(mode=0o755, parents=True, exist_ok=True)
    with open(LOCK, 'a') as handle:
        deadline = time.monotonic() + LOCK_WAIT
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Failure('busy') from None
                time.sleep(1)
        mount = mount_state()
        if mount != 'ok':
            outcome = report(approval, 'failed', 'mount-' + mount)
        elif not app_present(pinned):
            outcome = report(approval, 'failed', 'app-missing')
        else:
            outcome = update(pinned, approval, force, boot)
    # The lock is released: `status` reports `installing` only while another run holds it.
    return dict(status(pinned), apply=outcome)


def installed_for(report, pinned):
    """Whether `lcu status --json` shows the pinned LCU installed against the pinned app folder."""
    if not report or report.get('lcu_version') != pinned['lcu']['version']:
        return False
    app = report.get('app') if isinstance(report.get('app'), dict) else {}
    # LCU links the app in place: its release folder's `app` resolves to the mounted folder.
    try:
        return os.path.realpath(app['path']) == os.path.realpath(app_folder(pinned))
    except (KeyError, TypeError, OSError):
        return False


def update(pinned, mode, force, boot):
    """One run for `mode`; returns its approval report (`report`)."""
    existing = read_json(RECEIPT)
    configured = (not force and existing and existing.get('state') == 'ready'
                  and matches(existing, pinned, mode) and Path(lcu_command('lcu')).exists())
    if configured and not boot:
        # The receipt shows `lcu setup` applied this mode completely.
        return report(mode, 'applied')
    write_receipt(pinned, mode, 'installing')
    # Set once approval is confirmed: later failures (the readiness check) do not change it.
    result = None
    try:
        STAGE.mkdir(mode=0o700, parents=True, exist_ok=True)
        installed = lcu_status() if Path(lcu_command('lcu')).exists() else None
        if not installed_for(installed, pinned):
            install(pinned, STAGE)
            configured = False
        if configured:
            outcome, agents, reason = 'applied', existing.get('agents', []), None
        else:
            outcome, agents, reason = setup(mode)
        if outcome == 'failed':
            raise Failure(reason)
        result = report(mode, outcome, reason)
        digested = digest(lcu_status())
        if not doctor(SESSION_WAIT_BOOT if boot else SESSION_WAIT, repair=boot):
            raise Failure('doctor-failed')
        write_receipt(pinned, mode, 'ready', readiness='ready', agents=agents,
                      approvalOutcome=outcome, verifiedAt=now(), **digested)
    except Failure as failure:
        log(f'computer use setup failed: {failure.reason}: {failure}')
        result = result or report(mode, 'failed', failure.reason)
        write_receipt(pinned, mode, 'failed', failure.reason, readiness='failed',
                      approvalOutcome=result['outcome'])
    except Exception as error:  # noqa: BLE001 - the receipt must always record the end state
        log(f'computer use setup failed: {type(error).__name__}: {error}')
        result = result or report(mode, 'failed', 'setup-failed')
        write_receipt(pinned, mode, 'failed', 'setup-failed', readiness='failed',
                      approvalOutcome=result['outcome'])
    finally:
        subprocess.run(['rm', '-rf', str(STAGE)], check=False)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('status')
    apply_parser = commands.add_parser('apply')
    apply_parser.add_argument('--approval', choices=APPROVALS, required=True)
    apply_parser.add_argument('--force', action='store_true')
    apply_parser.add_argument('--boot', action='store_true')
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        print('Run as root', file=sys.stderr)
        return 1
    try:
        result = status() if args.command == 'status' else apply(args.approval, args.force, args.boot)
    except Failure as failure:
        # The run could not even start (another run held the lock): still a report.
        result = {'schemaVersion': SCHEMA, 'state': 'failed', 'reason': failure.reason}
        if args.command == 'apply':
            result['apply'] = report(args.approval, 'failed', failure.reason)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
