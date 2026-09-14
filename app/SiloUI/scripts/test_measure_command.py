import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('measure-command.py')

class MeasurementTests(unittest.TestCase):
    def test_records_duration_and_failure_without_command_or_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'metrics.jsonl'
            import os
            env = dict(os.environ, SILO_BUILD_METRICS=str(output), PRIVATE_SENTINEL='secret-sentinel')
            result = subprocess.run([sys.executable, str(SCRIPT), 'fixture', '--', sys.executable,
                                     '-c', 'import sys; sys.exit(7)', 'private-argument'], env=env, capture_output=True)
            self.assertEqual(result.returncode, 7)
            text = output.read_text()
            record = json.loads(text)
            self.assertEqual(record['exitCode'], 7)
            self.assertEqual(record['phase'], 'fixture')
            self.assertGreaterEqual(record['seconds'], 0)
            self.assertNotIn('secret-sentinel', text)
            self.assertNotIn('private-argument', text)

    def test_missing_program_is_a_recorded_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            import os
            output = Path(directory) / 'metrics.jsonl'
            result = subprocess.run([sys.executable, str(SCRIPT), 'missing', '--', '/no/such/program'],
                env=dict(os.environ, SILO_BUILD_METRICS=str(output)), capture_output=True)
            self.assertEqual(result.returncode, 127)
            self.assertEqual(json.loads(output.read_text())['exitCode'], 127)

if __name__ == '__main__':
    unittest.main()
