"""The Counterpart caliper, generated from parameters.

Layout (millimetres; x along the scale, y up the card, z out of the front face, z=0 at the back):

* The card is the fixed part. Its right edge at x=0 is the fixed measuring face. The main scale
  sits along the top edge of a through-slot. The QR codes are on the back; the through-hole
  fiducials go right through.
* The slider is a strip that runs in the slot, held by V ridges on both slot edges, plus a head
  outside the card's right edge. The head carries the moving jaws. Its outside face sits at x=s
  when the scale reads s.
* Outside jaws hang below. Inside jaws stand above and cross like a real caliper's. The card's
  inside finger is in the back half of the thickness and the slider's in the front half, so both
  pairs close to zero together and one scale reads both: outside gap = inside span = s.
* Colour: every print layer holds one colour. Layers 1-2 (z 0-0.4) are the marking colour, with
  the QR's light modules as holes. The body is body colour up to z=3.6. Above that, everything
  (raised scale, numerals and text, the keeper bar) is marking colour. The slider prints face
  down, so its face is marking colour and the vernier shows as body-colour lines.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict

import numpy as np
import segno
from manifold3d import CrossSection, FillRule, Manifold, OpType

from . import text as T

MARKING, BODY = 'marking', 'body'


@dataclass(frozen=True)
class Params:
    docs_url: str = 'https://counterpart.dtmont.com/'
    printer_url: str = 'https://dmontgomery40.github.io/mcp-3D-printer-server/'
    range_mm: int = 100
    layer: float = 0.2
    band: float = 0.4  # marking-colour layers on the bed side
    body: float = 3.6  # top of the body (card and slider are this thick)
    mark: float = 0.4  # raised marking height
    keeper_t: float = 1.0
    slot_h: float = 13.0
    edge_clear: float = 0.4  # flat slot-edge clearance; larger than the V clearance so the V faces locate the strip
    ridge: float = 0.8  # V ridge depth (half-width at the base is the same: 45 degree faces)
    groove_clear: float = 0.2  # normal clearance between ridge and groove faces
    low_h: float = 14.0
    up_h: float = 44.0
    card_left: float = -148.0
    slot_left: float = -141.0
    strip_left: float = -140.0
    zero_x: float = -122.0  # main-scale zero; the vernier zero sits here when the jaws are closed
    keeper_w: float = 7.0
    jaw_ext: float = 20.0
    jaw_w: float = 12.0
    head_w: float = 12.0
    finger_w: float = 3.5
    finger_len: float = 14.0
    finger_root: float = 8.0
    split_lo: float = 1.6  # card half of the crossing inside jaws: z in [0, split_lo]
    split_hi: float = 2.0  # slider half: z in [split_hi, body]
    relief: float = 0.6  # the card's upper right edge is set back so only the jaw faces touch
    flex_x: tuple[float, float] = (-38.0, -10.0)
    flex_beam: float = 1.4
    flex_slit: float = 0.6
    flex_preload: float = 0.8  # the ridge on the flexure stands this much proud, pressing the strip up
    tick_w: float = 0.5
    vernier_w: float = 0.7
    vernier_div: int = 5
    vernier_modulus: int = 3  # line spacing = modulus - 1/div = 2.8 mm (wide enough to label), read to 1/div = 0.2 mm
    qr_module: float = 1.0
    qr_quiet: int = 2
    fiducial_d: float = 4.0
    fiducial_big_d: float = 5.0
    chamfer: tuple[float, float] = (0.3, 0.2)  # (width, height) rabbet on measuring faces' bed edge

    @property
    def top(self) -> float:
        return self.slot_h + self.up_h

    @property
    def vernier_pitch(self) -> float:
        return self.vernier_modulus - 1.0 / self.vernier_div

    @property
    def resolution(self) -> float:
        return 1.0 / self.vernier_div


@dataclass
class Volume:
    name: str
    role: str  # MARKING or BODY
    solid: Manifold


@dataclass
class Design:
    params: Params
    card: list[Volume]
    slider: list[Volume]  # in use position with the jaws closed (reading 0)
    meta: dict = field(default_factory=dict)


def rect(x0, y0, x1, y1) -> CrossSection:
    return CrossSection.square([x1 - x0, y1 - y0]).translate([x0, y0])


def poly(*points) -> CrossSection:
    return CrossSection([np.array(points, dtype=np.float64)], fillrule=FillRule.NonZero)


def circle(x, y, d) -> CrossSection:
    return CrossSection.circle(d / 2, 64).translate([x, y])


def slab(shape: CrossSection, z0: float, z1: float) -> Manifold:
    return shape.extrude(z1 - z0).translate([0, 0, z0])


def along_x(section_yz: CrossSection, x0: float, x1: float) -> Manifold:
    """A prism along x from a cross-section drawn in (y, z)."""
    solid = section_yz.extrude(x1 - x0)  # (u=y, v=z, w=x)
    m = np.array([[0, 0, 1, x0], [1, 0, 0, 0], [0, 1, 0, 0]], dtype=np.float64)
    return solid.transform(m)


def union(shapes):
    shapes = [s for s in shapes if not s.is_empty()]
    if not shapes:
        return CrossSection()
    return CrossSection.batch_boolean(shapes, OpType.Add) if len(shapes) > 1 else shapes[0]


def qr_matrix(url: str) -> np.ndarray:
    # Byte mode keeps the path's case exactly: GitHub Pages paths are case-sensitive.
    qr = segno.make_qr(url, version=4, error='m', mode='byte', boost_error=False)
    return np.array([list(row) for row in qr.matrix], dtype=bool)


def qr_shapes(url: str, module: float, quiet: int) -> tuple[CrossSection, CrossSection, int]:
    """(dark modules, light area including the quiet zone, size in modules), origin at the lower-left of the quiet zone."""
    matrix = qr_matrix(url)
    n = len(matrix)
    dark = []
    for r in range(n):
        c = 0
        while c < n:
            if matrix[r, c]:
                start = c
                while c < n and matrix[r, c]:
                    c += 1
                y = (n - 1 - r + quiet) * module
                dark.append(rect((start + quiet) * module, y, (c + quiet) * module, y + module))
            else:
                c += 1
    dark_shape = union(dark)
    full = (n + 2 * quiet) * module
    return dark_shape, rect(0, 0, full, full) - dark_shape, n


def build(p: Params = Params()) -> Design:
    top = p.top
    zc = p.body / 2  # V ridges are centred in the thickness
    d = p.ridge
    c45 = p.groove_clear * np.sqrt(2)

    # ---------------- card outline (2D)
    jaw_bottom = -p.low_h - p.jaw_ext
    card_2d = rect(p.card_left, -p.low_h, 0, top) - rect(p.slot_left, 0, 1, p.slot_h)
    card_2d = card_2d + poly((-p.jaw_w, -p.low_h + 0.01), (0, -p.low_h + 0.01), (0, jaw_bottom), (-4, jaw_bottom), (-p.jaw_w, jaw_bottom + 8))
    card_2d = card_2d - rect(-p.relief, p.slot_h, 1, top - p.finger_root - 0.6)
    card_finger = poly((0, top - p.finger_root), (p.finger_w, top - p.finger_root), (p.finger_w, top + p.finger_len - 1.5),
                       (p.finger_w - 1.5, top + p.finger_len), (0, top + p.finger_len))
    card_zone = rect(-(p.finger_w + 0.6), top - p.finger_root - 0.6, 0, top)  # back half only, so the slider's finger can pass over
    slit = rect(p.flex_x[0] - 1.0, -p.flex_beam - p.flex_slit, p.flex_x[1] + 1.0, -p.flex_beam)

    fiducials = [(-141.0, 51.0, p.fiducial_big_d), (-12.0, 32.0, p.fiducial_d), (-141.0, -7.0, p.fiducial_d), (-45.0, -7.0, p.fiducial_d)]
    holes = union([circle(x, y, dia) for x, y, dia in fiducials])

    # ---------------- back: QR codes and labels, drawn as seen from behind then mirrored into card coordinates
    qr_full = (33 + 2 * p.qr_quiet) * p.qr_module
    back_light = []
    qr_meta = []
    for url, label, u0 in ((p.printer_url, '3D printer MCP', 56.0), (p.docs_url, 'Counterpart docs', 99.0)):
        dark, light, n = qr_shapes(url, p.qr_module, p.qr_quiet)
        if n != 33:
            raise ValueError(f'{url!r} needs a version-{(n - 17) // 4} QR code; re-fit the back layout')
        y0 = top - 1.5 - qr_full
        back_light.append(light.translate([u0, y0]))
        back_light.append(T.text(label, 3.2, 'centre').translate([u0 + qr_full / 2, y0 - 4.2]))
        qr_meta.append({'url': url, 'label': label, 'modules': n, 'module_mm': p.qr_module,
                        'centre_back_view': [u0 + qr_full / 2, y0 + qr_full / 2]})
    back_holes = union(back_light).mirror([1, 0])

    # ---------------- front markings (raised, marking colour)
    marks = []
    last = p.range_mm + p.vernier_modulus * p.vernier_div
    for v in range(0, last + 1):
        x = p.zero_x + v
        length = 6.0 if v % 10 == 0 else 4.5 if v % 5 == 0 else 3.0
        marks.append(rect(x - p.tick_w / 2, p.slot_h, x + p.tick_w / 2, p.slot_h + length))
    for v in range(0, p.range_mm + 1, 10):
        marks.append(T.text(str(v), 3.8, 'centre').translate([p.zero_x + v, p.slot_h + 7.2]))
    marks.append(T.text('mm', 3.6).translate([p.zero_x + p.range_mm + 6.5, p.slot_h + 7.2]))
    marks.append(T.text('Counterpart', 7.5, 'centre').translate([-78.0, 37.0]))
    marks.append(T.text('INSIDE', 3.4, 'right').translate([-7.0, top - 6.0]))
    marks.append(poly((-6.6, top - 6.0), (-4.6, top - 6.0), (-5.6, top - 2.6)))  # points up at the inside jaws
    marks.append(T.text('OUTSIDE', 3.4, 'right').translate([-7.0, -11.0]))
    marks.append(poly((-6.6, -7.6), (-4.6, -7.6), (-5.6, -11.0)))  # points down at the outside jaws
    for x, y, dia in fiducials:
        marks.append(circle(x, y, dia + 2.4) - circle(x, y, dia))
    marks_2d = union(marks)

    # ---------------- card volumes
    card_full = card_2d + card_finger
    rabbet_w, rabbet_h = p.chamfer
    card_rabbet = (slab(rect(-rabbet_w, jaw_bottom - 1, 1, 0), -1, rabbet_h)
                   + slab(rect(-1, top, rabbet_w, top + p.finger_len + 1), -1, rabbet_h))
    card_back = slab(card_full - holes - back_holes - slit, 0, p.band) - card_rabbet
    card_body = (slab(card_2d - card_zone - holes - slit, p.band, p.body)
                 + slab(card_zone + card_finger - holes, p.band, p.split_lo))
    top_ridge = along_x(poly((p.slot_h + 0.01, zc - d - 0.01), (p.slot_h + 0.01, zc + d + 0.01), (p.slot_h - d, zc)), p.slot_left - 0.5, 0)
    bottom_ridge = along_x(poly((-0.01, zc - d - 0.01), (-0.01, zc + d + 0.01), (d, zc)), p.slot_left - 0.5, 0)
    pre = p.flex_preload
    raised = poly((-0.01, zc - d - 0.01), (pre, zc - d - 0.01), (pre + d, zc), (pre, zc + d + 0.01), (-0.01, zc + d + 0.01))
    f0, f1 = p.flex_x
    ramp = 3.0
    flex_ridge = (along_x(raised, f0 + ramp, f1 - ramp)
                  + Manifold.batch_hull([along_x(poly((-0.01, zc - d), (-0.01, zc + d), (d, zc)), f0, f0 + 0.01),
                                         along_x(raised, f0 + ramp - 0.01, f0 + ramp)])
                  + Manifold.batch_hull([along_x(raised, f1 - ramp, f1 - ramp + 0.01),
                                         along_x(poly((-0.01, zc - d), (-0.01, zc + d), (d, zc)), f1 - 0.01, f1)]))
    card_body = card_body + top_ridge + bottom_ridge + flex_ridge
    keeper = (slab(rect(-p.keeper_w, -3.0, 0, p.slot_h + 3.0), p.body, p.body + p.keeper_t)
              - slab(rect(-p.keeper_w - 1, 0, 1, p.slot_h), p.body - 0.01, p.body + p.layer))
    card_marks = slab(marks_2d, p.body, p.body + p.mark) + keeper

    # ---------------- slider (use position, jaws closed)
    strip = rect(p.strip_left, p.edge_clear, 0.01, p.slot_h - p.edge_clear)
    lead = 1.5  # chamfered strip end slides in easily
    strip = strip - poly((p.strip_left - 1, p.slot_h), (p.strip_left + lead, p.slot_h), (p.strip_left - 1, p.slot_h - lead - 1))
    strip = strip - poly((p.strip_left - 1, 0), (p.strip_left + lead, 0), (p.strip_left - 1, lead + 1))
    head = poly((0, jaw_bottom), (4, jaw_bottom), (p.head_w, jaw_bottom + 8), (p.head_w, top), (0, top))
    slider_finger = poly((-p.finger_w, top - p.finger_root), (0, top - p.finger_root), (0, top + p.finger_len),
                         (-p.finger_w + 1.5, top + p.finger_len), (-p.finger_w, top + p.finger_len - 1.5))
    head_zone = rect(0, top - p.finger_root - 0.6, p.finger_w + 0.6, top)
    slider_2d = strip + head
    groove = lambda y_edge, sign: along_x(poly((y_edge, zc - d - c45), (y_edge, zc + d + c45), (y_edge + sign * (d + c45), zc),),
                                          p.strip_left - 2, 0)
    grooves = groove(p.slot_h + 0.01, -1) + groove(-0.01, 1)
    # Vernier: line k sits at zero_x + k * pitch and lines up with a main-scale tick when the reading ends in k * resolution.
    vernier = []
    for k in range(p.vernier_div + 1):
        x = p.zero_x + k * p.vernier_pitch
        y_top = p.slot_h - p.edge_clear + 0.01  # run to the strip edge so each line meets the main-scale ticks
        length = 6.0 if k in (0, p.vernier_div) else 4.6
        vernier.append(rect(x - p.vernier_w / 2, y_top - length, x + p.vernier_w / 2, y_top))
        if k < p.vernier_div:  # tenths of a millimetre; the last line is the next whole millimetre
            digit = T.text(str(round(10 * k * p.resolution)), 2.8)
            left, _, right, _ = digit.bounds()
            vernier.append(digit.translate([x - (left + right) / 2, y_top - 6.0 - 3.6]))
    vernier.append(T.text('1/10 mm', 2.2, 'right').translate([p.zero_x - 2.6, p.slot_h - p.edge_clear - 6.0 - 3.6]))
    vernier.append(T.text('OUT', 2.8, 'centre').translate([p.head_w / 2 + 0.3, -9.0]))
    vernier.append(T.text('IN', 2.8, 'centre').translate([p.head_w / 2 + 0.3, top - 16.0]))
    face_holes = union(vernier)
    slider_rabbet = (slab(rect(-1, jaw_bottom - 1, rabbet_w, p.edge_clear), p.body - rabbet_h, p.body + 1)
                     + slab(rect(-rabbet_w, top, 1, top + p.finger_len + 1), p.body - rabbet_h, p.body + 1))
    slider_face = slab(slider_2d + slider_finger - face_holes, p.body - p.band, p.body) - slider_rabbet
    slider_body = (slab(slider_2d - head_zone, 0, p.body - p.band) - grooves
                   + slab(head_zone + slider_finger, p.split_hi, p.body - p.band))

    meta = {
        'name': 'Counterpart caliper',
        'params': asdict(p),
        'reading': {
            'range_mm': p.range_mm, 'resolution_mm': p.resolution, 'vernier_divisions': p.vernier_div,
            'vernier_pitch_mm': p.vernier_pitch, 'zero_x': p.zero_x,
            'how_to_read': ('The whole millimetres are the main-scale value just left of the vernier 0 line. '
                            f'Add {p.resolution:g} mm for each vernier division up to the line that lines up best '
                            'with a main-scale tick (lines are labelled 0 2 4 6 8 in tenths of a millimetre). '
                            'The same reading is the gap between the OUTSIDE jaws and the span of the INSIDE jaws.'),
        },
        'fiducials': [{'x': x, 'y': y, 'diameter_mm': dia, 'through_hole': True} for x, y, dia in fiducials],
        'fiducial_note': 'Centres in mm in the card frame (x=0 at the fixed jaw face, y=0 at the slot bottom). '
                         'Use hole centres for scale: printed holes come out undersize.',
        'qr': qr_meta,
        'colour_bands': [{'z': [0.0, p.band], 'role': MARKING}, {'z': [p.band, p.body], 'role': BODY},
                         {'z': [p.body, p.body + p.keeper_t], 'role': MARKING}],
        'pause_at_z': [p.band, p.body],
    }
    return Design(p,
                  card=[Volume('card back', MARKING, card_back), Volume('card body', BODY, card_body), Volume('card marks', MARKING, card_marks)],
                  slider=[Volume('slider face', MARKING, slider_face), Volume('slider body', BODY, slider_body)],
                  meta=meta)


def slider_at(design: Design, reading_mm: float) -> list[Volume]:
    return [Volume(v.name, v.role, v.solid.translate([reading_mm, 0, 0])) for v in design.slider]


def print_slider(solid: Manifold, body: float) -> Manifold:
    """Face down on the bed: turned over about the y axis (a rotation, so text still reads from the face)."""
    return solid.transform(np.array([[-1, 0, 0, 0], [0, 1, 0, 0], [0, 0, -1, body]], dtype=np.float64))
