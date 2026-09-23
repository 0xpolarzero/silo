#!/bin/sh
set -eu
export DISPLAY=:0
export XDG_RUNTIME_DIR=/tmp/silo-runtime
export DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/silo-desktop-bus
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
Xvfb :0 -screen 0 1280x800x24 -ac -nolisten tcp > /tmp/xvfb.log 2>&1 &
until xdpyinfo >/dev/null 2>&1; do sleep 0.2; done
# Agent-launched apps must join the same bus as Xfce, rather than inheriting
# no address or opening a separate desktop session bus.
dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork
startxfce4 > /tmp/xfce.log 2>&1 &
python3 /usr/local/bin/lcu-bridge.py > /tmp/lcu-bridge.log 2>&1 &
python3 /usr/local/bin/tcp-bridge.py > /tmp/tcp-bridge.log 2>&1 &
# Separate observer server enforces read-only access at the RFB server.
x11vnc -display :0 -forever -shared -nopw -localhost -rfbport 5900 > /tmp/vnc-control.log 2>&1 &
x11vnc -display :0 -forever -shared -nopw -localhost -viewonly -rfbport 5901 > /tmp/vnc-observe.log 2>&1 &
websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 > /tmp/novnc-control.log 2>&1 &
websockify --web=/usr/share/novnc 6081 127.0.0.1:5901 > /tmp/novnc-observe.log 2>&1 &
wait
