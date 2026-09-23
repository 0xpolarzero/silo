"""Offline repair: remove only byte-identical copies of retained E2B artifacts.

Run as root inside the private PoC after pausing guests and stopping orchestrator.
Never remove canonical artifacts, unmatched files or failed snapshot outputs.
"""
import filecmp
import json
from pathlib import Path
import re
import subprocess
import time

root = Path('/opt/silo-e2b-poc')
assert Path(__file__).resolve().parent == root and (root / 'state/desktops.json').is_file()
for name in ('firecracker', 'orchestrator'):
    result = subprocess.run(['pgrep', '-x', name], capture_output=True)
    if result.returncode != 1:
        raise SystemExit('Refusing cache reclamation while ' + name + ' is running or cannot be checked')
removed = []
for path in Path('/orchestrator/build').iterdir():
    match = re.fullmatch(r'([0-9a-f-]{36})-(memfile|rootfs\.ext4)-[a-z0-9]+', path.name)
    if not match or not path.is_file() or path.is_symlink():
        continue
    canonical = Path('/var/lib/e2b/storage/templates') / match[1] / match[2]
    if canonical.is_file() and filecmp.cmp(path, canonical, shallow=False):
        removed.append({'name': path.name, 'allocated_bytes': path.stat().st_blocks * 512})
        path.unlink()
report = {'removed': removed, 'allocated_bytes': sum(r['allocated_bytes'] for r in removed)}
(root / 'evidence' / ('cache-reclamation-' + str(int(time.time())) + '.json')).write_text(json.dumps(report, indent=2))
print(json.dumps({'files': len(removed), 'allocated_bytes': report['allocated_bytes']}))
