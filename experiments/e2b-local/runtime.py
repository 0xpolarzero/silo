"""The experiment's E2B boundary. All resource IDs are recorded before use."""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import threading
import time
import uuid
import httpx

from e2b import Sandbox, SandboxQuery, CommandExitException
from e2b.exceptions import SandboxNotFoundException, SandboxException

HERE = Path(__file__).resolve().parent
STATE = HERE / 'state'
TEMPLATE = 'silo-arm-desktop-lcu'
DESKTOP_ENV = {'DISPLAY': ':0', 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/tmp/silo-desktop-bus'}
PRIVATE_NETWORKS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
                    '169.254.0.0/16', '100.64.0.0/10']


def configure():
    # Parse data, never eval the shell file containing the API credential.
    for line in (STATE / 'sdk.env').read_text().splitlines():
        parts = shlex.split(line)
        if len(parts) == 2 and parts[0] == 'export':
            key, value = parts[1].split('=', 1)
            if key in {'E2B_API_KEY', 'E2B_API_URL', 'E2B_SANDBOX_URL'}:
                os.environ[key] = value


class Conflict(Exception):
    pass


def workspace_path(value):
    path = PurePosixPath(value)
    if not path.is_absolute():
        path = PurePosixPath('/home/user') / path
    if '..' in path.parts or not path.is_relative_to('/home/user'):
        raise ValueError('Use a file under /home/user')
    return str(path)


