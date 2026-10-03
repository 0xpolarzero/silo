#!/usr/bin/python3
"""Explicitly install pinned LCU against an already-running Silo desktop."""
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
import sys
import tarfile
import tempfile

STATE = Path('/var/lib/silo-desktop')
POLICY = Path('/var/lib/silo/working-account.json')
LOCK = Path('/usr/local/share/silo/lcu-lock.json')
PREFIX = Path('/opt/lcu')
APP = Path('/usr/lib/chatgpt')
RECEIPT = STATE / 'lcu.json'
LOG = Path('/var/log/silo-lcu-install.log')
STATUS_COMMAND = ['/usr/local/bin/silo-desktop', 'status']
PHASES = {'pi': ('skill', 'extension'), 'codex': ('skill', 'MCP'),
          'claude-code': ('skill', 'MCP')}
NATIVE_DESKTOP_RUNTIME_SHA256 = 'da97d7a6b84505026c8ddada177735c50fb555f1cbb93c2d3205caa4a76f56fc'
NATIVE_DESKTOP_SETUP_SHA256 = '5e0d071d7ad8ec272dd4311f5c2866ab0c46653b8a0292c8855dd56ab5f0aa39'
NATIVE_DESKTOP_SIDECAR = b'''#!/bin/sh
set -eu

case ${NODE_REPL_NODE_PATH-} in
    */*) node_repl="${NODE_REPL_NODE_PATH%/*}/node_repl" ;;
    *) printf '%s\\n' 'LCU: NODE_REPL_NODE_PATH must name the bundled Node executable.' >&2; exit 127 ;;
esac

if [ ! -x "$node_repl" ]; then
    printf '%s\\n' 'LCU: bundled node_repl executable is missing.' >&2
    exit 127
fi

exec "$node_repl" --disable-sandbox "$@"
'''
NATIVE_DESKTOP_HELPER = b'''\ndef _native_node_repl_path(root, node_repl, target, env):
    opt_in = env.get('LCU_LINUX_NATIVE_DESKTOP')
    if opt_in not in (None, '0', '1'):
        raise ValueError('LCU_LINUX_NATIVE_DESKTOP must be 1 when enabled.')
    if opt_in != '1':
        return node_repl
    if target != 'linux':
        raise ValueError('LCU_LINUX_NATIVE_DESKTOP is supported only on Linux.')
    return root / 'bin/node-repl-disable-sandbox'

'''


def read_lock(path=LOCK):
    lock = json.loads(Path(path).read_text())
    assets = lock.get('assets', {})
    if lock.get('version') != '0.4.0' or lock.get('prefix') != str(PREFIX):
        raise RuntimeError('Invalid bundled LCU release lock')
    for arch in ('aarch64', 'x86_64'):
        asset = assets.get(arch, {})
        if (not asset.get('url', '').startswith('https://github.com/0xpolarzero/lcu/releases/download/v0.4.0/') or
                not re.fullmatch('[0-9a-f]{64}', asset.get('sha256', ''))):
            raise RuntimeError('Invalid bundled LCU release asset')
    return lock


def agent_registrations(output):
    """Only report an adapter when upstream confirms every required phase."""
    completed = {name: set() for name in PHASES}
    labels = {'Pi': 'pi', 'Codex': 'codex', 'Claude Code': 'claude-code'}
    for line in output.splitlines():
        match = re.fullmatch(r'(Pi|Codex|Claude Code): (skill|extension|MCP) registered\.', line.strip())
        if match:
            completed[labels[match.group(1)]].add(match.group(2))
    return sorted(name for name, phases in PHASES.items() if set(phases) <= completed[name])


def official_app_present(app=APP):
    try:
        info = Path(app).lstat()
    except OSError:
        return False
    return stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)


