"""Exercise GNOME shell setup without starting a desktop or native app."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SOURCE = Path(__file__).with_name('test-linux-gnome.sh')


class GnomeShellSetupTests(unittest.TestCase):
    def run_setup(self, *, fail_mktemp=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            commands = root / 'bin'
            commands.mkdir()
            session = root / 'session with spaces'
            log = root / 'calls.jsonl'
            stub = f'''#!{sys.executable}
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
with open(os.environ['SETUP_LOG'], 'a') as output:
    output.write(json.dumps([name, sys.argv[1:], dict(os.environ)]) + '\\n')
if name == 'mktemp':
    if os.environ.get('FAIL_MKTEMP'):
        sys.exit(23)
    print(os.environ['SETUP_SESSION'])
'''
            for name in ('mktemp', 'mkdir', 'chmod', 'xvfb-run', 'rm'):
                executable = commands / name
                executable.write_text(stub)
                executable.chmod(0o755)
            environment = {**os.environ, 'HOME': str(root), 'PATH': f'{commands}:/usr/bin:/bin',
                           'SETUP_LOG': str(log), 'SETUP_SESSION': str(session)}
            if fail_mktemp:
                environment['FAIL_MKTEMP'] = '1'
            result = subprocess.run(['/bin/sh', str(SOURCE.resolve())], env=environment,
                                    text=True, capture_output=True)
            return result, [json.loads(line) for line in log.read_text().splitlines()], session

    def test_failed_session_directory_creation_stops_before_setup(self):
        result, calls, _ = self.run_setup(fail_mktemp=True)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual([call[0] for call in calls], ['mktemp'])

    def test_session_paths_with_spaces_reach_the_desktop_as_single_values(self):
        result, calls, session = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        desktop = next(call for call in calls if call[0] == 'xvfb-run')
        for key, suffix in (('XDG_RUNTIME_DIR', 'run'), ('XDG_CONFIG_HOME', 'config'),
                            ('XDG_DATA_HOME', 'data'), ('XDG_CACHE_HOME', 'cache')):
            self.assertEqual(desktop[2][key], str(session / suffix))
        self.assertEqual(desktop[2]['SILO_DESKTOP_SESSION'], str(session))


if __name__ == '__main__':
    unittest.main()