class Desktops:
    def __init__(self, state=STATE, configure_sdk=True):
        self.state = Path(state)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.registry = self.state / 'desktops.json'
        self.lock = threading.RLock()
        self.handles = {}
        self.last_refresh = 0.0
        if configure_sdk:
            configure()
        self.data = json.loads(self.registry.read_text()) if self.registry.exists() else {
            'owner': str(uuid.uuid4()), 'desktops': {}, 'checkpoints': {}}
        # Existing experiment IDs remain valid logical IDs while their runtime
        # bindings can change. This is PoC state, not a shipped migration format.
        for record in self.data['desktops'].values():
            record.setdefault('sandbox_id', record['id'])
        self.save()

    def save(self):
        temporary = self.registry.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.data, indent=2))
        temporary.chmod(0o600)
        with temporary.open('rb') as stream:
            os.fsync(stream.fileno())
        temporary.replace(self.registry)
        directory = os.open(self.state, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def record(self, sid):
        if sid not in self.data['desktops']:
            raise KeyError('Desktop is not owned by this experiment')
        return self.data['desktops'][sid]

    def _create_metadata(self, sid, record):
        operation = record['operation']
        metadata = {
            'silo-poc-owner': self.data['owner'],
            'silo-workspace-id': sid,
            'silo-operation': operation['id'],
            'silo-operation-kind': 'create',
            'name': record['name'],
        }
        if record.get('run_id') is not None:
            metadata['silo-run-id'] = record['run_id']
        return metadata

    def _find_create_candidates(self, metadata):
        pages = Sandbox.list(query=SandboxQuery(metadata=metadata))
        matches = []
        while pages.has_next:
            for candidate in pages.next_items():
                candidate_metadata = getattr(candidate, 'metadata', {}) or {}
                if all(candidate_metadata.get(key) == value for key, value in metadata.items()):
                    matches.append(candidate)
        return matches

    def _attach_create_candidate(self, sid, candidate, connect=False):
        # Sandbox.create returns a live handle; metadata reconciliation returns
        # only a SandboxInfo and must connect before preparation.
        sbx = Sandbox.connect(candidate.sandbox_id, timeout=3600) if connect else candidate
        record = self.record(sid)
        record['sandbox_id'] = sbx.sandbox_id
        record['status'] = 'preparing'
        record['operation']['phase'] = 'accepted'
        record.pop('last_create_error', None)
        self.handles[sid] = sbx
        self.save()
        return self._finish_create(sid, sbx)

    def _finish_create(self, sid, sbx):
        record = self.record(sid)
        record['status'] = 'preparing'
        if record.get('operation'):
            record['operation']['phase'] = 'preparing'
        self.save()
        try:
            self.prepare_guest(sbx)
        except Exception as preparation_error:
            record['status'] = 'failed'
            record['preparation_error'] = str(preparation_error)
            record.pop('cleanup_error', None)
            try:
                sbx.pause(keep_memory=True)
            except Exception as cleanup_error:
                record['cleanup_error'] = str(cleanup_error)
                record.pop('operation', None)
                self.save()
                raise RuntimeError(
                    f"Workspace {sid} runtime {sbx.sandbox_id} preparation failed: "
                    f"{preparation_error}; pause cleanup failed: {cleanup_error}"
                ) from preparation_error
            record.pop('operation', None)
            self.save()
            raise
        record['status'] = 'running'
        record.pop('operation', None)
        record.pop('preparation_error', None)
        record.pop('cleanup_error', None)
        record.pop('last_create_error', None)
        self.save()
        return dict(record)

    def _reconcile_create(self, sid, raise_if_unresolved):
        record = self.record(sid)
        operation = record.get('operation')
        if not operation or operation.get('kind') != 'create' or record.get('sandbox_id'):
            return None
        metadata = self._create_metadata(sid, record)
        try:
            candidates = self._find_create_candidates(metadata)
        except Exception as error:
            record['last_create_error'] = f"Create outcome is unresolved; lookup failed: {error}"
            operation['phase'] = 'uncertain'
            self.save()
            if raise_if_unresolved:
                raise RuntimeError(
                    f"Create outcome is unresolved for workspace {sid}, operation {operation['id']}: {error}"
                ) from error
            return None
        if not candidates:
            operation['phase'] = 'uncertain'
            self.save()
            if raise_if_unresolved:
                raise RuntimeError(
                    f"Create outcome is unresolved for workspace {sid}, operation {operation['id']}; "
                    "no matching runtime is visible yet"
                )
            return None
        if len(candidates) != 1:
            record['status'] = 'create_conflict'
            record['candidate_sandbox_ids'] = [candidate.sandbox_id for candidate in candidates]
            record['last_create_error'] = 'Multiple runtimes match one create operation; refusing to choose or delete.'
            operation['phase'] = 'conflict'
            self.save()
            if raise_if_unresolved:
                raise RuntimeError(
                    f"Multiple runtimes match create operation {operation['id']} for workspace {sid}"
                )
            return None
        return self._attach_create_candidate(sid, candidates[0], connect=True)

    def recover_create(self, sid):
        """Explicitly reconcile and prepare a create left pending after restart."""
        with self.lock:
            record = self.record(sid)
            operation = record.get('operation')
            if (record.get('status') != 'creating' or not operation
                    or operation.get('kind') != 'create' or record.get('sandbox_id')):
                raise Conflict('Workspace has no pending create to recover')
            return self._reconcile_create(sid, raise_if_unresolved=True)

    def refresh(self):
        with self.lock:
            if time.monotonic() - self.last_refresh < 3:
                return
            for sid, record in self.data['desktops'].items():
                if record['status'] in ('deleted', 'preparing', 'failed') or record.get('operation'):
                    continue
                try:
                    info = Sandbox.get_info(record['sandbox_id'])
                    status = getattr(info.state, 'value', info.state)
                except SandboxNotFoundException:
                    status = 'missing'
                if status != record['status']:
                    record['status'] = status
                    record['epoch'] += 1
                    self.handles.pop(sid, None)
                    self.save()
            self.last_refresh = time.monotonic()

    def handle(self, sid):
        record = self.record(sid)
        if record.get('operation'):
            raise Conflict('Recover the incomplete revert before using this workspace')
        if record['status'] != 'running':
            raise Conflict('Resume this desktop first')
        if sid not in self.handles:
            self.handles[sid] = Sandbox.connect(record['sandbox_id'], timeout=3600)
        return self.handles[sid]

    def create(self, name, checkpoint=None, run_id=None):
        with self.lock:
            if checkpoint and checkpoint not in self.data['checkpoints']:
                raise KeyError('Unknown checkpoint')
            if run_id is not None and not re.fullmatch(r'[0-9a-f]{32}', run_id):
                raise ValueError('Invalid qualification run ID')
            sid = str(uuid.uuid4())
            self.data['desktops'][sid] = {
                'id': sid, 'sandbox_id': None, 'name': name[:80], 'status': 'creating', 'mode': 'agent',
                'epoch': 0, 'created': time.time(), 'checkpoint': checkpoint, 'run_id': run_id,
                'operation': {'kind': 'create', 'id': str(uuid.uuid4()), 'phase': 'requesting'}}
            self.save()
            try:
                metadata = self._create_metadata(sid, self.record(sid))
                sbx = Sandbox.create(checkpoint or TEMPLATE, timeout=3600,
                    envs=DESKTOP_ENV,
                    metadata=metadata,
                    lifecycle={'on_timeout': 'pause', 'auto_resume': False},
                    network={'deny_out': PRIVATE_NETWORKS, 'allow_public_traffic': False})
            except Exception as error:
                self.record(sid)['last_create_error'] = str(error)
                self.save()
                return self._reconcile_create(sid, raise_if_unresolved=True)
            return self._attach_create_candidate(sid, sbx)

    def restore_candidate(self, checkpoint, name, operation, run_id=None, workspace_id=None):
        for attempt in range(5):
            try:
                metadata = {'silo-poc-owner': self.data['owner'], 'name': name,
                            'silo-operation': operation, 'silo-operation-kind': 'revert'}
                if workspace_id is not None:
                    metadata['silo-workspace-id'] = workspace_id
                if run_id is not None:
                    metadata['silo-run-id'] = run_id
                return Sandbox.create(checkpoint, timeout=3600, envs=DESKTOP_ENV,
                    metadata=metadata,
                    lifecycle={'on_timeout': 'pause', 'auto_resume': False},
                    network={'deny_out': PRIVATE_NETWORKS, 'allow_public_traffic': False})
            except SandboxException as error:
                # Embed reports pause before releasing all hugepage reservations.
                # Retry only its explicit failed-placement response, never an
                # ambiguous timeout or an unknown API failure.
                if 'Failed to place sandbox: sandbox creation failed' not in str(error) or attempt == 4:
                    raise
                time.sleep(2 ** attempt)

    def prepare_guest(self, sbx):
        # Keys and editor authorization belong to this incarnation, never to the
        # shared template or a restored checkpoint. Stop cloned SSH sessions too.
        sbx.commands.run('set -e; mkdir -p /etc/systemd/system/ssh.service.d; '
            'printf "[Service]\\nKillMode=control-group\\n" > /etc/systemd/system/ssh.service.d/silo.conf; '
            'systemctl daemon-reload; systemctl stop ssh.socket ssh.service; rm -f /etc/ssh/ssh_host_*; '
            'ssh-keygen -A >/dev/null; install -d -m 700 -o user -g user /home/user/.ssh; '
            'install -m 600 -o user -g user /dev/null /home/user/.ssh/authorized_keys; '
            'mkdir -p /run/sshd; systemctl reset-failed ssh.service ssh.socket; systemctl start ssh', user='root', timeout=30)
        sbx.commands.run('/opt/lcu/current/bin/lcu-session --user user -- /opt/lcu/current/bin/lcu doctor',
                         envs=DESKTOP_ENV, timeout=30)
        self.lcu_call(sbx, 'js_reset', {})

    def lcu_call(self, sbx, tool, arguments):
        headers = {'E2b-Sandbox-Id': sbx.sandbox_id, 'E2b-Sandbox-Port': '6090',
                   'e2b-traffic-access-token': sbx.traffic_access_token}
        with httpx.Client(timeout=60, trust_env=False) as client:
            result = client.post('http://127.0.0.1:3002/call', headers=headers,
                                 json={'tool': tool, 'arguments': arguments})
            result.raise_for_status()
            return result.json()

    def revert(self, sid, checkpoint):
        with self.lock:
            record = self.record(sid)
            if checkpoint not in self.data['checkpoints']:
                raise KeyError('Unknown checkpoint')
            if record.get('operation') or record['status'] not in ('running', 'paused', 'missing'):
                raise Conflict('Workspace is not ready to revert')
            source = self.handle(sid) if record['status'] == 'running' else None
            old = record['sandbox_id']
            record['operation'] = {'id': str(uuid.uuid4()), 'old': old, 'candidate': None,
                                   'phase': 'pausing_source' if source else 'preparing'}
            self.save()
            if source:
                try:
                    source.pause(keep_memory=True)
                except Exception as error:
                    # The request may have been accepted despite a lost response.
                    # Keep the intent until passive recovery determines its state.
                    record['last_revert_error'] = str(error)
                    self.save()
                    raise
                self.handles.pop(sid, None)
                record['status'] = 'paused'
                record['epoch'] += 1
                record['operation']['phase'] = 'preparing'
                self.save()
            try:
                candidate = self.restore_candidate(checkpoint, record['name'], record['operation']['id'],
                                                   record.get('run_id'), sid)
                record['operation']['candidate'] = candidate.sandbox_id
                self.save()
                self.prepare_guest(candidate)
            except Exception as error:
                record['last_revert_error'] = str(error)
                self.save()
                try:
                    self.recover_revert(sid)
                except Conflict as recovery_error:
                    # Keep an ambiguous accepted create discoverable without
                    # replacing the original API/preparation failure.
                    record['recovery_error'] = str(recovery_error)
                    self.save()
                raise
            record.update(sandbox_id=candidate.sandbox_id, status='running', checkpoint=checkpoint)
            record.pop('last_revert_error', None)
            record['epoch'] += 1
            record['operation']['phase'] = 'committed'
            self.save()
            self.handles[sid] = candidate
            self.recover_revert(sid)
            return dict(record)

    def recover_revert(self, sid):
        with self.lock:
            record = self.record(sid)
            operation = record.get('operation')
            if not operation:
                return dict(record)
            if operation['phase'] == 'pausing_source':
                # No replacement was requested yet. A lost pause response must
                # not be treated as a failed pause or trigger a new create.
                try:
                    info = Sandbox.get_info(operation['old'])
                except Exception as error:
                    raise Conflict(f"Source state is unresolved for revert {operation['id']}: {error}") from error
                status = getattr(info.state, 'value', info.state)
                if status not in ('running', 'paused'):
                    raise Conflict(f"Source state is unresolved for revert {operation['id']}: {status}")
                if status == 'running':
                    # A lost pause response may be followed by an in-flight
                    # transition. One running read cannot prove rejection.
                    raise Conflict(f"Source is still running; pause outcome is unresolved for revert {operation['id']}")
                if record['status'] != status:
                    record['status'] = status
                    record['epoch'] += 1
                del record['operation']
                record.pop('recovery_error', None)
                self.save()
                return dict(record)
            retired = operation['old'] if operation['phase'] == 'committed' else operation['candidate']
            if retired:
                try:
                    Sandbox.kill(retired)
                except SandboxNotFoundException:
                    # A prior recovery may have killed this exact journaled
                    # runtime before crashing ahead of the final save.
                    pass
            elif operation.get('id'):
                # Covers a controller crash after E2B accepted create but before
                # its returned ID reached the journal. An empty lookup is not
                # proof of rejection: catalog visibility may lag the response.
                pages = Sandbox.list(query=SandboxQuery(metadata={
                    'silo-poc-owner': self.data['owner'], 'silo-operation': operation['id'],
                    'silo-operation-kind': 'revert'}))
                found = False
                while pages.has_next:
                    for candidate in pages.next_items():
                        found = True
                        try:
                            Sandbox.kill(candidate.sandbox_id)
                        except SandboxNotFoundException:
                            pass
                if not found:
                    operation['phase'] = 'candidate_unobserved'
                    self.save()
                    raise Conflict(f"Revert create outcome is unresolved for operation {operation['id']}")
            del record['operation']
            record.pop('recovery_error', None)
            self.save()
            return dict(record)

    def mode(self, sid, mode, viewer_instance=None):
        if mode not in ('agent', 'human'):
            raise ValueError('Mode must be agent or human')
        if viewer_instance is None:
            raise ValueError('Viewer instance is required for mode changes')
        try:
            if str(uuid.UUID(viewer_instance, version=4)) != viewer_instance:
                raise ValueError('Viewer instance must be a canonical UUIDv4')
        except (TypeError, AttributeError, ValueError) as error:
            raise ValueError('Viewer instance must be a canonical UUIDv4') from error
        owner = hashlib.sha256(viewer_instance.encode()).hexdigest()
        with self.lock:
            record = self.record(sid)
            if mode == 'agent' and record['mode'] == 'human' and record.get('control_owner') != owner:
                raise Conflict('Another viewer has control')
            record['mode'] = mode
            record['control_owner'] = owner if mode == 'human' else None
            record['epoch'] += 1
            self.save()
            return dict(record)

    def wait_durable_upload(self, sandbox_id, since_unix, timeout=300):
        """Block until the runtime logs its upload-success marker for a pause.

        Embed's Pause RPC returns before the snapshot's asynchronous upload
        finishes; the marker line is the only completion signal visible from
        outside the orchestrator. A timeout leaves a truthful undurable
        record that host shutdown will refuse.
        """
        deadline = time.time() + timeout
        last_error = None
        while time.time() < deadline:
            try:
                result = subprocess.run(
                    ['docker', 'logs', '--since', str(int(since_unix)), 'e2b-orchestrator-1'],
                    capture_output=True, text=True, timeout=30)
            except subprocess.SubprocessError as error:
                last_error = str(error)
                time.sleep(2)
                continue
            for line in (result.stdout + result.stderr).splitlines():
                if 'snapshot finished uploading successfully' not in line or sandbox_id not in line:
                    continue
                return {'marker_sha256': hashlib.sha256(line.encode()).hexdigest(),
                        'observed_at': time.time()}
            time.sleep(2)
        return {'timeout': True, 'waited_s': round(time.time() - since_unix, 1),
                'last_error': last_error}

    def lifecycle(self, sid, action):
        with self.lock:
            record = self.record(sid)
            if record.get('operation'):
                raise Conflict('Recover the incomplete revert first')
            if action == 'resume':
                self.handles[sid] = Sandbox.connect(record['sandbox_id'], timeout=3600)
                record['status'] = 'running'
            elif action == 'pause':
                began = time.time()
                self.handle(sid).pause(keep_memory=True)
                self.handles.pop(sid, None)
                record['status'] = 'paused'
                record['durable_upload'] = self.wait_durable_upload(record['sandbox_id'], began)
            elif action == 'delete':
                Sandbox.kill(record['sandbox_id'])
                self.handles.pop(sid, None)
                record['status'] = 'deleted'
            else:
                raise ValueError('Unknown lifecycle action')
            record['epoch'] += 1
            self.save()
            return dict(record)

    def checkpoint(self, sid):
        with self.lock:
            sandbox = self.handle(sid)
            self.require_snapshot_headroom()
            snapshot = sandbox.create_snapshot()
            result = {'id': snapshot.snapshot_id, 'source': sid, 'created': time.time(),
                      'run_id': self.record(sid).get('run_id')}
            self.data['checkpoints'][snapshot.snapshot_id] = result
            self.record(sid)['epoch'] += 1
            self.save()
            return result

    def require_snapshot_headroom(self):
        # A qualification guard for this fixed 2 GiB guest profile. Embed's
        # resume-fresh checkpoint can destroy its source on allocation failure.
        # This check is not an atomic runtime reservation or an upstream fix.
        memory = {}
        for line in Path('/proc/meminfo').read_text().splitlines():
            key, value = line.split(':', 1)
            memory[key] = int(value.split()[0])
        available_mb = (memory['HugePages_Free'] - memory['HugePages_Rsvd']) * memory['Hugepagesize'] // 1024
        if available_mb < 2560:
            raise Conflict(f'Checkpoint refused before pausing: {available_mb} MiB of hugepage headroom; this PoC requires 2560 MiB')

    def screenshot(self, sid):
        with self.lock:
            sbx = self.handle(sid)
            self.lcu_call(sbx, 'js', {'code': 'await cua.getState();'})
            result = self.lcu_call(sbx, 'js', {'code': 'await nodeRepl.emitImage((await cua.computer.get_screenshot())[0].data_url);'})
            picture = next(item for item in result['content'] if item['type'] == 'image')
            return base64.b64decode(picture['data'])

    def agent(self, sid, action, data):
        with self.lock:
            if self.record(sid)['mode'] != 'agent':
                raise Conflict('Human has control; return control to the agent first')
            sbx = self.handle(sid)
            if action == 'lcu':
                return self.lcu_call(sbx, data.get('tool', 'js'), data.get('arguments', {}))
            if action == 'shell':
                try:
                    result = sbx.commands.run(data['command'], timeout=30, envs=DESKTOP_ENV)
                except CommandExitException as error:
                    result = error
                return {'stdout': result.stdout, 'stderr': result.stderr, 'exit_code': result.exit_code}
            if action == 'write':
                path = workspace_path(data['path'])
                sbx.files.write(path, data['content'])
                return {'path': path}
            if action == 'read':
                return {'content': sbx.files.read(workspace_path(data['path']))}
            if action == 'type':
                method, arguments = 'type_text', {'text': data['text']}
            elif action == 'key':
                method, arguments = 'press_key', {'key': data['key']}
            elif action == 'click':
                x, y = int(data['x']), int(data['y'])
                if not (0 <= x < 1280 and 0 <= y < 800):
                    raise ValueError('Click is outside the 1280 × 800 desktop')
                method, arguments = 'click', {'x': x, 'y': y}
            else:
                raise ValueError('Unknown agent action')
            self.lcu_call(sbx, 'js', {'code': 'await cua.getState();'})
            return self.lcu_call(sbx, 'js', {'code': f'await cua.computer.{method}({json.dumps(arguments)});'})
