"""Private guest HTTP transport for one LCU stdio session. E2B protects ingress.

Runs as the desktop user. This deliberately exposes only LCU's existing MCP tools;
it is not another computer-use implementation. Guest root is inside this boundary.
"""
import json
import selectors
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Session:
    def __init__(self):
        self.lock = threading.Lock()
        self.process = None
        self.sequence = 0

    def start(self):
        if self.process is not None and self.process.poll() is None:
            return
        self.process = subprocess.Popen([
            '/opt/lcu/current/bin/lcu-session', '--user', 'user', '--',
            '/opt/lcu/current/bin/lcu'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.buffer = b''
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.request('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                     'clientInfo': {'name': 'silo-e2b-poc', 'version': '1'}})
        self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})

    def send(self, value):
        self.process.stdin.write(json.dumps(value).encode() + b'\n')
        self.process.stdin.flush()

    def request(self, method, params):
        self.sequence += 1
        self.send({'jsonrpc': '2.0', 'id': self.sequence, 'method': method, 'params': params})
        deadline = time.monotonic() + 55
        while time.monotonic() < deadline:
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                value = json.loads(line)
                if value.get('id') == self.sequence:
                    if 'error' in value:
                        raise ValueError(value['error'])
                    return value['result']
            if self.selector.select(max(0, deadline - time.monotonic())):
                chunk = self.process.stdout.read1(65536)
                if not chunk:
                    raise RuntimeError('LCU closed its session')
                self.buffer += chunk
        # Discard this session: a late response must not contaminate another call.
        self.process.terminate()
        self.process.wait(timeout=5)
        self.selector.close()
        raise TimeoutError('LCU request timed out; reconnect the session')

    def call(self, tool, arguments):
        if tool not in ('js', 'js_reset', 'turn_ended'):
            raise ValueError('Unsupported LCU tool')
        with self.lock:
            self.start()
            return self.request('tools/call', {'name': tool, 'arguments': arguments})


session = Session()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Tool code, arguments and returned desktop content stay out of logs.

    def do_GET(self):
        self.send_response(200 if self.path == '/health' else 404)
        self.end_headers()

    def do_POST(self):
        try:
            if self.path != '/call':
                raise ValueError('Unknown route')
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 1024 * 1024:
                raise ValueError('Invalid request size')
            data = json.loads(self.rfile.read(size))
            result = session.call(data['tool'], data.get('arguments', {}))
            body, status = json.dumps(result).encode(), 200
        except Exception as error:
            body, status = json.dumps({'error': str(error)}).encode(), 502
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 6090), Handler).serve_forever()
