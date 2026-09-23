"""Loopback-only desktop gateway. E2B credentials never reach the browser."""
import asyncio
import base64
import contextlib
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import time
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.websockets import WebSocketDisconnect
from websockets.asyncio.client import connect
from e2b.exceptions import SandboxException

from runtime import Conflict, Desktops
from report_contract import QUALIFICATION_CASES, CREDENTIAL_CASES, complete, same_candidate

HERE = Path(__file__).resolve().parent
app = FastAPI(title='Silo desktop experiment', docs_url=None, redoc_url=None)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', 'testserver'])
viewer_app = FastAPI(title='Silo desktop viewer', docs_url=None, redoc_url=None)
viewer_app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', 'testserver'])
desktops = None
VIEWER_SESSION_TTL_SECONDS = 600


def manager():
    global desktops
    if desktops is None:
        desktops = Desktops()
    return desktops


def same_origin(origin, host):
    parsed = urlsplit(origin)
    return parsed.scheme in ('http', 'https') and parsed.netloc == host


def viewer_signing_key(m=None):
    """Load or atomically create the host-only key shared by both services."""
    m = m or manager()
    path = m.state / 'viewer-session.key'
    if not path.exists():
        temporary = m.state / f'.viewer-session.{os.getpid()}.{secrets.token_hex(8)}.tmp'
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(secrets.token_bytes(32))
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass
        finally:
            temporary.unlink(missing_ok=True)
    info = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError('Viewer signing key must be a private regular file')
    key = path.read_bytes()
    if len(key) != 32:
        raise RuntimeError('Viewer signing key has an invalid length')
    return key


def issue_viewer_ticket(sid, epoch, m=None, now=None, role='observer', owner=None):
    if role not in ('observer', 'control') or (role == 'control' and not owner):
        raise ValueError('Invalid viewer role')
    claims = {'sid': sid, 'epoch': epoch,
              'exp': int(time.time() if now is None else now) + VIEWER_SESSION_TTL_SECONDS,
              'role': role, 'nonce': secrets.token_hex(16)}
    if role == 'control':
        claims['owner'] = owner
    payload = base64.urlsafe_b64encode(
        json.dumps(claims, sort_keys=True, separators=(',', ':')).encode()).rstrip(b'=')
    signature = hmac.digest(viewer_signing_key(m), payload, 'sha256')
    return payload.decode() + '.' + base64.urlsafe_b64encode(signature).rstrip(b'=').decode()


def verify_viewer_ticket(ticket, sid, m=None, now=None):
    m = m or manager()
    if not isinstance(ticket, str) or len(ticket) > 512:
        raise HTTPException(status_code=403, detail='Invalid or expired viewer session')
    try:
        encoded_payload, encoded_signature = ticket.split('.', 1)
        payload = encoded_payload.encode()
        signature = base64.b64decode(encoded_signature + '=' * (-len(encoded_signature) % 4),
                                     altchars=b'-_', validate=True)
        expected = hmac.digest(viewer_signing_key(m), payload, 'sha256')
        claims = json.loads(base64.b64decode(payload + b'=' * (-len(payload) % 4),
                                             altchars=b'-_', validate=True))
        record = m.record(sid)
        current_time = int(time.time() if now is None else now)
        if (not hmac.compare_digest(signature, expected) or claims.get('sid') != sid
                or type(claims.get('epoch')) is not int or claims.get('epoch') != record.get('epoch')
                or type(claims.get('exp')) is not int or claims.get('exp') <= current_time
                or claims.get('role') not in ('observer', 'control')
                or (claims['role'] == 'control' and (
                    record.get('mode') != 'human' or claims.get('owner') != record.get('control_owner')))
                or record.get('status') != 'running'):
            raise ValueError('Viewer session does not match current workspace authority')
        return claims
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=403, detail='Invalid or expired viewer session') from error


@app.middleware('http')
async def local_requests(request: Request, call_next):
    origin = request.headers.get('origin')
    if origin and not same_origin(origin, request.headers.get('host')):
        return JSONResponse({'detail': 'Cross-origin access is disabled'}, status_code=403)
    if request.method not in ('GET', 'HEAD') and request.headers.get('x-poc-request') != '1':
        return JSONResponse({'detail': 'Expected X-Poc-Request: 1'}, status_code=403)
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    return response


@viewer_app.middleware('http')
async def viewer_response_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    return response


@app.exception_handler(Conflict)
async def conflict_handler(request, error):
    return JSONResponse({'detail': str(error)}, status_code=409)


@app.exception_handler(KeyError)
async def missing_handler(request, error):
    return JSONResponse({'detail': str(error)}, status_code=404)


@app.exception_handler(ValueError)
async def invalid_handler(request, error):
    return JSONResponse({'detail': str(error)}, status_code=400)


@app.exception_handler(SandboxException)
async def sandbox_error(request, error):
    return JSONResponse({'detail': str(error)}, status_code=502)


