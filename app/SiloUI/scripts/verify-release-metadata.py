"""Inspect signed package identity without running any packaged executable."""
import json
from pathlib import Path, PurePosixPath
import plistlib
import struct
import subprocess
import sys
import tarfile
from channel_names import channel_names

TARGETS = {'arm64': 'aarch64-unknown-linux-gnu', 'x64': 'x86_64-unknown-linux-gnu'}

def identity(data, version, target):
    if json.loads(data) != {'version': version, 'target': target}:
        raise RuntimeError('Signed package version or architecture does not match the release.')

def appimage_offset(path, machine):
    with path.open('rb') as source:
        header=source.read(64)
        if len(header)!=64 or header[:6]!=b'\x7fELF\x02\x01' or struct.unpack_from('<H',header,18)[0]!=machine:
            raise RuntimeError('AppImage ELF architecture does not match the release.')
        if header[8:11]!=b'AI\x02':
            raise RuntimeError('Release package is not a type 2 AppImage.')
        offset=struct.unpack_from('<Q',header,40)[0]+struct.unpack_from('<H',header,58)[0]*struct.unpack_from('<H',header,60)[0]
        if offset<64 or offset>=path.stat().st_size:
            raise RuntimeError('Invalid AppImage filesystem offset.')
        source.seek(offset)
        if source.read(4)!=b'hsqs':raise RuntimeError('AppImage filesystem is not SquashFS.')
    return offset

def verify(root, version):
    production=channel_names()['production']
    product_name=production['productName']
    bundle_name=product_name+'.app'
    archive=root/f'{product_name}-macos-arm64.app.tar.gz'
    if archive.exists():
        with tarfile.open(archive,'r:gz') as tar:
            names=set()
            for member in tar.getmembers():
                path=PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0]!=bundle_name or str(path) in names:
                    raise RuntimeError('Invalid macOS archive layout or duplicate entry.')
                names.add(str(path))
            def read(name):
                member=tar.getmember(bundle_name+'/Contents/'+name)
                if not member.isfile() or member.size>1024*1024:raise RuntimeError('Invalid macOS metadata entry.')
                return tar.extractfile(member).read()
            info=plistlib.loads(read('Info.plist'))
            if info['CFBundleShortVersionString']!=version:raise RuntimeError('macOS version mismatch.')
            if info.get('CFBundleIdentifier')!=production['identifier']:raise RuntimeError('macOS application identity mismatch.')
            identity(read('Resources/release-info.json'),version,'aarch64-apple-darwin')
            binary=tar.getmember(bundle_name+'/Contents/MacOS/'+info['CFBundleExecutable'])
            if not binary.isfile():raise RuntimeError('Invalid macOS executable.')
            header=tar.extractfile(binary).read(8)
            if header!=b'\xcf\xfa\xed\xfe\x0c\x00\x00\x01':raise RuntimeError('macOS executable is not ARM64.')
    for arch,target in TARGETS.items():
        package=root/f'{product_name}-linux-{arch}.deb'
        if package.exists():
            fields=subprocess.check_output(['dpkg-deb','-f',str(package),'Package','Version','Architecture'],text=True).splitlines()
            expected=['Package: silo','Version: '+version,'Architecture: '+('amd64' if arch=='x64' else 'arm64')]
            if fields!=expected:raise RuntimeError('Debian package, version or architecture mismatch.')
        image=root/f'{product_name}-linux-{arch}.AppImage'
        if image.exists():
            offset=appimage_offset(image,62 if arch=='x64' else 183)
            metadata=subprocess.check_output(['unsquashfs','-cat','-o',str(offset),str(image),f'usr/lib/{product_name}/release-info.json'])
            identity(metadata,version,target)

if __name__=='__main__':verify(Path(sys.argv[1]),sys.argv[2])
