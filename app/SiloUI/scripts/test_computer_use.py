import fcntl
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).parents[1] / 'src-tauri/guest/silo-computer-use.py'
SPEC = importlib.util.spec_from_file_location('silo_computer_use', SCRIPT)
cu = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cu)
REAL_RUN = cu.run

APP_DIR = '26.928.31416-arm64'
ARCHIVE = 'lcu-0.8.0-linux-arm64.tar.gz'


def make_archive(directory):
    """A release archive with the one file the installer step needs."""
    path = Path(directory) / ARCHIVE
    root = 'lcu-0.8.0-linux-arm64'
    with tarfile.open(path, 'w:gz') as archive:
        for name, body, mode in ((f'{root}/scripts/install.sh', b'#!/bin/sh\n', 0o755),
                                 (f'{root}/README.md', b'lcu\n', 0o644)):
            info = tarfile.TarInfo(name)
            info.size = len(body)
            info.mode = mode
            archive.addfile(info, io.BytesIO(body))
    return path, hashlib.sha256(path.read_bytes()).hexdigest()


class Guest(unittest.TestCase):
    """A fake guest: temp state/mount/image directories and scripted lcu commands."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.state = root / 'state'
        self.mount = root / 'mount'
        self.image = root / 'image'
        for directory in (self.state, self.mount / APP_DIR, self.image):
            directory.mkdir(parents=True)
        self.archive, self.sha = make_archive(self.image)
        # What the pinned URL serves (kept outside the image directory).
        self.served = root / 'served.tar.gz'
        self.served.write_bytes(self.archive.read_bytes())
        self.commands = []
        self.lcu_status = {'lcu_version': '0.8.0', 'setup': {'approval': 'ask'},
                           'compatibility': {'status': 'tested', 'warning': None},
                           'app': {'path': str(self.mount / APP_DIR), 'version': '26.928.31416',
                                   'runtime': '0.0.27/20260927214556-b77d38801cca'}}
        self.setup_output = 'Claude Code: MCP registered.\nCodex: MCP registered.\nCodex: hooks registered.\n'
        self.failures = {}
        # The desktop session: True (running), False (still starting), a state name, or
        # a list of states reported in turn (the last one repeats).
        self.session = True
        # What a `silo-desktop start` does to the session (None: nothing).
        self.start_effect = None
        self.autostart = True
        self.installed = False
        patches = [
            mock.patch.object(cu, 'STATE', self.state),
            mock.patch.object(cu, 'PINNED', self.state / 'pinned.json'),
            mock.patch.object(cu, 'APPROVAL', self.state / 'approval.json'),
            mock.patch.object(cu, 'RECEIPT', self.state / 'receipt.json'),
            mock.patch.object(cu, 'LOCK', self.state / 'lock'),
            mock.patch.object(cu, 'STAGE', self.state / 'stage'),
            mock.patch.object(cu, 'LOG', root / 'log'),
            mock.patch.object(cu, 'IMAGE_DIR', self.image),
            mock.patch.object(cu, 'MOUNT', self.mount),
            mock.patch.object(cu, 'PREFIX', root / 'opt-lcu'),
            mock.patch.object(cu, 'mount_state', lambda *a, **k: self.mount_state),
            mock.patch.object(cu, 'desktop_session', self.fake_session),
            mock.patch.object(cu, 'DESKTOP_CONFIG', root / 'desktop-config.json'),
            mock.patch.object(cu, 'run', self.fake_run),
            # Files written by the tests are owned by the test user, not root.
            mock.patch.object(cu, 'read_json', self.read_json),
            mock.patch.object(cu.time, 'sleep', lambda *_: None),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.mount_state = 'ok'
        self.write_pinned()
        (root / 'desktop-config.json').write_text(json.dumps({'autoStart': True}))

    def fake_session(self):
        value = self.session
        if isinstance(value, list):
            return value.pop(0) if len(value) > 1 else value[0]
        if value is True:
            return 'running'
        return 'starting' if value is False else value

    @staticmethod
    def read_json(path):
        try:
            value = json.loads(Path(path).read_text())
        except (OSError, ValueError):
            return None
        return value if isinstance(value, dict) else None

    def write_pinned(self, **lcu):
        pinned = {'schemaVersion': 1,
                  'app': {'dir': APP_DIR, 'version': '26.928.31416', 'runtime': '0.0.27/20260927214556-b77d38801cca'},
                  'lcu': {'version': '0.8.0', 'archive': ARCHIVE, 'sha256': self.sha,
                          'url': 'https://example.invalid/' + ARCHIVE}}
        pinned['lcu'].update(lcu)
        (self.state / 'pinned.json').write_text(json.dumps(pinned))

    def fake_run(self, argv, *, user=False, timeout=900, check=True, cwd=None, extra_env=None, quiet=False):
        self.commands.append((list(argv), bool(user), cwd))
        name = Path(argv[0]).name
        if name == 'tar':
            return REAL_RUN(argv, timeout=timeout, check=check, quiet=quiet)
        key = ' '.join(argv[1:3]) if name == 'lcu' else name
        failure = self.failures.get(name) or self.failures.get(key)
        if failure:
            if check and failure != 'soft':
                raise cu.Failure('command-failed', name)
            return subprocess.CompletedProcess(argv, 1, stdout='', stderr='')
        if name == 'silo-desktop':
            if argv[1:2] == ['start'] and self.start_effect is not None:
                self.session = self.start_effect
            return subprocess.CompletedProcess(argv, 0, stdout='', stderr='')
        if name == 'install.sh':
            self.installed = True
            (cu.PREFIX / 'current/bin').mkdir(parents=True, exist_ok=True)
            (cu.PREFIX / 'current/bin/lcu').write_text('#!/bin/sh\n')
        if name == 'lcu' and argv[1:3] == ['status', '--json']:
            if not self.installed:
                return subprocess.CompletedProcess(argv, 1, stdout='', stderr='')
            return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(self.lcu_status), stderr='')
        if name == 'lcu' and argv[1:2] == ['setup']:
            return subprocess.CompletedProcess(argv, 0, stdout=self.setup_output, stderr='')
        if name == 'curl':
            Path(argv[argv.index('--output') + 1]).write_bytes(self.served.read_bytes())
        return subprocess.CompletedProcess(argv, 0, stdout='', stderr='')

    def lcu_commands(self):
        return [argv for argv, *_ in self.commands if Path(argv[0]).name in ('lcu', 'lcu-session')
                or Path(argv[0]).name == 'install.sh' or 'install.sh' in argv[0]]

    def receipt(self):
        return json.loads((self.state / 'receipt.json').read_text())


class Status(Guest):
    def test_without_the_pinned_pair_nothing_is_configured(self):
        (self.state / 'pinned.json').unlink()
        self.assertEqual(cu.status()['state'], 'not-set-up')
        self.assertEqual(cu.status()['reason'], 'not-configured')

    def test_a_malformed_pair_is_ignored(self):
        for lcu in ({'sha256': 'abc'}, {'archive': '../x.tar.gz'}, {'version': '$(id)'}):
            self.write_pinned(**lcu)
            self.assertIsNone(cu.load_pinned(), lcu)
        self.write_pinned()
        pinned = json.loads((self.state / 'pinned.json').read_text())
        pinned['app']['dir'] = '../../etc'
        (self.state / 'pinned.json').write_text(json.dumps(pinned))
        self.assertIsNone(cu.load_pinned())

    def test_a_missing_app_folder_needs_the_app(self):
        (self.mount / APP_DIR).rmdir()
        result = cu.status()
        self.assertEqual((result['state'], result['reason']), ('needs-app', 'app-missing'))

    def test_a_symlinked_app_folder_is_not_present(self):
        (self.mount / APP_DIR).rmdir()
        (self.mount / APP_DIR).symlink_to(self.image)
        self.assertEqual(cu.status()['state'], 'needs-app')

    def test_status_reads_the_receipt_only(self):
        cu.sync()
        self.commands.clear()
        result = cu.status()
        self.assertEqual(self.commands, [], 'status never runs LCU')
        self.assertEqual(result['state'], 'ready')
        self.assertEqual(result['compatibility'], 'tested')
        self.assertEqual(result['appVersion'], '26.928.31416')
        self.assertEqual(result['lcuVersion'], '0.8.0')
        self.assertEqual(result['agents'], ['claude-code', 'codex'])
        self.assertEqual(result['approval'], 'ask')

    def test_a_receipt_for_another_pair_does_not_count(self):
        cu.sync()
        self.write_pinned(version='0.8.1')
        self.assertEqual(cu.status()['state'], 'not-set-up')

    def test_a_held_lock_means_installing_and_a_stale_installing_receipt_failed(self):
        cu.write_receipt(cu.load_pinned(), 'ask', 'installing')
        self.assertEqual(cu.status()['reason'], 'interrupted')
        with open(self.state / 'lock', 'a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            self.assertEqual(cu.status()['state'], 'installing')

    def test_the_mount_must_be_read_only_and_present(self):
        cu.sync()
        for mount in ('missing', 'writable'):
            self.mount_state = mount
            result = cu.status()
            self.assertEqual((result['state'], result['reason']), ('failed', 'mount-' + mount))

    def test_mount_state_parses_proc_mounts(self):
        mounts = Path(self.tmp.name) / 'mounts'
        target = '/opt/silo/chatgpt'
        mounts.write_text(f'virtiofs {target} virtiofs ro,relatime 0 0\n')
        self.assertEqual(REAL_MOUNT_STATE(Path(target), mounts), 'ok')
        mounts.write_text(f'virtiofs {target} virtiofs rw,relatime 0 0\n')
        self.assertEqual(REAL_MOUNT_STATE(Path(target), mounts), 'writable')
        mounts.write_text('tmpfs /tmp tmpfs rw 0 0\n')
        self.assertEqual(REAL_MOUNT_STATE(Path(target), mounts), 'missing')
        self.assertEqual(REAL_MOUNT_STATE(Path(target), Path(self.tmp.name) / 'absent'), 'missing')


REAL_MOUNT_STATE = cu.mount_state


class Sync(Guest):
    def test_first_sync_installs_in_place_sets_up_and_checks_the_doctor(self):
        result = cu.sync()
        self.assertEqual(result['state'], 'ready')
        names = [Path(argv[0]).name for argv in self.lcu_commands()]
        self.assertEqual(names, ['install.sh', 'lcu', 'lcu', 'lcu-session'])
        install = next(argv for argv in self.lcu_commands() if argv[0].endswith('install.sh'))
        self.assertEqual(install[1:], ['--user', 'silo', '--runtime-only', '--skip-system', '--offline',
                                       '--existing-app', str(self.mount / APP_DIR), '--yes'])
        setup, = [(argv, user) for argv, user, _ in self.commands if argv[1:2] == ['setup']]
        self.assertEqual(setup[0][1:], ['setup', '--agent', 'auto', '--session', 'direct', '--yes',
                                        '--approval', 'ask'])
        self.assertTrue(setup[1], 'setup runs as the working account')
        doctor = self.lcu_commands()[-1]
        self.assertTrue([user for argv, user, _ in self.commands if argv == doctor][0],
                        'the session launcher runs as the desktop account')
        self.assertEqual(doctor[1:], ['--user', 'silo', '--', str(cu.PREFIX / 'current/bin/lcu'),
                                      'doctor', '--non-interactive', '--require-ready'])
        receipt = self.receipt()
        self.assertEqual((receipt['state'], receipt['readiness'], receipt['approval']), ('ready', 'ready', 'ask'))
        self.assertEqual(receipt['archiveSha256'], self.sha)

    def test_the_archive_is_extracted_on_local_disk_and_cleaned_up(self):
        cu.sync()
        install_cwd = next(cwd for argv, _, cwd in self.commands if argv[0].endswith('install.sh'))
        self.assertTrue(str(install_cwd).startswith(str(self.state / 'stage')))
        self.assertFalse((self.state / 'stage').exists())

    def test_an_up_to_date_vm_runs_nothing(self):
        cu.sync()
        self.commands.clear()
        result = cu.sync(boot=True)
        self.assertEqual(result['state'], 'ready')
        self.assertEqual(self.commands, [])

    def test_a_changed_approval_reruns_setup_only(self):
        cu.sync()
        self.commands.clear()
        result = cu.sync(approval='auto')
        self.assertEqual(result['approval'], 'auto')
        self.assertEqual(json.loads((self.state / 'approval.json').read_text())['approval'], 'auto')
        names = [Path(argv[0]).name for argv in self.lcu_commands()]
        self.assertNotIn('install.sh', names)
        setup = next(argv for argv, *_ in self.commands if argv[1:2] == ['setup'])
        self.assertEqual(setup[-2:], ['--approval', 'auto'])
        # An explicit ask is applied too (it removes the entries).
        cu.sync(approval='ask')
        self.assertEqual(self.receipt()['approval'], 'ask')

    def test_a_delayed_older_approval_never_undoes_a_newer_one(self):
        cu.sync(approval='auto', revision=5)
        self.commands.clear()
        # A boot sync launched earlier with the old mode arrives after the change to ask.
        cu.sync(approval='ask', revision=7)
        result = cu.sync(boot=True, approval='auto', revision=5)
        self.assertEqual((result['approval'], result['approvalRevision']), ('ask', 7))
        record = json.loads((self.state / 'approval.json').read_text())
        self.assertEqual((record['approval'], record['revision']), ('ask', 7))
        self.assertEqual(self.receipt()['approval'], 'ask')
        # The same revision is idempotent; a newer one wins.
        self.assertEqual(cu.sync(approval='ask', revision=7)['approvalRevision'], 7)
        self.assertEqual(cu.sync(approval='auto', revision=8)['approval'], 'auto')

    def test_an_unrevised_request_keeps_the_applied_revision(self):
        cu.sync(approval='auto', revision=5)
        self.assertEqual(cu.sync(approval='ask')['approvalRevision'], 5)

    def test_force_reruns_setup_for_agents_installed_later(self):
        cu.sync()
        self.commands.clear()
        cu.sync(force=True)
        self.assertTrue(any(argv[1:2] == ['setup'] for argv, *_ in self.commands))
        self.assertFalse(any(argv[0].endswith('install.sh') for argv, *_ in self.commands))

    def test_agents_are_the_ones_setup_confirmed(self):
        self.assertEqual(cu.registered_agents(self.setup_output), ['claude-code', 'codex'])
        self.assertEqual(cu.registered_agents('Pi: extension registered.\nOh My Pi: plugin registered.\n'),
                         ['oh-my-pi', 'pi'])
        self.assertEqual(cu.registered_agents('Codex: MCP failed: boom\nNo agents detected\n'), [])
        self.setup_output = ''
        self.assertEqual(cu.sync()['agents'], [])

    def test_lcu_installed_for_another_app_folder_is_installed_again(self):
        cu.sync()
        self.lcu_status['app']['path'] = '/somewhere/else'
        self.commands.clear()
        cu.sync(force=True)
        self.assertTrue(any(argv[0].endswith('install.sh') for argv, *_ in self.commands))

    def test_a_new_app_folder_installs_again_against_it(self):
        cu.sync()
        (self.mount / '26.929.1-arm64').mkdir()
        pinned = json.loads((self.state / 'pinned.json').read_text())
        pinned['app']['dir'] = '26.929.1-arm64'
        (self.state / 'pinned.json').write_text(json.dumps(pinned))
        self.commands.clear()
        cu.sync()
        install = next(argv for argv, *_ in self.commands if argv[0].endswith('install.sh'))
        self.assertEqual(install[install.index('--existing-app') + 1], str(self.mount / '26.929.1-arm64'))

    def test_a_missing_app_folder_installs_nothing(self):
        (self.mount / APP_DIR).rmdir()
        result = cu.sync()
        self.assertEqual(result['state'], 'needs-app')
        self.assertEqual(self.commands, [])

    def test_a_missing_mount_installs_nothing(self):
        self.mount_state = 'missing'
        self.assertEqual(cu.sync()['reason'], 'mount-missing')
        self.assertEqual(self.commands, [])

    def test_untested_pairs_are_reported_not_blocked(self):
        self.lcu_status['compatibility'] = {'status': 'untested', 'warning': 'Not tested with this app.'}
        result = cu.sync()
        self.assertEqual((result['state'], result['compatibility']), ('ready', 'untested'))
        self.assertEqual(result['warning'], 'Not tested with this app.')

    def test_a_failed_install_is_recorded_and_retried(self):
        self.failures['install.sh'] = True
        result = cu.sync()
        self.assertEqual((result['state'], result['reason']), ('failed', 'command-failed'))
        self.failures.clear()
        self.assertEqual(cu.sync()['state'], 'ready')

    def test_a_failed_doctor_fails_the_setup(self):
        self.failures['lcu-session'] = 'soft'
        result = cu.sync()
        self.assertEqual((result['state'], result['reason']), ('failed', 'doctor-failed'))

    def test_a_desktop_that_never_starts_fails_the_setup(self):
        self.session = False
        times = iter(range(0, 10_000, 100))
        with mock.patch.object(cu.time, 'monotonic', lambda: next(times)):
            result = cu.sync(boot=True)
        self.assertEqual((result['state'], result['reason']), ('failed', 'desktop-session-not-running'))

    def desktop_starts(self):
        return [argv for argv, *_ in self.commands if argv[:2] == [cu.DESKTOP_COMMAND, 'start']]

    def test_a_session_that_failed_during_boot_is_started_again_before_the_doctor(self):
        # The boot hook's desktop start failed (a stale PulseAudio pid file in the log):
        # the session is `failed` when the helper looks, and `start` brings it back.
        self.session = 'failed'
        self.start_effect = 'running'
        result = cu.sync(boot=True)
        self.assertEqual(result['state'], 'ready')
        self.assertEqual(len(self.desktop_starts()), 1)
        self.assertLess(self.commands.index(next(c for c in self.commands if c[0] == self.desktop_starts()[0])),
                        self.commands.index(next(c for c in self.commands if c[0][0].endswith('lcu-session'))),
                        'the doctor runs only once the session exists')

    def test_a_session_still_starting_is_waited_for_without_starting_it_again(self):
        self.session = ['starting', 'starting', 'starting', 'running']
        result = cu.sync(boot=True)
        self.assertEqual(result['state'], 'ready')
        self.assertEqual(self.desktop_starts(), [])

    def test_repair_waits_with_backoff_and_gives_up_after_three_starts(self):
        self.session = 'failed'
        slept = []
        with mock.patch.object(cu.time, 'sleep', slept.append):
            result = cu.sync(boot=True)
        self.assertEqual((result['state'], result['reason']), ('failed', 'desktop-session-not-running'))
        self.assertEqual(len(self.desktop_starts()), cu.SESSION_REPAIR_ATTEMPTS)
        self.assertEqual([n for n in slept if n >= cu.SESSION_REPAIR_BASE][:3], [2, 4, 8])
        self.assertFalse(any(c[0][0].endswith('lcu-session') for c in self.commands), 'no doctor without a session')

    def test_a_stopped_session_is_not_restarted_when_the_desktop_is_manual(self):
        (Path(self.tmp.name) / 'desktop-config.json').write_text(json.dumps({'autoStart': False}))
        self.session = 'stopped'
        times = iter(range(0, 10_000, 100))
        with mock.patch.object(cu.time, 'monotonic', lambda: next(times)):
            result = cu.sync(boot=True)
        self.assertEqual((result['state'], result['reason']), ('failed', 'desktop-session-not-running'))
        self.assertEqual(self.desktop_starts(), [])

    def test_a_later_sync_never_restarts_a_desktop_the_user_stopped(self):
        self.session = 'stopped'
        times = iter(range(0, 10_000, 100))
        with mock.patch.object(cu.time, 'monotonic', lambda: next(times)):
            result = cu.sync()
        self.assertEqual((result['state'], result['reason']), ('failed', 'desktop-session-not-running'))
        self.assertEqual(self.desktop_starts(), [])

    def test_a_staged_archive_that_does_not_match_is_downloaded_and_verified(self):
        # The staged file no longer matches the lock, so the pinned URL is used.
        (self.image / ARCHIVE).write_bytes(b'tampered')
        result = cu.sync()
        self.assertEqual(result['state'], 'ready')
        self.assertTrue(any(argv[0] == 'curl' for argv, *_ in self.commands))

    def test_an_archive_that_cannot_be_obtained_fails_clearly(self):
        (self.image / ARCHIVE).unlink()
        self.failures['curl'] = True
        result = cu.sync()
        self.assertEqual((result['state'], result['reason']), ('failed', 'lcu-archive-unavailable'))

    def test_a_downloaded_archive_with_the_wrong_hash_is_refused(self):
        (self.image / ARCHIVE).unlink()
        self.write_pinned(sha256='0' * 64)
        result = cu.sync()
        self.assertEqual((result['state'], result['reason']), ('failed', 'lcu-archive-mismatch'))
        self.assertFalse(any(argv[0].endswith('install.sh') for argv, *_ in self.commands))

    def test_archive_members_outside_the_release_folder_are_refused(self):
        bad = Path(self.tmp.name) / 'bad.tar.gz'
        with tarfile.open(bad, 'w:gz') as archive:
            info = tarfile.TarInfo('../escape')
            info.size = 0
            archive.addfile(info, io.BytesIO(b''))
        with self.assertRaises(cu.Failure) as caught:
            cu.extract(bad, self.state, 'lcu-0.8.0-linux-arm64')
        self.assertEqual(caught.exception.reason, 'lcu-archive-invalid')

    def test_a_concurrent_sync_waits_then_finds_it_done(self):
        cu.sync()
        self.commands.clear()
        # Another process finished the work while this one waited for the lock.
        self.assertEqual(cu.sync(boot=True)['state'], 'ready')
        self.assertEqual(self.commands, [])

    def test_the_digest_reads_the_documented_status_fields(self):
        report = cu.digest(self.lcu_status)
        self.assertEqual(report['compatibility'], 'tested')
        self.assertEqual(report['appVersion'], '26.928.31416')
        self.assertNotIn('agents', report)
        empty = cu.digest(None)
        self.assertEqual(empty['compatibility'], 'unknown')
        hostile = cu.digest({'compatibility': {'status': 'x', 'warning': 'a\x1b[31m' + 'b' * 999},
                             'app': {'version': '$(id)'}})
        self.assertEqual(hostile['compatibility'], 'unknown')
        self.assertIsNone(hostile['appVersion'])
        self.assertLessEqual(len(hostile['warning']), 300)


class CommandLine(Guest):
    def test_main_prints_status_and_requires_root(self):
        with mock.patch.object(cu.os, 'geteuid', return_value=0), mock.patch('builtins.print') as shown:
            self.assertEqual(cu.main(['status']), 0)
        self.assertEqual(json.loads(shown.call_args.args[0])['state'], 'not-set-up')
        with mock.patch.object(cu.os, 'geteuid', return_value=1000):
            self.assertEqual(cu.main(['status']), 1)


if __name__ == '__main__':
    unittest.main()
