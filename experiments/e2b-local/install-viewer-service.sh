#!/bin/sh
# Upgrade an existing owned PoC VM that predates the separate viewer service.
set -eu
test "$(id -u)" -eq 0
test -f /opt/silo-e2b-poc/server.py
test -x /opt/silo-e2b-poc/.venv/bin/uvicorn
cat > /etc/systemd/system/silo-e2b-poc-viewer.service <<'UNIT'
[Unit]
Description=Silo E2B guest viewer origin
After=docker.service silo-e2b-poc.service
Requires=silo-e2b-poc.service
[Service]
WorkingDirectory=/opt/silo-e2b-poc
ExecStart=/opt/silo-e2b-poc/.venv/bin/uvicorn server:viewer_app --host 127.0.0.1 --port 3801 --no-access-log
Restart=on-failure
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now silo-e2b-poc-viewer.service
