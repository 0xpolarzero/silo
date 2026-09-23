"""A failed save remains a shutdown failure on every retry; a durable pause must carry its upload marker."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from e2b.exceptions import SandboxNotFoundException
import runtime
import shutdown


class ShutdownTests(unittest.TestCase):
    def test_pause_blocks_until_upload_marker_and_records_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            manager = runtime.Desktops(temporary, configure_sdk=False)
            manager.data['desktops']['workspace'] = {'id': 'workspace', 'sandbox_id': 'sbx1',
                'name': 'Work', 'status': 'running', 'mode': 'agent', 'epoch': 3}
            handle = manager.handles['workspace'] = Mock(sandbox_id='sbx1')
            marker_line = ('2026-09-24T01:02:03Z INFO snapshot finished uploading successfully '
                           '{"service": "orchestrator", "sandbox.id": "sbx1"}')
            logs = Mock(returncode=0, stdout=marker_line + '\n', stderr='')
            with patch.object(runtime.subprocess, 'run', return_value=logs):
                result = manager.lifecycle('workspace', 'pause')
            self.assertEqual(result['status'], 'paused')
            handle.pause.assert_called_once_with(keep_memory=True)
            self.assertTrue(result['durable_upload'].get('marker_sha256'))
            self.assertNotIn('timeout', result['durable_upload'])

    def test_pause_timeout_leaves_truthful_undurable_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            manager = runtime.Desktops(temporary, configure_sdk=False)
            manager.data['desktops']['workspace'] = {'id': 'workspace', 'sandbox_id': 'sbx1',
                'name': 'Work', 'status': 'running', 'mode': 'agent', 'epoch': 3}
            manager.handles['workspace'] = Mock(sandbox_id='sbx1')
            logs = Mock(returncode=0, stdout='', stderr='')
            with patch.object(runtime.subprocess, 'run', return_value=logs), \
                 patch.object(runtime.time, 'sleep'):
                result = manager.lifecycle('workspace', 'pause')
            self.assertEqual(result['status'], 'paused')
            self.assertTrue(result['durable_upload'].get('timeout'))

    def test_shutdown_refuses_paused_desktop_without_marker(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            (state / 'desktops.json').write_text(json.dumps({'desktops': {
                'workspace': {'sandbox_id': 'sbx1', 'status': 'paused',
                              'durable_upload': {'timeout': True}}}}))
            with patch.object(shutdown, 'STATE', state), \
                 patch.object(shutdown.subprocess, 'run', return_value=Mock(returncode=1)), \
                 patch.object(shutdown, 'configure'), \
                 patch.object(shutdown.Sandbox, 'get_info',
                              return_value=Mock(state=Mock(value='paused'))):
                with self.assertRaisesRegex(RuntimeError, 'without a verified durable upload'):
                    shutdown.verify_durability(json.loads((state / 'desktops.json').read_text())['desktops'])

    def test_shutdown_barrier_passes_with_marker_and_syncs_storage(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            (state / 'desktops.json').write_text(json.dumps({'desktops': {
                'workspace': {'sandbox_id': 'sbx1', 'status': 'paused',
                              'durable_upload': {'marker_sha256': 'a' * 64}}}}))
            with patch.object(shutdown, 'STATE', state), \
                 patch.object(shutdown.subprocess, 'run', return_value=Mock(returncode=1)) as run, \
                 patch.object(shutdown, 'configure'), \
                 patch.object(shutdown.Sandbox, 'get_info',
                              return_value=Mock(state=Mock(value='paused'))):
                receipt = shutdown.main()
            self.assertEqual(receipt['barrier'], 'passed')
            sync_commands = [c for c in run.call_args_list
                             if 'sync' in c.args[0] and '/var/lib/e2b/storage' in c.args[0]]
            self.assertTrue(sync_commands, 'storage must be synced before host stop')

    def test_missing_saved_workspace_blocks_shutdown_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            (state / 'desktops.json').write_text(json.dumps({'desktops': {
                'workspace': {'sandbox_id': 'missing-runtime', 'status': 'missing'}}}))
            with patch.object(shutdown, 'STATE', state), \
                 patch.object(shutdown.subprocess, 'run', return_value=Mock(returncode=1)), \
                 patch.object(shutdown, 'configure'), \
                 patch.object(shutdown.Sandbox, 'get_info', side_effect=SandboxNotFoundException('missing')):
                with self.assertRaisesRegex(RuntimeError, 'missing-runtime'):
                    shutdown.verify_registry()


if __name__ == '__main__':
    unittest.main()
