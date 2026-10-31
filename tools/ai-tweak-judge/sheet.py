# SPDX-License-Identifier: GPL-3.0-or-later
"""Side-by-side comparison sheets for the visual pick (KAN-184).

python sheet.py --out DIR --cell 800 A=renders/x B=renders/y ...

For every view and shading mode, writes compare_<mode>_<view>.png with the candidates side by side
under their blind labels. Only the labels the caller passes appear: never a candidate's origin.
"""
import argparse
import json
import os
import re

from PIL import Image, ImageDraw, ImageFont

LABEL = re.compile(r'^[A-Z]$')


def font(size):
    for path in ('/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--cell', type=int, default=800)
    parser.add_argument('candidates', nargs='+', metavar='LABEL=DIR')
    args = parser.parse_args()
    columns = []
    for item in args.candidates:
        label, _, folder = item.partition('=')
        if not LABEL.match(label) or not os.path.isdir(folder):
            raise SystemExit('candidates are A=DIR with one capital letter')
        columns.append((label, folder))
    # The candidate folders hold pictures only (render.json would name the source mesh).
    images = sorted(name for name in os.listdir(columns[0][1]) if name.endswith('.png'))
    if not images:
        raise SystemExit('no renders in ' + columns[0][1])
    os.makedirs(args.out, exist_ok=True)
    cell, header = args.cell, args.cell // 10
    title = font(max(18, cell // 14))
    written = []
    for image in images:
        sheet = Image.new('RGB', (cell * len(columns), header + cell), 'white')
        draw = ImageDraw.Draw(sheet)
        for index, (label, folder) in enumerate(columns):
            draw.text((index * cell + 12, 8), label, fill='black', font=title)
            path = os.path.join(folder, image)
            if os.path.exists(path):
                with Image.open(path) as render:
                    sheet.paste(render.convert('RGB').resize((cell, cell), Image.LANCZOS), (index * cell, header))
            draw.rectangle([index * cell, header, (index + 1) * cell - 1, header + cell - 1], outline=(170, 170, 170))
        name = 'compare_' + image
        sheet.save(os.path.join(args.out, name))
        written.append(name)
    print(json.dumps(written))


main()
