"""Protect the release cache boundary using representative filesystem contents."""
from pathlib import Path
import re
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
ACTION = (ROOT / '.github/actions/prepare-release-runtime/action.yml').read_text()
WORKFLOW = (ROOT / '.github/workflows/release.yml').read_text()


class ReleaseCacheTests(unittest.TestCase):
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

    def test_shared_frontend_checks_gate_publication(self):
        frontend = WORKFLOW.split('\n  frontend:', 1)[1].split('\n  build:', 1)[0]
        build = WORKFLOW.split('\n  build:', 1)[1].split('\n  draft:', 1)[0]
        for command in ['npm test --', 'npm run lint', 'npm run test:release']:
            self.assertIn(command, frontend)
            self.assertNotIn(command, build)
        self.assertIn('npm run typecheck', frontend)
        self.assertIn('needs: [validate, frontend, build, macos-minimum-constraints]', WORKFLOW)
        self.assertIn('cargo test --manifest-path', build)
        self.assertIn("test_*release*.py", build)
        self.assertIn('Test updater transport and interrupted installation', build)


if __name__ == '__main__':
    unittest.main()
