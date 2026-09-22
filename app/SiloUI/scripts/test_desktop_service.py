"""Guest lifecycle behavior tests without starting a desktop or mutating host state."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
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
        marker_patch = patch.object(service, 'WORKING_ACCOUNT', self.root / 'working-account.json', create=True)
        marker_patch.start()
        self.addCleanup(marker_patch.stop)
        identity_patch = patch.multiple(service, USER='silo', HOME=Path('/home/silo'))
        identity_patch.start()
        self.addCleanup(identity_patch.stop)
        runtime_patch = patch.object(service, 'LUDA_PYTHON', self.root / 'luda/.venv/bin/python', create=True)
        runtime_patch.start()
        self.addCleanup(runtime_patch.stop)
        self.unified_policy()

    def command(self, *arguments):
        with patch.object(service.sys, 'argv', ['silo-desktop', *arguments]), \
             patch.object(service.os, 'geteuid', return_value=0), \
             patch.object(service, 'validate_policy_file'), \
             patch.object(service.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1001, pw_gid=1001, pw_dir='/home/silo')), \
             patch('sys.stdout', new_callable=io.StringIO) as output:
            service.main()
            return json.loads(output.getvalue())

    def test_absent_account_policy_requires_migration_even_when_installed(self):
        service.WORKING_ACCOUNT.unlink()
        for action in ('status', 'prepare-install', 'start', 'boot'):
            with self.subTest(action=action), self.assertRaisesRegex(RuntimeError, 'migrate this VM or create a new VM'):
                self.command(action)
        self.assertFalse((service.STATE / 'configuration-managed.json').exists())

    def unified_policy(self, **changes):
        policy = dict(schemaVersion=1, user='silo', home='/home/silo')
        policy.update(changes)
        service.WORKING_ACCOUNT.write_text(json.dumps(policy))
        service.WORKING_ACCOUNT.chmod(0o600)

    def test_unified_policy_uses_existing_normal_account(self):
        self.unified_policy()
        account = SimpleNamespace(pw_uid=1001, pw_gid=1001, pw_dir='/home/silo')
        with patch.object(service, 'validate_policy_file'), patch.object(service.pwd, 'getpwnam', return_value=account):
            self.assertEqual(service.desktop_account(), ('silo', Path('/home/silo')))
            self.assertEqual(self.command('status')['user'], 'silo')

    def test_invalid_policy_is_rejected(self):
        for changes in ({'schemaVersion': 2}, {'user': 'root'}, {'home': '/root'}):
            self.unified_policy(**changes)
            with patch.object(service, 'validate_policy_file'), self.assertRaises(RuntimeError):
                service.desktop_account()

    def test_policy_account_must_exist_with_expected_home_uid_and_gid(self):
        self.unified_policy()
        for account in (SimpleNamespace(pw_uid=0, pw_gid=1001, pw_dir='/home/silo'),
                        SimpleNamespace(pw_uid=1001, pw_gid=1000, pw_dir='/home/silo'),
                        SimpleNamespace(pw_uid=1001, pw_gid=1001, pw_dir='/elsewhere')):
            with patch.object(service, 'validate_policy_file'), patch.object(service.pwd, 'getpwnam', return_value=account), self.assertRaises(RuntimeError):
                service.desktop_account()
        with patch.object(service, 'validate_policy_file'), patch.object(service.pwd, 'getpwnam', side_effect=KeyError), self.assertRaises(RuntimeError):
            service.desktop_account()

    def test_policy_permissions_accept_only_root_owned_regular_files(self):
        for owner, mode, allowed in ((0, 0o100644, True), (1000, 0o100600, False),
                                     (0, 0o100620, False), (0, 0o040700, False)):
            with self.subTest(owner=owner, mode=mode):
                path = SimpleNamespace(lstat=lambda: SimpleNamespace(st_uid=owner, st_mode=mode))
                if allowed:
                    service.validate_policy_file(path)
                else:
                    with self.assertRaises(RuntimeError):
                        service.validate_policy_file(path)

    def test_policy_symlink_and_writable_file_are_rejected(self):
        self.unified_policy()
        service.WORKING_ACCOUNT.chmod(0o666)
        with self.assertRaises(RuntimeError):
            service.desktop_account()
        service.WORKING_ACCOUNT.unlink()
        service.WORKING_ACCOUNT.symlink_to(self.root / 'missing')
        with self.assertRaises(RuntimeError):
            service.desktop_account()

    def test_install_preflight_preserves_existing_desktop_configuration(self):
        home = self.root / 'home'
        (home / '.vnc').mkdir(parents=True)
        path = home / '.vnc/xstartup'
        path.write_text('existing session')
        with self.assertRaises(RuntimeError):
            service.prepare_configuration(home)
        self.assertEqual(path.read_text(), 'existing session')
        self.assertFalse((service.STATE / 'configuration-managed.json').exists())

    def test_install_preflight_rejects_existing_password_and_symlink_directory(self):
        home = self.root / 'home'
        home.mkdir()
        password = home / '.kasmpasswd'
        password.write_text('existing password')
        with self.assertRaises(RuntimeError):
            service.prepare_configuration(home)
        password.unlink()
        target = self.root / 'elsewhere'
        target.mkdir()
        (home / '.vnc').symlink_to(target, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            service.prepare_configuration(home)
        self.assertEqual(list(target.iterdir()), [])

    def test_unified_display_stop_targets_its_account_and_home(self):
        with patch.multiple(service, USER='silo', HOME=Path('/home/silo')), patch.object(service.subprocess, 'run') as run:
            service.stop_display()
        arguments = run.call_args.args[0]
        self.assertEqual(arguments[:6], ['runuser', '-u', 'silo', '--', 'env', 'HOME=/home/silo'])
        self.assertEqual(arguments[-3:], ['vncserver', '-kill', ':1'])

    def test_install_preflight_allows_retry_but_not_a_different_home(self):
        home = self.root / 'home'
        home.mkdir()
        service.prepare_configuration(home)
        (home / '.kasmpasswd').write_text('managed partial installation')
        service.prepare_configuration(home)
        with self.assertRaises(RuntimeError):
            service.prepare_configuration(self.root / 'other')

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

    def luda_runtime(self):
        service.LUDA_PYTHON.parent.mkdir(parents=True, exist_ok=True)
        service.LUDA_PYTHON.write_text('#!/bin/sh\nexit 0\n')
        service.LUDA_PYTHON.chmod(0o755)

    def test_luda_status_is_separate_from_desktop_readiness(self):
        self.assertEqual(self.command('status')['ludaState'], 'missing')
        self.assertFalse((service.STATE / 'luda.lock').exists())
        self.luda_runtime()
        for state in ('failed', 'ready'):
            service.write(service.STATE / 'luda.json', {'state': state, 'version': '0.3.0', 'error': 'private log'})
            result = self.command('status')
            self.assertTrue(result['installed'])
            self.assertEqual(result['ludaState'], state)
            self.assertEqual(result['ludaVersion'], '0.3.0')
            self.assertNotIn('private log', json.dumps(result))

    def test_unrecorded_runtime_has_unknown_status(self):
        self.luda_runtime()
        self.assertIsNone(self.command('status')['ludaState'])
        self.assertFalse((service.STATE / 'luda.json').exists())
        self.assertFalse((service.STATE / 'luda.lock').exists())

    def test_ready_requires_an_executable_runtime(self):
        service.write(service.STATE / 'luda.json', {'state': 'ready', 'version': '0.3.4'})
        self.assertEqual(self.command('status')['ludaState'], 'failed')
        self.luda_runtime()
        service.LUDA_PYTHON.chmod(0o644)
        self.assertFalse(os.access(service.LUDA_PYTHON, os.X_OK))
        self.assertEqual(self.command('status')['ludaState'], 'failed')
        service.LUDA_PYTHON.chmod(0o755)
        self.assertEqual(self.command('status')['ludaState'], 'ready')

    def test_only_a_running_installer_reports_installing(self):
        service.write(service.STATE / 'luda.json', {'state': 'installing', 'version': '0.3.4'})
        self.assertEqual(self.command('status')['ludaState'], 'failed')
        self.assertFalse((service.STATE / 'luda.lock').exists())
        with (service.STATE / 'luda.lock').open('w') as installer:
            service.fcntl.flock(installer, service.fcntl.LOCK_EX | service.fcntl.LOCK_NB)
            self.assertEqual(self.command('status')['ludaState'], 'installing')
        self.assertEqual(self.command('status')['ludaState'], 'failed')
        self.assertEqual(service.read('luda.json')['state'], 'installing')

    def test_active_installer_takes_precedence_over_previous_failure(self):
        service.write(service.STATE / 'luda.json', {'state': 'failed', 'version': '0.3.4'})
        with (service.STATE / 'luda.lock').open('w') as installer:
            service.fcntl.flock(installer, service.fcntl.LOCK_EX | service.fcntl.LOCK_NB)
            self.assertEqual(self.command('status')['ludaState'], 'installing')

    def test_unreadable_luda_receipt_has_unknown_status(self):
        with patch.object(service, 'read', side_effect=PermissionError('private path')):
            self.assertEqual(service.luda_status(), dict(ludaState=None, ludaVersion=None))

    def test_uncheckable_installer_lock_has_unknown_status(self):
        (service.STATE / 'luda.lock').touch()
        with patch.object(service.fcntl, 'flock', side_effect=OSError('private path')):
            self.assertEqual(service.luda_status(), dict(ludaState=None, ludaVersion=None))

    def test_invalid_luda_state_is_sanitized(self):
        service.write(service.STATE / 'luda.json', {'state': 'private log', 'version': 'private log'})
        result = self.command('status')
        self.assertEqual(result['ludaState'], 'failed')
        self.assertIsNone(result['ludaVersion'])

    def test_status_reports_installed_luda_release_without_requiring_current_pin(self):
        self.luda_runtime()
        for version in ('0.3.0', '0.3.1', '1.10.12'):
            with self.subTest(version=version):
                service.write(service.STATE / 'luda.json', {'state': 'ready', 'version': version})
                result = self.command('status')
                self.assertEqual(result['ludaVersion'], version)
                self.assertEqual(result['ludaState'], 'ready')

    def test_invalid_luda_versions_do_not_escape_or_break_status(self):
        self.luda_runtime()
        for version in (None, 3, True, [], {}, 'private log', '0.3', '0.3.1\n',
                        'v0.3.1', '0.3.1; secret', '０.３.１'):
            with self.subTest(version=version):
                service.write(service.STATE / 'luda.json', {'state': 'ready', 'version': version})
                result = self.command('status')
                self.assertIsNone(result['ludaVersion'])
                self.assertEqual(result['ludaState'], 'ready')
                self.assertTrue(result['installed'])

    def test_boot_does_not_install_or_repair_luda(self):
        with patch.object(service, 'start'), patch.object(service.subprocess, 'run') as run:
            self.command('boot')
        run.assert_not_called()

    def test_luda_repair_preserves_desktop_session(self):
        with patch.object(service.subprocess, 'run') as run, patch.object(service, 'start') as start, patch.object(service, 'stop') as stop:
            self.command('repair-luda')
        run.assert_called_once_with(['python3', '/usr/local/libexec/silo-setup-luda.py', '--repair'], check=True)
        start.assert_not_called()
        stop.assert_not_called()

    def test_unknown_autostart_value_does_not_modify_preferences(self):
        with self.assertRaises(RuntimeError):
            self.command('autostart', 'yes')
        self.assertIsNone(service.read('config.json'))


if __name__ == '__main__':
    unittest.main()
