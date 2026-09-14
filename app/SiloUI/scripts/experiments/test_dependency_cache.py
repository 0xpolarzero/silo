import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

WRAPPER = Path(__file__).with_name('dependency-cache.py')
spec = importlib.util.spec_from_file_location('wrapper', WRAPPER)
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)


class BoundaryTests(unittest.TestCase):
    def test_only_reviewed_registry_library_is_eligible(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root)
            manifest = home / 'registry/src/index/itoa-1.0.18'
            manifest.mkdir(parents=True)
            source = manifest / 'src.rs'
            source.write_text('')
            env = dict(CARGO_HOME=root, CARGO_MANIFEST_DIR=str(manifest), CARGO_PKG_NAME='itoa', CARGO_PKG_VERSION='1.0.18')
            args = ['--crate-name', 'itoa', '--crate-type', 'lib', str(source)]
            self.assertTrue(wrapper.eligible(args, env))
            for change in ({'CARGO_PKG_NAME': 'silo-ui'}, {'CARGO_PKG_VERSION': '1.0.19'}, {'CARGO_MANIFEST_DIR': root}):
                self.assertFalse(wrapper.eligible(args, env | change))
            for change in (args + ['--test'], ['--crate-name', 'build_script_build', '--crate-type', 'bin', str(source)], []):
                self.assertFalse(wrapper.eligible(change, env))

    def test_cache_process_has_no_credentials_and_defaults_to_readonly(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            manifest = directory / 'registry/src/index/itoa-1.0.18'
            manifest.mkdir(parents=True)
            source = manifest / 'lib.rs'
            source.write_text('')
            cache = directory / 'sccache'
            cache.write_text("#!/usr/bin/env python3\nimport os,sys\nif sys.argv[1:] == ['--version']: print('sccache 0.12.0')\nelse:\n assert 'SILO_GITHUB_CLIENT_SECRET' not in os.environ\n assert 'APPLE_PASSWORD' not in os.environ\n assert 'SCCACHE_BUCKET' not in os.environ\n assert os.environ['SCCACHE_LOCAL_RW_MODE'] == 'READ_ONLY'\n assert os.environ['SCCACHE_CONF'] == os.devnull\n")
            cache.chmod(0o755)
            env = os.environ | dict(CARGO_HOME=root, CARGO_MANIFEST_DIR=str(manifest), CARGO_PKG_NAME='itoa', CARGO_PKG_VERSION='1.0.18', SILO_EXPERIMENT_SCCACHE=str(cache), SILO_EXPERIMENT_CACHE_DIR=str(directory / 'objects'), SILO_GITHUB_CLIENT_SECRET='synthetic', APPLE_PASSWORD='synthetic', SCCACHE_BUCKET='must-not-upload')
            subprocess.run(['python3', str(WRAPPER), '/nonexistent-rustc', '--crate-name', 'itoa', '--crate-type', 'lib', str(source)], env=env, check=True)

    def test_unknown_app_bypasses_cache_and_preserves_configuration(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            compiler = directory / 'rustc'
            compiler.write_text('#!/bin/sh\nprintf "%s" "$SILO_GITHUB_CLIENT_SECRET" > "$PROBE_OUTPUT"\n')
            compiler.chmod(0o755)
            output = directory / 'output'
            for sentinel in ('synthetic-one', 'synthetic-two'):
                env = os.environ | {'SILO_GITHUB_CLIENT_SECRET': sentinel, 'PROBE_OUTPUT': str(output), 'SILO_EXPERIMENT_SCCACHE': '/nonexistent', 'SILO_EXPERIMENT_CACHE_DIR': str(directory / 'cache')}
                subprocess.run(['python3', str(WRAPPER), str(compiler)], env=env, check=True)
                self.assertEqual(output.read_text(), sentinel)
            self.assertFalse((directory / 'cache').exists())


if __name__ == '__main__':
    unittest.main()
