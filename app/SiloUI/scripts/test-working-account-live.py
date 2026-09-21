#!/usr/bin/env python3
"""Opt-in working-account proof in a disposable VM; never reads existing VM state.

SILO_RUN_WORKING_ACCOUNT_LIVE=1 python3 scripts/test-working-account-live.py
  --msb PATH --library PATH --guest-image DIRECTORY --output DIRECTORY
Logs and failed VM state are retained. Guest networking is disabled and package-manager sentinels reject unexpected installation.
The guest image must contain all working-account and Git dependencies.
"""
import argparse
import gzip
import json
import os
from pathlib import Path
import selectors
import shlex
import shutil
import socket
import subprocess
import tempfile
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ('msb', 'library', 'guest-image', 'output'):
        parser.add_argument('--' + argument, type=Path, required=True)
    parser.add_argument('--setup-account', type=Path, default=Path(__file__).resolve().parents[1] / 'src-tauri/guest/setup-working-account.sh')
    args = parser.parse_args()
    if os.environ.get('SILO_RUN_WORKING_ACCOUNT_LIVE') != '1':
        parser.error('set SILO_RUN_WORKING_ACCOUNT_LIVE=1')
    args.output.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='silo-account-live-', dir='/tmp'))
    env = {k: v for k, v in os.environ.items() if not k.startswith('MSB_')}
    env.update(MSB_HOME=str(root / 'home'), MSB_BACKEND='local',
               MSB_PATH=str(args.msb.resolve()), MSB_LIBKRUNFW_PATH=str(args.library.resolve()))
    name, machine_id = 'working-account-proof', str(uuid.uuid4())
    created, passed, endpoint = False, False, None
    log = (args.output / 'live.log').open('x')

    def record(message):
        print(message, flush=True)
        print(message, file=log, flush=True)

    def run(command, check=True, timeout=120, input=None):
        record('COMMAND ' + repr(command))
        try:
            result = subprocess.run(command, env=env, capture_output=True, text=True,
                                    timeout=timeout, input=input)
        except subprocess.TimeoutExpired as error:
            record(f'TIMEOUT after {timeout}s')
            for output in (error.stdout, error.stderr):
                if output:
                    record(output.decode(errors='replace') if isinstance(output, bytes) else output)
            raise
        record(f'EXIT {result.returncode}\n{result.stdout}{result.stderr}')
        if check and result.returncode:
            raise RuntimeError('Command failed; see live.log')
        return result

    def msb(*command, **options):
        return run([str(args.msb.resolve()), *command], **options)

    def guest(command, user='root', **options):
        return msb('exec', name, '--no-tty', '--user', user, '--env', f'USER={user}', '--env', f'LOGNAME={user}', '--', '/bin/sh', '-c', command, **options)

    try:
        record(f'Isolated runtime home: {root}; executable: {args.msb.resolve()}')
        manifest = json.loads((args.guest_image / 'manifest.json').read_text())
        archive = root / 'guest.tar'
        with gzip.open(args.guest_image / 'image.tar.gz', 'rb') as source, archive.open('wb') as target:
            shutil.copyfileobj(source, target)
        msb('image', 'load', '--input', str(archive), '--tag', manifest['imageReference'], '--quiet', timeout=300)
        msb('volume', 'create', 'account-workspace', '--kind', 'disk', '--size', '1G')
        msb('create', manifest['imageReference'], '--name', name, '--no-start', '--net', 'none', '--memory', '1G', '--cpus', '2', '--label', f'silo.machine-id={machine_id}', '--label', 'silo.working-account=1', '--mount-disk', f'{root / "home/volumes/account-workspace/disk.raw"}:/workspace:format=raw,fstype=ext4')
        created = True
        msb('start', name)
        guest('for tool in sudo python3 useradd; do command -v "$tool" || true; done; cat /etc/passwd')
        setup = args.setup_account.read_text()
        # This proves the guest cannot fetch dependencies; SSH travels over the
        # managed agent channel and remains available with guest networking off.
        network_probe = guest("timeout 3 /bin/bash -c 'exec 3<>/dev/tcp/1.1.1.1/443'", check=False, timeout=10)
        assert network_probe.returncode != 0, 'Guest unexpectedly reached the public network'
        guest(r"""set -eu
            mkdir -p /usr/local/bin
            for manager in apt apt-get dpkg; do
                cat > "/usr/local/bin/$manager" <<'SENTINEL'
#!/bin/sh
printf '%s\n' "$0 $*" >> /tmp/account-proof-package-manager-called
printf 'Unexpected package-manager call during offline account setup\n' >&2
exit 86
SENTINEL
                chmod 0755 "/usr/local/bin/$manager"
            done
        """)
        for executable in ('/usr/bin/sudo', '/usr/sbin/visudo', '/usr/bin/python3',
                           '/usr/sbin/runuser', '/usr/sbin/useradd', '/usr/sbin/groupadd',
                           '/usr/bin/findmnt', '/usr/lib/openssh/sftp-server'):
            present = guest(f'test -e {executable}', check=False).returncode == 0
            if present:
                guest(f'mv {executable} {executable}.account-proof-disabled')
            try:
                missing = guest(setup, check=False, timeout=15)
                assert missing.returncode != 0, f'Missing {executable} must refuse setup'
                guest('test ! -e /tmp/account-proof-package-manager-called')
                assert 'bundled' in (missing.stdout + missing.stderr).lower(), 'Missing tool error must identify the bundled guest image'
                guest('test ! -e /var/lib/silo/working-account-installing; test ! -e /var/lib/silo/working-account.json; ! getent passwd silo')
            finally:
                if present:
                    guest(f'mv {executable}.account-proof-disabled {executable}')
        record('PASS networking disabled and missing bundled tools fail before account or package-manager changes')

        # Unrelated existing accounts must be rejected before package installs.
        guest('groupadd -g 1001 conflict; useradd -u 1001 -g 1001 conflict; printf legacy > /root/legacy-data; chmod 600 /root/legacy-data')
        collision = guest(setup, check=False)
        assert collision.returncode != 0 and 'already exists' in collision.stderr
        guest('test ! -e /var/lib/silo/working-account-installing; userdel conflict; if getent group conflict >/dev/null; then groupdel conflict; fi')
        guest(setup, timeout=600)
        guest('printf sentinel > /workspace/root-owned; chmod 600 /workspace/root-owned')
        guest(setup)
        guest('test "$(stat -c %U:%a /workspace/root-owned)" = root:600; test "$(cat /workspace/root-owned)" = sentinel')
        guest('mv /var/lib/silo/working-account.json /var/lib/silo/working-account.json.saved; printf 1 > /var/lib/silo/working-account-installing')
        guest(setup)
        guest('test ! -e /var/lib/silo/working-account-installing; test "$(stat -c %U:%a /workspace/root-owned)" = root:600; cmp /var/lib/silo/working-account.json /var/lib/silo/working-account.json.saved')
        guest("printf '{}\\n' > /var/lib/silo/working-account.json")
        malformed = guest(setup, check=False)
        assert malformed.returncode != 0, 'Malformed account marker must fail closed'
        guest('mv /var/lib/silo/working-account.json.saved /var/lib/silo/working-account.json')
        record('PASS production setup refuses collisions and malformed policy, resumes interrupted setup, and preserves existing contents')
        identity = guest('id; printf "HOME=%s USER=%s LOGNAME=%s\\n" "$HOME" "$USER" "$LOGNAME"; pwd', user='silo')
        record('IDENTITY OBSERVATION ' + identity.stdout)
        guest('set -eu; test "$(id -un)" = silo; test "$HOME" = /home/silo; test "$USER" = silo; test "$LOGNAME" = silo; printf project > /workspace/project; printf tool > "$HOME/tool"; sudo -n test "$(sudo -n id -u)" = 0; test ! -r /root/legacy-data', user='silo')
        record('PASS exec identity, normal writes, sudo, and root file boundary')
        key = root / 'client'
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)])
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        endpoint = subprocess.Popen([str(args.msb.resolve()), 'ssh', 'serve', name, '--no-start', '--exit-on-stdin-close', '--authorized-keys', str(key) + '.pub', '--host', '127.0.0.1', '--port', str(port), '--expected-machine-id', machine_id], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
        with selectors.DefaultSelector() as selector:
            selector.register(endpoint.stdout, selectors.EVENT_READ)
            if not selector.select(15) or endpoint.stdout.readline() != b'SILO_SSH_READY\n':
                raise RuntimeError('SSH listener failed to become ready')
        common = ['-F', '/dev/null', '-i', str(key), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'StrictHostKeyChecking=accept-new', '-o', f'UserKnownHostsFile={root / "known_hosts"}']
        ssh = ['ssh', *common, '-p', str(port), 'silo@127.0.0.1']
        run([*ssh, 'set -eu; id; test "$(id -un)" = silo; test "$HOME" = /home/silo; test "$USER" = silo; test "$LOGNAME" = silo; printf ssh >> /workspace/project; sudo -n id -u'])
        record('PASS SSH command identity and shared workspace')
        tty_ssh = ['ssh', *common, '-p', str(port), '-tt', 'silo@127.0.0.1']
        run([*tty_ssh, 'test "$(id -un)" = silo && test "$HOME" = /home/silo && test "$USER" = silo && test "$LOGNAME" = silo && test "$(pwd)" = /home/silo'])
        record('PASS interactive SSH identity and home directory')
        (root / 'upload').write_text('sftp')
        sftp = ['sftp', *common, '-P', str(port), '-b', '-', 'silo@127.0.0.1']
        run(sftp, input=f'put {root / "upload"} /workspace/upload\nget /workspace/project {root / "download"}\n')
        assert (root / 'download').read_text() == 'projectssh'
        ownership = guest('stat -c "%U:%G" /workspace/upload').stdout.strip()
        assert ownership == 'silo:silo', ownership
        denied = run(sftp, check=False, input=f'put {root / "upload"} /root/forbidden\n')
        assert denied.returncode != 0, 'SFTP unexpectedly wrote root home'
        record('PASS SFTP shares normal identity and refuses root-owned private path')
        guest('mv /usr/lib/openssh/sftp-server /usr/lib/openssh/sftp-server.test-disabled')
        try:
            missing = run(sftp, check=False, input='pwd\n')
            assert missing.returncode != 0, 'Missing SFTP helper must fail closed'
        finally:
            guest('mv /usr/lib/openssh/sftp-server.test-disabled /usr/lib/openssh/sftp-server')
        record('PASS missing nonroot SFTP helper fails without root fallback')
        run(['scp', *common, '-P', str(port), str(root / 'upload'), 'silo@127.0.0.1:/workspace/scp-upload'])
        guest('test "$(stat -c %U /workspace/scp-upload)" = silo')
        root_sftp = [*sftp[:-1], 'root@127.0.0.1']
        run(root_sftp, input=f'put {root / "upload"} /root/root-sftp\n')
        guest('test "$(stat -c %U /root/root-sftp)" = root')
        record('PASS SCP uses normal ownership and legacy root SFTP remains available')

        github_setup = Path(__file__).resolve().parents[1] / 'src-tauri/guest/setup-github.sh'
        guest(github_setup.read_text(), timeout=600)
        credential = guest("printf 'protocol=https\\nhost=github.com\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill", user='silo').stdout
        assert 'username=x-access-token' in credential
        assert 'password=$MSB_SILO_GITHUB' in credential
        other_host = guest("printf 'protocol=https\\nhost=example.invalid\\n\\n' | /usr/local/libexec/silo-github-credential get", user='silo').stdout
        assert not other_host
        record('PASS normal user reads production system credential helper and receives only the placeholder for GitHub')
        guest(r"""set -eu
            git config --global user.name 'Silo Account Proof'
            git config --global user.email 'proof@example.invalid'
            git init --bare --initial-branch=main /workspace/git-remote.git
            git init --initial-branch=main /workspace/git-project
            cd /workspace/git-project
            git lfs track '*.bin'
            printf 'normal account commit\n' > README.txt
            python3 -c "from pathlib import Path; Path('payload.bin').write_bytes(bytes(range(256)) * 4096)"
            git add .gitattributes README.txt payload.bin
            git commit -m 'Working account Git and LFS proof'
            git remote add origin file:///workspace/git-remote.git
            git push -u origin main
            git lfs fsck
            git clone file:///workspace/git-remote.git /workspace/git-clone
            cmp payload.bin /workspace/git-clone/payload.bin
            cd /workspace/git-clone
            git lfs fsck
            test "$(git log -1 --format=%ae)" = proof@example.invalid
            test "$(stat -c %U .git/objects .git/lfs/objects payload.bin)" = "$(printf 'silo\nsilo\nsilo')"
        """, user='silo', timeout=180)
        record('PASS normal-user Git commit, push, clone and 1MiB LFS roundtrip with matching content and ownership')
        # Host Git uses only this test's key and explicit identity/configuration.
        # Transport reaches our loopback SSH listener; no external Git server.
        host_repo = root / 'host-git'
        ssh_command = shlex.join(['ssh', *common, '-p', str(port)])
        host_git = ['git', '-c', f'core.sshCommand={ssh_command}', '-c', 'core.hooksPath=/dev/null',
                    '-c', 'user.name=Silo Account Proof', '-c', 'user.email=proof@example.invalid',
                    '-c', 'commit.gpgSign=false', '-C', str(host_repo)]
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0')
        run(['git', 'init', '--bare', str(host_repo)])
        remote = f'ssh://silo@127.0.0.1:{port}/workspace/git-remote.git'
        run([*host_git, 'fetch', remote, 'main:refs/heads/main'])
        assert run([*host_git, 'show', 'main:README.txt']).stdout == 'normal account commit\n'
        run([*host_git, 'push', remote, 'main:refs/heads/from-host'])
        guest('set -eu; cd /workspace/git-project; git fetch origin from-host; test "$(git rev-parse FETCH_HEAD)" = "$(git rev-parse HEAD)"; test -z "$(find /workspace/git-remote.git ! -user silo -print -quit)"', user='silo')
        record('PASS Git SSH fetch/push as silo keeps repository files owned by silo')

        guest('set -eu; test "$(cat /root/legacy-data)" = legacy; test "$(stat -c %a /root/legacy-data)" = 600')
        msb('stop', name)
        if endpoint:
            endpoint.stdin.close()
            endpoint.wait(timeout=15)
        msb('start', name)
        guest('set -eu; test "$(cat /workspace/project)" = projectssh; test "$(cat "$HOME/tool")" = tool; sudo -n true', user='silo')
        record('PASS restart preserves project, home tool, and sudo')
        guest('test ! -e /tmp/account-proof-package-manager-called')
        record('PASS complete provisioning and Git workflow used no package manager with guest networking disabled')
        passed = True
    finally:
        if endpoint and endpoint.poll() is None:
            endpoint.stdin.close()
            try:
                endpoint.wait(timeout=15)
            except subprocess.TimeoutExpired:
                endpoint.terminate()
                endpoint.wait(timeout=15)
        if created:
            msb('stop', name, check=False)
        if passed:
            shutil.rmtree(root)
        else:
            record(f'Failure evidence retained at {root}')
        log.close()


if __name__ == '__main__':
    main()
