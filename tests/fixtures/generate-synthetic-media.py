"""Generate fixed synthetic media without opening an original fixture."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import zlib

FFMPEG = os.environ.get('WASALX_FFMPEG') or shutil.which('ffmpeg')
assert FFMPEG, 'ffmpeg is required to regenerate the committed synthetic fixtures'
IMAGE = {'width': 64, 'height': 64, 'rgb': [128, 128, 128]}
AUDIO = {'codec': 'opus', 'sample_rate': 48000, 'channels': 1, 'duration': 1}
VIDEO = {'width': 64, 'height': 64, 'fps': 10, 'duration': 1, 'audio': False}


def chunk(kind, body):
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))


def run(args):
    result = subprocess.run([str(FFMPEG), '-nostdin', '-hide_banner', '-n', '-fflags', '+bitexact', '-threads', '1', '-filter_threads', '1', *args], capture_output=True, timeout=45, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    assert result.returncode == 0, 'fixed synthetic media generation failed; diagnostics withheld'


def generate(output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress((b'\x00' + b'\x80\x80\x80' * 64) * 64, 9)) + chunk(b'IEND', b'')
    with (output / 'image.png').open('xb') as f:
        f.write(png)
    run(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '1', '-c:a', 'libopus', '-flags:a', '+bitexact', '-map_metadata', '-1', '-fflags', '+bitexact', str(output / 'audio.ogg')])
    run(['-f', 'lavfi', '-i', 'color=c=gray:size=64x64:rate=10', '-t', '1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-flags:v', '+bitexact', '-map_metadata', '-1', '-movflags', '+faststart', '-an', '-fflags', '+bitexact', str(output / 'video.mp4')])
    hashes = {name: hashlib.sha256((output / name).read_bytes()).hexdigest() for name in ('image.png', 'audio.ogg', 'video.mp4')}
    proof = {'generator': 'media-generator.py', 'generator_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'policy': 'A21_FIXED_MEDIA_NO_ORIGINAL_INPUT', 'content': 'fixed gray pixels and silent samples', 'image': IMAGE, 'audio': AUDIO, 'video': VIDEO, 'sha256': hashes}
    with (output / 'provenance.json').open('x', encoding='utf-8') as f:
        f.write(json.dumps(proof, indent=2) + '\n')
    return hashes


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    generate(parser.parse_args().output)
    print('A21_FIXED_MEDIA_PASS')
