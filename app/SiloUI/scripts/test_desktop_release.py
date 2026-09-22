"""Local desktop build routing and failure propagation, without compiling Tauri."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from build_desktop import build


class DesktopBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='silo-desktop-build-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.calls = []
        self.target = self.root / 'separate cargo output'

    def command(self, args, **kwargs):
        self.calls.append((args, kwargs))
        output = json.dumps({'target_directory': str(self.target)}) if args[0] == 'cargo' else ''
        return subprocess.CompletedProcess(args, 0, output)

    def test_local_app_is_finalized_and_verified_in_cargos_actual_output(self):
        args = ['--target', 'aarch64-apple-darwin',
                '--config', '{"bundle":{"createUpdaterArtifacts":true}}']
        with patch('build_desktop.sign_runtime') as sign, patch('build_desktop.verify_bundle') as verify:
            result = build(args, root=self.root, platform='darwin', run=self.command)
        expected = self.target / 'aarch64-apple-darwin/release/bundle/macos/Silo.app'
        self.assertEqual(result, expected)
        sign.assert_called_once_with(expected)
        verify.assert_called_once_with(expected)
        command = self.calls[-1][0]
        self.assertIn('--bundles', command)
        self.assertEqual(command[-2], '--config')
        self.assertEqual(json.loads(command[-1])['bundle'], {
            'active': True, 'createUpdaterArtifacts': False, 'macOS': {'hardenedRuntime': True},
        })

    def test_failed_compilation_never_signs_a_stale_bundle(self):
        def fail(args, **kwargs):
            if args[0] == 'node':
                raise subprocess.CalledProcessError(7, args)
            return self.command(args, **kwargs)
        with patch('build_desktop.sign_runtime') as sign, patch('build_desktop.verify_bundle') as verify:
            with self.assertRaises(subprocess.CalledProcessError):
                build([], root=self.root, platform='darwin', run=fail)
        sign.assert_not_called()
        verify.assert_not_called()

    def test_signature_or_policy_failure_fails_the_build(self):
        for failing in ('sign_runtime', 'verify_bundle'):
            with self.subTest(failing=failing), patch('build_desktop.sign_runtime'), \
                    patch('build_desktop.verify_bundle'), \
                    patch(f'build_desktop.{failing}', side_effect=RuntimeError('bad signature')):
                with self.assertRaisesRegex(RuntimeError, 'bad signature'):
                    build([], root=self.root, platform='darwin', run=self.command)

    def test_debug_unbundled_help_and_other_platforms_pass_through(self):
        cases = [('darwin', ['--debug']), ('darwin', ['-d']), ('darwin', ['--no-bundle', '--ci']),
                 ('darwin', ['--help']), ('darwin', ['--version']), ('linux', ['--bundles', 'deb', 'appimage']),
                 ('darwin', ['--target', 'aarch64-unknown-linux-gnu', '--bundles', 'deb'])]
        for platform, args in cases:
            self.calls.clear()
            with self.subTest(platform=platform, args=args), patch('build_desktop.sign_runtime') as sign:
                self.assertIsNone(build(args, root=self.root, platform=platform, run=self.command))
                self.assertEqual(len(self.calls), 1)
                self.assertEqual(self.calls[0][0][3:], args)
                sign.assert_not_called()

    def test_distribution_artifacts_cannot_be_made_before_finalization(self):
        for args in (['--bundles', 'dmg'], ['--bundles=all'], ['-b', 'app', 'dmg'],
                     ['--target', 'universal-apple-darwin'], ['--', '--target-dir', 'elsewhere']):
            with self.subTest(args=args), self.assertRaises(ValueError):
                build(args, root=self.root, platform='darwin', run=self.command)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
