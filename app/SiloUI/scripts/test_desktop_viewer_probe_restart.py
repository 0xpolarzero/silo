import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("desktop-viewer-probe-guest.py")
SPEC = importlib.util.spec_from_file_location("desktop_viewer_probe_guest", SCRIPT)
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class RestartStreamerRecordsTest(unittest.TestCase):
    def test_restart_replaces_only_the_selkies_record(self):
        original = [
            {"name": name, "pid": pid, "startTicks": pid * 10, "uid": 1001,
             "pgid": pid, "exe": f"/usr/bin/{name}"}
            for name, pid in (("xvfb", 10), ("pulse", 11), ("xfce", 12), ("selkies", 13))
        ]
        state = {"fixtureId": "fixture-12345678", "processes": original}
        replacement = {"name": "selkies", "pid": 14, "startTicks": 140, "uid": 1001,
                       "pgid": 14, "exe": "/usr/bin/selkies"}

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            (run / "session" / "pulse").mkdir(parents=True)
            (run / "session" / "Xauthority").touch()
            (root / "connection.json").write_text(json.dumps(
                {"username": "silo", "password": "a" * 64, "port": 6901}))
            writes = []
            with (patch.object(PROBE, "ROOT", root), patch.object(PROBE, "RUN", run),
                  patch.object(PROBE, "preflight", return_value=({"fixtureId": "fixture-12345678"}, object())),
                  patch.object(PROBE, "validate_live_marker"),
                  patch.object(PROBE, "state_read", return_value=state.copy()),
                  patch.object(PROBE, "state_write", side_effect=lambda value: writes.append(value.copy())),
                  patch.object(PROBE, "process_identities_ready", return_value=True),
                  patch.object(PROBE, "stream_ready", return_value=True),
                  patch.object(PROBE, "stop_recorded"),
                  patch.object(PROBE, "spawn", return_value=replacement),
                  patch.object(PROBE, "session_environment", return_value={}),
                  patch.object(PROBE, "selkies_args", return_value=[])):
                PROBE.restart_streamer("marker")

        final_records = writes[-1]["processes"]
        self.assertEqual(
            [item for item in final_records if item["name"] != "selkies"], original[:3])
        self.assertEqual([item for item in final_records if item["name"] == "selkies"], [replacement])


if __name__ == "__main__":
    unittest.main()
