#!/usr/bin/env python3
"""The blank check: frames where a stage or picture that should show something shows nothing, with no progress and no
words to say why.

David, Nov 10, on the new build: "What you scanned" stayed blank on his phone while it fetched a 2–192 MB scan, and every
capture so far talked to a companion that answered instantly. `ux_screens.py --condition slow|refusing|away` makes the
companion behave like a real one; this reads what those runs saved (each frame's PNG and its accessibility tree,
`<frame>.ax.json`) and flags:

- a stage that fails its state (main's StagePicture, `gallery-stage-picture`, #539): "shown" with nothing drawn, or
  "loading" / "not available" without its drawn line of words (a bare backdrop, or a spinner alone). The pixels decide,
  so a stage cannot pass on its label;
- an empty stage without that element (a model stage): known by the controls the app draws on it (the size chip
  "… × … × … mm", "N photos", "AR", "Explore in 3D"), whose area above those controls has no detail, with no progress
  indicator and no words in it;
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
LINE_MIN_PT = 60  # a drawn line of words is at least this wide; a spinner is about 20 pt
SHOWN_MIN_PT = 80  # a shown picture draws at least this much edge; a gradient backdrop draws none
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


def drawn(image, area: tuple[float, float, float, float], scale: float, exclude: list[dict]) -> tuple[float, float]:
    """What is drawn in an area, from its pixels: the length of strong edges in points (a gradient backdrop has none),
    and the widest run of them across a few rows (a line of words spans 60 pt or more, a spinner about 20). The controls
    drawn over the area are masked out. Pixels decide, so a stage cannot pass on its accessibility label alone."""
    from PIL import ImageDraw, ImageFilter
    box = tuple(int(v * scale) for v in area)
    edges = image.convert('L').crop(box).filter(ImageFilter.FIND_EDGES).point(lambda v: 255 if v > 40 else 0)
    w, h = edges.size
    if w < 8 or h < 8:
        return 0.0, 0.0
    pen = ImageDraw.Draw(edges)
    for node in exclude:
        r = node['rect']
        pen.rectangle([(r['x'] - area[0]) * scale - 6, (r['y'] - area[1]) * scale - 6,
                       (r['x'] + r['width'] - area[0]) * scale + 6, (r['y'] + r['height'] - area[1]) * scale + 6], fill=0)
    pixels = edges.load()
    spans = []
    for y in range(2, h - 2):
        xs = [x for x in range(2, w - 2) if pixels[x, y]]
        spans.append((xs[-1] - xs[0]) if len(xs) >= 6 else 0)
    spans.sort(reverse=True)
    inner = edges.crop((3, 3, w - 3, h - 3))
    values = inner.get_flattened_data() if hasattr(inner, 'get_flattened_data') else inner.getdata()
    length = sum(1 for v in values if v) / scale  # the crop's own border is no drawing
    return length, (spans[min(4, len(spans) - 1)] if spans else 0) / scale  # the fifth-widest row, not one stray row


def stage_states(image, elements: list[dict], scale: float, width: float, screen_h: float) -> list[str]:
    """main's stage (#539, StagePicture): one element `gallery-stage-picture`, value "shown", "loading" or "not available".
    Shown must have something drawn; loading and not available must draw their line of words (a bare backdrop or a
    spinner without words fails)."""
    problems = []
    for node in elements:
        if node['id'] != 'gallery-stage-picture':
            continue
        r = node['rect']
        area = (max(0.0, r['x']), max(0.0, r['y']), min(width, r['x'] + r['width']), min(screen_h, r['y'] + r['height']))
        if area[2] - area[0] < 40 or area[3] - area[1] < 40:
            continue
        value = node['value'].strip().lower()
        overlays = [n for n in elements if n is not node and n['rect']['height'] < 60 and inside(n['rect'], area)
                    and n['id'] != 'gallery-stage-retry']
        length, span = drawn(image, area, scale, overlays)
        if value == 'shown':
            if length < SHOWN_MIN_PT:
                problems.append(f'stage says "shown" but nothing is drawn on it ({length:.0f} pt of drawn edge)')
        elif value in ('loading', 'not available'):
            if span < LINE_MIN_PT:
                problems.append(f'stage says "{value}" but draws no line of words (widest drawn run {span:.0f} pt): '
                                f'a bare backdrop or a spinner alone')
        else:
            problems.append(f'stage has no state it should have (value "{node["value"]}")')
    return problems


def check_frame(png: Path, tree) -> list[str]:
    """What is blank in one frame, in words; empty when nothing is."""
    from PIL import Image
    with Image.open(png) as opened:
        image = opened.convert('RGB')
    elements = nodes(tree)
    if not elements:
        return []
    # The screen is the app's root element (its window); elements scrolled off it can be wider or lower.
    windows = [n['rect'] for n in elements if n['role'] in ('Window', 'Application') and n['rect']['width'] > 0]
    width = windows[0]['width'] if windows else min(image.width / 2, max(n['rect']['x'] + n['rect']['width'] for n in elements))
    scale = image.width / width if width else 1.0
    screen_h = image.height / scale
    problems = stage_states(image, elements, scale, width, screen_h)
    has_state = any(n['id'] == 'gallery-stage-picture' for n in elements)
    controls = [n for n in elements if STAGE_CONTROL.search(n['label'].strip()) and n['rect']['height'] < 80]
    # The model stage: on main the whole stage is one large "Explore in 3D" element; otherwise it is the area above the
    # chips along its bottom (the size chip, "N photos", "AR"). Its small "Explore in 3D" label sits at its top.
    big = [n for n in elements if n['label'].strip().lower() == 'explore in 3d' and n['rect']['height'] >= 150]
    bottom_controls = [n for n in controls if n['label'].strip().lower() != 'explore in 3d']
    area = None
    if big:
        r = big[0]['rect']
        area = (max(0.0, r['x']), max(0.0, r['y']), min(width, r['x'] + r['width']), min(screen_h, r['y'] + r['height']))
    elif bottom_controls:
        top = min(n['rect']['y'] for n in bottom_controls)
        left = min(n['rect']['x'] for n in bottom_controls) - 16
        right = max(n['rect']['x'] + n['rect']['width'] for n in bottom_controls) + 16
        area = (max(0.0, left), max(0.0, top - 220), min(width, right), max(0.0, top - 4))
    if area and not has_state and area[3] - area[1] > 60:
        within = [n for n in elements if n not in big and inside(n['rect'], area)]
        busy = [n for n in within if PROGRESS.search(n['role']) or PROGRESS.search(n['label'])]
        words = [n for n in within if TEXT.search(n['role']) and n['label'].strip() and not STAGE_CONTROL.search(n['label'].strip())]
        overlays = [n for n in within if n['rect']['height'] < 60]
        length, _ = drawn(image, area, scale, overlays)
        if not busy and not words and length < SHOWN_MIN_PT:
            labels = ', '.join(sorted({n['label'].strip() for n in controls}))
            problems.append(f'empty stage: nothing drawn on it ({length:.0f} pt of drawn edge; its controls: {labels}), '
                            f'no progress and no words')
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
