import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('broker', Path(__file__).with_name('credential-broker.py'))
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


class Policy(unittest.TestCase):
    def test_git_fetch_and_push_require_different_permissions(self):
        self.assertEqual(broker.permission('POST', '/fixture/a.git/git-upload-pack'), ('a', 'read'))
        self.assertEqual(broker.permission('POST', '/fixture/a.git/git-receive-pack'), ('a', 'write'))
        self.assertEqual(broker.permission('GET', '/fixture/b.git/info/refs?service=git-receive-pack'), ('b', 'write'))

    def test_ambiguous_paths_and_unparsed_graphql_fail_closed(self):
        for path in ('/graphql', '/repos/fixture/a/../b', '/repos/fixture/a/%2e%2e/b',
                     '/repos/fixture/a/%252e%252e/b', '/repos//fixture/a/file', '/repos/fixture/a\\b/file'):
            self.assertIsNone(broker.permission('GET', path), path)


if __name__ == '__main__':
    unittest.main()
