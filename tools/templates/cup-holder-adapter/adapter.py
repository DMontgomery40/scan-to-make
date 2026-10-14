#!/usr/bin/env python3
"""Cup-holder adapter template (FIT-002): FitSpec JSON in, STL + manifest out.

The adapter is a surface of revolution in the contract frame (right-handed,
Z-up, origin at holder base centre): a tapered hollow insert that slides into
the holder, a floor at the holder rim, and a cradle ring that holds the cup.

Sizing policy (conservative over the declared intervals, never nominal-only):
  * radial clearance is consumed at its UPPER bound everywhere, so a printer
    that needs the largest declared clearance is still covered;
  * insert outside top = holder top LOWER bound / 2 - clearance, and the
    insert bottom is additionally capped by that same rim opening, so the
    widest insert section can always pass the rim during insertion (an
    inverted-taper holder yields a straight insert, never a wedged one);
  * insert length   = insertion depth LOWER bound, so it never bottoms out
    early in the shallowest holder;
  * cradle inside   = cup UPPER bound / 2 + clearance, so the largest
    cup the spec allows still drops in.
Wall thickness and support height are design values, taken at nominal.

Authoritative FitSpec validation stays in packages/contracts; this module
re-checks the fields it consumes and refuses malformed input rather than
emitting geometry from garbage. Output is preview/check geometry only -
printing stays behind the companion's inspection and approval gates.

Usage:
  python3 adapter.py generate --spec path/to/fitspec.json --out-dir examples
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import struct
import sys

GENERATOR_VERSION = "0.1.0"
MEDIA_TYPE = "model/stl"
SEGMENTS = 96

Vec = tuple[float, float, float]
Tri = tuple[Vec, Vec, Vec]

DIM_KEYS = ("holderInnerBottomDiameter", "holderInnerTopDiameter", "insertionDepth",
            "cupOuterDiameter", "cupSupportHeight", "wallThickness", "radialClearance")


def _dim(spec: dict, key: str, *, allow_zero: bool = False) -> tuple[float, float, float]:
    try:
        d = spec["dimensions"][key]
        nominal, lower, upper = float(d["nominalMm"]), float(d["lowerMm"]), float(d["upperMm"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"dimension {key} is missing or malformed") from exc
    if not all(math.isfinite(v) for v in (nominal, lower, upper)):
        raise ValueError(f"dimension {key} must be finite")
    if not lower <= nominal <= upper:
        raise ValueError(f"dimension {key} requires lowerMm <= nominalMm <= upperMm")
    if lower < 0 or (lower == 0 and not allow_zero):
        raise ValueError(f"dimension {key} must be positive over its interval")
    return nominal, lower, upper


def sizing(spec: dict) -> dict:
    """Derived radii/heights from a FitSpec-shaped dict (see policy above)."""
    if spec.get("schemaVersion") != "0.1.0" or spec.get("template") != "cup-holder-adapter":
        raise ValueError("expected FitSpec schemaVersion 0.1.0, template cup-holder-adapter")
    if spec.get("units") != "mm" or spec.get("frame") != {
            "handedness": "right", "upAxis": "z", "origin": "holder-base-center"}:
        raise ValueError("expected mm units in the holder-base-center frame")
    for key in DIM_KEYS:
        _dim(spec, key, allow_zero=(key == "radialClearance"))
    clearance = _dim(spec, "radialClearance", allow_zero=True)[2]
    wall = _dim(spec, "wallThickness")[0]
    depth = _dim(spec, "insertionDepth")[1]
    bottom_lower = _dim(spec, "holderInnerBottomDiameter")[1]
    top_lower = _dim(spec, "holderInnerTopDiameter")[1]
    r_out_top = top_lower / 2.0 - clearance
    # The bottom section must pass the rim on its way in, so it is capped by
    # the rim opening as well as by its seated envelope (inverted tapers
    # therefore produce a straight insert instead of an uninsertable one).
    r_out_bottom = min(bottom_lower, top_lower) / 2.0 - clearance
    r_cup_in = _dim(spec, "cupOuterDiameter")[2] / 2.0 + clearance
    support = _dim(spec, "cupSupportHeight")[0]
    derived = {
        "radialClearanceMm": clearance, "wallMm": wall, "insertDepthMm": depth,
        "rInsertOuterBottomMm": r_out_bottom, "rInsertOuterTopMm": r_out_top,
        "rInsertInnerBottomMm": r_out_bottom - wall, "rInsertInnerTopMm": r_out_top - wall,
        "rCradleInnerMm": r_cup_in, "rCradleOuterMm": r_cup_in + wall,
        "floorTopZMm": depth + wall, "topZMm": depth + support,
        "cupEngagedHeightMm": support - wall,
    }
    if derived["rInsertInnerBottomMm"] <= 0 or derived["rInsertInnerTopMm"] <= 0:
        raise ValueError("holder is too narrow for the declared wall thickness")
    if derived["rCradleOuterMm"] < derived["rInsertInnerTopMm"]:
        raise ValueError("cup is too narrow for this template (cradle would not cover the insert)")
    if support <= wall:
        raise ValueError("cupSupportHeight must exceed wallThickness")
    return derived


def profile(s: dict) -> list[tuple[float, float]]:
    """Closed (r, z) cross-section, counter-clockwise from the outer bottom."""
    d, t = s["insertDepthMm"], s["wallMm"]
    return [
        (s["rInsertOuterBottomMm"], 0.0),
        (s["rInsertOuterTopMm"], d),
        (s["rCradleOuterMm"], d),
        (s["rCradleOuterMm"], s["topZMm"]),
        (s["rCradleInnerMm"], s["topZMm"]),
        (s["rCradleInnerMm"], s["floorTopZMm"]),
        (0.0, s["floorTopZMm"]),
        (0.0, d),
        (s["rInsertInnerTopMm"], d),
        (s["rInsertInnerBottomMm"], 0.0),
    ]


def _normal(a: Vec, b: Vec, c: Vec) -> Vec:
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    return (0.0, 0.0, 0.0) if length == 0.0 else (nx / length, ny / length, nz / length)


def _area2(a: Vec, b: Vec, c: Vec) -> float:
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    return math.sqrt((uy * vz - uz * vy) ** 2 + (uz * vx - ux * vz) ** 2 + (ux * vy - uy * vx) ** 2)


def revolve(points: list[tuple[float, float]], seg: int = SEGMENTS) -> list[Tri]:
    def ring(r: float, z: float) -> list[Vec]:
        return [(r * math.cos(2 * math.pi * i / seg), r * math.sin(2 * math.pi * i / seg), z)
                for i in range(seg)]
    rings = [ring(r, z) for r, z in points]
    tris: list[Tri] = []
    count = len(points)
    for k in range(count):
        lo, hi = rings[k], rings[(k + 1) % count]
        for i in range(seg):
            j = (i + 1) % seg
            for tri in ((lo[i], lo[j], hi[j]), (lo[i], hi[j], hi[i])):
                if _area2(*tri) > 1e-12:
                    tris.append(tri)
    return tris


def to_binary_stl(tris: list[Tri]) -> bytes:
    out = bytearray(b"\x00" * 80)
    out += struct.pack("<I", len(tris))
    for a, b, c in tris:
        out += struct.pack("<3f", *_normal(a, b, c))
        for v in (a, b, c):
            out += struct.pack("<3f", *v)
        out += struct.pack("<H", 0)
    return bytes(out)


def build(spec: dict) -> tuple[list[Tri], dict]:
    derived = sizing(spec)
    return revolve(profile(derived)), derived


def build_manifest(spec: dict, derived: dict, stl: bytes) -> dict:
    return {
        "schemaVersion": "0.1.0",
        "kind": "cup-holder-adapter",
        "generator": {"name": "tools/templates/cup-holder-adapter/adapter.py",
                      "version": GENERATOR_VERSION, "segments": SEGMENTS},
        "sourceSpec": {"id": spec.get("id"), "revision": spec.get("revision"),
                       "template": spec.get("template")},
        "sizingPolicy": ("clearance at upper bound; outside: holder lower bounds - "
                         "clearance, bottom capped by rim opening; length: depth lower "
                         "bound; cradle: cup upper bound + clearance; wall/support nominal"),
        "derived": derived,
        "artifact": {"sha256": hashlib.sha256(stl).hexdigest(),
                     "mediaType": MEDIA_TYPE, "byteLength": len(stl)},
        "status": "preview-geometry-not-print-authorized",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    gen = sub.add_parser("generate", help="FitSpec JSON -> STL + manifest")
    gen.add_argument("--spec", required=True)
    gen.add_argument("--out-dir", default=".")
    gen.add_argument("--name", default="cup-holder-adapter")
    args = parser.parse_args(argv)
    with open(args.spec, encoding="utf-8") as fh:
        spec = json.load(fh)
    tris, derived = build(spec)
    stl = to_binary_stl(tris)
    manifest = build_manifest(spec, derived, stl)
    os.makedirs(args.out_dir, exist_ok=True)
    with open(os.path.join(args.out_dir, f"{args.name}.stl"), "wb") as fh:
        fh.write(stl)
    with open(os.path.join(args.out_dir, f"{args.name}.manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    print(f"{args.name}.stl  sha256={manifest['artifact']['sha256']}  "
          f"bytes={len(stl)}  tris={len(tris)}  topZ={derived['topZMm']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
