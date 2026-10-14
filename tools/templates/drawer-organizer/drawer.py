#!/usr/bin/env python3
"""Drawer tray template: DrawerFitSpec JSON in, STL + manifest out.

The tray is an open rectangular shell with a solid floor, perimeter walls and
a uniform divider grid. Its contract frame is right-handed and Z-up, with the
origin at the inner drawer floor centre; X is width and Y is depth.

Sizing follows the drawer contract exactly. Peripheral clearance is
consumed at its upper bound on each side. Wall, floor and tray-height design
dimensions are consumed at nominal. This module re-checks the fields used for
geometry, while packages/contracts remains the authoritative validator.

The generated artifact is preview/check geometry. It makes no manufacturing
tolerance, strength, rigidity or physical-fit claim, and printing remains
behind the companion inspection and approval gates.

Usage:
  python3 drawer.py generate --spec path/to/drawer-fitspec.json --out-dir examples
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
MIN_CLEAR_CELL_MM = 10.0
EPSILON = 1e-9

Vec = tuple[float, float, float]
Tri = tuple[Vec, Vec, Vec]

DIM_KEYS = (
    "drawerInnerWidth",
    "drawerInnerDepth",
    "drawerInnerHeight",
    "wallThickness",
    "floorThickness",
    "peripheralClearance",
    "trayHeight",
)
PARAMETER_KEYS = ("dividersAcross", "dividersAlong")


def _require_object(value: object, label: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _require_exact_keys(value: dict, keys: tuple[str, ...], label: str) -> None:
    if set(value) != set(keys):
        raise ValueError(f"{label} must contain exactly: {', '.join(keys)}")


def _dim(spec: dict, key: str, *, allow_zero: bool = False) -> tuple[float, float, float]:
    try:
        dimension = _require_object(spec["dimensions"][key], f"dimension {key}")
        _require_exact_keys(
            dimension,
            ("nominalMm", "lowerMm", "upperMm", "source", "sourceId"),
            f"dimension {key}",
        )
        values = (dimension["nominalMm"], dimension["lowerMm"], dimension["upperMm"])
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in values):
            raise TypeError
        nominal, lower, upper = (float(value) for value in values)
        if dimension["source"] not in ("manual", "scan", "reference", "design"):
            raise ValueError
        if not isinstance(dimension["sourceId"], str) or not dimension["sourceId"].strip():
            raise ValueError
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"dimension {key} is missing or malformed") from exc
    if not all(math.isfinite(value) for value in (nominal, lower, upper)):
        raise ValueError(f"dimension {key} must be finite")
    if not lower <= nominal <= upper:
        raise ValueError(f"dimension {key} requires lowerMm <= nominalMm <= upperMm")
    if lower < 0 or (lower == 0 and not allow_zero):
        raise ValueError(f"dimension {key} must be positive over its interval")
    return nominal, lower, upper


def _parameters(spec: dict) -> tuple[int, int]:
    params = _require_object(spec.get("parameters"), "parameters")
    _require_exact_keys(params, PARAMETER_KEYS, "parameters")
    values = []
    for key in PARAMETER_KEYS:
        value = params[key]
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 8:
            raise ValueError(f"parameter {key} must be an integer from 0 through 8")
        values.append(value)
    return values[0], values[1]


def sizing(spec: dict) -> dict:
    """Derived tray dimensions from a DrawerFitSpec shape."""
    spec = _require_object(spec, "spec")
    _require_exact_keys(
        spec,
        ("schemaVersion", "id", "revision", "template", "units", "frame",
         "dimensions", "parameters", "interfaces"),
        "spec",
    )
    if spec.get("schemaVersion") != "0.2.0" or spec.get("template") != "drawer-tray":
        raise ValueError("expected DrawerFitSpec schemaVersion 0.2.0, template drawer-tray")
    if not isinstance(spec.get("id"), str) or not spec["id"].strip():
        raise ValueError("spec id must be a non-empty string")
    if (
        isinstance(spec.get("revision"), bool)
        or not isinstance(spec.get("revision"), int)
        or not 0 <= spec["revision"] <= 9_007_199_254_740_991
    ):
        raise ValueError("spec revision must be a safe non-negative integer")
    if spec.get("units") != "mm" or spec.get("frame") != {
        "handedness": "right",
        "upAxis": "z",
        "origin": "drawer-floor-center",
    }:
        raise ValueError("expected mm units in the drawer-floor-center frame")

    dimensions = _require_object(spec.get("dimensions"), "dimensions")
    _require_exact_keys(dimensions, DIM_KEYS, "dimensions")
    parsed = {
        key: _dim(spec, key, allow_zero=(key == "peripheralClearance"))
        for key in DIM_KEYS
    }
    dividers_across, dividers_along = _parameters(spec)

    clearance = parsed["peripheralClearance"][2]
    wall_nominal = parsed["wallThickness"][0]
    wall_upper = parsed["wallThickness"][2]
    floor_nominal = parsed["floorThickness"][0]
    floor_upper = parsed["floorThickness"][2]
    tray_nominal, tray_lower, tray_upper = parsed["trayHeight"]

    if tray_upper > parsed["drawerInnerHeight"][1] + EPSILON:
        raise ValueError("Tray height must fit below the lowest drawer obstruction")
    divider_top = tray_nominal - 2.0
    if floor_upper >= tray_lower - EPSILON:
        raise ValueError("Tray needs space above its floor")
    if (dividers_across > 0 or dividers_along > 0) and floor_upper + 2.0 >= tray_lower - EPSILON:
        raise ValueError("Dividers must extend above the floor with a 2 mm top setback")

    worst_cells = {}
    for key, count in (
        ("drawerInnerWidth", dividers_across),
        ("drawerInnerDepth", dividers_along),
    ):
        cell = (
            parsed[key][1] - 2.0 * clearance - (count + 2) * wall_upper
        ) / (count + 1)
        if not math.isfinite(cell) or cell < MIN_CLEAR_CELL_MM - EPSILON:
            raise ValueError("Every cell must retain at least 10 mm clear span at interval extremes")
        worst_cells[key] = cell

    interfaces = _require_object(spec.get("interfaces"), "interfaces")
    _require_exact_keys(interfaces, ("drawer-cavity",), "interfaces")
    cavity = _require_object(interfaces["drawer-cavity"], "drawer-cavity interface")
    _require_exact_keys(cavity, ("fitEvidence",), "drawer-cavity interface")
    if not isinstance(cavity["fitEvidence"], list):
        raise ValueError("drawer-cavity fitEvidence must be an array")

    outer_width = parsed["drawerInnerWidth"][1] - 2.0 * clearance
    outer_depth = parsed["drawerInnerDepth"][1] - 2.0 * clearance
    outer_height = tray_nominal
    inner_width = outer_width - 2.0 * wall_nominal
    inner_depth = outer_depth - 2.0 * wall_nominal
    if outer_width <= 0 or outer_depth <= 0 or inner_width <= 0 or inner_depth <= 0:
        raise ValueError("Drawer envelope is too small for the declared construction")
    if floor_nominal >= outer_height or (dividers_across or dividers_along) and divider_top <= floor_nominal:
        raise ValueError("Nominal tray construction has no usable interior height")

    def centers(inner_span: float, count: int) -> list[float]:
        if count == 0:
            return []
        clear_span = (inner_span - count * wall_nominal) / (count + 1)
        first = -inner_span / 2.0 + clear_span + wall_nominal / 2.0
        return [first + index * (clear_span + wall_nominal) for index in range(count)]

    return {
        "peripheralClearanceMm": clearance,
        "wallMm": wall_nominal,
        "floorMm": floor_nominal,
        "outerWidthMm": outer_width,
        "outerDepthMm": outer_depth,
        "outerHeightMm": outer_height,
        "innerWidthMm": inner_width,
        "innerDepthMm": inner_depth,
        "clearCellWidthMm": (inner_width - dividers_across * wall_nominal) / (dividers_across + 1),
        "clearCellDepthMm": (inner_depth - dividers_along * wall_nominal) / (dividers_along + 1),
        "worstCaseClearCellWidthMm": worst_cells["drawerInnerWidth"],
        "worstCaseClearCellDepthMm": worst_cells["drawerInnerDepth"],
        "dividerTopMm": divider_top,
        "dividersAcross": dividers_across,
        "dividersAlong": dividers_along,
        "dividerCentersAcrossMm": centers(inner_width, dividers_across),
        "dividerCentersAlongMm": centers(inner_depth, dividers_along),
    }


def _normal(a: Vec, b: Vec, c: Vec) -> Vec:
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    return (0.0, 0.0, 0.0) if length == 0.0 else (nx / length, ny / length, nz / length)


def _clean_zero(value: float) -> float:
    return 0.0 if value == 0.0 else value


def _vertex(x: float, y: float, z: float) -> Vec:
    return (_clean_zero(float(x)), _clean_zero(float(y)), _clean_zero(float(z)))


class _SurfaceBuilder:
    """Build one indexed, consistently wound surface from orthogonal cells.

    Coordinates are quantized only at shared grid values, never rounded. This
    avoids independent boxes whose coincident faces would make the emitted
    STL non-manifold and would double-count material at crossings.
    """

    def __init__(self, xs: list[float], ys: list[float], zs: list[float]):
        self.xs = sorted({_clean_zero(float(value)) for value in xs})
        self.ys = sorted({_clean_zero(float(value)) for value in ys})
        self.zs = sorted({_clean_zero(float(value)) for value in zs})
        self.x_index = {value: index for index, value in enumerate(self.xs)}
        self.y_index = {value: index for index, value in enumerate(self.ys)}
        self.z_index = {value: index for index, value in enumerate(self.zs)}
        self.solid: set[tuple[int, int, int]] = set()

    def add_box(
        self,
        x0: float,
        x1: float,
        y0: float,
        y1: float,
        z0: float,
        z1: float,
    ) -> None:
        if not (x0 < x1 and y0 < y1 and z0 < z1):
            raise ValueError("geometry boxes must have positive extent")
        for xi in range(self.x_index[_clean_zero(float(x0))], self.x_index[_clean_zero(float(x1))]):
            for yi in range(self.y_index[_clean_zero(float(y0))], self.y_index[_clean_zero(float(y1))]):
                for zi in range(self.z_index[_clean_zero(float(z0))], self.z_index[_clean_zero(float(z1))]):
                    self.solid.add((xi, yi, zi))

    def triangles(self) -> list[Tri]:
        tris: list[Tri] = []

        def point(xi: int, yi: int, zi: int) -> Vec:
            return _vertex(self.xs[xi], self.ys[yi], self.zs[zi])

        def quad(a: Vec, b: Vec, c: Vec, d: Vec) -> None:
            tris.append((a, b, c))
            tris.append((a, c, d))

        for xi, yi, zi in sorted(self.solid):
            x0, x1 = xi, xi + 1
            y0, y1 = yi, yi + 1
            z0, z1 = zi, zi + 1
            if (xi, yi, zi - 1) not in self.solid:
                quad(point(x0, y1, z0), point(x1, y1, z0), point(x1, y0, z0), point(x0, y0, z0))
            if (xi, yi, zi + 1) not in self.solid:
                quad(point(x0, y0, z1), point(x1, y0, z1), point(x1, y1, z1), point(x0, y1, z1))
            if (xi, yi - 1, zi) not in self.solid:
                quad(point(x0, y0, z0), point(x1, y0, z0), point(x1, y0, z1), point(x0, y0, z1))
            if (xi, yi + 1, zi) not in self.solid:
                quad(point(x1, y1, z0), point(x0, y1, z0), point(x0, y1, z1), point(x1, y1, z1))
            if (xi - 1, yi, zi) not in self.solid:
                quad(point(x0, y1, z0), point(x0, y0, z0), point(x0, y0, z1), point(x0, y1, z1))
            if (xi + 1, yi, zi) not in self.solid:
                quad(point(x1, y0, z0), point(x1, y1, z0), point(x1, y1, z1), point(x1, y0, z1))
        return tris


def build(spec: dict) -> tuple[list[Tri], dict]:
    derived = sizing(spec)
    width = derived["outerWidthMm"]
    depth = derived["outerDepthMm"]
    height = derived["outerHeightMm"]
    wall = derived["wallMm"]
    floor = derived["floorMm"]
    x0, x1 = -width / 2.0, width / 2.0
    y0, y1 = -depth / 2.0, depth / 2.0
    inner_x0, inner_x1 = x0 + wall, x1 - wall
    inner_y0, inner_y1 = y0 + wall, y1 - wall

    xs = [x0, inner_x0, inner_x1, x1]
    ys = [y0, inner_y0, inner_y1, y1]
    zs = [0.0, floor, derived["dividerTopMm"], height]
    across_spans = []
    for center in derived["dividerCentersAcrossMm"]:
        span = (center - wall / 2.0, center + wall / 2.0)
        across_spans.append(span)
        xs.extend(span)
    along_spans = []
    for center in derived["dividerCentersAlongMm"]:
        span = (center - wall / 2.0, center + wall / 2.0)
        along_spans.append(span)
        ys.extend(span)

    mesh = _SurfaceBuilder(xs, ys, zs)
    mesh.add_box(x0, x1, y0, y1, 0.0, floor)
    mesh.add_box(x0, x1, y0, inner_y0, floor, height)
    mesh.add_box(x0, x1, inner_y1, y1, floor, height)
    mesh.add_box(x0, inner_x0, inner_y0, inner_y1, floor, height)
    mesh.add_box(inner_x1, x1, inner_y0, inner_y1, floor, height)
    for span_x0, span_x1 in across_spans:
        mesh.add_box(span_x0, span_x1, inner_y0, inner_y1, floor, derived["dividerTopMm"])
    for span_y0, span_y1 in along_spans:
        mesh.add_box(inner_x0, inner_x1, span_y0, span_y1, floor, derived["dividerTopMm"])
    return mesh.triangles(), derived


def to_binary_stl(tris: list[Tri]) -> bytes:
    out = bytearray(b"\x00" * 80)
    out += struct.pack("<I", len(tris))
    for a, b, c in tris:
        out += struct.pack("<3f", *_normal(a, b, c))
        for vertex in (a, b, c):
            out += struct.pack("<3f", *vertex)
        out += struct.pack("<H", 0)
    return bytes(out)


def build_manifest(spec: dict, derived: dict, stl: bytes) -> dict:
    return {
        "schemaVersion": "0.1.0",
        "kind": "drawer-tray",
        "generator": {
            "name": "tools/templates/drawer-organizer/drawer.py",
            "version": GENERATOR_VERSION,
        },
        "sourceSpec": {
            "id": spec.get("id"),
            "revision": spec.get("revision"),
            "template": spec.get("template"),
            "schemaVersion": spec.get("schemaVersion"),
        },
        "sizingPolicy": (
            "peripheral clearance at upper bound; outer width/depth from drawer "
            "lower bounds; wall, floor and tray height nominal; divider top is "
            "tray height minus 2 mm"
        ),
        "derived": derived,
        "cornerRadiusAssumedMm": 0,
        "evidenceBoundary": (
            "Synthetic fixture only. This preview geometry is not physical-fit "
            "evidence; full-drawer-envelope evidence requires the printed tray "
            "to be inserted, seated and removed by hand."
        ),
        "artifact": {
            "sha256": hashlib.sha256(stl).hexdigest(),
            "mediaType": MEDIA_TYPE,
            "byteLength": len(stl),
        },
        "status": "preview-geometry-not-print-authorized",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    gen = sub.add_parser("generate", help="DrawerFitSpec JSON -> STL + manifest")
    gen.add_argument("--spec", required=True)
    gen.add_argument("--out-dir", default=".")
    gen.add_argument("--name", default="drawer-tray")
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
    print(
        f"{args.name}.stl  sha256={manifest['artifact']['sha256']}  "
        f"bytes={len(stl)}  tris={len(tris)}  "
        f"outer={derived['outerWidthMm']}x{derived['outerDepthMm']}x{derived['outerHeightMm']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
