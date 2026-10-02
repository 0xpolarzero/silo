"""Run APT signing setup with synthetic keys and fake signing tools."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = (ROOT / '.github/workflows/apt-repository.yml').read_text()
STEP = WORKFLOW.split('      - name: Sign update repository\n', 1)[1].split('\n      - name:', 1)[0]
SIGN = textwrap.dedent(STEP.split('        run: |\n', 1)[1])
STALE_STEP = WORKFLOW.split('      - name: Reject stale publication\n', 1)[1].split('\n      - uses:', 1)[0]
STALE = textwrap.dedent(STALE_STEP.split('        run: |\n', 1)[1])


class AptSigningShellTests(unittest.TestCase):
    def run_signing(self, *, fail_mktemp=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            log = root / 'calls.jsonl'
            home = root / 'signing home'
            stub = f'''#!{sys.executable}
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
with open(os.environ['SIGNING_LOG'], 'a') as output:
    output.write(json.dumps([name, sys.argv[1:], os.environ.get('GNUPGHOME')]) + '\\n')
if name == 'mktemp':
    if os.environ.get('FAIL_MKTEMP'):
        sys.exit(23)
    print(os.environ['SIGNING_HOME'])
elif name == 'gpg':
    sys.stdin.read()
elif name == 'cat':
    print('A' * 40)
'''
            for name in ('mktemp', 'gpg', 'python3', 'cat', 'rm'):
                executable = root / name
                executable.write_text(stub)
                executable.chmod(0o755)
            environment = {**os.environ, 'PATH': f'{root}:/usr/bin:/bin',
                           'SILO_APT_SIGNING_KEY': 'synthetic signing key', 'PAGES_URL': 'https://example.invalid',
                           'SIGNING_HOME': str(home), 'SIGNING_LOG': str(log)}
            if fail_mktemp:
                environment['FAIL_MKTEMP'] = '1'
            result = subprocess.run(['/bin/bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', SIGN],
                                    env=environment, text=True, capture_output=True)
            return result, [json.loads(line) for line in log.read_text().splitlines()], home

    def test_failed_private_directory_creation_stops_before_key_import(self):
        result, calls, _ = self.run_signing(fail_mktemp=True)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual([call[0] for call in calls], ['mktemp'])

    def test_signing_and_cleanup_use_the_private_directory(self):
        result, calls, home = self.run_signing()
        self.assertEqual(result.returncode, 0, result.stderr)
        for call in calls:
            if call[0] in ('gpg', 'python3'):
                self.assertEqual(call[2], str(home))
        self.assertEqual(calls[-1][:2], ['rm', ['-rf', str(home)]])


class AptPublicationGateShellTests(unittest.TestCase):
    def run_gate(self, *, local=None, remote=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, value in (('cat', local), ('gh', remote)):
                executable = root / name
                body = 'exit 23' if value is None else f"printf '%s\\n' '{value}'"
                executable.write_text('#!/bin/sh\n' + body + '\n')
                executable.chmod(0o755)
            return subprocess.run(['/bin/bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', STALE],
                                  env={**os.environ, 'PATH': str(root), 'GH_REPO': 'test/repository'},
                                  text=True, capture_output=True)

    def test_missing_local_and_remote_versions_cannot_authorize_publication(self):
        result = self.run_gate()
        self.assertEqual(result.returncode, 23, result.stderr)

    def test_publication_requires_matching_successfully_read_versions(self):
        for local, remote, expected in [('v0.10.0', 'v0.10.0', 0), ('v0.10.0', 'v0.11.0', 1),
                                        ('v0.10.0', None, 23), (None, 'v0.10.0', 23)]:
            with self.subTest(local=local, remote=remote):
                result = self.run_gate(local=local, remote=remote)
                self.assertEqual(result.returncode, expected, result.stderr)


if __name__ == '__main__':
    unittest.main()
