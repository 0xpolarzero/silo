"""Live LCU, checkpoint and SSH tests on fresh run-owned guests only."""
import argparse
import base64
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import shlex
import subprocess
import sys
import time
import threading
import uuid

import httpx
from e2b import Sandbox
from runtime import configure, DESKTOP_ENV
from report_contract import QUALIFICATION_CASES, complete

HERE = Path(__file__).resolve().parent
EVIDENCE = HERE / 'evidence'
PATH = EVIDENCE / 'qualification.json'
CLIENT = httpx.Client(base_url='http://127.0.0.1:3800', timeout=180,
                      headers={'X-Poc-Request': '1'}, trust_env=False)
REPORT = {'status': 'running', 'checks': [], 'desktops': []}


def run_directory(run_id):
    if not re.fullmatch(r'[0-9a-f]{32}', run_id):
        raise ValueError('Run ID must be 32 lowercase hexadecimal characters')
    return HERE / 'evidence' / 'runs' / run_id


def run_manifest():
    sources = ('qualification.py', 'credential-qualification.py', 'credential-broker.py',
               'runtime.py', 'server.py', 'ssh-proxy.py', 'tcp-bridge.py', 'template.py')
    hashes = {}
    for name in sources:
        path = HERE / name
        if path.is_file():
            hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    template = HERE / 'evidence' / 'template.json'
    return {'source_sha256': hashes,
            'template_build_record_sha256': hashlib.sha256(template.read_bytes()).hexdigest() if template.is_file() else None,
            'sdk_version': importlib.metadata.version('e2b'),
            'host_kernel': platform.release(), 'host_arch': platform.machine(),
            'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip() if Path('/proc/sys/kernel/random/boot_id').is_file() else None}


def save():
    PATH.write_text(json.dumps(REPORT, indent=2))


def api(path, data=None):
    r = CLIENT.get('/api/' + path) if data is None else CLIENT.post('/api/' + path, json=data)
    if r.is_error:
        raise AssertionError(f'{path}: HTTP {r.status_code}: {r.text[:2000]}')
    r.raise_for_status()
    return r.json()


def record(sid):
    return next(r for r in api('state')['desktops'] if r['id'] == sid)


def discover_run_desktops():
    """Record creates accepted by the gateway when its HTTP response was lost."""
    try:
        owned = [item['id'] for item in api('state')['desktops']
                 if item.get('run_id') == REPORT['run_id']]
    except Exception as error:
        REPORT['create_reconciliation_error_type'] = type(error).__name__
        save()
        return
    for sid in owned:
        if sid not in REPORT['desktops']:
            REPORT['desktops'].append(sid)
    save()


def shell(sid, command):
    r = api(f'desktops/{sid}/agent/shell', {'command': command})
    assert r['exit_code'] == 0, r
    return r['stdout'].strip()


def js(sid, code, tool='js', **arguments):
    r = api(f'desktops/{sid}/agent/lcu', {'tool': tool, 'arguments': {'code': code, **arguments} if tool == 'js' else {}})
    assert not r.get('isError'), r
    return r


def text(result):
    return '\n'.join(c['text'] for c in result['content'] if c['type'] == 'text')


def check(name, fn):
    start = time.monotonic()
    try:
        detail = fn()
        REPORT['checks'].append({'name': name, 'status': 'pass', 'detail': detail,
                                 'seconds': round(time.monotonic() - start, 2)})
        print('PASS', name, flush=True)
        save()
        return detail
    except Exception as error:
        REPORT['checks'].append({'name': name, 'status': 'fail',
                                 'error_type': type(error).__name__, 'error': str(error)})
        REPORT['status'] = 'failed'
        save()
        raise


def wait(fn, predicate=bool, timeout=20):
    deadline = time.monotonic() + timeout
    result = None
    while time.monotonic() < deadline:
        try:
            result = fn()
            if predicate(result):
                return result
        except (AssertionError, httpx.HTTPError) as error:
            result = str(error)
        time.sleep(.2)
    raise AssertionError('Readiness timeout: ' + str(result))


def isolation_and_network(a, b):
    token = 'silo-' + uuid.uuid4().hex
    sbx = Sandbox.connect(record(a)['sandbox_id'])
    assert shell(a, 'uname -m') == 'aarch64'
    original = shell(a, 'hostname')
    other = shell(b, 'hostname')
    try:
        sbx.commands.run('hostname ' + token, user='root')
        assert shell(a, 'hostname') == token and shell(b, 'hostname') == other
    finally:
        sbx.commands.run('hostname ' + shlex.quote(original), user='root')
    # The destination must be reachable from the host for this to test denial.
    assert httpx.get('http://192.168.5.15:3000/health', trust_env=False).status_code == 200
    probe = '''import socket,json
result=[]
for host,port in [('192.168.5.15',3000),('192.168.5.15',5008),('172.16.0.1',3000)]:
 s=socket.socket();s.settimeout(1)
 try:s.connect((host,port));result.append([host,port,'REACHABLE'])
 except OSError:result.append([host,port,'blocked'])
 finally:s.close()
print(json.dumps(result))
'''
    blocked = json.loads(shell(a, 'python3 -c ' + shlex.quote(probe)))
    assert all(row[2] == 'blocked' for row in blocked), blocked
    metadata = '''import urllib.request
base='http://169.254.169.254'
r=urllib.request.Request(base+'/latest/api/token',method='PUT',headers={'X-metadata-token-ttl-seconds':'60'})
token=urllib.request.urlopen(r,timeout=3).read().decode()
r=urllib.request.Request(base+'/instanceID',headers={'X-metadata-token':token})
print(urllib.request.urlopen(r,timeout=3).read().decode())
'''
    for sid in (a, b):
        assert shell(sid, 'python3 -c ' + shlex.quote(metadata)) == record(sid)['sandbox_id']
    return {'separate_kernel_hostname': True, 'private_destination_probes': blocked,
            'metadata_matches_runtime_identity': True}


def browser_test(a):
    api(f'desktops/{a}/agent/write', {'path': 'browser-test.html',
        'content': '<!doctype html><title>Silo LCU browser qualification</title><h1>Browser works</h1>'})
    shell(a, 'firefox-esr --new-window file:///home/user/browser-test.html >/tmp/browser.log 2>&1 &')
    js(a, '', tool='js_reset')
    js(a, 'await cua.getState();')
    wait(lambda: text(js(a, 'await cua.listWindows();')),
         lambda value: 'Silo LCU browser qualification' in value, timeout=45)
    response = CLIENT.get(f'/api/desktops/{a}/screenshot').raise_for_status()
    assert response.headers['content-type'] == 'image/jpeg' and response.content[:2] == b'\xff\xd8'
    (EVIDENCE / 'lcu-browser.jpg').write_bytes(response.content)
    return {'Firefox_ESR_page_title_observed_by_LCU': True, 'LCU_screenshot_JPEG': True}


FIXTURE = '''from pathlib import Path
import gi
gi.require_version('Gtk','3.0')
from gi.repository import Gtk
windows=[]
for name in ('Target','Other'):
 w=Gtk.Window(title='Silo LCU '+name);w.set_default_size(500,200)
 box=Gtk.Box(orientation=Gtk.Orientation.VERTICAL,spacing=15);box.set_border_width(20);w.add(box)
 entry=Gtk.Entry();entry.get_accessible().set_name('Draft text');entry.set_text('untouched' if name=='Other' else '')
 button=Gtk.Button(label='Save draft');status=Gtk.Label(label='Not saved')
 for widget in (entry,button,status):box.pack_start(widget,False,False,0)
 def save(_,name=name,entry=entry,status=status):
  Path('/home/user/'+name+'.txt').write_text(entry.get_text());status.set_text('Saved: '+entry.get_text())
 button.connect('clicked',save);w.show_all();windows.append(w)
Gtk.main()
'''


def lcu_test(a, b):
    api(f'desktops/{a}/agent/write', {'path': 'lcu-fixture.py', 'content': FIXTURE})
    shell(a, 'python3 /home/user/lcu-fixture.py >/tmp/lcu-fixture.log 2>&1 &')
    js(a, 'await cua.getState();')
    windows = wait(lambda: json.loads(text(js(a, 'nodeRepl.write(JSON.stringify(await cua.listWindows({emit:false})));'))),
                   lambda v: all(any(w.get('title') == 'Silo LCU '+name for w in v)
                                 for name in ('Target', 'Other')))
    target = next(w for w in windows if w.get('title') == 'Silo LCU Target')
    other = next(w for w in windows if w.get('title') == 'Silo LCU Other')
    state = text(js(a, f'let app = await cua.getApp({{windowId:{target["id"]}}});'))
    assert 'at_spi' in state, state
    def element(value, label):
        line = next(line for line in value.splitlines() if label in line)
        match = re.search(r'\[(\d+)\]', line) or re.search(r'^\s*(\d+)\b', line)
        assert match, line
        return match.group(1)
    content = 'Café 日本語 🐧 — saved through LCU'
    state = text(js(a, f'await app.click({json.dumps(element(state,"Draft text"))}); await app.typeText({json.dumps(content)}); await app.getAXState();'))
    js(a, f'await app.click({json.dumps(element(state,"Save draft"))}); await app.getAXState();')
    assert shell(a, 'cat /home/user/Target.txt') == content
    assert 'untouched' in text(js(a, f'let other = await cua.getApp({{windowId:{other["id"]}}});'))
    js(b, 'await cua.getState();')
    assert 'Silo LCU Target' not in text(js(b, 'await cua.listWindows();'))
    assert shell(b, 'test ! -e /home/user/Target.txt && echo isolated') == 'isolated'
    image = next(c for c in js(a, 'await app.getScreenshot();')['content'] if c['type'] == 'image')
    (EVIDENCE / 'lcu-window.jpg').write_bytes(base64.b64decode(image['data']))
    assert image['mimeType'] == 'image/jpeg'
    js(a, 'let lcuMemory = 41;')
    assert text(js(a, 'nodeRepl.write(lcuMemory+1);')) == '42'
    viewer_instance = str(uuid.uuid4())
    api(f'desktops/{a}/mode', {'mode': 'human', 'viewer_instance': viewer_instance})
    denied = CLIENT.post(f'/api/desktops/{a}/agent/lcu', json={'arguments': {'code': 'await app.typeText("UNWANTED");'}})
    assert denied.status_code == 409
    api(f'desktops/{a}/mode', {'mode': 'agent', 'viewer_instance': viewer_instance})
    api(f'desktops/{a}/lifecycle', {'action': 'pause'})
    api(f'desktops/{a}/lifecycle', {'action': 'resume'})
    assert text(js(a, 'nodeRepl.write(lcuMemory+1);')) == '42'
    js(a, '', tool='js_reset')
    js(a, 'await cua.getState();')
    assert text(js(a, 'nodeRepl.write(typeof lcuMemory);')) == 'undefined'
    return {'semantic_accessibility': 'AT-SPI', 'unicode_saved_by_gui': True,
            'window_and_vm_isolation': True, 'pause_keeps_repl_memory': True,
            'reset_clears_repl_memory': True, 'handoff_status': 409}


class SSH:
    def __init__(self, sid):
        self.sid = sid
        self.directory = HERE / 'state' / ('ssh-' + sid)
        self.directory.mkdir(mode=0o700, exist_ok=True)
        self.key = self.directory / 'key'
        if not self.key.exists():
            subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(self.key)], check=True)
        self.authorize()

    def authorize(self):
        result = api(f'desktops/{self.sid}/ssh-key', {'public_key': self.key.with_suffix('.pub').read_text()})
        self.host_key = result['host_key']
        (self.directory / 'known_hosts').write_text('silo-' + self.sid + ' ' + self.host_key + '\n')

    def args(self):
        proxy = shlex.join([sys.executable, str(HERE / 'ssh-proxy.py'), 'http://127.0.0.1:3800', self.sid])
        return ['-i', str(self.key), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
                '-o', 'HostKeyAlias=silo-' + self.sid, '-o', 'UserKnownHostsFile=' + str(self.directory / 'known_hosts'),
                '-o', 'ProxyCommand=' + proxy]

    def run(self, command, data=None, timeout=30):
        return subprocess.run(['ssh', *self.args(), 'user@silo', command], input=data,
                              capture_output=True, timeout=timeout)


