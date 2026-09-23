#!/bin/sh
set -eu
cd /opt/silo-e2b-poc
test -c /dev/kvm
test "$(getconf PAGESIZE)" = 4096
mkdir -p state evidence
chmod 700 state
python3 -m venv .venv
.venv/bin/pip install --disable-pip-version-check -r requirements.txt
cd runtime
python3 - <<'PY'
import json, subprocess
from pathlib import Path
services = subprocess.check_output(['docker', 'compose', 'config', '--services'], text=True).splitlines()
Path('compose.override.yaml').write_text(json.dumps({'services': {
    s: {'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}}}
    for s in services}}, indent=2))
PY
# This host is the experiment's disposable VM, never the user's Docker daemon.
docker compose up -d --wait --wait-timeout 900
# Embed's seeded tier permits only 512 MiB of build working space. The SDK's
# min_free_disk_mb applies AFTER build steps and cannot fix an apt install.
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres < ../fix-build-quota.sql
# This dedicated Redis database holds only this stack's five-minute auth cache.
docker compose exec -T redis redis-cli FLUSHDB
umask 077
docker compose exec -T ready cat /run/e2b/sdk.env > ../state/sdk.env
cat > /etc/systemd/system/silo-e2b-poc.service <<'UNIT'
[Unit]
Description=Silo E2B desktop proof of concept
After=docker.service
[Service]
WorkingDirectory=/opt/silo-e2b-poc
ExecStart=/opt/silo-e2b-poc/.venv/bin/uvicorn server:app --host 127.0.0.1 --port 3800
Restart=on-failure
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
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
