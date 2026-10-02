#!/usr/bin/python3
"""Make Chromium and Electron applications expose their web content over AT-SPI.

Chromium builds its accessibility tree for web content only after an AT-SPI
client has used extended properties of the application (it calls
OnExtendedPropertiesUsedInWebContent when GetAttributes or GetRelationSet is
requested). Without such a client Chrome exposes a handful of window nodes and
Electron applications expose almost nothing. Once triggered, the setting
persists for the life of the application.

This helper is that client. It is autostarted in the desktop session by
/etc/xdg/autostart/silo-accessibility.desktop and does nothing else.

Two processes run from this one file:

  * The supervisor (the default, and what autostart runs) never imports pyatspi.
    libatspi calls g_error when the accessibility bus cannot be activated, which
    aborts the process (exit 133), and XDG autostart never restarts anything. So
    the supervisor first waits, with backoff, until org.a11y.Bus.GetAddress
    succeeds on the session bus, then runs the worker as a child. It restarts the
    worker after an abnormal exit (backoff 1 s doubling to 30 s, reset when a run
    lasted a minute) and gives up after 10 consecutive short runs or after 10
    minutes without a bus. A clean worker exit ends the supervisor.
  * The worker (--worker) polls:
      - Every application root on the AT-SPI desktop, plus its first few
        children, gets one getAttributes() and getRelationSet() call.
      - Applications are identified by process id, never by name: reading
        application.name is a synchronous call into the application. An
        application is handled once it has been polled while having children;
        handled applications are skipped and forgotten when they leave the
        desktop.
      - Every AT-SPI call has a short timeout (Atspi.set_timeout), a sweep has a
        time budget, and an application that fails slowly (hung or stopped) is
        skipped for a minute, so one stuck application never delays the others.
      - Polling starts every 2 seconds and backs off to 10 seconds while nothing
        new appears, returning to 2 seconds when the set of applications changes.

Usage: silo-accessibility [fast-interval-seconds]
"""
import ctypes
import os
import signal
import subprocess
import sys
import time

FAST_INTERVAL = 2.0
SLOW_INTERVAL = 10.0
CHILDREN_TO_TOUCH = 5
CALL_TIMEOUT_MS = 1000  # AT-SPI call timeout; libatspi defaults to 800 and 15000 ms
SLOW_CALL_SECONDS = 0.4  # a failure slower than this means a hung application
SWEEP_BUDGET = 6.0  # seconds spent on applications in one sweep
HUNG_COOLDOWN = 60.0  # seconds a hung application is left alone

BUS_WAIT_LIMIT = 600.0
BUS_RETRY_MAX = 30.0
RESTART_DELAY_MAX = 30.0
HEALTHY_RUN = 60.0
MAX_SHORT_RUNS = 10


def application_key(application):
    """Identify one running application instance by process id, or None if it vanished.

    This asks the bus daemon, not the application, so a hung application cannot block it.
    """
    try:
        pid = application.get_process_id()
    except Exception:
        return None
    return pid if pid and pid > 0 else None


def touch(accessible):
    """Request the properties whose use switches Chromium's web accessibility on.

    Returns (ok, slow). libatspi reports a timed-out call as an empty result
    rather than an exception, so a hung application is recognised by elapsed time.
    """
    started = time.monotonic()
    try:
        accessible.getAttributes()
        accessible.getRelationSet()
        ok = True
    except Exception:
        ok = False
    return ok, time.monotonic() - started > SLOW_CALL_SECONDS


def poll_application(application, deadline):
    """Return (handled, hung): handled once the application has children and was fully touched."""
    ok, slow = touch(application)
    if slow:
        return False, True
    if not ok:
        return False, False
    started = time.monotonic()
    try:
        count = application.childCount
    except Exception:
        return False, time.monotonic() - started > SLOW_CALL_SECONDS
    if time.monotonic() - started > SLOW_CALL_SECONDS:
        return False, True
    for index in range(min(count, CHILDREN_TO_TOUCH)):
        if time.monotonic() > deadline:
            return False, False
        started = time.monotonic()
        try:
            child = application.getChildAtIndex(index)
        except Exception:
            child = None
        if time.monotonic() - started > SLOW_CALL_SECONDS:
            return False, True
        if child is not None and touch(child)[1]:
            return False, True
    return count > 0, False


