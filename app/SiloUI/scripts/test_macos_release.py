"""Exercise the release signing gate against real disposable macOS signatures."""
from pathlib import Path
import importlib.util
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('verify-macos-signing.py')
TOOLS = ('silo-ui', 'msb', 'git', 'git-lfs', 'git-remote-http', 'git-remote-https')


@unittest.skipUnless(sys.platform == 'darwin', 'Requires macOS codesign and clang')
class MacOSReleaseSigningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='silo-release-signing-')
        cls.root = Path(cls.temporary.name)
        source = cls.root / 'main.c'
        source.write_text('int main(void){return 0;}')
        cls.run_command('clang', '-arch', 'arm64', source, '-o', cls.root / 'executable')
        source.write_text('int value(void){return 7;}')
        cls.run_command('clang', '-arch', 'arm64', '-dynamiclib', source, '-o', cls.root / 'engine.dylib')
        source.write_text('int value(void){return 9;}')
        cls.run_command('clang', '-arch', 'arm64', '-dynamiclib', source, '-o', cls.root / 'replacement.dylib')

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    @staticmethod
    def run_command(*args):
        return subprocess.run(list(map(str, args)), capture_output=True, check=True)

    def setUp(self):
        self.case = Path(tempfile.mkdtemp(dir=self.root))
        self.app = self.case / 'Silo.app'
        self.binaries = self.app / 'Contents/MacOS'
        self.frameworks = self.app / 'Contents/Frameworks'
        self.binaries.mkdir(parents=True)
        self.frameworks.mkdir()
        (self.app / 'Contents/Info.plist').write_bytes(plistlib.dumps({
            'CFBundleExecutable': 'silo-ui', 'CFBundleIdentifier': 'org.silo.test',
            'CFBundleName': 'Silo', 'CFBundlePackageType': 'APPL',
            'CFBundleVersion': '1', 'CFBundleShortVersionString': '0.1.1',
            'LSMinimumSystemVersion': '14.0',
        }))
        for name in TOOLS:
            shutil.copy2(self.root / 'executable', self.binaries / name)
            self.sign(self.binaries / name)
        self.engine = self.frameworks / 'libkrunfw.5.dylib'
        shutil.copy2(self.root / 'engine.dylib', self.engine)
        self.sign(self.engine)
        output = self.run_command('codesign', '-d', '--verbose=4', self.engine).stderr
        self.digest = bytes.fromhex(re.search(rb'^CDHash=(\w+)$', output, re.M)[1].decode())
        self.sign_helper({'cdhash': self.digest})
        self.seal()

    def sign(self, target, *, entitlements=None, constraint=None, hardened=True):
        args = ['codesign', '--force', '--sign', '-']
        if hardened:
            args += ['--options', 'runtime']
        if entitlements is not None:
            path = self.case / 'entitlements.plist'
            path.write_bytes(plistlib.dumps(entitlements))
            args += ['--entitlements', path]
        if constraint is not None:
            path = self.case / 'constraint.plist'
            path.write_bytes(plistlib.dumps(constraint))
            args += ['--enforce-constraint-validity', '--library-constraint', path]
        self.run_command(*args, target)

    def sign_helper(self, constraint):
        self.sign(self.binaries / 'msb', entitlements={
            'com.apple.security.hypervisor': True,
            'com.apple.security.cs.disable-library-validation': True,
        }, constraint=constraint)

    def seal(self):
        self.sign(self.app, entitlements={
            'com.apple.security.hypervisor': True,
            'com.apple.security.automation.apple-events': True,
        })

    def verify(self, expected):
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.app)], capture_output=True, text=True)
        if expected:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, 'Unsafe bundle passed signing gate')

    def test_exact_constraint_accepted(self):
        self.verify(True)

    def test_broad_exception_without_constraint_rejected(self):
        self.sign_helper(None)
        self.seal()
        self.verify(False)

    def test_additional_permitted_library_rejected(self):
        self.sign_helper({'cdhash': {'$in': [self.digest, bytes(20)]}})
        self.seal()
        self.verify(False)

    def test_signed_replacement_engine_rejected(self):
        replacement = self.case / 'swapped.dylib'
        shutil.copy2(self.root / 'replacement.dylib', replacement)
        self.sign(replacement)
        replacement.replace(self.engine)
        self.seal()
        self.verify(False)

    def test_git_library_exception_rejected(self):
        self.sign(self.binaries / 'git', entitlements={'com.apple.security.cs.disable-library-validation': True})
        self.seal()
        self.verify(False)

    def test_non_hardened_helper_rejected(self):
        self.sign(self.binaries / 'git', hardened=False)
        self.seal()
        self.verify(False)

    def test_tampered_engine_rejected(self):
        data = bytearray(self.engine.read_bytes())
        data[4096] ^= 1
        self.engine.write_bytes(data)
        self.verify(False)


class MacOSReleaseSignerEnvironmentTests(unittest.TestCase):
    def run_packager(self, file_key):
        with tempfile.TemporaryDirectory(prefix='silo-signer-env-') as temporary:
            root = Path(temporary)
            app = root / 'Silo.app'
            (app / 'Contents/MacOS').mkdir(parents=True)
            (app / 'Contents/MacOS/msb').write_bytes(b'fixture runtime')
            key = 'disposable-inline-fixture'
            if file_key:
                key_file = root / 'fixture.key'
                key_file.write_text('disposable-key-fixture')
                key = str(key_file)
            script = SCRIPT.with_name('package-macos-release.py')
            with patch.object(sys, 'path', [str(script.parent), *sys.path]):
                spec = importlib.util.spec_from_file_location('package_macos_release_test', script)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            invocations = []

            def command(args, **kwargs):
                invocations.append((args, kwargs))
                return subprocess.CompletedProcess(args, 0)

            environment = {'TAURI_SIGNING_PRIVATE_KEY': key,
                           'TAURI_SIGNING_PRIVATE_KEY_PATH': 'stale-path',
                           'TAURI_SIGNING_PRIVATE_KEY_PASSWORD': ''}
            with patch.dict(os.environ, environment), \
                    patch.object(sys, 'argv', [str(script), str(app), str(root / 'output')]), \
                    patch.object(module, 'sign_runtime'), patch.object(module, 'verify_bundle'), \
                    patch.object(module.subprocess, 'run', side_effect=command):
                module.main()
            signer = [(args, kwargs) for args, kwargs in invocations if args[0] == 'npx']
            self.assertEqual(len(signer), 1)
            args, kwargs = signer[0]
            self.assertNotIn('TAURI_SIGNING_PRIVATE_KEY_PATH', kwargs['env'])
            if file_key:
                self.assertEqual(args[args.index('-f') + 1], key)
                self.assertNotIn('TAURI_SIGNING_PRIVATE_KEY', kwargs['env'])
            else:
                self.assertNotIn('-f', args)
                self.assertEqual(kwargs['env']['TAURI_SIGNING_PRIVATE_KEY'], key)
                self.assertNotIn(key, args)

    def test_file_key_removes_conflicting_inline_environment(self):
        self.run_packager(file_key=True)

    def test_inline_key_remains_in_environment_only(self):
        self.run_packager(file_key=False)


if __name__ == '__main__':
    unittest.main()
