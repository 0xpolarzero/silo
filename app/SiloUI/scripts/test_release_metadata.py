import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('metadata',Path(__file__).with_name('verify-release-metadata.py'))
metadata=importlib.util.module_from_spec(spec);spec.loader.exec_module(metadata)
class MetadataTests(unittest.TestCase):
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
