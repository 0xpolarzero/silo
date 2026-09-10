"""Verify Tauri's base64-encoded minisign signatures using the committed public key."""
import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(sys.argv[1])
config = json.loads((Path(__file__).parent.parent / 'src-tauri/tauri.conf.json').read_text())
with tempfile.TemporaryDirectory() as directory:
    public = Path(directory, 'public.key')
    public.write_bytes(base64.b64decode(config['plugins']['updater']['pubkey'], validate=True))
    signatures = list(root.glob('*.sig'))
    if not signatures:
        raise RuntimeError('No updater signatures found.')
    for signature in signatures:
        decoded = Path(directory, 'artifact.sig')
        decoded.write_bytes(base64.b64decode(signature.read_text().strip(), validate=True))
        subprocess.run(['minisign', '-Vm', str(signature.with_suffix('')), '-p', str(public), '-x', str(decoded)], check=True)
