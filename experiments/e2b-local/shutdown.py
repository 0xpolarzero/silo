"""Save owned desktops and independently verify them before host shutdown."""
import json
import os
import subprocess

from e2b import Sandbox
from e2b.exceptions import SandboxNotFoundException
from runtime import STATE, configure


def verify_registry():
    """Passive checks retained for use after a durable-upload barrier exists."""
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
    print(json.dumps({'verified_paused': verified, 'running_firecracker_processes': 0}), flush=True)


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run as root: the desktop registry is deliberately private')
    # Pause returns before the runtime's asynchronous artifact upload finishes.
    # The Compose orchestrator has a 60s stop grace period, while its upload
    # retry budget is 2h. SDK state=paused and zero Firecracker PIDs cannot
    # establish that a restart will find every required snapshot component.
    raise RuntimeError('Host stop is disabled until a per-snapshot durable-upload barrier is qualified')


if __name__ == '__main__':
    main()
