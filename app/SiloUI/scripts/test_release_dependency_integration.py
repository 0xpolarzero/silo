import argparse
import importlib.util
import json
import io
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

SPEC = importlib.util.spec_from_file_location('release_deps', Path(__file__).with_name('release-dependency-cache.py'))
DEPS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEPS)


class ReleaseDependencyIntegrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.app = Path(temporary.name)
        self.state = self.app / 'state'
        self.state.mkdir()
        self.args = argparse.Namespace(app_root=self.app, state=self.state, target='example-target')

    def test_miss_runs_no_importer(self):
        with patch.object(DEPS.subprocess, 'run') as run:
            DEPS.restore(self.args)
        run.assert_not_called()

    def test_rejected_cache_clears_only_dedicated_compile_products(self):
        target, _ = DEPS.paths(self.app)
        target.mkdir(parents=True)
        (target / 'partial').write_text('partial')
        runtime = target.parent / 'runtime-cache'
        runtime.mkdir()
        (runtime / 'keep').write_text('verified')
        (self.state / 'cache').mkdir()
        (self.state / 'cache/manifest.json').write_text('{}')
        with patch.object(DEPS.subprocess, 'run', return_value=argparse.Namespace(returncode=1)):
            DEPS.restore(self.args)
        self.assertFalse(target.exists())
        self.assertEqual((runtime / 'keep').read_text(), 'verified')

    def test_export_refuses_non_main_and_real_configuration_before_subprocess(self):
        for ref, secret in [('refs/tags/v1', 'SILO-CACHE-PRODUCER-CONFIG-SENTINEL'), ('refs/heads/main', 'real')]:
            with self.subTest(ref=ref), patch.dict(os.environ, {'GITHUB_REF': ref, 'SILO_GITHUB_CLIENT_SECRET': secret}), patch.object(DEPS.subprocess, 'run') as run:
                with self.assertRaises(ValueError):
                    DEPS.export(self.args)
                run.assert_not_called()

    def test_build_preserves_failure_and_rejects_reused_application(self):
        (self.state / 'metadata.json').write_text(json.dumps({'resolve': {'root': 'app'}}))
        for code, fresh, expected in [(19, False, 19), (0, True, None), (0, False, 0)]:
            row = {'reason': 'compiler-artifact', 'package_id': 'app', 'executable': '/unused', 'fresh': fresh}
            process = MagicMock(stdout=io.StringIO(json.dumps(row) + '\n'))
            process.__enter__.return_value = process
            process.wait.return_value = code
            with self.subTest(code=code, fresh=fresh), patch.object(DEPS.subprocess, 'Popen', return_value=process):
                if expected is None:
                    with self.assertRaises(ValueError):
                        DEPS.build(self.args)
                else:
                    self.assertEqual(DEPS.build(self.args), expected)

    def test_failed_compiler_streams_rendered_diagnostics_and_retains_inventory(self):
        (self.state / 'metadata.json').write_text(json.dumps({'resolve': {'root': 'app'}}))
        diagnostic = {'reason': 'compiler-message', 'message': {'rendered': 'error[E0308]: mismatched types\n'}}
        process = MagicMock(stdout=io.StringIO(json.dumps(diagnostic) + '\n'))
        process.__enter__.return_value = process
        process.wait.return_value = 101
        stderr = io.StringIO()
        with patch.object(DEPS.subprocess, 'Popen', return_value=process), patch.object(DEPS.sys, 'stderr', stderr):
            self.assertEqual(DEPS.build(self.args), 101)
        self.assertEqual(stderr.getvalue(), diagnostic['message']['rendered'])
        self.assertEqual(json.loads((self.state / 'messages.jsonl').read_text()), diagnostic)

    def test_build_treats_non_object_json_as_tool_output_and_preserves_exit_status(self):
        (self.state / 'metadata.json').write_text(json.dumps({'resolve': {'root': 'app'}}))
        runner = self.app / 'node_modules/.bin/tauri'
        runner.parent.mkdir(parents=True)
        row = {'reason': 'compiler-artifact', 'package_id': 'app',
               'executable': '/unused', 'fresh': False}
        noise = b'null\n[]\n"tool output"\n42\ntrue\nbad\xff\n'
        for code in (0, 19):
            with self.subTest(code=code):
                runner.write_text(f'#!{sys.executable}\nimport sys\n'
                                  f'sys.stdout.buffer.write({noise!r})\n'
                                  f'print({json.dumps(row)!r})\nsys.exit({code})\n')
                runner.chmod(0o755)
                stdout = io.StringIO()
                with patch.object(DEPS.sys, 'stdout', stdout):
                    self.assertEqual(DEPS.build(self.args), code)
                self.assertTrue(stdout.getvalue().startswith(noise.decode('utf-8', errors='replace')))
                self.assertEqual((self.state / 'messages.jsonl').read_text(), json.dumps(row) + '\n')

    @unittest.skipUnless(os.name == 'posix', 'POSIX signal exit status')
    def test_build_cli_reports_signal_termination_as_a_shell_exit_status(self):
        (self.state / 'metadata.json').write_text(json.dumps({'resolve': {'root': 'app'}}))
        runner = self.app / 'node_modules/.bin/tauri'
        runner.parent.mkdir(parents=True)
        runner.write_text(f'#!{sys.executable}\nimport signal\nsignal.raise_signal(signal.SIGTERM)\n')
        runner.chmod(0o755)
        result = subprocess.run([sys.executable, DEPS.__file__, 'build',
                                 '--app-root', str(self.app), '--state', str(self.state),
                                 '--target', 'fixture'], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 128 + signal.SIGTERM, result.stderr)

    def test_workflow_reader_writer_and_signing_order(self):
        root = Path(__file__).resolve().parents[3]
        release = (root / '.github/workflows/release-platform.yml').read_text()
        warmer = (root / '.github/workflows/warm-release-caches.yml').read_text()
        self.assertLess(release.index('Resolve public dependency identity'), release.index('Generate isolated test signing key'))
        self.assertNotIn('actions/cache/save', release)
        self.assertNotIn('src-tauri/target/${{ inputs.target }}/release/bundle', release)
        self.assertIn('lookup-only: true', warmer)
        self.assertIn("github.ref == 'refs/heads/main' && steps.dependency-cache", warmer)
        self.assertNotIn('secrets.', warmer)


if __name__ == '__main__':
    unittest.main()
