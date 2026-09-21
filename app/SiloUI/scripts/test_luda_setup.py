"""Exercise guest Luda provisioning without installing software on the host."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'src-tauri/guest/setup-luda.py'
spec = importlib.util.spec_from_file_location('luda_setup', SOURCE)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class LudaSetup(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.lock = json.loads(SOURCE.with_name('luda-lock.json').read_text())
        for name, path in dict(STATE=self.root / 'state', PREFIX=self.root / 'luda',
                               LOG=self.root / 'install.log', LOCK=self.root / 'lock.json',
                               POLICY=self.root / 'policy.json').items():
            mocked = patch.object(setup, name, path)
            mocked.start()
            self.addCleanup(mocked.stop)
        setup.STATE.mkdir()
        setup.LOCK.write_text(json.dumps(self.lock))
        self.account = patch.object(setup, 'validate_account')
        self.account.start()
        self.addCleanup(self.account.stop)

    def runtime(self):
        executable = setup.PREFIX / 'current/.venv/bin/python'
        executable.parent.mkdir(parents=True)
        executable.touch()

    def test_first_install_and_subsequent_install_are_network_free(self):
        with patch.object(setup, 'install_release', side_effect=lambda *_: self.runtime()) as install:
            setup.provision()
            self.assertEqual(setup.read_state()['state'], 'ready')
            setup.provision()
        install.assert_called_once()

    def test_failed_install_is_retryable_and_does_not_expose_subprocess_output(self):
        with patch.object(setup, 'install_release', side_effect=RuntimeError('secret credential')):
            with self.assertRaisesRegex(RuntimeError, '^Desktop tools installation failed') as error:
                setup.provision()
        self.assertNotIn('secret', str(error.exception))
        self.assertEqual(setup.read_state()['state'], 'failed')
        with patch.object(setup, 'install_release', side_effect=lambda *_: self.runtime()):
            setup.provision()
        self.assertEqual(setup.read_state()['state'], 'ready')

    def test_repair_uses_installed_setup_for_all_agents(self):
        self.runtime()
        setup.write_state('ready', self.lock)
        with patch.object(setup, 'run') as run, patch.object(setup, 'install_release') as install:
            setup.provision(repair=True)
        install.assert_not_called()
        self.assertEqual(run.call_args.args[0], [str(setup.PREFIX / 'current/.venv/bin/python'),
                         '-m', 'luda.setup', '--prefix', str(setup.PREFIX), '--user', 'silo',
                         '--agent', 'all', '--yes'])

    def test_repair_upgrades_old_ready_runtime_before_registering_agents(self):
        self.runtime()
        previous = dict(self.lock, version='0.3.0', commit='0' * 40)
        setup.write_state('ready', previous)
        with patch.object(setup, 'run') as run, patch.object(setup, 'install_release') as install:
            setup.provision(repair=True)
        install.assert_called_once()
        self.assertEqual(install.call_args.args[0], self.lock)
        # The release installer configures every agent. Running the old runtime's
        # setup command instead would silently leave the old MCP and skill active.
        run.assert_not_called()
        self.assertEqual(setup.read_state(), dict(state='ready', version=self.lock['version'],
                                                  commit=self.lock['commit']))
        with patch.object(setup, 'install_release') as install:
            setup.provision()
        install.assert_not_called()

    def test_failed_upgrade_does_not_mark_old_runtime_ready_and_can_retry(self):
        self.runtime()
        setup.write_state('ready', dict(self.lock, version='0.3.0', commit='0' * 40))
        with patch.object(setup, 'install_release', side_effect=RuntimeError('download failed')):
            with self.assertRaisesRegex(RuntimeError, 'Desktop tools installation failed'):
                setup.provision(repair=True)
        self.assertEqual(setup.read_state()['state'], 'failed')
        # The old executable can still exist after a failed upgrade. It must not
        # become eligible for a repair-only run merely because state has the new pin.
        with patch.object(setup, 'run') as run, patch.object(setup, 'install_release') as install:
            setup.provision(repair=True)
        install.assert_called_once()
        run.assert_not_called()
        self.assertEqual(setup.read_state()['state'], 'ready')

    def test_missing_runtime_or_interrupted_attempt_reinstalls(self):
        for state in ('ready', 'installing', 'failed'):
            setup.write_state(state, self.lock)
            with patch.object(setup, 'install_release') as install:
                setup.provision()
            install.assert_called_once()

    def test_concurrent_attempt_does_not_replace_state(self):
        setup.write_state('ready', self.lock)
        with patch.object(setup.fcntl, 'flock', side_effect=BlockingIOError), self.assertRaisesRegex(RuntimeError, 'already running'):
            setup.provision()
        self.assertEqual(setup.read_state()['state'], 'ready')

    def test_bad_checksum_never_executes_download(self):
        calls = []
        def fake_run(args, _output):
            calls.append(args)
            Path(args[-1]).write_bytes(b'corrupt archive')
        with patch.object(setup, 'run', side_effect=fake_run), self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
            setup.install_release(self.lock, io.StringIO())
        self.assertEqual(len(calls), 1)

    def test_verified_source_invokes_upstream_all_agent_installer(self):
        content = io.BytesIO()
        with tarfile.open(fileobj=content, mode='w:gz') as archive:
            member = tarfile.TarInfo('luda-' + self.lock['commit'] + '/scripts/install.sh')
            member.size = 4
            archive.addfile(member, io.BytesIO(b'exit'))
        blob = content.getvalue()
        lock = dict(self.lock, sha256=hashlib.sha256(blob).hexdigest())
        calls = []
        def fake_run(args, _output):
            calls.append(args)
            if args[0] == 'curl':
                Path(args[-1]).write_bytes(blob)
            else:
                self.assertTrue(Path(args[1]).is_file())
        with patch.object(setup, 'run', side_effect=fake_run):
            setup.install_release(lock, io.StringIO())
        self.assertEqual(calls[1][2:], ['--prefix', str(setup.PREFIX), '--user', 'silo', '--agent', 'all', '--yes'])

    def test_archive_cannot_escape_expected_directory(self):
        content = io.BytesIO()
        with tarfile.open(fileobj=content, mode='w:gz') as archive:
            member = tarfile.TarInfo('../escaped')
            member.size = 1
            archive.addfile(member, io.BytesIO(b'x'))
        blob = content.getvalue()
        lock = dict(self.lock, sha256=hashlib.sha256(blob).hexdigest())
        with patch.object(setup, 'run', side_effect=lambda args, _: Path(args[-1]).write_bytes(blob)), self.assertRaisesRegex(RuntimeError, 'Invalid Luda source archive'):
            setup.install_release(lock, io.StringIO())

    def test_requires_root_and_new_account_before_mutation(self):
        self.account.stop()
        with patch.object(setup.os, 'geteuid', return_value=1001), self.assertRaisesRegex(RuntimeError, 'guest root'):
            setup.provision()
        with patch.object(setup.os, 'geteuid', return_value=0), self.assertRaisesRegex(RuntimeError, 'migrate this VM'):
            setup.provision()
        self.assertFalse((setup.STATE / 'luda.json').exists())


if __name__ == '__main__':
    unittest.main()
