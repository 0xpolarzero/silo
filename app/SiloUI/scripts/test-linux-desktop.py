#!/usr/bin/env python3
"""Exercise the production Linux WebKit app through external WebDriver.

No IPC mocks, app test flags, installed credentials or existing Silo data are used.
Run with dbus-run-session -- xvfb-run -a python3 scripts/test-linux-desktop.py.
"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.options import BaseOptions
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / "test-results/linux"
EVIDENCE.mkdir(parents=True, exist_ok=True)


class Options(BaseOptions):
    @property
    def default_capabilities(self):
        return {}

    def to_capabilities(self):
        return {"tauri:options": {"application": str(ROOT / "src-tauri/target/debug/silo-ui")}}


def run():
    report = []
    with tempfile.TemporaryDirectory(prefix="silo-linux-ui-") as temporary:
        environment = dict(os.environ)
        for kind in ["CONFIG", "DATA", "CACHE"]:
            directory = Path(temporary) / kind.lower()
            directory.mkdir()
            environment[f"XDG_{kind}_HOME"] = str(directory)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        driver_path = shutil.which("tauri-driver")
        if not driver_path:
            raise RuntimeError("Install tauri-driver 2.0.6 before running this test")
        with (EVIDENCE / "desktop-driver.log").open("w") as output:
            process = subprocess.Popen([driver_path, "--port", str(port)], env=environment,
                                       stdout=output, stderr=subprocess.STDOUT)
            browser = None
            try:
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=1):
                            break
                    except OSError:
                        if process.poll() is not None:
                            raise RuntimeError("tauri-driver exited; inspect desktop-driver.log")
                        time.sleep(.1)
                browser = webdriver.Remote(f"http://127.0.0.1:{port}", options=Options())
                wait = WebDriverWait(browser, 45)
                # There are two production WebViews. Choose the actual main window.
                def main_window(_):
                    for handle in browser.window_handles:
                        browser.switch_to.window(handle)
                        if "native-status" not in browser.current_url:
                            return True
                    return False
                wait.until(main_window)
                wait.until(lambda _: "Dependencies" in browser.find_element(By.TAG_NAME, "body").text)
                wait.until(lambda _: "Checking" not in browser.find_element(By.TAG_NAME, "body").text)
                body = browser.find_element(By.TAG_NAME, "body").text
                assert "Applications" in body, body
                assert "Silo could not load" not in body, body
                report.append("Production onboarding loaded through native WebKit and IPC")
                browser.save_screenshot(str(EVIDENCE / "onboarding.png"))
                if not Path("/dev/kvm").exists():
                    assert "KVM" in body, body
                    button = browser.find_element(By.XPATH, "//button[normalize-space()='Continue']")
                    assert not button.is_enabled(), "Missing KVM must never allow onboarding to continue"
                    report.append("Missing KVM is visible and prevents Continue")
                # Error guidance is retained on retry; the page must not crash or lose its route.
                retries = browser.find_elements(By.XPATH, "//button[contains(., 'Check again') or contains(., 'Retry')]")
                if retries:
                    retries[0].click()
                    wait.until(lambda _: "Applications" in browser.find_element(By.TAG_NAME, "body").text)
                    report.append("Dependency retry keeps onboarding visible")
            except Exception:
                if browser:
                    browser.save_screenshot(str(EVIDENCE / "failure.png"))
                    (EVIDENCE / "failure.txt").write_text(browser.find_element(By.TAG_NAME, "body").text)
                raise
            finally:
                if browser:
                    browser.quit()
                process.terminate()
                process.wait(timeout=10)
                (EVIDENCE / "desktop.json").write_text(json.dumps(report, indent=2))
    for assertion in report:
        print("PASS: " + assertion)


if __name__ == "__main__":
    run()
