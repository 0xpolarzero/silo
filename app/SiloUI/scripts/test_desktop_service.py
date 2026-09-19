"""Guest lifecycle behavior tests without starting a desktop or mutating host state."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'src-tauri/guest/desktop-service.py'
spec = importlib.util.spec_from_file_location('desktop_service', SOURCE)
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class DesktopLifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ('STATE', 'RUN'):
            directory = self.root / name
            directory.mkdir()
            mock = patch.object(service, name, directory)
            mock.start()
            self.addCleanup(mock.stop)
        service.write(service.STATE / 'installed.json', {'version': '1'})

    def command(self, *arguments):
        with patch.object(service.sys, 'argv', ['silo-desktop', *arguments]), \
             patch.object(service.os, 'geteuid', return_value=0), \
             patch('sys.stdout', new_callable=io.StringIO) as output:
            service.main()
            return json.loads(output.getvalue())

    def test_disabling_autostart_preserves_current_session(self):
        with patch.object(service, 'start') as start, patch.object(service, 'stop') as stop:
            result = self.command('autostart', 'false')
        self.assertFalse(result['autoStart'])
        start.assert_not_called()
        stop.assert_not_called()
        self.assertEqual(service.read('config.json'), {'autoStart': False})

    def test_enabling_autostart_starts_immediately(self):
        with patch.object(service, 'start') as start:
            self.command('autostart', 'true')
        start.assert_called_once_with()

    def test_boot_respects_persisted_manual_preference(self):
        service.write(service.STATE / 'config.json', {'autoStart': False})
        with patch.object(service, 'start') as start:
            self.command('boot')
        start.assert_not_called()

    def test_boot_defaults_to_automatic(self):
        with patch.object(service, 'start') as start:
            self.command('boot')
        start.assert_called_once_with()

    def test_reused_pid_is_not_a_live_supervisor(self):
        service.write(service.RUN / 'supervisor.json', {'pid': 123, 'start': 'old'})
        with patch.object(service, 'identity', return_value='new'):
            self.assertIsNone(service.supervisor())
            with patch.object(service.os, 'kill') as kill:
                service.stop()
                kill.assert_not_called()

    def test_explicit_stop_clears_failure_without_disabling_next_boot(self):
        (service.RUN / 'failed').write_text('failed')
        result = self.command('stop')
        self.assertEqual(result['state'], 'stopped')
        self.assertTrue(result['autoStart'])

    def test_running_requires_service_and_endpoint(self):
        with patch.object(service, 'supervisor', return_value=123), \
             patch.object(service, 'listening', return_value=False):
            self.assertEqual(service.status()['state'], 'starting')
        with patch.object(service, 'supervisor', return_value=123), \
             patch.object(service, 'listening', return_value=True):
            self.assertEqual(service.status()['state'], 'running')

    def test_status_does_not_expose_connection_credentials(self):
        service.write(service.STATE / 'connection.json', {'username': 'silo', 'password': 'secret', 'port': 6901})
        result = self.command('status')
        self.assertNotIn('secret', json.dumps(result))
        self.assertNotIn('password', result)

    def test_log_bounds_preserve_tail_and_do_not_follow_symlinks(self):
        home = self.root / 'home'
        logs = home / '.vnc'
        logs.mkdir(parents=True)
        large = logs / 'desktop.log'
        large.write_bytes(b'a' * (1024 * 1024) + b'b' * (256 * 1024))
        target = self.root / 'private'
        original = b'private' * 200000
        target.write_bytes(original)
        (logs / 'symlink.log').symlink_to(target)
        with patch.object(service, 'HOME', home), patch.object(service, 'LOG', self.root / 'service.log'):
            service.trim_logs()
        self.assertEqual(large.read_bytes(), b'b' * (256 * 1024))
        self.assertEqual(target.read_bytes(), original)

    def test_unknown_autostart_value_does_not_modify_preferences(self):
        with self.assertRaises(RuntimeError):
            self.command('autostart', 'yes')
        self.assertIsNone(service.read('config.json'))


if __name__ == '__main__':
    unittest.main()
