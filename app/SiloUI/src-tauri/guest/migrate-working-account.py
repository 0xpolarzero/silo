#!/usr/bin/python3
"""Guest payload for the explicit host migration utility; never run on the host."""
import json
import os
from pathlib import Path
import pwd
import grp
import shutil
import stat
import subprocess
import sys

POLICY = {'schemaVersion': 1, 'user': 'silo', 'home': '/home/silo'}


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()


def copy_home(source, destination):
    """Preserve credentials and binary files; relocate home links and launch scripts."""
    def transient(directory, names):
        return [name for name in names
                if stat.S_ISSOCK((Path(directory) / name).lstat().st_mode)
                or stat.S_ISFIFO((Path(directory) / name).lstat().st_mode)]
    # A failed copy may already have installed links. Replace only matching source links.
    for path in source.rglob('*'):
        target = destination / path.relative_to(source)
        if path.is_symlink() and target.is_symlink():
            target.unlink()
    shutil.copytree(source, destination, symlinks=True, dirs_exist_ok=True, ignore=transient)
    for path in destination.rglob('*'):
        if path.is_symlink():
            target = os.readlink(path)
            updated = target.replace('/home/silo-desktop/', '/home/silo/').replace('/root/', '/home/silo/')
            if updated != target:
                path.unlink()
                path.symlink_to(updated)
        elif path.is_file() and (path.parent == destination and path.name in ('.bashrc', '.profile', '.bash_profile', '.zshrc', '.npmrc') or 'bin' in path.relative_to(destination).parts):
            # Installed launchers and shell setup contain absolute home paths.
            # Preserve binaries and all agent state/credential contents byte for byte.
            try:
                data = path.read_text()
            except (UnicodeError, OSError):
                continue
            updated = data.replace('/home/silo-desktop/', '/home/silo/').replace('/root/', '/home/silo/')
            if updated != data:
                path.write_text(updated)


def copy_shell_setup(source, destination):
    # The root account owns agent shell setup; desktop defaults must not replace it.
    for name in ('.bashrc', '.profile', '.bash_profile', '.zshrc', '.npmrc'):
        original, target = source / name, destination / name
        if original.is_file() and not original.is_symlink():
            if target.is_symlink():
                target.unlink()
            shutil.copy2(original, target)
            target.write_text(original.read_text().replace('/root/', '/home/silo/'))

    profile = destination / '.profile'
    if profile.exists() and '# Silo migrated user tools' in profile.read_text():
        return
    with profile.open('a') as output:
        output.write('\n# Silo migrated user tools\nif [ -d "$HOME/.local/bin" ]; then\n    export PATH="$HOME/.local/bin:$PATH"\nfi\n')


def validate_account(account):
    if account.pw_uid != 1001 or account.pw_gid != 1001 or account.pw_dir != '/home/silo':
        raise RuntimeError('The silo account does not match the migration layout.')


