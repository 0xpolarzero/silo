"""Loopback-only HTTP regressions for the synthetic credential broker."""
import hashlib
import http.client
import importlib.util
import json
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


class RecordingUpstream(BaseHTTPRequestHandler):
    """Independent fixture receipt sink; retain digests, never raw auth."""
    receipts = []
    receipt_lock = threading.Lock()

    def log_message(self, *_args):
        pass

    def do_GET(self):
        auth = self.headers.get('Authorization', '')
        if auth.startswith('Bearer '):
            received = auth.removeprefix('Bearer ')
        elif auth.startswith('Basic '):
            import base64
            received = base64.b64decode(auth[6:], validate=True).decode().split(':', 1)[1]
        else:
            received = ''
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        receipt = {
            'path': self.path,
            'token_sha256': hashlib.sha256(received.encode()).hexdigest(),
            'body_sha256': hashlib.sha256(body).hexdigest(),
        }
        with self.receipt_lock:
            self.receipts.append(receipt)
        response = json.dumps(receipt).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)


class BrokerBoundaries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which('openssl'):
            raise unittest.SkipTest('openssl is required to create the loopback fixture certificate')
        cls.temp = tempfile.TemporaryDirectory(prefix='silo-credential-boundary-')
        cls.root = Path(cls.temp.name)
        cls.cert = cls.root / 'fixture.pem'
        cls.key = cls.root / 'fixture-key.pem'
        subprocess.run([
            'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-keyout', str(cls.key), '-out', str(cls.cert), '-subj', '/CN=github-fixture.test',
            '-addext', 'subjectAltName=DNS:github-fixture.test,DNS:api.github-fixture.test,IP:127.0.0.1',
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.upstream = ThreadingHTTPServer(('127.0.0.1', 0), RecordingUpstream)
        upstream_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        upstream_tls.load_cert_chain(cls.cert, cls.key)
        cls.upstream.socket = upstream_tls.wrap_socket(cls.upstream.socket, server_side=True)
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
        with RecordingUpstream.receipt_lock:
            RecordingUpstream.receipts.clear()
        self.token_a = 'fixture-a-' + secrets.token_hex(16)
        self.token_b = 'fixture-b-' + secrets.token_hex(16)
        self.grant_a = broker.Grant(self.token_a, {'allowed': 'read'})
        self.grant_b = broker.Grant(self.token_b, {'other': 'read'})
        self.servers = []
        self.threads = []
        self.port_a = self.start_broker(self.grant_a)
        self.port_b = self.start_broker(self.grant_b)

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

    def request(self, port, path, authorization=None, extra_headers=()):
        connection = http.client.HTTPSConnection(
            '127.0.0.1', port, context=self.client_tls, timeout=3)
        connection.set_tunnel('github-fixture.test', 443)
        headers = {
            'Host': 'github-fixture.test',
            'Authorization': authorization or 'Bearer ' + broker.PLACEHOLDER,
            'User-Agent': 'credential-boundary-fixture',
        }
        headers.update(dict(extra_headers))
        try:
            connection.request('GET', path, headers=headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def receipts(self):
        with RecordingUpstream.receipt_lock:
            return list(RecordingUpstream.receipts)

    def test_allowed_placeholder_is_substituted_and_upstream_records_digest(self):
        status, body = self.request(self.port_a, '/repos/fixture/allowed/contents/file')
        self.assertEqual(status, 200)
        response_receipt = json.loads(body)
        receipts = self.receipts()
        self.assertEqual(len(receipts), 1)
        expected = {
            'path': '/repos/fixture/allowed/contents/file',
            'token_sha256': hashlib.sha256(self.token_a.encode()).hexdigest(),
            'body_sha256': hashlib.sha256(b'').hexdigest(),
        }
        self.assertEqual(receipts[0], expected)
        self.assertEqual(response_receipt, expected)
        self.assertNotIn(self.token_a.encode(), body)

    def test_other_workspace_and_ungranted_repository_are_denied_without_receipt(self):
        # Workspace B cannot select workspace A by supplying an identity header,
        # and A cannot use its read grant against a repository outside its map.
        for port, path in (
            (self.port_b, '/repos/fixture/allowed/contents/file'),
            (self.port_a, '/repos/fixture/denied/contents/file'),
        ):
            with self.subTest(port=port, path=path):
                status, _ = self.request(
                    port, path, extra_headers=(('X-Silo-Workspace', 'workspace-a'),))
                self.assertEqual(status, 403)
                self.assertEqual(self.receipts(), [])

    def test_malformed_basic_authorization_is_denied_without_receipt(self):
        status, _ = self.request(
            self.port_a,
            '/repos/fixture/allowed/contents/file',
            authorization='Basic !!!not-base64!!!',
        )
        self.assertEqual(status, 403)
        self.assertEqual(self.receipts(), [])


if __name__ == '__main__':
    unittest.main()
