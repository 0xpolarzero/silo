"""Keep Silo's private tools out of /usr/bin and away from system Git."""
import argparse
import hashlib
from pathlib import Path
import subprocess
import tempfile
import shutil

TOOLS=('msb','git','git-lfs','git-remote-http','git-remote-https')
parser=argparse.ArgumentParser();parser.add_argument('package',type=Path);args=parser.parse_args()
package=args.package.resolve()
with tempfile.TemporaryDirectory(prefix='silo-deb-') as directory:
    root=Path(directory,'package')
    subprocess.run(['dpkg-deb','--raw-extract',str(package),str(root)],check=True)
    private=root/'usr/lib/Silo/bin';private.mkdir(parents=True,exist_ok=True)
    for name in TOOLS:
        source=root/'usr/bin'/name
        if not source.is_file() or source.is_symlink():raise RuntimeError('Expected bundled executable '+name)
        source.rename(private/name)
    if {path.name for path in (root/'usr/bin').iterdir()}!={'silo-ui'}:
        raise RuntimeError('Silo must not install unrelated commands into /usr/bin.')
    support=Path(__file__).with_name('debian')
    for name in ('config', 'preinst', 'postinst', 'postrm', 'templates'):
        destination=root/'DEBIAN'/name
        if destination.exists():raise RuntimeError('Refusing to overwrite existing maintainer script '+name)
        shutil.copyfile(support/name, destination)
        destination.chmod(0o644 if name == 'templates' else 0o755)
    for source, target in [('silo-system-update', 'usr/lib/silo/silo-system-update'), ('org.silo.update.policy', 'usr/share/polkit-1/actions/org.silo.update.policy'), ('silo.sources', 'usr/share/silo/apt/silo.sources'), ('silo-archive-keyring.gpg', 'usr/share/keyrings/silo-archive-keyring.gpg')]:
        destination=root/target;destination.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(support/source,destination);destination.chmod(0o755 if source == 'silo-system-update' else 0o644)
    control=root/'DEBIAN/control'
    text=control.read_text()
    import re
    if re.search(r'^Depends:',text,re.M):
        text=re.sub(r'^Depends: ', 'Depends: debconf (>= 0.5) | debconf-2.0, ca-certificates, python3, pkexec, ',text, count=1, flags=re.M)
    else:text = text.rstrip() + '\nDepends: debconf (>= 0.5) | debconf-2.0, ca-certificates, python3, pkexec\n'
    control.write_text(text)
    sums=root/'DEBIAN/md5sums'
    if sums.exists():
        lines=[]
        for path in sorted(root.rglob('*')):
            if path.is_file() and not path.is_symlink() and 'DEBIAN' not in path.relative_to(root).parts:
                with path.open('rb') as file: digest=hashlib.file_digest(file,'md5').hexdigest()
                lines.append(f'{digest}  {path.relative_to(root)}\n')
        sums.write_text(''.join(lines))
    rebuilt=Path(directory,'Silo.deb')
    subprocess.run(['dpkg-deb','--root-owner-group','--build',str(root),str(rebuilt)],check=True)
    # Copy beside the original for same-filesystem atomic replacement.
    staged=package.with_suffix('.rebuilt')
    shutil.copyfile(rebuilt,staged);staged.replace(package)
    # Tauri's original signature covers the pre-relocation package. APT verifies
    # these bytes through signed repository metadata; never keep a stale .sig.
    Path(str(package)+'.sig').unlink(missing_ok=True)
