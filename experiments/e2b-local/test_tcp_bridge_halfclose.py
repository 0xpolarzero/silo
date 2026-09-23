"""Loopback regressions for both TCP half-close directions in tcp-bridge."""
import asyncio
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve


BRIDGE_PATH = Path(__file__).with_name('tcp-bridge.py')
SPEC = importlib.util.spec_from_file_location('e2b_tcp_bridge', BRIDGE_PATH)
bridge_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge_module)
DATA_FRAME = b'\x00'
EOF_FRAME = b'\x01'


class TcpBridgeHalfClose(unittest.IsolatedAsyncioTestCase):
    async def start_fixture(self, guest_peer):
        self.guest_result = asyncio.get_running_loop().create_future()

        async def guarded_guest(reader, writer):
            try:
                await guest_peer(reader, writer, self.guest_result)
            except BaseException as error:
                if not self.guest_result.done():
                    self.guest_result.set_exception(error)
                raise
            finally:
                writer.close()
                await writer.wait_closed()

        self.guest_server = await asyncio.start_server(guarded_guest, '127.0.0.1', 0)
        guest_port = self.guest_server.sockets[0].getsockname()[1]

        async def bridge_handler(ws):
            await bridge_module.bridge(ws)

        self.ws_server = await serve(
            bridge_handler,
            '127.0.0.1',
            0,
            max_size=bridge_module.MAX_FRAME_SIZE,
            compression=None,
        )
        ws_port = self.ws_server.sockets[0].getsockname()[1]
        self.port_patch = patch.object(bridge_module, 'GUEST_SSH_PORT', guest_port)
        self.port_patch.start()
        self.ws_url = f'ws://127.0.0.1:{ws_port}/ssh/fixture'

    async def asyncTearDown(self):
        if hasattr(self, 'port_patch'):
            self.port_patch.stop()
        ws_server = getattr(self, 'ws_server', None)
        if ws_server is not None:
            ws_server.close()
            await ws_server.wait_closed()
        guest_server = getattr(self, 'guest_server', None)
        if guest_server is not None:
            guest_server.close()
            await guest_server.wait_closed()

    async def read_frames_until_eof(self, ws):
        output = bytearray()
        async for frame in ws:
            if frame == EOF_FRAME:
                return bytes(output)
            if not isinstance(frame, bytes) or not frame or frame[:1] != DATA_FRAME:
                raise AssertionError(f'invalid guest frame: {frame!r}')
            output.extend(frame[1:])
        raise AssertionError('bridge closed before framed guest EOF')

    async def test_guest_output_eof_does_not_cancel_remaining_client_input(self):
        prefix = b'client-prefix-before-guest-fin|'
        suffix = b'client-remainder-after-guest-fin|'
        response = b'guest-output-before-fin'

        async def guest_peer(reader, writer, result):
            received_prefix = await reader.readexactly(len(prefix))
            writer.write(response)
            await writer.drain()
            writer.write_eof()
            # Keep the read half open after sending FIN. TCP permits this peer
            # to wait for more client bytes before closing its other half.
            received_suffix = await reader.read(len(suffix))
            client_eof = await reader.read()
            result.set_result((received_prefix + received_suffix, client_eof))

        await self.start_fixture(guest_peer)
        async with connect(self.ws_url, compression=None, max_size=bridge_module.MAX_FRAME_SIZE) as ws:
            await ws.send(DATA_FRAME + prefix)
            output = await self.read_frames_until_eof(ws)
            self.assertEqual(output, response)
            await ws.send(DATA_FRAME + suffix)
            await ws.send(EOF_FRAME)
            # The client closes the WebSocket after both stream halves reach
            # EOF; the bridge must not close it before receiving this half.
            await ws.close()

        guest_bytes, client_eof = await asyncio.wait_for(self.guest_result, 2)
        self.assertEqual(guest_bytes, prefix + suffix)
        self.assertEqual(client_eof, b'')

    async def test_client_eof_still_allows_guest_final_output(self):
        payload = b'client-request-before-eof'
        response = b'guest-final-output-after-client-eof'

        async def guest_peer(reader, writer, result):
            client_bytes = await reader.read()
            result.set_result(client_bytes)
            writer.write(response)
            await writer.drain()
            writer.write_eof()

        await self.start_fixture(guest_peer)
        async with connect(self.ws_url, compression=None, max_size=bridge_module.MAX_FRAME_SIZE) as ws:
            await ws.send(DATA_FRAME + payload)
            await ws.send(EOF_FRAME)
            output = await self.read_frames_until_eof(ws)

        self.assertEqual(await asyncio.wait_for(self.guest_result, 2), payload)
        self.assertEqual(output, response)


if __name__ == '__main__':
    unittest.main()
