#!/usr/bin/env python3
"""Isolated browser sign-in for the opt-in native regression; no credential files."""
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.parse

root = Path(__file__).resolve().parents[4]
environment = os.environ.copy()
configuration = root / 'app/SiloUI/github-build.local.json'
if configuration.exists():
    for key, value in json.loads(configuration.read_text()).items():
        environment.setdefault(key, value)
required = ['SILO_GITHUB_CLIENT_ID', 'SILO_GITHUB_CLIENT_SECRET', 'SILO_TEST_MSB',
            'SILO_TEST_LIBKRUNFW', 'SILO_TEST_GIT', 'SILO_TEST_GIT_SUPPORT']
required += [f'SILO_GITHUB_TEST_{role}_{field}' for role in ['READ', 'WRITE', 'DENIED']
             for field in ['REPO', 'REPO_ID']]
if environment.get('SILO_GITHUB_TEST_CONFIRM') != 'private-test-repositories' or any(
        not environment.get(key) for key in required):
    sys.exit('Set the explicitly authorized fixture and runtime variables from README.md.')
state = secrets.token_urlsafe(32)
verifier = secrets.token_urlsafe(48)
code = None

class Callback(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Callback URLs contain an authorization code.

    def do_GET(self):
        global code
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        valid = (url.path == '/github/callback' and query.get('state') == [state]
                 and len(query.get('code', [])) == 1 and query['code'][0]
                 and not query.get('error'))
        if valid:
            code = query['code'][0]
        self.send_response(200 if valid else 400)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()
        self.wfile.write(b'Isolated Silo test authorization received. You can close this tab.'
                         if valid else b'Invalid test callback.')

with http.server.HTTPServer(('127.0.0.1', 0), Callback) as server:
    server.timeout = 1
    redirect = f'http://127.0.0.1:{server.server_port}/github/callback'
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    url = 'https://github.com/login/oauth/authorize?' + urllib.parse.urlencode({
        'client_id': environment['SILO_GITHUB_CLIENT_ID'], 'redirect_uri': redirect,
        'state': state, 'code_challenge': challenge, 'code_challenge_method': 'S256'})
    print('Open this public authorization URL in the signed-in browser:', flush=True)
    print(url, flush=True)
    deadline = time.monotonic() + 300
    while code is None and time.monotonic() < deadline:
        server.handle_request()
if code is None:
    sys.exit('Browser authorization timed out; no test token was created.')
environment.update(SILO_GITHUB_TEST_CODE=code, SILO_GITHUB_TEST_VERIFIER=verifier,
                   SILO_GITHUB_TEST_REDIRECT=redirect)
# Native production Exchange/Refresh/Scope/RevokeToken implementations handle all
# credentials; this launcher never reads Keychain or changes the saved account.
result = subprocess.run(['cargo', 'test', '--manifest-path',
    str(root / 'app/SiloUI/src-tauri/Cargo.toml'), '--offline',
    'github_authenticated_browser_workflow', '--', '--ignored', '--test-threads=1'],
    env=environment)
sys.exit(result.returncode)
