"""Deterministic boundary tests; live infrastructure is tested separately."""
import asyncio
import tempfile
import threading
import json
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from e2b import CommandExitException

from fastapi.testclient import TestClient
from runtime import Conflict, Desktops, workspace_path
import server
from starlette.websockets import WebSocketDisconnect


class Boundaries(unittest.TestCase):
    VIEWER_INSTANCE = '11111111-1111-4111-8111-111111111111'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.m = Desktops(Path(self.temp.name), configure_sdk=False)
        self.m.data['desktops']['owned'] = {'id': 'owned', 'sandbox_id': 'owned', 'status': 'running', 'mode': 'agent', 'epoch': 0}
        self.m.handles['owned'] = Mock()
        self.m.handles['owned'].sandbox_id = 'runtime-owned'
        self.m.save()

    def tearDown(self):
        self.temp.cleanup()

    def test_unknown_ids_cannot_be_resumed_or_deleted(self):
        with patch('runtime.Sandbox') as sdk:
            for action in ('resume', 'delete'):
                with self.assertRaises(KeyError):
                    self.m.lifecycle('someone-elses-sandbox', action)
            sdk.connect.assert_not_called()
            sdk.kill.assert_not_called()

    def test_takeover_waits_for_command_and_blocks_next_input(self):
        entered, release, changed = threading.Event(), threading.Event(), threading.Event()
        def command(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(2))
            return Mock(stdout='done', stderr='', exit_code=0)
        self.m.handles['owned'].commands.run.side_effect = command
        agent = threading.Thread(target=lambda: self.m.agent('owned', 'shell', {'command': 'sleep 1'}))
        def takeover():
            self.m.mode('owned', 'human', self.VIEWER_INSTANCE)
            changed.set()
        human = threading.Thread(target=takeover)
        agent.start()
        self.assertTrue(entered.wait(2))
        human.start()
        self.assertFalse(changed.wait(.05))
        release.set()
        agent.join(2)
        human.join(2)
        self.assertTrue(changed.is_set())
        with self.assertRaises(Conflict):
            self.m.agent('owned', 'type', {'text': 'race'})

    def test_takeover_survives_controller_restart(self):
        self.m.mode('owned', 'human', self.VIEWER_INSTANCE)
        restarted = Desktops(Path(self.temp.name), configure_sdk=False)
        with self.assertRaises(Conflict):
            restarted.agent('owned', 'shell', {'command': 'echo unwanted'})

    def test_observer_and_human_use_different_servers(self):
        self.m.handles['owned'].traffic_access_token = 'secret'
        with patch.object(server, 'desktops', self.m):
            self.assertEqual(server.route('owned')[0]['E2b-Sandbox-Port'], '6081')
            self.m.mode('owned', 'human', self.VIEWER_INSTANCE)
            self.assertEqual(server.route('owned')[0]['E2b-Sandbox-Port'], '6080')

    def test_cross_origin_and_simple_posts_are_rejected(self):
        with patch.object(server, 'desktops', self.m), TestClient(server.app) as client:
            path = '/api/desktops/owned/mode'
            self.assertEqual(client.post(path, json={'mode': 'human'}).status_code, 403)
            self.assertEqual(client.post(path, json={'mode': 'human'}, headers={
                'X-Poc-Request': '1', 'Origin': 'https://untrusted.example'}).status_code, 403)
            self.assertEqual(self.m.record('owned')['mode'], 'agent')
            self.assertEqual(client.post(path, json={'mode': 'human', 'viewer_instance': self.VIEWER_INSTANCE}, headers={
                'X-Poc-Request': '1', 'Origin': 'http://testserver'}).status_code, 200)

    def test_guest_asset_cannot_reuse_control_origin_mutation_authority(self):
        """A guest asset that posts with the public header must stay powerless."""
        class GuestResponse:
            content = b"fetch('http://127.0.0.1:3800/api/desktops/owned/mode',{method:'POST',headers:{'X-Poc-Request':'1'}})"
            status_code = 200
            headers = {'content-type': 'text/html'}

        class GuestClient:
            def __init__(self, *args, **kwargs):
                self.requested_url = None

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            async def get(self, url, **kwargs):
                self.requested_url = url
                return GuestResponse()

        viewer_app = getattr(server, 'viewer_app', server.app)
        viewer_origin = 'http://127.0.0.1:3801' if hasattr(server, 'viewer_app') else 'http://127.0.0.1:3800'
        self.m.handles['owned'].sandbox_id = 'runtime-owned'
        with patch.object(server, 'desktops', self.m), \
                patch.object(server.httpx, 'AsyncClient', GuestClient):
            ticket = (server.issue_viewer_ticket('owned', 0, self.m)
                      if hasattr(server, 'issue_viewer_ticket') else None)
            asset_path = (f'/session/{ticket}/viewer/owned/vnc.html' if ticket
                          else '/viewer/owned/vnc.html')
            with TestClient(viewer_app, base_url=viewer_origin) as guest_page:
                asset = guest_page.get(asset_path)
            self.assertEqual(asset.status_code, 200)
            self.assertIn("'X-Poc-Request':'1'", asset.text)
            with TestClient(server.app, base_url='http://127.0.0.1:3800') as control:
                attack = control.post('/api/desktops/owned/mode', json={'mode': 'human'}, headers={
                    'Origin': viewer_origin, 'X-Poc-Request': '1'})
        self.assertEqual(attack.status_code, 403)
        self.assertEqual(self.m.record('owned')['mode'], 'agent')

    def test_control_api_mints_short_lived_workspace_ticket(self):
        with patch.object(server, 'desktops', self.m), TestClient(server.app) as client:
            response = client.post('/api/desktops/owned/viewer-session', json={}, headers={
                'X-Poc-Request': '1', 'Origin': 'http://testserver'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['expires_in'], 600)
        claims = server.verify_viewer_ticket(response.json()['ticket'], 'owned', self.m)
        self.assertEqual(claims['epoch'], 0)
        self.assertEqual(claims['sid'], 'owned')
        self.assertEqual((self.m.state / 'viewer-session.key').stat().st_mode & 0o777, 0o600)

    def test_only_taking_viewer_gets_interactive_route(self):
        owner = '11111111-1111-4111-8111-111111111111'
        observer = '22222222-2222-4222-8222-222222222222'
        self.m.handles['owned'].traffic_access_token = 'fixture'
        with patch.object(server, 'desktops', self.m), TestClient(server.app) as client:
            takeover = client.post('/api/desktops/owned/mode', json={
                'mode': 'human', 'viewer_instance': owner}, headers={'X-Poc-Request': '1'})
            self.assertEqual(takeover.status_code, 200)
            tickets = {}
            for instance in (owner, observer):
                response = client.post('/api/desktops/owned/viewer-session', json={
                    'viewer_instance': instance}, headers={'X-Poc-Request': '1'})
                self.assertEqual(response.status_code, 200)
                tickets[instance] = response.json()['ticket']
            owner_claims = server.verify_viewer_ticket(tickets[owner], 'owned', self.m)
            observer_claims = server.verify_viewer_ticket(tickets[observer], 'owned', self.m)
            self.assertEqual(server.route('owned', owner_claims['role'])[0]['E2b-Sandbox-Port'], '6080')
            self.assertEqual(server.route('owned', observer_claims['role'])[0]['E2b-Sandbox-Port'], '6081')
            self.assertNotEqual(tickets[owner], tickets[observer])

            class GuestWebSocket:
                async def __aenter__(self):
                    return self

                async def __aexit__(self, *args):
                    return None

                async def __aiter__(self):
                    yield b'frame'

                async def send(self, message):
                    return None

            with patch.object(server, 'connect', return_value=GuestWebSocket()) as connect, \
                    TestClient(server.viewer_app, base_url='http://127.0.0.1:3801') as viewer:
                for instance, expected_port in ((owner, '6080'), (observer, '6081')):
                    with viewer.websocket_connect(
                            f'/session/{tickets[instance]}/viewer/owned/websockify', headers={
                                'Origin': 'http://127.0.0.1:3801', 'Host': '127.0.0.1:3801'}) as ws:
                        self.assertEqual(ws.receive_bytes(), b'frame')
                    self.assertEqual(connect.call_args.kwargs['additional_headers']['E2b-Sandbox-Port'],
                                     expected_port)
            release = client.post('/api/desktops/owned/mode', json={
                'mode': 'agent', 'viewer_instance': owner}, headers={'X-Poc-Request': '1'})
            self.assertEqual(release.status_code, 200)
            with self.assertRaises(server.HTTPException):
                server.verify_viewer_ticket(tickets[owner], 'owned', self.m)

    def test_second_viewer_needs_explicit_takeover_to_get_control(self):
        owner = self.VIEWER_INSTANCE
        second = '22222222-2222-4222-8222-222222222222'
        with patch.object(server, 'desktops', self.m), TestClient(server.app) as client:
            self.m.mode('owned', 'human', owner)
            original = client.post('/api/desktops/owned/viewer-session', json={
                'viewer_instance': owner}, headers={'X-Poc-Request': '1'}).json()['ticket']
            refused = client.post('/api/desktops/owned/mode', json={
                'mode': 'agent', 'viewer_instance': second}, headers={'X-Poc-Request': '1'})
            self.assertEqual(refused.status_code, 409)
            self.assertEqual(self.m.record('owned')['mode'], 'human')
            takeover = client.post('/api/desktops/owned/mode', json={
                'mode': 'human', 'viewer_instance': second}, headers={'X-Poc-Request': '1'})
            self.assertEqual(takeover.status_code, 200)
            with self.assertRaises(server.HTTPException):
                server.verify_viewer_ticket(original, 'owned', self.m)
            renewed = client.post('/api/desktops/owned/viewer-session', json={
                'viewer_instance': second}, headers={'X-Poc-Request': '1'})
            self.assertEqual(renewed.json()['role'], 'control')

    def test_viewer_ticket_for_workspace_a_cannot_fetch_workspace_b_assets(self):
        self.m.data['desktops']['other'] = {
            'id': 'other', 'sandbox_id': 'runtime-other', 'status': 'running',
            'mode': 'agent', 'epoch': 0}
        self.m.handles['other'] = Mock(sandbox_id='runtime-other')
        self.m.save()

        class GuestResponse:
            content = b'guest-controlled asset'
            status_code = 200
            headers = {'content-type': 'text/html'}

        class GuestClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            async def get(self, url, **kwargs):
                return GuestResponse()

        with patch.object(server, 'desktops', self.m), \
                patch.object(server.httpx, 'AsyncClient', GuestClient):
            ticket_a = server.issue_viewer_ticket('owned', 0) if hasattr(server, 'issue_viewer_ticket') else None
            own_path = (f'/session/{ticket_a}/viewer/owned/vnc.html' if ticket_a
                        else '/viewer/owned/vnc.html')
            other_path = (f'/session/{ticket_a}/viewer/other/vnc.html' if ticket_a
                          else '/viewer/other/vnc.html')
            with TestClient(server.viewer_app, base_url='http://127.0.0.1:3801') as client:
                own = client.get(own_path)
                attack = client.get(other_path)
        self.assertEqual(own.status_code, 200)
        self.assertEqual(attack.status_code, 403)

    def test_viewer_ticket_for_workspace_a_cannot_open_workspace_b_websocket(self):
        self.m.data['desktops']['other'] = {
            'id': 'other', 'sandbox_id': 'runtime-other', 'status': 'running',
            'mode': 'agent', 'epoch': 0}
        self.m.handles['other'] = Mock(sandbox_id='runtime-other')
        self.m.save()

        class GuestWebSocket:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            async def __aiter__(self):
                yield b'workspace-b-frame'

            async def send(self, message):
                return None

        with patch.object(server, 'desktops', self.m), \
                patch.object(server, 'connect', return_value=GuestWebSocket()):
            ticket_a = server.issue_viewer_ticket('owned', 0) if hasattr(server, 'issue_viewer_ticket') else None
            path = (f'/session/{ticket_a}/viewer/other/websockify' if ticket_a
                    else '/viewer/other/websockify')
            with TestClient(server.viewer_app, base_url='http://127.0.0.1:3801') as client:
                with self.assertRaises(WebSocketDisconnect):
                    with client.websocket_connect(path, headers={
                            'Origin': 'http://127.0.0.1:3801', 'Host': '127.0.0.1:3801'}) as ws:
                        ws.receive_bytes()

    def test_viewer_ticket_is_revoked_when_workspace_epoch_changes(self):
        class GuestResponse:
            content = b'asset'
            status_code = 200
            headers = {'content-type': 'text/html'}

        class GuestClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            async def get(self, url, **kwargs):
                return GuestResponse()

        with patch.object(server, 'desktops', self.m), \
                patch.object(server.httpx, 'AsyncClient', GuestClient), \
                TestClient(server.viewer_app) as client:
            ticket = server.issue_viewer_ticket('owned', 0, self.m)
            updated = json.loads(self.m.registry.read_text())
            updated['desktops']['owned']['epoch'] = 1
            self.m.registry.write_text(json.dumps(updated))
            response = client.get(f'/session/{ticket}/viewer/owned/vnc.html')
            renewed = server.issue_viewer_ticket('owned', 1, self.m)
            with patch('runtime.Sandbox.connect', return_value=Mock(sandbox_id='runtime-owned')):
                renewed_response = client.get(f'/session/{renewed}/viewer/owned/vnc.html')
        self.assertEqual(response.status_code, 403)
        self.assertEqual(renewed_response.status_code, 200)

    def test_open_viewer_websocket_closes_when_epoch_changes(self):
        class WaitingGuestWebSocket:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            async def __aiter__(self):
                await asyncio.Event().wait()
                yield b'unreachable'

            async def send(self, message):
                return None

        with patch.object(server, 'desktops', self.m), \
                patch.object(server, 'connect', return_value=WaitingGuestWebSocket()), \
                TestClient(server.viewer_app, base_url='http://127.0.0.1:3801') as client:
            ticket = server.issue_viewer_ticket('owned', 0, self.m)
            with client.websocket_connect(f'/session/{ticket}/viewer/owned/websockify', headers={
                    'Origin': 'http://127.0.0.1:3801', 'Host': '127.0.0.1:3801'}) as ws:
                updated = json.loads(self.m.registry.read_text())
                updated['desktops']['owned']['epoch'] = 1
                self.m.registry.write_text(json.dumps(updated))
                with self.assertRaises(WebSocketDisconnect):
                    ws.receive_bytes()

    def test_viewer_ticket_expires(self):
        with patch.object(server, 'desktops', self.m):
            expired = server.issue_viewer_ticket('owned', 0, self.m, now=1)
            with self.assertRaises(server.HTTPException) as error:
                server.verify_viewer_ticket(expired, 'owned', self.m, now=602)
        self.assertEqual(error.exception.status_code, 403)

    def test_viewer_ticket_rejects_malformed_and_oversized_values(self):
        with patch.object(server, 'desktops', self.m):
            for ticket in ('not-a-ticket', 'a' * 513):
                with self.subTest(length=len(ticket)):
                    with self.assertRaises(server.HTTPException) as error:
                        server.verify_viewer_ticket(ticket, 'owned', self.m)
                    self.assertEqual(error.exception.status_code, 403)

    def test_control_surface_does_not_proxy_guest_paths(self):
        with TestClient(server.app) as client:
            self.assertEqual(client.get('/viewer/owned/vnc.html').status_code, 404)
            self.assertEqual(client.get('/viewer/owned/../api/state').status_code, 404)
        with TestClient(server.viewer_app) as viewer:
            self.assertEqual(viewer.get('/api/state').status_code, 404)
            self.assertEqual(viewer.get('/viewer/owned/vnc.html').status_code, 404)

    def test_control_page_points_viewer_at_separate_forwarded_origin(self):
        with TestClient(server.app, base_url='http://127.0.0.1:13801') as client:
            response = client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn("const VIEWER_ORIGIN='http://127.0.0.1:13802'", response.text)
        self.assertIn("${VIEWER_ORIGIN}${prefix}vnc.html", response.text)
        self.assertIn("path:`${prefix}websockify`", response.text)

    def test_viewer_websocket_rejects_control_origin(self):
        with patch.object(server, 'desktops', self.m), TestClient(server.viewer_app) as client:
            ticket = server.issue_viewer_ticket('owned', 0, self.m)
            with self.assertRaises(WebSocketDisconnect) as disconnect:
                with client.websocket_connect(f'/session/{ticket}/viewer/owned/websockify', headers={
                        'Origin': 'http://127.0.0.1:3800'}):
                    pass
        self.assertEqual(disconnect.exception.code, 1008)

    def test_viewer_websocket_uses_fixed_guest_upstream(self):
        class GuestWebSocket:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            async def __aiter__(self):
                yield b'viewer-frame'

            async def send(self, message):
                return None

        with patch.object(server, 'desktops', self.m), \
                patch.object(server, 'connect', return_value=GuestWebSocket()) as connect, \
                TestClient(server.viewer_app, base_url='http://127.0.0.1:3801') as client:
            ticket = server.issue_viewer_ticket('owned', 0, self.m)
            with client.websocket_connect(f'/session/{ticket}/viewer/owned/websockify', headers={
                    'Origin': 'http://127.0.0.1:3801', 'Host': '127.0.0.1:3801'}) as ws:
                self.assertEqual(ws.receive_bytes(), b'viewer-frame')
        self.assertEqual(connect.call_args.args[0], 'ws://127.0.0.1:3002/websockify')

    def test_viewer_asset_path_uses_fixed_guest_origin(self):
        requested = []
        class GuestResponse:
            content = b'viewer asset'
            status_code = 200
            headers = {'content-type': 'application/javascript'}

        class GuestClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            async def get(self, url, **kwargs):
                requested.append((url, kwargs))
                return GuestResponse()

        with patch.object(server, 'desktops', self.m), \
                patch.object(server.httpx, 'AsyncClient', GuestClient), \
                TestClient(server.viewer_app, base_url='http://127.0.0.1:3801') as client:
            ticket = server.issue_viewer_ticket('owned', 0, self.m)
            response = client.get(f'/session/{ticket}/viewer/owned/core.js?cache=no')
        self.assertEqual(response.content, b'viewer asset')
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertEqual(response.headers['x-content-type-options'], 'nosniff')
        self.assertEqual(requested[0][0], 'http://127.0.0.1:3002/core.js')
        self.assertEqual(dict(requested[0][1]['params']), {'cache': 'no'})

    def test_viewer_registry_reload_revokes_old_epoch_and_runtime_handle(self):
        original = self.m.handles['owned']
        updated = json.loads(self.m.registry.read_text())
        updated['desktops']['owned'].update({'epoch': 7, 'sandbox_id': 'runtime-reverted'})
        self.m.registry.write_text(json.dumps(updated))
        server.reload_registry(self.m)
        self.assertEqual(self.m.record('owned')['epoch'], 7)
        self.assertEqual(self.m.record('owned')['sandbox_id'], 'runtime-reverted')
        self.assertNotIn('owned', self.m.handles)
        replacement = Mock(sandbox_id='runtime-reverted')
        with patch.object(server, 'desktops', self.m), patch('runtime.Sandbox.connect', return_value=replacement):
            headers, epoch = server.route('owned')
        self.assertIsNot(original, self.m.handles['owned'])
        self.assertEqual(epoch, 7)

    def test_paths_cannot_lexically_escape_workspace(self):
        for value in ('../etc/passwd', '/etc/passwd', '/home/user/../other/file'):
            with self.assertRaises(ValueError):
                workspace_path(value)
        self.assertEqual(workspace_path('notes.txt'), '/home/user/notes.txt')

    def test_failed_guest_command_preserves_output_and_exit_code(self):
        self.m.handles['owned'].commands.run.side_effect = CommandExitException(
            stderr='diagnostic', stdout='partial result', exit_code=17, error=None)
        result = self.m.agent('owned', 'shell', {'command': 'exit 17'})
        self.assertEqual(result, {'stdout': 'partial result', 'stderr': 'diagnostic', 'exit_code': 17})

    def test_external_pause_updates_viewer_without_resuming_sandbox(self):
        with patch('runtime.Sandbox') as sdk:
            sdk.get_info.return_value = Mock(state='paused')
            self.m.refresh()
            self.assertEqual(self.m.record('owned')['status'], 'paused')
            self.assertEqual(self.m.record('owned')['epoch'], 1)
            self.assertNotIn('owned', self.m.handles)
            sdk.connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
