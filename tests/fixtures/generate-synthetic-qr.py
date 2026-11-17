"""Regenerate the non-operational fixed synthetic pairing raster."""
from pathlib import Path
import struct, zlib
def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
rows = [b'\0' + b''.join((b'\0\0\0' if (x // 4 + y // 4) % 2 == 0 else b'\xff\xff\xff') for x in range(64)) for y in range(64)]
raw = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')
Path(__file__).with_name('waha').joinpath('synthetic-qr.png').write_bytes(raw)
