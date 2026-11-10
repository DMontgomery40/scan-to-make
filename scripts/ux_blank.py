#!/usr/bin/env python3
"""The blank check: frames where a stage or picture that should show something shows nothing, with no progress and no
words to say why.

David, Nov 10, on the new build: "What you scanned" stayed blank on his phone while it fetched a 2–192 MB scan, and every
capture so far talked to a companion that answered instantly. `ux_screens.py --condition slow|refusing|away` makes the
companion behave like a real one; this reads what those runs saved (each frame's PNG and its accessibility tree,
`<frame>.ax.json`) and flags:

- an empty stage: a picture stage, known by the controls the app draws on it (the size chip "… × … × … mm", "N photos",
  "AR", "Explore in 3D"), whose area above those controls has no detail, with no progress indicator and no words in it;
- an empty picture: an unlabelled image element (a photo or render; labelled images are symbols) of 64 pt or more, wholly on
  screen, whose pixels are one flat colour.

    python3 scripts/ux_blank.py <screens folder>     # writes <folder>/blank.md; exits 1 when any frame is flagged

`ux_screens.py` runs it at the end of every capture and exits non-zero when it flags anything, so a gate can run it.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

STAGE_CONTROL = re.compile(r'(\d\s*[×x]\s*\d.*mm)|(^\d+ photos?$)|(^AR$)|(^Explore in 3D$)', re.I)
PROGRESS = re.compile(r'progress|activity|busy|spinner', re.I)
IMAGE = re.compile(r'image|picture|photo', re.I)
TEXT = re.compile(r'statictext|text$|label', re.I)
EDGE_BLANK = 1.2  # mean edge strength (0–255) under which an area has nothing drawn in it
FLAT_BLANK = 3.0  # pixel standard deviation under which a picture is one flat colour


def nodes(tree) -> list[dict]:
    """Every element in an agent-device snapshot, whatever its nesting: dicts with a role or type and a rect."""
    found, stack = [], [tree]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            rect = item.get('rect') or item.get('frame') or item.get('bounds')
            if isinstance(rect, dict) and {'x', 'y', 'width', 'height'} <= set(rect):
                found.append({'role': str(item.get('type') or item.get('role') or item.get('kind') or ''),
                              'label': str(item.get('label') or item.get('name') or item.get('title') or ''),
                              'value': str(item.get('value') or ''),
                              'id': str(item.get('identifier') or item.get('id') or ''),
                              'rect': {k: float(rect[k]) for k in ('x', 'y', 'width', 'height')}})
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    return found


def inside(rect: dict, area: tuple[float, float, float, float]) -> bool:
    x0, y0, x1, y1 = area
    cx, cy = rect['x'] + rect['width'] / 2, rect['y'] + rect['height'] / 2
    return x0 <= cx <= x1 and y0 <= cy <= y1


def measure(image, area: tuple[float, float, float, float], scale: float, exclude: list[dict]) -> tuple[float, float]:
    """Mean edge strength and pixel spread of an area (points), with the controls drawn over it masked out."""
    from PIL import ImageChops, ImageDraw, ImageFilter, ImageStat
    box = tuple(int(v * scale) for v in area)
    gray = image.convert('L').crop(box)
    if gray.width < 4 or gray.height < 4:
        return 255.0, 255.0
    edges = gray.filter(ImageFilter.FIND_EDGES)
    mask = gray.point(lambda _: 255)
    draw = ImageDraw.Draw(mask)
    for node in exclude:
        r = node['rect']
        draw.rectangle([(r['x'] - area[0]) * scale - 6, (r['y'] - area[1]) * scale - 6,
                        (r['x'] + r['width'] - area[0]) * scale + 6, (r['y'] + r['height'] - area[1]) * scale + 6], fill=0)
    edges = ImageChops.multiply(edges, mask)
    inner = edges.crop((2, 2, edges.width - 2, edges.height - 2))  # the crop's own border isn't content
    covered = max(1, ImageStat.Stat(mask).sum[0] / 255) / (mask.width * mask.height)
    return ImageStat.Stat(inner).mean[0] / covered, ImageStat.Stat(gray, mask).stddev[0]


def check_frame(png: Path, tree) -> list[str]:
    """What is blank in one frame, in words; empty when nothing is."""
    from PIL import Image
    with Image.open(png) as opened:
        image = opened.convert('RGB')
    elements = nodes(tree)
    if not elements:
        return []
    width = max(n['rect']['x'] + n['rect']['width'] for n in elements)
    scale = image.width / width if width else 1.0
    screen_h = image.height / scale
    problems = []
    controls = [n for n in elements if STAGE_CONTROL.search(n['label'].strip()) and n['rect']['height'] < 80]
    if controls:
        bottom = max(n['rect']['y'] + n['rect']['height'] for n in controls)
        top_of_controls = min(n['rect']['y'] for n in controls)
        left = min(n['rect']['x'] for n in controls) - 16
        right = max(n['rect']['x'] + n['rect']['width'] for n in controls) + 16
        # The stage: the full width of its controls' row, from well above them down to just over them.
        area = (max(0.0, left), max(0.0, top_of_controls - 220), min(width, right), max(0.0, top_of_controls - 4))
        within = [n for n in elements if inside(n['rect'], (area[0], area[1], area[2], bottom))]
        busy = [n for n in within if PROGRESS.search(n['role']) or PROGRESS.search(n['label'])]
        words = [n for n in within if TEXT.search(n['role']) and n['label'].strip() and not STAGE_CONTROL.search(n['label'].strip())
                 and n['rect']['y'] < area[3]]
        if area[3] - area[1] > 60 and not busy and not words:
            edge, _ = measure(image, area, scale, [n for n in within if n['rect']['y'] < area[3]])
            if edge < EDGE_BLANK:
                labels = ', '.join(sorted({n['label'].strip() for n in controls}))
                problems.append(f'empty stage: nothing drawn above its controls ({labels}), no progress and no words '
                                f'(detail {edge:.2f} < {EDGE_BLANK})')
    for node in elements:
        r = node['rect']
        # A content picture: unlabelled (labelled images are symbols and icons), at least 64 pt, wholly on screen.
        if (not IMAGE.search(node['role']) or node['label'].strip() not in ('', 'Image') or r['width'] < 64 or r['height'] < 64
                or r['x'] < 0 or r['y'] < 0 or r['x'] + r['width'] > width + 1 or r['y'] + r['height'] > screen_h + 1):
            continue
        area = (r['x'], r['y'], r['x'] + r['width'], r['y'] + r['height'])
        edge, spread = measure(image, area, scale, [])
        if spread < FLAT_BLANK and edge < EDGE_BLANK:
            problems.append(f'empty picture: "{node["label"] or node["id"] or node["role"]}" at {int(r["x"])},{int(r["y"])} '
                            f'{int(r["width"])}×{int(r["height"])} is one flat colour')
    return problems


def check_folder(out: Path) -> list[tuple[Path, list[str]]]:
    """Every captured frame (`<device>/<screen>-p<n>.png`). A frame without a readable tree of the app counts: the app
    was not on screen when it was taken (Nov 10, under `slow`: the app had crashed and the frame was the home screen)."""
    flagged = []
    for png in sorted(out.glob('*/*-p*.png')):
        tree_path = png.with_suffix('.ax.json')
        tree = json.loads(tree_path.read_text()) if tree_path.exists() else None
        if not tree or not nodes(tree):
            flagged.append((png, ['the app was not on screen: no accessibility tree of it could be read for this frame (crashed or not running)']))
            continue
        problems = check_frame(png, tree)
        if problems:
            flagged.append((png, problems))
    return flagged


def write_report(out: Path, flagged: list[tuple[Path, list[str]]]) -> Path:
    condition = (out / 'condition.txt').read_text().strip() if (out / 'condition.txt').exists() else 'none'
    checked = len(list(out.glob('*/*-p*.png')))
    lines = ['# Blank frames', '', f'Condition: **{condition}**. {checked} frames checked by `scripts/ux_blank.py`; '
             f'{len(flagged)} flagged: a stage or picture with nothing drawn and nothing said.', '']
    for png, problems in flagged:
        rel = png.relative_to(out)
        lines.append(f'- [{rel}]({rel}): ' + '; '.join(problems))
    report = out / 'blank.md'
    report.write_text('\n'.join(lines) + '\n')
    return report


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print(__doc__); return 2
    out = Path(argv[0]).resolve()
    flagged = check_folder(out)
    report = write_report(out, flagged)
    print(f'{len(flagged)} blank frames: {report}')
    return 1 if flagged else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
