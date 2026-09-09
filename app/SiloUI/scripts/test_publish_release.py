import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("publish", Path(__file__).with_name("publish-release.py"))
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous = Path.cwd()
        os.chdir(self.directory.name)
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(os.chdir, self.previous)
        Path("release-assets").mkdir()
        for name in ["Silo-macos-arm64.app.tar.gz", "Silo-macos-arm64.dmg", "Silo-linux-x64.deb", "Silo-linux-arm64.deb"]:
            Path("release-assets", name).write_bytes(b"fixture-package")
        self.calls = []
        self.existing = False
        self.head = "test-sha"
        self.environment = patch.dict(os.environ, GH_REPO="test/repo", GITHUB_SHA="test-sha")
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def gh(self, *args):
        self.calls.append(args)
        if args[:2] == ("api", "repos/test/repo/commits/main"):
            return self.head
        if "--paginate" in args:
            return json.dumps({"assets": [{"name": "obsolete.deb"}]}) if self.existing else ""
        if args[:2] == ("api", "repos/test/repo/git/matching-refs/tags/latest"):
            return json.dumps([{"ref": "refs/tags/latest"}] if self.existing else [])
        return ""

    def test_incomplete_matrix_never_touches_github(self):
        Path("release-assets/Silo-linux-arm64.deb").unlink()
        with patch.object(publish, "gh", self.gh), self.assertRaises(RuntimeError):
            publish.main()
        self.assertEqual(self.calls, [])

    def test_superseded_build_never_moves_latest(self):
        self.head = "newer-sha"
        with patch.object(publish, "gh", self.gh):
            publish.main()
        self.assertEqual(len(self.calls), 1)

    def test_first_release_contains_every_package_and_checksums(self):
        with patch.object(publish, "gh", self.gh):
            publish.main()
        creation = next(call for call in self.calls if call[:2] == ("release", "create"))
        self.assertIn("--latest", creation)
        self.assertEqual(len([arg for arg in creation if arg.startswith("release-assets/")]), 5)
        self.assertEqual(len(Path("release-assets/SHA256SUMS").read_text().splitlines()), 4)
        self.assertIn("test-sha", Path("release-notes.md").read_text())

    def test_existing_release_is_updated_without_deleting_release(self):
        self.existing = True
        with patch.object(publish, "gh", self.gh):
            publish.main()
        upload = next(call for call in self.calls if call[:2] == ("release", "upload"))
        self.assertIn("--clobber", upload)
        self.assertIn(("release", "delete-asset", "latest", "obsolete.deb", "--yes"), self.calls)
        self.assertFalse(any(call[:2] == ("release", "delete") for call in self.calls))


if __name__ == "__main__":
    unittest.main()
