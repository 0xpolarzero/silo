"""Test package relocation at the dpkg-deb process boundary, without root access."""
import hashlib
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('package-debian-release.py')
TOOLS = ('msb', 'git', 'git-lfs', 'git-remote-http', 'git-remote-https')


class DebianReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.package = self.root / 'Silo.deb'
        self.package.write_bytes(b'original package')
        self.signature = self.root / 'Silo.deb.sig'
        self.signature.write_text('original signature')
        self.fixture = self.root / 'extracted'
        (self.fixture / 'usr/bin').mkdir(parents=True)
        (self.fixture / 'DEBIAN').mkdir()
        (self.fixture / 'DEBIAN/md5sums').write_text('obsolete paths')
        for name in ('silo-ui', *TOOLS):
            path = self.fixture / 'usr/bin' / name
            path.write_text(f'private {name}')
            path.chmod(0o755)
        self.built = False

    def dpkg(self, command, *, check):
        self.assertTrue(check)
        self.assertEqual(command[0], 'dpkg-deb')
        if command[1] == '--raw-extract':
            self.assertEqual(command[2], str(self.package))
            shutil.copytree(self.fixture, command[3])
        else:
            self.assertEqual(command[1:3], ['--root-owner-group', '--build'])
            tree = Path(command[3])
            self.assertEqual({path.name for path in (tree / 'usr/bin').iterdir()}, {'silo-ui'})
            for name in TOOLS:
                path = tree / 'usr/lib/Silo/bin' / name
                self.assertEqual(path.read_text(), f'private {name}')
                self.assertEqual(path.stat().st_mode & 0o777, 0o755)
            sums = (tree / 'DEBIAN/md5sums').read_text().splitlines()
            expected = []
            for path in sorted(tree.rglob('*')):
                if path.is_file() and 'DEBIAN' not in path.relative_to(tree).parts:
                    expected.append(f'{hashlib.md5(path.read_bytes()).hexdigest()}  {path.relative_to(tree)}')
            self.assertEqual(sums, expected)
            Path(command[4]).write_bytes(b'rebuilt private package')
            self.built = True
        return subprocess.CompletedProcess(command, 0)

    def run_package(self):
        with patch('sys.argv', [str(SCRIPT), str(self.package)]), \
                patch('subprocess.run', side_effect=self.dpkg):
            runpy.run_path(str(SCRIPT), run_name='__main__')

    def test_moves_private_tools_preserves_modes_and_rebuilds_checksums(self):
        self.run_package()
        self.assertTrue(self.built)
        self.assertEqual(self.package.read_bytes(), b'rebuilt private package')
        self.assertFalse(self.signature.exists())
        self.assertFalse(self.package.with_suffix('.rebuilt').exists())

    def test_missing_private_tool_leaves_original_package_and_signature_unchanged(self):
        (self.fixture / 'usr/bin/msb').unlink()
        with self.assertRaisesRegex(RuntimeError, 'Expected bundled executable msb'):
            self.run_package()
        self.assertFalse(self.built)
        self.assertEqual(self.package.read_bytes(), b'original package')
        self.assertEqual(self.signature.read_text(), 'original signature')

    def test_unrelated_global_command_is_rejected_without_replacing_package(self):
        (self.fixture / 'usr/bin/unrelated').write_text('must not ship')
        with self.assertRaisesRegex(RuntimeError, 'unrelated commands'):
            self.run_package()
        self.assertFalse(self.built)
        self.assertEqual(self.package.read_bytes(), b'original package')
        self.assertTrue(self.signature.exists())


if __name__ == '__main__':
    unittest.main()
