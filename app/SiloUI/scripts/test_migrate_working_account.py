import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HERE = Path(__file__).resolve().parent
host = load('host_migration', HERE / 'migrate-working-account.py')
guest = load('guest_migration', HERE.parent / 'src-tauri/guest/migrate-working-account.py')


class MigrationTests(unittest.TestCase):
    def state(self, workspace):
        return {'status': 'Running', 'config': {'labels': {'silo.managed': 'true', 'silo.machine-id': 'fixture'}, 'mounts': [{'type': 'Tmpfs', 'guest': '/tmp'},
            {'type': 'DiskImage', 'host': str(workspace), 'guest': '/workspace', 'format': 'Raw', 'fstype': 'ext4'}]}}

    def test_dry_run_only_inspects(self):
        commands = []
        def run(args, **kwargs):
            commands.append(args)
            return subprocess.CompletedProcess(args, 0, '1' if args[1].startswith('--') else json.dumps(self.state('/fixture/disk.raw')), '')
        host.migrate('/msb', 'fixture', None, run=run)
        self.assertEqual(commands, [['/msb', '--silo-working-account-protocol'], ['/msb', 'inspect', 'fixture', '--format', 'json']])

    def test_failure_never_publishes_label_and_preserves_backup(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            workspace = root / 'disk.raw'
            workspace.write_bytes(b'private workspace')
            commands = []
            def run(args, **kwargs):
                commands.append(args)
                if args[1] == '--silo-working-account-protocol':
                    output = '1'
                elif args[1] == 'inspect':
                    output = json.dumps(self.state(workspace))
                elif args[1] == 'exec':
                    raise subprocess.CalledProcessError(1, args)
                else:
                    output = ''
                return subprocess.CompletedProcess(args, 0, output, '')
            with self.assertRaises(subprocess.CalledProcessError):
                host.migrate('/msb', 'fixture', root / 'backup', apply=True, run=run)
            self.assertEqual((root / 'backup/workspace.raw').read_bytes(), b'private workspace')
            self.assertNotIn('modify', [command[1] for command in commands])
            self.assertEqual(commands[-1], ['/msb', 'stop', 'fixture'])

    def test_credentials_binary_and_launcher_relocation(self):
        with tempfile.TemporaryDirectory() as root:
            source, destination = Path(root) / 'root', Path(root) / 'silo'
            (source / '.local/bin').mkdir(parents=True)
            (source / '.codex').mkdir()
            credential = b'{"token":"secret-/root/unchanged"}'
            (source / '.codex/auth.json').write_bytes(credential)
            (source / '.local/bin/tool').write_text('#!/root/.local/bin/python\nprint("ok")\n')
            (source / '.local/bin/python').symlink_to('/root/.local/python/bin/python')
            (source / '.local/bin/binary').write_bytes(b'\x00\xff/root/')
            guest.copy_home(source, destination)
            guest.copy_home(source, destination)
            self.assertEqual((destination / '.codex/auth.json').read_bytes(), credential)
            self.assertEqual((destination / '.local/bin/binary').read_bytes(), b'\x00\xff/root/')
            self.assertEqual((destination / '.local/bin/python').readlink(), Path('/home/silo/.local/python/bin/python'))
            self.assertTrue((destination / '.local/bin/tool').read_text().startswith('#!/home/silo/.local/bin/python'))
            self.assertTrue((source / '.local/bin/tool').read_text().startswith('#!/root/'))

    def test_home_copy_skips_transient_pipes_and_preserves_files(self):
        with tempfile.TemporaryDirectory() as root:
            source, destination = Path(root) / 'root', Path(root) / 'silo'
            source.mkdir()
            os.mkfifo(source / 'agent.pipe')
            (source / 'saved').write_text('saved work')
            guest.copy_home(source, destination)
            self.assertFalse((destination / 'agent.pipe').exists())
            self.assertEqual((destination / 'saved').read_text(), 'saved work')

    def test_sparse_disk_copy_preserves_bytes_and_length(self):
        with tempfile.TemporaryDirectory() as root:
            source, destination = Path(root) / 'source', Path(root) / 'copy'
            data = b'a' + bytes(2 * 1024 * 1024) + b'z'
            source.write_bytes(data)
            host.copy_disk(source, destination)
            self.assertEqual(destination.read_bytes(), data)
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)

    def test_resume_rejects_a_backup_from_another_vm_before_mutating(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            disk = root / 'workspace.raw'
            disk.write_bytes(b'work')
            backup = root / 'backup'
            backup.mkdir()
            saved = self.state(disk)
            saved['config']['labels']['silo.machine-id'] = 'another-vm'
            (backup / 'inspect.json').write_text(json.dumps(saved))
            commands = []
            def run(args, **kwargs):
                commands.append(args[1])
                output = '1' if args[1] == '--silo-working-account-protocol' else json.dumps(self.state(disk))
                return subprocess.CompletedProcess(args, 0, output, '')
            with self.assertRaisesRegex(ValueError, 'does not match'):
                host.migrate('/msb', 'fixture', backup, apply=True, run=run, resume=True)
            self.assertEqual(commands, ['--silo-working-account-protocol', 'inspect'])

    def test_resume_account_requires_original_reserved_identity(self):
        guest.validate_account(SimpleNamespace(pw_uid=1001, pw_gid=1001, pw_dir='/home/silo'))
        for values in [(0, 1001, '/home/silo'), (1001, 1000, '/home/silo'), (1001, 1001, '/root')]:
            with self.assertRaises(RuntimeError):
                guest.validate_account(SimpleNamespace(pw_uid=values[0], pw_gid=values[1], pw_dir=values[2]))

    def test_cli_preserves_short_runtime_alias(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            storage = root / 'long-runtime-storage-directory'
            storage.mkdir()
            alias = root / 'short'
            alias.symlink_to(storage, target_is_directory=True)
            with patch.dict(os.environ), patch.object(host, 'migrate') as migrate, patch('sys.argv', [
                    'migrate', 'fixture', '--msb', '/msb', '--runtime-home', str(alias)]):
                host.main()
                self.assertEqual(os.environ['MSB_HOME'], str(alias))
                migrate.assert_called_once()

    def test_agent_shell_setup_wins_over_desktop_defaults(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            agent, desktop, home = root / 'agent', root / 'desktop', root / 'home'
            agent.mkdir(); desktop.mkdir()
            (agent / '.bashrc').write_text('export PATH=/root/.local/bin:$PATH')
            (desktop / '.bashrc').write_text('# desktop defaults')
            guest.copy_home(agent, home)
            guest.copy_home(desktop, home)
            guest.copy_shell_setup(agent, home)
            self.assertEqual((home / '.bashrc').read_text(), 'export PATH=/home/silo/.local/bin:$PATH')
            self.assertIn('export PATH="$HOME/.local/bin:$PATH"', (home / '.profile').read_text())

    def test_shared_workspace_rejected(self):
        state = self.state('/fixture/shared')
        state['config']['mounts'][1]['type'] = 'Directory'
        with self.assertRaisesRegex(ValueError, 'standard ext4'):
            host.inspect_legacy(state)


if __name__ == '__main__':
    unittest.main()
