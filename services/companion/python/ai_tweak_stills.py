#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Write close-up photos as upright full-resolution JPEGs for a sealed AI attempt.

The agent sees ordinary .jpg files: EXIF orientation is applied to the pixels (two of
Thing's twelve stills were stored rotated), HEIC is decoded, and no resizing happens.
"""
import argparse
import json
from pathlib import Path
import re
import sys

MAX_SOURCE_BYTES = 64 * 1024 * 1024
NAME = re.compile(r'^still_[0-9]{2}_[0-9a-f]{8}\.jpg$')
HEIC_BRANDS = {b'heic', b'heix', b'heim', b'heis', b'hevc', b'hevm', b'hevs', b'mif1', b'mif2'}


def kind(raw):
    if raw.startswith(b'\xff\xd8\xff'):
        return 'jpeg'
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP':
        return 'webp'
    if raw[4:8] == b'ftyp' and any(raw[i:i + 4] in HEIC_BRANDS for i in range(8, min(len(raw), 64), 4)):
        return 'heic'
    raise ValueError('not a JPEG, PNG, WebP or HEIC image')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--still', nargs=2, action='append', default=[], metavar=('SOURCE', 'NAME'))
    args = parser.parse_args()
    from io import BytesIO
    from PIL import Image, ImageOps
    out = Path(args.out)
    if not out.is_dir():
        raise SystemExit('output directory missing')
    report = []
    for source, name in args.still:
        if not NAME.match(name):
            raise SystemExit('invalid still name')
        path = Path(source)
        if not path.is_file() or path.is_symlink():
            raise SystemExit('still is not a regular file')
        raw = path.read_bytes()
        if len(raw) > MAX_SOURCE_BYTES:
            raise SystemExit('still exceeds 64 MiB')
        fmt = kind(raw)
        if fmt == 'heic':
            import pillow_heif
            pillow_heif.register_heif_opener()
        with Image.open(BytesIO(raw)) as image:
            image.load()
            orientation = image.getexif().get(274, 1)
            upright = ImageOps.exif_transpose(image)
            if upright.mode in ('RGBA', 'LA') or 'transparency' in upright.info:
                rgba = upright.convert('RGBA')
                flat = Image.new('RGB', rgba.size, 'white')
                flat.paste(rgba, mask=rgba.getchannel('A'))
                upright = flat
            else:
                upright = upright.convert('RGB')
            target = out / name
            with target.open('xb') as stream:
                upright.save(stream, format='JPEG', quality=95)
            report.append({'name': name, 'source': fmt, 'orientation': orientation, 'size': list(upright.size)})
    json.dump(report, sys.stdout)


if __name__ == '__main__':
    main()
