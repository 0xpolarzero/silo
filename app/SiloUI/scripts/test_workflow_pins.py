"""Every third-party action is pinned to a full commit SHA that Dependabot updates."""
from pathlib import Path
import re
import unittest

GITHUB = Path(__file__).resolve().parents[3] / '.github'
USES = re.compile(r'^\s*(?:-\s+)?uses:\s*(\S+)(.*)$', re.M)


class WorkflowPinTests(unittest.TestCase):
    def test_actions_are_pinned_to_commit_shas_with_version_comments(self):
        files = sorted([*GITHUB.glob('workflows/*.yml'), *GITHUB.glob('actions/*/action.yml')])
        self.assertTrue(files)
        checked = 0
        for path in files:
            for reference, rest in USES.findall(path.read_text()):
                if reference.startswith('./'):
                    continue  # Local actions and reusable workflows come from this checkout.
                checked += 1
                with self.subTest(file=path.name, action=reference):
                    self.assertRegex(reference, r'^[\w.-]+/[\w./-]+@[0-9a-f]{40}$')
                    self.assertRegex(rest, r'^\s+# v\d+(\.\d+)*$')
        self.assertGreater(checked, 0)

    def test_dependabot_updates_workflow_and_composite_actions(self):
        config = (GITHUB / 'dependabot.yml').read_text()
        self.assertIn('package-ecosystem: github-actions', config)
        for directory in ['/'] + [f'/.github/actions/{path.name}' for path in GITHUB.glob('actions/*')]:
            self.assertIn(f"'{directory}'", config)


if __name__ == '__main__':
    unittest.main()
