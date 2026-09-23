"""Measure the experiment's real host, guest, cache and snapshot footprint."""
import json
from pathlib import Path
import subprocess
import time
from e2b import Sandbox
from runtime import configure, STATE

root = Path(__file__).resolve().parent
configure()
registry = json.loads((STATE / 'desktops.json').read_text())


def filesystem(text):
    row = text.strip().splitlines()[-1].split()
    return {'total_bytes': int(row[1]), 'used_bytes': int(row[2]), 'available_bytes': int(row[3])}


def meminfo(text):
    result = {}
    for line in text.splitlines():
        key, value = line.split(':', 1)
        if key in {'MemTotal', 'MemAvailable', 'HugePages_Total', 'HugePages_Free', 'Hugepagesize'}:
            fields = value.split()
            result[key + ('_bytes' if len(fields) > 1 and fields[1] == 'kB' else '')] = int(fields[0]) * (1024 if len(fields) > 1 and fields[1] == 'kB' else 1)
    return result


result = {'measured_at': time.time(), 'host_kernel': subprocess.check_output(['uname', '-a'], text=True).strip(),
          'host_memory': meminfo(Path('/proc/meminfo').read_text()),
          'host_filesystem': filesystem(subprocess.check_output(['df', '-B1', '/'], text=True)),
          'e2b_allocated_bytes': int(subprocess.check_output(['du', '-s', '-B1', '/var/lib/e2b'], text=True).split()[0]),
          'e2b_directory_allocation': subprocess.check_output(['du', '-B1', '--max-depth=2', '/var/lib/e2b'], text=True),
          'docker_usage': subprocess.check_output(['docker', 'system', 'df', '--format', '{{json .}}'], text=True),
          'firecracker_processes': subprocess.run(['ps', '-C', 'firecracker', '-o', 'pid,comm'], capture_output=True, text=True).stdout,
          'desktops': []}
for sid, record in registry['desktops'].items():
    if record['status'] != 'running':
        continue  # Observing resources must never resume a paused desktop.
    sandbox = Sandbox.connect(record['sandbox_id'])
    info = sandbox.get_info()
    result['desktops'].append({'id': sid, 'sandbox_id': record['sandbox_id'], 'cpus': info.cpu_count, 'memory_mib': info.memory_mb,
        'memory': meminfo(sandbox.files.read('/proc/meminfo')),
        'filesystem': filesystem(sandbox.commands.run('df -B1 /').stdout),
        'desktop_packages': sandbox.commands.run("dpkg-query -W -f='${Package} ${Version} ${Installed-Size} KiB\\n' firefox-esr xfce4-session mousepad novnc xvfb fonts-noto-cjk").stdout})
(root / 'evidence/lcu-resources.json').write_text(json.dumps(result, indent=2))
print(json.dumps({key: result[key] for key in ('host_memory', 'host_filesystem', 'e2b_allocated_bytes')}, indent=2))
