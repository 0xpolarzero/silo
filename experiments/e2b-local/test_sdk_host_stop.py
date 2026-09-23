"""The SDK host-stop guard accepts only an exact prepared pause report."""

import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("sdk-host-stop.py")
RUN = "a" * 32
SID = "idwb0vm6hbt7nl23hafns"
BUILD = "feb009cc-1190-4c85-80ba-faa413b05119"


def load_script():
    runtime = types.ModuleType("runtime")
    runtime.STATE = Path("/unused")
    runtime.configure = lambda: None
    spec = importlib.util.spec_from_file_location("sdk_host_stop_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    with patch.dict("sys.modules", {"runtime": runtime}):
        spec.loader.exec_module(module)
    return module


class SDKHostStopTests(unittest.TestCase):
    def prepared(self):
        return {"schema": "sdk-host-restart-prepare/v1", "run_id": RUN,
                "status": "prepared", "sandbox_id": SID, "build_id": BUILD,
                "events": [{"name": "pause-request", "at": "2026-09-23T13:00:00+00:00"},
                           {"name": "pause-response", "returned": True}],
                "upload_marker": {"line_sha256": "b" * 64},
                "canonical_manifest_sha256": "c" * 64}

    def load(self, data):
        module = load_script()
        with tempfile.TemporaryDirectory() as directory:
            module.EVIDENCE = Path(directory)
            (module.EVIDENCE / f"host-restart-prepare-{RUN}.json").write_text(json.dumps(data))
            return module.load_prepared(RUN)

    def test_complete_exact_report_is_accepted(self):
        data, since = self.load(self.prepared())
        self.assertEqual(data["build_id"], BUILD)
        self.assertEqual(since, "2026-09-23T13:00:00+00:00")

    def test_incomplete_or_ambiguous_pause_is_refused(self):
        for mutate in (
            lambda data: data.update(status="failed"),
            lambda data: data["events"].append({"name": "pause-request", "at": "later"}),
            lambda data: data["events"][1].update(returned=False),
            lambda data: data["upload_marker"].update(line_sha256="bad"),
            lambda data: data.update(canonical_manifest_sha256="bad"),
        ):
            with self.subTest(mutate=mutate):
                data = self.prepared()
                mutate(data)
                with self.assertRaises(RuntimeError):
                    self.load(data)

    def test_run_id_is_exact(self):
        module = load_script()
        with self.assertRaisesRegex(RuntimeError, "exact 32-character"):
            module.load_prepared("../some-other-run")


if __name__ == "__main__":
    unittest.main()
