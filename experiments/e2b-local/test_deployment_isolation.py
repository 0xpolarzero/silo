"""A diagnostic Lima deployment must not reuse incident paths or the port."""
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from contextlib import redirect_stderr
import io
import tempfile


SCRIPT = Path(__file__).with_name('poc.py')


def load_driver():
    spec = importlib.util.spec_from_file_location('poc_driver_test', SCRIPT)
    driver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(driver)
    return driver


class DeploymentIsolationTests(unittest.TestCase):
    def test_named_scratch_deployment_separates_vm_evidence_and_forward(self):
        with patch.dict(os.environ, {'SILO_E2B_DEPLOYMENT': 'diagnostic-d1',
                                    'SILO_E2B_HOST_PORT': '13801'}, clear=False):
            driver = load_driver()
        self.assertEqual(driver.NAME, 'silo-e2b-diagnostic-d1')
        self.assertNotEqual(driver.EVIDENCE, driver.BASE_EVIDENCE)
        self.assertNotEqual(driver.LIMA_HOME, Path.home() / '.silo-e2b-poc/lima')
        self.assertEqual(driver.HOST_PORT, 13801)
        self.assertEqual(driver.VIEWER_HOST_PORT, 13802)
        config = driver.resolved_lima_config()
        self.assertIn('guestPort: 3800\n    hostPort: 13801', config)
        self.assertIn('guestPort: 3801\n    hostPort: 13802', config)

    def test_scratch_requires_explicit_nonincident_forward(self):
        with patch.dict(os.environ, {'SILO_E2B_DEPLOYMENT': 'diagnostic-d1'}, clear=False):
            os.environ.pop('SILO_E2B_HOST_PORT', None)
            with self.assertRaises(ValueError):
                load_driver()

    def test_up_refuses_existing_instance_without_viewer_forward(self):
        with patch.dict(os.environ, {'SILO_E2B_DEPLOYMENT': 'diagnostic-d1',
                                    'SILO_E2B_HOST_PORT': '13801'}, clear=False):
            driver = load_driver()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / driver.NAME).mkdir()
            (root / driver.NAME / 'lima.yaml').write_text('portForwards:\n  - guestPort: 3800\n')
            with patch.object(driver, 'LIMA_HOME', root), \
                    patch.object(driver, 'EVIDENCE', root / 'evidence'), \
                    patch.object(driver, 'prepare'), \
                    patch('sys.argv', ['poc.py', 'up']):
                with self.assertRaisesRegex(RuntimeError, 'new scratch deployment name'):
                    driver.main()

    def test_mutating_default_cannot_target_historical_vm(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('SILO_E2B_DEPLOYMENT', None)
            driver = load_driver()
        with patch('sys.argv', ['poc.py', 'stop']), redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as result:
                driver.main()
        self.assertEqual(result.exception.code, 2)

    def test_sdk_stop_requires_exact_run_and_successful_guest_guard(self):
        with patch.dict(os.environ, {'SILO_E2B_DEPLOYMENT': 'diagnostic-d1',
                                    'SILO_E2B_HOST_PORT': '13801'}, clear=False):
            driver = load_driver()
        with patch.object(driver, 'guest') as guest, patch.object(driver, 'lima') as lima:
            with patch('sys.argv', ['poc.py', 'stop-sdk', 'bad-id']):
                with self.assertRaisesRegex(RuntimeError, 'exact 32-character'):
                    driver.main()
            guest.assert_not_called()
            lima.assert_not_called()
            guest.side_effect = RuntimeError('prepared snapshot incomplete')
            with patch('sys.argv', ['poc.py', 'stop-sdk', 'a' * 32]):
                with self.assertRaisesRegex(RuntimeError, 'prepared snapshot incomplete'):
                    driver.main()
            lima.assert_not_called()

    def test_sdk_stop_refuses_historical_deployment(self):
        with patch.dict(os.environ, {'SILO_E2B_DEPLOYMENT': 'incident'}, clear=False):
            driver = load_driver()
        with patch.object(driver, 'guest') as guest, patch.object(driver, 'lima') as lima:
            with patch('sys.argv', ['poc.py', 'stop-sdk', 'a' * 32]):
                with self.assertRaisesRegex(RuntimeError, 'owned scratch'):
                    driver.main()
            guest.assert_not_called()
            lima.assert_not_called()

    def test_sdk_up_reuses_existing_scratch_config_after_prepared_report(self):
        run_id = 'a' * 32
        with patch.dict(os.environ, {'SILO_E2B_DEPLOYMENT': 'diagnostic-d1',
                                    'SILO_E2B_HOST_PORT': '13801'}, clear=False):
            driver = load_driver()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vm = root / driver.NAME
            vm.mkdir()
            (vm / 'lima.yaml').write_text('portForwards:\n  - guestPort: 3800\n')
            report_dir = root / 'evidence' / 'sdk-lifecycle'
            report_dir.mkdir(parents=True)
            (report_dir / f'host-restart-prepare-{run_id}.json').write_text(json.dumps({
                'run_id': run_id, 'status': 'prepared', 'schema': 'sdk-host-restart-prepare/v1'}))
            with patch.object(driver, 'LIMA_HOME', root), \
                    patch.object(driver, 'EVIDENCE', root), \
                    patch.object(driver, 'lima') as lima, \
                    patch.object(driver, 'guest') as guest, \
                    patch('sys.argv', ['poc.py', 'up-sdk', run_id]):
                driver.main()
            lima.assert_called_once_with('start', '--tty=false', driver.NAME)
            guest.assert_called_once()

    def test_sdk_up_refuses_missing_preparation_before_start(self):
        with patch.dict(os.environ, {'SILO_E2B_DEPLOYMENT': 'diagnostic-d1',
                                    'SILO_E2B_HOST_PORT': '13801'}, clear=False):
            driver = load_driver()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / driver.NAME).mkdir()
            (root / driver.NAME / 'lima.yaml').write_text('existing')
            with patch.object(driver, 'LIMA_HOME', root), \
                    patch.object(driver, 'EVIDENCE', root), \
                    patch.object(driver, 'lima') as lima, \
                    patch('sys.argv', ['poc.py', 'up-sdk', 'a' * 32]):
                with self.assertRaisesRegex(RuntimeError, 'collected preparation'):
                    driver.main()
            lima.assert_not_called()


if __name__ == '__main__':
    unittest.main()
