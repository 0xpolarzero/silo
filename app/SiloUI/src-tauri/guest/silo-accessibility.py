#!/usr/bin/python3
"""Make Chromium and Electron applications expose their web content over AT-SPI.

Chromium builds its accessibility tree for web content only after an AT-SPI
client has used extended properties of the application (it calls
OnExtendedPropertiesUsedInWebContent when GetAttributes or GetRelationSet is
requested). Without such a client Chrome exposes a handful of window nodes and
Electron applications expose almost nothing. Once triggered, the setting
persists for the life of the application.

This helper is that client. It is autostarted in the desktop session by
/etc/xdg/autostart/silo-accessibility.desktop and does nothing else:

  * Every application root on the AT-SPI desktop, plus its first few children,
    gets one getAttributes() and getRelationSet() call.
  * An application is considered handled once it has been polled while having
    children. Handled applications are skipped; they are forgotten when they
    leave the desktop, so a restarted application is polled again.
  * Polling starts every 2 seconds and backs off to 10 seconds while nothing new
    appears, returning to 2 seconds as soon as the set of applications changes.
  * Every AT-SPI call is guarded: applications that die or hang never stop the loop.

Usage: silo-accessibility [fast-interval-seconds]
"""
import sys
import time

import pyatspi

FAST_INTERVAL = 2.0
SLOW_INTERVAL = 10.0
CHILDREN_TO_TOUCH = 5


def application_key(application):
    """Identify one running application instance, or None if it already vanished."""
    try:
        return application.get_process_id(), application.name
    except Exception:
        return None


def touch(accessible):
    """Request the properties whose use switches Chromium's web accessibility on."""
    try:
        accessible.getAttributes()
        accessible.getRelationSet()
        return True
    except Exception:
        return False


def poll_application(application):
    """Return True once the application has children and has been fully touched."""
    if not touch(application):
        return False
    try:
        count = application.childCount
    except Exception:
        return False
    for index in range(min(count, CHILDREN_TO_TOUCH)):
        try:
            child = application.getChildAtIndex(index)
        except Exception:
            continue
        if child is not None:
            touch(child)
    return count > 0


def main():
    fast = float(sys.argv[1]) if len(sys.argv) > 1 else FAST_INTERVAL
    handled = set()
    interval = fast
    while True:
        changed = False
        try:
            desktop = pyatspi.Registry.getDesktop(0)
            present = set()
            for index in range(desktop.childCount):
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
                changed = True
                if poll_application(application):
                    handled.add(key)
            if handled - present:
                handled &= present
                changed = True
        except Exception as error:
            print(f"silo-accessibility: {error}", file=sys.stderr, flush=True)
            changed = True
        interval = fast if changed else min(interval * 1.5, SLOW_INTERVAL)
        time.sleep(interval)


if __name__ == "__main__":
    main()
