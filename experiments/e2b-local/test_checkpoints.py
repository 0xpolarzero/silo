"""Revert must preserve workspace identity and never publish a partial restore."""
import json
import tempfile
import unittest
from unittest.mock import Mock, patch
from runtime import Desktops
from e2b.exceptions import SandboxException, SandboxNotFoundException


class RevertTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.m = Desktops(self.temp.name, configure_sdk=False)
        self.m.data['desktops']['workspace'] = {'id': 'workspace', 'sandbox_id': 'old',
            'name': 'Work', 'status': 'running', 'mode': 'human', 'epoch': 5}
        self.m.data['checkpoints']['checkpoint'] = {'id': 'checkpoint', 'source': 'workspace'}
        self.old = self.m.handles['workspace'] = Mock(sandbox_id='old')
        self.m.save()

    def tearDown(self):
        self.temp.cleanup()

    def test_revert_replaces_runtime_but_preserves_workspace_and_control(self):
        new = Mock(sandbox_id='new')
        with patch('runtime.Sandbox') as sdk, patch.object(self.m, 'prepare_guest'):
            sdk.create.return_value = new
            result = self.m.revert('workspace', 'checkpoint')
            self.assertEqual(result['id'], 'workspace')
            self.assertEqual(result['sandbox_id'], 'new')
            self.assertEqual(result['mode'], 'human')
            self.assertGreater(result['epoch'], 5)
            self.old.pause.assert_called_once_with(keep_memory=True)
            sdk.kill.assert_called_once_with('old')
            self.assertNotIn('operation', result)

    def test_failed_readiness_keeps_old_workspace_recoverable(self):
        with patch('runtime.Sandbox') as sdk, patch.object(self.m, 'prepare_guest', side_effect=RuntimeError('not ready')):
            sdk.create.return_value = Mock(sandbox_id='new')
            with self.assertRaisesRegex(RuntimeError, 'not ready'):
                self.m.revert('workspace', 'checkpoint')
            record = self.m.record('workspace')
            self.assertEqual(record['sandbox_id'], 'old')
            self.assertEqual(record['status'], 'paused')
            sdk.kill.assert_called_once_with('new')
            self.assertNotIn('operation', record)

    def test_revert_intent_is_durable_before_source_pause(self):
        def pause_after_acceptance(**kwargs):
            persisted = json.loads(self.m.registry.read_text())['desktops']['workspace']
            self.assertEqual(persisted['operation']['phase'], 'pausing_source')
            self.assertEqual(persisted['operation']['old'], 'old')
            raise RuntimeError('pause response lost')

        self.old.pause.side_effect = pause_after_acceptance
        with self.assertRaisesRegex(RuntimeError, 'pause response lost'):
            self.m.revert('workspace', 'checkpoint')
        self.assertEqual(self.m.record('workspace')['operation']['phase'], 'pausing_source')

        restarted = Desktops(self.temp.name, configure_sdk=False)
        with patch('runtime.Sandbox') as sdk:
            sdk.get_info.return_value = Mock(state=Mock(value='paused'))
            restarted.recover_revert('workspace')
            sdk.get_info.assert_called_once_with('old')
            sdk.kill.assert_not_called()
        self.assertEqual(restarted.record('workspace')['sandbox_id'], 'old')
        self.assertEqual(restarted.record('workspace')['status'], 'paused')
        self.assertNotIn('operation', restarted.record('workspace'))

    def test_revert_pause_lookup_failure_keeps_source_intent(self):
        self.m.record('workspace')['operation'] = {
            'id': 'operation', 'old': 'old', 'candidate': None, 'phase': 'pausing_source'}
        self.m.save()
        from runtime import Conflict
        with patch('runtime.Sandbox') as sdk:
            sdk.get_info.side_effect = RuntimeError('owner unavailable')
            with self.assertRaisesRegex(Conflict, 'unresolved'):
                self.m.recover_revert('workspace')
            sdk.kill.assert_not_called()
        self.assertEqual(self.m.record('workspace')['sandbox_id'], 'old')
        self.assertEqual(self.m.record('workspace')['operation']['id'], 'operation')

    def test_running_lookup_does_not_clear_in_flight_pause_intent(self):
        from runtime import Conflict
        self.m.record('workspace')['operation'] = {
            'id': 'operation', 'old': 'old', 'candidate': None, 'phase': 'pausing_source'}
        self.m.save()
        with patch('runtime.Sandbox') as sdk:
            sdk.get_info.side_effect = [Mock(state=Mock(value='running')),
                                        Mock(state=Mock(value='paused'))]
            with self.assertRaisesRegex(Conflict, 'still running'):
                self.m.recover_revert('workspace')
            self.assertEqual(self.m.record('workspace')['operation']['phase'], 'pausing_source')
            sdk.kill.assert_not_called()
            self.m.recover_revert('workspace')
            self.assertEqual(sdk.get_info.call_count, 2)
            sdk.kill.assert_not_called()
        self.assertEqual(self.m.record('workspace')['status'], 'paused')
        self.assertNotIn('operation', self.m.record('workspace'))

    def test_crash_after_candidate_recording_does_not_publish_it(self):
        record = self.m.record('workspace')
        record.update(status='paused', operation={'candidate': 'new', 'old': 'old', 'phase': 'preparing'})
        self.m.save()
        restarted = Desktops(self.temp.name, configure_sdk=False)
        with patch('runtime.Sandbox') as sdk:
            restarted.recover_revert('workspace')
            sdk.kill.assert_called_once_with('new')
            self.assertEqual(restarted.record('workspace')['sandbox_id'], 'old')

    def test_revert_retirement_replay_accepts_exact_owned_runtime_already_missing(self):
        record = self.m.record('workspace')
        record.update(sandbox_id='new', operation={
            'id': 'operation', 'candidate': 'new', 'old': 'old', 'phase': 'committed'})
        self.m.save()
        with patch('runtime.Sandbox') as sdk:
            with patch.object(self.m, 'save', side_effect=OSError('crash before journal cleanup')):
                with self.assertRaisesRegex(OSError, 'crash before journal cleanup'):
                    self.m.recover_revert('workspace')
            sdk.kill.assert_called_once_with('old')
            sdk.kill.reset_mock(side_effect=True)
            sdk.kill.side_effect = SandboxNotFoundException('old already deleted')
            restarted = Desktops(self.temp.name, configure_sdk=False)
            restarted.recover_revert('workspace')
            sdk.kill.assert_called_once_with('old')
        self.assertEqual(restarted.record('workspace')['sandbox_id'], 'new')
        self.assertNotIn('operation', restarted.record('workspace'))

    def test_unknown_checkpoint_cannot_pause_workspace(self):
        with self.assertRaises(KeyError):
            self.m.revert('workspace', 'unowned')
        self.old.pause.assert_not_called()

    def test_only_definitive_placement_failure_is_retried(self):
        with patch('runtime.Sandbox') as sdk, patch('runtime.time.sleep'):
            sdk.create.side_effect = [SandboxException('500: Failed to place sandbox: sandbox creation failed on 1 node(s)'), Mock(sandbox_id='new')]
            self.assertEqual(self.m.restore_candidate('checkpoint', 'Work', 'op').sandbox_id, 'new')
            self.assertEqual(sdk.create.call_count, 2)
            sdk.create.reset_mock(side_effect=True)
            sdk.create.side_effect = SandboxException('request timed out')
            with self.assertRaises(SandboxException):
                self.m.restore_candidate('checkpoint', 'Work', 'op')
            sdk.create.assert_called_once()

    def test_crash_before_returned_id_is_recovered_by_owned_operation(self):
        self.m.record('workspace')['operation'] = {'id': 'operation', 'candidate': None, 'old': 'old', 'phase': 'preparing'}
        with patch('runtime.Sandbox') as sdk:
            class Page:
                has_next = True
                def next_items(self):
                    self.has_next = False
                    return [Mock(sandbox_id='accepted-but-unrecorded')]
            sdk.list.return_value = Page()
            self.m.recover_revert('workspace')
            sdk.kill.assert_called_once_with('accepted-but-unrecorded')
            query = sdk.list.call_args.kwargs['query']
            self.assertEqual(query.metadata['silo-poc-owner'], self.m.data['owner'])
            self.assertEqual(query.metadata['silo-operation'], 'operation')

    def test_unobserved_revert_create_keeps_intent_until_candidate_is_visible(self):
        from runtime import Conflict
        self.m.record('workspace').update(status='paused', operation={
            'id': 'operation', 'candidate': None, 'old': 'old', 'phase': 'preparing'})
        self.m.save()

        class Page:
            has_next = True
            def __init__(self, items):
                self.items = items
            def next_items(self):
                self.has_next = False
                return self.items

        with patch('runtime.Sandbox') as sdk:
            sdk.list.side_effect = [Page([]), Page([Mock(sandbox_id='late-candidate')])]
            with self.assertRaisesRegex(Conflict, 'unresolved'):
                self.m.recover_revert('workspace')
            self.assertEqual(self.m.record('workspace')['operation']['id'], 'operation')
            sdk.kill.assert_not_called()
            self.m.recover_revert('workspace')
            sdk.kill.assert_called_once_with('late-candidate')
            self.assertNotIn('operation', self.m.record('workspace'))

    def test_ambiguous_revert_create_preserves_original_error_and_intent(self):
        class EmptyPage:
            has_next = True
            def next_items(self):
                self.has_next = False
                return []

        with patch.object(self.m, 'restore_candidate', side_effect=RuntimeError('create response lost')):
            with patch('runtime.Sandbox') as sdk:
                sdk.list.return_value = EmptyPage()
                with self.assertRaisesRegex(RuntimeError, 'create response lost'):
                    self.m.revert('workspace', 'checkpoint')
                sdk.kill.assert_not_called()
        record = self.m.record('workspace')
        self.assertEqual(record['sandbox_id'], 'old')
        self.assertEqual(record['operation']['phase'], 'candidate_unobserved')
        self.assertEqual(record['last_revert_error'], 'create response lost')

    def test_low_snapshot_headroom_refuses_before_touching_source(self):
        from runtime import Conflict
        with patch('runtime.Path.read_text', return_value='HugePages_Free: 1024\nHugePages_Rsvd: 256\nHugepagesize: 2048 kB\n'):
            with self.assertRaisesRegex(Conflict, 'refused before pausing'):
                self.m.checkpoint('workspace')
        self.old.create_snapshot.assert_not_called()
        self.old.pause.assert_not_called()


if __name__ == '__main__':
    unittest.main()
