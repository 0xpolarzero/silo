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
        self.root = Path(directory.name).resolve()
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

    def test_utf8_decodable_binary_launcher_is_preserved_byte_for_byte(self):
        source, home = self.root / 'source', self.root / 'home'
        (source / '.local/bin').mkdir(parents=True)
        binary = b'\x00\x01/root/binary-data\n/home/silo-desktop/data'
        (source / '.local/bin/binary').write_bytes(binary)
        guest.copy_home(source, home)
        guest.copy_home(source, home)
        self.assertEqual((home / '.local/bin/binary').read_bytes(), binary)
        self.assertEqual((source / '.local/bin/binary').read_bytes(), binary)

    def test_home_copy_skips_transient_pipes_and_preserves_files(self):
        source, destination = self.root / 'root', self.root / 'silo'
        source.mkdir()
        os.mkfifo(source / 'agent.pipe')
        (source / 'saved').write_text('saved work')
        guest.copy_home(source, destination)
        self.assertFalse((destination / 'agent.pipe').exists())
        self.assertEqual((destination / 'saved').read_text(), 'saved work')

    def test_two_home_merge_preserves_external_directory_link_target(self):
        root, desktop, home, external = [self.root / name for name in ('root', 'desktop', 'home', 'external')]
        root.mkdir()
        external.mkdir()
        (desktop / '.config').mkdir(parents=True)
        sentinel = external / 'editor.json'
        sentinel.write_bytes(b'existing-workspace-settings')
        (root / '.config').symlink_to(external, target_is_directory=True)
        original = desktop / '.config/editor.json'
        original.write_bytes(b'legacy-desktop-settings')
        guest.copy_home(root, home)
        with self.assertRaisesRegex(RuntimeError, 'conflict.*\\.config'):
            guest.copy_home(desktop, home)
        self.assertEqual(sentinel.read_bytes(), b'existing-workspace-settings')
        self.assertEqual(original.read_bytes(), b'legacy-desktop-settings')
        self.assertEqual((home / '.config').readlink(), external)

    def test_retry_link_conflicts_are_preflighted_without_partial_copies(self):
        for kind in ('file', 'directory', 'nested', 'dangling'):
            with self.subTest(kind=kind):
                case = self.root / kind
                source, home, external = [case / name for name in ('source', 'home', 'external')]
                source.mkdir(parents=True)
                home.mkdir()
                external.mkdir()
                sentinel = external / 'sentinel'
                sentinel.write_bytes(b'outside-home')
                (source / 'a-new-file').write_bytes(b'new file')
                relative = Path('nested/link') if kind == 'nested' else Path('link')
                (source / relative).parent.mkdir(parents=True, exist_ok=True)
                (home / relative).parent.mkdir(parents=True, exist_ok=True)
                if kind == 'file':
                    (source / relative).write_bytes(b'legacy file')
                    (home / relative).symlink_to(sentinel)
                else:
                    (source / relative).mkdir()
                    (source / relative / 'sentinel').write_bytes(b'legacy file')
                    target = external / 'missing' if kind == 'dangling' else external
                    (home / relative).symlink_to(target, target_is_directory=True)
                for _ in range(2):
                    with self.assertRaisesRegex(RuntimeError, 'conflict.*link'):
                        guest.copy_home(source, home)
                    self.assertEqual(sentinel.read_bytes(), b'outside-home')
                    self.assertFalse((home / 'a-new-file').exists())
                    self.assertTrue((home / relative).is_symlink())
                    self.assertFalse((external / 'missing').exists())
                # The user preserves the conflicting link before retrying.
                retained = home / relative.with_name('retained-link')
                (home / relative).rename(retained)
                guest.copy_home(source, home)
                guest.copy_home(source, home)
                self.assertTrue(retained.is_symlink())
                self.assertEqual((home / 'a-new-file').read_bytes(), b'new file')
                self.assertEqual(sentinel.read_bytes(), b'outside-home')

    def test_source_link_does_not_replace_destination_directory(self):
        source, home = self.root / 'source', self.root / 'home'
        source.mkdir()
        (source / 'config').symlink_to('/root/config', target_is_directory=True)
        (home / 'config').mkdir(parents=True)
        (home / 'config/saved').write_bytes(b'existing data')
        with self.assertRaisesRegex(RuntimeError, 'conflict.*config'):
            guest.copy_home(source, home)
        self.assertEqual((source / 'config').readlink(), Path('/root/config'))
        self.assertEqual((home / 'config/saved').read_bytes(), b'existing data')

    def test_conflicting_regular_files_are_not_overwritten(self):
        source, home = self.root / 'source', self.root / 'home'
        source.mkdir()
        home.mkdir()
        (source / 'saved').write_bytes(b'legacy bytes')
        (home / 'saved').write_bytes(b'existing bytes')
        with self.assertRaisesRegex(RuntimeError, 'conflict.*saved'):
            guest.copy_home(source, home)
        self.assertEqual((source / 'saved').read_bytes(), b'legacy bytes')
        self.assertEqual((home / 'saved').read_bytes(), b'existing bytes')

    def test_file_directory_and_link_type_conflicts_preserve_entries(self):
        for kind in ('file-over-directory', 'directory-over-file', 'different-links'):
            with self.subTest(kind=kind):
                source, home = self.root / kind / 'source', self.root / kind / 'home'
                source.mkdir(parents=True)
                home.mkdir()
                if kind == 'file-over-directory':
                    (source / 'entry').write_bytes(b'legacy file')
                    (home / 'entry').mkdir()
                    (home / 'entry/saved').write_bytes(b'existing data')
                elif kind == 'directory-over-file':
                    (source / 'entry').mkdir()
                    (source / 'entry/saved').write_bytes(b'legacy data')
                    (home / 'entry').write_bytes(b'existing data')
                else:
                    (source / 'entry').symlink_to('/root/source')
                    (home / 'entry').symlink_to('/different/target')
                with self.assertRaisesRegex(RuntimeError, 'conflict.*entry'):
                    guest.copy_home(source, home)
                if kind == 'file-over-directory':
                    self.assertEqual((home / 'entry/saved').read_bytes(), b'existing data')
                elif kind == 'directory-over-file':
                    self.assertEqual((home / 'entry').read_bytes(), b'existing data')
                else:
                    self.assertEqual((source / 'entry').readlink(), Path('/root/source'))
                    self.assertEqual((home / 'entry').readlink(), Path('/different/target'))

    def test_interrupted_copy_resumes_without_replacing_completed_files(self):
        source, home = self.root / 'source', self.root / 'home'
        (source / '.local/bin').mkdir(parents=True)
        (source / '.local/bin/a-launcher').write_text('#!/root/.local/bin/python\n')
        (source / 'z-credential').write_bytes(b'\x00\xff/root/secret')
        copy = guest.shutil.copy2
        def interrupted(original, target):
            if original.name == 'z-credential':
                raise OSError('synthetic interrupted copy')
            return copy(original, target)
        with mock.patch.object(guest.shutil, 'copy2', side_effect=interrupted):
            with self.assertRaisesRegex(OSError, 'synthetic interrupted copy'):
                guest.copy_home(source, home)
        launcher = home / '.local/bin/a-launcher'
        self.assertEqual(launcher.read_text(), '#!/home/silo/.local/bin/python\n')
        with mock.patch.object(guest.shutil, 'copy2', wraps=copy) as copies:
            guest.copy_home(source, home)
        self.assertEqual([call.args[0].name for call in copies.call_args_list], ['z-credential'])
        self.assertEqual((home / 'z-credential').read_bytes(), b'\x00\xff/root/secret')

    def test_partial_file_copy_is_not_published_and_retry_succeeds(self):
        source, home = self.root / 'source', self.root / 'home'
        source.mkdir()
        original = source / 'credential'
        original.write_bytes(b'complete synthetic credential')
        def interrupted(original, target):
            Path(target).write_bytes(b'partial')
            raise OSError('synthetic interrupted copy')
        with mock.patch.object(guest.shutil, 'copy2', side_effect=interrupted):
            with self.assertRaisesRegex(OSError, 'synthetic interrupted copy'):
                guest.copy_home(source, home)
        self.assertFalse((home / 'credential').exists())
        self.assertEqual(list(home.iterdir()), [])
        guest.copy_home(source, home)
        self.assertEqual((home / 'credential').read_bytes(), original.read_bytes())

    def test_two_home_merge_copies_nonconflicting_files_and_keeps_unrelated_links(self):
        root, desktop, home, external = [self.root / name for name in ('root', 'desktop', 'home', 'external')]
        (root / '.codex').mkdir(parents=True)
        (desktop / '.config').mkdir(parents=True)
        (home / '.local/bin').mkdir(parents=True)
        external.write_text('#!/root/tool\n')
        (home / '.local/bin/unrelated').symlink_to(external)
        credential = b'{"token":"secret-/root/unchanged"}'
        (root / '.codex/auth.json').write_bytes(credential)
        (desktop / '.config/settings').write_bytes(b'\x00\xff/root/settings')
        for _ in range(2):
            guest.copy_home(root, home)
            guest.copy_home(desktop, home)
        self.assertEqual((home / '.codex/auth.json').read_bytes(), credential)
        self.assertEqual((home / '.config/settings').read_bytes(), b'\x00\xff/root/settings')
        self.assertEqual((home / '.local/bin/unrelated').readlink(), external)
        self.assertEqual(external.read_text(), '#!/root/tool\n')

    def test_destination_home_and_ancestors_cannot_be_links(self):
        source, external = self.root / 'source', self.root / 'external'
        source.mkdir()
        external.mkdir()
        (source / 'saved').write_bytes(b'legacy bytes')
        linked = self.root / 'linked'
        linked.symlink_to(external, target_is_directory=True)
        for home in (linked, linked / 'nested-home'):
            with self.assertRaisesRegex(RuntimeError, 'conflict.*linked'):
                guest.copy_home(source, home)
            self.assertEqual(list(external.iterdir()), [])

    def test_shell_setup_preserves_conflicting_links(self):
        source, home, external = self.root / 'source', self.root / 'home', self.root / 'external'
        source.mkdir()
        home.mkdir()
        external.write_bytes(b'outside-home')
        (source / '.bashrc').write_text('export PATH=/root/.local/bin:$PATH')
        (home / '.bashrc').symlink_to(external)
        with self.assertRaisesRegex(RuntimeError, 'conflict.*\\.bashrc'):
            guest.copy_shell_setup(source, home)
        self.assertTrue((home / '.bashrc').is_symlink())
        self.assertEqual(external.read_bytes(), b'outside-home')

    def test_shell_setup_replaces_home_entry_without_overwriting_hardlink_target(self):
        source, home, external = self.root / 'source', self.root / 'home', self.root / 'external'
        source.mkdir()
        home.mkdir()
        original = source / '.bashrc'
        original.write_text('export PATH=/root/.local/bin:$PATH')
        external.write_bytes(b'existing external shell setup')
        os.link(external, home / '.bashrc')
        guest.copy_shell_setup(source, home)
        self.assertEqual(external.read_bytes(), b'existing external shell setup')
        self.assertEqual((home / '.bashrc').read_text(), 'export PATH=/home/silo/.local/bin:$PATH')
        self.assertEqual(original.read_text(), 'export PATH=/root/.local/bin:$PATH')

    def test_interrupted_shell_setup_preserves_existing_file_and_retries(self):
        source, home = self.root / 'source', self.root / 'home'
        source.mkdir()
        home.mkdir()
        (source / '.profile').write_text('# /root/tools\n')
        target = home / '.profile'
        target.write_bytes(b'existing shell setup')
        def interrupted(original, target):
            Path(target).write_bytes(b'partial')
            raise OSError('synthetic interrupted copy')
        with mock.patch.object(guest.shutil, 'copy2', side_effect=interrupted):
            with self.assertRaisesRegex(OSError, 'synthetic interrupted copy'):
                guest.copy_shell_setup(source, home)
        self.assertEqual(target.read_bytes(), b'existing shell setup')
        guest.copy_shell_setup(source, home)
        self.assertEqual(target.read_text(), '# /home/silo/tools\n' + guest.PATH_SETUP)

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

    def test_shell_setup_relocates_paths_without_decoding_or_changing_other_bytes(self):
        source, home = self.root / 'source', self.root / 'home'
        source.mkdir()
        originals = {
            '.bashrc': b'# caf\xe9\r\nexport PATH=/root/.local/bin:$PATH\r\n',
            '.profile': b'# caf\xe9\nexport TOOL=/home/silo-desktop/bin/tool\n',
        }
        for name, contents in originals.items():
            (source / name).write_bytes(contents)
        for _ in range(2):
            guest.copy_home(source, home)
            guest.copy_shell_setup(source, home)
        for name, contents in originals.items():
            expected = contents.replace(b'/root/', b'/home/silo/').replace(
                b'/home/silo-desktop/', b'/home/silo/')
            if name == '.profile':
                expected += guest.PATH_SETUP.encode('utf-8')
            self.assertEqual((home / name).read_bytes(), expected)
            self.assertEqual((source / name).read_bytes(), contents)


if __name__ == '__main__':
    unittest.main()
