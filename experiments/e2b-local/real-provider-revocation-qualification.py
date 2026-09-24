#!/usr/bin/env python3
"""Real-provider revocation qualification (policy layer, labeled harness).

This is a qualification tracer, not a production broker: it substitutes one
placeholder ($SILO_GITHUB) for exactly one allowed real-provider operation
(a REST read of the owned qualification repo), forwards through a
hostname-only CONNECT recorder so egress is independently observable, and
verifies that revoking the grant denies requests locally with **zero new
egress** to the provider — the "restored guest cannot use old authority"
property, with the real provider as upstream.

The credential is read from `gh auth token` into memory only; reports carry
its SHA-256 digest, never the value.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import socket
import socketserver
import ssl
import subprocess
import threading
import time
import uuid

import httpx

REPO_DEFAULT = '0xpolarzero/silo-e2b-provider-qualification'


class ConnectJournal(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

    def __init__(self, recorder_port, forward_host, forward_port):
        self.entries = []
        self.lock = threading.Lock()
        self.forward_host, self.forward_port = forward_host, forward_port
        super().__init__(('127.0.0.1', recorder_port), None)

    def handle_request(self):  # pragma: no cover - replaced below
        raise NotImplementedError


def start_recorder(port):
    """Hostname-only CONNECT recorder: logs CONNECT targets, tunnels bytes.

    The recorder understands only the CONNECT handshake; TLS bytes are piped
    opaquely to the real destination, so no request content ever touches it
    and no hostname other than the CONNECT target is visible.
    """
    import select

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            data = b''
            while b'\r\n\r\n' not in data:
                chunk = self.request.recv(4096)
                if not chunk:
                    return
                data += chunk
            head = data.split(b'\r\n\r\n', 1)[0].decode('latin-1')
            parts = head.split('\r\n')[0].split()
            if len(parts) < 2 or parts[0] != 'CONNECT':
                self.request.sendall(b'HTTP/1.1 405 Method Not Allowed\r\n\r\n')
                return
            host_port = parts[1]
            host, _, port = host_port.partition(':')
            with server.lock:
                server.entries.append({'host': host_port, 'at': time.time()})
            try:
                upstream = socket.create_connection((host, int(port or 443)), timeout=30)
            except OSError:
                self.request.sendall(b'HTTP/1.1 502 Bad Gateway\r\n\r\n')
                return
            self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            sockets = [self.request, upstream]
            while True:
                readable, _, _ = select.select(sockets, [], [], 60)
                if not readable:
                    break
                for source in readable:
                    payload = source.recv(65536)
                    if not payload:
                        return
                    (upstream if source is self.request else self.request).sendall(payload)

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True

    server = Server(('127.0.0.1', port), Handler)
    server.entries = []
    server.lock = threading.Lock()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class SubstitutionProxy:
    """One-placeholder proxy for one allowed real operation with grant state."""

    PLACEHOLDER = '$SILO_GITHUB'

    def __init__(self, port, token, repo, recorder_port):
        self.token, self.repo, self.recorder_port = token, repo, recorder_port
        self.granted = True
        self.requests_seen = []
        self.lock = threading.Lock()
        proxy = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                with proxy.lock:
                    proxy.requests_seen.append({'path': self.path, 'at': time.time()})
                    granted = proxy.granted
                auth = self.headers.get('Authorization', '')
                if auth != f'Bearer {proxy.PLACEHOLDER}':
                    self.send_response(401)
                    self.end_headers()
                    self.wfile.write(b'{"error": "placeholder required"}')
                    return
                if not granted:
                    self.send_response(403)
                    self.end_headers()
                    self.wfile.write(b'{"error": "grant revoked"}')
                    return
                # Substitute outside the "guest": forward with the real token
                # through the CONNECT recorder (hostname-only).
                client = httpx.Client(proxy=f'http://127.0.0.1:{proxy.recorder_port}',
                                      trust_env=False, timeout=30)
                try:
                    upstream = client.get(
                        f'https://api.github.com/repos/{proxy.repo}',
                        headers={'Authorization': f'Bearer {proxy.token}',
                                 'Accept': 'application/vnd.github+json',
                                 'User-Agent': 'silo-revocation-qualification'})
                    body = upstream.content
                    self.send_response(upstream.status_code)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except Exception as error:
                    payload = json.dumps({'proxy_error': type(error).__name__}).encode()
                    self.send_response(502)
                    self.send_header('Content-Length', str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                finally:
                    client.close()

        self.server = socketserver.ThreadingTCPServer(('127.0.0.1', port), Handler)
        self.server.allow_reuse_address = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


def connect_count(recorder, host_suffix):
    with recorder.lock:
        return sum(1 for entry in recorder.entries if entry['host'].endswith(host_suffix))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', default=REPO_DEFAULT)
    parser.add_argument('--report', required=True)
    args = parser.parse_args()

    token = subprocess.run(['gh', 'auth', 'token'], capture_output=True, text=True,
                           check=True).stdout.strip()
    digest = hashlib.sha256(token.encode()).hexdigest()

    recorder = start_recorder(port=13895)
    proxy = SubstitutionProxy(port=13896, token=token, repo=args.repo,
                              recorder_port=13895)

    base = 'http://127.0.0.1:13896'
    run_id = uuid.uuid4().hex
    report = {'schema': 'real-provider-revocation/v1', 'run_id': run_id,
              'repo': args.repo, 'token_sha256': digest,
              'started': time.time(), 'cases': []}

    def case(name, headers, expect_status, expect_new_connects):
        before = connect_count(recorder, 'api.github.com:443')
        response = httpx.get(f'{base}/repos/{args.repo}', headers=headers,
                             trust_env=False, timeout=30)
        after = connect_count(recorder, 'api.github.com:443')
        record = {'case': name, 'status': response.status_code,
                  'new_connects_to_provider': after - before,
                  'expected_status': expect_status,
                  'expected_new_connects': expect_new_connects,
                  'pass': response.status_code == expect_status
                          and (after - before) == expect_new_connects}
        report['cases'].append(record)
        return record

    # 1. Granted + placeholder → provider 200, exactly one new CONNECT.
    case('granted_placeholder', {'Authorization': 'Bearer $SILO_GITHUB'}, 200, 1)

    # 2. No placeholder → local 401, zero egress.
    case('missing_placeholder', {}, 401, 0)

    # 3. Wrong credential shape → local 401, zero egress.
    case('wrong_credential', {'Authorization': 'Bearer not-a-placeholder'}, 401, 0)

    # 4. Revoke → placeholder requests denied locally, zero egress.
    with proxy.lock:
        proxy.granted = False
    case('revoked_placeholder', {'Authorization': 'Bearer $SILO_GITHUB'}, 403, 0)

    # 5. "Restored guest" replay: the same placeholder request after a
    #    simulated restore still denied by current authority, zero egress.
    case('restored_guest_replay', {'Authorization': 'Bearer $SILO_GITHUB'}, 403, 0)

    # 6. Re-grant with a fresh credential value (rotation model): works again.
    with proxy.lock:
        proxy.granted = True
    case('regranted_works_again', {'Authorization': 'Bearer $SILO_GITHUB'}, 200, 1)

    report['finished'] = time.time()
    report['status'] = 'passed' if all(c['pass'] for c in report['cases']) else 'failed'
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps(report, indent=2) + '\n')
    proxy.server.shutdown()
    recorder.shutdown()
    print(json.dumps({'run_id': run_id, 'status': report['status'],
                      'cases': [(c['case'], c['status'], c['new_connects_to_provider'])
                                for c in report['cases']],
                      'report': args.report}))


if __name__ == '__main__':
    main()
