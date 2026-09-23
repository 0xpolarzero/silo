"""Build one ARM-native template with its desktop already running in memory."""
import json
from pathlib import Path
from e2b import Template
from runtime import configure, TEMPLATE

HERE = Path(__file__).resolve().parent


def main():
    configure()
    packages = ('ca-certificates curl sudo python3 python3-websockets python3-gi gir1.2-gtk-3.0 openssh-server git git-lfs xfce4-session xfce4-panel xfwm4 '
                'xfdesktop4 xfce4-settings xfce4-terminal thunar mousepad firefox-esr '
                'xvfb x11-utils x11vnc xdotool scrot xclip dbus-x11 novnc websockify '
                'fonts-dejavu fonts-noto-color-emoji fonts-noto-cjk net-tools procps iproute2 '
                'libxtst6 libxi6 libxrandr2 libxfixes3 libxcomposite1 libxdamage1 at-spi2-core')
    start = (HERE / 'start-desktop.sh').read_text()
    import shlex
    template = (Template().from_image('debian:trixie-slim')
        .set_user('root').set_envs({'DEBIAN_FRONTEND': 'noninteractive', 'DISPLAY': ':0'})
        .run_cmd(f'apt-get update && apt-get install -y --no-install-recommends {packages} && rm -rf /var/lib/apt/lists/*')
        .run_cmd('id -u user >/dev/null 2>&1 || useradd -m -s /bin/bash user')
        .run_cmd('curl -fL --retry 3 https://github.com/0xpolarzero/lcu/releases/download/v0.2.1/lcu-0.2.1-linux-arm64.tar.gz -o /tmp/lcu.tar.gz && '
                 'echo "fd619f2a23cfb937bf414c9d4c309a3a9520651915d468cd644c4d9053dcddd3  /tmp/lcu.tar.gz" | sha256sum -c - && '
                 'mkdir /tmp/lcu && tar -xzf /tmp/lcu.tar.gz -C /tmp/lcu --strip-components=1 && '
                 '/tmp/lcu/scripts/install.sh --user user --agent all --skip-system --yes && rm -rf /tmp/lcu /tmp/lcu.tar.gz')
        .run_cmd('rm -f /etc/ssh/ssh_host_* && mkdir -p /run/sshd && '
                 'printf "PasswordAuthentication no\\nKbdInteractiveAuthentication no\\nPermitRootLogin no\\nAllowUsers user\\n" > /etc/ssh/sshd_config.d/silo.conf')
        .run_cmd(f'printf %s {shlex.quote((HERE / "lcu-bridge.py").read_text())} > /usr/local/bin/lcu-bridge.py')
        .run_cmd(f'printf %s {shlex.quote((HERE / "tcp-bridge.py").read_text())} > /usr/local/bin/tcp-bridge.py')
        .run_cmd(f'printf %s {shlex.quote(start)} > /usr/local/bin/start-desktop && chmod 755 /usr/local/bin/start-desktop')
        .run_cmd('mkdir -p /home/user/Desktop /home/user/Downloads && chown -R user:user /home/user')
        .set_envs({'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/tmp/silo-desktop-bus'})
        .set_user('user').set_workdir('/home/user')
        .set_start_cmd('/usr/local/bin/start-desktop',
                       'DISPLAY=:0 xdpyinfo >/dev/null && pgrep -x xfdesktop >/dev/null && curl -fsS http://127.0.0.1:6081/vnc.html >/dev/null && curl -fsS http://127.0.0.1:6090/health >/dev/null'))
    result = Template.build(template, TEMPLATE, cpu_count=2, memory_mb=2048, min_free_disk_mb=4096,
                            on_build_logs=lambda log: print(log, flush=True))
    (HERE / 'evidence').mkdir(exist_ok=True)
    (HERE / 'evidence/template.json').write_text(json.dumps(vars(result), default=str, indent=2))
    print('Desktop template built:', TEMPLATE)


if __name__ == '__main__':
    main()