def migrate(helper, resume=False):
    if os.geteuid() != 0 or run('sh', '-c', '. /etc/os-release; printf "%s %s" "$ID" "$VERSION_ID"') != 'ubuntu 24.04':
        raise RuntimeError('Migration requires root inside an Ubuntu 24.04 Silo VM.')
    if run('findmnt', '-rn', '-T', '/workspace', '-o', 'TARGET,FSTYPE') != '/workspace ext4':
        raise RuntimeError('Migration requires the standard workspace disk.')
    marker = Path('/var/lib/silo/working-account.json')
    if marker.exists():
        if json.loads(marker.read_text()) != POLICY:
            raise RuntimeError('Unexpected working-account marker.')
        if run('id', '-u', 'silo') != '1001' or run('id', '-g', 'silo') != '1001' or pwd.getpwnam('silo').pw_dir != '/home/silo':
            raise RuntimeError('Completed account does not match its policy.')
        run('runuser', '-u', 'silo', '--', 'env', 'HOME=/home/silo', 'sh', '-ec', 'test -w "$HOME"; test -w /workspace; sudo -n true')
        return
    try:
        account = pwd.getpwnam('silo')
    except KeyError:
        account = None
    if account:
        if not resume:
            raise RuntimeError('Migration is incomplete. Resume with the original backup using --resume.')
        validate_account(account)
        if not Path('/home/silo').is_dir() or Path('/home/silo').is_symlink():
            raise RuntimeError('The partial migration home is invalid.')
    for lookup in (pwd.getpwuid, grp.getgrgid):
        try:
            entry = lookup(1001)
        except KeyError:
            continue
        if entry[0] != ('silo' if account else 'silo-desktop'):
            raise RuntimeError('UID/GID 1001 belongs to another account.')
    if not account and Path('/home/silo').exists():
        raise RuntimeError('/home/silo already exists without its expected account.')
    if not shutil.which('sudo') or not Path('/usr/lib/openssh/sftp-server').exists():
        run('apt-get', 'update')
        run('env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '--no-install-recommends', 'sudo', 'openssh-sftp-server')
    # Host stopped and restarted the VM, so terminal sessions have ended. Stop
    # only the known managed desktop, which may have started at boot.
    if not account and Path('/usr/local/bin/silo-desktop').exists():
        run('/usr/local/bin/silo-desktop', 'stop')
    try:
        desktop = pwd.getpwnam('silo-desktop')
    except KeyError:
        desktop = None
    if account:
        if desktop:
            raise RuntimeError('Both working accounts exist; cannot resume this migration.')
        desktop = Path('/home/silo-desktop').is_dir()
    elif desktop:
        if desktop.pw_uid != 1001 or desktop.pw_gid != 1001 or desktop.pw_dir != '/home/silo-desktop':
            raise RuntimeError('Unexpected legacy desktop account.')
        run('usermod', '-l', 'silo', '-d', '/home/silo', '-s', '/bin/bash', 'silo-desktop')
        run('groupmod', '-n', 'silo', 'silo-desktop')
        Path('/etc/sudoers.d/silo-desktop').unlink(missing_ok=True)
    else:
        run('groupadd', '--gid', '1001', 'silo')
        run('useradd', '--uid', '1001', '--gid', 'silo', '--create-home', '--shell', '/bin/bash', 'silo')
    home = Path('/home/silo')
    home.mkdir(exist_ok=True)
    # Root holds agent state; merge desktop preferences and files around it.
    copy_home(Path('/root'), home)
    if desktop:
        copy_home(Path('/home/silo-desktop'), home)
    copy_shell_setup(Path('/root'), home)
    run('chown', '-hR', 'silo:silo', str(home))
    # Do not traverse other mounts or follow symlinks into system/host files.
    run('find', '/workspace', '-xdev', '-exec', 'chown', '-h', 'silo:silo', '{}', '+')
    sudoers = Path('/etc/sudoers.d/silo')
    sudoers.write_text('silo ALL=(ALL:ALL) NOPASSWD: ALL\n')
    sudoers.chmod(0o440)
    run('visudo', '-cf', str(sudoers))
    state = Path('/var/lib/silo-desktop')
    if (state / 'installed.json').exists():
        service = Path('/usr/local/bin/silo-desktop')
        service.write_text(helper)
        service.chmod(0o755)
        (state / 'configuration-managed.json').write_text('{"home":"/home/silo"}\n')
        (state / 'configuration-managed.json').chmod(0o600)
    if run('id', '-u', 'silo') != '1001' or run('id', '-g', 'silo') != '1001':
        raise RuntimeError('Account verification failed.')
    run('runuser', '-u', 'silo', '--', 'env', 'HOME=/home/silo', 'USER=silo', 'LOGNAME=silo', 'sh', '-ec', 'test -w "$HOME"; test -w /workspace; sudo -n true; test -x /usr/lib/openssh/sftp-server')
    marker.parent.mkdir(parents=True, exist_ok=True)
    temporary = marker.with_suffix('.tmp')
    temporary.write_text(json.dumps(POLICY) + '\n')
    temporary.chmod(0o644)
    temporary.replace(marker)


if __name__ == '__main__':
    migrate(sys.argv[1], resume='--resume' in sys.argv[2:])
