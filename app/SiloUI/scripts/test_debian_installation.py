"""Root-only package lifecycle test. Run only in a disposable Linux container/runner."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).parent
SOURCE = Path('/etc/apt/sources.list.d/silo.sources')
MARKER = Path('/var/lib/silo/package-update-in-progress')


@unittest.skipUnless(os.environ.get('SILO_APT_LIFECYCLE_TEST') == '1' and os.geteuid() == 0, 'Explicit disposable root environment required')
class InstallerTests(unittest.TestCase):
    def test_install_opt_out_upgrade_and_running_process(self):
        self.assertFalse(Path('/usr/bin/silo-ui').exists(), 'Never run on an installed Silo host')
        env = {**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'}
        def run(*args, check=True, **kw):
            result = subprocess.run(args, env=env, capture_output=True, **kw)
            if check and result.returncode:
                self.fail(f'{args}: {result.stderr.decode()}')
            return result
        with tempfile.TemporaryDirectory() as tmp:
            packages = []
            for version in ('0.1.0', '0.2.0'):
                tree = Path(tmp, version)
                (tree / 'DEBIAN').mkdir(parents=True)
                (tree / 'usr/bin').mkdir(parents=True)
                (tree / 'DEBIAN/control').write_text(f'Package: silo\nVersion: {version}\nArchitecture: {subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip()}\nMaintainer: Test\nDescription: Disposable Silo lifecycle test\n')
                shutil.copyfile('/bin/sleep', tree / 'usr/bin/silo-ui')
                (tree / 'usr/bin/silo-ui').chmod(0o755)
                for name in ('msb', 'git', 'git-lfs', 'git-remote-http', 'git-remote-https'):
                    shutil.copy('/bin/true', tree / 'usr/bin' / name)
                package = Path(tmp, f'{version}.deb')
                run('dpkg-deb', '--build', str(tree), str(package))
                run('python3', str(SCRIPTS / 'package-debian-release.py'), str(package))
                packages.append(str(package))
            try:
                run('debconf-set-selections', input=b'silo silo/system-updates boolean false\n')
                run('dpkg', '-i', packages[0])
                self.assertFalse(SOURCE.exists())
                self.assertFalse(MARKER.exists())
                run('dpkg', '--purge', 'silo')
                run('debconf-set-selections', input=b'silo silo/system-updates boolean true\n')
                run('dpkg', '-i', packages[0])
                self.assertEqual(SOURCE.read_text(), (SCRIPTS / 'debian/silo.sources').read_text())
                process = subprocess.Popen(['/usr/bin/silo-ui', '60'])
                try:
                    result = run('dpkg', '-i', packages[1], check=False)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(b'Quit Silo', result.stderr)
                    self.assertIsNone(process.poll())
                    self.assertFalse(MARKER.exists())
                finally:
                    process.terminate(); process.wait()
                SOURCE.write_text(SOURCE.read_text() + 'Enabled: no\n')
                run('apt-get', '-y', 'install', packages[1])
                self.assertEqual(run('dpkg-query', '-W', '-f=${Version}', 'silo').stdout, b'0.2.0')
                self.assertIn('Enabled: no', SOURCE.read_text())
                self.assertFalse(MARKER.exists())
                run('dpkg', '--purge', 'silo')
                self.assertTrue(SOURCE.exists(), 'Preserve administrator changes')
                SOURCE.unlink()
                run('debconf-set-selections', input=b'silo silo/system-updates boolean true\n')
                run('dpkg', '-i', packages[0])
                SOURCE.unlink()
                run('dpkg', '-i', packages[1])
                self.assertFalse(SOURCE.exists(), 'Preserve a source disabled by deletion')
            finally:
                run('dpkg', '--purge', 'silo', check=False)
                SOURCE.unlink(missing_ok=True)
                MARKER.unlink(missing_ok=True)


if __name__ == '__main__':
    unittest.main()
