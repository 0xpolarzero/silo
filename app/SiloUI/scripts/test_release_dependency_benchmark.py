import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('benchmark', Path(__file__).with_name('dependency-cache-benchmark.py'))
BENCHMARK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BENCHMARK)


class DependencyBenchmarkTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.archive = self.root / 'cache.tar.gz'

    def archive_member(self, name, kind=tarfile.REGTYPE):
        with tarfile.open(self.archive, 'w:gz') as archive:
            manifest = tarfile.TarInfo('manifest.json')
            manifest.size = 2
            archive.addfile(manifest, io.BytesIO(b'{}'))
            entry = tarfile.TarInfo(name)
            entry.type = kind
            entry.linkname = '../outside'
            if kind == tarfile.REGTYPE:
                entry.size = 1
                archive.addfile(entry, io.BytesIO(b'x'))
            else:
                archive.addfile(entry)
        return hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def test_transport_checks_digest_and_rejects_unsafe_members_before_writes(self):
        for index, (name, kind) in enumerate([
            ('../outside', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
            ('artifacts/link', tarfile.SYMTYPE), ('artifacts/link', tarfile.LNKTYPE),
            ('target/app', tarfile.REGTYPE), ('manifest.json', tarfile.REGTYPE),
        ]):
            with self.subTest(name=name, kind=kind):
                digest = self.archive_member(name, kind)
                destination = self.root / str(index)
                with self.assertRaises(ValueError):
                    BENCHMARK.extract(self.archive, destination, digest)
                self.assertFalse(destination.exists())
        digest = self.archive_member('artifacts/public.rlib')
        destination = self.root / 'digest'
        with self.assertRaisesRegex(ValueError, 'SHA256'):
            BENCHMARK.extract(self.archive, destination, '0' * 64)
        self.assertFalse(destination.exists())
        BENCHMARK.extract(self.archive, destination, digest)
        self.assertEqual((destination / 'artifacts/public.rlib').read_bytes(), b'x')

    def test_threshold_includes_transfer_and_records_rejection_without_raising(self):
        control, consumer, restored, output = [self.root / name for name in ['control', 'consumer', 'restore', 'result']]
        valid = dict(exitCode=0, appRecompiled=True, configurationVerified=True)
        control.write_text(json.dumps(dict(valid, compileSeconds=100)))
        consumer.write_text(json.dumps(dict(valid, compileSeconds=60)))
        args = argparse.Namespace(control=control, consumer=consumer, restore_report=restored, report=output, target='fixture')
        for transfer, accepted, expected in [(5, True, True), (20, True, False), (0, False, False)]:
            restored.write_text(json.dumps(dict(transferRestoreSeconds=transfer, accepted=accepted)))
            BENCHMARK.summarize(args)
            result = json.loads(output.read_text())
            self.assertEqual(result['eligibleAtThirtyPercent'], expected)
        consumer.write_text(json.dumps(dict(valid, compileSeconds=40, appRecompiled=False)))
        BENCHMARK.summarize(args)
        self.assertFalse(json.loads(output.read_text())['eligibleAtThirtyPercent'])

    def test_missing_build_report_is_ineligible_and_still_reported(self):
        args = argparse.Namespace(control=self.root / 'missing-control', consumer=self.root / 'missing-consumer',
            restore_report=self.root / 'missing-restore', report=self.root / 'result', target='fixture')
        BENCHMARK.summarize(args)
        self.assertFalse(json.loads(args.report.read_text())['eligibleAtThirtyPercent'])

    def test_restore_refuses_to_clean_any_other_target(self):
        protected = self.root / 'important'
        protected.mkdir()
        sentinel = protected / 'keep'
        sentinel.write_text('preserve')
        args = argparse.Namespace(app_root=self.root, target_dir=protected)
        with self.assertRaisesRegex(ValueError, 'dedicated'):
            BENCHMARK.restore(args)
        self.assertEqual(sentinel.read_text(), 'preserve')

    def test_build_accepts_non_object_json_tool_output_before_artifacts(self):
        metadata, messages, report = [self.root / name for name in ('metadata', 'messages', 'report')]
        metadata.write_text(json.dumps({'resolve': {'root': 'app'}, 'packages': []}))
        executable = self.root / 'fixture-app'
        executable.write_bytes(BENCHMARK.PRODUCER.encode())
        runner = self.root / 'node_modules/.bin/tauri'
        runner.parent.mkdir(parents=True)
        row = {'reason': 'compiler-artifact', 'package_id': 'app',
               'executable': str(executable), 'fresh': False}
        noise = b'null\n[]\n"tool output"\n42\ntrue\nbad\xff\n'
        runner.write_text(f'#!{sys.executable}\nimport sys\n'
                          f'sys.stdout.buffer.write({noise!r})\nprint({json.dumps(row)!r})\n')
        runner.chmod(0o755)
        args = argparse.Namespace(app_root=self.root, metadata=metadata, messages=messages,
                                  report=report, role='producer', target='fixture')
        stdout = io.StringIO()
        with (patch.dict(os.environ, {'CARGO_TARGET_DIR': str(self.root / 'src-tauri/target/release-compile')}),
              patch.object(BENCHMARK.sys, 'stdout', stdout)):
            self.assertEqual(BENCHMARK.build(args), 0)
        self.assertTrue(stdout.getvalue().startswith(noise.decode('utf-8', errors='replace')))
        self.assertEqual(messages.read_text(), json.dumps(row) + '\n')
        self.assertTrue(json.loads(report.read_text())['configurationVerified'])

    @unittest.skipUnless(os.name == 'posix', 'POSIX signal exit status')
    def test_build_cli_preserves_signal_in_report_and_maps_shell_exit_status(self):
        metadata, messages, report = [self.root / name for name in ('metadata', 'messages', 'report')]
        metadata.write_text(json.dumps({'resolve': {'root': 'app'}, 'packages': []}))
        runner = self.root / 'node_modules/.bin/tauri'
        runner.parent.mkdir(parents=True)
        runner.write_text(f'#!{sys.executable}\nimport signal\nsignal.raise_signal(signal.SIGTERM)\n')
        runner.chmod(0o755)
        result = subprocess.run([sys.executable, BENCHMARK.__file__, 'build',
                                 '--app-root', str(self.root), '--metadata', str(metadata),
                                 '--messages', str(messages), '--report', str(report),
                                 '--target', 'fixture', '--role', 'producer'],
                                env=dict(os.environ, CARGO_TARGET_DIR=str(self.root / 'src-tauri/target/release-compile')),
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 128 + signal.SIGTERM, result.stderr)
        self.assertEqual(json.loads(report.read_text())['exitCode'], -signal.SIGTERM)

    def test_output_failure_stops_and_reaps_the_owned_benchmark_command(self):
        class FailedOutput(io.StringIO):
            def write(self, _text):
                raise OSError('fixture output failure')

        metadata = self.root / 'metadata'
        metadata.write_text(json.dumps({'resolve': {'root': 'app'}, 'packages': []}))
        runner = self.root / 'node_modules/.bin/tauri'
        runner.parent.mkdir(parents=True)
        row = json.dumps({'reason': 'compiler-artifact'})
        runner.write_text(f'#!{sys.executable}\nimport time\nprint({row!r}, flush=True)\ntime.sleep(30)\n')
        runner.chmod(0o755)
        args = argparse.Namespace(app_root=self.root, metadata=metadata, messages=self.root / 'messages',
                                  report=self.root / 'report', role='producer', target='fixture')
        popen, original_open = subprocess.Popen, Path.open
        for failed in ('stdout', 'messages'):
            children = []

            def spawn(command, **kwargs):
                process = popen(command, **kwargs)
                children.append(process)
                return process

            def open_messages(path, *arguments, **kwargs):
                return FailedOutput() if path == args.messages else original_open(path, *arguments, **kwargs)

            destination = (patch.object(BENCHMARK.sys, 'stdout', FailedOutput()) if failed == 'stdout'
                           else patch.object(Path, 'open', open_messages))
            try:
                with self.subTest(destination=failed), \
                        patch.dict(os.environ, CARGO_TARGET_DIR=str(self.root / 'src-tauri/target/release-compile')), \
                        patch.object(BENCHMARK.subprocess, 'Popen', side_effect=spawn), destination:
                    with self.assertRaisesRegex(OSError, 'fixture output failure'):
                        BENCHMARK.build(args)
                    self.assertIsNotNone(children[0].returncode, 'benchmark command was abandoned')
                    with self.assertRaises(ChildProcessError):
                        os.waitpid(children[0].pid, os.WNOHANG)
            finally:
                for child in children:
                    if child.poll() is None:
                        child.terminate()
                        child.wait(timeout=3)
                    if child.stdout:
                        child.stdout.close()


if __name__ == '__main__':
    unittest.main()
