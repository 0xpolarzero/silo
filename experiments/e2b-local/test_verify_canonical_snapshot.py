from __future__ import annotations

import ctypes
import ctypes.util
import hashlib
import importlib.util
import json
import shutil
import struct
import tempfile
import unittest
from pathlib import Path
from uuid import UUID


SCRIPT = Path(__file__).with_name("verify-canonical-snapshot.py")
SPEC = importlib.util.spec_from_file_location("verify_canonical_snapshot", SCRIPT)
assert SPEC and SPEC.loader
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)

ROOT = UUID("11111111-1111-4111-8111-111111111111")
MEMORY = UUID("22222222-2222-4222-8222-222222222222")
DISK = UUID("33333333-3333-4333-8333-333333333333")
SHARED = UUID("44444444-4444-4444-8444-444444444444")
NIL = UUID(int=0)


def header(build: UUID, base: UUID, mapped: tuple[UUID, ...]) -> bytes:
    metadata = struct.pack("<QQQQ", 3, 4096, 4096, 1) + build.bytes + base.bytes
    rows = b"".join(struct.pack("<QQ16sQ", index * 4096, 4096, dependency.bytes, 0)
                    for index, dependency in enumerate(mapped))
    return metadata + rows


def compressed_header(build: UUID, compression: int, version: int = 4,
                      pending: bool = False, size: int = 4096) -> bytes:
    block = bytearray(struct.pack("<I", 1))
    block += build.bytes + struct.pack("<q", size) + bytes(32)
    frames = 1 if compression else 0
    block += struct.pack("<II", compression, frames)
    if frames:
        block += struct.pack("<qqII", 0, 0, size, 128)
    if version == 4:
        block += struct.pack("<IQQ16sQ", 1, 0, size, build.bytes, 0)
    else:
        block += struct.pack("<I", 1) + build.bytes + struct.pack("<I", 1)
        block += b"\x00\x01\x00\x00"
    lib = ctypes.CDLL(ctypes.util.find_library("lz4"))
    lib.LZ4F_compressFrameBound.argtypes = [ctypes.c_size_t, ctypes.c_void_p]
    lib.LZ4F_compressFrameBound.restype = ctypes.c_size_t
    lib.LZ4F_compressFrame.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p,
                                       ctypes.c_size_t, ctypes.c_void_p]
    lib.LZ4F_compressFrame.restype = ctypes.c_size_t
    source = ctypes.create_string_buffer(bytes(block))
    destination = ctypes.create_string_buffer(lib.LZ4F_compressFrameBound(len(block), None))
    written = lib.LZ4F_compressFrame(destination, len(destination), source, len(block), None)
    metadata = struct.pack("<QQQQ", version, 4096, size, 1) + build.bytes + NIL.bytes
    return metadata + bytes([int(pending)]) + struct.pack("<I", len(block)) + destination.raw[:written]


def add_build(storage: Path, build: UUID, memory_base: UUID = NIL, disk_base: UUID = NIL,
              memory_mapped: tuple[UUID, ...] = (), disk_mapped: tuple[UUID, ...] = ()) -> None:
    directory = storage / "templates" / str(build)
    directory.mkdir(parents=True)
    files = {
        "metadata.json": json.dumps({"version": 2, "template": {"build_id": str(build)}}).encode(),
        "snapfile": b"device state for " + build.bytes,
        "memfile.header": header(build, memory_base, memory_mapped),
        "rootfs.ext4.header": header(build, disk_base, disk_mapped),
        "memfile": b"memory body for " + build.bytes,
        "rootfs.ext4": b"disk body for " + build.bytes,
    }
    for name, contents in files.items():
        (directory / name).write_bytes(contents)


class CanonicalSnapshotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.storage = Path(self.temp.name)

    def fixture(self) -> None:
        add_build(self.storage, ROOT, MEMORY, DISK, (SHARED,), (DISK,))
        add_build(self.storage, MEMORY, memory_mapped=(SHARED,))
        add_build(self.storage, DISK)
        add_build(self.storage, SHARED)

    def test_reads_both_lineages_and_hashes_all_six_objects_per_build(self) -> None:
        self.fixture()
        result = verify.verify(self.storage, str(ROOT))
        self.assertEqual(result["build_count"], 4)
        self.assertEqual(result["object_count"], 24)
        self.assertEqual({row["build_id"] for row in result["builds"]},
                         {str(ROOT), str(MEMORY), str(DISK), str(SHARED)})
        for row in result["builds"]:
            for name, record in row["objects"].items():
                contents = (self.storage / "templates" / row["build_id"] / name).read_bytes()
                self.assertEqual(record, {"bytes": len(contents),
                                          "sha256": hashlib.sha256(contents).hexdigest()})

    def test_missing_ancestor_or_body_refuses_manifest(self) -> None:
        self.fixture()
        (self.storage / "templates" / str(DISK) / "rootfs.ext4").unlink()
        with self.assertRaises(FileNotFoundError):
            verify.verify(self.storage, str(ROOT))
        shutil.rmtree(self.storage / "templates" / str(DISK))
        with self.assertRaises(FileNotFoundError):
            verify.verify(self.storage, str(ROOT))

    def test_header_build_mismatch_refuses_manifest(self) -> None:
        self.fixture()
        path = self.storage / "templates" / str(ROOT) / "memfile.header"
        path.write_bytes(header(MEMORY, NIL, ()))
        with self.assertRaisesRegex(verify.VerificationError, "build ID does not match"):
            verify.verify(self.storage, str(ROOT))

    def test_unsupported_header_and_metadata_versions_refuse_manifest(self) -> None:
        add_build(self.storage, ROOT)
        directory = self.storage / "templates" / str(ROOT)
        (directory / "rootfs.ext4.header").write_bytes(struct.pack("<Q", 2) + bytes(56))
        with self.assertRaisesRegex(verify.VerificationError, "unsupported header version"):
            verify.verify(self.storage, str(ROOT))
        (directory / "rootfs.ext4.header").write_bytes(header(ROOT, NIL, ()))
        (directory / "metadata.json").write_text(json.dumps({"version": 3, "template": {"build_id": str(ROOT)}}))
        with self.assertRaisesRegex(verify.VerificationError, "unsupported metadata version"):
            verify.verify(self.storage, str(ROOT))

    def test_symlinked_object_and_build_directory_are_refused(self) -> None:
        add_build(self.storage, ROOT)
        directory = self.storage / "templates" / str(ROOT)
        path = directory / "snapfile"
        path.unlink()
        path.symlink_to(directory / "metadata.json")
        with self.assertRaises(OSError):
            verify.verify(self.storage, str(ROOT))
        path.unlink()
        path.write_bytes(b"state")
        relocated = self.storage / "relocated"
        directory.rename(relocated)
        directory.symlink_to(relocated, target_is_directory=True)
        with self.assertRaises(OSError):
            verify.verify(self.storage, str(ROOT))

    def test_byte_budget_and_noncanonical_id_are_refused(self) -> None:
        add_build(self.storage, ROOT)
        original = verify.MAX_TOTAL_BYTES
        try:
            verify.MAX_TOTAL_BYTES = 20
            with self.assertRaisesRegex(verify.VerificationError, "byte budget"):
                verify.verify(self.storage, str(ROOT))
        finally:
            verify.MAX_TOTAL_BYTES = original
        with self.assertRaisesRegex(verify.VerificationError, "canonical UUID"):
            verify.verify(self.storage, "AAAAAAAA-AAAA-4AAA-AAAA-AAAAAAAAAAAA")

    def test_v4_compressed_bodies_and_size_sidecars(self) -> None:
        add_build(self.storage, ROOT)
        directory = self.storage / "templates" / str(ROOT)
        for artifact, compression, suffix in (("memfile", 1, ".zstd"),
                                               ("rootfs.ext4", 2, ".lz4")):
            (directory / (artifact + ".header")).write_bytes(compressed_header(ROOT, compression))
            (directory / artifact).unlink()
            (directory / (artifact + suffix)).write_bytes(b"compressed " + artifact.encode())
            (directory / (artifact + suffix + ".uncompressed-size")).write_bytes(b"4096")
        result = verify.verify(self.storage, str(ROOT))
        self.assertEqual(result["object_count"], 8)
        self.assertIn("memfile.zstd.uncompressed-size", result["builds"][0]["objects"])
        (directory / "memfile.zstd.uncompressed-size").write_bytes(b"8192")
        self.assertEqual(verify.verify(self.storage, str(ROOT))["object_count"], 8)
        (directory / "memfile.zstd.uncompressed-size").write_bytes(b"1024")
        with self.assertRaisesRegex(verify.VerificationError, "invalid uncompressed size"):
            verify.verify(self.storage, str(ROOT))
        (directory / "memfile.zstd.uncompressed-size").write_bytes(b"4096")
        (directory / "rootfs.ext4.lz4.uncompressed-size").unlink()
        with self.assertRaises(FileNotFoundError):
            verify.verify(self.storage, str(ROOT))

    def test_v5_mixed_body_names_and_pending_header(self) -> None:
        add_build(self.storage, ROOT)
        directory = self.storage / "templates" / str(ROOT)
        (directory / "memfile.header").write_bytes(compressed_header(ROOT, 2, version=5))
        (directory / "rootfs.ext4.header").write_bytes(compressed_header(ROOT, 0, version=5))
        (directory / "memfile").unlink()
        (directory / "memfile.lz4").write_bytes(b"compressed memory")
        (directory / "memfile.lz4.uncompressed-size").write_bytes(b"4096")
        result = verify.verify(self.storage, str(ROOT))
        self.assertEqual(result["object_count"], 7)
        (directory / "memfile.header").write_bytes(compressed_header(ROOT, 2, version=5, pending=True))
        with self.assertRaisesRegex(verify.VerificationError, "pending upload"):
            verify.verify(self.storage, str(ROOT))


if __name__ == "__main__":
    unittest.main()
