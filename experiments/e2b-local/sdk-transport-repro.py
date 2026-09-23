#!/usr/bin/env python3
"""One disposable SDK guest for PTY exit and binary file transport checks."""
import hashlib
import io
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import secrets
import shlex
import time
import uuid
from datetime import datetime

from e2b import CommandExitException, PtySize, Sandbox

HERE = Path(__file__).resolve().parent
TEMPLATE = 'silo-sdk-lifecycle-20260923'
EVIDENCE = HERE / 'evidence' / 'sdk-transport'


def configure():
    for line in (HERE / 'state' / 'sdk.env').read_text().splitlines():
        parts = shlex.split(line)
        if len(parts) == 2 and parts[0] == 'export':
            key, value = parts[1].split('=', 1)
            if key in {'E2B_API_KEY', 'E2B_API_URL', 'E2B_SANDBOX_URL'}:
                os.environ[key] = value


def save(path, report):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(report, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def inventory():
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        name, _, value = line.partition(':')
        if name in {'HugePages_Free', 'HugePages_Rsvd', 'Hugepagesize', 'MemAvailable'}:
            memory[name] = value.strip()
    disk = os.statvfs('/var/lib/e2b')
    source = Path(__file__).read_bytes()
    return {
        'at_local': datetime.now().astimezone().isoformat(),
        'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
        'kernel': platform.release(), 'architecture': platform.machine(),
        'sdk_version': importlib.metadata.version('e2b'),
        'script_sha256': hashlib.sha256(source).hexdigest(),
        'hugepages': memory,
        'guest_disk_free_bytes': disk.f_bavail * disk.f_frsize,
    }


class InterruptedSource(io.RawIOBase):
    """Emit one bounded chunk, then fail the upload producer."""
    def __init__(self):
        super().__init__()
        self.calls = 0

    def readable(self):
        return True

    def read(self, size=-1):
        self.calls += 1
        if self.calls > 1:
            raise OSError('intentional upload-source interruption')
        return b'x' * min(65536, size if size > 0 else 65536)


def run():
    configure()
    run_id = uuid.uuid4().hex
    output = EVIDENCE / f'{run_id}.json'
    report = {'run_id': run_id, 'template': TEMPLATE, 'status': 'running',
              'started_unix': time.time(), 'before': inventory(),
              'sandbox_id': None, 'checks': {},
              'create_request': {'template': TEMPLATE, 'timeout': 600,
                                 'metadata': {'sdk-transport-run': run_id},
                                 'lifecycle': {'on_timeout': 'pause', 'auto_resume': False}}}
    save(output, report)
    sandbox = None
    try:
        sandbox = Sandbox.create(TEMPLATE, timeout=600,
            metadata={'sdk-transport-run': run_id},
            lifecycle={'on_timeout': 'pause', 'auto_resume': False})
        report['sandbox_id'] = sandbox.sandbox_id
        info = Sandbox.get_info(sandbox.sandbox_id)
        report['sandbox_info'] = {
            'state': getattr(info.state, 'value', info.state),
            'template_id': getattr(info, 'template_id', None),
            'cpu_count': getattr(info, 'cpu_count', None),
            'memory_mb': getattr(info, 'memory_mb', None),
        }
        save(output, report)

        marker = secrets.token_hex(8).encode()
        chunks = []
        pty = sandbox.pty.create(PtySize(rows=24, cols=80), timeout=30)
        report['pty_pid'] = pty.pid
        sandbox.pty.send_stdin(pty.pid, b"printf '%s\\n' " + marker + b'; exit 17\n')
        try:
            result = pty.wait(on_pty=chunks.append)
            exit_code = result.exit_code
        except CommandExitException as error:
            exit_code = error.exit_code
        if exit_code != 17 or marker not in b''.join(chunks):
            raise AssertionError(f'PTY exit/output mismatch: exit={exit_code}, marker_seen={marker in b"".join(chunks)}')
        report['checks']['pty_nonzero_exit'] = {'exit_code': exit_code, 'output_marker_seen': True}
        save(output, report)

        payload = secrets.token_bytes(256 * 1024)
        expected_hash = hashlib.sha256(payload).hexdigest()
        path = '/home/user/sdk-transport/binary.bin'
        sandbox.files.write(path, payload)
        digest = hashlib.sha256()
        chunk_count = 0
        with sandbox.files.read(path, format='stream') as stream:
            for chunk in stream:
                digest.update(chunk)
                chunk_count += 1
        if digest.hexdigest() != expected_hash or chunk_count == 0:
            raise AssertionError('Binary file stream hash mismatch')
        report['checks']['binary_stream'] = {'bytes': len(payload), 'sha256': expected_hash,
                                              'chunks': chunk_count}
        save(output, report)

        interrupted = '/home/user/sdk-transport/interrupted.bin'
        source = InterruptedSource()
        try:
            sandbox.files.write(interrupted, source)
        except Exception as error:
            if source.calls < 2 or 'intentional upload-source interruption' not in str(error):
                raise
            report['checks']['interrupted_upload'] = {
                'reported_success': False, 'source_reads': source.calls,
                'error_type': type(error).__name__}
        else:
            raise AssertionError('Interrupted producer was reported successful')
        partial = sandbox.commands.run(
            'if test -e /home/user/sdk-transport/interrupted.bin; '
            'then stat -c %s /home/user/sdk-transport/interrupted.bin; '
            'else printf absent; fi', timeout=10).stdout.strip()
        report['checks']['interrupted_upload']['remote_file_bytes'] = (
            int(partial) if partial.isdecimal() else 'absent')
        save(output, report)

        reader = sandbox.files.read(path, format='stream')
        try:
            first = next(reader)
            if not first:
                raise AssertionError('Cancelled download produced no bytes')
        finally:
            reader.close()
        if hashlib.sha256(bytes(sandbox.files.read(path, format='bytes'))).hexdigest() != expected_hash:
            raise AssertionError('File changed after cancelled download')
        report['checks']['cancelled_download'] = {'first_chunk_bytes': len(first),
                                                  'full_retry_hash_matches': True}
        report['status'] = 'passed'
        save(output, report)

        Sandbox.kill(sandbox.sandbox_id)
        report['owned_guest_deleted_after_pass'] = True
        report['finished_unix'] = time.time()
        report['after'] = inventory()
        save(output, report)
    except Exception as error:
        report['status'] = 'failed'
        report['error_type'] = type(error).__name__
        report['error_summary'] = str(error)[:400]
        report['finished_unix'] = time.time()
        report['owned_guest_kept_for_inspection'] = sandbox is not None
        save(output, report)
        raise
    print(json.dumps({'run_id': run_id, 'status': report['status'],
                      'sandbox_id': report['sandbox_id'], 'report': str(output)}))


if __name__ == '__main__':
    try:
        run()
    except Exception:
        raise SystemExit(1)
