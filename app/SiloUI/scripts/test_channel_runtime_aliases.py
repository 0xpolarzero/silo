"""Verify live harnesses locate the runtime alias owned by their app channel."""
import ast
import hashlib
import os
from pathlib import Path
from types import SimpleNamespace
import unittest

from channel_names import channel_for_identifier, channel_names


SCRIPTS = Path(__file__).resolve().parent


def alias_expression(script, variable):
    tree = ast.parse((SCRIPTS / script).read_text())
    assignments = [node for node in ast.walk(tree) if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == variable
                           for target in node.targets)]
    if len(assignments) != 1:
        raise AssertionError(f'Expected one runtime alias assignment in {script}')
    setup = [node for node in ast.walk(tree) if isinstance(node, ast.Assign)
             and any(isinstance(target, ast.Name) and target.id == 'state_dir_name'
                     for target in node.targets)]
    return compile(ast.Module(body=[*setup, assignments[0]], type_ignores=[]), script, 'exec')


class RuntimeAliasFixtureTests(unittest.TestCase):
    def test_runtime_aliases_follow_the_application_identifier(self):
        storage = Path('/fixture/data/runtime/microsandbox')
        digest = hashlib.sha256(os.fsencode(storage)).hexdigest()[:12]
        cases = [('test-linux-desktop.py', 'runtime_alias'),
                 ('test-linux-ui-qualification.py', 'alias'),
                 ('test-linux-snapshot-groups.py', 'runtime_home')]
        for identifier, state in [('org.silo.preview', '.silo'),
                                  ('org.silo.dev', '.silo-dev'),
                                  ('org.example.fixture', '.silo-dev')]:
            for script, variable in cases:
                with self.subTest(script=script, identifier=identifier):
                    environment = {'HOME': '/fixture/home',
                                   'SILO_LINUX_APPLICATION_ID': identifier}
                    namespace = {'Path': Path, 'hashlib': hashlib,
                                 'os': SimpleNamespace(environ=environment, fsencode=os.fsencode),
                                 'environment': environment, 'identifier': identifier,
                                 'APPLICATION_ID': identifier, 'home': Path(environment['HOME']),
                                 'storage_home': storage, 'digest': digest,
                                 'channel_for_identifier': channel_for_identifier, 'names': channel_names()}
                    exec(alias_expression(script, variable), namespace)
                    self.assertEqual(namespace[variable], Path('/fixture/home') / state / digest)


if __name__ == '__main__':
    unittest.main()