@app.get('/')
def index(request: Request):
    # Lima forwards the control port and the next port as distinct loopback
    # origins. Derive the viewer port from the forwarded control Host header.
    control_port = request.url.port or 3800
    viewer_origin = f'{request.url.scheme}://{request.url.hostname}:{control_port + 1}'
    page = (HERE / 'index.html').read_text().replace('__SILO_VIEWER_ORIGIN__', viewer_origin)
    return HTMLResponse(page)


@app.get('/api/state')
def state():
    m = manager()
    m.refresh()
    with m.lock:
        return {'desktops': list(m.data['desktops'].values()),
                'checkpoints': list(m.data['checkpoints'].values())}


@app.post('/api/desktops')
def create(data: dict):
    return manager().create(str(data.get('name', 'Desktop')), data.get('checkpoint'), data.get('run_id'))


@app.post('/api/pause-all')
def pause_all():
    m = manager()
    m.refresh()
    with m.lock:
        paused = []
        for sid, record in m.data['desktops'].items():
            if record['status'] == 'running':
                m.lifecycle(sid, 'pause')
                paused.append(sid)
        return {'paused': paused}


@app.post('/api/desktops/{sid}/mode')
def mode(sid: str, data: dict):
    return manager().mode(sid, data['mode'], data.get('viewer_instance'))


@app.post('/api/desktops/{sid}/lifecycle')
def lifecycle(sid: str, data: dict):
    return manager().lifecycle(sid, data['action'])


@app.post('/api/desktops/{sid}/checkpoint')
def checkpoint(sid: str):
    return manager().checkpoint(sid)


@app.post('/api/desktops/{sid}/revert')
def revert(sid: str, data: dict):
    return manager().revert(sid, data['checkpoint'])


@app.post('/api/desktops/{sid}/recover-revert')
def recover_revert(sid: str):
    return manager().recover_revert(sid)


@app.post('/api/desktops/{sid}/recover-create')
def recover_create(sid: str):
    return manager().recover_create(sid)


@app.post('/api/desktops/{sid}/agent/{action}')
def agent(sid: str, action: str, data: dict):
    return manager().agent(sid, action, data)


@app.get('/api/desktops/{sid}/screenshot')
def screenshot(sid: str):
    return Response(manager().screenshot(sid), media_type='image/jpeg')


@app.get('/api/evidence')
def evidence(run_id: str | None = None):
    if run_id is None:
        return {'status': 'incomplete', 'checks': [], 'run_id': None,
                'detail': 'Select one fresh qualification run ID',
                'cutover': 'blocked: checkpoint failure safety and remaining adoption gates'}
    if not re.fullmatch(r'[0-9a-f]{32}', run_id):
        raise HTTPException(status_code=400, detail='Invalid qualification run ID')
    reports = []
    for name in ('qualification', 'credentials'):
        path = HERE / 'evidence' / 'runs' / run_id / (name + '.json')
        if path.exists():
            report = json.loads(path.read_text())
            if report.get('run_id') != run_id:
                raise HTTPException(status_code=409, detail='Evidence run ID mismatch')
            reports.append(report)
    verified = (len(reports) == 2 and complete(reports[0], QUALIFICATION_CASES)
                and complete(reports[1], CREDENTIAL_CASES)
                and same_candidate(reports[0], reports[1]))
    local_status = ('failed' if any(r.get('status') == 'failed' for r in reports)
                    else 'passed' if verified else 'incomplete')
    return {'run_id': run_id,
            'status': 'blocked' if verified else local_status,
            'local_case_status': local_status,
            'detail': ('Local case reports passed; deployed runtime identity and '
                       'remaining qualification gates are unverified') if verified else None,
            'checks': [c for r in reports for c in r['checks']],
            'cutover': 'blocked: checkpoint failure safety and remaining adoption gates'}


@app.get('/api/resources')
def resources():
    # Fixed commands only, never shell interpolation from the browser.
    return {'host': subprocess.check_output(['uname', '-sm'], text=True).strip(),
            'memory': subprocess.check_output(['free', '-m'], text=True),
            'disk': subprocess.check_output(['df', '-h', '/'], text=True),
            'e2b_allocated': subprocess.check_output(['du', '-sh', '/var/lib/e2b'], text=True).strip()}


def route(sid, viewer_role=None):
    m = manager()
    with m.lock:
        record = m.record(sid)
        sbx = m.handle(sid)
        if viewer_role not in (None, 'observer', 'control'):
            raise ValueError('Invalid viewer role')
        interactive = (record['mode'] == 'human' if viewer_role is None
                       else viewer_role == 'control')
        headers = {'E2b-Sandbox-Id': sbx.sandbox_id,
                   'E2b-Sandbox-Port': '6080' if interactive else '6081'}
        if sbx.traffic_access_token:
            headers['e2b-traffic-access-token'] = sbx.traffic_access_token
        return headers, record['epoch']


@app.post('/api/desktops/{sid}/ssh-key')
def ssh_key(sid: str, data: dict):
    m = manager()
    with m.lock:
        sbx = m.handle(sid)
        key = data['public_key'].strip()
        if '\n' in key or (key and not key.startswith('ssh-ed25519 ')):
            raise ValueError('Expected one Ed25519 public key, or empty to revoke')
        sbx.files.write('/home/user/.ssh/authorized_keys', key + '\n')
        sbx.commands.run('chmod 600 /home/user/.ssh/authorized_keys')
        m.record(sid)['epoch'] += 1
        m.save()
        return {'host_key': sbx.commands.run('cat /etc/ssh/ssh_host_ed25519_key.pub').stdout.strip()}


