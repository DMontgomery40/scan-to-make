#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Numbered, uncropped reference sheets using the companion's existing Pillow runtime.

Inputs are the pass's normalized photos, never the originals. Individual references
remain available at their original pass resolution. Each sheet holds at most 24 views.
"""
import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

CELL_WIDTH = 384
IMAGE_HEIGHT = 288
HEADER_HEIGHT = 28
PAGE_SIZE = 24


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('photos', nargs='+')
    args = parser.parse_args()
    output = Path(args.out)
    if not output.is_dir():
        raise SystemExit('photo output directory missing')
    written = []
    for start in range(0, len(args.photos), PAGE_SIZE):
        paths = args.photos[start:start + PAGE_SIZE]
        columns = min(4, len(paths))
        height = IMAGE_HEIGHT + HEADER_HEIGHT
        sheet = Image.new('RGB', (columns * CELL_WIDTH, math.ceil(len(paths) / columns) * height), 'white')
        draw = ImageDraw.Draw(sheet)
        for index, source in enumerate(paths):
            path = Path(source)
            with Image.open(path) as image:
                upright = ImageOps.exif_transpose(image).convert('RGBA')
                upright.thumbnail((CELL_WIDTH, IMAGE_HEIGHT), Image.Resampling.LANCZOS)
                x = (index % columns) * CELL_WIDTH
                y = (index // columns) * height
                draw.text((x + 8, y + 7), f'{start + index + 1}: {path.name}', fill='black')
                sheet.paste(upright, (x + (CELL_WIDTH - upright.width) // 2,
                                     y + HEADER_HEIGHT + (IMAGE_HEIGHT - upright.height) // 2), upright)
        name = f'overview-{len(written) + 1:02d}.jpg'
        with (output / name).open('xb') as stream:
            sheet.save(stream, format='JPEG', quality=90)
        written.append(name)
    print(json.dumps(written))


if __name__ == '__main__':
    main()
