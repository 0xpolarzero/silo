import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('download_apt_releases', Path(__file__).with_name('download-apt-releases.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DownloadTests(unittest.TestCase):
    def download(self, latest='v0.2.0', tamper=False):
        releases = [dict(tag_name=v, draft=d, prerelease=False) for v, d in [('v0.3.0', True), ('v0.1.0', False), ('v0.2.0', False)]]
        def gh(*args):
            return json.dumps({'tag_name': latest} if args[-1].endswith('/latest') else [releases])
        def fetch(args, **kwargs):
            directory = Path(args[args.index('--dir') + 1])
            sums = []
            for name in ('Silo-linux-x64.deb', 'Silo-linux-arm64.deb'):
                data = b'disposable package download fixture'
                (directory / name).write_bytes(data + (b'changed' if tamper else b''))
                sums.append(hashlib.sha256(data).hexdigest() + '  ' + name)
            (directory / 'SHA256SUMS').write_text('\n'.join(sums))
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        output = Path(tmp.name) / 'packages'
        with patch.object(module, 'gh', side_effect=gh), patch.object(module.subprocess, 'run', side_effect=fetch):
            module.download(output)
        return output

    def test_downloads_only_two_latest_public_stable_releases(self):
        output = self.download()
        self.assertEqual({p.name for p in output.iterdir() if p.is_dir()}, {'0.1.0', '0.2.0'})
        self.assertEqual((output / 'latest-version').read_text(), 'v0.2.0')

    def test_rejects_latest_pointing_to_an_older_version(self):
        with self.assertRaisesRegex(ValueError, 'highest'):
            self.download(latest='v0.1.0')

    def test_rejects_package_checksum_mismatch(self):
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.download(tamper=True)
