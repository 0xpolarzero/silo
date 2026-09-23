"""Loopback regressions for independent SSH ProxyCommand stream halves."""
import asyncio
from pathlib import Path
import sys
import unittest

from websockets.asyncio.server import serve


PROXY = Path(__file__).with_name('ssh-proxy.py')
EOF_FRAME = b'\x01'


class ProxyHalfClose(unittest.IsolatedAsyncioTestCase):
    async def start_proxy(self, handler):
        self.received = asyncio.get_running_loop().create_future()
        self.output_eof = asyncio.Event()

        async def guarded(ws):
            try:
                await handler(ws, self.received, self.output_eof)
            except BaseException as error:
                if not self.received.done():
                    self.received.set_exception(error)
                raise

        self.server = await serve(guarded, '127.0.0.1', 0, compression=None)
        port = self.server.sockets[0].getsockname()[1]
        self.process = await asyncio.create_subprocess_exec(
            sys.executable, str(PROXY), f'http://127.0.0.1:{port}', 'fixture',
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

    async def asyncTearDown(self):
        process = getattr(self, 'process', None)
        if process is not None and process.returncode is None:
            process.terminate()
            await asyncio.wait_for(process.wait(), 2)
        server = getattr(self, 'server', None)
        if server is not None:
            server.close()
            await server.wait_closed()

    async def test_reverse_eof_keeps_client_input_open_until_client_eof(self):
        prefix = b'prefix-before-server-fin|'
        suffix = b'remaining-client-bytes-after-server-fin|'
        response = b'server-output-before-fin'

        async def peer(ws, received, output_eof):
            first = await asyncio.wait_for(ws.recv(), 2)
            if not isinstance(first, bytes) or first[:1] != b'\x00':
                raise AssertionError(f'expected client data frame, got {first!r}')
            client_bytes = bytearray(first[1:])
            await ws.send(b'\x00' + response)
            await ws.send(EOF_FRAME)
            output_eof.set()
            async for frame in ws:
                if frame == EOF_FRAME:
                    received.set_result(bytes(client_bytes))
                    return
                if not isinstance(frame, bytes) or not frame or frame[:1] != b'\x00':
                    raise AssertionError(f'invalid client frame: {frame!r}')
                client_bytes.extend(frame[1:])
            received.set_result(bytes(client_bytes))

        await self.start_proxy(peer)
        self.process.stdin.write(prefix)
        await self.process.stdin.drain()
        await asyncio.wait_for(self.output_eof.wait(), 2)
        output = await asyncio.wait_for(self.process.stdout.read(), 2)
        self.assertEqual(output, response)

        try:
            self.process.stdin.write(suffix)
            await self.process.stdin.drain()
            self.process.stdin.close()
            await self.process.stdin.wait_closed()
        except (BrokenPipeError, ConnectionResetError):
            # The old proxy exits on server EOF and closes its stdin pipe.
            pass
        received = await asyncio.wait_for(self.received, 2)
        exit_code = await asyncio.wait_for(self.process.wait(), 2)
        self.assertEqual(received, prefix + suffix)
        self.assertEqual(exit_code, 0)

    async def test_client_eof_still_allows_final_server_output(self):
        payload = b'client-request-before-eof'
        response = b'final-server-response-after-client-eof'

        async def peer(ws, received, output_eof):
            client_bytes = bytearray()
            async for frame in ws:
                if frame == EOF_FRAME:
                    received.set_result(bytes(client_bytes))
                    await ws.send(b'\x00' + response)
                    await ws.send(EOF_FRAME)
                    output_eof.set()
                    return
                if not isinstance(frame, bytes) or not frame or frame[:1] != b'\x00':
                    raise AssertionError(f'invalid client frame: {frame!r}')
                client_bytes.extend(frame[1:])
            raise AssertionError('proxy closed before sending client EOF')

        await self.start_proxy(peer)
        self.process.stdin.write(payload)
        self.process.stdin.close()
        await self.process.stdin.wait_closed()
        output = await asyncio.wait_for(self.process.stdout.read(), 2)
        self.assertEqual(output, response)
        self.assertEqual(await asyncio.wait_for(self.received, 2), payload)
        self.assertTrue(self.output_eof.is_set())
        self.assertEqual(await asyncio.wait_for(self.process.wait(), 2), 0)

    async def test_oversized_server_frame_is_rejected(self):
        async def peer(ws, received, output_eof):
            await ws.send(b'\x00' + b'x' * 65537)
            await ws.wait_closed()
            received.set_result(True)

        await self.start_proxy(peer)
        self.process.stdin.close()
        await self.process.stdin.wait_closed()
        self.assertNotEqual(await asyncio.wait_for(self.process.wait(), 3), 0)
        self.assertEqual(await asyncio.wait_for(self.process.stdout.read(), 2), b'')


if __name__ == '__main__':
    unittest.main()
