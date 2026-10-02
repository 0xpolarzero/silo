"""Check the workflow and desktop fixture agree without launching a native app."""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from build_desktop import build


ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = (ROOT / '.github/workflows/linux-verification.yml').read_text()
SMOKE = ast.parse(Path(__file__).with_name('test-linux-desktop.py').read_text())
RUN = next(node for node in SMOKE.body if isinstance(node, ast.FunctionDef) and node.name == 'run')


def expression(name):
    assignments = [node for node in ast.walk(RUN) if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)]
    if len(assignments) != 1:
        raise AssertionError(f'Expected one smoke-fixture assignment for {name}')
    return compile(ast.Expression(assignments[0].value), str(Path(__file__).with_name('test-linux-desktop.py')), 'eval')


class LinuxVerificationTests(unittest.TestCase):
    def test_lifecycle_default_and_guest_probes_use_development_host_state(self):
        lifecycle = next(node for node in SMOKE.body if isinstance(node, ast.FunctionDef)
                         and node.name == 'run_lifecycle')
        identifier_assignment = next(node for node in lifecycle.body if isinstance(node, ast.Assign)
                                     and any(isinstance(target, ast.Name) and target.id == 'identifier'
                                             for target in node.targets))
        default = eval(compile(ast.Expression(identifier_assignment.value), 'lifecycle-identifier', 'eval'),
                       {'environment': {}})
        self.assertEqual(default, 'org.silo.dev')

    def test_lifecycle_guest_probes_select_the_channel_runtime_alias(self):
        lifecycle = next(node for node in SMOKE.body if isinstance(node, ast.FunctionDef)
                         and node.name == 'run_lifecycle')
        guest_for = next(node for node in ast.walk(lifecycle) if isinstance(node, ast.FunctionDef)
                         and node.name == 'guest_for')
        channel_setup = [node for node in lifecycle.body if isinstance(node, ast.Assign)
                         and any(isinstance(target, ast.Name) and target.id == 'state_dir_name'
                                 for target in node.targets)]
        probe = compile(ast.Module(body=[*channel_setup, guest_for], type_ignores=[]),
                        'lifecycle-guest-probe', 'exec')
        for identifier, private_directory in [('org.silo.dev', '.silo-dev'),
                                              ('org.silo.preview', '.silo'),
                                              ('org.silo.preview.linux-checkpoints', '.silo-dev')]:
            with self.subTest(identifier=identifier), tempfile.TemporaryDirectory() as temporary:
                app_data = Path(temporary) / 'data' / identifier
                storage_home = app_data / 'runtime-checkpoints-converted/microsandbox'
                alias = Path(temporary) / 'home' / private_directory / hashlib.sha256(os.fsencode(storage_home)).hexdigest()[:12]
                alias.mkdir(parents=True)
                environment = {'HOME': str(Path(temporary) / 'home'),
                               'SILO_LINUX_MSB': '/fixture/msb', 'SILO_LINUX_MSB_LIBRARY': '/fixture/library'}
                calls = []

                def run(args, **kwargs):
                    calls.append((args, kwargs))
                    return SimpleNamespace(returncode=0, stdout='guest marker\n')

                namespace = {'Path': Path, 'os': os, 'hashlib': hashlib, 'identifier': identifier,
                             'app_data': app_data, 'environment': environment,
                             'subprocess': SimpleNamespace(run=run)}
                exec(probe, namespace)
                self.assertEqual(namespace['guest_for']('fixture-workspace', 'printf marker', 'guest marker'),
                                 'guest marker')
                self.assertEqual(calls[0][1]['env']['MSB_HOME'], str(alias))

    def test_smoke_environment_keeps_home_and_xdg_state_inside_the_fixture(self):
        fixture = next(node for node in RUN.body if isinstance(node, ast.With))
        statements = []
        for statement in fixture.body:
            if isinstance(statement, ast.With):
                break
            statements.append(statement)
        prelude = compile(ast.Module(body=statements, type_ignores=[]), 'smoke-environment', 'exec')
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as caller:
            sentinel = Path(caller) / '.silo-dev/desktop-remote/config.json'
            sentinel.parent.mkdir(parents=True)
            sentinel.write_text('existing caller state')
            namespace = {'temporary': temporary, 'os': os, 'Path': Path}
            with patch.dict(os.environ, {'HOME': caller}):
                exec(prelude, namespace)
            environment = namespace['environment']
            for key in ('HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'):
                with self.subTest(key=key):
                    path = Path(environment[key])
                    self.assertTrue(path.is_relative_to(temporary), path)
                    self.assertTrue(path.is_dir(), path)
            self.assertEqual(sentinel.read_text(), 'existing caller state')

    def test_workflow_build_and_fixture_paths_use_the_same_channel(self):
        command = re.search(r'run: npm run desktop:build -- ([^\n]+)', WORKFLOW).group(1)
        with tempfile.TemporaryDirectory() as temporary:
            calls = []
            build(shlex.split(command), root=temporary, platform='linux',
                  run=lambda args, **kwargs: calls.append(args))
            args = calls[0][3:]
            configs = [args[index + 1] for index, value in enumerate(args) if value == '--config']
            config = json.loads((ROOT / 'app/SiloUI/src-tauri' / 'tauri.conf.json').read_text())
            for path in configs:
                config.update(json.loads((ROOT / 'app/SiloUI' / path).read_text()))
            smoke_step = WORKFLOW.split('- name: Verify native WebKit onboarding and validation', 1)[1].split('\n      - name:', 1)[0]
            match = re.search(r'SILO_LINUX_APPLICATION_ID:\s*([^\s]+)', smoke_step)
            environment = {'XDG_CONFIG_HOME': temporary}
            if match:
                environment['SILO_LINUX_APPLICATION_ID'] = match.group(1).strip("'\"")
            namespace = {'environment': environment, 'Path': Path}
            identifier = eval(expression('identifier'), namespace)
            self.assertEqual(identifier, config['identifier'])
            namespace['identifier'] = identifier
            self.assertEqual(eval(expression('settings'), namespace),
                             Path(temporary) / config['identifier'] / 'settings.json')
            self.assertEqual(eval(expression('entry'), namespace),
                             Path(temporary) / 'autostart/org.silo.dev.desktop')

    def test_explicit_production_fixture_retains_its_released_autostart_name(self):
        namespace = {'environment': {'XDG_CONFIG_HOME': '/synthetic/config'},
                     'identifier': 'org.silo.preview', 'Path': Path}
        self.assertEqual(eval(expression('entry'), namespace),
                         Path('/synthetic/config/autostart/org.silo.preview.desktop'))


if __name__ == '__main__':
    unittest.main()
