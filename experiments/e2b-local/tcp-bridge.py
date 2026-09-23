"""Guest SSH transport with explicit TCP half-close over authenticated E2B WS.

Frame 0 carries bytes; frame 1 closes only the sending half. The destination is
fixed, so this service cannot be used to reach arbitrary guest/host ports.
"""
import asyncio
from websockets.asyncio.server import serve

GUEST_SSH_PORT = 22
MAX_FRAME_SIZE = 1024 * 1024


async def bridge(ws):
    reader, writer = await asyncio.open_connection('127.0.0.1', GUEST_SSH_PORT)
    async def incoming():
        ended = False
        async for frame in ws:
            if not isinstance(frame, bytes) or not frame or ended:
                raise ValueError('Invalid stream frame')
            if frame[0] == 0:
                writer.write(frame[1:])
                await writer.drain()
            elif frame == b'\x01':
                ended = True
                writer.write_eof()
                await writer.drain()
            else:
                raise ValueError('Unknown stream frame')
        if not ended:
            raise ConnectionError('Transport disconnected before EOF')
    async def outgoing():
        while data := await reader.read(65536):
            await ws.send(b'\x00' + data)
        await ws.send(b'\x01')
    tasks = [asyncio.create_task(fn()) for fn in (incoming, outgoing)]
    try:
        # Each EOF closes one direction. Keep the other direction alive until
        # it reaches its own EOF or fails.
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        writer.close()
        await writer.wait_closed()


async def main():
    async with serve(bridge, '0.0.0.0', 6091, max_size=MAX_FRAME_SIZE, compression=None):
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(main())
