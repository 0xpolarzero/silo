import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('working_account', HERE.parent / 'src-tauri/guest/working-account.py')
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


class WorkingAccountTests(unittest.TestCase):
    """The guest setup Silo runs after a boot. Linux account changes are proven by
    scripts/test-working-account-live.py; the host side by working_account.rs."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        # Distribution defaults for root's dotfiles, as in /usr/share/base-files.
        self.defaults = self.root / 'base-files'
        self.defaults.mkdir()
        (self.defaults / 'dot.bashrc').write_text('# default root bashrc\n')
        (self.defaults / 'dot.profile').write_text('# default root profile\n')
        patched = mock.patch.object(guest.carried, '__defaults__', (self.defaults,))
        patched.start()
        self.addCleanup(patched.stop)

    def test_credentials_binary_and_launcher_relocation(self):
        source, destination = self.root / 'root', self.root / 'silo'
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
        source, destination = self.root / 'root', self.root / 'silo'
        source.mkdir()
        os.mkfifo(source / 'agent.pipe')
        (source / 'saved').write_text('saved work')
        guest.copy_home(source, destination)
        self.assertFalse((destination / 'agent.pipe').exists())
        self.assertEqual((destination / 'saved').read_text(), 'saved work')

    def test_resumed_account_requires_the_reserved_identity(self):
        guest.validate_account(SimpleNamespace(pw_uid=1001, pw_gid=1001, pw_dir='/home/silo'))
        for values in [(0, 1001, '/home/silo'), (1001, 1000, '/home/silo'), (1001, 1001, '/root')]:
            with self.assertRaises(RuntimeError):
                guest.validate_account(SimpleNamespace(pw_uid=values[0], pw_gid=values[1], pw_dir=values[2]))

    def test_agent_shell_setup_wins_over_desktop_defaults(self):
        agent, desktop, home = self.root / 'agent', self.root / 'desktop', self.root / 'home'
        agent.mkdir()
        desktop.mkdir()
        (agent / '.bashrc').write_text('export PATH=/root/.local/bin:$PATH')
        (agent / '.profile').write_text('# agent profile\n')
        (desktop / '.bashrc').write_text('# desktop defaults')
        for _ in range(2):
            guest.copy_home(agent, home)
            guest.copy_home(desktop, home)
            guest.copy_shell_setup(agent, home)
        self.assertEqual((home / '.bashrc').read_text(), 'export PATH=/home/silo/.local/bin:$PATH')
        self.assertEqual((home / '.profile').read_text(), '# agent profile\n' + guest.PATH_SETUP)

    def test_a_new_account_keeps_its_own_shell_setup(self):
        root, home = self.root / 'root', self.root / 'home'
        root.mkdir()
        home.mkdir()
        # An unchanged root dotfile carries nothing; the account's own (from /etc/skel) stays.
        (root / '.bashrc').write_text('# default root bashrc\n')
        (root / '.profile').write_text('# default root profile\n')
        (home / '.bashrc').write_text('# skeleton bashrc\n')
        (home / '.profile').write_text('# skeleton profile\n')
        (root / '.gitconfig').write_text('[user]\n')
        guest.copy_home(root, home)
        guest.copy_shell_setup(root, home)
        self.assertEqual((home / '.bashrc').read_text(), '# skeleton bashrc\n')
        self.assertEqual((home / '.profile').read_text(), '# skeleton profile\n')
        self.assertEqual((home / '.gitconfig').read_text(), '[user]\n')
        self.assertFalse(guest.carried(root / '.bashrc'))
        (root / '.bashrc').write_text('# default root bashrc\nexport PATH=/root/.bun/bin:$PATH\n')
        self.assertTrue(guest.carried(root / '.bashrc'))


if __name__ == '__main__':
    unittest.main()