def ssh_test(a, b):
    connection = SSH(a)
    payload = os.urandom(2 * 1024 * 1024) + 'Unicode 日本語\n'.encode()
    result = connection.run('cat', payload)
    assert result.returncode == 0 and result.stdout == payload, result.stderr.decode()
    # EOF on input still allows the remote process to return a final result.
    result = connection.run('python3 -c "import sys,hashlib; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())"', payload)
    assert result.stdout.strip().decode() == hashlib.sha256(payload).hexdigest()
    local = connection.directory / 'payload.bin'
    local.write_bytes(payload)
    downloaded = connection.directory / 'download.bin'
    batch = f'put {local} /home/user/sftp.bin\nget /home/user/sftp.bin {downloaded}\n'
    result = subprocess.run(['sftp', *connection.args(), '-b', '-', 'user@silo'], input=batch.encode(), capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr.decode()
    assert downloaded.read_bytes() == payload
    result = connection.run('echo diagnostic >&2; exit 17')
    assert result.returncode == 17 and b'diagnostic' in result.stderr
    active = subprocess.Popen(['ssh', *connection.args(), 'user@silo', 'sleep 60'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        time.sleep(1)
        assert active.poll() is None
        api(f'desktops/{a}/ssh-key', {'public_key': ''})
        assert active.wait(timeout=10) != 0
        assert connection.run('true').returncode != 0
    finally:
        if active.poll() is None:
            active.terminate()
            active.wait(timeout=10)
    connection.authorize()
    other = SSH(b)
    assert other.host_key != connection.host_key
    return {'binary_bytes': len(payload), 'sftp_sha256_matches': True, 'EOF_preserves_output': True,
            'exit_and_stderr_preserved': True, 'revocation_closes_active_connection': True,
            'separate_host_keys': True}


def pty_test(a):
    from e2b import PtySize
    sbx = Sandbox.connect(record(a)['sandbox_id'])
    pty = sbx.pty.create(PtySize(rows=24, cols=80), envs=DESKTOP_ENV, timeout=30)
    chunks, errors = [], []
    def read():
        try:
            pty.wait(on_pty=chunks.append)
        except Exception as error:
            errors.append(str(error))
    worker = threading.Thread(target=read)
    worker.start()
    sbx.pty.send_stdin(pty.pid, b'stty -echo; stty size; printf "READY\\n"\n')
    wait(lambda: b''.join(chunks), lambda value: b'24 80' in value)
    sbx.pty.resize(pty.pid, PtySize(rows=41, cols=103))
    sbx.pty.send_stdin(pty.pid, 'stty size; printf "日本語\\n"; sleep 30\n'.encode())
    wait(lambda: b''.join(chunks), lambda value: b'41 103' in value and '日本語'.encode() in value)
    sbx.pty.send_stdin(pty.pid, b'\x03')
    sbx.pty.send_stdin(pty.pid, b'printf "INTERRUPTED_OK\\n"; exit 0\n')
    worker.join(10)
    assert not worker.is_alive() and not errors, errors
    assert b'INTERRUPTED_OK' in b''.join(chunks)
    return {'rows_cols_before': [24, 80], 'rows_cols_after': [41, 103],
            'unicode': True, 'control_c_interrupts_child': True, 'clean_exit': True}


def checkpoints(a):
    api(f'desktops/{a}/agent/write', {'path': 'checkpoint.txt', 'content': 'before'})
    server = '''from http.server import BaseHTTPRequestHandler,HTTPServer
import uuid
nonce=str(uuid.uuid4())
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(nonce.encode())
HTTPServer(('127.0.0.1',8788),H).serve_forever()
'''
    api(f'desktops/{a}/agent/write', {'path': 'memory.py', 'content': server})
    shell(a, 'python3 /home/user/memory.py >/tmp/memory.log 2>&1 &')
    nonce = wait(lambda: shell(a, 'curl -fsS http://127.0.0.1:8788'))
    old_key = SSH(a).host_key
    snapshot = api(f'desktops/{a}/checkpoint', {})['id']
    REPORT['checkpoint'] = snapshot
    save()
    api(f'desktops/{a}/agent/write', {'path': 'checkpoint.txt', 'content': 'after'})
    fork = api('desktops', {'name': 'LCU checkpoint fork', 'checkpoint': snapshot,
                            'run_id': REPORT['run_id']})['id']
    REPORT['desktops'].append(fork)
    save()
    assert shell(fork, 'cat /home/user/checkpoint.txt') == 'before'
    assert shell(fork, 'curl -fsS http://127.0.0.1:8788') == nonce
    assert shell(a, 'cat /home/user/checkpoint.txt') == 'after'
    assert SSH(fork).host_key != old_key
    old = record(a)['sandbox_id']
    result = api(f'desktops/{a}/revert', {'checkpoint': snapshot})
    assert result['id'] == a and result['sandbox_id'] != old
    assert shell(a, 'cat /home/user/checkpoint.txt') == 'before'
    assert shell(a, 'curl -fsS http://127.0.0.1:8788') == nonce
    assert SSH(a).host_key not in (old_key, SSH(fork).host_key)
    js(a, 'await cua.getState();')
    assert 'Silo LCU Target' in text(js(a, 'await cua.listWindows();'))
    assert text(js(a, 'nodeRepl.write(typeof lcuMemory);')) == 'undefined'
    shell(fork, 'echo independent > /home/user/checkpoint.txt')
    assert shell(a, 'cat /home/user/checkpoint.txt') == 'before'
    api(f'desktops/{fork}/lifecycle', {'action': 'pause'})
    return {'checkpoint': snapshot, 'fork': fork, 'logical_id_retained': a,
            'old_runtime': old, 'new_runtime': result['sandbox_id'],
            'memory_nonce_retained': True, 'fork_files_independent': True,
            'ssh_identity_replaced': True, 'LCU_reconnected': True}


def main(argv=None):
    global REPORT, EVIDENCE, PATH
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args(argv)
    configure()
    EVIDENCE = run_directory(args.run_id)
    EVIDENCE.mkdir(parents=True, exist_ok=False)
    PATH = EVIDENCE / 'qualification.json'
    REPORT = {'run_id': args.run_id, 'status': 'running', 'checks': [], 'desktops': [],
              'started_unix': time.time(), 'template': 'silo-arm-desktop-lcu',
              'manifest': run_manifest()}
    save()
    stage = 'create first desktop'
    try:
        a = api('desktops', {'name': 'LCU qualification A', 'run_id': args.run_id})['id']
        REPORT['desktops'].append(a)
        save()
        stage = 'create second desktop'
        b = api('desktops', {'name': 'LCU qualification B', 'run_id': args.run_id})['id']
        REPORT['desktops'].append(b)
        save()
        for name, fn in [('Kernel isolation, private egress and per-guest metadata', lambda: isolation_and_network(a, b)),
                         ('LCU desktop, isolation, handoff and reconnect', lambda: lcu_test(a, b)),
                         ('ARM64 Firefox observed through LCU', lambda: browser_test(a)),
                         ('SDK PTY resize, Unicode, signal and exit', lambda: pty_test(a)),
                         ('SSH binary, SFTP, EOF, exit status and revocation', lambda: ssh_test(a, b)),
                         ('Checkpoint fork and revert preserve memory and renew identity', lambda: checkpoints(a))]:
            stage = name
            check(name, fn)
        REPORT['status'] = 'passed'
        if not complete(REPORT, QUALIFICATION_CASES):
            raise RuntimeError('Qualification report is missing a required passing check')
        save()
    except Exception:
        discover_run_desktops()
        REPORT['status'] = 'failed'
        REPORT['failure_stage'] = stage
        save()
        raise


if __name__ == '__main__':
    main()