@app.post('/api/desktops/{sid}/viewer-session')
def viewer_session(sid: str, data: dict):
    m = manager()
    with m.lock:
        record = m.record(sid)
        if record['status'] != 'running':
            raise Conflict('Resume this desktop first')
        viewer_instance = data.get('viewer_instance')
        owner = (hashlib.sha256(viewer_instance.encode()).hexdigest()
                 if isinstance(viewer_instance, str) and len(viewer_instance) == 36 else None)
        role = ('control' if record['mode'] == 'human' and owner is not None
                and owner == record.get('control_owner')
                else 'observer')
        return {'ticket': issue_viewer_ticket(sid, record['epoch'], m, role=role,
                                              owner=owner if role == 'control' else None),
                'role': role, 'expires_in': VIEWER_SESSION_TTL_SECONDS}


@app.websocket('/ssh/{sid}')
async def ssh_socket(ws: WebSocket, sid: str):
    await socket(ws, sid, port='6091', path='/')


def reload_registry(m):
    """Refresh a viewer process's read-only copy of control-owned state."""
    latest = json.loads(m.registry.read_text())
    with m.lock:
        for sid, old in m.data['desktops'].items():
            current = latest['desktops'].get(sid)
            if (current is None or current.get('sandbox_id') != old.get('sandbox_id')
                    or current.get('epoch') != old.get('epoch')):
                m.handles.pop(sid, None)
        m.data = latest


@viewer_app.get('/healthz')
def viewer_health():
    return PlainTextResponse('ok')


@viewer_app.get('/session/{ticket}/viewer/{sid}/{path:path}')
async def viewer(ticket: str, sid: str, path: str, request: Request):
    if request.method not in ('GET', 'HEAD'):
        raise HTTPException(status_code=405, detail='Viewer assets are read-only')
    m = manager()
    await run_in_threadpool(reload_registry, m)
    claims = verify_viewer_ticket(ticket, sid, m)
    headers, _ = await run_in_threadpool(route, sid, claims['role'])
    # httpx normalizes the path; the destination host/port remain fixed.
    async with httpx.AsyncClient(timeout=20, trust_env=False) as client:
        result = await client.get('http://127.0.0.1:3002/' + path,
                                  params=request.query_params, headers=headers)
    return Response(result.content, status_code=result.status_code,
                    media_type=result.headers.get('content-type'))


@viewer_app.websocket('/session/{ticket}/viewer/{sid}/websockify')
async def viewer_socket(ws: WebSocket, ticket: str, sid: str):
    await socket(ws, sid, viewer_surface=True, ticket=ticket)


async def socket(ws: WebSocket, sid: str, port=None, path='/websockify',
                 viewer_surface=False, ticket=None):
    origin = ws.headers.get('origin')
    if not origin or not same_origin(origin, ws.headers.get('host')):
        await ws.close(code=1008)
        return
    try:
        m = manager()
        if viewer_surface:
            await run_in_threadpool(reload_registry, m)
            claims = verify_viewer_ticket(ticket, sid, m)
        headers, epoch = await run_in_threadpool(route, sid, claims['role'] if viewer_surface else None)
        if port:
            headers['E2b-Sandbox-Port'] = port
    except (KeyError, Conflict, HTTPException):
        await ws.close(code=1008)
        return
    await ws.accept(subprotocol='binary' if 'binary' in ws.headers.get('sec-websocket-protocol', '') else None)
    try:
        async with connect('ws://127.0.0.1:3002' + path, additional_headers=headers,
                           subprotocols=None if port else ['binary'], max_size=None, proxy=None) as upstream:
            async def browser_to_guest():
                while True:
                    event = await ws.receive()
                    if event['type'] == 'websocket.disconnect':
                        return
                    # Mode transitions invalidate both observer and interactive streams.
                    if viewer_surface:
                        await run_in_threadpool(reload_registry, m)
                        verify_viewer_ticket(ticket, sid, m)
                    if m.record(sid)['epoch'] != epoch:
                        return
                    await upstream.send(event.get('bytes') if event.get('bytes') is not None else event['text'])

            async def guest_to_browser():
                async for message in upstream:
                    if isinstance(message, bytes):
                        await ws.send_bytes(message)
                    else:
                        await ws.send_text(message)

            async def invalidate():
                while True:
                    if viewer_surface:
                        await run_in_threadpool(reload_registry, m)
                        verify_viewer_ticket(ticket, sid, m)
                    if m.record(sid)['epoch'] != epoch:
                        return
                    await asyncio.sleep(0.1)

            tasks = [asyncio.create_task(fn()) for fn in (browser_to_guest, guest_to_browser, invalidate)]
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        with contextlib.suppress(RuntimeError, WebSocketDisconnect):
            await ws.close(code=1000)
