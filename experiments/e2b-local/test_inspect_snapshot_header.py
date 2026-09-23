from __future__ import annotations

import ctypes
import ctypes.util
import importlib.util
import struct
import unittest
from pathlib import Path
from uuid import UUID


SCRIPT = Path(__file__).with_name("inspect-snapshot-header.py")
SPEC = importlib.util.spec_from_file_location("inspect_snapshot_header", SCRIPT)
assert SPEC and SPEC.loader
inspect = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inspect)


def compress_frame(data: bytes) -> bytes:
    name = ctypes.util.find_library("lz4")
    if not name:
        raise unittest.SkipTest("liblz4 is required for the synthetic header test")
    lib = ctypes.CDLL(name)
    size_t = ctypes.c_size_t
    void_p = ctypes.c_void_p
    lib.LZ4F_compressFrameBound.argtypes = [size_t, void_p]
    lib.LZ4F_compressFrameBound.restype = size_t
    lib.LZ4F_compressFrame.argtypes = [void_p, size_t, void_p, size_t, void_p]
    lib.LZ4F_compressFrame.restype = size_t
    lib.LZ4F_isError.argtypes = [size_t]
    lib.LZ4F_isError.restype = ctypes.c_uint

    source = ctypes.create_string_buffer(data)
    capacity = lib.LZ4F_compressFrameBound(len(data), None)
    destination = ctypes.create_string_buffer(capacity)
    written = lib.LZ4F_compressFrame(destination, capacity, source, len(data), None)
    if lib.LZ4F_isError(written):
        raise AssertionError("liblz4 failed to create test frame")
    return destination.raw[:written]


def make_header(version: int, build_id: UUID, base_id: UUID, referenced_id: UUID) -> bytes:
    # V4/V5 shared Builds section: count; UUID + size + checksum; empty frame table.
    block = bytearray(struct.pack("<I", 1))
    block += referenced_id.bytes + struct.pack("<q", 4096) + bytes(32)
    block += struct.pack("<II", 0, 0)
    if version == 4:
        block += struct.pack("<I", 1)
        block += struct.pack("<QQ16sQ", 0, 4096, referenced_id.bytes, 0)
    else:
        # V5 compact mapping: distinct build IDs, entry count, then four varint columns.
        block += struct.pack("<I", 1) + referenced_id.bytes + struct.pack("<I", 1)
        block += b"\x00"  # offset delta in pages
        block += b"\x01"  # length in pages
        block += b"\x00"  # signed storage delta (Go varint zig-zag)
        block += b"\x00"  # build ID table index

    metadata = struct.pack("<QQQQ", version, 4096, 4096, 7) + build_id.bytes + base_id.bytes
    return metadata + b"\x00" + struct.pack("<I", len(block)) + compress_frame(bytes(block))


class HeaderSummaryTests(unittest.TestCase):
    def test_v4_returns_only_header_lineage_ids(self) -> None:
        build = UUID("4d52ff40-ea41-4b1d-887c-0c000e4a5a8f")
        base = UUID("11111111-1111-4111-8111-111111111111")
        layer = UUID("22222222-2222-4222-8222-222222222222")
        result = inspect.parse_header(make_header(4, build, base, layer), "memfile")
        self.assertEqual(result["build_id"], str(build))
        self.assertEqual(result["base_build_id"], str(base))
        self.assertEqual(result["referenced_build_ids"], [str(layer)])
        self.assertEqual(result["build_table_ids"], [str(layer)])
        self.assertNotIn("checksum", result)
        self.assertNotIn("offset", result)

    def test_v5_returns_compact_mapping_build_ids(self) -> None:
        build = UUID("4d52ff40-ea41-4b1d-887c-0c000e4a5a8f")
        base = UUID("33333333-3333-4333-8333-333333333333")
        layer = UUID("44444444-4444-4444-8444-444444444444")
        result = inspect.parse_header(make_header(5, build, base, layer), "rootfs.ext4")
        self.assertEqual(result["version"], 5)
        self.assertEqual(result["referenced_build_ids"], [str(layer)])

    def test_v3_reads_fixed_mapping_records(self) -> None:
        build = UUID("4d52ff40-ea41-4b1d-887c-0c000e4a5a8f")
        base = UUID("55555555-5555-4555-8555-555555555555")
        layer = UUID("66666666-6666-4666-8666-666666666666")
        metadata = struct.pack("<QQQQ", 3, 4096, 4096, 2) + build.bytes + base.bytes
        row = struct.pack("<QQ16sQ", 0, 4096, layer.bytes, 0)
        result = inspect.parse_header(metadata + row, "memfile")
        self.assertEqual(result["version"], 3)
        self.assertEqual(result["base_build_id"], str(base))
        self.assertEqual(result["referenced_build_ids"], [str(layer)])

    def test_rejects_unsupported_legacy_version(self) -> None:
        with self.assertRaisesRegex(inspect.HeaderError, "only V3/V4/V5"):
            inspect.parse_header(bytes(64), "memfile")


if __name__ == "__main__":
    unittest.main()
