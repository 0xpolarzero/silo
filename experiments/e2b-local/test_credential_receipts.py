"""Independent fsynced upstream receipts for synthetic broker authorization."""
import base64
import hashlib
import http.client
import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import secrets
import shutil
import ssl
import subprocess
import tempfile
import threading
import unittest

SPEC = importlib.util.spec_from_file_location(
    'credential_broker', Path(__file__).with_name('credential-broker.py'))
broker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(broker)


class DurableReceiptUpstream(BaseHTTPRequestHandler):
    receipt_path = None
    receipt_lock = threading.Lock()

    def log_message(self, *_args):
        pass

    def do_GET(self):
        authorization = self.headers.get('Authorization', '')
        if authorization.startswith('Bearer '):
            scheme, token = 'Bearer', authorization[7:]
        elif authorization.startswith('Basic '):
            scheme = 'Basic'
            decoded = base64.b64decode(authorization[6:], validate=True).decode()
            token = decoded.split(':', 1)[1]
        else:
            scheme, token = 'missing', ''
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        receipt = {
            'request_id': self.headers.get('X-Fixture-Request-ID'),
            'host': self.headers.get('Host'),
            'method': self.command,
            'path': self.path,
            'auth_scheme': scheme,
            'token_sha256': hashlib.sha256(token.encode()).hexdigest(),
            'body_sha256': hashlib.sha256(body).hexdigest(),
        }
        encoded = json.dumps(receipt, sort_keys=True).encode() + b'\n'
        with self.receipt_lock:
            fd = os.open(self.receipt_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                os.write(fd, encoded)
                os.fsync(fd)
            finally:
                os.close(fd)
        response = json.dumps({'request_id': receipt['request_id'],
                               'token_sha256': receipt['token_sha256']}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)


class CredentialReceiptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which('openssl'):
            raise unittest.SkipTest('openssl is required for loopback TLS')
        cls.temp = tempfile.TemporaryDirectory(prefix='silo-credential-receipt-')
        cls.root = Path(cls.temp.name)
        cls.cert = cls.root / 'fixture.pem'
        cls.key = cls.root / 'fixture-key.pem'
        cls.receipt_path = cls.root / 'upstream-receipts.jsonl'
        DurableReceiptUpstream.receipt_path = cls.receipt_path
        subprocess.run([
            'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-keyout', str(cls.key), '-out', str(cls.cert), '-subj', '/CN=github-fixture.test',
            '-addext', 'subjectAltName=DNS:github-fixture.test,IP:127.0.0.1',
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.upstream = ThreadingHTTPServer(('127.0.0.1', 0), DurableReceiptUpstream)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.cert, cls.key)
        cls.upstream.socket = context.wrap_socket(cls.upstream.socket, server_side=True)
        cls.upstream_thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.upstream_thread.start()
        cls.client_tls = ssl.create_default_context(cafile=str(cls.cert))

    @classmethod
    def tearDownClass(cls):
        cls.upstream.shutdown()
        cls.upstream.server_close()
        cls.upstream_thread.join(timeout=2)
        cls.temp.cleanup()

    def setUp(self):
        self.receipt_path.unlink(missing_ok=True)
        self.token_a = 'synthetic-a-' + secrets.token_hex(16)
        self.token_b = 'synthetic-b-' + secrets.token_hex(16)
        self.servers = []
        self.threads = []
        self.port_a = self.start_broker(broker.Grant(self.token_a, {'repo-a': 'read'}))
        self.port_b = self.start_broker(broker.Grant(self.token_b, {'repo-b': 'read'}))

    def tearDown(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join(timeout=2)

    def start_broker(self, grant):
        server = broker.Broker(grant, self.cert, self.key, self.upstream.server_port)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.servers.append(server)
        self.threads.append(thread)
        return server.server_port

    def request(self, port, path, request_id, authorization, workspace_id=None):
        connection = http.client.HTTPSConnection(
            '127.0.0.1', port, context=self.client_tls, timeout=3)
        connection.set_tunnel('github-fixture.test', 443)
        headers = {
            'Host': 'github-fixture.test',
            'Authorization': authorization,
            'X-Fixture-Request-ID': request_id,
        }
        if workspace_id is not None:
            headers['X-Silo-Workspace'] = workspace_id
        try:
            connection.request('GET', path, headers=headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def receipts(self):
        if not self.receipt_path.exists():
            return []
        return [json.loads(line) for line in self.receipt_path.read_text().splitlines()]

    def test_allowed_bearer_basic_and_denied_cross_workspace_have_independent_receipts(self):
        bearer_id = 'receipt-bearer-' + secrets.token_hex(8)
        status, _ = self.request(
            self.port_a, '/repos/fixture/repo-a/contents/file', bearer_id,
            'Bearer ' + broker.PLACEHOLDER)
        self.assertEqual(status, 200)

        basic_id = 'receipt-basic-' + secrets.token_hex(8)
        placeholder_basic = base64.b64encode(
            ('x-access-token:' + broker.PLACEHOLDER).encode()).decode()
        status, _ = self.request(
            self.port_a, '/fixture/repo-a.git/info/refs?service=git-upload-pack', basic_id,
            'Basic ' + placeholder_basic)
        self.assertEqual(status, 200)

        denied_id = 'receipt-denied-' + secrets.token_hex(8)
        status, _ = self.request(
            self.port_b, '/repos/fixture/repo-a/contents/file', denied_id,
            'Bearer ' + broker.PLACEHOLDER, workspace_id='workspace-a')
        self.assertEqual(status, 403)

        receipts = self.receipts()
        by_id = {receipt['request_id']: receipt for receipt in receipts}
        self.assertEqual(len(receipts), 2)
        self.assertEqual(set(by_id), {bearer_id, basic_id})
        self.assertNotIn(denied_id, by_id)
        expected = {
            bearer_id: ('Bearer', self.token_a, '/repos/fixture/repo-a/contents/file'),
            basic_id: ('Basic', self.token_a,
                       '/fixture/repo-a.git/info/refs?service=git-upload-pack'),
        }
        for request_id, (scheme, token, path) in expected.items():
            receipt = by_id[request_id]
            self.assertEqual(receipt['host'], 'github-fixture.test')
            self.assertEqual(receipt['method'], 'GET')
            self.assertEqual(receipt['path'], path)
            self.assertEqual(receipt['auth_scheme'], scheme)
            self.assertEqual(receipt['token_sha256'], hashlib.sha256(token.encode()).hexdigest())
            self.assertEqual(receipt['body_sha256'], hashlib.sha256(b'').hexdigest())
        serialized = self.receipt_path.read_bytes()
        self.assertTrue(serialized.endswith(b'\n'))
        self.assertNotIn(self.token_a.encode(), serialized)
        self.assertNotIn(self.token_b.encode(), serialized)

    def test_rebound_broker_uses_current_grant_after_old_grant_revoked(self):
        before_id = 'before-rebind-' + secrets.token_hex(8)
        status, _ = self.request(
            self.port_a, '/repos/fixture/repo-a/contents/file', before_id,
            'Bearer ' + broker.PLACEHOLDER)
        self.assertEqual(status, 200)

        self.servers[0].grant.revoke()
        stale_id = 'stale-rebind-' + secrets.token_hex(8)
        status, _ = self.request(
            self.port_a, '/repos/fixture/repo-a/contents/file', stale_id,
            'Bearer ' + broker.PLACEHOLDER)
        self.assertEqual(status, 403)

        current_token = 'synthetic-current-' + secrets.token_hex(16)
        current_port = self.start_broker(
            broker.Grant(current_token, {'repo-a': 'read'}))
        current_id = 'current-rebind-' + secrets.token_hex(8)
        status, _ = self.request(
            current_port, '/repos/fixture/repo-a/contents/file', current_id,
            'Bearer ' + broker.PLACEHOLDER)
        self.assertEqual(status, 200)
        denied_id = 'current-denied-' + secrets.token_hex(8)
        status, _ = self.request(
            current_port, '/repos/fixture/repo-b/contents/file', denied_id,
            'Bearer ' + broker.PLACEHOLDER)
        self.assertEqual(status, 403)

        receipts = {item['request_id']: item for item in self.receipts()}
        self.assertEqual(set(receipts), {before_id, current_id})
        self.assertEqual(receipts[before_id]['token_sha256'],
                         hashlib.sha256(self.token_a.encode()).hexdigest())
        self.assertEqual(receipts[current_id]['token_sha256'],
                         hashlib.sha256(current_token.encode()).hexdigest())
        self.assertNotEqual(receipts[before_id]['token_sha256'],
                            receipts[current_id]['token_sha256'])


if __name__ == '__main__':
    unittest.main()
