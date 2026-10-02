"""Offline regressions for the live working-account proof's shell checks."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    'working_account_live', Path(__file__).with_name('test-working-account-live.py'))
LIVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LIVE)


class WorkingAccountShellTests(unittest.TestCase):
    def check_fetch(self, **overrides):
        with tempfile.TemporaryDirectory(prefix='silo-account-shell-') as directory:
            scripts = {
                'git': '''case "$2" in
FETCH_HEAD) printf '%s' "$FETCH_HASH"; exit "$FETCH_STATUS";;
HEAD) printf '%s' "$HEAD_HASH"; exit "$HEAD_STATUS";;
*) exit 99;;
esac
''',
                'find': 'printf "%s" "$WRONG_OWNER"; exit "$FIND_STATUS"\n',
            }
            for name, body in scripts.items():
                path = Path(directory) / name
                path.write_text('#!/bin/sh\n' + body)
                path.chmod(0o700)
            env = dict(os.environ, PATH=directory + ':/usr/bin:/bin',
                       FETCH_HASH='matching', HEAD_HASH='matching', WRONG_OWNER='',
                       FETCH_STATUS='0', HEAD_STATUS='0', FIND_STATUS='0')
            env.update(overrides)
            return subprocess.run(['/bin/sh', '-c', 'set -eu; ' + LIVE.VERIFY_FETCH_OWNERSHIP],
                                  env=env, capture_output=True, text=True)

    def test_failed_git_reads_are_rejected(self):
        for overrides in (
                {'FETCH_STATUS': '23', 'FETCH_HASH': 'matching'},
                {'HEAD_STATUS': '24', 'HEAD_HASH': 'matching'},
                {'FETCH_STATUS': '23', 'HEAD_STATUS': '24', 'FETCH_HASH': '', 'HEAD_HASH': ''}):
            with self.subTest(overrides=overrides):
                self.assertNotEqual(self.check_fetch(**overrides).returncode, 0)

    def test_failed_ownership_scan_is_rejected(self):
        self.assertEqual(self.check_fetch(FIND_STATUS='25').returncode, 25)

    def test_success_requires_matching_commits_and_ownership(self):
        self.assertEqual(self.check_fetch().returncode, 0)
        self.assertNotEqual(self.check_fetch(HEAD_HASH='different').returncode, 0)
        self.assertNotEqual(self.check_fetch(WRONG_OWNER='/workspace/git-remote.git/object').returncode, 0)


if __name__ == '__main__':
    unittest.main()
