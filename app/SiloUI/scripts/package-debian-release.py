"""Keep Silo's private tools out of /usr/bin and away from system Git."""
import argparse
import hashlib
from pathlib import Path
import subprocess
import tempfile

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
    import shutil
    staged=package.with_suffix('.rebuilt')
    shutil.copyfile(rebuilt,staged);staged.replace(package)
    # Tauri's original signature covers the pre-relocation package. Debian updates
    # are manual package-manager installs, so never leave a stale .sig beside it.
    Path(str(package)+'.sig').unlink(missing_ok=True)
