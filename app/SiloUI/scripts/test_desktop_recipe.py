"""Execute the guest desktop recipe in a temporary filesystem with fake OS tools.

These tests never install software, start a desktop, or modify host guest paths.
The shell's real branching and generated session script remain under test.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'src-tauri/guest/setup-desktop.sh'

# Package/account operations are boundaries of the shell recipe. Record each one
# and simulate only the filesystem effects later recipe steps depend on.
STUB = r'''
import json, os, pathlib, shutil, subprocess, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
root = pathlib.Path(os.environ['RECIPE_ROOT'])
with (root / 'calls.jsonl').open('a') as output:
    output.write(json.dumps([name, args]) + '\n')
if name == 'id':
    print('silo' if '-gn' in args else '0')
elif name == 'dpkg':
    if '--print-architecture' in args:
        print(os.environ.get('DPKG_ARCH', 'arm64'))
elif name == 'dpkg-query':
    if 'greybird-gtk-theme' in args:
        if not (root / 'theme-installed').exists():
            sys.exit(1)
        print('install ok installed')
elif name == 'apt-get':
    if 'install' in args and 'greybird-gtk-theme' in args:
        (root / 'theme-installed').touch()
    if 'install' in args and any('selkies.deb' in arg for arg in args):
        if os.environ.get('SELKIES_INSTALL_FAIL'):
            sys.exit(31)
        binary = pathlib.Path(os.environ['SELKIES_BINARY'])
        binary.parent.mkdir(parents=True, exist_ok=True)
        binary.write_text('#!/bin/sh\nexit 0\n')
        binary.chmod(0o755)
elif name == 'python3':
    if args and args[0].endswith('/patch-selkies-web-client.py'):
        if os.environ.get('SELKIES_PATCH_FAIL'):
            sys.exit(32)
    if args and args[0] in ('-', '-c'):
        source = sys.stdin.read() if args[0] == '-' else args[1]
        if args[0] == '-' and not any(marker in source for marker in
                                      ('SILO_STREAMER_LOCK_V1', 'SILO_STREAMER_RECEIPT_V1',
                                       'SILO_DESKTOP_CONNECTION_V1')):
            sys.exit('unexpected Python recipe helper')
        result = subprocess.run([sys.executable, *args], input=source if args[0] == '-' else None,
                                 text=True, capture_output=True, env=os.environ)
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        sys.exit(result.returncode)
    elif args and args[0].endswith('/desktop-service.py') and args[1:] == ['prepare-install']:
        print('silo ' + str(root / 'home/silo'))
    elif args and args[0].endswith('/desktop-service.py') and args[1:] == ['status']:
        print(json.dumps({
            'state': os.environ.get('LEGACY_STATE', 'stopped'),
            'sessionState': os.environ.get('SESSION_STATE', 'stopped'),
            'streamState': os.environ.get('STREAM_STATE', 'stopped'),
        }))
    elif args and args[0].endswith('/silo-setup-luda.py') and os.environ.get('LUDA_FAIL'):
        sys.exit(23)
elif name == 'install':
    if '-d' in args:
        pathlib.Path(args[-1]).mkdir(parents=True, exist_ok=True)
    else:
        destination = pathlib.Path(args[-1])
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args[-2], destination)
        destination.chmod(int(args[args.index('-m') + 1], 8))
elif name == 'curl':
    pathlib.Path(args[args.index('-o') + 1]).touch()
elif name == 'sha256sum':
    supplied = sys.stdin.read().split()
    if supplied and supplied[0] != os.environ.get('EXPECTED_STREAMER_SHA'):
        sys.exit('unexpected streamer package digest')
elif name == 'df':
    print('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/test 9999999 0 9999999 0% /')
'''


class DesktopRecipe(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='silo-desktop-recipe-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        binaries = self.root / 'bin'
        binaries.mkdir()
        stub = '#!' + sys.executable + '\n' + STUB
        for name in ('id', 'dpkg', 'dpkg-query', 'apt-get', 'python3', 'install',
                     'curl', 'sha256sum', 'usermod', 'chown', 'flock', 'df'):
            path = binaries / name
            path.write_text(stub)
            path.chmod(0o755)
        self.state = self.root / 'var/lib/silo-desktop'
        self.state.mkdir(parents=True)
        self.home = self.root / 'home/silo'
        (self.home / '.vnc').mkdir(parents=True)
        self.fixture = self.root / 'sources'
        self.fixture.mkdir()
        (self.fixture / 'desktop-service.py').write_text(stub)
        (self.fixture / 'setup-luda.py').write_text('# fixture installer\n')
        (self.fixture / 'luda-lock.json').write_text('{"version":"test"}\n')
        (self.fixture / 'patch-selkies-web-client.py').write_text('# fixture patcher\n')
        streamer_lock = (SOURCE.parent / 'desktop-streamer-lock.json').read_text()
        (self.fixture / 'desktop-streamer-lock.json').write_text(streamer_lock)
        os_release = self.root / 'os-release'
        os_release.write_text('ID=ubuntu\nVERSION_ID=24.04\n')
        source = SOURCE.read_text().replace('/etc/os-release', str(os_release))
        # Rewrite only absolute guest roots, leaving shell logic unchanged. All
        # remaining mutating OS tools are explicit stubs above.
        for path in ('/var/lib/silo-desktop', '/usr/local', '/home/silo', '/run/silo-desktop'):
            source = source.replace(path, str(self.root) + path)
        source = source.replace('/usr/bin/selkies', str(self.root / 'usr/bin/selkies'))
        self.recipe = self.root / 'recipe.sh'
        self.recipe.write_text(source)
        self.env = dict(os.environ, PATH=str(binaries) + ':/usr/bin:/bin',
                        RECIPE_ROOT=str(self.root),
                        SILO_DESKTOP_SERVICE_SOURCE=str(self.fixture / 'desktop-service.py'),
                        SILO_SELKIES_WEB_CLIENT_PATCH_SOURCE=str(self.fixture / 'patch-selkies-web-client.py'),
                        SELKIES_BINARY=str(self.root / 'usr/bin/selkies'),
                        EXPECTED_STREAMER_SHA='3900f3ba805898c495829629092553cc1cf4d5a864ffc4056f57d21646ad45e4')

    def run_recipe(self, action='install', env=None):
        result = subprocess.run(['/bin/sh', str(self.recipe), action], env=dict(self.env, **(env or {})),
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]

    def assert_session_identity(self):
        session = self.home / '.vnc/xstartup'
        self.assertTrue(os.access(session, os.X_OK))
        # Run the generated script, replacing only its final desktop launch with
        # observation of the environment delivered to that launch.
        script = session.read_text().replace('exec dbus-run-session -- xfce4-session',
                                             'printf "%s" "$XDG_CURRENT_DESKTOP"')
        result = subprocess.run(['/bin/sh', '-c', script], env={'PATH': '/usr/bin:/bin'},
                                text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'XFCE')

    def test_fresh_desktop_installs_theme_and_launches_identified_session(self):
        calls = self.run_recipe()
        self.assertTrue((self.root / 'theme-installed').exists())
        self.assert_session_identity()
        self.assertIn(['silo-desktop', ['boot']], calls)
        receipt_path = self.state / 'streamer.json'
        self.assertEqual(receipt_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(receipt_path.read_text()), {
            'schemaVersion': 1, 'state': 'ready', 'backend': 'selkies',
            'version': '2.0.0', 'recipeVersion': 2, 'architecture': 'arm64',
            'packageSha256': self.env['EXPECTED_STREAMER_SHA'],
            'resolution': {'width': 1440, 'height': 900},
        })
        curl = next(args for name, args in calls if name == 'curl')
        self.assertIn('https://github.com/selkies-project/selkies/releases/download/2.0.0/selkies-2.0.0-ubuntu24.04-arm64.deb', curl)
        apt = [args for name, args in calls if name == 'apt-get']
        self.assertTrue(any('xvfb' in args and 'pulseaudio' in args for args in apt))
        self.assertFalse(any('kasmvncserver_noble' in arg or 'kasmvnc.deb' in arg
                             for args in apt + [curl] for arg in args))
        patch_call = ['python3', [str(self.fixture / 'patch-selkies-web-client.py'), 'arm64']]
        self.assertIn(patch_call, calls)
        package_install = next(i for i, (name, args) in enumerate(calls)
                               if name == 'apt-get' and any('selkies.deb' in arg for arg in args))
        self.assertLess(package_install, calls.index(patch_call))
        connection_path = self.state / 'connection.json'
        self.assertEqual(connection_path.stat().st_mode & 0o777, 0o600)
        connection = json.loads(connection_path.read_text())
        self.assertEqual(connection['username'], 'silo')
        self.assertEqual(connection['port'], 6901)
        self.assertRegex(connection['password'], r'^[0-9a-f]{64}$')

    def test_fresh_desktop_provisions_luda_before_starting(self):
        calls = self.run_recipe()
        install = ['python3', [str(self.root / 'usr/local/libexec/silo-setup-luda.py')]]
        self.assertEqual(calls.count(install), 1)
        self.assertLess(calls.index(install), calls.index(['silo-desktop', ['boot']]))

    def test_fresh_desktop_selects_amd64_streamer_asset_and_receipt(self):
        digest = 'bbaa4d71012b9374a753b7dfddc1da07e31f34b04277fe4fb3d045f18fd88391'
        calls = self.run_recipe(env={'DPKG_ARCH': 'amd64', 'EXPECTED_STREAMER_SHA': digest})
        curl = next(args for name, args in calls if name == 'curl')
        self.assertIn('https://github.com/selkies-project/selkies/releases/download/2.0.0/selkies-2.0.0-ubuntu24.04-amd64.deb', curl)
        receipt = json.loads((self.state / 'streamer.json').read_text())
        self.assertEqual(receipt['architecture'], 'amd64')
        self.assertEqual(receipt['recipeVersion'], 2)
        self.assertEqual(receipt['packageSha256'], digest)
        self.assertIn(['python3', [str(self.fixture / 'patch-selkies-web-client.py'), 'amd64']], calls)

    def test_luda_failure_fails_installation_and_retry_preserves_desktop(self):
        result = subprocess.run(['/bin/sh', str(self.recipe), 'install'],
                                env=dict(self.env, LUDA_FAIL='1'),
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 23, result.stdout + result.stderr)
        calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
        self.assertNotIn(['silo-desktop', ['boot']], calls)
        self.assertTrue((self.state / 'installed.json').exists())
        (self.root / 'calls.jsonl').unlink()
        calls = self.run_recipe()
        self.assertIn(['python3', [str(self.root / 'usr/local/libexec/silo-setup-luda.py')]], calls)
        self.assertFalse(any(name in ('curl', 'apt-get') for name, _ in calls))
        self.assertFalse(any(name == 'silo-desktop' and args in (['boot'], ['stop'])
                             for name, args in calls))

    def test_existing_desktop_install_and_repair_upgrade_session_and_theme(self):
        (self.state / 'installed.json').write_text('{"version":"1"}')
        for action in ('install', 'setup-tools'):
            with self.subTest(action=action):
                (self.home / '.vnc/xstartup').write_text('#!/bin/sh\nexec xfce4-session\n')
                (self.root / 'theme-installed').unlink(missing_ok=True)
                (self.root / 'calls.jsonl').unlink(missing_ok=True)
                calls = self.run_recipe(action)
                self.assertTrue((self.root / 'theme-installed').exists())
                self.assert_session_identity()
                self.assertFalse(any(name == 'curl' for name, _ in calls), 'Do not reinstall VNC')
                self.assertFalse((self.state / 'streamer.json').exists(),
                                 'Ordinary setup preserves the legacy Kasm backend')
                self.assertFalse(any(name == 'silo-desktop' and args in (['boot'], ['stop'])
                                     for name, args in calls), 'Preserve the running desktop')
                installers = [args for name, args in calls if name == 'python3'
                              and args[0].endswith('/silo-setup-luda.py')]
                self.assertEqual(len(installers), 1)
                self.assertEqual('--repair' in installers[0], action == 'setup-tools')
                # Repeating setup on an upgraded desktop needs no package network.
                (self.root / 'calls.jsonl').unlink()
                calls = self.run_recipe(action)
                self.assertFalse(any(name == 'apt-get' for name, _ in calls))

    def test_update_streamer_requires_stopped_desktop_even_when_stream_failed(self):
        (self.state / 'installed.json').write_text('{"version":"1"}')
        result = subprocess.run(['/bin/sh', str(self.recipe), 'update-streamer'],
                                env=dict(self.env, SESSION_STATE='running',
                                         LEGACY_STATE='failed', STREAM_STATE='failed'),
                                text=True, capture_output=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Stop the desktop before updating its streamer', result.stderr)
        self.assertFalse((self.state / 'streamer.json').exists())
        self.assertFalse((self.root / 'usr/local/bin/silo-desktop').exists())
        calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
        self.assertFalse(any(name in ('curl', 'apt-get') for name, _ in calls))

    def test_update_streamer_writes_receipt_after_pinned_install_without_restarting_desktop(self):
        (self.state / 'installed.json').write_text('{"version":"1"}')
        connection = {'username': 'silo', 'password': 'a' * 64, 'port': 6901}
        connection_path = self.state / 'connection.json'
        connection_path.write_text(json.dumps(connection))
        connection_path.chmod(0o600)
        calls = self.run_recipe('update-streamer')
        receipt = json.loads((self.state / 'streamer.json').read_text())
        self.assertEqual(receipt['backend'], 'selkies')
        self.assertEqual(receipt['recipeVersion'], 2)
        self.assertEqual(receipt['packageSha256'], self.env['EXPECTED_STREAMER_SHA'])
        self.assertEqual((self.state / 'streamer.json').stat().st_mode & 0o777, 0o600)
        self.assertTrue(any(name == 'apt-get' and any('selkies.deb' in arg for arg in args)
                            for name, args in calls))
        self.assertIn(['python3', [str(self.fixture / 'patch-selkies-web-client.py'), 'arm64']], calls)
        installed_helper = self.root / 'usr/local/bin/silo-desktop'
        self.assertEqual(installed_helper.read_text(), (self.fixture / 'desktop-service.py').read_text())
        self.assertEqual(installed_helper.stat().st_mode & 0o777, 0o755)
        self.assertFalse(any(name == 'silo-desktop' and args in (['boot'], ['start'], ['stop'], ['restart'])
                             for name, args in calls))
        self.assertEqual(json.loads(connection_path.read_text()), connection)

    def test_failed_selkies_package_install_does_not_write_receipt(self):
        (self.state / 'installed.json').write_text('{"version":"1"}')
        connection = {'username': 'silo', 'password': 'a' * 64, 'port': 6901}
        connection_path = self.state / 'connection.json'
        connection_path.write_text(json.dumps(connection))
        connection_path.chmod(0o600)
        old_receipt = {'schemaVersion': 1, 'state': 'ready', 'backend': 'selkies',
                       'version': '2.0.0', 'recipeVersion': 1, 'architecture': 'arm64',
                       'packageSha256': self.env['EXPECTED_STREAMER_SHA'],
                       'resolution': {'width': 1440, 'height': 900}}
        receipt_path = self.state / 'streamer.json'
        receipt_path.write_text(json.dumps(old_receipt))
        result = subprocess.run(['/bin/sh', str(self.recipe), 'update-streamer'],
                                env=dict(self.env, SELKIES_PATCH_FAIL='1'),
                                text=True, capture_output=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(receipt_path.read_text()), old_receipt)
        self.assertFalse((self.root / 'usr/local/bin/silo-desktop').exists())


if __name__ == '__main__':
    unittest.main()
