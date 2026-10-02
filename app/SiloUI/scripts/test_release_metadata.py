import importlib.util
import io
import json
import os
import sys
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('metadata',Path(__file__).with_name('verify-release-metadata.py'))
metadata=importlib.util.module_from_spec(spec);spec.loader.exec_module(metadata)
class MetadataTests(unittest.TestCase):
    def test_wrong_debian_package_name_is_rejected(self):
        for arch, architecture in [('x64', 'amd64'), ('arm64', 'arm64')]:
            with self.subTest(arch=arch), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / f'Silo-linux-{arch}.deb').write_bytes(b'package fixture')
                fields = {'Package': 'unrelated', 'Version': '0.1.0', 'Architecture': architecture}
                def dpkg(command, **kwargs):
                    return '\n'.join(f'{name}: {fields[name]}' for name in command[3:]) + '\n'
                with patch.object(metadata.subprocess, 'check_output', side_effect=dpkg):
                    with self.assertRaisesRegex(RuntimeError, 'Debian.*mismatch'):
                        metadata.verify(root, '0.1.0')

    def test_debian_resource_identity_matches_control_fields(self):
        for arch, architecture, target in [('x64', 'amd64', 'x86_64-unknown-linux-gnu'),
                                            ('arm64', 'arm64', 'aarch64-unknown-linux-gnu')]:
            for version in ('0.1.0', '0.0.9'):
                with self.subTest(arch=arch, version=version), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    (root / f'Silo-linux-{arch}.deb').write_bytes(b'package fixture')
                    payload = root / 'payload.tar'
                    with tarfile.open(payload, 'w') as archive:
                        data = json.dumps({'version': version, 'target': target}).encode()
                        entry = tarfile.TarInfo('./usr/lib/Silo/release-info.json')
                        entry.size = len(data)
                        archive.addfile(entry, io.BytesIO(data))
                    dpkg = root / 'dpkg-deb'
                    dpkg.write_text(f'#!{sys.executable}\nimport sys\nfrom pathlib import Path\n'
                        f'if sys.argv[1] == "-f": print("Package: silo\\nVersion: 0.1.0\\nArchitecture: {architecture}")\n'
                        f'elif sys.argv[1] == "--fsys-tarfile": sys.stdout.buffer.write(Path({str(payload)!r}).read_bytes())\n'
                        'else: sys.exit(21)\n')
                    dpkg.chmod(0o755)
                    with patch.dict(os.environ, {'PATH': str(root) + os.pathsep + os.environ['PATH']}):
                        if version == '0.1.0': metadata.verify(root, '0.1.0')
                        else:
                            with self.assertRaisesRegex(RuntimeError, 'Signed package version'):
                                metadata.verify(root, '0.1.0')

    def test_macos_development_identifier_is_rejected(self):
        production = json.loads((Path(__file__).resolve().parent.parent / 'src-tauri/tauri.conf.json').read_text())['identifier']
        for identifier in (production, 'org.silo.dev', 'org.example.other'):
            with self.subTest(identifier=identifier), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with tarfile.open(root / 'Silo-macos-arm64.app.tar.gz', 'w:gz') as archive:
                    files = {
                        'Info.plist': plistlib.dumps({'CFBundleShortVersionString': '0.1.0',
                            'CFBundleIdentifier': identifier, 'CFBundleExecutable': 'silo-ui'}),
                        'Resources/release-info.json': b'{"version":"0.1.0","target":"aarch64-apple-darwin"}',
                        'MacOS/silo-ui': b'\xcf\xfa\xed\xfe\x0c\x00\x00\x01',
                    }
                    for name, data in files.items():
                        entry = tarfile.TarInfo('Silo.app/Contents/' + name)
                        entry.size = len(data)
                        archive.addfile(entry, io.BytesIO(data))
                if identifier == production: metadata.verify(root, '0.1.0')
                else:
                    with self.assertRaisesRegex(RuntimeError, 'macOS.*identity'):
                        metadata.verify(root, '0.1.0')

    def test_channel_bundle_name_is_used_when_inspecting_an_archive(self):
        from channel_names import channel_names
        names = channel_names()
        names = {**names, 'production': {**names['production'], 'productName': 'Fixture Channel'}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with tarfile.open(root / 'Fixture Channel-macos-arm64.app.tar.gz', 'w:gz') as archive:
                data = plistlib.dumps({'CFBundleShortVersionString': '0.1.0'})
                entry = tarfile.TarInfo('Fixture Channel.app/Contents/Info.plist')
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
            with patch.object(metadata, 'channel_names', return_value=names):
                with self.assertRaisesRegex(RuntimeError, 'macOS version mismatch'):
                    metadata.verify(root, '0.1.1')

    @unittest.skipUnless(shutil.which('dpkg-deb'), 'Linux Debian tools required')
    def test_real_debian_identity_accepts_silo_and_rejects_another_package(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tree = root / 'tree'
            (tree / 'DEBIAN').mkdir(parents=True)
            resources = tree / 'usr/lib/Silo'
            resources.mkdir(parents=True)
            (resources / 'release-info.json').write_text(json.dumps({'version': '0.1.0', 'target': 'x86_64-unknown-linux-gnu'}))
            for package in ('silo', 'unrelated'):
                (tree / 'DEBIAN/control').write_text(f'Package: {package}\nVersion: 0.1.0\nArchitecture: amd64\nMaintainer: Test\nDescription: Disposable identity fixture\n')
                subprocess.run(['dpkg-deb', '--build', str(tree), str(root / 'Silo-linux-x64.deb')], check=True, capture_output=True)
                if package == 'silo': metadata.verify(root, '0.1.0')
                else:
                    with self.assertRaisesRegex(RuntimeError, 'Debian.*mismatch'):
                        metadata.verify(root, '0.1.0')

    @unittest.skipUnless(shutil.which('dpkg-deb'), 'Linux Debian tools required')
    def test_real_debian_resources_reject_stale_wrong_target_and_missing_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tree = root / 'tree'
            (tree / 'DEBIAN').mkdir(parents=True)
            (tree / 'DEBIAN/control').write_text('Package: silo\nVersion: 0.1.0\nArchitecture: amd64\nMaintainer: Test\nDescription: Disposable metadata fixture\n')
            resource = tree / 'usr/lib/Silo/release-info.json'
            resource.parent.mkdir(parents=True)
            for data in ({'version': '0.0.9', 'target': 'x86_64-unknown-linux-gnu'},
                         {'version': '0.1.0', 'target': 'aarch64-unknown-linux-gnu'}, None):
                with self.subTest(data=data):
                    if data is None: resource.unlink()
                    else: resource.write_text(json.dumps(data))
                    subprocess.run(['dpkg-deb', '--build', str(tree), str(root / 'Silo-linux-x64.deb')], check=True, capture_output=True)
                    with self.assertRaisesRegex(RuntimeError, 'Signed package version|Missing Debian release metadata'):
                        metadata.verify(root, '0.1.0')

    def test_signed_old_version_rejected(self):
        with self.assertRaises(RuntimeError):metadata.identity('{"version":"0.1.0","target":"aarch64-unknown-linux-gnu"}','0.1.1','aarch64-unknown-linux-gnu')
    def test_signed_wrong_architecture_rejected(self):
        with self.assertRaises(RuntimeError):metadata.identity('{"version":"0.1.0","target":"x86_64-unknown-linux-gnu"}','0.1.0','aarch64-unknown-linux-gnu')
    def test_correct_identity(self):
        metadata.identity('{"version":"0.1.0","target":"aarch64-unknown-linux-gnu"}','0.1.0','aarch64-unknown-linux-gnu')
    def test_appimage_header_and_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory,'image')
            header=bytearray(64);header[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',header,18,183);struct.pack_into('<Q',header,40,64)
            path.write_bytes(header+b'hsqs')
            self.assertEqual(metadata.appimage_offset(path,183),64)
            with self.assertRaises(RuntimeError):metadata.appimage_offset(path,62)
            path.write_bytes(header+b'bad!')
            with self.assertRaises(RuntimeError):metadata.appimage_offset(path,183)
if __name__=='__main__':unittest.main()
