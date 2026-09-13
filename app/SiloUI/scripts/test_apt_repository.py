"""Exercise real GPG signatures, dpkg metadata, and APT's candidate selection."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('apt_repository', Path(__file__).with_name('apt-repository.py'))
repo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repo)


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
        for version in ('0.1.0', '0.2.0'):
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
        repo.build(self.packages if packages is None else packages, self.site, self.fingerprint, self.key)

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
        path = self.site / 'apt/pool/main/s/silo/silo_0.2.0_amd64.deb'
        path.write_bytes(path.read_bytes() + b'tampered')
        result = subprocess.run(['apt-get', *opts, '--download-only', '-y', 'install', 'silo'], capture_output=True, text=True)
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
            self.build(self.packages[:-1])

    def test_rejects_mislabeled_package(self):
        packages = [(v, a, self.packages[0][2] if a == 'arm64' else p) for v, a, p in self.packages]
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.build(packages)

    def test_rejects_wrong_signing_key(self):
        with self.assertRaisesRegex(ValueError, 'trust anchor'):
            repo.build(self.packages, self.site, '0' * 40, self.key)


if __name__ == '__main__':
    unittest.main()
