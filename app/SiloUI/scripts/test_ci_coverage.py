"""CI test selection must include new ordinary suites and platform-specific tests."""
import json
import os
import re
import shlex
import tomllib
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
APP = ROOT / 'app/SiloUI'


class ReleaseDiscoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        package = json.loads((APP / 'package.json').read_text())
        self.command = package['scripts']['test:release']
        (self.root / 'package.json').write_text(json.dumps({'scripts': {'test:release': self.command}}))
        # Existing explicit entries must remain valid so the regression reaches discovery.
        for source in (APP / 'scripts').glob('*.test.mjs'):
            path = self.root / 'scripts' / source.name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("import test from 'node:test'; test('existing fixture', () => {});\n")
        for filename in ['new-ci-suite.test.mjs', 'nested/new-ci-suite.test.mjs']:
            path = self.root / 'scripts' / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("import test from 'node:test'; import {writeFileSync} from 'node:fs';\n"
                            "test('new CI suite', () => {writeFileSync(new URL('./picked-up', import.meta.url), 'yes');"
                            "if (process.env.FAIL_DISCOVERY) throw new Error('new suite failed');});\n")

    def run_script(self, *, fail=False):
        environment = dict(os.environ)
        environment.pop('FAIL_DISCOVERY', None)
        if fail:
            environment['FAIL_DISCOVERY'] = '1'
        return subprocess.run(['npm', 'run', '--silent', 'test:release'], cwd=self.root,
                              env=environment, capture_output=True, text=True)

    def test_new_release_suites_are_discovered(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for marker in ['scripts/picked-up', 'scripts/nested/picked-up']:
            self.assertTrue((self.root / marker).exists(), marker)

    def test_new_release_suite_failure_fails_the_command(self):
        result = self.run_script(fail=True)
        self.assertNotEqual(result.returncode, 0, 'the newly added failing suites were ignored')
        self.assertIn('new suite failed', result.stdout + result.stderr)


class CargoCoverageTests(unittest.TestCase):
    def test_ci_selects_local_patched_packages_with_unit_tests(self):
        manifest = tomllib.loads((APP / 'src-tauri/Cargo.toml').read_text())
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        selected = set()
        for command in re.findall(r'(?m)^ +(?:- )?run: (cargo test .+)$', workflow):
            arguments = shlex.split(command)
            self.assertIn('--locked', arguments)
            if '-p' in arguments:
                selected.add(arguments[arguments.index('-p') + 1])
            else:
                selected.add(manifest['package']['name'])
        self.assertIn(manifest['package']['name'], selected)
        for name, patch in manifest['patch']['crates-io'].items():
            directory = APP / 'src-tauri' / patch['path']
            if any('#[test]' in source.read_text() for source in directory.rglob('*.rs')):
                with self.subTest(package=name):
                    self.assertIn(name, selected, 'dependency unit tests are not run by root cargo test')


if __name__ == '__main__':
    unittest.main()
