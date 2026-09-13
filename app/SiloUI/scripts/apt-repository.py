"""Build a signed, two-architecture APT repository from verified release packages."""
import argparse
from datetime import datetime, timedelta, timezone
from email.parser import Parser
from email.utils import format_datetime
import gzip
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.error import HTTPError
from urllib.request import urlopen

ARCHITECTURES = ('amd64', 'arm64')
MAX_VERSION_COUNT = 2


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def package_record(package, version, arch, root):
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise ValueError('Only stable Silo versions belong in this repository')
    if package.is_symlink() or not package.is_file():
        raise ValueError('Expected a regular Debian package')
    control = run('dpkg-deb', '--field', str(package))
    fields = Parser().parsestr(control)
    if any(len(fields.get_all(key, [])) != 1 for key in ('Package', 'Version', 'Architecture')):
        raise ValueError('Duplicate or missing package identity')
    if (fields['Package'], fields['Version'], fields['Architecture']) != ('silo', version, arch):
        raise ValueError('Package identity does not match the published release')
    if any(fields.get(key) for key in ('Filename', 'Size', 'SHA256', 'SHA512', 'MD5sum', 'SHA1')):
        raise ValueError('Unexpected archive fields in package control')
    relative = f'pool/main/s/silo/silo_{version}_{arch}.deb'
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(package, target)
    data = target.read_bytes()
    return f'{control}\nFilename: {relative}\nSize: {len(data)}\nSHA256: {hashlib.sha256(data).hexdigest()}\n\n'


def build(packages, output, fingerprint, public_key, now=None):
    if output.exists() and any(output.iterdir()):
        raise ValueError('Output must be empty; never overwrite a deployed repository')
    versions = sorted({version for version, _, _ in packages}, key=lambda v: tuple(map(int, v.split('.'))), reverse=True)
    if not versions or len(versions) > MAX_VERSION_COUNT:
        raise ValueError('Supply the latest one or two complete releases')
    if len(packages) != len(versions) * 2 or {(v, a) for v, a, _ in packages} != {(v, a) for v in versions for a in ARCHITECTURES}:
        raise ValueError('Both architectures are required for every release')
    public_fingerprints = [line.split(':')[9] for line in run('gpg', '--batch', '--with-colons', '--show-keys', str(public_key)).splitlines() if line.startswith('fpr:')]
    if not public_fingerprints or fingerprint.upper() != public_fingerprints[0]:
        raise ValueError('Signing key does not match the installer trust anchor')
    root = output / 'apt'
    release_dir = root / 'dists/stable'
    entries = []
    for arch in ARCHITECTURES:
        directory = release_dir / f'main/binary-{arch}'
        directory.mkdir(parents=True, exist_ok=True)
        records = ''.join(package_record(path, version, arch, root) for version in versions for v, a, path in packages if (v, a) == (version, arch))
        for name, data in [('Packages', records.encode()), ('Packages.gz', gzip.compress(records.encode(), mtime=0))]:
            path = directory / name
            path.write_bytes(data)
            digest = hashlib.sha256(data).hexdigest()
            by_hash = directory / 'by-hash/SHA256' / digest
            by_hash.parent.mkdir(parents=True, exist_ok=True)
            by_hash.write_bytes(data)
            entries.append((str(path.relative_to(release_dir)), len(data), digest))
    now = now or datetime.now(timezone.utc)
    release = '\n'.join([
        'Origin: Silo', 'Label: Silo', 'Suite: stable', 'Codename: stable',
        f'Date: {format_datetime(now, usegmt=True)}',
        f'Valid-Until: {format_datetime(now + timedelta(days=14), usegmt=True)}',
        'Architectures: amd64 arm64', 'Components: main', 'Acquire-By-Hash: yes',
        'Description: Official Silo desktop application updates', 'SHA256:',
        *(f' {digest} {size} {name}' for name, size, digest in entries), '',
    ])
    release_path = release_dir / 'Release'
    release_path.write_text(release)
    for flags, name in [(('--clearsign',), 'InRelease'), (('--armor', '--detach-sign'), 'Release.gpg')]:
        subprocess.run(['gpg', '--batch', '--yes', '--local-user', fingerprint, '--digest-algo', 'SHA256', '--output', str(release_dir / name), *flags, str(release_path)], check=True)
    subprocess.run(['gpgv', '--keyring', str(public_key.resolve()), str(release_dir / 'InRelease')], check=True, stdout=subprocess.DEVNULL)
    shutil.copyfile(public_key, root / 'silo-archive-keyring.gpg')
    (output / '.nojekyll').touch()
    (output / 'index.html').write_text('<!doctype html><title>Silo software updates</title><h1>Silo software updates</h1><p>This is the signed software source used by Silo’s Linux installer.</p><p><a href="https://github.com/0xpolarzero/silo/releases/latest">Download Silo</a></p>')


def preserve_previous_indexes(output, public_key, previous_url):
    """Keep the prior signed indexes available while clients refresh cached metadata."""
    with tempfile.TemporaryDirectory(prefix='silo-apt-previous-') as directory:
        signed = Path(directory) / 'InRelease'
        try:
            with urlopen(previous_url + '/dists/stable/InRelease', timeout=30) as response:
                signed.write_bytes(response.read(1024 * 1024))
        except HTTPError as error:
            if error.code == 404:
                return  # First deployment has no prior repository.
            raise
        release = Path(directory) / 'Release'
        subprocess.run(['gpgv', '--keyring', str(public_key.resolve()), '--output', str(release), str(signed)], check=True, capture_output=True)
        hashes = Parser().parsestr(release.read_text())['SHA256']
        if not hashes:
            raise ValueError('Previous signed release has no SHA256 indexes')
        for line in hashes.strip().splitlines():
            digest, size, name = line.split()
            if not re.fullmatch(r'main/binary-(amd64|arm64)/Packages(\.gz)?', name) or not re.fullmatch('[a-f0-9]{64}', digest):
                raise ValueError('Unexpected previous index')
            if not 0 < int(size) <= 1024 * 1024:
                raise ValueError('Previous index exceeds size limit')
            relative = str(Path(name).parent / 'by-hash/SHA256' / digest)
            with urlopen(previous_url + '/dists/stable/' + relative, timeout=30) as response:
                data = response.read(1024 * 1024 + 1)
            if len(data) != int(size) or hashlib.sha256(data).hexdigest() != digest:
                raise ValueError('Previous index checksum mismatch')
            target = output / 'apt/dists/stable' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--packages', type=Path, required=True, help='Directory with VERSION/Silo-linux-{x64,arm64}.deb')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--fingerprint', required=True)
    parser.add_argument('--public-key', type=Path, default=Path(__file__).with_name('debian') / 'silo-archive-keyring.gpg')
    parser.add_argument('--previous-url', help='Previously deployed repository URL; verified with the pinned archive key')
    args = parser.parse_args()
    packages = [(directory.name, arch, directory / f'Silo-linux-{asset}.deb') for directory in args.packages.iterdir() if directory.is_dir() for arch, asset in [('amd64', 'x64'), ('arm64', 'arm64')]]
    build(packages, args.output, args.fingerprint, args.public_key)
    if args.previous_url:
        preserve_previous_indexes(args.output, args.public_key, args.previous_url)
    if sum(p.stat().st_size for p in args.output.rglob('*') if p.is_file()) > 900 * 1024 * 1024:
        raise ValueError('Repository exceeds the GitHub Pages size budget')
