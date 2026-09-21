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
import json, os, pathlib, shutil, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
root = pathlib.Path(os.environ['RECIPE_ROOT'])
with (root / 'calls.jsonl').open('a') as output:
    output.write(json.dumps([name, args]) + '\n')
if name == 'id':
    print('silo' if '-gn' in args else '0')
elif name == 'dpkg':
    if '--print-architecture' in args:
        print('arm64')
elif name == 'dpkg-query':
    if 'greybird-gtk-theme' in args:
        if not (root / 'theme-installed').exists():
            sys.exit(1)
        print('install ok installed')
elif name == 'apt-get':
    if 'install' in args and 'greybird-gtk-theme' in args:
        (root / 'theme-installed').touch()
elif name == 'python3':
    if 'prepare-install' in args:
        print('silo ' + str(root / 'home/silo'))
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
        os_release = self.root / 'os-release'
        os_release.write_text('ID=ubuntu\nVERSION_ID=24.04\n')
        source = SOURCE.read_text().replace('/etc/os-release', str(os_release))
        # Rewrite only absolute guest roots, leaving shell logic unchanged. All
        # remaining mutating OS tools are explicit stubs above.
        for path in ('/var/lib/silo-desktop', '/usr/local', '/home/silo', '/run/silo-desktop'):
            source = source.replace(path, str(self.root) + path)
        self.recipe = self.root / 'recipe.sh'
        self.recipe.write_text(source)
        self.env = dict(os.environ, PATH=str(binaries) + ':/usr/bin:/bin',
                        RECIPE_ROOT=str(self.root),
                        SILO_DESKTOP_SERVICE_SOURCE=str(self.fixture / 'desktop-service.py'))

    def run_recipe(self, action='install'):
        result = subprocess.run(['/bin/sh', str(self.recipe), action], env=self.env,
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


if __name__ == '__main__':
    unittest.main()
