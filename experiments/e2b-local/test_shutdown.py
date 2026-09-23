"""A failed save remains a shutdown failure on every retry."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from e2b.exceptions import SandboxNotFoundException
import shutdown


class ShutdownTests(unittest.TestCase):
    def test_stop_refuses_before_pausall_without_durability_barrier(self):
        with patch('shutdown.os.geteuid', return_value=0), \
             patch('shutdown.verify_registry') as verify:
            with self.assertRaisesRegex(RuntimeError, 'durable-upload barrier'):
                shutdown.main()
            verify.assert_not_called()

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
