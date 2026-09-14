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
    def test_in_app_upgrade_refreshes_stale_apt_and_preserves_unrelated_processes(self):
        from test_apt_repository import RepositoryTests, repo
        self.assertFalse(Path('/usr/bin/silo-ui').exists(), 'Never run on an installed Silo host')
        fixture = RepositoryTests('test_signed_repository_selects_newest_version')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        env = {**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'}
        def run(*args, check=True, **kwargs):
            result = subprocess.run(args, env=env, capture_output=True, **kwargs)
            if check and result.returncode:
                self.fail(f'{args}: {result.stdout.decode()} {result.stderr.decode()}')
            return result
        arch = run('dpkg', '--print-architecture').stdout.decode().strip()
        for version, target, package in fixture.packages:
            tree = fixture.root / f'{version}-{target}'
            (tree / 'usr/bin').mkdir(parents=True)
            for name in ('silo-ui', 'msb', 'git', 'git-lfs', 'git-remote-http', 'git-remote-https'):
                shutil.copy('/bin/sleep' if name == 'silo-ui' else '/bin/true', tree / 'usr/bin' / name)
            run('dpkg-deb', '--build', str(tree), str(package))
            run('python3', str(SCRIPTS / 'package-debian-release.py'), str(package))
        old = [item for item in fixture.packages if item[0] == '0.1.0']
        repo.build(old, fixture.site, fixture.fingerprint, fixture.key)
        published = fixture.root / 'published'
        published.symlink_to(fixture.site, target_is_directory=True)
        from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
        from functools import partial
        from threading import Thread
        class Handler(SimpleHTTPRequestHandler):
            def do_GET(self):
                # Both publications can occur within the filesystem's timestamp
                # resolution; the fixture must serve its newly signed bytes.
                if 'If-Modified-Since' in self.headers:
                    del self.headers['If-Modified-Since']
                super().do_GET()
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(fixture.root)))
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        source = f'Types: deb\nURIs: http://127.0.0.1:{server.server_port}/published/apt\nSuites: stable\nComponents: main\nSigned-By: {fixture.key}\n'
        process = None
        try:
            package = next(path for version, target, path in old if target == arch)
            run('dpkg', '-i', str(package))
            SOURCE.write_text(source)
            run('apt-get', '-o', f'Dir::Etc::sourcelist={SOURCE}', '-o', 'Dir::Etc::sourceparts=-', '-o', 'APT::Get::List-Cleanup=0', 'update')
            self.assertIn(b'Candidate: 0.1.0', run('apt-cache', 'policy', 'silo').stdout)
            new_site = fixture.root / 'new-site'
            repo.build(fixture.packages, new_site, fixture.fingerprint, fixture.key)
            published.unlink(); published.symlink_to(new_site, target_is_directory=True)
            # No apt refresh here: reproduce the exact reported stale candidate.
            self.assertIn(b'Candidate: 0.1.0', run('apt-cache', 'policy', 'silo').stdout)
            process = subprocess.Popen(['/usr/bin/silo-ui', '600'], user=65534)
            env['PKEXEC_UID'] = '65534'
            # A second, uncoordinated Silo instance must still block installation.
            other = subprocess.Popen(['/usr/bin/silo-ui', '600'], user=65534)
            try:
                result = run('/usr/lib/silo/silo-system-update', str(process.pid), '0.2.0', check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'Quit Silo', result.stderr)
                self.assertIsNone(other.poll())
                self.assertIsNone(process.poll())
            finally:
                other.terminate(); other.wait()
            result = run('/usr/lib/silo/silo-system-update', str(process.pid), '0.2.0')
            self.assertEqual(result.stdout.decode().splitlines(), ['refreshing', 'downloading', 'installing'])
            self.assertEqual(run('dpkg-query', '-W', '-f=${Version}', 'silo').stdout, b'0.2.0')
            self.assertIsNone(process.poll(), 'The updater never kills the UI')
            self.assertFalse(Path('/run/silo/system-update.json').exists())
            self.assertFalse(MARKER.exists())
            # An already updated package only needs the older running app to restart.
            self.assertEqual(run('/usr/lib/silo/silo-system-update', str(process.pid), '0.2.0').stdout, b'')
            self.assertNotEqual(run('/usr/lib/silo/silo-system-update', str(process.pid), '0.1.0', check=False).returncode, 0)
        finally:
            if process is not None:
                process.terminate(); process.wait()
            run('dpkg', '--purge', 'silo', check=False)
            SOURCE.unlink(missing_ok=True)
            MARKER.unlink(missing_ok=True)

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