def worker(fast):
    import pyatspi

    try:
        from gi.repository import Atspi
        Atspi.set_timeout(CALL_TIMEOUT_MS, CALL_TIMEOUT_MS)
    except Exception as error:
        print(f"silo-accessibility: cannot set AT-SPI timeouts: {error}", file=sys.stderr, flush=True)
    handled = set()
    skip_until = {}
    interval = fast
    next_index = 0
    while True:
        changed = False
        try:
            desktop = pyatspi.Registry.getDesktop(0)
            present = set()
            deadline = time.monotonic() + SWEEP_BUDGET
            count = desktop.childCount
            deferred = None
            for offset in range(count):
                index = (next_index + offset) % count
                try:
                    application = desktop.getChildAtIndex(index)
                except Exception:
                    continue
                key = application_key(application) if application is not None else None
                if key is None:
                    continue
                present.add(key)
                if key in handled:
                    continue
                now = time.monotonic()
                if skip_until.get(key, 0) > now:
                    continue
                changed = True
                if now > deadline:
                    if deferred is None:
                        deferred = index
                    continue
                done, hung = poll_application(application, deadline)
                if done:
                    handled.add(key)
                elif hung:
                    skip_until[key] = time.monotonic() + HUNG_COOLDOWN
            # Resume at the first deferred application so empty roots cannot starve it.
            next_index = deferred if deferred is not None else 0
            if handled - present:
                handled &= present
                changed = True
            for key in [k for k in skip_until if k not in present]:
                del skip_until[key]
        except Exception as error:
            print(f"silo-accessibility: {error}", file=sys.stderr, flush=True)
            changed = True
        interval = fast if changed else min(interval * 1.5, SLOW_INTERVAL)
        time.sleep(interval)


def bus_available():
    """True once the session bus can hand out the AT-SPI bus address (activating it if needed)."""
    try:
        result = subprocess.run(
            ["gdbus", "call", "--session", "--dest", "org.a11y.Bus", "--object-path", "/org/a11y/bus",
             "--method", "org.a11y.Bus.GetAddress"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        return result.returncode == 0
    except Exception:
        return False


def wait_for_bus():
    delay = 1.0
    give_up = time.monotonic() + BUS_WAIT_LIMIT
    while not bus_available():
        if time.monotonic() > give_up:
            return False
        time.sleep(delay)
        delay = min(delay * 2, BUS_RETRY_MAX)
    return True


def die_with_parent():
    try:
        ctypes.CDLL(None).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except Exception:
        pass


def supervise(args):
    child = None

    def forward(signum, _frame):
        if child is not None and child.poll() is None:
            child.terminate()
        sys.exit(0)

    signal.signal(signal.SIGTERM, forward)
    delay = 1.0
    short_runs = 0
    while True:
        if not wait_for_bus():
            print("silo-accessibility: the AT-SPI bus never became available", file=sys.stderr, flush=True)
            return 1
        started = time.monotonic()
        child = subprocess.Popen([sys.executable, os.path.abspath(__file__), "--worker", *args], preexec_fn=die_with_parent)
        code = child.wait()
        if code == 0:
            return 0
        if time.monotonic() - started >= HEALTHY_RUN:
            delay, short_runs = 1.0, 0
        else:
            short_runs += 1
            if short_runs >= MAX_SHORT_RUNS:
                print(f"silo-accessibility: giving up after {short_runs} failed runs (exit {code})", file=sys.stderr, flush=True)
                return 1
        print(f"silo-accessibility: worker exited with {code}; restarting in {delay:.0f}s", file=sys.stderr, flush=True)
        time.sleep(delay)
        delay = min(delay * 2, RESTART_DELAY_MAX)


def main():
    args = sys.argv[1:]
    if args and args[0] == "--worker":
        worker(float(args[1]) if len(args) > 1 else FAST_INTERVAL)
    else:
        sys.exit(supervise(args))


if __name__ == "__main__":
    main()
