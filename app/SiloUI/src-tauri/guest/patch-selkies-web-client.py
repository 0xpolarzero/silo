#!/usr/bin/env python3
"""Apply Silo's source-hash-guarded Selkies 2.0.0 WebSocket status fix."""
import hashlib
import os
from pathlib import Path
import stat
import sys
import tempfile


SOURCE_SHA256 = {
    'amd64': '3a2199dfa2535eb0ad077e6413df11ef57b944e802209788d140c2194e2e1519',
    'arm64': '3a2199dfa2535eb0ad077e6413df11ef57b944e802209788d140c2194e2e1519',
}
PATCHED_SHA256 = {
    'amd64': '7ef83a1dc3fd37f30662bd0faabc4f640380bea30c6a1d47f7ff89deebc554a2',
    'arm64': '7ef83a1dc3fd37f30662bd0faabc4f640380bea30c6a1d47f7ff89deebc554a2',
}

# Keep the update to the readable upstream behavior narrow: publish the
# waiting state before async codec capability checks, so an early MODE message
# can advance it without the post-await continuation restoring stale status.
ONOPEN_OLD = (
    b'l.onopen=async()=>{console.log(`[websockets] Connection opened!`),'
    b'await Bi(),await se===`avcc`'
)
ONOPEN_NEW = (
    b'l.onopen=async()=>{fr=`connected_waiting_mode`,pr=`Connection established. '
    b'Waiting for server mode...`,Gr(),console.log(`[websockets] Connection opened!`),'
    b'await Bi(),await se===`avcc`'
)
LATE_STATUS_OLD = (
    b'if(fr=`connected_waiting_mode`,pr=`Connection established. Waiting for server mode...`,'
    b'Gr(),typeof DecompressionStream<`u`)'
)
LATE_STATUS_NEW = b'if(typeof DecompressionStream<`u`)'
PRESENTED_OLD = (
    b'if(t.type===`presented`){fe=!0,Yr&&s&&(s.style.display=`none`);return}'
)
PRESENTED_NEW = (
    b'if(t.type===`presented`){fe=!0,Yr&&s&&(s.style.display=`none`),!xr&&no();return}'
)


def transform_source(source):
    if (source.count(ONOPEN_OLD) != 1 or source.count(LATE_STATUS_OLD) != 1 or
            source.count(PRESENTED_OLD) != 1):
        raise ValueError('Pinned Selkies client does not match the expected source fragments')
    updated = source.replace(ONOPEN_OLD, ONOPEN_NEW, 1)
    updated = updated.replace(LATE_STATUS_OLD, LATE_STATUS_NEW, 1)
    updated = updated.replace(PRESENTED_OLD, PRESENTED_NEW, 1)
    if (updated.count(ONOPEN_NEW) != 1 or updated.count(LATE_STATUS_OLD) or
            updated.count(PRESENTED_OLD) or updated.count(PRESENTED_NEW) != 1):
        raise ValueError('Selkies client patch did not produce the expected result')
    return updated


def patch_file(path, architecture):
    if architecture not in SOURCE_SHA256:
        raise ValueError('Unsupported Selkies package architecture')
    path = Path(path)
    if not path.is_file() or path.is_symlink():
        raise ValueError('Selkies web client asset is missing or not a regular file')
    source = path.read_bytes()
    digest = hashlib.sha256(source).hexdigest()
    if digest == PATCHED_SHA256[architecture]:
        return 'already patched'
    if digest != SOURCE_SHA256[architecture]:
        raise ValueError('Selkies web client source hash is not the pinned 2.0.0 asset')
    updated = transform_source(source)
    if hashlib.sha256(updated).hexdigest() != PATCHED_SHA256[architecture]:
        raise ValueError('Selkies web client patch result hash mismatch')

    original = path.stat()
    fd, temporary = tempfile.mkstemp(prefix='.selkies-core-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(updated)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, stat.S_IMODE(original.st_mode))
        os.chown(temporary, original.st_uid, original.st_gid)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return 'patched'


def find_asset():
    assets = []
    for directory in Path('/opt/selkies/lib').glob(
            'python*/site-packages/selkies/selkies_web/assets'):
        assets.extend(directory.glob('selkies-core-*.js'))
    if len(assets) != 1:
        raise ValueError('Expected exactly one installed Selkies 2.0.0 core asset')
    return assets[0]


def main(argv):
    if len(argv) != 1:
        raise ValueError('Usage: patch-selkies-web-client.py amd64|arm64')
    print(f"Selkies 2.0.0 {argv[0]} web client {patch_file(find_asset(), argv[0])}")


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
