#!/bin/sh
# Silo runs this as root after a boot when the VM has no silo account record.
# Usage: sh -c "$(cat working-account.sh)" sh "$(cat working-account.py)" "$(cat desktop-service.py)"
set -eu
# Images from older Silo versions may lack these; Silo's own image has them.
if ! command -v python3 >/dev/null || ! command -v sudo >/dev/null || [ ! -x /usr/lib/openssh/sftp-server ]; then
    apt-get update -q
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends python3 sudo openssh-sftp-server
fi
exec python3 -c "$1" "$2"
