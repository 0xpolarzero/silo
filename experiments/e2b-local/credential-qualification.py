"""Real guest → per-workspace SSH tunnel → TLS broker → controlled upstream.

Uses synthetic secrets only. Does not access GitHub accounts or repositories.
"""
import argparse
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shlex
import ssl
import subprocess
import threading
import time
from urllib.parse import urlsplit

import qualification as q
from report_contract import QUALIFICATION_CASES, complete, same_candidate

spec = importlib.util.spec_from_file_location('broker', Path(__file__).with_name('credential-broker.py'))
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)
RUN = secrets.token_hex(6)
ROOT = q.HERE / 'state' / 'credential-fixture' / RUN
SEEN = []
LFS = {}


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def handle_request(self):
        auth = self.headers.get('Authorization', '')
        if auth.startswith('Basic '):
            token = base64.b64decode(auth[6:]).decode().split(':', 1)[1]
        else:
            token = auth.removeprefix('Bearer ')
        SEEN.append(hashlib.sha256(token.encode()).hexdigest())
        url = urlsplit(self.path)
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if url.path.endswith('/info/lfs/objects/batch'):
            request = json.loads(body)
            objects = []
            repo = url.path.split('/')[2]
            for item in request['objects']:
                action = request['operation']
                objects.append({**item, 'authenticated': True, 'actions': {action: {
                    'href': f'https://github-fixture.test/fixture/{repo}/lfs/objects/{item["oid"]}'}}})
            content = json.dumps({'transfer': 'basic', 'objects': objects}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/vnd.git-lfs+json')
        elif '/lfs/objects/' in url.path:
            oid = url.path.rsplit('/', 1)[1]
            if self.command == 'PUT':
                assert hashlib.sha256(body).hexdigest() == oid
                LFS[oid] = body
                content = b''
            else:
                content = LFS[oid]
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
        elif url.path.startswith('/fixture/'):
            env = {**os.environ, 'GIT_PROJECT_ROOT': str(ROOT), 'GIT_HTTP_EXPORT_ALL': '1',
                   'PATH_INFO': url.path, 'QUERY_STRING': url.query, 'REQUEST_METHOD': self.command,
                   'CONTENT_TYPE': self.headers.get('Content-Type', ''), 'CONTENT_LENGTH': str(len(body)), 'REMOTE_USER': 'fixture'}
            result = subprocess.run(['git', 'http-backend'], input=body, env=env, capture_output=True, check=True)
            head, content = result.stdout.split(b'\r\n\r\n', 1)
            headers = [line.decode().split(': ', 1) for line in head.split(b'\r\n')]
            code = next((int(v.split()[0]) for k, v in headers if k.lower() == 'status'), 200)
            self.send_response(code)
            for k, v in headers:
                if k.lower() != 'status':
                    self.send_header(k, v)
        else:
            content = (token if url.path.endswith('/reflect') else json.dumps({'auth_sha256': SEEN[-1]})).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    do_GET = do_POST = do_PUT = handle_request


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args(argv)
    q.configure()
    q.EVIDENCE = q.run_directory(args.run_id)
    original = json.loads((q.EVIDENCE / 'qualification.json').read_text())
    current_manifest = q.run_manifest()
    if (original.get('run_id') != args.run_id
            or not complete(original, QUALIFICATION_CASES)
            or not same_candidate(original, {'manifest': current_manifest})):
        raise RuntimeError('Credential test requires a passing qualification report from this run')
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    a, b = original['desktops'][:2]
    q.PATH = q.EVIDENCE / 'credentials.json'
    if q.PATH.exists():
        raise RuntimeError('Credential report already exists for this run')
    q.REPORT = {'run_id': args.run_id, 'status': 'running', 'checks': [], 'desktops': [a, b],
                'started_unix': time.time(), 'fixture': 'synthetic TLS upstream',
                'manifest': current_manifest}
    q.save()
    cert, key = ROOT / 'ca.pem', ROOT / 'ca-key.pem'
    if not cert.exists():
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
            '-keyout', str(key), '-out', str(cert), '-subj', '/CN=Silo disposable credential fixture',
            '-addext', 'subjectAltName=DNS:github-fixture.test,DNS:api.github-fixture.test,IP:127.0.0.1'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        key.chmod(0o600)
    for repo in ('a', 'b', 'c'):
        path = ROOT / 'fixture' / (repo + '.git')
        if not path.exists():
            subprocess.run(['git', 'init', '--bare', str(path)], check=True, capture_output=True)
            subprocess.run(['git', '-C', str(path), 'config', 'http.receivepack', 'true'], check=True)
    upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    upstream.socket = ctx.wrap_socket(upstream.socket, server_side=True)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    token = 'synthetic-' + secrets.token_hex(24)
    grant_a = broker.Grant(token, {'a': 'read', 'b': 'write'})
    grant_b = broker.Grant('synthetic-' + secrets.token_hex(24), {'c': 'read'})
    brokers, tunnels = [], []
    try:
        for sid, grant in ((a, grant_a), (b, grant_b)):
            server = broker.Broker(grant, cert, key, upstream.server_port)
            brokers.append(server)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            connection = q.SSH(sid)
            process = subprocess.Popen(['ssh', *connection.args(), '-o', 'ExitOnForwardFailure=yes',
                '-R', f'127.0.0.1:18080:127.0.0.1:{server.server_port}', '-N', 'user@silo'],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            tunnels.append(process)
            q.api(f'desktops/{sid}/agent/write', {'path': 'broker-ca.pem', 'content': cert.read_text()})
        time.sleep(1)
        assert all(t.poll() is None for t in tunnels)
        def request(sid, path='/repos/fixture/a/check', method='GET', auth=None, origin='api.github-fixture.test', extra=''):
            auth = auth or 'Bearer ' + broker.PLACEHOLDER
            command = 'curl --silent --show-error --max-time 10 --proxy http://127.0.0.1:18080 --cacert /home/user/broker-ca.pem '
            command += '-X ' + shlex.quote(method) + ' -H ' + shlex.quote('Authorization: ' + auth) + ' '
            command += extra + ' -w "\\n%{http_code}" ' + shlex.quote('https://' + origin + path)
            r = q.api(f'desktops/{sid}/agent/shell', {'command': command})
            return r['stdout'].strip(), r['exit_code']

        def substitution():
            response, code = request(a)
            assert code == 0 and response.endswith('200'), (response, code)
            assert json.loads(response.rsplit('\n', 1)[0])['auth_sha256'] == hashlib.sha256(token.encode()).hexdigest()
            basic = 'Basic ' + base64.b64encode(('x-access-token:' + broker.PLACEHOLDER).encode()).decode()
            assert request(a, auth=basic)[0].endswith('200')
            assert request(a, auth='Bearer wrong')[0].endswith('403')
            assert request(a, method='POST')[0].endswith('403')
            assert request(a, '/repos/fixture/b/check', method='POST')[0].endswith('200')
            assert request(a, '/repos/fixture/c/check')[0].endswith('403')
            assert request(a, origin='attacker.test')[1] != 0
            assert request(a, '/graphql', method='POST')[0].endswith('403')
            assert request(b, extra='-H "X-Silo-Workspace: ' + a + '"')[0].endswith('403')
            assert request(a, '/repos/fixture/a/reflect')[0].endswith('502')
            return {'TLS_Bearer_and_Git_Basic_substitution': True, 'read_A_write_B_deny_C': True,
                    'wrong_destination_and_placeholder_denied': True, 'guest_identity_header_ignored': True,
                    'raw_reflection_blocked': True, 'unqualified_GraphQL_denied': True}
        q.check('TLS credential substitution and negative authorization cases', substitution)

        def git_transport():
            basic = base64.b64encode(('x-access-token:' + broker.PLACEHOLDER).encode()).decode()
            git = 'git -c http.proxy=http://127.0.0.1:18080 -c http.sslCAInfo=/home/user/broker-ca.pem -c ' + shlex.quote('http.extraHeader=Authorization: Basic ' + basic)
            directory = '/home/user/credential-runs/' + RUN
            q.shell(a, f'mkdir -p {directory}/repo && cd {directory}/repo && git init -q && '
                'git config user.name Fixture && git config user.email fixture@example.invalid && '
                'echo independent-git-oracle > file.txt && git add file.txt && git commit -qm fixture && ' +
                git + ' push https://github-fixture.test/fixture/b.git HEAD:refs/heads/main')
            committed = subprocess.check_output(['git', '--git-dir', str(ROOT / 'fixture/b.git'), 'show', 'main:file.txt'], text=True).strip()
            assert committed == 'independent-git-oracle'
            q.shell(a, git + f' clone -q --branch main https://github-fixture.test/fixture/b.git {directory}/clone')
            assert q.shell(a, f'cat {directory}/clone/file.txt') == committed
            denied = q.api(f'desktops/{a}/agent/shell', {'command': f'cd {directory}/repo && ' + git + ' push https://github-fixture.test/fixture/a.git HEAD:refs/heads/main'})
            assert denied['exit_code'] != 0
            refs = subprocess.run(['git', '--git-dir', str(ROOT / 'fixture/a.git'), 'show-ref'], capture_output=True)
            assert refs.returncode == 1 and not refs.stdout
            q.shell(a, f'cd {directory}/repo && git lfs install --local && git lfs track "*.bin" && '
                'git config lfs.url https://github-fixture.test/fixture/b.git/info/lfs && '
                'python3 -c ' + shlex.quote('from pathlib import Path; Path("large.bin").write_bytes(bytes(range(256))*256)') + ' && '
                'git add .gitattributes large.bin && git commit -qm lfs && ' +
                git + ' push https://github-fixture.test/fixture/b.git HEAD:refs/heads/main')
            expected = hashlib.sha256(bytes(range(256)) * 256).hexdigest()
            assert hashlib.sha256(LFS[expected]).hexdigest() == expected
            q.shell(a, git + f' clone -q --branch main https://github-fixture.test/fixture/b.git {directory}/lfs-clone')
            assert q.shell(a, f'sha256sum {directory}/lfs-clone/large.bin').split()[0] == expected
            return {'real_git_push_and_clone': True, 'upstream_commit_verified': True,
                    'push_to_read_only_repo_denied': True, 'LFS_upload_download_sha256_matches': True}
        q.check('Git smart HTTP through TLS placeholder broker', git_transport)

        def rotation():
            replacement = 'synthetic-' + secrets.token_hex(24)
            grant_a.rotate(replacement)
            response, code = request(a)
            assert code == 0 and response.endswith('200')
            assert json.loads(response.rsplit('\n', 1)[0])['auth_sha256'] == hashlib.sha256(replacement.encode()).hexdigest()
            # The real value is never transmitted into the guest as search text.
            sbx = q.Sandbox.connect(q.record(a)['sandbox_id'])
            scan = sbx.commands.run('tar -cf - /home/user 2>/dev/null | base64 -w0', timeout=30).stdout
            data = base64.b64decode(scan)
            assert token.encode() not in data and replacement.encode() not in data
            grant_a.revoke()
            assert request(a)[0].endswith('403')
            # Checkpoint contains placeholders and a live SSH reverse forward.
            # Restored guests must not inherit authority from the source tunnel.
            snapshot = q.api(f'desktops/{a}/checkpoint', {})['id']
            q.REPORT['checkpoint'] = snapshot
            q.save()
            old = q.record(a)['sandbox_id']
            q.api(f'desktops/{a}/revert', {'checkpoint': snapshot})
            assert q.record(a)['sandbox_id'] != old
            receipts_before_replay = len(SEEN)
            restored = request(a)
            assert restored[1] != 0 or restored[0].endswith('403'), restored
            assert len(SEEN) == receipts_before_replay, 'Revoked replay reached upstream'

            # Reconnect through the restored runtime's current SSH identity.
            # A denied stale tunnel alone does not prove that the restored
            # workspace can use a newly authorized grant.
            current_token = 'synthetic-' + secrets.token_hex(24)
            current_grant = broker.Grant(current_token, {'a': 'read'})
            current_broker = broker.Broker(current_grant, cert, key, upstream.server_port)
            brokers.append(current_broker)
            threading.Thread(target=current_broker.serve_forever, daemon=True).start()
            current_connection = q.SSH(a)
            current_tunnel = subprocess.Popen(['ssh', *current_connection.args(),
                '-o', 'ExitOnForwardFailure=yes',
                '-R', f'127.0.0.1:18080:127.0.0.1:{current_broker.server_port}',
                '-N', 'user@silo'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            tunnels.append(current_tunnel)
            time.sleep(1)
            assert current_tunnel.poll() is None, 'Current-grant tunnel did not establish'
            q.api(f'desktops/{a}/agent/write', {'path': 'broker-ca.pem', 'content': cert.read_text()})
            response, code = request(a)
            assert code == 0 and response.endswith('200'), (response, code)
            current_digest = hashlib.sha256(current_token.encode()).hexdigest()
            assert json.loads(response.rsplit('\n', 1)[0])['auth_sha256'] == current_digest
            assert SEEN[-1] == current_digest
            receipts_before_denial = len(SEEN)
            assert request(a, '/repos/fixture/b/check', method='POST')[0].endswith('403')
            assert len(SEEN) == receipts_before_denial
            return {'rotation_immediate': True, 'old_grant_revoked': True,
                    'guest_home_scan_no_real_secret': True, 'restoring_checkpoint_does_not_restore_tunnel_authority': True,
                    'restored_runtime_uses_new_current_grant': True,
                    'scan_scope': '/home/user, not all guest RAM'}
        q.check('Rotation, revocation, guest-file scan and checkpoint replay', rotation)
        q.REPORT['status'] = 'passed'
        q.save()
    finally:
        for process in tunnels:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
        for server in brokers:
            server.grant.revoke()
            server.shutdown()
            server.server_close()
        upstream.shutdown()
        upstream.server_close()


if __name__ == '__main__':
    main()
