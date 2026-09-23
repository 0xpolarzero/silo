"""A new qualification run must not change an earlier workspace or verdict."""
import json
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import qualification
from runtime import Desktops
import server

spec = importlib.util.spec_from_file_location('reset_failed_test', Path(__file__).with_name('reset-failed-test.py'))
reset_failed_test = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reset_failed_test)


class RunIsolationTests(unittest.TestCase):
    def test_fresh_run_uses_only_newly_created_desktops_and_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / 'evidence'
            evidence.mkdir()
            historical = evidence / 'qualification.json'
            historical.write_text('{"status":"passed","desktops":["incident"]}')
            calls = []

            def api(path, data=None):
                calls.append((path, data))
                if path == 'desktops':
                    return {'id': f'run-owned-{len(calls)}'}
                raise AssertionError(f'Unexpected API operation: {path}')

            def check(name, fn):
                qualification.REPORT['checks'].append({'name': name, 'status': 'pass'})

            run_id = 'a' * 32
            with patch.object(qualification, 'HERE', root), \
                 patch.object(qualification, 'EVIDENCE'), \
                 patch.object(qualification, 'PATH'), \
                 patch.object(qualification, 'api', side_effect=api), \
                 patch.object(qualification, 'configure'), \
                 patch.object(qualification, 'check', side_effect=check):
                qualification.main(['--run-id', run_id])

            report = json.loads((evidence / 'runs' / run_id / 'qualification.json').read_text())
            self.assertEqual(report['run_id'], run_id)
            self.assertEqual(report['desktops'], ['run-owned-1', 'run-owned-2'])
            self.assertEqual([path for path, _ in calls], ['desktops', 'desktops'])
            self.assertEqual(historical.read_text(), '{"status":"passed","desktops":["incident"]}')

    def test_create_failure_marks_new_run_failed_without_touching_old_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = root / 'evidence' / 'qualification.json'
            old.parent.mkdir()
            old.write_text('{"status":"passed"}')
            run_id = 'f' * 32
            with patch.object(qualification, 'HERE', root), \
                 patch.object(qualification, 'EVIDENCE'), \
                 patch.object(qualification, 'PATH'), \
                 patch.object(qualification, 'configure'), \
                 patch.object(qualification, 'api', side_effect=RuntimeError('accepted response lost')):
                with self.assertRaisesRegex(RuntimeError, 'accepted response lost'):
                    qualification.main(['--run-id', run_id])
            report = json.loads((root / 'evidence' / 'runs' / run_id / 'qualification.json').read_text())
            self.assertEqual(report['status'], 'failed')
            self.assertEqual(old.read_text(), '{"status":"passed"}')

    def test_invalid_run_id_cannot_escape_evidence_directory(self):
        with self.assertRaises(ValueError):
            qualification.run_directory('../incident')

    def test_created_guest_and_registry_carry_run_owner(self):
        with tempfile.TemporaryDirectory() as temporary:
            manager = Desktops(temporary, configure_sdk=False)
            with patch('runtime.Sandbox') as sdk, patch.object(manager, 'prepare_guest'):
                sdk.create.return_value = Mock(sandbox_id='accepted-runtime')
                record = manager.create('Fixture', run_id='b' * 32)
                self.assertEqual(record['run_id'], 'b' * 32)
                self.assertEqual(sdk.create.call_args.kwargs['metadata']['silo-run-id'], 'b' * 32)
                with self.assertRaises(ValueError):
                    manager.create('Bad fixture', run_id='../incident')
                sdk.create.assert_called_once()

    def test_evidence_never_combines_legacy_or_other_run_passes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / 'evidence'
            evidence.mkdir()
            (evidence / 'qualification.json').write_text('{"status":"passed","checks":[]}')
            (evidence / 'credentials.json').write_text('{"status":"passed","checks":[]}')
            run_id = 'c' * 32
            run = evidence / 'runs' / run_id
            run.mkdir(parents=True)
            (run / 'qualification.json').write_text(json.dumps({
                'run_id': run_id, 'status': 'passed', 'checks': [{'name': 'fresh', 'status': 'pass'}],
                'manifest': {'source_sha256': {'runtime.py': 'one'}, 'sdk_version': '2.51.0'}}))
            with patch.object(server, 'HERE', root):
                self.assertEqual(server.evidence()['status'], 'incomplete')
                self.assertEqual(server.evidence(run_id)['status'], 'incomplete')
                (run / 'credentials.json').write_text(json.dumps({
                    'run_id': run_id, 'status': 'passed', 'checks': [{'name': 'credential', 'status': 'pass'}],
                    'manifest': {'source_sha256': {'runtime.py': 'one'}, 'sdk_version': '2.51.0'}}))
                self.assertEqual(server.evidence(run_id)['status'], 'incomplete')
                qualification_cases = [
                    'Kernel isolation, private egress and per-guest metadata',
                    'LCU desktop, isolation, handoff and reconnect',
                    'ARM64 Firefox observed through LCU',
                    'SDK PTY resize, Unicode, signal and exit',
                    'SSH binary, SFTP, EOF, exit status and revocation',
                    'Checkpoint fork and revert preserve memory and renew identity']
                credential_cases = [
                    'TLS credential substitution and negative authorization cases',
                    'Git smart HTTP through TLS placeholder broker',
                    'Rotation, revocation, guest-file scan and checkpoint replay']
                candidate = {'source_sha256': {'runtime.py': 'one'},
                             'template_build_record_sha256': 'template-one',
                             'sdk_version': '2.51.0', 'host_kernel': '7.0-test',
                             'host_arch': 'aarch64', 'boot_id': 'boot-one'}
                (run / 'qualification.json').write_text(json.dumps({
                    'run_id': run_id, 'status': 'passed',
                    'checks': [{'name': name, 'status': 'pass'} for name in qualification_cases],
                    'manifest': candidate}))
                (run / 'credentials.json').write_text(json.dumps({
                    'run_id': run_id, 'status': 'passed',
                    'checks': [{'name': name, 'status': 'pass'} for name in credential_cases],
                    'manifest': candidate}))
                result = server.evidence(run_id)
                self.assertEqual(result['status'], 'blocked')
                self.assertEqual(result['local_case_status'], 'passed')
                self.assertEqual(len(result['checks']), 9)
                credential_report = json.loads((run / 'credentials.json').read_text())
                credential_report['manifest']['boot_id'] = 'boot-two'
                (run / 'credentials.json').write_text(json.dumps(credential_report))
                self.assertNotEqual(server.evidence(run_id)['local_case_status'], 'passed')

    def test_cleanup_refuses_untagged_and_other_run_desktops(self):
        run_id = 'd' * 32
        report = {'run_id': run_id, 'status': 'failed', 'desktops': ['owned']}
        with self.assertRaises(ValueError):
            reset_failed_test.target_ids(report, [{'id': 'owned', 'run_id': None}], run_id)
        with self.assertRaises(ValueError):
            reset_failed_test.target_ids(report, [{'id': 'owned', 'run_id': 'e' * 32}], run_id)
        self.assertEqual(reset_failed_test.target_ids(report, [
            {'id': 'owned', 'run_id': run_id, 'status': 'running'},
            {'id': 'other', 'run_id': 'e' * 32, 'status': 'running'}], run_id), ['owned'])

    def test_cleanup_discovers_accepted_create_with_lost_response(self):
        run_id = 'd' * 32
        report = {'run_id': run_id, 'status': 'failed', 'desktops': []}
        self.assertEqual(reset_failed_test.target_ids(report, [
            {'id': 'accepted', 'run_id': run_id, 'status': 'creating'},
            {'id': 'other', 'run_id': 'e' * 32, 'status': 'running'}], run_id), ['accepted'])


if __name__ == '__main__':
    unittest.main()
