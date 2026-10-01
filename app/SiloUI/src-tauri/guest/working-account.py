#!/usr/bin/python3
"""Set up this Silo VM's silo working account; Silo runs it as root (see working-account.sh).

A new VM gets a fresh account. A VM from an older Silo kept agent files under /root,
and sometimes had a separate silo-desktop account: those homes are copied into
/home/silo and the originals stay in place. The account record is written last and
every step can be repeated, so an interrupted run finishes at the next boot.
"""
import grp
import json
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess
import sys

POLICY = {'schemaVersion': 1, 'user': 'silo', 'home': '/home/silo'}
RECORD = Path('/var/lib/silo/working-account.json')
HOME = Path('/home/silo')
# Checked before any change, so a missing tool never leaves a partial account.
TOOLS = ('findmnt', 'groupadd', 'groupmod', 'useradd', 'usermod', 'runuser', 'sudo', 'visudo')
SHELL_SETUP = ('.bashrc', '.profile', '.bash_profile', '.zshrc', '.npmrc')
PATH_SETUP = '\n# Silo migrated user tools\nif [ -d "$HOME/.local/bin" ]; then\n    export PATH="$HOME/.local/bin:$PATH"\nfi\n'


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()


def account(name):
    try:
        return pwd.getpwnam(name)
    except KeyError:
        return None


def group(name):
    try:
        return grp.getgrnam(name)
    except KeyError:
        return None


def carried(path, defaults=Path('/usr/share/base-files')):
    """False for a dotfile identical to the distribution's default for root, such as an
    unchanged /root/.bashrc: it carries nothing and would replace the account's own."""
    default = defaults / ('dot' + path.name)
    return not (path.name.startswith('.') and path.is_file() and not path.is_symlink()
                and default.is_file() and path.read_bytes() == default.read_bytes())


def copy_home(source, destination):
    """Preserve credentials and binary files; relocate home links and launch scripts."""
    def skipped(directory, names):
        directory = Path(directory)
        return [name for name in names
                if stat.S_ISSOCK((directory / name).lstat().st_mode)
                or stat.S_ISFIFO((directory / name).lstat().st_mode)
                or directory == source and not carried(directory / name)]
    # A failed copy may already have installed links. Replace only matching source links.
    for path in source.rglob('*'):
        target = destination / path.relative_to(source)
        if path.is_symlink() and target.is_symlink():
            target.unlink()
    shutil.copytree(source, destination, symlinks=True, dirs_exist_ok=True, ignore=skipped)
    for path in destination.rglob('*'):
        if path.is_symlink():
            target = os.readlink(path)
            updated = target.replace('/home/silo-desktop/', '/home/silo/').replace('/root/', '/home/silo/')
            if updated != target:
                path.unlink()
                path.symlink_to(updated)
        elif path.is_file() and (path.parent == destination and path.name in SHELL_SETUP or 'bin' in path.relative_to(destination).parts):
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
    for name in SHELL_SETUP:
        original, target = source / name, destination / name
        if original.is_file() and not original.is_symlink() and carried(original):
            if target.is_symlink():
                target.unlink()
            shutil.copy2(original, target)
            target.write_text(original.read_text().replace('/root/', '/home/silo/'))
            # Root's profile does not put the user's own tools on PATH.
            if name == '.profile' and PATH_SETUP not in target.read_text():
                with target.open('a') as output:
                    output.write(PATH_SETUP)


def validate_account(entry):
    if entry.pw_uid != 1001 or entry.pw_gid != 1001 or entry.pw_dir != '/home/silo':
        raise RuntimeError('The silo account does not match the layout Silo needs.')


