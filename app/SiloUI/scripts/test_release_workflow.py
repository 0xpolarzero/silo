"""Run the workflow's early release gate without building or contacting GitHub."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = (ROOT / '.github/workflows/release.yml').read_text()
GATE = textwrap.dedent(WORKFLOW.split('        run: |\n', 1)[1].split('\n  macos-minimum-constraints:', 1)[0])


class ReleaseWorkflowTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.app = self.root / 'app/SiloUI'
        (self.app / 'scripts').mkdir(parents=True)
        (self.app / 'src-tauri').mkdir()
        (self.app / '.changeset').mkdir()
        (self.app / '.changeset/README.md').write_text('Changeset instructions')
        shutil.copyfile(ROOT / 'app/SiloUI/scripts/validate-release-version.py', self.app / 'scripts/validate-release-version.py')
        (self.app / 'package.json').write_text(json.dumps({'version': '1.2.3'}))
        (self.app / 'package-lock.json').write_text(json.dumps({'version': '1.2.3', 'packages': {'': {'version': '1.2.3'}}}))
        (self.app / 'src-tauri/Cargo.toml').write_text('[package]\nversion = "1.2.3"\n')
        (self.app / 'src-tauri/Cargo.lock').write_text('[[package]]\nname = "silo-ui"\nversion = "1.2.3"\n')
        (self.root / 'docs/releases').mkdir(parents=True)
        self.notes = self.root / 'docs/releases/1.2.3.md'
        self.notes.write_text('User-facing release notes')
        self.output = self.root / 'output'

    def run_gate(self, *, draft=True, ref='refs/tags/v1.2.3'):
        return subprocess.run(['bash', '-c', GATE], cwd=self.root,
                              env={**os.environ, 'CREATE_DRAFT': str(draft).lower(),
                                   'RELEASE_REF': ref, 'GITHUB_OUTPUT': str(self.output)},
                              capture_output=True, text=True)

    def test_prepared_tag_produces_draft(self):
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.output.read_text(), 'draft=true\n')

    def test_branch_and_mismatched_tags_fail_before_build(self):
        for ref in ['refs/heads/main', 'refs/tags/v1.2.4', 'refs/tags/v1.2.3-rc.1']:
            with self.subTest(ref=ref):
                result = self.run_gate(ref=ref)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Release ref must be', result.stdout)

    def test_missing_and_empty_release_notes_block_draft(self):
        for contents in [None, '']:
            with self.subTest(contents=contents):
                if contents is None:
                    self.notes.unlink()
                else:
                    self.notes.write_text(contents)
                result = self.run_gate()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Missing release notes', result.stdout)

    def test_pending_changesets_block_draft(self):
        (self.app / '.changeset/new-feature.md').write_text('Pending note')
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Pending changeset', result.stdout)

    def test_version_mismatch_blocks_even_verification(self):
        (self.app / 'src-tauri/Cargo.toml').write_text('[package]\nversion = "1.2.2"\n')
        result = self.run_gate(draft=False, ref='refs/heads/main')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('versions must agree', result.stderr)

    def test_manual_verification_allows_unreleased_work(self):
        self.notes.unlink()
        (self.app / '.changeset/new-feature.md').write_text('Pending note')
        result = self.run_gate(draft=False, ref='refs/heads/main')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.output.read_text(), 'draft=false\n')


if __name__ == '__main__':
    unittest.main()
