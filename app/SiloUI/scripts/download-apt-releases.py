"""Fetch the latest published stable release and its predecessor, checking all bytes."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

REPOSITORY = '0xpolarzero/silo'


def gh(*args):
    return subprocess.check_output(['gh', *args], text=True)


def download(output):
    latest = json.loads(gh('api', f'repos/{REPOSITORY}/releases/latest'))
    pages = json.loads(gh('api', '--paginate', '--slurp', f'repos/{REPOSITORY}/releases'))
    stable = [r for page in pages for r in page if not r['draft'] and not r['prerelease'] and re.fullmatch(r'v\d+\.\d+\.\d+', r['tag_name'])]
    stable.sort(key=lambda r: tuple(map(int, r['tag_name'][1:].split('.'))), reverse=True)
    if not stable or stable[0]['tag_name'] != latest['tag_name']:
        raise ValueError('Latest release must be the highest published stable version')
    output.mkdir(parents=True, exist_ok=False)
    for release in stable[:2]:
        version = release['tag_name'][1:]
        target = output / version
        target.mkdir()
        subprocess.run(['gh', 'release', 'download', release['tag_name'], '--repo', REPOSITORY, '--dir', str(target), '--pattern', 'Silo-linux-*.deb', '--pattern', 'SHA256SUMS'], check=True)
        hashes = {}
        for line in (target / 'SHA256SUMS').read_text().splitlines():
            digest, name = line.split('  ', 1)
            if name in hashes or not re.fullmatch(r'[0-9a-f]{64}', digest):
                raise ValueError('Invalid or duplicate release checksums')
            hashes[name] = digest
        for name in ('Silo-linux-x64.deb', 'Silo-linux-arm64.deb'):
            package = target / name
            if package.is_symlink() or hashlib.sha256(package.read_bytes()).hexdigest() != hashes.get(name):
                raise ValueError('Release package checksum mismatch')
    (output / 'latest-version').write_text(latest['tag_name'])


if __name__ == '__main__':
    download(Path(sys.argv[1]))