def set_up(desktop_service):
    if os.geteuid() != 0 or run('sh', '-c', '. /etc/os-release; printf "%s %s" "$ID" "$VERSION_ID"') != 'ubuntu 24.04':
        raise RuntimeError('The silo account needs root inside an Ubuntu 24.04 Silo VM.')
    missing = [tool for tool in TOOLS if not shutil.which(tool)]
    if missing:
        raise RuntimeError(f'The sandbox is missing {", ".join(missing)}.')
    if run('findmnt', '-rn', '-T', '/workspace', '-o', 'TARGET,FSTYPE') != '/workspace ext4':
        raise RuntimeError('The silo account needs the standard workspace disk.')
    if RECORD.exists():
        if json.loads(RECORD.read_text()) != POLICY:
            raise RuntimeError('This sandbox records an account layout this Silo does not know. Update Silo.')
        return
    silo, desktop = account('silo'), account('silo-desktop')
    if silo and desktop:
        raise RuntimeError('Both the silo and silo-desktop accounts exist.')
    for lookup in (pwd.getpwuid, grp.getgrgid):
        try:
            entry = lookup(1001)
        except KeyError:
            continue
        if entry[0] not in ('silo', 'silo-desktop'):
            raise RuntimeError('The reserved account ID 1001 belongs to another account.')
    if HOME.is_symlink() or HOME.exists() and not HOME.is_dir():
        raise RuntimeError('The silo home folder is not a folder.')
    if HOME.exists() and not silo and not desktop:
        raise RuntimeError('The silo home folder exists without its account.')
    # Each step checks what an interrupted earlier run already did.
    if desktop:
        if desktop.pw_uid != 1001 or desktop.pw_gid != 1001 or desktop.pw_dir != '/home/silo-desktop':
            raise RuntimeError('The old silo-desktop account has an unexpected layout.')
        # Stop the managed desktop, which may have started at boot, before renaming its account.
        if Path('/usr/local/bin/silo-desktop').exists():
            run('/usr/local/bin/silo-desktop', 'stop')
        run('usermod', '-l', 'silo', '-d', '/home/silo', '-s', '/bin/bash', 'silo-desktop')
    if not group('silo'):
        if group('silo-desktop'):
            run('groupmod', '-n', 'silo', 'silo-desktop')
        else:
            run('groupadd', '--gid', '1001', 'silo')
    if not account('silo'):
        run('useradd', '--uid', '1001', '--gid', 'silo', '--create-home', '--shell', '/bin/bash', '--comment', 'Silo working account', 'silo')
    validate_account(account('silo'))
    Path('/etc/sudoers.d/silo-desktop').unlink(missing_ok=True)
    HOME.mkdir(exist_ok=True)
    # Root holds agent state; merge desktop preferences and files around it.
    copy_home(Path('/root'), HOME)
    if Path('/home/silo-desktop').is_dir():
        copy_home(Path('/home/silo-desktop'), HOME)
    copy_shell_setup(Path('/root'), HOME)
    run('chown', '-hR', 'silo:silo', str(HOME))
    # Do not traverse other mounts or follow symlinks into system or host files.
    run('find', '/workspace', '-xdev', '-exec', 'chown', '-h', 'silo:silo', '{}', '+')
    sudoers = Path('/etc/sudoers.d/silo')
    sudoers.write_text('silo ALL=(ALL:ALL) NOPASSWD: ALL\n')
    sudoers.chmod(0o440)
    run('visudo', '-cf', str(sudoers))
    state = Path('/var/lib/silo-desktop')
    if (state / 'installed.json').exists():
        service = Path('/usr/local/bin/silo-desktop')
        service.write_text(desktop_service)
        service.chmod(0o755)
        (state / 'configuration-managed.json').write_text('{"home":"/home/silo"}\n')
        (state / 'configuration-managed.json').chmod(0o600)
    run('runuser', '-u', 'silo', '--', 'env', 'HOME=/home/silo', 'USER=silo', 'LOGNAME=silo', 'sh', '-ec', 'test -w "$HOME"; test -w /workspace; sudo -n true; test -x /usr/lib/openssh/sftp-server')
    RECORD.parent.mkdir(parents=True, exist_ok=True)
    temporary = RECORD.with_suffix('.tmp')
    temporary.write_text(json.dumps(POLICY, separators=(',', ':')) + '\n')
    temporary.chmod(0o644)
    temporary.replace(RECORD)


if __name__ == '__main__':
    set_up(sys.argv[1])
