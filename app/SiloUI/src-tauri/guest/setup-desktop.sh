#!/bin/sh
# Guest-only optional desktop recipe 1. Never run on the host.
set -eu
[ "${1:-install}" = install ] || { echo 'Usage: setup-desktop.sh install' >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo 'Desktop installation requires guest root' >&2; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || { echo 'Desktop requires Ubuntu 24.04' >&2; exit 1; }
case "$(dpkg --print-architecture)" in
    arm64) arch=arm64; digest=c9199cf4753208bfb69fd016a9780242bebfc43370cc38c97d61e90a3c783e04 ;;
    amd64) arch=amd64; digest=f599fe02e2175b9817b6165f74a5d2bebdc73118dde9181ba3410963bed7ae1e ;;
    *) echo 'Desktop requires ARM64 or AMD64' >&2; exit 1 ;;
esac
helper=${SILO_DESKTOP_SERVICE_SOURCE:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/desktop-service.py}
[ -f "$helper" ] || { echo 'Desktop lifecycle helper is missing' >&2; exit 1; }
mkdir -p /var/lib/silo-desktop
chmod 0700 /var/lib/silo-desktop
exec 9>/var/lib/silo-desktop/install.lock
flock -w 5 9 || { echo 'Desktop installation is already running' >&2; exit 1; }
if [ -f /var/lib/silo-desktop/installed.json ]; then
    /usr/local/bin/silo-desktop status
    exit 0
fi
# Do not reuse an unrelated existing account or change ownership of user files.
if getent passwd silo-desktop >/dev/null && [ ! -f /var/lib/silo-desktop/account-created ]; then
    echo 'The silo-desktop account already exists and is not managed by Silo' >&2
    exit 1
fi
if command -v Xvnc >/dev/null 2>&1 && [ ! -f /var/lib/silo-desktop/install-stage ]; then
    echo 'An existing unmanaged VNC installation conflicts with the Silo desktop' >&2
    exit 1
fi
available=$(df -Pk / | awk 'NR==2 {print $4}')
[ "$available" -ge 2097152 ] || { echo 'Desktop installation requires at least 2 GiB free disk space' >&2; exit 1; }
printf '%s\n' preparing > /var/lib/silo-desktop/install-stage
export DEBIAN_FRONTEND=noninteractive
# Recover packages unpacked before an interrupted installation. apt retains its
# own locks; never remove lock files or claim transactional rollback.
if [ -n "$(dpkg --audit)" ]; then
    dpkg --configure -a || apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=2 install -f -y
fi
apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update
apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=2 -o Acquire::http::Timeout=30 install -y --no-install-recommends ca-certificates ssl-cert curl python3 sudo dbus-x11 at-spi2-core xfce4-session xfce4-panel xfce4-settings xfdesktop4 xfwm4 thunar xfce4-terminal mousepad fonts-dejavu-core xauth x11-utils procps
package=/var/lib/silo-desktop/kasmvnc.deb
curl --silent --show-error --fail --location --retry 2 --connect-timeout 30 --max-time 600 --proto '=https' --tlsv1.2 "https://github.com/kasmtech/KasmVNC/releases/download/v1.5.0/kasmvncserver_noble_1.5.0_${arch}.deb" -o "$package.partial"
printf '%s  %s\n' "$digest" "$package.partial" | sha256sum --check --status || { echo 'Desktop download checksum mismatch' >&2; exit 1; }
mv "$package.partial" "$package"
printf '%s\n' installing > /var/lib/silo-desktop/install-stage
apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=2 install -y --no-install-recommends "$package"
if ! getent passwd silo-desktop >/dev/null; then
    useradd --create-home --shell /bin/bash --comment 'Silo desktop' silo-desktop
    touch /var/lib/silo-desktop/account-created
fi
usermod -a -G ssl-cert silo-desktop
printf '%s\n' 'silo-desktop ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/silo-desktop
chmod 0440 /etc/sudoers.d/silo-desktop
visudo -cf /etc/sudoers.d/silo-desktop >/dev/null
install -d -m 0700 -o silo-desktop -g silo-desktop /home/silo-desktop/.vnc
cat > /home/silo-desktop/.vnc/kasmvnc.yaml <<'YAML'
desktop:
  resolution:
    width: 1440
    height: 900
  allow_resize: false
network:
  protocol: http
  interface: 0.0.0.0
  websocket_port: 6901
  use_ipv6: false
  ssl:
    require_ssl: false
user_session:
  session_type: shared
  idle_timeout: never
encoding:
  max_frame_rate: 30
logging:
  level: 10
YAML
cat > /home/silo-desktop/.vnc/xstartup <<'SESSION'
#!/bin/sh
unset SESSION_MANAGER DBUS_SESSION_BUS_ADDRESS
export DISPLAY=:1
export XDG_RUNTIME_DIR=/run/silo-desktop/user
exec dbus-run-session -- xfce4-session
SESSION
chmod 0755 /home/silo-desktop/.vnc/xstartup
chown silo-desktop:silo-desktop /home/silo-desktop/.vnc/kasmvnc.yaml /home/silo-desktop/.vnc/xstartup
python3 - <<'PY'
import json, os, pathlib, secrets, subprocess
root = pathlib.Path('/var/lib/silo-desktop')
connection = root / 'connection.json'
if not connection.exists():
    connection.write_text(json.dumps(dict(username='silo', password=secrets.token_hex(32), port=6901)))
    connection.chmod(0o600)
data = json.loads(connection.read_text())
subprocess.run(['runuser', '-u', 'silo-desktop', '--', 'kasmvncpasswd', '-u', data['username'], '-r', '-w', '/home/silo-desktop/.kasmpasswd'], input=(data['password']+'\n'+data['password']+'\n').encode(), stdout=subprocess.DEVNULL, check=True)
config = root / 'config.json'
if not config.exists():
    config.write_text('{"autoStart":true}\n')
    config.chmod(0o600)
PY
install -m 0755 "$helper" /usr/local/bin/silo-desktop
mkdir -p /usr/local/libexec
cat > /usr/local/libexec/silo-desktop-boot <<'BOOT'
#!/bin/sh
exec /usr/local/bin/silo-desktop boot
BOOT
chmod 0755 /usr/local/libexec/silo-desktop-boot
dpkg-query -W > /var/lib/silo-desktop/packages.txt
printf '%s\n' '{"version":"1","kasmVncVersion":"1.5.0"}' > /var/lib/silo-desktop/installed.json
printf '%s\n' installed > /var/lib/silo-desktop/install-stage
rm -f "$package"
/usr/local/bin/silo-desktop boot