def receipt_status(receipt_path=RECEIPT, prefix=PREFIX, app=APP):
    """Read status only; never invoke LCU or alter agent configuration."""
    if not official_app_present(app):
        return {'status': 'needs-runtime', 'reason': 'chatgpt-app-required',
                'requiredRuntime': 'official-chatgpt-linux'}
    try:
        info = Path(receipt_path).lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022):
            return {'status': 'repair-required', 'reason': 'invalid-receipt'}
        receipt = json.loads(Path(receipt_path).read_text())
    except FileNotFoundError:
        return {'status': 'not-installed'}
    except (OSError, ValueError):
        return {'status': 'repair-required', 'reason': 'invalid-receipt'}
    if not isinstance(receipt, dict):
        return {'status': 'repair-required', 'reason': 'invalid-receipt'}
    if receipt.get('schemaVersion') != 1:
        return {'status': 'repair-required', 'reason': 'unsupported-receipt'}
    if receipt.get('status') == 'failed':
        return {'status': 'failed', 'reason': receipt.get('reason', 'setup-failed')}
    if receipt.get('status') == 'installing':
        return {'status': 'installing', 'version': receipt.get('version')}
    current = Path(prefix) / 'current'
    runtime = current / 'bin/lcu'
    managed_app = current / 'app'
    if (receipt.get('status') != 'ready' or not current.is_symlink() or
            not runtime.is_file() or not os.access(runtime, os.X_OK) or
            not managed_app.is_dir()):
        return {'status': 'repair-required', 'reason': 'managed-runtime-missing'}
    return {key: receipt[key] for key in
            ('status', 'version', 'architecture', 'appVersion', 'runtimeVersion',
             'agents', 'readiness') if key in receipt}


def validate_account():
    if os.geteuid() != 0:
        raise RuntimeError('LCU setup requires guest root')
    try:
        info = POLICY.lstat()
    except FileNotFoundError:
        raise RuntimeError('LCU requires the Silo working account; migrate this computer or create a new computer') from None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('Invalid Silo working account policy permissions')
    if json.loads(POLICY.read_text()) != dict(schemaVersion=1, user='silo', home='/home/silo'):
        raise RuntimeError('Unsupported Silo working account policy')
    account = pwd.getpwnam('silo')
    if (account.pw_uid, account.pw_gid, account.pw_dir) != (1001, 1001, '/home/silo'):
        raise RuntimeError('Unexpected Silo working account')


def desktop_session_running():
    result = subprocess.run(STATUS_COMMAND, check=True, capture_output=True, text=True, timeout=20)
    state = json.loads(result.stdout)
    return state.get('sessionState', state.get('state')) == 'running'


def write_receipt(receipt):
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.lcu-', dir=STATE)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(json.dumps(receipt, sort_keys=True) + '\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, RECEIPT)
        directory = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def run(arguments, output, *, user=False, extra_env=None):
    if user:
        arguments = ['runuser', '-u', 'silo', '--', *arguments]
    environment = dict(os.environ, DEBIAN_FRONTEND='noninteractive')
    # This opt-in belongs only to the generated MCP launch environment. Setup
    # receives it to persist there; curl/install/doctor never inherit it.
    environment.pop('LCU_LINUX_NATIVE_DESKTOP', None)
    if extra_env:
        environment.update(extra_env)
    subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=output,
                   stderr=subprocess.STDOUT, check=True, timeout=1800,
                   env=environment)


def extract_archive(contents, destination, expected_root):
    for member in contents.getmembers():
        parts = Path(member.name).parts
        if (not parts or parts[0] != expected_root or '..' in parts or
                not (member.isfile() or member.isdir() or member.issym())):
            raise RuntimeError('Invalid LCU release archive')
    contents.extractall(destination, filter='data')


