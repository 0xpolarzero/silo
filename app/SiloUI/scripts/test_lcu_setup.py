"""Focused tests for explicit LCU setup prerequisites and its receipt evidence."""
from contextlib import ExitStack
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


SCRIPT = Path(__file__).parents[1] / 'src-tauri/guest/setup-lcu.py'
SPEC = importlib.util.spec_from_file_location('setup_lcu', SCRIPT)
setup_lcu = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup_lcu)


class LcuSetupTests(unittest.TestCase):
    def test_receipt_file_sync_failure_preserves_previous_status_and_retries(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            receipt = state / 'lcu.json'
            before = b'{"status":"installing"}\n'
            receipt.write_bytes(before)
            with (mock.patch.object(setup_lcu, 'STATE', state),
                  mock.patch.object(setup_lcu, 'RECEIPT', receipt)):
                with mock.patch.object(setup_lcu.os, 'fsync', side_effect=OSError('disk full')):
                    with self.assertRaisesRegex(OSError, 'disk full'):
                        setup_lcu.write_receipt({'status': 'ready'})
                self.assertEqual(receipt.read_bytes(), before)
                self.assertEqual(list(state.iterdir()), [receipt])
                setup_lcu.write_receipt({'status': 'ready'})
            self.assertEqual(json.loads(receipt.read_text()), {'status': 'ready'})
            self.assertEqual(stat.S_IMODE(receipt.stat().st_mode), 0o600)

    def test_receipt_syncs_file_then_directory_and_propagates_directory_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            receipt = state / 'lcu.json'
            receipt.write_text('{"status":"installing"}\n')
            synced = []
            fsync = os.fsync

            def sync(fd):
                info = os.fstat(fd)
                if stat.S_ISREG(info.st_mode):
                    self.assertEqual(json.loads(receipt.read_text())['status'], 'installing')
                    self.assertEqual(json.loads(os.pread(fd, info.st_size, 0)), {'status': 'ready'})
                    self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
                    synced.append('file')
                    fsync(fd)
                else:
                    self.assertTrue(stat.S_ISDIR(info.st_mode))
                    self.assertEqual(info.st_ino, state.stat().st_ino)
                    self.assertEqual(json.loads(receipt.read_text())['status'], 'ready')
                    synced.append('directory')
                    raise OSError('directory sync failed')

            with (mock.patch.object(setup_lcu, 'STATE', state),
                  mock.patch.object(setup_lcu, 'RECEIPT', receipt),
                  mock.patch.object(setup_lcu.os, 'fsync', side_effect=sync)):
                with self.assertRaisesRegex(OSError, 'directory sync failed'):
                    setup_lcu.write_receipt({'status': 'ready'})
            self.assertEqual(synced, ['file', 'directory'])
            self.assertEqual(list(state.iterdir()), [receipt])

    def test_native_desktop_patch_is_source_guarded_and_resealed(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'lcu-0.4.0-linux-x64'
            (source / 'lcu').mkdir(parents=True)
            (source / 'bin').mkdir()
            setup_source = source / 'lcu/setup.py'
            original_setup = (
                b'const [cli, agent, scope, commandJson, policyJson] = process.argv.slice(1);\n'
                b"const { agents, upsertServer } = await import(pathToFileURL(join(dirname(cli), 'lib.js')));\n"
                b"if (agent === 'codex') {\n  const transform = agents.codex.transformConfig;\n"
                b'  const policy = JSON.parse(policyJson);\n'
                b'  agents.codex.transformConfig = (...args) => ({ ...transform(...args), ...policy });\n}\n'
                b'const [command, ...args] = JSON.parse(commandJson);\n'
                b"const result = upsertServer(agent, 'lcu', { command, args }, { local: scope === 'project', cwd: process.cwd() });\n"
                b'if (!result.success) throw new Error(result.error);\n'
                b'console.log(JSON.stringify(result));\n'
                b'\ndef host_policy(release_root):\n'
                b"    env = installer_environment(home, names, environ)\n"
                b"    node, skills, mcp = installer_paths(tools_root)\n"
                b"                                 client.mcp_agent, scope, json.dumps(mcp_command), json.dumps(host_policy(release_root))]))\n"
            )
            setup_source.write_bytes(original_setup)
            runtime = source / 'lcu/runtime.py'
            original = (
                b"# upstream runtime fixture\n\n"
                b"def environment(root, resolved=None, *, chrome=False):\n"
                b"    env = dict(os.environ)\n"
                b"    env.update(CUA_REPL_NODE_REPL_PATH=str(node_repl),)\n"
            )
            runtime.write_bytes(original)
            expected = hashlib.sha256(original).hexdigest()
            with (mock.patch.object(setup_lcu, 'NATIVE_DESKTOP_RUNTIME_SHA256', expected),
                  mock.patch.object(setup_lcu, 'NATIVE_DESKTOP_SETUP_SHA256',
                                    hashlib.sha256(original_setup).hexdigest()),
                  mock.patch.object(setup_lcu, 'run') as run):
                setup_lcu.prepare_native_desktop_release(source, 'x86_64', io.StringIO())

            patched = runtime.read_bytes()
            self.assertIn(b'def _native_node_repl_path(root, node_repl, target, env):', patched)
            self.assertIn(b'node_repl_path = _native_node_repl_path(root, node_repl, target, env)', patched)
            self.assertIn(b'CUA_REPL_NODE_REPL_PATH=str(node_repl_path)', patched)
            self.assertNotIn(b'CUA_REPL_NODE_REPL_PATH=str(node_repl),', patched)
            patched_setup = setup_source.read_bytes()
            self.assertIn(b'def native_desktop_server_env(environ):', patched_setup)
            self.assertIn(b'server.env = env', patched_setup)
            self.assertIn(b'json.dumps(server_env)', patched_setup)
            sidecar = source / 'bin/node-repl-disable-sandbox'
            self.assertEqual(sidecar.read_bytes(), setup_lcu.NATIVE_DESKTOP_SIDECAR)
            self.assertEqual(sidecar.stat().st_mode & 0o777, 0o755)
            run.assert_called_once()
            command = run.call_args.args[0]
            self.assertEqual(command[:3], [setup_lcu.sys.executable, '-B', '-c'])
            self.assertLess(command[3].index('seal(root'), command[3].index('verify(root'))
            self.assertEqual(command[-1], 'x64')

    def test_native_desktop_patch_refuses_unrecognized_runtime_without_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            runtime = source / 'lcu/runtime.py'
            runtime.parent.mkdir()
            runtime.write_text('unexpected upstream change\n')
            original = runtime.read_bytes()
            with self.assertRaisesRegex(RuntimeError, 'Unsupported bundled LCU runtime'):
                setup_lcu.prepare_native_desktop_release(source, 'x86_64', io.StringIO())
            self.assertEqual(runtime.read_bytes(), original)
            self.assertFalse((source / 'bin/node-repl-disable-sandbox').exists())

    def test_run_scopes_native_desktop_opt_in_to_explicit_setup_environment(self):
        with mock.patch.dict(setup_lcu.os.environ,
                             {'LCU_LINUX_NATIVE_DESKTOP': 'inherited', 'KEEP_ME': 'yes'}):
            with mock.patch.object(setup_lcu.subprocess, 'run') as run:
                setup_lcu.run(['lcu', 'doctor'], io.StringIO())
                setup_lcu.run(['lcu', 'setup'], io.StringIO(), user=True,
                              extra_env={'LCU_LINUX_NATIVE_DESKTOP': '1'})

        default_env = run.call_args_list[0].kwargs['env']
        setup_env = run.call_args_list[1].kwargs['env']
        self.assertNotIn('LCU_LINUX_NATIVE_DESKTOP', default_env)
        self.assertEqual(setup_env['LCU_LINUX_NATIVE_DESKTOP'], '1')
        self.assertEqual(setup_env['KEEP_ME'], 'yes')
        self.assertEqual(run.call_args_list[1].args[0][:3],
                         ['runuser', '-u', 'silo'])

    def test_archive_extraction_accepts_safe_links_and_rejects_escape(self):
        expected = 'lcu-0.4.0-linux-arm64'

        def make_archive(path, link_target):
            with tarfile.open(path, 'w:gz') as archive:
                for name in (expected, f'{expected}/bin'):
                    directory = tarfile.TarInfo(name)
                    directory.type = tarfile.DIRTYPE
                    archive.addfile(directory)
                executable = tarfile.TarInfo(f'{expected}/bin/tool')
                executable.size = len(b'test executable')
                archive.addfile(executable, io.BytesIO(b'test executable'))
                link = tarfile.TarInfo(f'{expected}/bin/tool-link')
                link.type = tarfile.SYMTYPE
                link.linkname = link_target
                archive.addfile(link)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            safe_archive = root / 'safe.tar.gz'
            make_archive(safe_archive, 'tool')
            destination = root / 'safe'
            destination.mkdir()
            with tarfile.open(safe_archive, 'r:gz') as archive:
                setup_lcu.extract_archive(archive, destination, expected)
            self.assertTrue((destination / expected / 'bin/tool-link').is_symlink())
            self.assertEqual((destination / expected / 'bin/tool-link').read_bytes(), b'test executable')

            unsafe_archive = root / 'unsafe.tar.gz'
            make_archive(unsafe_archive, '../../../outside')
            unsafe_destination = root / 'unsafe'
            unsafe_destination.mkdir()
            with tarfile.open(unsafe_archive, 'r:gz') as archive:
                with self.assertRaises(tarfile.FilterError):
                    setup_lcu.extract_archive(archive, unsafe_destination, expected)
            self.assertFalse((root / 'outside').exists())

    def test_setup_failure_records_actionable_private_log_cause(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / 'usr/lib/chatgpt'
            app.mkdir(parents=True)
            state = root / 'state'
            log = root / 'silo-lcu-install.log'
            patches = (
                mock.patch.object(setup_lcu, 'validate_account'),
                mock.patch.object(setup_lcu, 'read_lock', return_value={'version': '0.4.0'}),
                mock.patch.object(setup_lcu, 'desktop_session_running', return_value=True),
                mock.patch.object(setup_lcu, 'extract_release', side_effect=tarfile.FilterError(
                    'link would escape destination')),
                mock.patch.object(setup_lcu, 'STATE', state),
                mock.patch.object(setup_lcu, 'RECEIPT', state / 'lcu.json'),
                mock.patch.object(setup_lcu, 'LOG', log),
                mock.patch.object(setup_lcu, 'APP', app),
            )
            with ExitStack() as stack:
                for patcher in patches:
                    stack.enter_context(patcher)
                with self.assertRaisesRegex(RuntimeError, 'inspect .*silo-lcu-install.log'):
                    setup_lcu.provision()

            self.assertEqual(log.read_text(),
                             'LCU setup failed: FilterError: link would escape destination\n')
            self.assertEqual(json.loads((state / 'lcu.json').read_text())['status'], 'failed')

    def test_missing_official_app_has_no_setup_side_effects(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state = root / 'state'
            absent_app = root / 'usr/lib/chatgpt'
            with (mock.patch.object(setup_lcu, 'validate_account'),
                  mock.patch.object(setup_lcu, 'read_lock', return_value={'version': '0.4.0'}),
                  mock.patch.object(setup_lcu, 'STATE', state),
                  mock.patch.object(setup_lcu, 'RECEIPT', state / 'lcu.json'),
                  mock.patch.object(setup_lcu, 'APP', absent_app),
                  mock.patch.object(setup_lcu.subprocess, 'run') as run):
                result = setup_lcu.provision()

            self.assertEqual(result, {
                'status': 'needs-runtime',
                'reason': 'chatgpt-app-required',
                'requiredRuntime': 'official-chatgpt-linux',
            })
            self.assertFalse(state.exists())
            self.assertFalse(setup_lcu.RECEIPT.exists())
            run.assert_not_called()

    def test_passive_status_does_not_run_setup_commands(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / 'chatgpt'
            app.mkdir()
            with mock.patch.object(setup_lcu.subprocess, 'run') as run:
                result = setup_lcu.receipt_status(root / 'missing.json', root / 'prefix', app)
            self.assertEqual(result, {'status': 'not-installed'})
            run.assert_not_called()

    def test_missing_official_app_overrides_stale_ready_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix = root / 'prefix'
            release = prefix / 'releases' / 'current'
            (release / 'bin').mkdir(parents=True)
            (release / 'app').mkdir()
            runtime = release / 'bin/lcu'
            runtime.write_text('#!/bin/sh\n')
            runtime.chmod(0o755)
            (prefix / 'current').symlink_to(release)
            receipt = root / 'state/lcu.json'
            receipt.parent.mkdir()
            receipt.write_text(json.dumps({
                'schemaVersion': 1,
                'status': 'ready',
                'version': '0.4.0',
                'architecture': 'aarch64',
                'appVersion': '1.2026.123',
                'runtimeVersion': '22.1.0',
                'agents': ['codex'],
                'readiness': 'ready',
            }))
            missing_app = root / 'usr/lib/chatgpt'
            original_lstat = Path.lstat

            def receipt_owned_by_root(path):
                if path == receipt:
                    info = original_lstat(path)
                    return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0)
                return original_lstat(path)

            with mock.patch.object(Path, 'lstat', new=receipt_owned_by_root):
                result = setup_lcu.receipt_status(receipt, prefix, missing_app)

            self.assertEqual(result, {
                'status': 'needs-runtime',
                'reason': 'chatgpt-app-required',
                'requiredRuntime': 'official-chatgpt-linux',
            })

    def test_passive_status_rejects_non_object_receipts_without_running_commands(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / 'chatgpt'
            app.mkdir()
            receipt = root / 'lcu.json'
            original_lstat = Path.lstat

            def receipt_owned_by_root(path):
                if path == receipt:
                    return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0)
                return original_lstat(path)

            for value in ([], None, 'ready', 1, True):
                with self.subTest(value=value):
                    receipt.write_text(json.dumps(value))
                    with (mock.patch.object(Path, 'lstat', new=receipt_owned_by_root),
                          mock.patch.object(setup_lcu.subprocess, 'run') as run):
                        result = setup_lcu.receipt_status(receipt, root / 'prefix', app)
                    self.assertEqual(result, {
                        'status': 'repair-required', 'reason': 'invalid-receipt',
                    })
                    run.assert_not_called()

    def test_active_session_check_ignores_stream_health(self):
        with mock.patch.object(setup_lcu.subprocess, 'run', return_value=mock.Mock(
                stdout='{"state":"failed","sessionState":"running","streamState":"failed"}')):
            self.assertTrue(setup_lcu.desktop_session_running())
        with mock.patch.object(setup_lcu.subprocess, 'run', return_value=mock.Mock(
                stdout='{"state":"running","streamState":"running"}')):
            self.assertTrue(setup_lcu.desktop_session_running())

    def test_only_upstream_confirmed_complete_registrations_are_recorded(self):
        output = '\n'.join((
            'Pi: skill registered.',
            'Pi: extension registered.',
            'Codex: skill registered.',
            'Claude Code: skill registered.',
            'Claude Code: MCP registered.',
            'Unknown: MCP registered.',
        ))

        self.assertEqual(setup_lcu.agent_registrations(output), ['claude-code', 'pi'])
        command = setup_lcu.setup_command()
        self.assertIn('--agent', command)
        self.assertIn('auto', command)
        self.assertIn('--session', command)
        self.assertIn('direct', command)
        self.assertNotIn('all', command)


if __name__ == '__main__':
    unittest.main()
