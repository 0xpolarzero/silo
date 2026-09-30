import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HERE = Path(__file__).resolve().parent
guest = load('guest_migration', HERE.parent / 'src-tauri/guest/migrate-working-account.py')


class GuestMigrationTests(unittest.TestCase):
    """The guest payload Silo sends unchanged. Host orchestration is tested in
    src-tauri/src/runtime/account_migration.rs."""

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

    def test_resume_account_requires_original_reserved_identity(self):
        guest.validate_account(SimpleNamespace(pw_uid=1001, pw_gid=1001, pw_dir='/home/silo'))
        for values in [(0, 1001, '/home/silo'), (1001, 1000, '/home/silo'), (1001, 1001, '/root')]:
            with self.assertRaises(RuntimeError):
                guest.validate_account(SimpleNamespace(pw_uid=values[0], pw_gid=values[1], pw_dir=values[2]))

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



if __name__ == '__main__':
    unittest.main()
