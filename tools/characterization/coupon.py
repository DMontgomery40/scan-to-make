#!/usr/bin/env python3
"""Parametric printer-characterization coupon (FIT-001, Bet 4).

One print yields the measurements that characterize a printer/material/nozzle
combination once, instead of re-couponing every interface:

  * clearance ladder  - a 12 mm peg against slots of growing width
  * ring bores        - 4/6/8/10 mm holes for pin or caliper checks
  * bosses            - 20 mm square + 20 mm round outer references
  * shrinkage bar     - 100 mm outer length for XY scale
  * wall ladder       - 0.8..2.4 mm fins for minimum reliable wall

Geometry is built only from boxes, cylinders and rings (no CSG subtraction),
so it renders deterministically with the standard library alone and emits a
binary STL plus a JSON manifest. The manifest's artifact identity
{sha256, mediaType, byteLength} matches the ArtifactRef shape in
packages/contracts. The coupon informs dimension choices; it is NOT
holder-fit evidence: FitEvidence requires an actual insert (or insert-band
coupon) with insert geometry tried in the real holder, which this generic
characterization plate does not contain.

Usage:
  python3 coupon.py generate --out-dir examples \
      --printer-id p1s-01 --printer-model "Bambu P1S" --nozzle-mm 0.4 \
      --material "PLA" --slicer-settings-file exported-profile.json
  python3 coupon.py profile --measured measurements.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from dataclasses import dataclass, field

GENERATOR_VERSION = "0.1.0"
MEDIA_TYPE = "model/stl"

Vec = tuple[float, float, float]
Tri = tuple[Vec, Vec, Vec]


@dataclass(frozen=True)
class CouponParams:
    peg_width_mm: float = 12.0
    peg_foot_relief_mm: float = 0.3
    peg_foot_height_mm: float = 1.2
    clearance_steps_mm: tuple[float, ...] = (0.0, 0.05, 0.10, 0.15, 0.20, 0.30)
    ring_bores_mm: tuple[float, ...] = (4.0, 6.0, 8.0, 10.0)
    ring_wall_mm: float = 3.0
    boss_mm: float = 20.0
    shrinkage_bar_mm: float = 100.0
    wall_steps_mm: tuple[float, ...] = (0.8, 1.2, 1.6, 2.0, 2.4)
    circle_segments: int = 64

    def validate(self) -> None:
        if self.peg_width_mm <= 0:
            raise ValueError("peg_width_mm must be positive")
        if self.peg_foot_relief_mm < 0 or 2.0 * self.peg_foot_relief_mm >= self.peg_width_mm:
            raise ValueError("peg_foot_relief_mm must be in [0, peg_width_mm/2)")
        if not 0.0 <= self.peg_foot_height_mm < 18.0:
            raise ValueError("peg_foot_height_mm must be in [0, peg height)")
        steps = list(self.clearance_steps_mm)
        if any(s < 0 for s in steps) or steps != sorted(steps) or len(set(steps)) != len(steps):
            raise ValueError("clearance_steps_mm must be non-negative, unique and increasing")
        if any(b <= 0 for b in self.ring_bores_mm) or self.ring_wall_mm <= 0:
            raise ValueError("ring bores and ring wall must be positive")
        if self.boss_mm <= 0 or self.shrinkage_bar_mm <= 0:
            raise ValueError("boss and shrinkage bar must be positive")
        if any(w <= 0 for w in self.wall_steps_mm):
            raise ValueError("wall steps must be positive")
        if self.circle_segments < 12:
            raise ValueError("circle_segments must be at least 12")

    @property
    def slot_widths_mm(self) -> list[float]:
        """Slot width = peg width + clearance on BOTH sides (radial per-side)."""
        return [self.peg_width_mm + 2.0 * s for s in self.clearance_steps_mm]


def _normal(a: Vec, b: Vec, c: Vec) -> Vec:
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    if length == 0.0:
        return (0.0, 0.0, 0.0)
    return (nx / length, ny / length, nz / length)


def box(tris: list[Tri], x: float, y: float, z: float, dx: float, dy: float, dz: float) -> None:
    x1, y1, z1 = x + dx, y + dy, z + dz
    v = [(x, y, z), (x1, y, z), (x1, y1, z), (x, y1, z),
         (x, y, z1), (x1, y, z1), (x1, y1, z1), (x, y1, z1)]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (3, 0, 4, 7)]
    for a, b, c, d in faces:
        tris.append((v[a], v[b], v[c]))
        tris.append((v[a], v[c], v[d]))


def cylinder(tris: list[Tri], cx: float, cy: float, z: float, r: float, h: float, seg: int) -> None:
    ring = [(cx + r * math.cos(2 * math.pi * i / seg), cy + r * math.sin(2 * math.pi * i / seg))
            for i in range(seg)]
    top_c, bot_c = (cx, cy, z + h), (cx, cy, z)
    for i in range(seg):
        j = (i + 1) % seg
        b0, b1 = (ring[i][0], ring[i][1], z), (ring[j][0], ring[j][1], z)
        t0, t1 = (ring[i][0], ring[i][1], z + h), (ring[j][0], ring[j][1], z + h)
        tris.append((b0, b1, t1))
        tris.append((b0, t1, t0))
        tris.append((top_c, t0, t1))
        tris.append((bot_c, b1, b0))


def ring(tris: list[Tri], cx: float, cy: float, z: float,
         r_in: float, r_out: float, h: float, seg: int) -> None:
    def pts(r: float, zz: float) -> list[Vec]:
        return [(cx + r * math.cos(2 * math.pi * i / seg),
                 cy + r * math.sin(2 * math.pi * i / seg), zz) for i in range(seg)]
    ob, ot, ib, it = pts(r_out, z), pts(r_out, z + h), pts(r_in, z), pts(r_in, z + h)
    for i in range(seg):
        j = (i + 1) % seg
        tris.append((ob[i], ob[j], ot[j])); tris.append((ob[i], ot[j], ot[i]))   # outer wall
        tris.append((ib[i], it[j], ib[j])); tris.append((ib[i], it[i], it[j]))   # inner wall
        tris.append((ot[i], ot[j], it[j])); tris.append((ot[i], it[j], it[i]))   # top annulus
        tris.append((ob[i], ib[j], ob[j])); tris.append((ob[i], ib[i], ib[j]))   # bottom annulus


@dataclass
class Layout:
    slot_widths_mm: list[float] = field(default_factory=list)
    peg_width_mm: float = 0.0
    ring_centers: list[tuple[float, float, float]] = field(default_factory=list)  # cx, cy, bore
    bbox_mm: tuple[Vec, Vec] = ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0))


def build(params: CouponParams) -> tuple[list[Tri], Layout]:
    params.validate()
    tris: list[Tri] = []
    layout = Layout(slot_widths_mm=params.slot_widths_mm, peg_width_mm=params.peg_width_mm)

    # Clearance ladder: posts on a base strip; gaps between posts are the slots.
    # Pip count on the base top (front) numbers each slot 1..n, left to right.
    post_w, post_top = 6.0, 13.0
    total_x = post_w * (len(params.slot_widths_mm) + 1) + sum(params.slot_widths_mm)
    box(tris, 0.0, 0.0, 0.0, total_x, 14.0, 3.0)
    x = 0.0
    for idx, width in enumerate(params.slot_widths_mm):
        box(tris, x, 2.0, 3.0, post_w, 10.0, post_top - 3.0)
        slot_x = x + post_w
        for pip in range(idx + 1):
            box(tris, slot_x + 0.8 + pip * 2.2, 12.4, 3.0, 1.2, 1.2, 1.5)
        x = slot_x + width
    box(tris, x, 2.0, 3.0, post_w, 10.0, post_top - 3.0)

    # Peg: exact nominal width, thinner than slot depth, widened finger tab.
    # The insertion end is relieved per side for the first foot_height so
    # first-layer elephant's foot cannot decide which slot the peg enters.
    relief, foot_h = params.peg_foot_relief_mm, params.peg_foot_height_mm
    box(tris, relief, 24.0 + relief, 0.0, params.peg_width_mm - 2.0 * relief,
        6.0 - 2.0 * relief, foot_h)
    box(tris, 0.0, 24.0, foot_h, params.peg_width_mm, 6.0, 18.0 - foot_h)
    box(tris, 0.0, 21.0, 12.0, params.peg_width_mm, 12.0, 6.0)

    # Ring bores and bosses on the build plate (through-holes, no plate below).
    rx, ry = 0.0, 48.0
    for bore in params.ring_bores_mm:
        r_out = bore / 2.0 + params.ring_wall_mm
        cx = rx + r_out
        ring(tris, cx, ry, 0.0, bore / 2.0, r_out, 8.0, params.circle_segments)
        layout.ring_centers.append((cx, ry, bore))
        rx += 2.0 * r_out + 4.0
    box(tris, 70.0, 38.0, 0.0, params.boss_mm, params.boss_mm, 6.0)
    cylinder(tris, 104.0, 48.0, 0.0, params.boss_mm / 2.0, 6.0, params.circle_segments)

    # Shrinkage bar: outermost X faces are exactly the nominal length apart.
    bar = params.shrinkage_bar_mm
    box(tris, 0.0, 68.0, 0.0, bar, 8.0, 4.0)
    box(tris, 0.0, 68.0, 4.0, 6.0, 8.0, 6.0)
    box(tris, bar - 6.0, 68.0, 4.0, 6.0, 8.0, 6.0)

    # Wall ladder: fins on a thin base strip, thinnest first, left to right.
    fin_gap, fin_y = 12.0, 86.0
    strip_len = sum(params.wall_steps_mm) + fin_gap * (len(params.wall_steps_mm) - 1) + 16.0
    box(tris, 0.0, fin_y - 2.0, 0.0, strip_len, 18.0, 2.5)
    fx = 8.0
    for w in params.wall_steps_mm:
        box(tris, fx, fin_y, 2.5, w, 14.0, 9.5)
        fx += w + fin_gap

    xs = [v[0] for t in tris for v in t]; ys = [v[1] for t in tris for v in t]
    zs = [v[2] for t in tris for v in t]
    layout.bbox_mm = ((min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs)))
    return tris, layout


def to_binary_stl(tris: list[Tri]) -> bytes:
    out = bytearray(b"\x00" * 80)
    out += struct.pack("<I", len(tris))
    for a, b, c in tris:
        out += struct.pack("<3f", *_normal(a, b, c))
        for v in (a, b, c):
            out += struct.pack("<3f", *v)
        out += struct.pack("<H", 0)
    return bytes(out)


def build_manifest(params: CouponParams, layout: Layout, stl_bytes: bytes, *,
                   printer_id: str, printer_model: str, nozzle_mm: float,
                   material: str, slicer_settings: str = "unspecified-settings",
                   slicer_settings_sha256: str | None = None,
                   orientation: tuple[float, float, float] = (0.0, 0.0, 1.0)) -> dict:
    norm = math.hypot(*orientation)
    if abs(norm - 1.0) >= 1e-6:
        raise ValueError("orientation must be a unit vector (insertion axis)")
    if nozzle_mm <= 0:
        raise ValueError("nozzle_mm must be positive")
    if slicer_settings_sha256 is not None:
        if len(slicer_settings_sha256) != 64 or any(
                ch not in "0123456789abcdef" for ch in slicer_settings_sha256):
            raise ValueError("slicer_settings_sha256 must be lowercase hex sha256")
        settings_digest = slicer_settings_sha256
        settings_source = "file-bytes"
    else:
        settings_digest = hashlib.sha256(slicer_settings.encode()).hexdigest()
        settings_source = ("unspecified" if slicer_settings.startswith("unspecified")
                           else "declared-string")
    unspecified = (any(v.startswith("unspecified")
                       for v in (printer_id, printer_model, material))
                   or settings_source == "unspecified")
    params_json = json.dumps({
        "pegWidthMm": params.peg_width_mm,
        "pegFootReliefMm": params.peg_foot_relief_mm,
        "pegFootHeightMm": params.peg_foot_height_mm,
        "clearanceStepsMm": list(params.clearance_steps_mm),
        "ringBoresMm": list(params.ring_bores_mm),
        "ringWallMm": params.ring_wall_mm, "bossMm": params.boss_mm,
        "shrinkageBarMm": params.shrinkage_bar_mm,
        "wallStepsMm": list(params.wall_steps_mm),
        "circleSegments": params.circle_segments,
    }, sort_keys=True)
    measurements = [
        {"id": "first-free-slot", "nominalMm": None,
         "how": "Push the peg down each slot. Pips on the base number slots 1..n, tightest first. Record the first slot the peg slides through under its own weight.",
         "feeds": "printedPairClearanceMm"},
        {"id": "ring-bores", "nominalMm": list(params.ring_bores_mm),
         "how": "Largest pin/drill shank that passes each ring, or inside-caliper the bore.",
         "feeds": "holeBiasMm"},
        {"id": "square-boss", "nominalMm": params.boss_mm,
         "how": "Outside-caliper the square boss across X at mid-height.", "feeds": "outerBiasMm"},
        {"id": "round-boss", "nominalMm": params.boss_mm, "optional": True,
         "how": "Outside-caliper the round boss diameter at mid-height, across vertices.",
         "feeds": "roundOuterBiasMm"},
        {"id": "shrinkage-bar", "nominalMm": params.shrinkage_bar_mm,
         "how": "Outside-caliper the outermost X faces of the bar end fins.", "feeds": "xyScale"},
        {"id": "wall-ladder", "nominalMm": list(params.wall_steps_mm),
         "how": "Thinnest fin (left to right) that printed complete and survives a firm finger flex.",
         "feeds": "minReliableWallMm"},
    ]
    return {
        "schemaVersion": "0.1.0",
        "kind": "characterization-coupon",
        "generator": {"name": "tools/characterization/coupon.py", "version": GENERATOR_VERSION,
                      "paramsSha256": hashlib.sha256(params_json.encode()).hexdigest()},
        "parameters": json.loads(params_json) | {"slotWidthsMm": layout.slot_widths_mm},
        "bboxMm": {"min": list(layout.bbox_mm[0]), "max": list(layout.bbox_mm[1])},
        "artifact": {"sha256": hashlib.sha256(stl_bytes).hexdigest(),
                     "mediaType": MEDIA_TYPE, "byteLength": len(stl_bytes)},
        "calibrationScope": {
            "printerId": printer_id, "printerModel": printer_model,
            "nozzleDiameterMm": nozzle_mm, "material": material,
            "orientation": list(orientation),
            "slicerSettingsSha256": settings_digest,
        },
        "slicerSettingsEvidence": {"source": settings_source},
        "scopeStatus": ("template-replace-before-evidence" if unspecified
                        else "declared-by-operator-not-verified-here"),
        "measurements": measurements,
    }


def derive_profile(params: CouponParams, measured: dict) -> dict:
    """Turn recorded coupon measurements into a machine capability profile.

    measured keys: shrinkageBarMm, squareBossMm, ringBoresMm (list aligned
    with params.ring_bores_mm), firstFreeSlotIndex (0-based or None),
    minReliableWallMm (one of params.wall_steps_mm or None), and optional
    roundBossMm. Biases are measured-minus-nominal: negative hole bias means
    holes print small.

    printedPairClearanceMm is a printed-peg-in-printed-slot result (outer and
    hole bias stacked). It is NOT the contracts radialClearance, which is
    the per-side gap between a printed insert and an unprinted holder bore;
    sizing that interface uses xyScale plus (round) outer bias. Nothing here
    feeds a FitSpec silently.
    """
    bar = float(measured["shrinkageBarMm"])
    boss = float(measured["squareBossMm"])
    bores = [float(v) for v in measured["ringBoresMm"]]
    if bar <= 0 or boss <= 0 or any(v <= 0 for v in bores):
        raise ValueError("measurements must be positive")
    if len(bores) != len(params.ring_bores_mm):
        raise ValueError("ringBoresMm must align with the coupon's nominal bores")
    idx = measured.get("firstFreeSlotIndex")
    clearance = None
    if idx is not None:
        if not isinstance(idx, int) or not 0 <= idx < len(params.clearance_steps_mm):
            raise ValueError("firstFreeSlotIndex out of range")
        clearance = params.clearance_steps_mm[idx]
    wall = measured.get("minReliableWallMm")
    if wall is not None and float(wall) not in params.wall_steps_mm:
        raise ValueError("minReliableWallMm must be one of the printed wall steps")
    round_boss = measured.get("roundBossMm")
    round_bias = None
    if round_boss is not None:
        if float(round_boss) <= 0:
            raise ValueError("roundBossMm must be positive")
        round_bias = float(round_boss) - params.boss_mm
    return {
        "xyScaleMeasured": bar / params.shrinkage_bar_mm,
        "xyScaleCorrection": params.shrinkage_bar_mm / bar,
        "outerBiasMm": boss - params.boss_mm,
        "roundOuterBiasMm": round_bias,
        "holeBiasMm": sum(m - n for m, n in zip(bores, params.ring_bores_mm)) / len(bores),
        "printedPairClearanceMm": clearance,
        "minReliableWallMm": wall,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    gen = sub.add_parser("generate", help="emit STL + manifest")
    gen.add_argument("--out-dir", default=".")
    gen.add_argument("--name", default="characterization-coupon")
    gen.add_argument("--printer-id", default="unspecified-printer")
    gen.add_argument("--printer-model", default="unspecified-model")
    gen.add_argument("--nozzle-mm", type=float, default=0.4)
    gen.add_argument("--material", default="unspecified-material")
    settings_group = gen.add_mutually_exclusive_group()
    settings_group.add_argument("--slicer-settings",
                                help="declared profile name/text; digest covers the string only")
    settings_group.add_argument("--slicer-settings-file",
                                help="exported settings file; digest covers its exact bytes")
    prof = sub.add_parser("profile", help="derive a capability profile from measurements JSON")
    prof.add_argument("--measured", required=True, help="path to measurements JSON file")
    args = parser.parse_args(argv)

    params = CouponParams()
    if args.cmd == "generate":
        import os
        tris, layout = build(params)
        stl = to_binary_stl(tris)
        settings_sha = None
        if args.slicer_settings_file:
            with open(args.slicer_settings_file, "rb") as fh:
                settings_sha = hashlib.sha256(fh.read()).hexdigest()
        manifest = build_manifest(
            params, layout, stl, printer_id=args.printer_id,
            printer_model=args.printer_model, nozzle_mm=args.nozzle_mm,
            material=args.material,
            slicer_settings=args.slicer_settings or "unspecified-settings",
            slicer_settings_sha256=settings_sha)
        os.makedirs(args.out_dir, exist_ok=True)
        stl_path = os.path.join(args.out_dir, f"{args.name}.stl")
        man_path = os.path.join(args.out_dir, f"{args.name}.manifest.json")
        with open(stl_path, "wb") as fh:
            fh.write(stl)
        with open(man_path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2)
            fh.write("\n")
        print(f"{stl_path}  sha256={manifest['artifact']['sha256']}  bytes={len(stl)}  tris={len(tris)}")
        print(f"{man_path}  scopeStatus={manifest['scopeStatus']}")
        return 0
    with open(args.measured, encoding="utf-8") as fh:
        measured = json.load(fh)
    print(json.dumps(derive_profile(params, measured), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
