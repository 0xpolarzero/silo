#!/bin/sh
# Provision only a new, labelled Silo VM or resume its interrupted creation.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Working account setup requires guest root' >&2; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || exit 1
for tool in sudo visudo python3 runuser useradd groupadd findmnt; do
    command -v "$tool" >/dev/null || {
        echo "Silo's bundled guest image is missing required tool: $tool. Reinstall Silo and retry." >&2
        exit 1
    }
done
[ -x /usr/lib/openssh/sftp-server ] || {
    echo "Silo's bundled guest image is missing required tool: sftp-server. Reinstall Silo and retry." >&2
    exit 1
}
[ "$(findmnt -rn -T /workspace -o TARGET,FSTYPE)" = '/workspace ext4' ] || {
    echo 'Working account setup requires the new workspace disk' >&2; exit 1;
}
verify_account() {
    [ "$(id -u silo)" = 1001 ] && [ "$(id -g silo)" = 1001 ] || return 1
    [ "$(getent passwd silo | cut -d: -f6)" = /home/silo ] || return 1
    [ ! -L /home/silo ] && [ -d /home/silo ] || return 1
    runuser -u silo -- env HOME=/home/silo USER=silo LOGNAME=silo sh -ec 'test -w /workspace; test -w "$HOME"; sudo -n true'
    test -x /usr/lib/openssh/sftp-server
}
if [ -e /var/lib/silo/working-account.json ]; then
    python3 -c 'import json; assert json.load(open("/var/lib/silo/working-account.json")) == {"schemaVersion":1,"user":"silo","home":"/home/silo"}'
    verify_account
    exit 0
fi
if [ ! -f /var/lib/silo/working-account-installing ]; then
    if getent passwd silo >/dev/null || getent passwd 1001 >/dev/null || getent group silo >/dev/null || getent group 1001 >/dev/null; then
        echo 'The working account or reserved UID/GID 1001 already exists' >&2
        exit 1
    fi
    [ ! -e /home/silo ] && [ ! -L /home/silo ] || exit 1
    install -d -m 0755 -o root -g root /var/lib/silo
    printf '1\n' > /var/lib/silo/working-account-installing
fi
if ! getent group silo >/dev/null; then groupadd --gid 1001 silo; fi
[ "$(getent group silo | cut -d: -f3)" = 1001 ] || exit 1
if ! getent passwd silo >/dev/null; then
    useradd --uid 1001 --gid silo --create-home --shell /bin/bash --comment 'Silo working account' silo
fi
[ "$(id -u silo)" = 1001 ] && [ "$(id -g silo)" = 1001 ] || exit 1
[ "$(getent passwd silo | cut -d: -f6)" = /home/silo ] && [ ! -L /home/silo ] || exit 1
printf '%s\n' 'silo ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/silo
chmod 0440 /etc/sudoers.d/silo
visudo -cf /etc/sudoers.d/silo >/dev/null
# Only the mount directory of this newly allocated disk, never its contents.
chown silo:silo /workspace
verify_account
printf '%s\n' '{"schemaVersion":1,"user":"silo","home":"/home/silo"}' > /var/lib/silo/working-account.json.tmp
chmod 0644 /var/lib/silo/working-account.json.tmp
mv /var/lib/silo/working-account.json.tmp /var/lib/silo/working-account.json
rm /var/lib/silo/working-account-installing
