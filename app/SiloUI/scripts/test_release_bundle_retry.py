import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("retry-bundle.py")
SPEC = importlib.util.spec_from_file_location("retry_bundle", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
FAILURE = """[appimage/stderr] Downloading runtime file from https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-aarch64
[appimage/stderr] Failed to download runtime: server returned status code 504
[appimage/stderr] Failed to download runtime file, please download the runtime manually from https://github.com/AppImage/type2-runtime/releases and pass it to appimagetool with --runtime-file
ERROR: Failed to run plugin: appimage (exit code: 1)
failed to bundle project: `failed to run /fixture/linuxdeploy-aarch64.AppImage`
       Error [tauri_cli_node] failed to bundle project: `failed to run /fixture/linuxdeploy-aarch64.AppImage`
"""
FIXTURE = """
import json, pathlib, sys
state = pathlib.Path(sys.argv[1])
count = int(state.read_text()) + 1 if state.exists() else 1
state.write_text(str(count))
print('stdout attempt ' + str(count), flush=True)
print('argv: ' + json.dumps(sys.argv[4:]), flush=True)
print(sys.argv[3] if count <= int(sys.argv[2]) else 'bundle succeeded', file=sys.stderr, flush=True)
sys.exit(17 if count <= int(sys.argv[2]) else 0)
"""


class RetryBundleTests(unittest.TestCase):
    def run_fixture(self, failures, diagnostic=FAILURE, args=()):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        count = root / "count"
        log = root / "bundle.log"
        stdout, stderr, delays = io.BytesIO(), io.BytesIO(), []
        command = [sys.executable, "-c", FIXTURE, str(count), str(failures), diagnostic, *args]
        code = MODULE.retry_bundle(command, log, stdout, stderr, delays.append)
        return code, int(count.read_text()), log.read_bytes(), stdout.getvalue(), stderr.getvalue(), delays

    def test_retries_transient_download_then_preserves_all_attempts_and_streams(self):
        code, count, log, stdout, stderr, delays = self.run_fixture(2)
        self.assertEqual((code, count, delays), (0, 3, [2, 4]))
        self.assertEqual(log.count(b"status code 504"), 2)
        self.assertIn(b"bundle succeeded", log)
        for attempt in range(1, 4):
            self.assertIn(f"stdout attempt {attempt}".encode(), stdout)
            self.assertIn(f"stdout attempt {attempt}".encode(), log)
            self.assertIn(f"Bundle attempt {attempt} exit code:".encode(), log)
        self.assertNotIn(b"status code", stdout)
        self.assertIn(b"status code 504", stderr)

    def test_stops_at_three_failures_and_preserves_final_nonzero_code(self):
        code, count, log, _, _, delays = self.run_fixture(9)
        self.assertEqual((code, count, delays), (17, 3, [2, 4]))
        self.assertEqual(log.count(b"status code 504"), 3)

    def test_all_approved_transient_http_statuses_retry(self):
        for status in (500, 502, 503, 504):
            with self.subTest(status=status):
                code, count, *_ = self.run_fixture(1, FAILURE.replace("504", str(status)))
                self.assertEqual((code, count), (0, 2))

    def test_permanent_and_unrelated_failures_never_retry(self):
        for diagnostic in (
            FAILURE.replace("504", "404"), FAILURE.replace("504", "501"),
            "error: could not compile silo-ui", "Package validation failed",
            "Failed to download runtime: server returned status code 504",
            FAILURE.replace("AppImage/type2-runtime", "other/runtime"),
            FAILURE + "Package validation failed\n",
            FAILURE + "error: could not compile silo-ui\n",
            "error: could not compile silo-ui\n" + FAILURE,
            "Package validation failed\n" + FAILURE,
        ):
            with self.subTest(diagnostic=diagnostic):
                code, count, _, _, _, delays = self.run_fixture(9, diagnostic)
                self.assertEqual((code, count, delays), (17, 1, []))

    def test_argv_is_forwarded_without_shell_expansion(self):
        args = ['space separated', '$(touch should-not-exist)', '; exit 99', '"quoted"']
        code, count, _, stdout, _, _ = self.run_fixture(0, args=args)
        self.assertEqual((code, count), (0, 1))
        line = next(line for line in stdout.decode().splitlines() if line.startswith('argv: '))
        self.assertEqual(json.loads(line.removeprefix('argv: ')), args)

    def test_both_streams_are_forwarded_before_the_command_exits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            class AcknowledgingStream(io.BytesIO):
                def __init__(self, marker):
                    super().__init__()
                    self.marker = marker
                def write(self, value):
                    count = super().write(value)
                    if b'live output' in self.getvalue():
                        self.marker.touch()
                    return count
            child = """
import pathlib, sys, time
for name, stream in [('stdout', sys.stdout), ('stderr', sys.stderr)]:
    print('live output', file=stream, flush=True)
    marker = pathlib.Path(sys.argv[1]) / name
    deadline = time.monotonic() + 2
    while not marker.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    if not marker.exists():
        sys.exit(8)
"""
            code = MODULE.retry_bundle([sys.executable, '-c', child, str(root)], root / 'bundle.log',
                AcknowledgingStream(root / 'stdout'), AcknowledgingStream(root / 'stderr'))
            self.assertEqual(code, 0)

    def test_cli_does_not_mask_nonzero_exit_and_appends_to_existing_log(self):
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / 'bundle.log'
            log.write_text('earlier diagnostic\n')
            result = subprocess.run([sys.executable, str(SCRIPT), '--log', str(log), '--',
                                     sys.executable, '-c', 'import sys; print("permanent", file=sys.stderr); sys.exit(9)'], capture_output=True)
            self.assertEqual(result.returncode, 9)
            self.assertIn(b'permanent', result.stderr)
            self.assertTrue(log.read_text().startswith('earlier diagnostic\n'))

    def test_missing_executable_fails_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            delays = []
            code = MODULE.retry_bundle(['/no/such/executable'], Path(temporary) / 'bundle.log', io.BytesIO(), io.BytesIO(), delays.append)
            self.assertEqual(code, 127)
            self.assertEqual(delays, [])


if __name__ == '__main__':
    unittest.main()