def prepare_native_desktop_release(source, machine, output):
    """Apply the pinned Linux native-desktop opt-in to a verified release copy."""
    source = Path(source)
    runtime = source / 'lcu/runtime.py'
    info = runtime.lstat()
    if not stat.S_ISREG(info.st_mode) or runtime.is_symlink():
        raise RuntimeError('Bundled LCU runtime is not a regular file')
    original = runtime.read_bytes()
    if hashlib.sha256(original).hexdigest() != NATIVE_DESKTOP_RUNTIME_SHA256:
        raise RuntimeError('Unsupported bundled LCU runtime; refusing compatibility patch')

    environment_marker = b'\ndef environment(root, resolved=None, *, chrome=False):\n'
    env_marker = b'    env = dict(os.environ)\n'
    repl_marker = b'CUA_REPL_NODE_REPL_PATH=str(node_repl),'
    if (original.count(environment_marker) != 1 or original.count(env_marker) != 1 or
            original.count(repl_marker) != 1):
        raise RuntimeError('Pinned LCU runtime compatibility patch context changed')
    patched = original.replace(environment_marker, NATIVE_DESKTOP_HELPER + environment_marker)
    patched = patched.replace(env_marker, env_marker +
        b"    node_repl_path = _native_node_repl_path(root, node_repl, target, env)\n")
    patched = patched.replace(repl_marker, b'CUA_REPL_NODE_REPL_PATH=str(node_repl_path),')
    runtime.write_bytes(patched)

    patch_native_desktop_registration(source / 'lcu/setup.py')

    sidecar = source / 'bin/node-repl-disable-sandbox'
    try:
        fd = os.open(sidecar, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
    except FileExistsError:
        raise RuntimeError('Unexpected LCU native desktop sidecar already exists') from None
    with os.fdopen(fd, 'wb') as launcher:
        launcher.write(NATIVE_DESKTOP_SIDECAR)
        launcher.flush()
        os.fsync(launcher.fileno())
    os.chmod(sidecar, 0o755)

    arch = {'aarch64': 'arm64', 'x86_64': 'x64'}.get(machine)
    if arch is None:
        raise RuntimeError('Unsupported architecture for LCU compatibility bundle')
    seal_and_verify = '''import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / 'scripts'))
from bundle import seal, verify
root = Path(sys.argv[1])
seal(root, sys.argv[2])
verify(root, sys.argv[2])
'''
    run([sys.executable, '-B', '-c', seal_and_verify, str(source), arch], output)


def patch_native_desktop_registration(setup_source):
    setup_source = Path(setup_source)
    info = setup_source.lstat()
    if not stat.S_ISREG(info.st_mode) or setup_source.is_symlink():
        raise RuntimeError('Bundled LCU setup module is not a regular file')
    original = setup_source.read_bytes()
    if hashlib.sha256(original).hexdigest() != NATIVE_DESKTOP_SETUP_SHA256:
        raise RuntimeError('Unsupported bundled LCU setup module; refusing compatibility patch')

    old_register = b"""const [cli, agent, scope, commandJson, policyJson] = process.argv.slice(1);
const { agents, upsertServer } = await import(pathToFileURL(join(dirname(cli), 'lib.js')));
if (agent === 'codex') {
  const transform = agents.codex.transformConfig;
  const policy = JSON.parse(policyJson);
  agents.codex.transformConfig = (...args) => ({ ...transform(...args), ...policy });
}
const [command, ...args] = JSON.parse(commandJson);
const result = upsertServer(agent, 'lcu', { command, args }, { local: scope === 'project', cwd: process.cwd() });"""
    new_register = b"""const [cli, agent, scope, commandJson, policyJson, envJson] = process.argv.slice(1);
const { agents, upsertServer } = await import(pathToFileURL(join(dirname(cli), 'lib.js')));
if (agent === 'codex') {
  const transform = agents.codex.transformConfig;
  const policy = JSON.parse(policyJson);
  agents.codex.transformConfig = (...args) => ({ ...transform(...args), ...policy });
}
const [command, ...args] = JSON.parse(commandJson);
const server = { command, args };
const env = JSON.parse(envJson);
if (Object.keys(env).length) server.env = env;
const result = upsertServer(agent, 'lcu', server, { local: scope === 'project', cwd: process.cwd() });"""
    helper_marker = b'\ndef host_policy(release_root):\n'
    helper = b'''\ndef native_desktop_server_env(environ):
    opt_in = environ.get('LCU_LINUX_NATIVE_DESKTOP')
    if opt_in not in (None, '0', '1'):
        raise ValueError('LCU_LINUX_NATIVE_DESKTOP must be 1 when enabled.')
    if opt_in != '1':
        return {}
    if sys.platform != 'linux':
        raise ValueError('LCU_LINUX_NATIVE_DESKTOP is supported only on Linux.')
    return {'LCU_LINUX_NATIVE_DESKTOP': '1'}

'''
    configure_marker = b'    env = installer_environment(home, names, environ)\n'
    configure_insert = (configure_marker +
        b"    server_env = native_desktop_server_env(env)\n"
        b"    if server_env and not ({'codex', 'claude-code'} & set(names)):\n"
        b"        raise ValueError('LCU_LINUX_NATIVE_DESKTOP requires a Codex or Claude Code MCP server.')\n")
    old_command = b'client.mcp_agent, scope, json.dumps(mcp_command), json.dumps(host_policy(release_root))]))'
    new_command = (b'client.mcp_agent, scope, json.dumps(mcp_command), json.dumps(host_policy(release_root)),\n'
                   b'                                 json.dumps(server_env)]))')
    if (original.count(old_register) != 1 or original.count(helper_marker) != 1 or
            original.count(configure_marker) != 1 or original.count(old_command) != 1):
        raise RuntimeError('Pinned LCU setup compatibility patch context changed')
    patched = original.replace(old_register, new_register)
    patched = patched.replace(helper_marker, helper + helper_marker)
    patched = patched.replace(configure_marker, configure_insert)
    patched = patched.replace(old_command, new_command)
    setup_source.write_bytes(patched)


def extract_release(lock, output):
    machine = os.uname().machine
    asset = lock['assets'].get(machine)
    if asset is None:
        raise RuntimeError('LCU 0.4.0 has no locked asset for this guest architecture')
    with tempfile.TemporaryDirectory(prefix='lcu-', dir=STATE) as directory:
        root = Path(directory)
        archive = root / 'lcu.tar.gz'
        run(['curl', '--silent', '--show-error', '--fail', '--location',
             '--retry', '2', '--connect-timeout', '30', '--max-time', '600',
             '--proto', '=https', '--tlsv1.2', asset['url'], '--output', str(archive)], output)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != asset['sha256']:
            raise RuntimeError('LCU download checksum mismatch')
        expected = 'lcu-0.4.0-linux-' + ('arm64' if machine == 'aarch64' else 'x64')
        source = root / expected
        with tarfile.open(archive, 'r:gz') as contents:
            extract_archive(contents, root, expected)
        prepare_native_desktop_release(source, machine, output)
        run(['bash', str(source / 'scripts/install.sh'), '--runtime-only',
             '--user', 'silo', '--prefix', str(PREFIX), '--existing-app', str(APP)], output)
    return machine, asset['sha256']


def installed_metadata():
    metadata = json.loads((PREFIX / 'current/installation.json').read_text())
    required = ('package_version', 'runtime', 'architecture')
    if any(not isinstance(metadata.get(key), str) or not metadata[key] for key in required):
        raise RuntimeError('LCU installation metadata is incomplete')
    return metadata


def setup_command():
    return [str(PREFIX / 'current/bin/lcu-session'), '--user', 'silo', '--',
            str(PREFIX / 'current/bin/lcu'), 'setup', '--prefix', str(PREFIX),
            '--user', 'silo', '--agent', 'auto', '--session', 'direct', '--yes']


def doctor_command():
    return [str(PREFIX / 'current/bin/lcu-session'), '--user', 'silo', '--',
            str(PREFIX / 'current/bin/lcu'), 'doctor', '--non-interactive', '--require-ready']


def provision():
    validate_account()
    # This hard prerequisite is checked before creating state, downloading or
    # touching either the managed installation or any harness configuration.
    if not official_app_present(APP):
        return {'status': 'needs-runtime', 'reason': 'chatgpt-app-required',
                'requiredRuntime': 'official-chatgpt-linux'}
    lock = read_lock()
    if not desktop_session_running():
        return {'status': 'desktop-session-required', 'reason': 'session-not-running'}
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / 'lcu.lock').open('w') as guard:
        try:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('LCU setup is already running') from None
        receipt = {'schemaVersion': 1, 'status': 'installing', 'version': lock['version'],
                   'agents': [], 'readiness': 'unverified'}
        write_receipt(receipt)
        try:
            fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'w') as output:
                machine, digest = extract_release(lock, output)
                run(setup_command(), output, user=True,
                    extra_env={'LCU_LINUX_NATIVE_DESKTOP': '1'})
                agents = agent_registrations(LOG.read_text(errors='replace'))
                if not agents:
                    raise RuntimeError('LCU did not confirm a maintained agent registration')
                metadata = installed_metadata()
                run(doctor_command(), output, user=True)
            receipt.update(status='ready', architecture=metadata['architecture'], archiveSha256=digest,
                           appPath=str(APP), appVersion=metadata['package_version'],
                           runtimeVersion=metadata['runtime'], agents=agents, readiness='ready')
            write_receipt(receipt)
            return receipt
        except Exception as error:
            if isinstance(error, subprocess.CalledProcessError):
                detail = f'{type(error).__name__}: exit status {error.returncode}'
            else:
                detail = f'{type(error).__name__}: {error}'
            try:
                with LOG.open('a') as output:
                    output.write(f'LCU setup failed: {detail}\n')
            except OSError:
                pass
            receipt.update(status='failed', reason='setup-failed')
            write_receipt(receipt)
            raise RuntimeError('LCU setup failed; inspect /var/log/silo-lcu-install.log') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('status', 'setup'), nargs='?', default='status')
    args = parser.parse_args()
    if args.action == 'status':
        result = receipt_status()
    else:
        try:
            result = provision()
        except Exception as error:
            result = {'status': 'failed', 'reason': 'setup-failed', 'message': str(error)}
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
