"""Synthetic tests for the SDK-only host restart probe safety gates."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shlex
import tempfile
import unittest
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch


SCRIPT = Path(__file__).with_name("sdk-host-restart-probe.py")
SPEC = importlib.util.spec_from_file_location("sdk_host_restart_probe", SCRIPT)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class SDKHostRestartProbeTests(unittest.TestCase):
    def write_run_report(self, folder, *, run_id="r-1", sandbox_id="sbx-1"):
        path = folder / f"{run_id}.json"
        path.write_text(json.dumps({
            "run_id": run_id, "action": "pause", "status": "passed",
            "sandbox_id": sandbox_id,
            "oracles": {"memory_nonce": "a" * 64,
                        "fsynced_file_sha256": hashlib.sha256(b"state").hexdigest()},
        }))
        return path

    def running_sdk(self, *, metadata=None, state="running", cpus=1, memory=512):
        info = SimpleNamespace(sandbox_id="sbx-1", state=state,
                               metadata=metadata or {"sdk-repro-run": "r-1"},
                               cpu_count=cpus, memory_mb=memory)
        return SimpleNamespace(Sandbox=SimpleNamespace(get_info=Mock(return_value=info),
                                                       connect=Mock(), pause=Mock()))

    def test_prepare_records_proof_limit_and_never_connects_or_pauses(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source = self.write_run_report(folder)
            output = folder / "prepare.json"
            sdk = self.running_sdk()

            result = probe.prepare([source], output, sdk=sdk)

            self.assertEqual(result["status"], "blocked")
            self.assertFalse(result["pause_attempted"])
            self.assertFalse(result["guest_mutations_attempted"])
            self.assertFalse(result["restart_authorized"])
            self.assertIn("canonical", result["proof_limit"])
            sdk.Sandbox.get_info.assert_called_once_with("sbx-1")
            sdk.Sandbox.connect.assert_not_called()
            sdk.Sandbox.pause.assert_not_called()
            persisted = json.loads(output.read_text())
            self.assertEqual(persisted["status"], "blocked")

    def test_prepare_refuses_mismatched_run_tag_passively(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source = self.write_run_report(folder)
            output = folder / "prepare.json"
            sdk = self.running_sdk(metadata={"sdk-repro-run": "some-other-run"})

            result = probe.prepare([source], output, sdk=sdk)

            self.assertIn("run ownership", result["block_reason"])
            self.assertFalse(result["pause_attempted"])
            sdk.Sandbox.connect.assert_not_called()
            sdk.Sandbox.pause.assert_not_called()

    def test_prepare_configures_poc_sdk_environment_before_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source = self.write_run_report(folder)
            configured = []
            runtime_module = ModuleType("runtime")
            runtime_module.configure = lambda: configured.append("configured")
            e2b_module = ModuleType("e2b")

            def get_info(sandbox_id):
                self.assertEqual(configured, ["configured"])
                self.assertEqual(sandbox_id, "sbx-1")
                return SimpleNamespace(sandbox_id=sandbox_id, state="running",
                    metadata={"sdk-repro-run": "r-1"}, cpu_count=1, memory_mb=512)

            e2b_module.Sandbox = SimpleNamespace(get_info=get_info)
            with patch.dict("sys.modules", {"runtime": runtime_module, "e2b": e2b_module}):
                result = probe.prepare([source], folder / "prepare.json")

            self.assertEqual(configured, ["configured"])
            self.assertEqual(result["status"], "blocked")

    def test_verify_requires_attestation_and_changed_boot_before_connect(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source = folder / "prepare.json"
            source.write_text(json.dumps({
                "schema": "sdk-host-restart-probe/v1", "phase": "prepare",
                "status": "prepared", "host_boot_id_before": "boot-before",
                "targets": [{"sandbox_id": "sbx-1", "run_id": "r-1",
                             "memory_nonce": "a" * 64,
                             "fsynced_file_sha256": hashlib.sha256(b"state").hexdigest()}],
                "upload_barrier": {"status": "incomplete"},
            }))
            sdk = SimpleNamespace(Sandbox=SimpleNamespace(get_info=Mock(), connect=Mock()))
            with self.assertRaisesRegex(probe.ProbeError, "canonical upload attestation"):
                probe.verify(source, folder / "verified.json", sdk=sdk, host_boot_id="boot-after")
            sdk.Sandbox.connect.assert_not_called()
            sdk.Sandbox.get_info.assert_not_called()

            report = json.loads(source.read_text())
            report["upload_barrier"] = {"status": "complete",
                "condition": "canonical-object-readback", "sandboxes": {
                    "sbx-1": {"status": "complete", "build_id": "build-1",
                              "manifest_sha256": "b" * 64,
                              "canonical_objects_read_back": True}}}
            source.write_text(json.dumps(report))
            with self.assertRaisesRegex(probe.ProbeError, "No trusted canonical object readback verifier"):
                probe.verify(source, folder / "verified.json", sdk=sdk, host_boot_id="boot-after")
            with self.assertRaisesRegex(probe.ProbeError, "boot ID did not change"):
                probe.verify(source, folder / "verified.json", sdk=sdk, host_boot_id="boot-before",
                             barrier_verifier=lambda _report: True)
            sdk.Sandbox.connect.assert_not_called()

    def test_verify_explicitly_resumes_and_checks_both_oracles_and_new_write(self):
        nonce = "a" * 64
        old_hash = hashlib.sha256(b"state").hexdigest()

        class FakeSandbox:
            def __init__(self):
                self.files = {"/home/user/state.bin": b"state"}
                self.connect_calls = []
                self.commands = SimpleNamespace(run=self.run)

            def run(self, command, timeout=30):
                if command.startswith("curl -fsS"):
                    return SimpleNamespace(exit_code=0, stdout=nonce + "\n", stderr="")
                if command == "sha256sum /home/user/state.bin":
                    return SimpleNamespace(exit_code=0,
                        stdout=hashlib.sha256(self.files["/home/user/state.bin"]).hexdigest() + "  state.bin\n",
                        stderr="")
                if command.startswith("python3 -c "):
                    program = shlex.split(command)[2]
                    start = program.index("bytes.fromhex('") + len("bytes.fromhex('")
                    end = program.index("')", start)
                    self.files["/home/user/host-restart-probe-write"] = bytes.fromhex(program[start:end])
                    return SimpleNamespace(exit_code=0, stdout="", stderr="")
                if command == "sha256sum /home/user/host-restart-probe-write":
                    payload = self.files["/home/user/host-restart-probe-write"]
                    return SimpleNamespace(exit_code=0,
                        stdout=hashlib.sha256(payload).hexdigest() + "  host-restart-probe-write\n",
                        stderr="")
                return SimpleNamespace(exit_code=1, stdout="", stderr="unexpected command")

        fake = FakeSandbox()
        info = SimpleNamespace(state="paused", metadata={"sdk-repro-run": "r-1"})
        sdk = SimpleNamespace(Sandbox=SimpleNamespace(
            get_info=Mock(return_value=info),
            connect=Mock(side_effect=lambda sid, **kwargs: (fake.connect_calls.append((sid, kwargs)) or fake))))
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source = folder / "prepare.json"
            source.write_text(json.dumps({
                "schema": "sdk-host-restart-probe/v1", "phase": "prepare",
                "status": "prepared", "host_boot_id_before": "boot-before",
                "targets": [{"sandbox_id": "sbx-1", "run_id": "r-1",
                             "memory_nonce": nonce, "fsynced_file_sha256": old_hash}],
                "upload_barrier": {"status": "complete",
                    "condition": "canonical-object-readback", "sandboxes": {
                        "sbx-1": {"status": "complete", "build_id": "build-1",
                                  "manifest_sha256": "b" * 64,
                                  "canonical_objects_read_back": True}}},
            }))

            result = probe.verify(source, folder / "verified.json", sdk=sdk,
                                  host_boot_id="boot-after", barrier_verifier=lambda _report: True)

            self.assertEqual(result["status"], "passed")
            self.assertEqual(sdk.Sandbox.get_info.call_args.args, ("sbx-1",))
            self.assertEqual(fake.connect_calls, [("sbx-1", {"on_resume": "restore"})])
            self.assertTrue(result["targets"][0]["memory_nonce_matches"])
            self.assertTrue(result["targets"][0]["fsynced_file_matches"])
            self.assertTrue(result["targets"][0]["new_fsynced_write_matches"])


if __name__ == "__main__":
    unittest.main()
