import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import os
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publish', Path(__file__).with_name('publish-release.py'))
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in publish.EXPECTED:
            (self.root/name).write_text('signedfixture' if name.endswith('.sig') else 'package')

    def test_complete_matrix_has_version_pinned_feed_and_every_checksum(self):
        publish.prepare(self.root, '0.1.0', 'test/repo', 'Release notes')
        feed = json.loads((self.root/'latest.json').read_text())
        self.assertEqual(feed['version'], '0.1.0')
        self.assertEqual(set(feed['platforms']), set(publish.PLATFORMS))
        for target, name in publish.PLATFORMS.items():
            self.assertEqual(feed['platforms'][target]['url'], f'https://github.com/test/repo/releases/download/v0.1.0/{name}')
        names = {line.split('  ')[1] for line in (self.root/'SHA256SUMS').read_text().splitlines()}
        self.assertEqual(names, publish.EXPECTED|{'latest.json'})

    def test_missing_architecture_fails_before_feed(self):
        (self.root/'Silo-linux-arm64.AppImage').unlink()
        with self.assertRaises(RuntimeError): publish.prepare(self.root,'0.1.0','test/repo','notes')
        self.assertFalse((self.root/'latest.json').exists())

    def test_empty_package_rejected(self):
        (self.root/'Silo-macos-arm64.dmg').write_text('')
        with self.assertRaises(RuntimeError): publish.prepare(self.root,'0.1.0','test/repo','notes')

    def test_unexpected_file_rejected(self):
        (self.root/'private.key').write_text('never upload')
        with self.assertRaises(RuntimeError): publish.prepare(self.root,'0.1.0','test/repo','notes')

    def test_symlink_rejected(self):
        name=self.root/'Silo-macos-arm64.dmg';name.unlink();name.symlink_to(self.root/'Silo-linux-x64.deb')
        with self.assertRaises(RuntimeError): publish.prepare(self.root,'0.1.0','test/repo','notes')

    def test_bad_signature_rejected(self):
        (self.root/'Silo-linux-arm64.AppImage.sig').write_text('not a signature')
        with self.assertRaises(RuntimeError): publish.prepare(self.root,'0.1.0','test/repo','notes')

    def test_only_stable_nonzero_versions(self):
        for version in ['0.0.0','01.2.3','1.0','1.0.0-beta','1.0.0/other','v1.0.0']:
            with self.subTest(version=version), self.assertRaises(RuntimeError): publish.validate_version(version)
        self.assertEqual(publish.validate_version('1.2.10'), (1,2,10))

    def test_existing_public_version_cannot_be_replaced(self):
        releases=[[{'tag_name':'v0.1.0','draft':False,'prerelease':False}]]
        with patch.dict(os.environ,GH_REPO='test/repo'), patch('sys.argv',['publish','0.1.0']), patch.object(publish,'gh',return_value=json.dumps(releases)) as gh:
            with self.assertRaisesRegex(RuntimeError,'newer'): publish.main()
            self.assertEqual(gh.call_count,1)

    def test_existing_draft_cannot_be_overwritten(self):
        releases=[[{'tag_name':'v0.1.0','draft':True,'prerelease':False}]]
        with patch.dict(os.environ,GH_REPO='test/repo'), patch('sys.argv',['publish','0.1.0']), patch.object(publish,'gh',return_value=json.dumps(releases)) as gh:
            with self.assertRaisesRegex(RuntimeError,'already exists'): publish.main()
            self.assertEqual(gh.call_count,1)

    def test_incomplete_draft_cannot_publish(self):
        releases=[[{'tag_name':'v0.1.0','draft':True,'prerelease':False,'assets':[]}]]
        with patch.dict(os.environ,GH_REPO='test/repo'), patch('sys.argv',['publish','0.1.0','--publish']), patch.object(publish,'gh',return_value=json.dumps(releases)) as gh:
            with self.assertRaisesRegex(RuntimeError,'incomplete'): publish.main()
            self.assertEqual(gh.call_count,1)

    def test_tag_must_match_build(self):
        with patch.dict(os.environ,GH_REPO='test/repo',GITHUB_SHA='built-sha'), patch('sys.argv',['publish','0.1.0']), patch.object(publish,'gh',side_effect=['[]','other-sha']) as gh:
            with self.assertRaisesRegex(RuntimeError,'tag'): publish.main()
            self.assertEqual(gh.call_count,2)

if __name__=='__main__': unittest.main()
