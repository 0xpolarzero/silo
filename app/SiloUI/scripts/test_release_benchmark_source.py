"""Execute the workflow's source-validation boundary without checking out code."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = (ROOT / '.github/workflows/release.yml').read_text()
PLATFORM = (ROOT / '.github/workflows/release-platform.yml').read_text()
TRIGGER = 'a' * 40
SOURCE = 'b' * 40


class BenchmarkSourceTests(unittest.TestCase):
    def validate(self, source='', event='workflow_dispatch', draft='false'):
        step = WORKFLOW.split('      - name: Validate source revision before checkout\n', 1)[1].split('      - uses:', 1)[0]
        script = textwrap.dedent(step.split('        run: |\n', 1)[1])
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'output'
            result = subprocess.run(['bash', '-c', script], env=dict(os.environ,
                BENCHMARK_REF=source, EVENT_NAME=event, CREATE_DRAFT=draft,
                TRIGGER_SHA=TRIGGER, GITHUB_OUTPUT=str(output)), capture_output=True, text=True)
            return result, output.read_text() if output.exists() else ''

    def test_normal_dispatch_and_tag_draft_keep_trigger_commit(self):
        for event, draft in [('workflow_dispatch', 'false'), ('workflow_dispatch', 'true'), ('push', 'true')]:
            with self.subTest(event=event, draft=draft):
                result, output = self.validate(event=event, draft=draft)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(output, f'ref={TRIGGER}\n')

    def test_artifact_dispatch_accepts_only_full_hex_commit(self):
        for source in [SOURCE, 'ABCDEF0123' * 4]:
            with self.subTest(source=source):
                result, output = self.validate(source)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(output, f'ref={source}\n')

    def test_invalid_or_publish_override_fails_before_output(self):
        cases = [(source, 'workflow_dispatch', 'false') for source in
                 ['main', 'refs/tags/v1.0.0', 'b' * 7, 'b' * 41, 'g' * 40, SOURCE + '\n', SOURCE + '\nref=main']]
        cases += [(SOURCE, 'workflow_dispatch', 'true'), (SOURCE, 'push', 'true'), (SOURCE, 'push', 'false')]
        for source, event, draft in cases:
            with self.subTest(source=source, event=event, draft=draft):
                result, output = self.validate(source, event, draft)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(output, '')

    def test_all_checkout_jobs_use_validated_source(self):
        refs = re.findall(r'uses: actions/checkout@v4\n        with:\n          ref: (.+)', WORKFLOW)
        self.assertEqual(len(refs), WORKFLOW.count('uses: actions/checkout@'))
        self.assertEqual(refs, ['${{ steps.source.outputs.ref }}'] + ['${{ needs.validate.outputs.source-ref }}'] * 3)
        refs = re.findall(r'uses: actions/checkout@v4\n        with:\n          ref: (.+)', PLATFORM)
        self.assertEqual(refs, ['${{ inputs.source-ref }}'] * 3)
        self.assertEqual(len(refs), PLATFORM.count('uses: actions/checkout@'))
        self.assertIn('source-ref: ${{ needs.validate.outputs.source-ref }}', WORKFLOW)
        self.assertLess(WORKFLOW.index('Validate source revision before checkout'), WORKFLOW.index('uses: actions/checkout@'))

    def test_concurrency_separates_artifact_runs_and_preserves_production_group(self):
        self.assertIn("group: ${{ github.event_name == 'workflow_dispatch' && !inputs.draft && format('silo-release-benchmark-{0}', github.run_id) || 'silo-release-build' }}", WORKFLOW)
        self.assertIn('cancel-in-progress: false', WORKFLOW)


if __name__ == '__main__':
    unittest.main()
