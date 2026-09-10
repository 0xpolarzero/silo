#!/usr/bin/env python3
"""Exercise the production Linux WebKit app through external WebDriver.

No IPC mocks, app test flags, installed credentials or existing Silo data are used.
Run with xvfb-run -a dbus-run-session -- python3 scripts/test-linux-desktop.py.
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
from selenium.common.exceptions import ElementClickInterceptedException, StaleElementReferenceException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.options import BaseOptions
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / "test-results/linux"
EVIDENCE.mkdir(parents=True, exist_ok=True)


class Options(BaseOptions):
    # Selenium 4.18 reads this attribute for custom desktop capabilities.
    _ignore_local_proxy = True

    @property
    def default_capabilities(self):
        return {}

    def to_capabilities(self):
        return {"tauri:options": {"application": str(ROOT / "src-tauri/target/debug/silo-ui")}}


def run():
    report = []
    passed = False
    with tempfile.TemporaryDirectory(prefix="silo-linux-ui-") as temporary:
        environment = dict(os.environ)
        for kind in ["CONFIG", "DATA", "CACHE"]:
            directory = Path(temporary) / kind.lower()
            directory.mkdir()
            environment[f"XDG_{kind}_HOME"] = str(directory)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            native_port = probe.getsockname()[1]
        driver_path = shutil.which("tauri-driver")
        if not driver_path:
            raise RuntimeError("Install tauri-driver 2.0.6 before running this test")
        with (EVIDENCE / "desktop-driver.log").open("w") as output:
            process = subprocess.Popen([driver_path, "--port", str(port), "--native-port", str(native_port)], env=environment,
                                       stdout=output, stderr=subprocess.STDOUT)
            browser = None
            try:
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=1):
                            with socket.create_connection(("127.0.0.1", native_port), timeout=1):
                                break
                    except OSError:
                        if process.poll() is not None:
                            raise RuntimeError("tauri-driver exited; inspect desktop-driver.log")
                        time.sleep(.1)
                browser = webdriver.Remote(f"http://127.0.0.1:{port}", options=Options())
                wait = WebDriverWait(browser, 45, ignored_exceptions=(StaleElementReferenceException, ElementClickInterceptedException))
                def click(by, value):
                    def attempt(_):
                        node = browser.find_element(by, value)
                        if not node.is_displayed() or not node.is_enabled():
                            return False
                        node.click()
                        return True
                    wait.until(attempt)
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
                browser.quit()
                browser = None
                # Persisted fixture is isolated in this test's XDG directory. This
                # exercises the real empty-app state even on hosts without KVM.
                settings = Path(environment["XDG_CONFIG_HOME"]) / "org.silo.preview/settings.json"
                settings.parent.mkdir(parents=True, exist_ok=True)
                settings.write_text(json.dumps({"schemaVersion": 1, "settings": {
                    "onboardingComplete": True, "launchAtLogin": False,
                    "startWorkspacesAtLaunch": False,
                }, "onboardingDraft": None}))
                browser = webdriver.Remote(f"http://127.0.0.1:{port}", options=Options())
                wait = WebDriverWait(browser, 45, ignored_exceptions=(StaleElementReferenceException, ElementClickInterceptedException))
                wait.until(main_window)
                wait.until(lambda _: browser.find_element(By.ID, "application-nav-backup"))
                for page in ["workspaces", "github", "secrets", "backup", "settings"]:
                    click(By.ID, f"application-nav-{page}")
                    wait.until(lambda _: browser.find_element(By.ID, f"application-panel-{page}").is_displayed())
                    assert "Silo could not load" not in browser.find_element(By.TAG_NAME, "body").text
                    report.append(f"Native {page} page renders and keeps its route")
                click(By.ID, "application-nav-secrets")
                click(By.CSS_SELECTOR, "button[aria-label='Add secret']")
                form = browser.find_element(By.CSS_SELECTOR, "form[aria-label='Add secret']")
                form.find_element(By.CSS_SELECTOR, "button[type='submit']").click()
                invalid = form.find_elements(By.CSS_SELECTOR, "input[aria-invalid='true']")
                assert invalid, "Empty secret must show field-level validation"
                assert form.find_elements(By.CSS_SELECTOR, "[role='alert']"), "Explain invalid fields"
                invalid[0].send_keys(Keys.ESCAPE)
                wait.until(lambda _: not browser.find_elements(By.CSS_SELECTOR, "form[aria-label='Add secret']"))
                report.append("Secret form validates inline and Escape cancels without saving")
                click(By.ID, "application-nav-settings")
                login = browser.find_element(By.CSS_SELECTOR, "button[aria-label='Launch Silo at login']")
                wait.until(lambda _: login.is_enabled())
                login.click()
                entry = Path(environment["XDG_CONFIG_HOME"]) / "autostart/org.silo.preview.desktop"
                wait.until(lambda _: entry.exists() and "Exec=" in entry.read_text() and "Hidden=true" not in entry.read_text())
                wait.until(lambda _: login.is_enabled() and login.get_attribute("aria-checked") == "true")
                login.click()
                wait.until(lambda _: "Hidden=true" in entry.read_text())
                report.append("Login preference writes and disables a real isolated XDG autostart entry")
                motion = browser.find_element(By.CSS_SELECTOR, "button[aria-label='Reduce motion']")
                previous = motion.get_attribute("aria-checked")
                motion.click()
                expected = "false" if previous == "true" else "true"
                wait.until(lambda _: motion.get_attribute("aria-checked") == expected)
                wait.until(lambda _: json.loads(settings.read_text())["settings"].get("reduceMotion") == (expected == "true"))
                browser.quit()
                browser = None
                browser = webdriver.Remote(f"http://127.0.0.1:{port}", options=Options())
                wait = WebDriverWait(browser, 45, ignored_exceptions=(StaleElementReferenceException, ElementClickInterceptedException))
                wait.until(main_window)
                click(By.ID, "application-nav-settings")
                wait.until(lambda _: browser.find_element(By.CSS_SELECTOR, "button[aria-label='Reduce motion']").get_attribute("aria-checked") == expected)
                report.append("Settings survive a full native application relaunch")
                browser.save_screenshot(str(EVIDENCE / "settings.png"))
                passed = True
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
                (EVIDENCE / "desktop.json").write_text(json.dumps({"passed": passed, "checks": report}, indent=2))
    for assertion in report:
        print("PASS: " + assertion)


if __name__ == "__main__":
    run()
