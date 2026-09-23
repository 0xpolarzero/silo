"""OpenSSH ProxyCommand. No E2B keys or guest credentials enter this process."""
import asyncio
import os
import sys
from websockets.asyncio.client import connect

MAX_TRANSPORT_FRAME = 65537  # One framing byte plus a 64 KiB TCP chunk.


async def main():
    base, sid = sys.argv[1:]
    async with connect(base.replace('http', 'ws', 1) + '/ssh/' + sid,
                       origin=base, proxy=None, compression=None,
                       max_size=MAX_TRANSPORT_FRAME) as ws:
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        input_transport, _ = await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)

        async def send():
            while data := await reader.read(65536):
                await ws.send(b'\x00' + data)
            await ws.send(b'\x01')

        async def receive():
            async for frame in ws:
                if frame == b'\x01':
                    # The peer closed its output half. Close the local stdout
                    # pipe, but keep reading stdin until its independent EOF.
                    os.close(1)
                    return
                if not isinstance(frame, bytes) or not frame or frame[0] != 0:
                    raise ValueError('Invalid SSH transport frame')
                data = memoryview(frame)[1:]
                while data:
                    written = await asyncio.to_thread(os.write, 1, data)
                    data = data[written:]
            raise ConnectionError('Transport disconnected before EOF')

        tasks = [asyncio.create_task(fn()) for fn in (send, receive)]
        try:
            # TCP halves are independent. Receiving EOF must not cancel stdin;
            # stdin EOF must not discard the peer's final output.
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            input_transport.close()


if __name__ == '__main__':
    asyncio.run(main())
