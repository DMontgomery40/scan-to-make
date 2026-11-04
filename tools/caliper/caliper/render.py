"""Draws sliced G-code as it prints: every extrusion at its real width and filament colour.

Looking from above, later layers cover earlier ones. Looking from below, the first layer is on top.
This shows what the printer will actually lay down, which a mesh render can't: dropped thin
features, closed-up holes, bridges.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw

_MOVE = re.compile(r'^(G[0123])\s')
_ARG = re.compile(r'([XYZEIJ])(-?\d*\.?\d+)')


@dataclass
class Segments:
    x0: np.ndarray
    y0: np.ndarray
    x1: np.ndarray
    y1: np.ndarray
    z: np.ndarray
    tool: np.ndarray
    width: np.ndarray
    tower: np.ndarray
    colours: list[str]


def parse(gcode: str) -> Segments:
    lines = gcode.splitlines()
    colours = ['#808080']
    for line in lines:
        if line.startswith('; filament_colour = '):
            colours = [c.strip() for c in line.split('=', 1)[1].split(';')]
            break
    start = next((i for i, l in enumerate(lines) if 'MACHINE_START_GCODE_END' in l), 0)
    rows = []
    x = y = 0.0
    z = 0.0
    tool = 0
    for line in lines[:start]:  # the start G-code loads the first filament
        stripped = line.strip().split(';', 1)[0].strip()
        if stripped[:1] == 'T' and stripped[1:].isdigit() and int(stripped[1:]) < 200:
            tool = int(stripped[1:])
    width = 0.42
    feature = ''
    in_tower = False
    for line in lines[start + 1:]:
        if line.startswith(';'):
            if line.startswith('; Z_HEIGHT:'):
                z = float(line.split(':', 1)[1])
            elif line.startswith('; LINE_WIDTH:'):
                width = float(line.split(':', 1)[1])
            elif line.startswith('; FEATURE:'):
                feature = line[10:].strip()
            elif line.startswith('; WIPE_TOWER_START'):
                in_tower = True
            elif line.startswith('; WIPE_TOWER_END'):
                in_tower = False
            continue
        stripped = line.strip()
        if stripped[:1] == 'T' and stripped[1:].isdigit():
            t = int(stripped[1:])
            if t < 200:
                tool = t
            continue
        m = _MOVE.match(line)
        if not m:
            continue
        args = {k: float(v) for k, v in _ARG.findall(line.split(';', 1)[0])}
        nx, ny = args.get('X', x), args.get('Y', y)
        e = args.get('E', 0.0)
        g = m.group(1)
        if e > 0 and g in ('G1', 'G0') and (nx != x or ny != y):  # E-only moves are retract/prime, not lines
            rows.append((x, y, nx, ny, z, tool, width, in_tower or feature == 'Prime tower'))
        elif e > 0 and g in ('G2', 'G3'):
            cx, cy = x + args.get('I', 0.0), y + args.get('J', 0.0)
            r = math.hypot(x - cx, y - cy)
            a0, a1 = math.atan2(y - cy, x - cx), math.atan2(ny - cy, nx - cx)
            if g == 'G2':  # clockwise
                while a1 >= a0:
                    a1 -= 2 * math.pi
            else:
                while a1 <= a0:
                    a1 += 2 * math.pi
            steps = max(2, int(abs(a1 - a0) * r / 0.3))
            px, py = x, y
            for i in range(1, steps + 1):
                a = a0 + (a1 - a0) * i / steps
                qx, qy = cx + r * math.cos(a), cy + r * math.sin(a)
                rows.append((px, py, qx, qy, z, tool, width, in_tower or feature == 'Prime tower'))
                px, py = qx, qy
        x, y = nx, ny
        if 'Z' in args:
            pass  # layer height comes from the Z_HEIGHT comments
    if not rows:
        raise ValueError('no extrusion moves found')
    a = np.array(rows, dtype=np.float64)
    return Segments(a[:, 0], a[:, 1], a[:, 2], a[:, 3], np.round(a[:, 4], 3), a[:, 5].astype(int), a[:, 6], a[:, 7].astype(bool), colours)


def inside(px: np.ndarray, py: np.ndarray, polygons: list[np.ndarray]) -> np.ndarray:
    """Even-odd point-in-polygon test for many points."""
    result = np.zeros(px.shape, dtype=bool)
    for poly in polygons:
        xs, ys = poly[:, 0], poly[:, 1]
        xj, yj = np.roll(xs, 1), np.roll(ys, 1)
        for xi_, yi_, xj_, yj_ in zip(xs, ys, xj, yj):
            crosses = ((yi_ > py) != (yj_ > py)) & (px < (xj_ - xi_) * (py - yi_) / ((yj_ - yi_) or 1e-12) + xi_)
            result ^= crosses
    return result


def draw(seg: Segments, select: np.ndarray, *, transform, size: tuple[int, int], px_per_mm: float,
         from_below: bool = False, colours: list[str] | None = None) -> Image.Image:
    """Draw the selected segments onto a transparent image.

    `transform(x, y)` maps plate millimetres to image pixels (vectorised). From below, layers
    are drawn top first so the first layer ends up on top.
    """
    colours = colours or seg.colours
    image = Image.new('RGBA', size, (0, 0, 0, 0))
    canvas = ImageDraw.Draw(image)
    idx = np.nonzero(select)[0]
    order = np.argsort(-seg.z[idx] if from_below else seg.z[idx], kind='stable')
    idx = idx[order]
    ax, ay = transform(seg.x0[idx], seg.y0[idx])
    bx, by = transform(seg.x1[idx], seg.y1[idx])
    for k, i in enumerate(idx):
        colour = colours[seg.tool[i] % len(colours)]
        w = max(1, int(round(seg.width[i] * px_per_mm)))
        canvas.line([(ax[k], ay[k]), (bx[k], by[k])], fill=colour, width=w)
        r = w / 2
        canvas.ellipse([bx[k] - r, by[k] - r, bx[k] + r, by[k] + r], fill=colour)
    return image
