"""Exercise real GPG signatures, dpkg metadata, and APT's candidate selection."""
import importlib.util
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('apt_repository', Path(__file__).with_name('apt-repository.py'))
repo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repo)


class RetentionTests(unittest.TestCase):
    """Exercise publication with local files and only the signing tools replaced."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.key = self.root / 'key.gpg'
        self.key.write_bytes(b'test key')
        self.now = datetime.now(timezone.utc).replace(microsecond=0)
        self.fingerprint = 'A' * 40
        self.packages = []
        for version in ('0.1.0', '0.2.0', '0.3.0', '0.4.0'):
            for arch in repo.ARCHITECTURES:
                path = self.root / f'{version}-{arch}.deb'
                path.write_bytes(path.name.encode())
                self.packages.append((version, arch, path))
        def run(*args):
            if args[0] == 'gpg':
                return 'fpr:::::::::' + self.fingerprint
            version, arch = Path(args[-1]).stem.rsplit('-', 1)
            return f'Package: silo\nVersion: {version}\nArchitecture: {arch}'
        def sign(args, **kwargs):
            if '--output' not in args:
                return
            destination = Path(args[args.index('--output') + 1])
            shutil.copyfile(args[-1], destination)
        self.addCleanup(patch.stopall)
        patch.object(repo, 'run', side_effect=run).start()
        patch.object(repo.subprocess, 'run', side_effect=sign).start()

    def publish(self, name, versions, day, previous=None):
        site = self.root / name
        now = self.now + timedelta(days=day)
        repo.build([p for p in self.packages if p[0] in versions], site, self.fingerprint, self.key, now=now)
        if previous:
            with patch.object(repo, 'datetime', wraps=datetime) as clock:
                clock.now.return_value = now
                repo.preserve_previous_indexes(site, self.key, (previous / 'apt').as_uri())
        return site

    def test_three_publications_keep_all_unexpired_objects(self):
        first = self.publish('first', ('0.1.0', '0.2.0'), 0)
        second = self.publish('second', ('0.2.0', '0.3.0'), 1, first)
        third = self.publish('third', ('0.3.0', '0.4.0'), 2, second)
        for old in (first, second):
            for path in (old / 'apt').rglob('*'):
                if path.is_file() and ('by-hash' in path.parts or 'pool' in path.parts):
                    self.assertEqual((third / path.relative_to(old)).read_bytes(), path.read_bytes())
        current = (third / 'apt/dists/stable/main/binary-amd64/Packages').read_text()
        self.assertNotIn('Version: 0.1.0', current)
        self.assertNotIn('Version: 0.2.0', current)

    def test_expired_metadata_and_unreferenced_objects_are_removed(self):
        first = self.publish('first', ('0.1.0', '0.2.0'), 0)
        second = self.publish('second', ('0.2.0', '0.3.0'), 1, first)
        third = self.publish('third', ('0.3.0', '0.4.0'), 14, second)
        self.assertFalse((third / 'apt/pool/main/s/silo/silo_0.1.0_amd64.deb').exists())
        self.assertTrue((third / 'apt/pool/main/s/silo/silo_0.2.0_amd64.deb').exists())
        expired_index = next((first / 'apt/dists/stable/main/binary-amd64/by-hash/SHA256').iterdir())
        self.assertFalse((third / expired_index.relative_to(first)).exists())
        fourth = self.publish('fourth', ('0.3.0', '0.4.0'), 15, third)
        self.assertFalse((fourth / 'apt/pool/main/s/silo/silo_0.2.0_amd64.deb').exists())

    def test_tampered_retained_package_is_rejected(self):
        first = self.publish('first', ('0.1.0', '0.2.0'), 0)
        (first / 'apt/pool/main/s/silo/silo_0.1.0_amd64.deb').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.publish('second', ('0.2.0', '0.3.0'), 1, first)

    def test_retention_refuses_to_exceed_pages_budget(self):
        first = self.publish('first', ('0.1.0', '0.2.0'), 0)
        second = self.publish('second', ('0.2.0', '0.3.0'), 1)
        size = sum(p.stat().st_size for p in second.rglob('*') if p.is_file())
        with patch.object(repo, 'MAX_REPOSITORY_BYTES', size + 1):
            with self.assertRaisesRegex(ValueError, 'size budget'):
                repo.preserve_previous_indexes(second, self.key, (first / 'apt').as_uri())

    def test_bootstraps_a_repository_without_retention_history(self):
        first = self.publish('first', ('0.1.0', '0.2.0'), 0)
        (first / 'apt/retained-releases.json').unlink()
        second = self.publish('second', ('0.2.0', '0.3.0'), 1, first)
        self.assertTrue((second / 'apt/pool/main/s/silo/silo_0.1.0_amd64.deb').exists())


@unittest.skipUnless(all(shutil.which(x) for x in ('gpg', 'gpgv', 'dpkg-deb', 'apt-get')), 'Linux APT/GPG tools required')
class RepositoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.root.chmod(0o755)
        home = self.root / 'gnupg'; home.mkdir(mode=0o700)
        self.old_home = os.environ.get('GNUPGHOME')
        os.environ['GNUPGHOME'] = str(home)
        self.addCleanup(self.restore_home)
        subprocess.run(['gpg', '--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'Silo disposable test', 'ed25519', 'sign', '1d'], check=True, capture_output=True)
        self.fingerprint = next(line.split(':')[9] for line in repo.run('gpg', '--batch', '--with-colons', '--list-keys').splitlines() if line.startswith('fpr:'))
        self.key = self.root / 'test.gpg'
        self.key.write_bytes(subprocess.check_output(['gpg', '--export', self.fingerprint]))
        self.packages = []
        for version in ('0.1.0', '0.2.0', '0.3.0', '0.4.0'):
            for arch in repo.ARCHITECTURES:
                tree = self.root / f'{version}-{arch}'
                (tree / 'DEBIAN').mkdir(parents=True)
                (tree / 'DEBIAN/control').write_text(f'Package: silo\nVersion: {version}\nArchitecture: {arch}\nMaintainer: Test\nDescription: Disposable APT fixture\n')
                path = tree.parent / (tree.name + '.deb')
                subprocess.run(['dpkg-deb', '--build', str(tree), str(path)], check=True, capture_output=True)
                self.packages.append((version, arch, path))
        self.site = self.root / 'site'

    def restore_home(self):
        if self.old_home is None: os.environ.pop('GNUPGHOME', None)
        else: os.environ['GNUPGHOME'] = self.old_home

    def build(self, packages=None):
        repo.build(self.packages[:4] if packages is None else packages, self.site, self.fingerprint, self.key)

    def apt_options(self):
        (self.root / 'sources.list').write_text(f'deb [signed-by={self.key}] file:{self.site}/apt stable main\n')
        (self.root / 'lists/partial').mkdir(parents=True, exist_ok=True)
        (self.root / 'cache/archives/partial').mkdir(parents=True, exist_ok=True)
        (self.root / 'status').touch()
        return ['-o', f'Dir::Etc::sourcelist={self.root}/sources.list', '-o', 'Dir::Etc::sourceparts=-', '-o', f'Dir::State::lists={self.root}/lists', '-o', f'Dir::State::status={self.root}/status', '-o', f'Dir::Cache={self.root}/cache', '-o', 'APT::Get::List-Cleanup=0']

    def test_signed_repository_selects_newest_version(self):
        self.build()
        opts = self.apt_options()
        subprocess.run(['apt-get', *opts, 'update'], check=True, capture_output=True)
        result = subprocess.check_output(['apt-cache', *opts, 'policy', 'silo'], text=True)
        self.assertIn('Candidate: 0.2.0', result)
        self.assertIn('0.1.0', result)

    def test_cached_indexes_survive_republication(self):
        old_site = self.root / 'old-site'
        repo.build(self.packages[:2], old_site, self.fingerprint, self.key)
        self.build()
        repo.preserve_previous_indexes(self.site, self.key, (old_site / 'apt').as_uri())
        for old in (old_site / 'apt/dists/stable').glob('main/binary-*/by-hash/SHA256/*'):
            current = self.site / old.relative_to(old_site)
            self.assertEqual(current.read_bytes(), old.read_bytes())

    def test_apt_downloads_from_cached_metadata_after_three_publications(self):
        self.build()
        opts = self.apt_options()
        subprocess.run(['apt-get', *opts, 'update'], check=True, capture_output=True)
        for number, packages in enumerate((self.packages[2:6], self.packages[4:8])):
            previous = self.root / f'previous-{number}'
            self.site.rename(previous)
            self.build(packages)
            repo.preserve_previous_indexes(self.site, self.key, (previous / 'apt').as_uri())
        # No update: APT still holds the first publication's signed indexes.
        subprocess.run(['apt-get', *opts, 'download', 'silo=0.1.0'], cwd=self.root, check=True, capture_output=True)
        downloaded = next(self.root.glob('silo_0.1.0_*.deb'))
        arch = downloaded.stem.rsplit('_', 1)[1]
        original = next(p for v, a, p in self.packages if (v, a) == ('0.1.0', arch))
        self.assertEqual(downloaded.read_bytes(), original.read_bytes())

    def test_retained_historical_metadata_requires_valid_signature(self):
        first = self.root / 'first'
        repo.build(self.packages[:4], first, self.fingerprint, self.key)
        second = self.root / 'second'
        repo.build(self.packages[2:6], second, self.fingerprint, self.key)
        repo.preserve_previous_indexes(second, self.key, (first / 'apt').as_uri())
        historical = next(p for p in (second / 'apt/dists/stable/retained').iterdir() if p.read_bytes() == (first / 'apt/dists/stable/InRelease').read_bytes())
        historical.write_text(historical.read_text().replace('Label: Silo', 'Label: Forged'))
        self.build(self.packages[4:8])
        with self.assertRaisesRegex(ValueError, 'release checksum mismatch'):
            repo.preserve_previous_indexes(self.site, self.key, (second / 'apt').as_uri())

    def test_previous_repository_requires_valid_signature(self):
        old_site = self.root / 'old-site'
        repo.build(self.packages[:2], old_site, self.fingerprint, self.key)
        signed = old_site / 'apt/dists/stable/InRelease'
        signed.write_text(signed.read_text().replace('Label: Silo', 'Label: Forged'))
        self.build()
        with self.assertRaises(subprocess.CalledProcessError):
            repo.preserve_previous_indexes(self.site, self.key, (old_site / 'apt').as_uri())

    def test_modified_package_is_rejected(self):
        self.build()
        opts = self.apt_options()
        subprocess.run(['apt-get', *opts, 'update'], check=True, capture_output=True)
        arch = repo.run('dpkg', '--print-architecture')
        path = self.site / f'apt/pool/main/s/silo/silo_0.2.0_{arch}.deb'
        path.write_bytes(path.read_bytes() + b'tampered')
        result = subprocess.run(['apt-get', *opts, 'download', 'silo=0.2.0'], cwd=self.root, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Hash Sum mismatch', result.stdout + result.stderr)

    def test_modified_signed_metadata_is_rejected(self):
        self.build()
        path = self.site / 'apt/dists/stable/InRelease'
        path.write_text(path.read_text().replace('Label: Silo', 'Label: Forged'))
        result = subprocess.run(['apt-get', *self.apt_options(), 'update'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def test_rejects_partial_release(self):
        with self.assertRaisesRegex(ValueError, 'Both architectures'):
            self.build(self.packages[:3])

    def test_rejects_mislabeled_package(self):
        packages = [(v, a, self.packages[0][2] if a == 'arm64' else p) for v, a, p in self.packages[:4]]
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.build(packages)

    def test_rejects_wrong_signing_key(self):
        with self.assertRaisesRegex(ValueError, 'trust anchor'):
            repo.build(self.packages[:4], self.site, '0' * 40, self.key)


if __name__ == '__main__':
    unittest.main()
