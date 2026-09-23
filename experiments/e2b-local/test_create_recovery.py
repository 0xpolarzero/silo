"""Deterministic lost-response and preparation cleanup tests for create."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import runtime


class FakeRuntime:
    def __init__(self, sandbox_id, metadata):
        self.sandbox_id = sandbox_id
        self.metadata = metadata
        self.pause_calls = 0
        self.traffic_access_token = None
        self.commands = object()

    def pause(self, **_kwargs):
        self.pause_calls += 1


class FakePages:
    def __init__(self, items):
        self.items = items
        self.has_next = True

    def next_items(self):
        self.has_next = False
        return self.items


class FakeSDK:
    accepted = []
    creates = []
    list_queries = []
    connects = []
    kills = []
    create_hook = None

    @classmethod
    def reset(cls):
        cls.accepted = []
        cls.creates = []
        cls.list_queries = []
        cls.connects = []
        cls.kills = []
        cls.create_hook = None

    @classmethod
    def create(cls, _template, **kwargs):
        cls.creates.append(kwargs)
        if cls.create_hook:
            return cls.create_hook(kwargs)
        sbx = FakeRuntime(f'accepted-{len(cls.creates)}', kwargs['metadata'])
        cls.accepted.append(sbx)
        return sbx

    @classmethod
    def list(cls, *, query):
        cls.list_queries.append(dict(query.metadata))
        wanted = dict(query.metadata)
        matches = [item for item in cls.accepted if all(item.metadata.get(k) == v for k, v in wanted.items())]
        return FakePages(matches)

    @classmethod
    def connect(cls, sandbox_id, **_kwargs):
        cls.connects.append(sandbox_id)
        return next(item for item in cls.accepted if item.sandbox_id == sandbox_id)

    @classmethod
    def kill(cls, sandbox_id, **_kwargs):
        cls.kills.append(sandbox_id)


class CreateRecoveryTests(unittest.TestCase):
    def setUp(self):
        FakeSDK.reset()
        self.temp = tempfile.TemporaryDirectory()
        self.manager = runtime.Desktops(self.temp.name, configure_sdk=False)
        self.patch_sdk = patch.object(runtime, 'Sandbox', FakeSDK)
        self.patch_sdk.start()
        self.addCleanup(self.patch_sdk.stop)
        self.addCleanup(self.temp.cleanup)

    def test_accepted_response_loss_reconciles_same_operation_without_duplicate(self):
        original_create = FakeSDK.create

        def accept_then_lose_response(kwargs):
            record = json.loads(self.manager.registry.read_text())['desktops']
            self.assertEqual(len(record), 1)
            intent = next(iter(record.values()))
            self.assertIsNone(intent['sandbox_id'])
            self.assertEqual(intent['operation']['kind'], 'create')
            metadata = kwargs['metadata']
            for key in ('silo-poc-owner', 'silo-workspace-id', 'silo-operation', 'silo-operation-kind', 'silo-run-id'):
                self.assertIn(key, metadata)
            self.assertEqual(intent['id'], metadata['silo-workspace-id'])
            self.assertEqual(intent['operation']['id'], metadata['silo-operation'])
            accepted = FakeRuntime('accepted-before-timeout', metadata)
            FakeSDK.accepted.append(accepted)
            raise TimeoutError('synthetic response loss')

        FakeSDK.create_hook = accept_then_lose_response
        with patch.object(self.manager, 'prepare_guest'):
            result = self.manager.create('Fixture', run_id='a' * 32)

        self.assertEqual(result['sandbox_id'], 'accepted-before-timeout')
        self.assertEqual(result['status'], 'running')
        self.assertEqual(result['run_id'], 'a' * 32)
        self.assertEqual(len(FakeSDK.creates), 1)
        self.assertEqual(len(FakeSDK.list_queries), 1)
        self.assertIsNotNone(original_create)

    def test_restart_leaves_durable_intent_pending_until_explicit_recovery(self):
        workspace_id = 'workspace-from-before-restart'
        operation_id = 'operation-from-before-restart'
        metadata = {
            'silo-poc-owner': self.manager.data['owner'],
            'silo-workspace-id': workspace_id,
            'silo-operation': operation_id,
            'silo-operation-kind': 'create',
            'silo-run-id': 'b' * 32,
            'name': 'Restart fixture',
        }
        self.manager.data['desktops'][workspace_id] = {
            'id': workspace_id, 'sandbox_id': None, 'name': 'Restart fixture',
            'status': 'creating', 'mode': 'agent', 'epoch': 0, 'created': 1,
            'checkpoint': None, 'run_id': 'b' * 32,
            'operation': {'kind': 'create', 'id': operation_id, 'phase': 'requesting'},
        }
        self.manager.save()
        FakeSDK.accepted.append(FakeRuntime('accepted-during-prior-process', metadata))

        restarted = runtime.Desktops(self.temp.name, configure_sdk=False)

        pending = restarted.record(workspace_id)
        self.assertIsNone(pending['sandbox_id'])
        self.assertEqual(pending['status'], 'creating')
        self.assertEqual(pending['operation']['id'], operation_id)
        self.assertEqual(FakeSDK.connects, [])
        self.assertEqual(FakeSDK.list_queries, [])

        with patch.object(restarted, 'prepare_guest'):
            result = restarted.recover_create(workspace_id)

        record = restarted.record(workspace_id)
        self.assertEqual(result['sandbox_id'], 'accepted-during-prior-process')
        self.assertEqual(record['sandbox_id'], 'accepted-during-prior-process')
        self.assertEqual(record['status'], 'running')
        self.assertEqual(record['run_id'], 'b' * 32)
        self.assertNotIn('operation', record)
        self.assertEqual(FakeSDK.creates, [])
        self.assertEqual(FakeSDK.list_queries, [metadata])

    def test_constructor_and_get_state_leave_pending_create_read_only(self):
        from fastapi.testclient import TestClient
        import server

        workspace_id = 'pending-without-implicit-recovery'
        operation_id = 'pending-operation'
        metadata = {
            'silo-poc-owner': self.manager.data['owner'],
            'silo-workspace-id': workspace_id,
            'silo-operation': operation_id,
            'silo-operation-kind': 'create',
            'name': 'Pending fixture',
        }
        self.manager.data['desktops'][workspace_id] = {
            'id': workspace_id, 'sandbox_id': None, 'name': 'Pending fixture',
            'status': 'creating', 'mode': 'agent', 'epoch': 0, 'created': 1,
            'checkpoint': None,
            'operation': {'kind': 'create', 'id': operation_id, 'phase': 'uncertain'},
        }
        self.manager.save()
        FakeSDK.accepted.append(FakeRuntime('accepted-pending', metadata))

        with patch.object(runtime.Desktops, 'prepare_guest'), \
             patch.object(server, 'desktops', None), \
             patch.object(server, 'Desktops', lambda: runtime.Desktops(self.temp.name, configure_sdk=False)), \
             TestClient(server.app) as client:
            response = client.get('/api/state')
            restored = server.desktops
            self.assertIsNone(restored.record(workspace_id)['sandbox_id'])
            self.assertEqual(restored.record(workspace_id)['status'], 'creating')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(FakeSDK.creates, [])
        self.assertEqual(FakeSDK.connects, [])
        self.assertEqual(FakeSDK.kills, [])
        self.assertEqual(FakeSDK.list_queries, [])

    def test_explicit_recover_create_attaches_pending_candidate(self):
        workspace_id = 'explicit-recovery-workspace'
        operation_id = 'explicit-recovery-operation'
        metadata = {
            'silo-poc-owner': self.manager.data['owner'],
            'silo-workspace-id': workspace_id,
            'silo-operation': operation_id,
            'silo-operation-kind': 'create',
            'name': 'Explicit recovery fixture',
        }
        self.manager.data['desktops'][workspace_id] = {
            'id': workspace_id, 'sandbox_id': None, 'name': 'Explicit recovery fixture',
            'status': 'creating', 'mode': 'agent', 'epoch': 0, 'created': 1,
            'checkpoint': None,
            'operation': {'kind': 'create', 'id': operation_id, 'phase': 'uncertain'},
        }
        self.manager.save()
        FakeSDK.accepted.append(FakeRuntime('accepted-explicitly', metadata))

        import server
        from fastapi.testclient import TestClient

        with patch.object(self.manager, 'prepare_guest'), \
             patch.object(server, 'desktops', self.manager), TestClient(server.app) as client:
            response = client.post(f'/api/desktops/{workspace_id}/recover-create',
                                   headers={'X-Poc-Request': '1'})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['sandbox_id'], 'accepted-explicitly')
        self.assertEqual(response.json()['status'], 'running')
        self.assertEqual(FakeSDK.connects, ['accepted-explicitly'])
        self.assertEqual(FakeSDK.creates, [])

    def test_preparation_and_pause_failures_preserve_both_errors_and_runtime_id(self):
        preparation_error = RuntimeError('synthetic preparation failure')
        pause_error = RuntimeError('synthetic pause failure')
        accepted = FakeRuntime('accepted-but-not-prepared', {})
        FakeSDK.create_hook = lambda _kwargs: accepted

        def fail_prepare(_sbx):
            raise preparation_error

        def fail_pause(**_kwargs):
            accepted.pause_calls += 1
            raise pause_error

        accepted.pause = fail_pause
        with patch.object(self.manager, 'prepare_guest', side_effect=fail_prepare):
            with self.assertRaisesRegex(RuntimeError, 'synthetic preparation failure') as caught:
                self.manager.create('Broken fixture', run_id='c' * 32)

        self.assertIn('synthetic pause failure', str(caught.exception))
        records = json.loads(self.manager.registry.read_text())['desktops']
        record = next(iter(records.values()))
        self.assertEqual(record['sandbox_id'], 'accepted-but-not-prepared')
        self.assertEqual(record['status'], 'failed')
        self.assertEqual(record['preparation_error'], 'synthetic preparation failure')
        self.assertEqual(record['cleanup_error'], 'synthetic pause failure')
        self.assertEqual(record['run_id'], 'c' * 32)
        self.assertEqual(accepted.pause_calls, 1)


if __name__ == '__main__':
    unittest.main()
