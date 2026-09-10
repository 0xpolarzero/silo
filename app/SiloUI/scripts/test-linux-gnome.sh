#!/bin/sh
# Test-only nested GNOME session. The Silo executable remains the production app.
set -eu
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
export SILO_LINUX_DESKTOP_SERVICES=gnome
export SILO_LINUX_EVIDENCE="$PWD/test-results/linux/gnome-wayland"
export SILO_DESKTOP_SESSION=$(mktemp -d /tmp/silo-gnome.XXXXXX)
export XDG_RUNTIME_DIR=$SILO_DESKTOP_SESSION/run XDG_CONFIG_HOME=$SILO_DESKTOP_SESSION/config XDG_DATA_HOME=$SILO_DESKTOP_SESSION/data XDG_CACHE_HOME=$SILO_DESKTOP_SESSION/cache
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
chmod 700 "$XDG_RUNTIME_DIR"
export XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_TYPE=wayland GDK_BACKEND=wayland WAYLAND_DISPLAY=silo-test
export LIBGL_ALWAYS_SOFTWARE=1 MUTTER_DEBUG_DUMMY_MODE_SPECS=1440x1000
mkdir -p "$SILO_LINUX_EVIDENCE"
export GNOME_SHELL_SLOWDOWN_FACTOR=1
trap 'rm -rf "$SILO_DESKTOP_SESSION"' EXIT HUP INT TERM
xvfb-run -a -s "-screen 0 1440x1000x24" dbus-run-session -- sh -ec '
 shell=""
 cleanup() {
   if test -n "$shell"; then
     kill -TERM "$shell" 2>/dev/null || true
     for attempt in $(seq 1 30); do kill -0 "$shell" 2>/dev/null || break; sleep .1; done
     kill -KILL "$shell" 2>/dev/null || true
     wait "$shell" 2>/dev/null || true
   fi
   # The real document portal mounts FUSE only inside this private runtime dir.
   if mountpoint -q "$XDG_RUNTIME_DIR/doc"; then fusermount3 -uz "$XDG_RUNTIME_DIR/doc"; fi
   rm -rf "$SILO_DESKTOP_SESSION"
 }
 trap cleanup EXIT HUP INT TERM
 printf "%s\n" "{\"passed\":false,\"checks\":[]}" > "$SILO_LINUX_EVIDENCE/gnome-services.json"
 rm -f "$SILO_LINUX_EVIDENCE/gnome-notification.png"
 gsettings set org.gnome.shell enabled-extensions "[\"ubuntu-appindicators@ubuntu.com\"]"
 # Mutter nests on the parent X11 display; Silo uses the new Wayland socket.
 env -u WAYLAND_DISPLAY gnome-shell --debug-control --nested --wayland --wayland-display=silo-test --sm-disable > "$SILO_LINUX_EVIDENCE/gnome-shell.log" 2>&1 &
 shell=$!
 for i in $(seq 1 100); do test -S "$XDG_RUNTIME_DIR/silo-test" && break; sleep .1; done
 sleep 3
 xdotool key Super_L
 timeout 15 gdbus call --session --dest org.freedesktop.Notifications --object-path /org/freedesktop/Notifications --method org.freedesktop.Notifications.GetServerInformation
 timeout --kill-after=10 300 python3 scripts/test-linux-desktop.py
'
