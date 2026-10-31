#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Deterministic STL printability geometry analyzer (MIT, no Blender).

Uses NumPy (BSD-3-Clause) when installed for fast vectorised STL unpacking and
triangle geometry, with an identical IEEE-754 float64 stdlib fallback so bare
Python environments produce the exact same deterministic JSON report.
"""

from __future__ import annotations

import hashlib
import math
import os
import struct
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

try:
    import numpy as _np  # type: ignore[import-not-found]
    HAS_NUMPY = True
except ImportError:  # pragma: no cover - exercised on stdlib-only hosts
    _np = None
    HAS_NUMPY = False

PRINTABILITY_SCHEMA = "scan-to-make.printability/0.1.0"
# Match the companion's readVerifiedStl intake (services/companion/src/stl-export.ts).
MAX_INPUT_BYTES = 32 << 20
MAX_FACETS = 500_000
DEFAULT_OVERHANG_THRESHOLD_DEG = 45.0
BASE_PLANE_TOLERANCE_MM = 0.05
MIN_BASE_AREA_MM2 = 9.0
MIN_BASE_FOOTPRINT_RATIO = 0.02
MIN_TIP_ANGLE_DEG = 10.0
DEFAULT_MAX_WALL_SAMPLES = 8000
RAY_INSET_MM = 1e-4


class PrintabilityError(ValueError):
    """Raised when input files or parameters cannot be analyzed safely."""

    def __init__(self, stage: str, message: str) -> None:
        super().__init__(f"{stage}: {message}")
        self.stage = stage
        self.detail = message


def _r(val: float, digits: int = 6) -> float:
    rounded = round(float(val), digits)
    return 0.0 if rounded == 0.0 else rounded


def _rvec(vals: tuple[float, ...] | list[float], digits: int = 6) -> list[float]:
    return [_r(v, digits) for v in vals]


def read_stl_bounded(path: Path, max_bytes: int = MAX_INPUT_BYTES) -> bytes:
    p = Path(path)
    try:
        fd = os.open(p, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        raise PrintabilityError("input", f"STL file not found: {p}") from None
    except OSError as exc:
        raise PrintabilityError("input", f"cannot open STL file {p}: {exc}") from exc
    try:
        st = os.fstat(fd)
        if not os.path.isfile(p) or (st.st_mode & 0o170000) != 0o100000:
            raise PrintabilityError("input", f"STL path is not a regular file: {p}")
        if st.st_size == 0:
            raise PrintabilityError("input", "STL file is empty")
        if st.st_size > max_bytes:
            raise PrintabilityError("limits", f"STL exceeds {max_bytes} byte limit ({st.st_size} bytes)")
        with os.fdopen(fd, "rb") as f:
            fd = -1
            data = f.read(max_bytes + 1)
    finally:
        if fd >= 0:
            os.close(fd)
    if len(data) > max_bytes:
        raise PrintabilityError("limits", f"STL exceeds {max_bytes} byte limit")
    return data


def _parse_stl_stdlib(data: bytes) -> tuple[str, bool, list[tuple[float, ...]]]:
    if len(data) >= 84:
        count = struct.unpack_from("<I", data, 80)[0]
        if len(data) == 84 + 50 * count:
            if count == 0:
                raise PrintabilityError("input", "binary STL has zero facets")
            if count > MAX_FACETS:
                raise PrintabilityError("limits", f"binary STL exceeds {MAX_FACETS} facets ({count})")
            raw_tris: list[tuple[float, ...]] = []
            unit_normals = True
            for vals in struct.iter_unpack("<12fH", memoryview(data)[84:]):
                coords = vals[:12]
                if not all(math.isfinite(c) for c in coords):
                    raise PrintabilityError("input", "binary STL contains non-finite coordinates or normals")
                nx, ny, nz = coords[0], coords[1], coords[2]
                nmag = math.sqrt(nx * nx + ny * ny + nz * nz)
                if not (0.99 <= nmag <= 1.01):
                    unit_normals = False
                raw_tris.append(tuple(float(c) for c in coords[3:12]))
            return "binary-stl", unit_normals, raw_tris

    head = data[:512].lstrip().lower()
    if not (head.startswith(b"solid") and b"facet" in data and b"endsolid" in data):
        raise PrintabilityError("input", "input is not a valid binary or ASCII STL")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PrintabilityError("input", f"ASCII STL is not valid UTF-8: {exc}") from exc

    raw_tris = []
    verts: list[float] = []
    in_loop = False
    for line in text.splitlines():
        toks = line.strip().split()
        if not toks:
            continue
        kw = toks[0].lower()
        if kw == "outer" and len(toks) >= 2 and toks[1].lower() == "loop":
            if in_loop:
                raise PrintabilityError("input", "nested outer loop in ASCII STL")
            in_loop = True
            verts = []
        elif kw == "vertex":
            if not in_loop or len(toks) != 4:
                raise PrintabilityError("input", "malformed vertex line in ASCII STL")
            try:
                vx, vy, vz = float(toks[1]), float(toks[2]), float(toks[3])
            except ValueError as exc:
                raise PrintabilityError("input", f"invalid vertex coordinate in ASCII STL: {exc}") from exc
            if not (math.isfinite(vx) and math.isfinite(vy) and math.isfinite(vz)):
                raise PrintabilityError("input", "non-finite vertex in ASCII STL")
            verts.extend((vx, vy, vz))
        elif kw == "endloop":
            if not in_loop or len(verts) != 9:
                raise PrintabilityError("input", "ASCII STL facet loop must have exactly 3 vertices")
            in_loop = False
            raw_tris.append(tuple(verts))
            if len(raw_tris) > MAX_FACETS:
                raise PrintabilityError("limits", f"ASCII STL exceeds {MAX_FACETS} facets")
    if in_loop or not raw_tris:
        raise PrintabilityError("input", "ASCII STL has no complete facets")
    return "ascii-stl", True, raw_tris


def _parse_and_build_facets(
    data: bytes,
    *,
    use_numpy: bool | None = None,
) -> dict[str, Any]:
    """Parse STL and compute exact float64 triangle records + mesh invariants."""
    want_np = HAS_NUMPY if use_numpy is None else (bool(use_numpy) and HAS_NUMPY)

    stl_format: str
    unit_normals: bool
    raw_tris: list[tuple[float, ...]]

    if want_np and _np is not None and len(data) >= 84:
        count = struct.unpack_from("<I", data, 80)[0]
        if len(data) == 84 + 50 * count:
            if count == 0:
                raise PrintabilityError("input", "binary STL has zero facets")
            if count > MAX_FACETS:
                raise PrintabilityError("limits", f"binary STL exceeds {MAX_FACETS} facets ({count})")
            dtype = _np.dtype([("n", "<f4", (3,)), ("v", "<f4", (9,)), ("attr", "<u2")])
            arr = _np.frombuffer(data, dtype=dtype, offset=84, count=count)
            normals_f64 = arr["n"].astype(_np.float64)
            verts_f64 = arr["v"].astype(_np.float64)
            if not (_np.isfinite(normals_f64).all() and _np.isfinite(verts_f64).all()):
                raise PrintabilityError("input", "binary STL contains non-finite coordinates or normals")
            nmags = _np.sqrt(_np.sum(normals_f64 * normals_f64, axis=1))
            unit_normals = bool(_np.all((nmags >= 0.99) & (nmags <= 1.01)))
            stl_format = "binary-stl"
            raw_tris = [tuple(row) for row in verts_f64.tolist()]
        else:
            stl_format, unit_normals, raw_tris = _parse_stl_stdlib(data)
    else:
        stl_format, unit_normals, raw_tris = _parse_stl_stdlib(data)

    # First pass: bounding box + topological half-edges + non-degenerate triangle records.
    # Each facet tuple:
    # (ax, ay, az, ux, uy, uz, vx, vy, vz, nx, ny, nz, mx, my, mz, area, min_z, max_z, v0_key, v1_key, v2_key)
    x_min = y_min = z_min = float("inf")
    x_max = y_max = z_max = float("-inf")
    facets: list[tuple[Any, ...]] = []
    degenerate_count = 0
    directed_edges: dict[tuple[tuple[int, int, int], tuple[int, int, int]], int] = defaultdict(int)

    for ax, ay, az, bx, by, bz, cx, cy, cz in raw_tris:
        mnx = min(ax, bx, cx)
        mxx = max(ax, bx, cx)
        mny = min(ay, by, cy)
        mxy = max(ay, by, cy)
        mnz = min(az, bz, cz)
        mxz = max(az, bz, cz)
        if mnx < x_min:
            x_min = mnx
        if mxx > x_max:
            x_max = mxx
        if mny < y_min:
            y_min = mny
        if mxy > y_max:
            y_max = mxy
        if mnz < z_min:
            z_min = mnz
        if mxz > z_max:
            z_max = mxz

        k0 = (round(ax * 100000.0), round(ay * 100000.0), round(az * 100000.0))
        k1 = (round(bx * 100000.0), round(by * 100000.0), round(bz * 100000.0))
        k2 = (round(cx * 100000.0), round(cy * 100000.0), round(cz * 100000.0))

        ux, uy, uz = bx - ax, by - ay, bz - az
        vx, vy, vz = cx - ax, cy - ay, cz - az
        nx = uy * vz - uz * vy
        ny = uz * vx - ux * vz
        nz = ux * vy - uy * vx
        area2 = math.sqrt(nx * nx + ny * ny + nz * nz)
        if area2 <= 1e-12 or k0 == k1 or k1 == k2 or k2 == k0:
            degenerate_count += 1
            continue

        directed_edges[(k0, k1)] += 1
        directed_edges[(k1, k2)] += 1
        directed_edges[(k2, k0)] += 1

        inv = 1.0 / area2
        nx *= inv
        ny *= inv
        nz *= inv
        area = 0.5 * area2
        mx = (ax + bx + cx) / 3.0
        my = (ay + by + cy) / 3.0
        mz = (az + bz + cz) / 3.0
        facets.append((
            ax, ay, az,
            ux, uy, uz,
            vx, vy, vz,
            nx, ny, nz,
            mx, my, mz,
            area, mnz, mxz,
            k0, k1, k2,
        ))

    if not facets:
        raise PrintabilityError("input", "STL contains only zero-area degenerate facets")

    # Topology check via paired half-edges
    undirected_pairs: set[tuple[tuple[int, int, int], tuple[int, int, int]]] = set()
    for u, v in directed_edges:
        undirected_pairs.add((u, v) if u < v else (v, u))

    boundary_edges = 0
    unbalanced_edges = 0
    non_manifold_shared_edges = 0
    for u, v in undirected_pairs:
        fwd = directed_edges.get((u, v), 0)
        rev = directed_edges.get((v, u), 0)
        if fwd + rev == 1:
            boundary_edges += 1
        if fwd != rev:
            unbalanced_edges += 1
        if fwd > 1 or rev > 1:
            non_manifold_shared_edges += 1

    # Exact signed volume & solid center of mass relative to (x_min, y_min, z_min) to avoid catastrophic cancellation
    vol_terms: list[float] = []
    cx_terms: list[float] = []
    cy_terms: list[float] = []
    cz_terms: list[float] = []
    area_terms: list[float] = []

    ox, oy, oz = x_min, y_min, z_min
    for f in facets:
        ax, ay, az, ux, uy, uz, vx, vy, vz = f[:9]
        area = f[15]
        area_terms.append(area)
        p0x, p0y, p0z = ax - ox, ay - oy, az - oz
        p1x, p1y, p1z = p0x + ux, p0y + uy, p0z + uz
        p2x, p2y, p2z = p0x + vx, p0y + vy, p0z + vz
        tet_vol6 = (
            p0x * (p1y * p2z - p1z * p2y)
            - p0y * (p1x * p2z - p1z * p2x)
            + p0z * (p1x * p2y - p1y * p2x)
        )
        tet_vol = tet_vol6 / 6.0
        vol_terms.append(tet_vol)
        cx_terms.append(tet_vol * (p0x + p1x + p2x) * 0.25)
        cy_terms.append(tet_vol * (p0y + p1y + p2y) * 0.25)
        cz_terms.append(tet_vol * (p0z + p1z + p2z) * 0.25)

    signed_vol = math.fsum(vol_terms)
    total_area = math.fsum(area_terms)
    if abs(signed_vol) > 1e-9:
        com_x = ox + math.fsum(cx_terms) / signed_vol
        com_y = oy + math.fsum(cy_terms) / signed_vol
        com_z = oz + math.fsum(cz_terms) / signed_vol
    else:
        com_x = 0.5 * (x_min + x_max)
        com_y = 0.5 * (y_min + y_max)
        com_z = 0.5 * (z_min + z_max)

    watertight = (
        degenerate_count == 0
        and unbalanced_edges == 0
        and non_manifold_shared_edges == 0
        and len(facets) >= 4
        and signed_vol > 1e-6
    )
    return {
        "format": stl_format,
        "declaredUnitNormals": unit_normals,
        "rawFacetCount": len(raw_tris),
        "validFacetCount": len(facets),
        "degenerateFacetCount": degenerate_count,
        "boundaryEdgeCount": boundary_edges,
        "unbalancedEdgeCount": unbalanced_edges,
        "nonManifoldSharedEdgeCount": non_manifold_shared_edges,
        "watertight": watertight,
        "boundsMm": {
            "min": (x_min, y_min, z_min),
            "max": (x_max, y_max, z_max),
        },
        "extentsMm": (x_max - x_min, y_max - y_min, z_max - z_min),
        "signedVolumeMm3": signed_vol,
        "surfaceAreaMm2": total_area,
        "centerOfMassMm": (com_x, com_y, com_z),
        "facets": facets,
    }


def _find_bed_placement(
    w: float,
    d: float,
    bed_x: float,
    bed_y: float,
    zones: list[dict[str, Any]],
) -> tuple[float, float] | None:
    eps = 1e-6
    if w > bed_x + eps or d > bed_y + eps:
        return None
    cand_x = [max(0.0, 0.5 * (bed_x - w)), 0.0, max(0.0, bed_x - w)]
    cand_y = [max(0.0, 0.5 * (bed_y - d)), 0.0, max(0.0, bed_y - d)]
    for z in zones:
        cand_x.extend((float(z["xMax"]), max(0.0, float(z["xMin"]) - w)))
        cand_y.extend((float(z["yMax"]), max(0.0, float(z["yMin"]) - d)))
    seen: set[tuple[int, int]] = set()
    for ox in cand_x:
        if ox < -eps or ox + w > bed_x + eps:
            continue
        for oy in cand_y:
            if oy < -eps or oy + d > bed_y + eps:
                continue
            key = (round(ox * 10000), round(oy * 10000))
            if key in seen:
                continue
            seen.add(key)
            blocked = False
            for z in zones:
                if (
                    ox < float(z["xMax"]) - eps
                    and ox + w > float(z["xMin"]) + eps
                    and oy < float(z["yMax"]) - eps
                    and oy + d > float(z["yMin"]) + eps
                ):
                    blocked = True
                    break
            if not blocked:
                return (max(0.0, ox), max(0.0, oy))
    return None


def evaluate_bed_fit(mesh: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    dx, dy, dz = mesh["extentsMm"]
    bed = profile["bedMm"]
    bx, by, bz = float(bed["x"]), float(bed["y"]), float(bed["z"])
    zones = profile["excludeZonesMm"]
    eps = 1e-6

    fits_height = dz <= bz + eps
    fits_raw_xy = (dx <= bx + eps and dy <= by + eps) or (dy <= bx + eps and dx <= by + eps)

    placement = _find_bed_placement(dx, dy, bx, by, zones)
    rot90 = False
    placed_w, placed_d = dx, dy
    if placement is None:
        placement = _find_bed_placement(dy, dx, bx, by, zones)
        if placement is not None:
            rot90 = True
            placed_w, placed_d = dy, dx

    fits_footprint = placement is not None
    fits = fits_height and fits_footprint
    blocked_by_exclusion_only = fits_height and fits_raw_xy and not fits_footprint
    return {
        "fits": fits,
        "fitsHeight": fits_height,
        "fitsFootprint": fits_footprint,
        "blockedByExcludeZone": blocked_by_exclusion_only,
        "requiresZRotation90": rot90,
        "partExtentsMm": _rvec((dx, dy, dz)),
        "bedMm": {"x": _r(bx), "y": _r(by), "z": _r(bz)},
        "placementOriginMm": _rvec(placement) if placement is not None else None,
        "marginsMm": {
            "x": _r(bx - placed_w),
            "y": _r(by - placed_d),
            "z": _r(bz - dz),
        },
    }


def _convex_hull_2d(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts

    def cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0.0:
            lower.pop()
        lower.append(p)
    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0.0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _polygon_area_2d(poly: list[tuple[float, float]]) -> float:
    if len(poly) < 3:
        return 0.0
    acc = 0.0
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        acc += x1 * y2 - x2 * y1
    return abs(acc) * 0.5


def _signed_margin_inside_ccw_hull(pt: tuple[float, float], hull: list[tuple[float, float]]) -> float:
    if len(hull) < 3:
        return -float("inf")
    px, py = pt
    min_dist = float("inf")
    n = len(hull)
    for i in range(n):
        x1, y1 = hull[i]
        x2, y2 = hull[(i + 1) % n]
        ex, ey = x2 - x1, y2 - y1
        elen = math.hypot(ex, ey)
        if elen <= 1e-12:
            continue
        # For CCW hull, inward half-plane has cross(edge, pt - p1) >= 0
        signed_d = (ex * (py - y1) - ey * (px - x1)) / elen
        if signed_d < min_dist:
            min_dist = signed_d
    return min_dist



def count_solids(mesh: dict[str, Any]) -> int:
    """Connected solids: facets sharing a quantised vertex belong to one solid.

    Base stability combines contact and centre of mass across the whole file,
    so multiple disconnected solids could let a stable part mask an unstable
    one. Callers reject multi-solid inputs instead of evaluating them jointly.
    """
    parent = list(range(len(mesh["facets"])))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    owner: dict[tuple[int, int, int], int] = {}
    for idx, f in enumerate(mesh["facets"]):
        ax, ay, az, ux, uy, uz, vx, vy, vz = f[:9]
        for x, y, z in ((ax, ay, az), (ax + ux, ay + uy, az + uz), (ax + vx, ay + vy, az + vz)):
            key = (round(x * 1e5), round(y * 1e5), round(z * 1e5))
            other = owner.setdefault(key, idx)
            if other != idx:
                ra, rb = find(other), find(idx)
                if ra != rb:
                    parent[rb] = ra
    return len({find(i) for i in range(len(parent))})

def evaluate_base_stability(mesh: dict[str, Any]) -> dict[str, Any]:
    z_min = mesh["boundsMm"]["min"][2]
    dx, dy, _ = mesh["extentsMm"]
    footprint_area = max(dx * dy, 1e-9)
    cos5 = math.cos(math.radians(5.0))

    base_area_terms: list[float] = []
    contact_pts: list[tuple[float, float]] = []
    base_facet_count = 0

    for f in mesh["facets"]:
        ax, ay, az, ux, uy, uz, vx, vy, vz, _nx, _ny, nz, _mx, _my, _mz, area, _mnz, mxz = f[:18]
        if mxz <= z_min + BASE_PLANE_TOLERANCE_MM and nz <= -cos5:
            base_area_terms.append(area)
            base_facet_count += 1
            contact_pts.append((round(ax, 5), round(ay, 5)))
            contact_pts.append((round(ax + ux, 5), round(ay + uy, 5)))
            contact_pts.append((round(ax + vx, 5), round(ay + vy, 5)))

    flat_base_area = math.fsum(base_area_terms)
    hull = _convex_hull_2d(contact_pts)
    hull_area = _polygon_area_2d(hull)
    com_x, com_y, com_z = mesh["centerOfMassMm"]
    com_h = max(0.0, com_z - z_min)

    if len(hull) >= 3 and hull_area > 1e-6:
        margin = _signed_margin_inside_ccw_hull((com_x, com_y), hull)
        com_inside = margin >= -1e-4
        tip_deg = math.degrees(math.atan2(max(0.0, margin), max(com_h, 1e-6))) if com_inside else 0.0
    else:
        margin = 0.0
        com_inside = False
        tip_deg = 0.0

    base_ratio = flat_base_area / footprint_area
    has_flat_base = (flat_base_area >= MIN_BASE_AREA_MM2) and (base_ratio >= MIN_BASE_FOOTPRINT_RATIO)
    is_stable = has_flat_base and com_inside and (tip_deg >= MIN_TIP_ANGLE_DEG)

    return {
        "ok": is_stable,
        "hasFlatBase": has_flat_base,
        "isStable": is_stable,
        "basePlaneZMm": _r(z_min),
        "baseFacetCount": base_facet_count,
        "flatBaseAreaMm2": _r(flat_base_area),
        "supportHullAreaMm2": _r(hull_area),
        "boundingFootprintAreaMm2": _r(dx * dy),
        "baseToFootprintRatio": _r(base_ratio),
        "centerOfMassMm": _rvec((com_x, com_y, com_z)),
        "comHeightAboveBaseMm": _r(com_h),
        "comInsideSupportHull": com_inside,
        "comSupportMarginMm": _r(margin),
        "minTipAngleDeg": _r(tip_deg),
    }


def evaluate_wall_thickness(
    mesh: dict[str, Any],
    nozzle_diameter_mm: float,
    *,
    max_samples: int = DEFAULT_MAX_WALL_SAMPLES,
) -> dict[str, Any]:
    facets = mesh["facets"]
    x0, y0, z0 = mesh["boundsMm"]["min"]
    x1, y1, z1 = mesh["boundsMm"]["max"]
    span = max(x1 - x0, y1 - y0, z1 - z0, 1.0)
    cell = max(span / 32.0, 1.0)
    gx = max(1, min(64, int(math.ceil((x1 - x0) / cell)) + 1))
    gy = max(1, min(64, int(math.ceil((y1 - y0) / cell)) + 1))
    gz = max(1, min(64, int(math.ceil((z1 - z0) / cell)) + 1))
    cx_size = ((x1 - x0) + 1e-6) / gx
    cy_size = ((y1 - y0) + 1e-6) / gy
    cz_size = ((z1 - z0) + 1e-6) / gz

    grid: list[list[int]] = [[] for _ in range(gx * gy * gz)]
    stride_y = gx
    stride_z = gx * gy

    for idx, f in enumerate(facets):
        ax, ay, az, ux, uy, uz, vx, vy, vz = f[:9]
        bx, by, bz = ax + ux, ay + uy, az + uz
        cx, cy, cz = ax + vx, ay + vy, az + vz
        i0 = max(0, min(gx - 1, int((min(ax, bx, cx) - x0) / cx_size)))
        i1 = max(0, min(gx - 1, int((max(ax, bx, cx) - x0) / cx_size)))
        j0 = max(0, min(gy - 1, int((min(ay, by, cy) - y0) / cy_size)))
        j1 = max(0, min(gy - 1, int((max(ay, by, cy) - y0) / cy_size)))
        k0 = max(0, min(gz - 1, int((min(az, bz, cz) - z0) / cz_size)))
        k1 = max(0, min(gz - 1, int((max(az, bz, cz) - z0) / cz_size)))
        for k in range(k0, k1 + 1):
            kz = k * stride_z
            for j in range(j0, j1 + 1):
                jz = kz + j * stride_y
                for i in range(i0, i1 + 1):
                    grid[jz + i].append(idx)

    # Deterministic sample set: full mesh up to max_samples; otherwise cover every
    # occupied grid cell (smallest-area + midpoint facet) plus uniform stride.
    total_facets = len(facets)
    if max_samples <= 0 or total_facets <= max_samples:
        sample_indices = list(range(total_facets))
    else:
        chosen: set[int] = set()
        for bucket in grid:
            if not bucket:
                continue
            smallest = min(bucket, key=lambda idx: (facets[idx][15], idx))
            chosen.add(smallest)
            chosen.add(bucket[len(bucket) // 2])
            if len(chosen) >= max_samples:
                break
        if len(chosen) < max_samples:
            needed = max_samples - len(chosen)
            for s in range(needed):
                chosen.add(int(s * total_facets / needed))
        sample_indices = sorted(chosen)

    def first_hit(ox: float, oy: float, oz: float, dx: float, dy: float, dz: float, skip_idx: int) -> tuple[float, int]:
        ix = max(0, min(gx - 1, int((ox - x0) / cx_size)))
        iy = max(0, min(gy - 1, int((oy - y0) / cy_size)))
        iz = max(0, min(gz - 1, int((oz - z0) / cz_size)))
        step_x = 1 if dx > 0.0 else (-1 if dx < 0.0 else 0)
        step_y = 1 if dy > 0.0 else (-1 if dy < 0.0 else 0)
        step_z = 1 if dz > 0.0 else (-1 if dz < 0.0 else 0)
        tmax_x = ((x0 + (ix + (1 if step_x > 0 else 0)) * cx_size - ox) / dx) if step_x else float("inf")
        tmax_y = ((y0 + (iy + (1 if step_y > 0 else 0)) * cy_size - oy) / dy) if step_y else float("inf")
        tmax_z = ((z0 + (iz + (1 if step_z > 0 else 0)) * cz_size - oz) / dz) if step_z else float("inf")
        tdelta_x = (cx_size / abs(dx)) if step_x else float("inf")
        tdelta_y = (cy_size / abs(dy)) if step_y else float("inf")
        tdelta_z = (cz_size / abs(dz)) if step_z else float("inf")
        best_t = float("inf")
        best_idx = -1
        seen: set[int] = set()
        while 0 <= ix < gx and 0 <= iy < gy and 0 <= iz < gz:
            cell_exit = min(tmax_x, tmax_y, tmax_z)
            for tidx in grid[iz * stride_z + iy * stride_y + ix]:
                if tidx == skip_idx or tidx in seen:
                    continue
                seen.add(tidx)
                ax, ay, az, ux, uy, uz, vx, vy, vz = facets[tidx][:9]
                px = dy * vz - dz * vy
                py = dz * vx - dx * vz
                pz = dx * vy - dy * vx
                det = ux * px + uy * py + uz * pz
                if -1e-12 < det < 1e-12:
                    continue
                inv_det = 1.0 / det
                tx, ty, tz = ox - ax, oy - ay, oz - az
                u = (tx * px + ty * py + tz * pz) * inv_det
                if u < -1e-6 or u > 1.0 + 1e-6:
                    continue
                qx = ty * uz - tz * uy
                qy = tz * ux - tx * uz
                qz = tx * uy - ty * ux
                v = (dx * qx + dy * qy + dz * qz) * inv_det
                if v < -1e-6 or u + v > 1.0 + 1e-6:
                    continue
                t_hit = (vx * qx + vy * qy + vz * qz) * inv_det
                if 5e-5 < t_hit < best_t:
                    best_t = t_hit
                    best_idx = tidx
            if best_t <= cell_exit + 1e-6:
                break
            if tmax_x <= tmax_y and tmax_x <= tmax_z:
                ix += step_x
                tmax_x += tdelta_x
            elif tmax_y <= tmax_z:
                iy += step_y
                tmax_y += tdelta_y
            else:
                iz += step_z
                tmax_z += tdelta_z
        return best_t, best_idx

    measurements: list[float] = []
    min_wall = float("inf")
    min_loc: tuple[float, float, float] | None = None
    min_mode: str | None = None
    below_nozzle = 0
    below_two_nozzles = 0
    two_nozzles = 2.0 * nozzle_diameter_mm

    for idx in sample_indices:
        nx, ny, nz, mx, my, mz = facets[idx][9:15]
        candidates_for_facet: list[tuple[float, str]] = []

        # 1. 3D inward normal ray (floors, roofs, walls, sloped pockets)
        t3d, hidx3d = first_hit(
            mx - RAY_INSET_MM * nx,
            my - RAY_INSET_MM * ny,
            mz - RAY_INSET_MM * nz,
            -nx, -ny, -nz, idx,
        )
        if hidx3d >= 0:
            hnx, hny, hnz = facets[hidx3d][9:12]
            if nx * hnx + ny * hny + nz * hnz <= -0.5:
                candidates_for_facet.append((t3d + RAY_INSET_MM, "3d-normal"))

        # 2. Horizontal XY slice-plane inward ray for vertical/steep walls
        nxy = math.hypot(nx, ny)
        if nxy >= 0.5 and (z0 + BASE_PLANE_TOLERANCE_MM < mz < z1 - BASE_PLANE_TOLERANCE_MM):
            rx, ry = -nx / nxy, -ny / nxy
            txy, hidx_xy = first_hit(
                mx + RAY_INSET_MM * rx,
                my + RAY_INSET_MM * ry,
                mz,
                rx, ry, 0.0, idx,
            )
            if hidx_xy >= 0:
                hnx, hny, _ = facets[hidx_xy][9:12]
                hnxy = math.hypot(hnx, hny)
                if hnxy >= 0.5 and ((nx * hnx + ny * hny) / (nxy * hnxy)) <= -0.5:
                    candidates_for_facet.append((txy + RAY_INSET_MM, "xy-slice"))

        if candidates_for_facet:
            best_thick, best_mode = min(candidates_for_facet, key=lambda item: item[0])
            measurements.append(best_thick)
            if best_thick < nozzle_diameter_mm - 1e-3:
                below_nozzle += 1
            if best_thick < two_nozzles - 1e-3:
                below_two_nozzles += 1
            if best_thick < min_wall:
                min_wall = best_thick
                min_loc = (mx, my, mz)
                min_mode = best_mode

    if not measurements or not math.isfinite(min_wall):
        # Fallback to smallest bounding extent when no opposing rays hit (e.g. non-closed shell)
        min_wall = min(mesh["extentsMm"])
        min_loc = mesh["centerOfMassMm"]
        min_mode = "bounds-fallback"
        p05 = min_wall
    else:
        measurements.sort()
        p05_idx = min(len(measurements) - 1, max(0, int(0.05 * (len(measurements) - 1))))
        p05 = measurements[p05_idx]

    meets_nozzle = min_wall >= nozzle_diameter_mm - 1e-3
    meets_two = min_wall >= two_nozzles - 1e-3
    return {
        "meetsMinimumNozzleWidth": meets_nozzle,
        "meetsRecommendedTwoPerimeters": meets_two,
        "minWallMm": _r(min_wall),
        "p05WallMm": _r(p05),
        "nozzleDiameterMm": _r(nozzle_diameter_mm),
        "recommendedMinWallMm": _r(two_nozzles),
        "wallToNozzleRatio": _r(min_wall / nozzle_diameter_mm),
        "minWallLocationMm": _rvec(min_loc) if min_loc is not None else None,
        "minWallMode": min_mode,
        "sampledFacets": len(sample_indices),
        "opposingMeasurements": len(measurements),
        "thinSamplesBelowNozzle": below_nozzle,
        "thinSamplesBelowTwoNozzles": below_two_nozzles,
    }


def evaluate_overhangs(
    mesh: dict[str, Any],
    *,
    threshold_deg: float = DEFAULT_OVERHANG_THRESHOLD_DEG,
) -> dict[str, Any]:
    if not (0.0 < threshold_deg < 90.0):
        raise PrintabilityError("parameters", "overhang threshold_deg must be in (0, 90)")
    z_min = mesh["boundsMm"]["min"][2]
    total_area = max(mesh["surfaceAreaMm2"], 1e-9)
    sin_thresh = math.sin(math.radians(threshold_deg))

    # Collect overhang facets strictly above the build-plate contact layer
    overhang_items: list[tuple[int, float, float]] = []  # (facet_idx, area, angle_from_vertical_deg)
    max_angle = 0.0
    for idx, f in enumerate(mesh["facets"]):
        nz = f[11]
        mz = f[14]
        area = f[15]
        mxz = f[17]
        if mxz <= z_min + BASE_PLANE_TOLERANCE_MM or mz <= z_min + 0.15:
            continue
        if nz < -(sin_thresh + 1e-6):
            angle_deg = math.degrees(math.asin(min(1.0, max(0.0, -nz))))
            overhang_items.append((idx, area, angle_deg))
            if angle_deg > max_angle:
                max_angle = angle_deg

    overhang_area = math.fsum(item[1] for item in overhang_items)
    overhang_pct = 100.0 * overhang_area / total_area

    # Group overhang facets into connected spatial regions via shared quantized vertices
    vert_to_overhang_pos: dict[tuple[int, int, int], list[int]] = defaultdict(list)
    for pos, (fidx, _area, _ang) in enumerate(overhang_items):
        k0, k1, k2 = mesh["facets"][fidx][18:21]
        vert_to_overhang_pos[k0].append(pos)
        vert_to_overhang_pos[k1].append(pos)
        vert_to_overhang_pos[k2].append(pos)

    visited = [False] * len(overhang_items)
    locations: list[dict[str, Any]] = []
    for start in range(len(overhang_items)):
        if visited[start]:
            continue
        visited[start] = True
        q: deque[int] = deque([start])
        comp: list[int] = []
        while q:
            cur = q.popleft()
            comp.append(cur)
            fidx = overhang_items[cur][0]
            for vk in mesh["facets"][fidx][18:21]:
                for nb in vert_to_overhang_pos[vk]:
                    if not visited[nb]:
                        visited[nb] = True
                        q.append(nb)

        comp_area = math.fsum(overhang_items[p][1] for p in comp)
        wx = math.fsum(overhang_items[p][1] * mesh["facets"][overhang_items[p][0]][12] for p in comp)
        wy = math.fsum(overhang_items[p][1] * mesh["facets"][overhang_items[p][0]][13] for p in comp)
        wz = math.fsum(overhang_items[p][1] * mesh["facets"][overhang_items[p][0]][14] for p in comp)
        cx = wx / max(comp_area, 1e-12)
        cy = wy / max(comp_area, 1e-12)
        cz = wz / max(comp_area, 1e-12)
        comp_max_ang = max(overhang_items[p][2] for p in comp)

        bx0 = by0 = bz0 = float("inf")
        bx1 = by1 = bz1 = float("-inf")
        for p in comp:
            ax, ay, az, ux, uy, uz, vx, vy, vz = mesh["facets"][overhang_items[p][0]][:9]
            px1, py1, pz1 = ax + ux, ay + uy, az + uz
            px2, py2, pz2 = ax + vx, ay + vy, az + vz
            bx0 = min(bx0, ax, px1, px2)
            bx1 = max(bx1, ax, px1, px2)
            by0 = min(by0, ay, py1, py2)
            by1 = max(by1, ay, py1, py2)
            bz0 = min(bz0, az, pz1, pz2)
            bz1 = max(bz1, az, pz1, pz2)

        locations.append({
            "facetCount": len(comp),
            "areaMm2": _r(comp_area),
            "areaPercentOfTotal": _r(100.0 * comp_area / total_area),
            "maxOverhangDeg": _r(comp_max_ang),
            "centroidMm": _rvec((cx, cy, cz)),
            "boundsMm": {
                "min": _rvec((bx0, by0, bz0)),
                "max": _rvec((bx1, by1, bz1)),
            },
        })

    locations.sort(key=lambda loc: (-loc["areaMm2"], loc["centroidMm"]))

    severe_region = any(loc["areaMm2"] >= 4.0 and loc["maxOverhangDeg"] >= 55.0 for loc in locations)
    requires_supports = (overhang_area >= 10.0) or (overhang_pct >= 1.0) or severe_region

    return {
        "thresholdDeg": _r(threshold_deg),
        "requiresSupports": requires_supports,
        "overhangFacetCount": len(overhang_items),
        "overhangAreaMm2": _r(overhang_area),
        "totalSurfaceAreaMm2": _r(total_area),
        "overhangAreaPercent": _r(overhang_pct),
        "maxOverhangDeg": _r(max_angle),
        "regionCount": len(locations),
        "locations": locations[:25],
    }


def estimate_volume_and_filament(
    mesh: dict[str, Any],
    profile: dict[str, Any],
    material_spec: dict[str, Any],
) -> dict[str, Any]:
    vol_mm3 = max(0.0, mesh["signedVolumeMm3"])
    vol_cm3 = vol_mm3 / 1000.0
    area_mm2 = mesh["surfaceAreaMm2"]
    fil_diam = float(profile["filamentDiameterMm"])
    nozzle = float(profile["nozzleDiameterMm"])
    density = float(material_spec["densityGPerCm3"])
    fil_cross_mm2 = math.pi * (0.5 * fil_diam) ** 2

    solid_len_mm = vol_mm3 / fil_cross_mm2
    solid_mass_g = vol_cm3 * density

    # Deterministic pre-slice shell + sparse-infill estimate (2 wall loops + 15% infill)
    shell_thickness_mm = 2.0 * nozzle
    shell_vol_mm3 = min(vol_mm3, area_mm2 * shell_thickness_mm * 0.85)
    interior_vol_mm3 = max(0.0, vol_mm3 - shell_vol_mm3)
    typical_extruded_mm3 = shell_vol_mm3 + 0.15 * interior_vol_mm3
    typical_cm3 = typical_extruded_mm3 / 1000.0
    typical_len_mm = typical_extruded_mm3 / fil_cross_mm2
    typical_mass_g = typical_cm3 * density

    return {
        "material": material_spec["family"],
        "densityGPerCm3": _r(density),
        "filamentDiameterMm": _r(fil_diam),
        "meshSolidVolumeMm3": _r(vol_mm3),
        "meshSolidVolumeCm3": _r(vol_cm3),
        "surfaceAreaMm2": _r(area_mm2),
        "solidUpperBound": {
            "filamentLengthMm": _r(solid_len_mm),
            "filamentLengthM": _r(solid_len_mm / 1000.0),
            "filamentMassG": _r(solid_mass_g),
        },
        "typicalFffEstimate": {
            "assumptions": "2 perimeter walls + top/bottom shells + 15% sparse infill (pre-slice estimate)",
            "extrudedVolumeCm3": _r(typical_cm3),
            "filamentLengthMm": _r(typical_len_mm),
            "filamentLengthM": _r(typical_len_mm / 1000.0),
            "filamentMassG": _r(typical_mass_g),
        },
    }


def analyze_stl(
    stl_path: Path,
    profile: dict[str, Any],
    material_spec: dict[str, Any],
    *,
    overhang_threshold_deg: float = DEFAULT_OVERHANG_THRESHOLD_DEG,
    max_wall_samples: int = DEFAULT_MAX_WALL_SAMPLES,
    max_input_bytes: int = MAX_INPUT_BYTES,
    stl_bytes: bytes | None = None,
    use_numpy: bool | None = None,
) -> dict[str, Any]:
    """Analyze an STL against a printer profile and emit a deterministic printability report."""
    path = Path(stl_path)
    # Retained verified bytes let callers bind analysis and slicing to one snapshot.
    # In this mode the path is only a report label and is never reopened.
    data = read_stl_bounded(path, max_input_bytes) if stl_bytes is None else stl_bytes
    if not data:
        raise PrintabilityError("input", "STL file is empty")
    if len(data) > max_input_bytes:
        raise PrintabilityError("limits", f"STL exceeds {max_input_bytes} byte limit")
    sha256 = hashlib.sha256(data).hexdigest()
    mesh = _parse_and_build_facets(data, use_numpy=use_numpy)

    bed_fit = evaluate_bed_fit(mesh, profile)
    base_stability = evaluate_base_stability(mesh)
    wall_thickness = evaluate_wall_thickness(
        mesh,
        float(profile["nozzleDiameterMm"]),
        max_samples=max_wall_samples,
    )
    overhangs = evaluate_overhangs(mesh, threshold_deg=overhang_threshold_deg)
    estimates = estimate_volume_and_filament(mesh, profile, material_spec)

    blocker_reasons: list[tuple[str, str]] = []
    support_reasons: list[tuple[str, str]] = []
    warnings: list[dict[str, str]] = []

    if mesh["format"] == "binary-stl" and not mesh["declaredUnitNormals"]:
        blocker_reasons.append((
            "invalid-stl-normals",
            "Binary STL contains non-unit facet normals; BambuStudio CLI rejects zero/non-unit normals.",
        ))
    if mesh["degenerateFacetCount"] > 0:
        blocker_reasons.append((
            "degenerate-facets",
            f"STL contains {mesh['degenerateFacetCount']} zero-area or collapsed degenerate facet(s); "
            "printability refuses to analyze a silently cleaned subset.",
        ))
    solid_count = count_solids(mesh)
    if solid_count > 1:
        blocker_reasons.append((
            "multiple-disconnected-solids",
            f"File contains {solid_count} disconnected solids; stability cannot be judged jointly, so print each part from its own file.",
        ))
    if not mesh["watertight"]:
        blocker_reasons.append((
            "mesh-not-watertight",
            f"Mesh is not a closed outward-wound solid (unbalancedEdges={mesh['unbalancedEdgeCount']}, "
            f"boundaryEdges={mesh['boundaryEdgeCount']}, "
            f"nonManifoldSharedEdges={mesh['nonManifoldSharedEdgeCount']}, "
            f"signedVolumeMm3={_r(mesh['signedVolumeMm3'])}).",
        ))
    if not bed_fit["fits"]:
        px, py, pz = bed_fit["partExtentsMm"]
        bx, by, bz = bed_fit["bedMm"]["x"], bed_fit["bedMm"]["y"], bed_fit["bedMm"]["z"]
        if bed_fit["blockedByExcludeZone"]:
            blocker_reasons.append((
                "intersects-bed-exclusion-zone",
                f"Part footprint {px:.2f} x {py:.2f} mm cannot avoid bed exclusion zone(s) on {profile['displayName']}.",
            ))
        else:
            blocker_reasons.append((
                "exceeds-build-volume",
                f"Part extents {px:.2f} x {py:.2f} x {pz:.2f} mm exceed {profile['displayName']} "
                f"build volume {bx:.1f} x {by:.1f} x {bz:.1f} mm.",
            ))
    if not base_stability["hasFlatBase"]:
        blocker_reasons.append((
            "missing-flat-base",
            f"Insufficient flat base contact on build plate ({base_stability['flatBaseAreaMm2']:.2f} mm^2, "
            f"{100.0 * base_stability['baseToFootprintRatio']:.2f}% of footprint).",
        ))
    elif not base_stability["isStable"]:
        blocker_reasons.append((
            "unstable-base-contact",
            f"Center of mass threatens tipping on base support polygon "
            f"(insideHull={base_stability['comInsideSupportHull']}, tipAngle={base_stability['minTipAngleDeg']:.1f} deg).",
        ))
    if not wall_thickness["meetsMinimumNozzleWidth"]:
        blocker_reasons.append((
            "wall-thinner-than-nozzle",
            f"Minimum wall thickness {wall_thickness['minWallMm']:.3f} mm is narrower than "
            f"{profile['nozzleDiameterMm']:.2f} mm nozzle diameter.",
        ))
    elif not wall_thickness["meetsRecommendedTwoPerimeters"]:
        warnings.append({
            "code": "single-perimeter-thin-wall",
            "message": (
                f"Minimum wall {wall_thickness['minWallMm']:.3f} mm is between 1x and 2x nozzle width "
                f"({profile['nozzleDiameterMm']:.2f}..{2.0 * profile['nozzleDiameterMm']:.2f} mm)."
            ),
        })

    if overhangs["requiresSupports"]:
        support_reasons.append((
            "overhangs-require-supports",
            f"Overhang area above {overhangs['thresholdDeg']:.1f} deg is {overhangs['overhangAreaPercent']:.2f}% "
            f"({overhangs['overhangAreaMm2']:.2f} mm^2 across {overhangs['regionCount']} region(s), "
            f"max {overhangs['maxOverhangDeg']:.1f} deg).",
        ))
    elif overhangs["overhangFacetCount"] > 0:
        warnings.append({
            "code": "minor-localized-overhang",
            "message": (
                f"Minor localized overhang above {overhangs['thresholdDeg']:.1f} deg "
                f"({overhangs['overhangAreaMm2']:.2f} mm^2, {overhangs['overhangAreaPercent']:.2f}%)."
            ),
        })

    if bed_fit["fits"] and bed_fit["requiresZRotation90"]:
        warnings.append({
            "code": "requires-z-rotation-90",
            "message": "Part fits build plate when rotated 90 deg around Z during plate arrangement.",
        })

    if blocker_reasons:
        verdict = "not-printable"
        combined = blocker_reasons + support_reasons
        reason_codes = [c for c, _ in combined]
        reasons = [f"{c}: {m}" for c, m in combined]
    elif support_reasons:
        verdict = "printable-with-supports"
        reason_codes = [c for c, _ in support_reasons]
        reasons = [f"{c}: {m}" for c, m in support_reasons]
    else:
        verdict = "printable"
        reason_codes = ["all-checks-passed"]
        px, py, pz = bed_fit["partExtentsMm"]
        reasons = [
            f"Fits {profile['displayName']} bed ({px:.2f} x {py:.2f} x {pz:.2f} mm), "
            f"flat stable base ({base_stability['flatBaseAreaMm2']:.1f} mm^2), "
            f"minimum wall {wall_thickness['minWallMm']:.2f} mm >= {profile['nozzleDiameterMm']:.2f} mm nozzle, "
            f"and {overhangs['overhangAreaPercent']:.2f}% overhang above {overhangs['thresholdDeg']:.0f} deg."
        ]

    return {
        "schema": PRINTABILITY_SCHEMA,
        "verdict": verdict,
        "reasonCodes": reason_codes,
        "reasons": reasons,
        "warnings": warnings,
        "dispatchAuthorized": False,
        "provesPhysicalFit": False,
        "input": {
            "fileName": path.name,
            "format": mesh["format"],
            "sha256": sha256,
            "byteLength": len(data),
            "mediaType": "model/stl",
        },
        "profile": {
            "id": profile["id"],
            "bambuModel": profile["bambuModel"],
            "displayName": profile["displayName"],
            "bedMm": profile["bedMm"],
            "excludeZonesMm": profile["excludeZonesMm"],
            "nozzleDiameterMm": profile["nozzleDiameterMm"],
            "nozzleCount": profile["nozzleCount"],
            "nozzleType": profile["nozzleType"],
            "bedType": profile["bedType"],
        },
        "topology": {
            "watertight": mesh["watertight"],
            "solidCount": solid_count,
            "declaredUnitNormals": mesh["declaredUnitNormals"],
            "rawFacetCount": mesh["rawFacetCount"],
            "validFacetCount": mesh["validFacetCount"],
            "degenerateFacetCount": mesh["degenerateFacetCount"],
            "boundaryEdgeCount": mesh["boundaryEdgeCount"],
            "unbalancedEdgeCount": mesh["unbalancedEdgeCount"],
            "nonManifoldSharedEdgeCount": mesh["nonManifoldSharedEdgeCount"],
        },
        "checks": {
            "bedFit": bed_fit,
            "baseStability": base_stability,
            "wallThickness": wall_thickness,
            "overhangs": overhangs,
        },
        "estimates": estimates,
    }
