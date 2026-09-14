"""Protect the release cache boundary using representative filesystem contents."""
from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
ACTION = (ROOT / '.github/actions/prepare-release-runtime/action.yml').read_text()
WORKFLOW = (ROOT / '.github/workflows/release.yml').read_text()
PLATFORM = (ROOT / '.github/workflows/release-platform.yml').read_text()


class ReleaseCacheTests(unittest.TestCase):
    def test_ci_installs_the_manifest_toolchain(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / 'app/SiloUI/runtime-inputs.json'
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({'toolchain': '9.8.7'}))
            commands = root / 'bin'
            commands.mkdir()
            (commands / 'node').symlink_to(shutil.which('node'))
            rustup = commands / 'rustup'
            rustup.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$SILO_TOOLCHAIN_LOG"\n')
            rustup.chmod(0o755)
            log = root / 'calls'
            env = dict(os.environ, PATH=str(commands), GITHUB_WORKSPACE=str(root), SILO_TOOLCHAIN_LOG=str(log))
            for name in ['release-platform.yml', 'warm-release-caches.yml', 'linux-verification.yml']:
                workflow = (ROOT / '.github/workflows' / name).read_text()
                blocks = re.findall(r'          runtime_toolchain=.*\n          rustup toolchain install .*\n          rustup default .*', workflow)
                self.assertEqual(len(blocks), 3 if name == 'release-platform.yml' else 1)
                for block in blocks:
                    log.unlink(missing_ok=True)
                    subprocess.run(['/bin/bash', '-eu', '-c', block], env=env, check=True, capture_output=True)
                    self.assertEqual(log.read_text().splitlines(), ['toolchain install 9.8.7 --profile minimal', 'default 9.8.7'])
            self.assertIn('-rust${{ steps.runtime-inputs.outputs.toolchain }}-', ACTION)
            output = root / 'github-output'
            env['GITHUB_OUTPUT'] = str(output)
            preflight_block = re.search(r'      run: \|\n((?:        .+\n)+)', ACTION).group(1)
            subprocess.run(['/bin/bash', '-eu', '-c', preflight_block], cwd=ROOT, env=env, check=True, capture_output=True)
            approved = json.loads((ROOT / 'app/SiloUI/runtime-inputs.json').read_text())
            self.assertEqual(output.read_text(), f"toolchain={approved['toolchain']}\n")

    def test_cache_allowlist_excludes_compiled_application_and_build_work(self):
        blocks = re.findall(r'        path: \|\n((?:          .+\n)+)', ACTION)
        paths = [block.split() for block in blocks]
        self.assertEqual(len(paths), 4)
        self.assertEqual(paths[0], paths[2], 'Runtime restore/save paths must match')
        self.assertEqual(paths[1], paths[3], 'Cargo restore/save paths must match')
        runtime = 'app/SiloUI/src-tauri/target/runtime-cache/'
        allowed = [runtime + 'v0.6.17/patched-builds/key/msb',
                   runtime + 'v0.6.17/patched-builds/key/msb.sha256',
                   runtime + 'v0.6.17/msb-linux.tar.gz',
                   runtime + 'v0.6.17/licenses/LICENSE',
                   runtime + 'dugite/version/archive.tar.gz',
                   'app/SiloUI/src-tauri/runtime/guest-image/image.tar.gz',
                   '.cargo/registry/cache/index/crate.tar.gz']
        forbidden = [runtime + 'v0.6.17/patched-builds/key/cargo-target/release/msb',
                     runtime + 'v0.6.17/patched-builds/key/work/source.rs',
                     'app/SiloUI/src-tauri/target/release/silo-ui',
                     'app/SiloUI/src-tauri/target/debug/build/silo/output',
                     'app/SiloUI/github-build.local.json',
                     '.cargo/credentials.toml', '.cargo/config.toml']
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in allowed + forbidden:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture')
            selected = set()
            for pattern in paths[0] + paths[1]:
                for match in root.glob(pattern.removeprefix('~/')):
                    selected.update([match] if match.is_file() else match.rglob('*'))
            for name in allowed:
                self.assertIn(root / name, selected)
            for name in forbidden:
                self.assertNotIn(root / name, selected)

    def test_preflight_precedes_runtime_downloads(self):
        self.assertLess(ACTION.index('node app/SiloUI/scripts/preflight.mjs'), ACTION.index('actions/cache/restore'))
        self.assertIn("'app/SiloUI/runtime-inputs.json'", ACTION)
        self.assertIn('restore-keys: silo-runtime-v1-', ACTION)
        validate = WORKFLOW.split('\n  validate:', 1)[1].split('\n  macos-minimum-constraints:', 1)[0]
        self.assertIn('node app/SiloUI/scripts/preflight.mjs', validate)

    def test_shared_frontend_checks_gate_publication(self):
        frontend = WORKFLOW.split('\n  frontend:', 1)[1].split('\n  platforms:', 1)[0]
        build = PLATFORM.split('\n  build:', 1)[1]
        for command in ['npm test --', 'npm run lint', 'npm run test:release']:
            self.assertIn(command, frontend)
            self.assertNotIn(command, build)
        self.assertIn('npm run typecheck', frontend)
        self.assertIn('needs: [validate, frontend, platforms, macos-minimum-constraints]', WORKFLOW)
        native = PLATFORM.split('\n  native-tests:', 1)[1].split('\n  build:', 1)[0]
        self.assertIn('cargo test --manifest-path', native)
        self.assertIn('Test updater transport and interrupted installation', native)
        self.assertNotIn('secrets.', native)
        self.assertNotIn('TAURI_SIGNING_PRIVATE_KEY', native)
        self.assertIn("inputs.benchmark-schedule != 'sequential'", native)
        self.assertIn("if: inputs.benchmark-schedule == 'sequential'", build)
        self.assertIn('path: ${{ runner.temp }}/build-phases.jsonl', native)
        self.assertNotIn('path: app/SiloUI/src-tauri/target', native)
        self.assertIn("test_*release*.py", build)
        self.assertIn('Test updater transport and interrupted installation', build)


if __name__ == '__main__':
    unittest.main()
