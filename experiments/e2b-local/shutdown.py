"""Save owned desktops and independently verify them before host shutdown."""
import json
import os
import subprocess

from e2b import Sandbox
from e2b.exceptions import SandboxNotFoundException
from runtime import STATE, configure


def verify_registry():
    """Passive checks: registry exists, no incomplete operations, all saved."""
    registry = STATE / 'desktops.json'
    if not registry.exists():
        raise RuntimeError('No desktop registry; SDK-only guests may exist')
    configure()
    verified = []
    for sid, record in json.loads(registry.read_text())['desktops'].items():
        if record['status'] == 'deleted':
            continue
        if record.get('operation'):
            raise RuntimeError(f'Refusing host shutdown: {sid} has an incomplete operation')
        if record['status'] in ('missing', 'failed', 'preparing'):
            raise RuntimeError(f'Refusing host shutdown: {sid} ({record["sandbox_id"]}) has unresolved {record["status"]} state')
        try:
            info = Sandbox.get_info(record['sandbox_id'])
        except SandboxNotFoundException:
            raise RuntimeError(f'Refusing host shutdown: {sid} ({record["sandbox_id"]}) is missing from E2B') from None
        state = getattr(info.state, 'value', info.state)
        if state != 'paused':
            raise RuntimeError(f'Refusing host shutdown: {sid} is {state}')
        verified.append(sid)
    live = subprocess.run(['pgrep', '-x', 'firecracker'], capture_output=True, text=True)
    if live.returncode != 1:
        raise RuntimeError('Refusing host shutdown: Firecracker is still running or its check failed')
    return verified


def verify_durability(desktops):
    """Every paused desktop must carry its pause's verified upload marker.

    The runtime's Pause returns before the snapshot upload completes, so a
    paused record without a marker line hash (including a recorded timeout)
    does not establish that a restart will find the snapshot complete.
    """
    undurable = []
    for sid, record in desktops.items():
        if record.get('status') != 'paused':
            continue
        marker = record.get('durable_upload') or {}
        if not marker.get('marker_sha256'):
            undurable.append({'id': sid, 'sandbox_id': record.get('sandbox_id'),
                              'durable_upload': marker})
    if undurable:
        raise RuntimeError('Refusing host shutdown: paused desktops without a verified '
                           'durable upload: ' + json.dumps(undurable)[:400])
    return sorted(desktops)


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run as root: the desktop registry is deliberately private')
    registry = STATE / 'desktops.json'
    if not registry.exists():
        raise RuntimeError('No desktop registry; SDK-only guests may exist')
    desktops = json.loads(registry.read_text())['desktops']
    verified = verify_registry()
    durable = verify_durability(desktops)
    sync = subprocess.run(['sync', '-f', '/var/lib/e2b/storage'])
    if sync.returncode != 0:
        raise RuntimeError('Refusing host shutdown: canonical storage sync failed')
    receipt = {'barrier': 'passed', 'verified_paused': verified, 'durable': durable,
               'running_firecracker_processes': 0}
    print(json.dumps(receipt), flush=True)
    return receipt


if __name__ == '__main__':
    main()
