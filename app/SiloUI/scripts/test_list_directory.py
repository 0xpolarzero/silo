"""Guest folder listing: UTF-8-safe names and bounded output, without a VM."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'src-tauri/guest/list-directory.py'
spec = importlib.util.spec_from_file_location('list_directory', SOURCE)
listing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(listing)


class FakeEntry:
    def __init__(self, name, directory=False, link=False):
        self.name = name
        self.directory = directory
        self.link = link

    def is_symlink(self):
        return self.link

    def is_dir(self, follow_symlinks=True):
        return self.directory


class FakeScan(list):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def records(output):
    parts = output.split(b'\0')
    return parts[0], list(zip(parts[1:-1:2], parts[2:-1:2]))


class ListDirectory(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = os.path.realpath(self.temp.name)
        cwd = os.getcwd()
        self.addCleanup(os.chdir, cwd)

    def run_script(self, path):
        # Exactly how files.rs runs it: `python3 -I -c <source> <path>`.
        return subprocess.run([sys.executable, '-I', '-c', SOURCE.read_text(), path],
                              check=True, capture_output=True).stdout

    def test_lists_kinds_without_following_links(self):
        os.mkdir(os.path.join(self.root, 'folder'))
        Path(self.root, 'a\nb').write_text('x')
        os.symlink('folder', os.path.join(self.root, 'link'))
        status, entries = records(self.run_script(self.root))
        self.assertEqual(status, b'ok')
        self.assertEqual(sorted(entries), [(b'd', b'folder'), (b'f', b'a\nb'), (b'l', b'link')])

    def test_reports_missing_invalid_and_symlinked_folders(self):
        Path(self.root, 'file').write_text('x')
        os.mkdir(os.path.join(self.root, 'real'))
        os.symlink('real', os.path.join(self.root, 'alias'))
        self.assertEqual(self.run_script(os.path.join(self.root, 'absent')), b'missing\0')
        self.assertEqual(self.run_script(os.path.join(self.root, 'file')), b'invalid\0')
        self.assertEqual(self.run_script(os.path.join(self.root, 'alias')), b'invalid\0')
        self.assertEqual(self.run_script(os.path.join(self.root, 'real')), b'ok\0')

    def test_undecodable_names_are_escaped_and_never_openable(self):
        scan = FakeScan([FakeEntry(b'caf\xe9', directory=True), FakeEntry('日本語'.encode())])
        with patch.object(listing.os, 'scandir', return_value=scan):
            status, entries = records(listing.listing(self.root))
        self.assertEqual(status, b'ok')
        # The whole output stays valid UTF-8 so the host can decode it.
        self.assertEqual(entries, [(b'u', b'caf\\xe9'), (b'f', '日本語'.encode())])
        for _, name in entries:
            name.decode('utf-8')

    def test_real_undecodable_name_when_the_filesystem_allows_it(self):
        try:
            with open(os.path.join(os.fsencode(self.root), b'bad\xff'), 'wb'):
                pass
        except OSError:
            self.skipTest('this filesystem requires UTF-8 names')
        status, entries = records(self.run_script(self.root))
        self.assertEqual((status, entries), (b'ok', [(b'u', b'bad\\xff')]))

    def test_oversized_folders_report_large_before_the_host_output_cap(self):
        many = FakeScan(FakeEntry(str(index).encode()) for index in range(listing.MAX_ENTRIES + 1))
        with patch.object(listing.os, 'scandir', return_value=many):
            self.assertEqual(listing.listing(self.root), b'large\0')
        long_names = FakeScan(FakeEntry(b'x' * 255) for _ in range(5000))
        with patch.object(listing.os, 'scandir', return_value=long_names):
            self.assertEqual(listing.listing(self.root), b'large\0')
        exact = FakeScan(FakeEntry(str(index).encode()) for index in range(listing.MAX_ENTRIES))
        with patch.object(listing.os, 'scandir', return_value=exact):
            output = listing.listing(self.root)
        self.assertTrue(output.startswith(b'ok\0'))
        self.assertLess(len(output), 1024 * 1024)


if __name__ == '__main__':
    unittest.main()
