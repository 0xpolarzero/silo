"""Inspect signed package identity without running any packaged executable."""
import json
from pathlib import Path
import plistlib
import struct
import subprocess
import sys
import tarfile

TARGETS = {'arm64': 'aarch64-unknown-linux-gnu', 'x64': 'x86_64-unknown-linux-gnu'}

def identity(data, version, target):
    if json.loads(data) != {'version': version, 'target': target}:
        raise RuntimeError('Signed package version or architecture does not match the release.')

def appimage_offset(path, machine):
    with path.open('rb') as source:
        header=source.read(64)
        if len(header)!=64 or header[:6]!=b'\x7fELF\x02\x01' or struct.unpack_from('<H',header,18)[0]!=machine:
            raise RuntimeError('AppImage ELF architecture does not match the release.')
        offset=struct.unpack_from('<Q',header,40)[0]+struct.unpack_from('<H',header,58)[0]*struct.unpack_from('<H',header,60)[0]
        if offset<64 or offset>=path.stat().st_size:
            raise RuntimeError('Invalid AppImage filesystem offset.')
        source.seek(offset)
        if source.read(4)!=b'hsqs':raise RuntimeError('AppImage filesystem is not SquashFS.')
    return offset

def verify(root, version):
    archive=root/'Silo-macos-arm64.app.tar.gz'
    if archive.exists():
        with tarfile.open(archive,'r:gz') as tar:
            def read(name):
                member=tar.getmember('Silo.app/Contents/'+name)
                if not member.isfile() or member.size>1024*1024:raise RuntimeError('Invalid macOS metadata entry.')
                return tar.extractfile(member).read()
            info=plistlib.loads(read('Info.plist'))
            if info['CFBundleShortVersionString']!=version:raise RuntimeError('macOS version mismatch.')
            identity(read('Resources/release-info.json'),version,'aarch64-apple-darwin')
            binary=tar.getmember('Silo.app/Contents/MacOS/'+info['CFBundleExecutable'])
            if not binary.isfile():raise RuntimeError('Invalid macOS executable.')
            header=tar.extractfile(binary).read(8)
            if header!=b'\xcf\xfa\xed\xfe\x0c\x00\x00\x01':raise RuntimeError('macOS executable is not ARM64.')
    for arch,target in TARGETS.items():
        package=root/f'Silo-linux-{arch}.deb'
        if package.exists():
            fields=subprocess.check_output(['dpkg-deb','-f',str(package),'Version','Architecture'],text=True).splitlines()
            expected=['Version: '+version,'Architecture: '+('amd64' if arch=='x64' else 'arm64')]
            if fields!=expected:raise RuntimeError('Debian version or architecture mismatch.')
        image=root/f'Silo-linux-{arch}.AppImage'
        if image.exists():
            offset=appimage_offset(image,62 if arch=='x64' else 183)
            metadata=subprocess.check_output(['unsquashfs','-cat','-o',str(offset),str(image),'usr/lib/Silo/release-info.json'])
            identity(metadata,version,target)

if __name__=='__main__':verify(Path(sys.argv[1]),sys.argv[2])
