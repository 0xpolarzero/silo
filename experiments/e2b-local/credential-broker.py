"""Disposable-credential tracer, not a production GitHub policy engine.

Each loopback listener belongs to one host-established SSH reverse tunnel. Guest
headers never select the workspace. Only two controlled test origins are allowed.
The CA private key and credentials stay in the outer host. No request logging.
"""
import base64
import http.client
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ssl
import threading
from urllib.parse import parse_qs, unquote, urlsplit

PLACEHOLDER = '$SILO_GITHUB'
ORIGINS = {'github-fixture.test', 'api.github-fixture.test'}


def permission(method, target, body=b''):
    url = urlsplit(target)
    path = unquote(url.path)
    # Do not normalize ambiguous input into an authorized request.
    if '%' in path or '\\' in path or '//' in path or any(p in ('.', '..') for p in path.split('/')):
        return None
    parts = path.strip('/').split('/')
    if len(parts) == 6 and parts[0] == 'fixture' and parts[1].endswith('.git') and parts[2:] == ['info', 'lfs', 'objects', 'batch'] and method == 'POST':
        try:
            operation = json.loads(body)['operation']
        except (ValueError, KeyError, TypeError):
            return None
        if operation in ('download', 'upload'):
            return parts[1][:-4], 'read' if operation == 'download' else 'write'
        return None
    if len(parts) == 5 and parts[0] == 'fixture' and parts[1].endswith('.git') and parts[2:4] == ['lfs', 'objects']:
        if method in ('GET', 'PUT'):
            return parts[1][:-4], 'read' if method == 'GET' else 'write'
        return None
    if len(parts) >= 4 and parts[:2] == ['repos', 'fixture']:
        return parts[2], 'read' if method in ('GET', 'HEAD') else 'write'
    if len(parts) != 3 or parts[0] != 'fixture' or not parts[1].endswith('.git'):
        # info/refs has one additional component.
        if len(parts) == 4 and parts[0] == 'fixture' and parts[1].endswith('.git') and parts[2:] == ['info', 'refs'] and method == 'GET':
            service = parse_qs(url.query).get('service')
            if service == ['git-upload-pack']:
                return parts[1][:-4], 'read'
            if service == ['git-receive-pack']:
                return parts[1][:-4], 'write'
        return None
    if method == 'POST' and parts[2] in ('git-upload-pack', 'git-receive-pack'):
        return parts[1][:-4], 'read' if parts[2] == 'git-upload-pack' else 'write'
    return None


class Grant:
    def __init__(self, credential, repositories):
        self.credential, self.repositories = credential, repositories
        self.enabled = True
        self.lock = threading.Lock()

    def rotate(self, credential):
        with self.lock:
            self.credential = credential

    def revoke(self):
        with self.lock:
            self.enabled = False


class Broker(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, grant, cert, key, upstream_port):
        self.grant, self.upstream_port = grant, upstream_port
        self.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.tls.load_cert_chain(cert, key)
        self.verify = ssl.create_default_context(cafile=cert)
        super().__init__(('127.0.0.1', 0), Handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    origin = None

    def log_message(self, *args):
        pass

    def answer(self, status, body=b'', headers=()):
        self.send_response(status)
        for key, value in headers:
            self.send_header(key, value)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_CONNECT(self):
        if self.path not in {host + ':443' for host in ORIGINS}:
            return self.answer(403)
        self.origin = self.path[:-4]
        self.send_response(200)
        self.end_headers()
        self.wfile.flush()
        self.connection = self.server.tls.wrap_socket(self.connection, server_side=True)
        self.rfile = self.connection.makefile('rb')
        self.wfile = self.connection.makefile('wb')
        self.close_connection = False
        try:
            self.handle_one_request()
        finally:
            self.wfile.flush()
            self.connection.close()

    def forward(self):
        grant = self.server.grant
        length = self.headers.get('Content-Length', '0')
        if not length.isdecimal() or int(length) > 32 * 1024 * 1024 or self.headers.get('Transfer-Encoding'):
            return self.answer(400)
        body = self.rfile.read(int(length))
        if self.origin not in ORIGINS or self.headers.get('Host') not in (self.origin, self.origin + ':443'):
            return self.answer(403)
        if not self.path.startswith('/') or self.path.startswith('//') or len(self.headers.get_all('Authorization', [])) > 1:
            return self.answer(403)
        auth = self.headers.get('Authorization', '')
        if not auth:
            return self.answer(401, headers=[('WWW-Authenticate', 'Basic realm="Silo fixture"')])
        basic = False
        if auth.startswith('Basic '):
            try:
                auth = base64.b64decode(auth[6:], validate=True).decode()
            except (ValueError, UnicodeError):
                return self.answer(403)
            basic = True
        expected = 'x-access-token:' + PLACEHOLDER if basic else 'Bearer ' + PLACEHOLDER
        requested = permission(self.command, self.path, body)
        with grant.lock:
            if not grant.enabled or auth != expected or not requested:
                return self.answer(403)
            repo, access = requested
            allowed = grant.repositories.get(repo)
            if allowed != 'write' and not (allowed == 'read' and access == 'read'):
                return self.answer(403)
            credential = grant.credential
            # Request headers cannot affect identity, routing, TLS or forwarding.
            headers = {k: v for k, v in self.headers.items() if k.lower() in (
                'content-type', 'accept', 'user-agent', 'git-protocol', 'x-fixture-request-id')}
            headers['Host'] = self.origin
            headers['Authorization'] = ('Basic ' + base64.b64encode(('x-access-token:' + credential).encode()).decode()) if basic else 'Bearer ' + credential
            upstream = http.client.HTTPSConnection('127.0.0.1', self.server.upstream_port,
                                                   context=self.server.verify, timeout=15)
            try:
                upstream.request(self.command, self.path, body=body, headers=headers)
                response = upstream.getresponse()
                content = response.read(32 * 1024 * 1024 + 1)
                if len(content) > 32 * 1024 * 1024:
                    return self.answer(502)
                # A controlled upstream deliberately reflects raw secrets in one
                # negative test. This is not a claim to catch arbitrary encodings.
                returned = repr(response.getheaders()).encode() + content
                if credential.encode() in returned or base64.b64encode(credential.encode()) in returned:
                    return self.answer(502)
                safe = [(k, v) for k, v in response.getheaders() if k.lower() in ('content-type', 'location')]
                return self.answer(response.status, content, safe)
            finally:
                upstream.close()

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = forward
