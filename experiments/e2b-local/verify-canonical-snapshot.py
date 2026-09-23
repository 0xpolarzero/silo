#!/usr/bin/env python3
"""Read and hash the canonical local object closure for one E2B build.

The input root must be the canonical storage directory containing ``templates``.
This command never opens a cache, VM, service, or guest. It emits a manifest only
after every required object has been read successfully.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import stat
import sys
from pathlib import Path
from uuid import UUID


SPEC = importlib.util.spec_from_file_location(
    "inspect_snapshot_header", Path(__file__).with_name("inspect-snapshot-header.py")
)
assert SPEC and SPEC.loader
inspect = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inspect)

MAX_BUILDS = 1024
MAX_TOTAL_BYTES = 16 * 1024**4
MAX_METADATA_BYTES = 16 * 1024**2
MAX_SNAPFILE_BYTES = 256 * 1024**2
MAX_SIZE_SIDECAR_BYTES = 64
CHUNK_BYTES = 1024 * 1024
REQUIRED_SIDECARS = ("metadata.json", "snapfile", "memfile.header", "rootfs.ext4.header")
COMPRESSION_SUFFIXES = {0: "", 1: ".zstd", 2: ".lz4"}
NIL = UUID(int=0)
DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
FILE_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)


class VerificationError(ValueError):
    pass


def _uuid(value: str) -> UUID:
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError) as exc:
        raise VerificationError(f"invalid build ID: {value!r}") from exc
    if parsed == NIL or str(parsed) != value:
        raise VerificationError(f"build ID must be a non-nil canonical UUID: {value!r}")
    return parsed


def _read_object(directory_fd: int, name: str, budget: list[int]) -> tuple[dict[str, object], bytes | None]:
    limit = (MAX_METADATA_BYTES if name == "metadata.json" else
             MAX_SNAPFILE_BYTES if name == "snapfile" else
             MAX_SIZE_SIDECAR_BYTES if name.endswith(".uncompressed-size") else
             inspect.MAX_HEADER_BYTES if name.endswith(".header") else MAX_TOTAL_BYTES)
    fd = os.open(name, FILE_FLAGS, dir_fd=directory_fd)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise VerificationError(f"{name} is not a regular file")
        if before.st_size == 0 or before.st_size > limit:
            raise VerificationError(f"{name} has an empty or over-limit size")
        if before.st_size > budget[0]:
            raise VerificationError("canonical object byte budget exceeded")
        digest = hashlib.sha256()
        data = bytearray() if name in ("metadata.json", "memfile.header", "rootfs.ext4.header") or name.endswith(".uncompressed-size") else None
        size = 0
        while chunk := os.read(fd, CHUNK_BYTES):
            size += len(chunk)
            if size > before.st_size or size > budget[0]:
                raise VerificationError(f"{name} grew or exceeded the byte budget during readback")
            digest.update(chunk)
            if data is not None:
                data.extend(chunk)
        after = os.fstat(fd)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if size != before.st_size or identity(before) != identity(after):
            raise VerificationError(f"{name} changed during readback")
        budget[0] -= size
        return {"bytes": size, "sha256": digest.hexdigest()}, bytes(data) if data is not None else None
    finally:
        os.close(fd)


def _verify_build(directory_fd: int, current: UUID, budget: list[int]) -> tuple[dict[str, object], set[UUID]]:
    objects = {}
    contents = {}
    for name in REQUIRED_SIDECARS:
        objects[name], contents[name] = _read_object(directory_fd, name, budget)
    try:
        metadata = json.loads(contents["metadata.json"])
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VerificationError(f"{current}: invalid metadata JSON") from exc
    if not isinstance(metadata, dict) or type(metadata.get("version")) is not int or metadata["version"] != 2:
        raise VerificationError(f"{current}: unsupported metadata version")
    template = metadata.get("template")
    if not isinstance(template, dict) or template.get("build_id") != str(current):
        raise VerificationError(f"{current}: metadata build ID does not match directory")

    headers = {}
    dependencies = set()
    for artifact in ("memfile", "rootfs.ext4"):
        try:
            header = inspect.parse_header(contents[artifact + ".header"], artifact)
        except inspect.HeaderError as exc:
            raise VerificationError(f"{current}/{artifact}.header: {exc}") from exc
        if header["build_id"] != str(current):
            raise VerificationError(f"{current}/{artifact}.header: build ID does not match directory")
        headers[artifact] = header
        for value in (header["base_build_id"], *header["referenced_build_ids"],
                      *header.get("build_table_ids", [])):
            dependency = _uuid(value) if value != str(NIL) else NIL
            if dependency not in (NIL, current):
                dependencies.add(dependency)

        if header["version"] & 0xFFFF == 3:
            # V3 has no serialized build table or compression metadata.
            body_name = artifact
        else:
            self_build = header["build_table"].get(str(current))
            if self_build is None:
                raise VerificationError(f"{current}/{artifact}.header: missing self build table entry")
            if self_build["uncompressed_bytes"] == 0:
                continue  # The upload path emits no data object for an empty diff.
            body_name = artifact + COMPRESSION_SUFFIXES[self_build["compression"]]
        objects[body_name], _ = _read_object(directory_fd, body_name, budget)
        if body_name != artifact:
            sidecar_name = body_name + ".uncompressed-size"
            objects[sidecar_name], sidecar = _read_object(directory_fd, sidecar_name, budget)
            # The FS sidecar records the source file's full size. A sparse
            # frame table may cover fewer bytes than that source file.
            if not sidecar.isdigit() or int(sidecar) < self_build["uncompressed_bytes"]:
                raise VerificationError(f"{current}/{sidecar_name}: invalid uncompressed size")

    return ({"build_id": str(current), "objects": objects, "headers": headers,
             "dependencies": sorted(map(str, dependencies))}, dependencies)


def verify(storage_root: Path, build_id: str) -> dict[str, object]:
    initial = _uuid(build_id)
    if not storage_root.is_absolute():
        raise VerificationError("storage root must be an absolute path")
    root_fd = os.open(storage_root, DIR_FLAGS)
    try:
        templates_fd = os.open("templates", DIR_FLAGS, dir_fd=root_fd)
        try:
            pending = [initial]
            visited: set[UUID] = set()
            results = []
            budget = [MAX_TOTAL_BYTES]
            while pending:
                current = pending.pop()
                if current in visited:
                    continue
                if len(visited) >= MAX_BUILDS:
                    raise VerificationError(f"build closure exceeds {MAX_BUILDS} builds")
                directory_fd = os.open(str(current), DIR_FLAGS, dir_fd=templates_fd)
                try:
                    row, dependencies = _verify_build(directory_fd, current, budget)
                finally:
                    os.close(directory_fd)
                visited.add(current)
                pending.extend(sorted(dependencies - visited, key=str))
                results.append(row)
            return {"build_id": str(initial), "storage_root": str(storage_root),
                    "build_count": len(results), "object_count": sum(len(row["objects"]) for row in results),
                    "bytes_read": MAX_TOTAL_BYTES - budget[0],
                    "builds": sorted(results, key=lambda row: row["build_id"])}
        finally:
            os.close(templates_fd)
    finally:
        os.close(root_fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--storage-root", required=True, type=Path,
                        help="canonical local storage root containing templates/")
    parser.add_argument("--build-id", required=True, help="exact canonical build UUID")
    args = parser.parse_args()
    try:
        result = verify(args.storage_root, args.build_id)
    except (OSError, VerificationError) as exc:
        print(f"canonical snapshot readback failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
