import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

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


if __name__ == '__main__':
    unittest.main()
