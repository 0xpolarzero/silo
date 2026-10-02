"""Workflow action pins and literal handling of reusable shell inputs."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest

GITHUB = Path(__file__).resolve().parents[3] / '.github'
USES = re.compile(r'^\s*(?:-\s+)?uses:\s*(\S+)(.*)$', re.M)


class WorkflowPinTests(unittest.TestCase):
    def test_qemu_installer_images_are_pinned_to_digests(self):
        checked = 0
        for path in GITHUB.glob('workflows/*.yml'):
            steps = re.split(r'^\s{6}- ', path.read_text(), flags=re.M)
            for step in steps:
                if not re.search(r'^uses: docker/setup-qemu-action@', step):
                    continue
                checked += 1
                with self.subTest(file=path.name):
                    self.assertRegex(step, r'(?m)^\s+image: docker\.io/tonistiigi/binfmt@sha256:[0-9a-f]{64}\s*$')
        self.assertGreater(checked, 0)

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

    def test_checkout_does_not_persist_repository_credentials(self):
        checked = 0
        for path in GITHUB.glob('workflows/*.yml'):
            for step in re.split(r'^ {6}- ', path.read_text(), flags=re.M):
                if not re.search(r'(?:^|\n +)uses: actions/checkout@', step):
                    continue
                checked += 1
                with self.subTest(file=path.name):
                    self.assertRegex(step, r'(?m)^ {10}persist-credentials: false$')
        self.assertGreater(checked, 0)

    def test_dependabot_updates_workflow_and_composite_actions(self):
        config = (GITHUB / 'dependabot.yml').read_text()
        self.assertIn('package-ecosystem: github-actions', config)
        for directory in ['/'] + [f'/.github/actions/{path.name}' for path in GITHUB.glob('actions/*')]:
            self.assertIn(f"'{directory}'", config)


class WorkflowConcurrencyTests(unittest.TestCase):
    def test_verification_supersedes_only_the_same_pull_request(self):
        for name in ['linux-verification.yml', 'release-tooling.yml']:
            with self.subTest(workflow=name):
                workflow = (GITHUB / 'workflows' / name).read_text()
                concurrency = re.search(r'(?m)^concurrency:\n((?: +[^\n]*\n)+)', workflow)
                self.assertIsNotNone(concurrency, 'obsolete PR checks run without a concurrency limit')
                config = concurrency[1]
                group = re.search(r'(?m)^ +group: (.+)$', config)[1]
                self.assertIn('github.workflow', group)
                self.assertRegex(group, r"github.event_name == 'pull_request' && github.ref \|\| github.run_id")
                cancel = re.search(r'(?m)^ +cancel-in-progress: (.+)$', config)[1]
                self.assertEqual(cancel, "${{ github.event_name == 'pull_request' }}")


class WorkflowInputTests(unittest.TestCase):
    def test_linux_collection_preserves_globs_and_asset_names(self):
        workflow = (GITHUB / 'workflows/release-platform.yml').read_text()
        step = workflow.split('      - name: Collect and verify Linux assets\n', 1)[1]
        command = textwrap.dedent(step.split('        run: |\n', 1)[1].split('      - name:', 1)[0])
        for target, asset in [
            ('x86_64-unknown-linux-gnu', 'linux-x64'),
            ('aarch64-unknown-linux-gnu', 'linux-arm64'),
            ("x'; touch injected; #", "linux-x64'; touch injected; #"),
        ]:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                tools = root / 'tools'
                tools.mkdir()
                for name in ['python3', 'dpkg-deb']:
                    executable = tools / name
                    executable.write_text('#!/bin/sh\nexit 0\n')
                    executable.chmod(0o755)
                bundle = root / 'src-tauri/target/release-compile' / target / 'release/bundle'
                (bundle / 'deb').mkdir(parents=True)
                (bundle / 'appimage').mkdir()
                (bundle / 'deb/Silo.deb').write_text('debian fixture')
                (bundle / 'appimage/Silo.AppImage.sig').write_text('signature fixture')
                (bundle / 'appimage/Silo.AppImage').write_text(
                    '#!/bin/sh\nmkdir -p squashfs-root/usr/bin\ntouch squashfs-root/usr/bin/silo-ui\nchmod +x squashfs-root/usr/bin/silo-ui\n')
                # Render old expressions as Actions would, and bind the new environment.
                script = command.replace('${{ inputs.target }}', target).replace('${{ inputs.asset }}', asset)
                result = subprocess.run(['bash', '-e', '-c', script], cwd=root, env={
                    **os.environ, 'PATH': str(tools) + os.pathsep + os.environ['PATH'],
                    'RUNTIME_TARGET': target, 'RELEASE_ASSET': asset,
                }, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse((root / 'injected').exists())
                self.assertEqual(sorted(path.name for path in (root / 'release-assets').iterdir()),
                                 sorted(f'Silo-{asset}{suffix}' for suffix in ['.deb', '.AppImage', '.AppImage.sig']))
                self.assertEqual((root / f'release-assets/Silo-{asset}.deb').read_text(), 'debian fixture')
                self.assertEqual((root / f'release-assets/Silo-{asset}.AppImage.sig').read_text(), 'signature fixture')

    def test_reusable_target_is_a_literal_command_argument(self):
        cases = [
            ('actions/prepare-release-runtime/action.yml', 'Warm application dependency downloads', 'cargo',
             ['fetch', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--target']),
            ('workflows/release-platform.yml', 'Resolve public dependency identity before test signing configuration', 'python3',
             ['scripts/release-dependency-cache.py', 'prepare', '--target']),
            ('workflows/benchmark-dependency-platform.yml', 'Measure cold production compilation with synthetic configuration', 'python3',
             ['scripts/dependency-cache-benchmark.py', 'build', '--role', 'producer', '--target']),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            arguments = root / 'arguments.json'
            marker = root / 'injected'
            for filename, name, executable, prefix in cases:
                workflow = (GITHUB / filename).read_text()
                step = re.search(r'(?m)^( +)- name: ' + re.escape(name) + r'\n', workflow)
                self.assertIsNotNone(step, name)
                indent = len(step[1])
                body = re.split(r'(?m)^ {' + str(indent) + r'}- ', workflow[step.end():], maxsplit=1)[0]
                command = re.search(r'(?m)^ +run: (.+)$', body)[1]
                self.assertNotEqual(command, '|')
                fake = root / executable
                fake.write_text(f'#!{sys.executable}\nimport json, os, sys\nfrom pathlib import Path\nPath(os.environ["ARGUMENTS"]).write_text(json.dumps(sys.argv[1:]))\n')
                fake.chmod(0o755)
                if filename.startswith('actions/'):
                    environment = body
                else:
                    job_prefix = re.split(r'(?m)^  [\w-]+:\n', workflow[:step.start()])[-1]
                    environment = job_prefix.split('    steps:', 1)[0]
                binding = re.search(r'(?m)^ +RUNTIME_TARGET: (.+)$', environment)
                for target in ['x86_64-unknown-linux-gnu', f"x'; touch {marker}; #", f'$(touch {marker})']:
                    with self.subTest(file=filename, target=target):
                        marker.unlink(missing_ok=True)
                        # Model Actions expression expansion before Bash parses the script.
                        script = command.replace('${{ inputs.target }}', target)
                        result = subprocess.run(['bash', '-e', '-c', script], cwd=root, env={
                            **os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH'],
                            'ARGUMENTS': str(arguments),
                            'RUNTIME_TARGET': binding[1].replace('${{ inputs.target }}', target) if binding else '',
                            'RUNNER_TEMP': str(root), 'GITHUB_OUTPUT': str(root / 'output'),
                        }, capture_output=True, text=True)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertFalse(marker.exists(), 'input executed a shell command')
                        actual = json.loads(arguments.read_text())
                        self.assertEqual(actual[:len(prefix) + 1], [*prefix, target])



if __name__ == '__main__':
    unittest.main()
