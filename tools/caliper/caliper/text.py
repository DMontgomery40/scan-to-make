"""Text as 2D outlines from the vendored OFL font (Atkinson Hyperlegible Bold, designed for legibility)."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import numpy as np
from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont
from manifold3d import CrossSection, FillRule

FONT = Path(__file__).resolve().parent.parent / 'fonts' / 'AtkinsonHyperlegible-Bold.ttf'


class _Flatten(BasePen):
    """Collects glyph contours as polylines, flattening quadratic and cubic curves."""

    def __init__(self, glyphs, steps: int = 5):
        super().__init__(glyphs)
        self.contours: list[list[tuple[float, float]]] = []
        self.steps = steps

    def _moveTo(self, p):
        self.contours.append([p])

    def _lineTo(self, p):
        self.contours[-1].append(p)

    def _qCurveToOne(self, p1, p2):
        p0 = self.contours[-1][-1]
        for i in range(1, self.steps + 1):
            t = i / self.steps
            self.contours[-1].append(((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
                                      (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]))

    def _curveToOne(self, p1, p2, p3):
        p0 = self.contours[-1][-1]
        for i in range(1, self.steps + 1):
            t = i / self.steps
            a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
            self.contours[-1].append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                                      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))

    def _closePath(self):
        pass


@lru_cache(maxsize=1)
def _font():
    font = TTFont(str(FONT))
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    cap = glyphs[cmap[ord('H')]]
    pen = _Flatten(glyphs)
    cap.draw(pen)
    cap_height = max(y for contour in pen.contours for _, y in contour)
    return font, glyphs, cmap, cap_height


def text(value: str, cap_height: float, align: str = 'left', spacing: float = 0.0) -> CrossSection:
    """`value` as filled outlines with its baseline on y=0. `cap_height` is the height of capital letters in mm.

    align: left (x=0 at the start), centre or right. `spacing` adds mm between characters.
    """
    font, glyphs, cmap, cap = _font()
    scale = cap_height / cap
    polygons: list[np.ndarray] = []
    pen_x = 0.0
    for character in value:
        name = cmap.get(ord(character))
        if name is None:
            raise ValueError(f'the font has no glyph for {character!r}')
        glyph = glyphs[name]
        pen = _Flatten(glyphs)
        glyph.draw(pen)
        for contour in pen.contours:
            points = np.array(contour, dtype=np.float64)
            if len(points) > 1 and np.allclose(points[0], points[-1]):
                points = points[:-1]
            if len(points) >= 3:
                polygons.append(np.column_stack([points[:, 0] * scale + pen_x, points[:, 1] * scale]))
        pen_x += glyph.width * scale + spacing
    width = pen_x - spacing
    shape = CrossSection(polygons, fillrule=FillRule.NonZero) if polygons else CrossSection()
    shift = {'left': 0.0, 'centre': -width / 2, 'right': -width}[align]
    return shape.translate([shift, 0.0])


def text_width(value: str, cap_height: float, spacing: float = 0.0) -> float:
    font, glyphs, cmap, cap = _font()
    scale = cap_height / cap
    return sum(glyphs[cmap[ord(c)]].width * scale for c in value) + spacing * (len(value) - 1)
