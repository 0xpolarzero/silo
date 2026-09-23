#!/usr/bin/env python3
"""Print build lineage IDs from E2B V3/V4/V5 header sidecars only.

This intentionally never opens the associated memfile/rootfs data bodies.
The binary layout follows the pinned runtime's shared/pkg/storage/header parser.

Example (run only where these preserved sidecars have been copied):
  python3 experiments/e2b-local/inspect-snapshot-header.py \
    /var/lib/e2b/storage/templates/4d52ff40-ea41-4b1d-887c-0c000e4a5a8f
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import json
import os
import stat
import struct
import sys
from pathlib import Path
from uuid import UUID

MAX_HEADER_BYTES = 256 * 1024 * 1024
MAX_BUILDS = 1_000_000
MAX_V5_MAPPING_BUILDS = 65_535
MAX_V5_MAPPING_ENTRIES = 8 * 1024 * 1024
MAX_FRAME_COUNT = 1024 * 1024
METADATA_SIZE = 64
LZ4F_VERSION = 100


class HeaderError(ValueError):
    pass


def _need(data: bytes, offset: int, count: int, what: str) -> bytes:
    end = offset + count
    if count < 0 or end > len(data):
        raise HeaderError(f"truncated {what}")
    return data[offset:end]


def _u32(data: bytes, offset: int, what: str) -> tuple[int, int]:
    return struct.unpack("<I", _need(data, offset, 4, what))[0], offset + 4


def _read_uvarint(data: bytes, offset: int, what: str) -> tuple[int, int]:
    value = 0
    for shift in range(0, 70, 7):
        byte = _need(data, offset, 1, what)[0]
        offset += 1
        if shift == 63 and byte > 1:
            raise HeaderError(f"invalid {what}")
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, offset
    raise HeaderError(f"invalid {what}")


def _read_varint(data: bytes, offset: int, what: str) -> tuple[int, int]:
    raw, offset = _read_uvarint(data, offset, what)
    return (raw >> 1) ^ -(raw & 1), offset


def _lz4_library() -> ctypes.CDLL:
    name = ctypes.util.find_library("lz4")
    if not name:
        raise HeaderError("liblz4 is required to read V4/V5 header metadata")
    lib = ctypes.CDLL(name)
    size_t_p = ctypes.POINTER(ctypes.c_size_t)
    void_p = ctypes.c_void_p
    lib.LZ4F_createDecompressionContext.argtypes = [ctypes.POINTER(void_p), ctypes.c_uint]
    lib.LZ4F_createDecompressionContext.restype = ctypes.c_size_t
    lib.LZ4F_freeDecompressionContext.argtypes = [void_p]
    lib.LZ4F_freeDecompressionContext.restype = ctypes.c_size_t
    lib.LZ4F_decompress.argtypes = [void_p, void_p, size_t_p, void_p, size_t_p, void_p]
    lib.LZ4F_decompress.restype = ctypes.c_size_t
    lib.LZ4F_isError.argtypes = [ctypes.c_size_t]
    lib.LZ4F_isError.restype = ctypes.c_uint
    return lib


def _decompress_lz4_frame(src: bytes, expected_size: int) -> bytes:
    if not 0 <= expected_size <= MAX_HEADER_BYTES:
        raise HeaderError(f"declared decompressed header size exceeds {MAX_HEADER_BYTES} bytes")
    lib = _lz4_library()
    context = ctypes.c_void_p()
    code = lib.LZ4F_createDecompressionContext(ctypes.byref(context), LZ4F_VERSION)
    if lib.LZ4F_isError(code):
        raise HeaderError("liblz4 could not create a decompression context")

    source = ctypes.create_string_buffer(src)
    destination = ctypes.create_string_buffer(max(expected_size, 1))
    source_offset = 0
    destination_offset = 0
    try:
        while True:
            src_size = ctypes.c_size_t(len(src) - source_offset)
            dst_size = ctypes.c_size_t(expected_size - destination_offset)
            src_ptr = ctypes.c_void_p(ctypes.addressof(source) + source_offset)
            dst_ptr = ctypes.c_void_p(ctypes.addressof(destination) + destination_offset)
            hint = lib.LZ4F_decompress(
                context,
                dst_ptr,
                ctypes.byref(dst_size),
                src_ptr,
                ctypes.byref(src_size),
                None,
            )
            if lib.LZ4F_isError(hint):
                raise HeaderError("invalid LZ4 frame in header")
            source_offset += src_size.value
            destination_offset += dst_size.value
            if hint == 0:
                if source_offset != len(src):
                    raise HeaderError("trailing bytes after LZ4 header frame")
                if destination_offset != expected_size:
                    raise HeaderError("decompressed header size does not match its prefix")
                return destination.raw[:destination_offset]
            if source_offset == len(src) or (src_size.value == 0 and dst_size.value == 0):
                raise HeaderError("incomplete LZ4 frame in header")
            if destination_offset >= expected_size:
                raise HeaderError("LZ4 header expands beyond its declared size")
    finally:
        lib.LZ4F_freeDecompressionContext(context)


def _parse_build_section(block: bytes, offset: int) -> tuple[int, dict[str, dict[str, int]]]:
    count, offset = _u32(block, offset, "build count")
    if count > MAX_BUILDS:
        raise HeaderError("build count exceeds parser limit")
    # Every entry has 56 fixed bytes and an 8-byte frame table header.
    if count > (len(block) - offset) // 64:
        raise HeaderError("build count exceeds remaining header bytes")
    builds = {}
    for _ in range(count):
        row = _need(block, offset, 56, "build metadata")
        build_id = UUID(bytes=row[:16])
        size = struct.unpack_from("<q", row, 16)[0]
        if build_id.int == 0 or size < 0 or str(build_id) in builds:
            raise HeaderError("invalid or duplicate build table entry")
        offset += 56
        compression, offset = _u32(block, offset, "frame compression type")
        frames, offset = _u32(block, offset, "frame count")
        if compression not in (0, 1, 2):
            raise HeaderError("unknown frame compression type")
        if frames > MAX_FRAME_COUNT or (compression == 0 and frames != 0):
            raise HeaderError("invalid frame count")
        frame_bytes = frames * 24
        _need(block, offset, frame_bytes, "frame table")
        offset += frame_bytes
        builds[str(build_id)] = {"uncompressed_bytes": size,
                                 "compression": compression if frames else 0,
                                 "frame_count": frames}
    return offset, builds


def _parse_v4_mapping_ids(block: bytes, offset: int) -> tuple[list[UUID], int]:
    count, offset = _u32(block, offset, "V4 mapping count")
    if count > (len(block) - offset) // 40:
        raise HeaderError("V4 mapping count exceeds remaining header bytes")
    ids = set()
    for _ in range(count):
        row = _need(block, offset, 40, "V4 mapping")
        build_id = UUID(bytes=row[16:32])
        if build_id.int != 0:  # uuid.Nil denotes an empty region, not a layer.
            ids.add(build_id)
        offset += 40
    return sorted(ids, key=lambda item: item.bytes), offset


def _parse_v3_mapping_ids(block: bytes, build_id: UUID) -> list[UUID]:
    # V3 serializes fixed 40-byte mapping records to EOF, with no count prefix.
    if len(block) % 40:
        raise HeaderError("V3 mapping section has a partial 40-byte record")
    ids = set()
    for offset in range(0, len(block), 40):
        row = block[offset : offset + 40]
        mapping_offset, length = struct.unpack_from("<QQ", row)
        layer_id = UUID(bytes=row[16:32])
        storage_offset = struct.unpack_from("<Q", row, 32)[0]
        # NewMapping (used by the runtime's V3 deserializer) requires page-aligned
        # ranges that fit its uint32 page-index representation.
        if any(value % 4096 for value in (mapping_offset, length, storage_offset)):
            raise HeaderError("V3 mapping has a range that is not page aligned")
        if any(value // 4096 > 0xFFFFFFFF for value in (mapping_offset, length, storage_offset)):
            raise HeaderError("V3 mapping page index exceeds runtime limits")
        if layer_id.int != 0:
            ids.add(layer_id)
    if not block:
        # NewHeader creates an identity mapping to the header's own build ID
        # when deserialization receives no mapping records.
        ids.add(build_id)
    return sorted(ids, key=lambda item: item.bytes)


def _parse_v5_mapping_ids(block: bytes, offset: int) -> tuple[list[UUID], int]:
    count, offset = _u32(block, offset, "V5 mapping build count")
    if count > MAX_V5_MAPPING_BUILDS or count > (len(block) - offset) // 16:
        raise HeaderError("V5 mapping build count exceeds parser limit or remaining bytes")
    ids = [UUID(bytes=_need(block, offset + 16 * i, 16, "V5 mapping build ID")) for i in range(count)]
    offset += count * 16
    entries, offset = _u32(block, offset, "V5 mapping count")
    if entries > MAX_V5_MAPPING_ENTRIES or entries > (len(block) - offset) // 4:
        raise HeaderError("V5 mapping count exceeds parser limit or remaining bytes")
    # Validate all four encoded columns without retaining guest offsets/ranges.
    for label in ("V5 mapping offset", "V5 mapping length"):
        for _ in range(entries):
            _, offset = _read_uvarint(block, offset, label)
    for _ in range(entries):
        _, offset = _read_varint(block, offset, "V5 mapping storage delta")
    for _ in range(entries):
        index, offset = _read_uvarint(block, offset, "V5 mapping build index")
        if index >= count:
            raise HeaderError("V5 mapping build index is out of range")
    return sorted(set(ids), key=lambda item: item.bytes), offset


def parse_header(data: bytes, artifact: str) -> dict[str, object]:
    if len(data) > MAX_HEADER_BYTES:
        raise HeaderError(f"header file exceeds {MAX_HEADER_BYTES} bytes")
    if len(data) < METADATA_SIZE:
        raise HeaderError("header is shorter than metadata")

    version, block_size, size, generation = struct.unpack_from("<QQQQ", data)
    format_version = version & 0xFFFF
    build_id = UUID(bytes=data[32:48])
    base_build_id = UUID(bytes=data[48:64])
    if format_version not in (3, 4, 5):
        raise HeaderError(f"unsupported header version {version}; only V3/V4/V5 are parsed")
    if block_size == 0:
        raise HeaderError("header has zero block size")
    if format_version == 3:
        referenced = _parse_v3_mapping_ids(data[METADATA_SIZE:], build_id)
        return {
            "artifact": artifact,
            "version": version,
            "generation": generation,
            "build_id": str(build_id),
            "base_build_id": str(base_build_id),
            "referenced_build_ids": [str(item) for item in referenced],
        }
    if len(data) < METADATA_SIZE + 5:
        raise HeaderError("V4/V5 header is truncated before its LZ4 frame")

    if data[METADATA_SIZE] & 1:
        raise HeaderError("header is marked as pending upload")
    expected_size = struct.unpack_from("<I", data, METADATA_SIZE + 1)[0]
    compressed = data[METADATA_SIZE + 5 :]
    block = _decompress_lz4_frame(compressed, expected_size)
    offset, build_table = _parse_build_section(block, 0)
    referenced, offset = (_parse_v4_mapping_ids(block, offset) if format_version == 4
                          else _parse_v5_mapping_ids(block, offset))
    if offset != len(block):
        raise HeaderError("trailing bytes in V4/V5 mapping block")
    return {
        "artifact": artifact,
        "version": version,
        "generation": generation,
        "build_id": str(build_id),
        "base_build_id": str(base_build_id),
        "referenced_build_ids": [str(item) for item in referenced],
        "build_table_ids": sorted(build_table),
        "build_table": build_table,
    }


def inspect_build(build_dir: Path) -> list[dict[str, object]]:
    # Explicit sidecar allowlist: never derive or open the corresponding bodies.
    files = (("memfile", build_dir / "memfile.header"), ("rootfs.ext4", build_dir / "rootfs.ext4.header"))
    results = []
    for artifact, path in files:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        try:
            metadata = os.fstat(fd)
            if not stat.S_ISREG(metadata.st_mode):
                raise HeaderError(f"{path.name} is not a regular file")
            if metadata.st_size > MAX_HEADER_BYTES:
                raise HeaderError(f"{path.name} exceeds {MAX_HEADER_BYTES} bytes")
            with os.fdopen(fd, "rb", closefd=False) as sidecar:
                contents = sidecar.read(MAX_HEADER_BYTES + 1)
        finally:
            os.close(fd)
        if len(contents) > MAX_HEADER_BYTES:
            raise HeaderError(f"{path.name} exceeds {MAX_HEADER_BYTES} bytes")
        results.append(parse_header(contents, artifact))
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build_dir", type=Path, help="directory containing only the two header sidecars to inspect")
    args = parser.parse_args()
    try:
        print(json.dumps(inspect_build(args.build_dir), indent=2))
    except (OSError, HeaderError) as exc:
        print(f"header inspection failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
