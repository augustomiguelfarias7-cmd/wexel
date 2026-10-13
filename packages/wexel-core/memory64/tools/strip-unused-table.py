#!/usr/bin/env python3
"""Remove the unused linker-generated table from this table-free Memory64 VFS module."""
from pathlib import Path
import sys

if len(sys.argv) != 3:
    raise SystemExit("usage: strip-unused-table.py INPUT.wasm OUTPUT.wasm")
source, destination = map(Path, sys.argv[1:])
data = source.read_bytes()
if data[:8] != b"\x00asm\x01\x00\x00\x00":
    raise SystemExit("input is not a WebAssembly v1 module")

def read_uleb(buf: bytes, offset: int):
    value = 0
    shift = 0
    while True:
        if offset >= len(buf) or shift > 35:
            raise SystemExit("invalid section length encoding")
        byte = buf[offset]
        offset += 1
        value |= (byte & 0x7f) << shift
        if byte < 0x80:
            return value, offset
        shift += 7

sections = []
offset = 8
while offset < len(data):
    start = offset
    section_id = data[offset]
    offset += 1
    size, payload_start = read_uleb(data, offset)
    end = payload_start + size
    if end > len(data):
        raise SystemExit("section extends past end of module")
    sections.append((section_id, data[start:end]))
    offset = end

if any(section_id == 9 for section_id, _ in sections):
    raise SystemExit("refusing to remove table: module has an element section")
if sum(section_id == 4 for section_id, _ in sections) > 1:
    raise SystemExit("unexpected multiple table sections")

output = bytearray(data[:8])
removed = 0
for section_id, raw in sections:
    if section_id == 4:
        removed += 1
    else:
        output.extend(raw)
if removed > 1:
    raise SystemExit("unexpected multiple table sections")
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_bytes(output)
print(f"Removed {removed} unused table section(s); wrote {destination} ({len(output)} bytes)")
