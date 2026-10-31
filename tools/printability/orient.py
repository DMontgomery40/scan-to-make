#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Deterministic STL auto-orientation for FFF 3D printing (MIT, no Blender).

Evaluates candidate build-plate orientations for a closed, single-solid,
non-degenerate STL against an explicit printer profile:
  1. The 6 axis-aligned faces (-Z, +Z, -X, +X, -Y, +Y),
  2. Outward normals of the largest coplanar flat facet clusters, and
  3. Outward normals of the 3D convex-hull faces.

Scores each candidate deterministically by bed fit, flat base area and CoM
tipping stability (matching analyzer.py's gates), overhang support area, and
Z print height. Uses NumPy (BSD-3-Clause) when installed for fast vectorised
coordinate transforms and binary STL packing, with a byte-identical IEEE-754
float64/float32 stdlib fallback.
"""

from __future__ import annotations

import hashlib
import math
import struct
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

from analyzer import (
    BASE_PLANE_TOLERANCE_MM,
    DEFAULT_OVERHANG_THRESHOLD_DEG,
    HAS_NUMPY,
    MAX_FACETS,
    MAX_INPUT_BYTES,
    MIN_BASE_AREA_MM2,
    PrintabilityError,
    _np,
    _parse_and_build_facets,
    _parse_stl_stdlib,
    _r,
    _rvec,
    count_solids,
    evaluate_base_stability,
    evaluate_bed_fit,
    evaluate_overhangs,
    read_stl_bounded,
)

ORIENTATION_SCHEMA = "scan-to-make.print-orientation/0.1.0"
BINARY_STL_HEADER = b"scan-to-make oriented binary STL".ljust(80, b"\x00")

MAX_FLAT_CLUSTER_CANDIDATES = 16
MAX_CONVEX_HULL_CANDIDATES = 24
MAX_HULL_INPUT_VERTICES = 1600

AXIS_ALIGNED_CANDIDATES: tuple[tuple[str, tuple[float, float, float]], ...] = (
    ("axis:-z", (0.0, 0.0, -1.0)),
    ("axis:+z", (0.0, 0.0, 1.0)),
    ("axis:-x", (-1.0, 0.0, 0.0)),
    ("axis:+x", (1.0, 0.0, 0.0)),
    ("axis:-y", (0.0, -1.0, 0.0)),
    ("axis:+y", (0.0, 1.0, 0.0)),
)

# Exact proper orthogonal (det = +1) matrices mapping each canonical axis normal to (0, 0, -1).
_CANONICAL_AXIS_MATRICES: dict[tuple[float, float, float], tuple[tuple[float, float, float], ...]] = {
    (0.0, 0.0, -1.0): (
        (1.0, 0.0, 0.0),
        (0.0, 1.0, 0.0),
        (0.0, 0.0, 1.0),
    ),
    (0.0, 0.0, 1.0): (
        (1.0, 0.0, 0.0),
        (0.0, -1.0, 0.0),
        (0.0, 0.0, -1.0),
    ),
    (-1.0, 0.0, 0.0): (
        (0.0, 0.0, -1.0),
        (0.0, 1.0, 0.0),
        (1.0, 0.0, 0.0),
    ),
    (1.0, 0.0, 0.0): (
        (0.0, 0.0, 1.0),
        (0.0, 1.0, 0.0),
        (-1.0, 0.0, 0.0),
    ),
    (0.0, -1.0, 0.0): (
        (1.0, 0.0, 0.0),
        (0.0, 0.0, -1.0),
        (0.0, 1.0, 0.0),
    ),
    (0.0, 1.0, 0.0): (
        (1.0, 0.0, 0.0),
        (0.0, 0.0, 1.0),
        (0.0, -1.0, 0.0),
    ),
}

_R_Z90: tuple[tuple[float, float, float], ...] = (
    (0.0, -1.0, 0.0),
    (1.0, 0.0, 0.0),
    (0.0, 0.0, 1.0),
)


def _normalize3(vx: float, vy: float, vz: float) -> tuple[float, float, float] | None:
    mag = math.sqrt((vx * vx + vy * vy) + vz * vz)
    if mag <= 1e-12:
        return None
    return (vx / mag, vy / mag, vz / mag)


def _matmul3(
    a: tuple[tuple[float, float, float], ...],
    b: tuple[tuple[float, float, float], ...],
) -> tuple[tuple[float, float, float], ...]:
    return tuple(
        tuple(
            (a[i][0] * b[0][j] + a[i][1] * b[1][j]) + a[i][2] * b[2][j]
            for j in range(3)
        )
        for i in range(3)
    )


def rotation_mapping_down_normal(
    down_normal: tuple[float, float, float],
) -> tuple[tuple[float, float, float], ...]:
    """Return a det=+1 3x3 rotation matrix mapping unit `down_normal` to (0, 0, -1)."""
    if down_normal in _CANONICAL_AXIS_MATRICES:
        return _CANONICAL_AXIS_MATRICES[down_normal]

    unit = _normalize3(*down_normal)
    if unit is None:
        raise PrintabilityError("parameters", "down_normal must be non-zero")
    dx, dy, dz = unit
    sin_theta = math.hypot(dx, dy)
    cos_theta = max(-1.0, min(1.0, -dz))
    if sin_theta <= 1e-12:
        if dz < 0.0:
            return _CANONICAL_AXIS_MATRICES[(0.0, 0.0, -1.0)]
        return _CANONICAL_AXIS_MATRICES[(0.0, 0.0, 1.0)]

    kx = -dy / sin_theta
    ky = dx / sin_theta
    theta = math.atan2(sin_theta, cos_theta)
    c = math.cos(theta)
    s = math.sin(theta)
    omc = 1.0 - c
    return (
        (c + kx * kx * omc, kx * ky * omc, ky * s),
        (ky * kx * omc, c + ky * ky * omc, -kx * s),
        (-ky * s, kx * s, c),
    )


def axis_angle_from_matrix(
    rot: tuple[tuple[float, float, float], ...],
) -> tuple[tuple[float, float, float], float]:
    """Extract canonical unit axis and angle in [0, 180] degrees from a 3x3 SO(3) matrix."""
    trace = (rot[0][0] + rot[1][1]) + rot[2][2]
    cos_ang = max(-1.0, min(1.0, 0.5 * (trace - 1.0)))
    angle_rad = math.acos(cos_ang)
    angle_deg = math.degrees(angle_rad)
    if angle_deg <= 1e-7:
        return ((0.0, 0.0, 1.0), 0.0)

    rx = rot[2][1] - rot[1][2]
    ry = rot[0][2] - rot[2][0]
    rz = rot[1][0] - rot[0][1]
    rmag = math.sqrt((rx * rx + ry * ry) + rz * rz)
    if rmag > 1e-9:
        return ((rx / rmag, ry / rmag, rz / rmag), angle_deg)

    # Near 180-degree rotation: extract axis from largest positive diagonal component of (R + I)/2.
    d0 = max(0.0, 0.5 * (rot[0][0] + 1.0))
    d1 = max(0.0, 0.5 * (rot[1][1] + 1.0))
    d2 = max(0.0, 0.5 * (rot[2][2] + 1.0))
    ax = math.sqrt(d0)
    ay = math.sqrt(d1)
    az = math.sqrt(d2)
    if d0 >= d1 and d0 >= d2:
        if rot[0][1] + rot[1][0] < 0.0:
            ay = -ay
        if rot[0][2] + rot[2][0] < 0.0:
            az = -az
    elif d1 >= d0 and d1 >= d2:
        if rot[0][1] + rot[1][0] < 0.0:
            ax = -ax
        if rot[1][2] + rot[2][1] < 0.0:
            az = -az
    else:
        if rot[0][2] + rot[2][0] < 0.0:
            ax = -ax
        if rot[1][2] + rot[2][1] < 0.0:
            ay = -ay
    unit = _normalize3(ax, ay, az) or (1.0, 0.0, 0.0)
    return (unit, 180.0)


def _extract_raw_tris(
    data: bytes,
    *,
    use_numpy: bool | None = None,
) -> tuple[list[tuple[float, ...]], Any]:
    """Return raw triangle coordinates as float64 9-tuples and optional (N, 9) float64 ndarray."""
    want_np = HAS_NUMPY if use_numpy is None else (bool(use_numpy) and HAS_NUMPY)
    if want_np and _np is not None and len(data) >= 84:
        count = struct.unpack_from("<I", data, 80)[0]
        if len(data) == 84 + 50 * count:
            if count == 0:
                raise PrintabilityError("input", "binary STL has zero facets")
            if count > MAX_FACETS:
                raise PrintabilityError("limits", f"binary STL exceeds {MAX_FACETS} facets ({count})")
            dtype = _np.dtype([("n", "<f4", (3,)), ("v", "<f4", (9,)), ("attr", "<u2")])
            arr = _np.frombuffer(data, dtype=dtype, offset=84, count=count)
            verts_f64 = arr["v"].astype(_np.float64)
            return [], verts_f64

    _fmt, _unit, raw_tris = _parse_stl_stdlib(data)
    if want_np and _np is not None:
        return raw_tris, _np.asarray(raw_tris, dtype=_np.float64)
    return raw_tris, None


def _pack_rotated_tris(
    raw_tris: list[tuple[float, ...]],
    verts_np: Any,
    rot: tuple[tuple[float, float, float], ...],
    *,
    use_numpy: bool | None = None,
) -> bytes:
    """Rotate triangles by `rot`, translate min bounds to (0, 0, 0), and emit canonical binary STL.

    Every floating-point step uses IEEE-754 basic operations (*, +, -, /, sqrt,
    float64->float32 round-to-nearest-even) and canonicalizes signed zeros so
    stdlib and NumPy paths emit byte-identical output.
    """
    want_np = HAS_NUMPY if use_numpy is None else (bool(use_numpy) and HAS_NUMPY)
    (r00, r01, r02), (r10, r11, r12), (r20, r21, r22) = rot

    if want_np and _np is not None and verts_np is not None:
        count = int(verts_np.shape[0])
        pts = verts_np.reshape(-1, 3)
        x = pts[:, 0]
        y = pts[:, 1]
        z = pts[:, 2]
        rx = (x * r00 + y * r01) + z * r02
        ry = (x * r10 + y * r11) + z * r12
        rz = (x * r20 + y * r21) + z * r22

        min_x = float(rx.min())
        min_y = float(ry.min())
        min_z = float(rz.min())

        vx32 = (rx - min_x).astype("<f4")
        vy32 = (ry - min_y).astype("<f4")
        vz32 = (rz - min_z).astype("<f4")
        vx32 = _np.where(vx32 == 0, _np.float32(0.0), vx32)
        vy32 = _np.where(vy32 == 0, _np.float32(0.0), vy32)
        vz32 = _np.where(vz32 == 0, _np.float32(0.0), vz32)

        v_tri32 = _np.stack((vx32, vy32, vz32), axis=1).reshape(count, 3, 3)
        v_tri64 = v_tri32.astype(_np.float64)
        a = v_tri64[:, 0, :]
        b = v_tri64[:, 1, :]
        c = v_tri64[:, 2, :]
        ux = b[:, 0] - a[:, 0]
        uy = b[:, 1] - a[:, 1]
        uz = b[:, 2] - a[:, 2]
        vx = c[:, 0] - a[:, 0]
        vy = c[:, 1] - a[:, 1]
        vz = c[:, 2] - a[:, 2]

        nx = uy * vz - uz * vy
        ny = uz * vx - ux * vz
        nz = ux * vy - uy * vx
        nmag = _np.sqrt((nx * nx + ny * ny) + nz * nz)
        safe = nmag > 1e-12
        safe_mag = _np.where(safe, nmag, 1.0)
        nx32 = _np.where(safe, nx / safe_mag, 0.0).astype("<f4")
        ny32 = _np.where(safe, ny / safe_mag, 0.0).astype("<f4")
        nz32 = _np.where(safe, nz / safe_mag, 0.0).astype("<f4")
        nx32 = _np.where(nx32 == 0, _np.float32(0.0), nx32)
        ny32 = _np.where(ny32 == 0, _np.float32(0.0), ny32)
        nz32 = _np.where(nz32 == 0, _np.float32(0.0), nz32)

        out_dtype = _np.dtype([("n", "<f4", (3,)), ("v", "<f4", (9,)), ("attr", "<u2")])
        records = _np.zeros(count, dtype=out_dtype)
        records["n"][:, 0] = nx32
        records["n"][:, 1] = ny32
        records["n"][:, 2] = nz32
        records["v"] = v_tri32.reshape(count, 9)
        return BINARY_STL_HEADER + struct.pack("<I", count) + records.tobytes()

    if not raw_tris and verts_np is not None:
        raw_tris = [tuple(row) for row in verts_np.tolist()]

    count = len(raw_tris)
    rotated_coords: list[float] = []
    min_x = min_y = min_z = float("inf")
    for tri in raw_tris:
        for base in (0, 3, 6):
            x, y, z = tri[base], tri[base + 1], tri[base + 2]
            rx = (x * r00 + y * r01) + z * r02
            ry = (x * r10 + y * r11) + z * r12
            rz = (x * r20 + y * r21) + z * r22
            if rx < min_x:
                min_x = rx
            if ry < min_y:
                min_y = ry
            if rz < min_z:
                min_z = rz
            rotated_coords.extend((rx, ry, rz))

    buf = bytearray(84 + 50 * count)
    buf[:80] = BINARY_STL_HEADER
    struct.pack_into("<I", buf, 80, count)

    offset = 84
    for idx in range(count):
        cbase = idx * 9
        svals = []
        for j in range(0, 9, 3):
            sx = rotated_coords[cbase + j] - min_x
            sy = rotated_coords[cbase + j + 1] - min_y
            sz = rotated_coords[cbase + j + 2] - min_z
            svals.extend((0.0 if sx == 0.0 else sx, 0.0 if sy == 0.0 else sy, 0.0 if sz == 0.0 else sz))

        vbytes = struct.pack("<9f", *svals)
        qvals = struct.unpack("<9f", vbytes)
        qclean = tuple(0.0 if v == 0.0 else v for v in qvals)
        ax, ay, az, bx, by, bz, cx, cy, cz = qclean

        ux, uy, uz = bx - ax, by - ay, bz - az
        vx, vy, vz = cx - ax, cy - ay, cz - az
        nx = uy * vz - uz * vy
        ny = uz * vx - ux * vz
        nz = ux * vy - uy * vx
        nmag = math.sqrt((nx * nx + ny * ny) + nz * nz)
        if nmag > 1e-12:
            unx = nx / nmag
            uny = ny / nmag
            unz = nz / nmag
        else:
            unx = uny = unz = 0.0

        n_packed = struct.unpack(
            "<3f",
            struct.pack(
                "<3f",
                0.0 if unx == 0.0 else unx,
                0.0 if uny == 0.0 else uny,
                0.0 if unz == 0.0 else unz,
            ),
        )
        fnx, fny, fnz = (0.0 if v == 0.0 else v for v in n_packed)
        struct.pack_into("<12fH", buf, offset, fnx, fny, fnz, *qclean, 0)
        offset += 50

    return bytes(buf)


def rotate_stl_bytes(
    stl_bytes: bytes,
    rotation_matrix: list[list[float]] | tuple[tuple[float, float, float], ...],
    *,
    max_input_bytes: int = MAX_INPUT_BYTES,
    use_numpy: bool | None = None,
) -> bytes:
    """Validate `stl_bytes`, apply 3x3 proper rotation `rotation_matrix`, and emit binary STL bytes."""
    if not stl_bytes:
        raise PrintabilityError("input", "STL file is empty")
    if len(stl_bytes) > max_input_bytes:
        raise PrintabilityError("limits", f"STL exceeds {max_input_bytes} byte limit")
    if len(rotation_matrix) != 3 or any(len(row) != 3 for row in rotation_matrix):
        raise PrintabilityError("parameters", "rotation_matrix must be 3x3")
    rot = tuple(tuple(float(v) for v in row) for row in rotation_matrix)
    det = (
        rot[0][0] * (rot[1][1] * rot[2][2] - rot[1][2] * rot[2][1])
        - rot[0][1] * (rot[1][0] * rot[2][2] - rot[1][2] * rot[2][0])
        + rot[0][2] * (rot[1][0] * rot[2][1] - rot[1][1] * rot[2][0])
    )
    if abs(det - 1.0) > 1e-4:
        raise PrintabilityError("parameters", f"rotation_matrix must have determinant +1 (got {det:.6f})")

    mesh = _parse_and_build_facets(stl_bytes, use_numpy=use_numpy)
    _validate_orientable_mesh(mesh)
    raw_tris, verts_np = _extract_raw_tris(stl_bytes, use_numpy=use_numpy)
    return _pack_rotated_tris(raw_tris, verts_np, rot, use_numpy=use_numpy)


def _validate_orientable_mesh(mesh: dict[str, Any]) -> None:
    if mesh["format"] == "binary-stl" and not mesh["declaredUnitNormals"]:
        raise PrintabilityError(
            "topology",
            "Binary STL contains non-unit facet normals; orient requires valid outward normals.",
        )
    if mesh["degenerateFacetCount"] > 0:
        raise PrintabilityError(
            "topology",
            f"STL contains {mesh['degenerateFacetCount']} zero-area or collapsed degenerate facet(s); "
            "orient requires a clean watertight mesh.",
        )
    solid_count = count_solids(mesh)
    if solid_count > 1:
        raise PrintabilityError(
            "topology",
            f"File contains {solid_count} disconnected solids; orient requires a single watertight solid.",
        )
    if not mesh["watertight"]:
        raise PrintabilityError(
            "topology",
            f"Mesh is not a closed outward-wound watertight solid (unbalancedEdges={mesh['unbalancedEdgeCount']}, "
            f"boundaryEdges={mesh['boundaryEdgeCount']}, "
            f"nonManifoldSharedEdges={mesh['nonManifoldSharedEdgeCount']}).",
        )


def _flat_facet_cluster_normals(mesh: dict[str, Any]) -> list[tuple[tuple[float, float, float], float]]:
    """Cluster edge-connected coplanar facets on the mesh and return largest flat cluster normals."""
    facets = mesh["facets"]
    n_facets = len(facets)
    edge_to_facets: dict[tuple[tuple[int, int, int], tuple[int, int, int]], list[int]] = defaultdict(list)
    for idx, f in enumerate(facets):
        k0, k1, k2 = f[18], f[19], f[20]
        for u, v in ((k0, k1), (k1, k2), (k2, k0)):
            ek = (u, v) if u < v else (v, u)
            edge_to_facets[ek].append(idx)

    cos_2deg = math.cos(math.radians(2.0))
    visited = [False] * n_facets
    clusters: list[tuple[tuple[float, float, float], float]] = []

    seed_order = sorted(
        range(n_facets),
        key=lambda idx: (-_r(facets[idx][15]), _rvec((facets[idx][9], facets[idx][10], facets[idx][11])), idx),
    )

    for start in seed_order:
        if visited[start]:
            continue
        visited[start] = True
        snx, sny, snz = facets[start][9], facets[start][10], facets[start][11]
        queue: deque[int] = deque([start])
        members: list[int] = []
        area_terms: list[float] = []
        wx_terms: list[float] = []
        wy_terms: list[float] = []
        wz_terms: list[float] = []

        while queue:
            cur = queue.popleft()
            members.append(cur)
            cf = facets[cur]
            cnx, cny, cnz, carea = cf[9], cf[10], cf[11], cf[15]
            area_terms.append(carea)
            wx_terms.append(carea * cnx)
            wy_terms.append(carea * cny)
            wz_terms.append(carea * cnz)

            k0, k1, k2 = cf[18], cf[19], cf[20]
            for u, v in ((k0, k1), (k1, k2), (k2, k0)):
                ek = (u, v) if u < v else (v, u)
                for nb in edge_to_facets[ek]:
                    if visited[nb]:
                        continue
                    nf = facets[nb]
                    nnx, nny, nnz = nf[9], nf[10], nf[11]
                    if (
                        (cnx * nnx + cny * nny) + cnz * nnz >= cos_2deg
                        and (snx * nnx + sny * nny) + snz * nnz >= cos_2deg
                    ):
                        visited[nb] = True
                        queue.append(nb)

        total_area = math.fsum(area_terms)
        if total_area < MIN_BASE_AREA_MM2 * 0.5:
            continue
        unit = _normalize3(math.fsum(wx_terms), math.fsum(wy_terms), math.fsum(wz_terms))
        if unit is None:
            continue

        # Refine normal onto the outermost contact plane (within BASE_PLANE_TOLERANCE_MM)
        # so adjacent shallow bevel/fillet strips recessed inward cannot tilt a broad flat face.
        ux0, uy0, uz0 = unit
        max_proj = -float("inf")
        facet_min_proj: list[float] = []
        for midx in members:
            mf = facets[midx]
            ax, ay, az, dux, duy, duz, dvx, dvy, dvz = mf[:9]
            p0 = (ux0 * ax + uy0 * ay) + uz0 * az
            p1 = (ux0 * (ax + dux) + uy0 * (ay + duy)) + uz0 * (az + duz)
            p2 = (ux0 * (ax + dvx) + uy0 * (ay + dvy)) + uz0 * (az + dvz)
            hi = max(p0, p1, p2)
            if hi > max_proj:
                max_proj = hi
            facet_min_proj.append(min(p0, p1, p2))

        c_areas: list[float] = []
        c_wx: list[float] = []
        c_wy: list[float] = []
        c_wz: list[float] = []
        for midx, lo_p in zip(members, facet_min_proj):
            if max_proj - lo_p <= BASE_PLANE_TOLERANCE_MM:
                mf = facets[midx]
                marea = mf[15]
                c_areas.append(marea)
                c_wx.append(marea * mf[9])
                c_wy.append(marea * mf[10])
                c_wz.append(marea * mf[11])
        contact_area = math.fsum(c_areas)
        if contact_area >= MIN_BASE_AREA_MM2 * 0.5:
            refined = _normalize3(math.fsum(c_wx), math.fsum(c_wy), math.fsum(c_wz))
            if refined is not None:
                unit = refined

        clusters.append((unit, total_area))

    clusters.sort(key=lambda item: (-_r(item[1]), _rvec(item[0])))
    return clusters[:MAX_FLAT_CLUSTER_CANDIDATES]


def _thin_hull_vertices(pts: list[tuple[float, float, float]]) -> list[tuple[float, float, float]]:
    """Deterministically retain extremal support vertices when high-poly meshes exceed MAX_HULL_INPUT_VERTICES."""
    if len(pts) <= MAX_HULL_INPUT_VERTICES:
        return pts

    dirs: list[tuple[float, float, float]] = [
        (1.0, 0.0, 0.0), (-1.0, 0.0, 0.0),
        (0.0, 1.0, 0.0), (0.0, -1.0, 0.0),
        (0.0, 0.0, 1.0), (0.0, 0.0, -1.0),
    ]
    golden = math.pi * (3.0 - math.sqrt(5.0))
    n_fib = 320
    for i in range(n_fib):
        z = 1.0 - (2.0 * (i + 0.5)) / n_fib
        rad = math.sqrt(max(0.0, 1.0 - z * z))
        phi = golden * i
        dirs.append((rad * math.cos(phi), rad * math.sin(phi), z))

    chosen_indices: set[int] = set()
    for dx, dy, dz in dirs:
        best_idx = 0
        best_proj = -float("inf")
        for idx, (px, py, pz) in enumerate(pts):
            proj = (px * dx + py * dy) + pz * dz
            if proj > best_proj:
                best_proj = proj
                best_idx = idx
        chosen_indices.add(best_idx)

    # Retain local per-column coordinate min/max vertices across all 3 axis projections
    # so broad flat or slightly tilted faces on rounded high-poly scans keep full support coverage.
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    zs = [p[2] for p in pts]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    z0, z1 = min(zs), max(zs)
    sx = max(x1 - x0, 1e-6)
    sy = max(y1 - y0, 1e-6)
    sz = max(z1 - z0, 1e-6)
    xy_z_ext: dict[tuple[int, int], list[int]] = {}
    yz_x_ext: dict[tuple[int, int], list[int]] = {}
    xz_y_ext: dict[tuple[int, int], list[int]] = {}
    for idx, (px, py, pz) in enumerate(pts):
        ix = min(7, int(8.0 * (px - x0) / sx))
        iy = min(7, int(8.0 * (py - y0) / sy))
        iz = min(7, int(8.0 * (pz - z0) / sz))

        ez = xy_z_ext.get((ix, iy))
        if ez is None:
            xy_z_ext[(ix, iy)] = [idx, idx]
        else:
            if pz < pts[ez[0]][2]:
                ez[0] = idx
            if pz > pts[ez[1]][2]:
                ez[1] = idx

        ex = yz_x_ext.get((iy, iz))
        if ex is None:
            yz_x_ext[(iy, iz)] = [idx, idx]
        else:
            if px < pts[ex[0]][0]:
                ex[0] = idx
            if px > pts[ex[1]][0]:
                ex[1] = idx

        ey = xz_y_ext.get((ix, iz))
        if ey is None:
            xz_y_ext[(ix, iz)] = [idx, idx]
        else:
            if py < pts[ey[0]][1]:
                ey[0] = idx
            if py > pts[ey[1]][1]:
                ey[1] = idx

    for col_map in (xy_z_ext, yz_x_ext, xz_y_ext):
        for lo_idx, hi_idx in col_map.values():
            chosen_indices.add(lo_idx)
            chosen_indices.add(hi_idx)

    return [pts[i] for i in sorted(chosen_indices)]


def _convex_hull_3d_normals(mesh: dict[str, Any]) -> list[tuple[tuple[float, float, float], float]]:
    """Compute 3D convex hull via deterministic Quickhull and return merged outward face normals."""
    unique_by_key: dict[tuple[int, int, int], tuple[float, float, float]] = {}
    for f in mesh["facets"]:
        ax, ay, az, ux, uy, uz, vx, vy, vz, k0, k1, k2 = (
            f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8], f[18], f[19], f[20]
        )
        if k0 not in unique_by_key:
            unique_by_key[k0] = (ax, ay, az)
        if k1 not in unique_by_key:
            unique_by_key[k1] = (ax + ux, ay + uy, az + uz)
        if k2 not in unique_by_key:
            unique_by_key[k2] = (ax + vx, ay + vy, az + vz)

    pts = _thin_hull_vertices(sorted(unique_by_key.values()))
    if len(pts) < 4:
        return []

    scale = max(mesh["extentsMm"])
    if scale <= 1e-9:
        return []
    eps = max(1e-5, 1e-5 * scale)
    vis_eps = max(1e-9, 1e-9 * scale)

    # Initial non-degenerate tetrahedron (i0, i1, i2, i3)
    i0 = 0
    x0, y0, z0 = pts[i0]
    i1 = max(
        range(1, len(pts)),
        key=lambda i: (((pts[i][0] - x0) ** 2 + (pts[i][1] - y0) ** 2 + (pts[i][2] - z0) ** 2), -i),
    )
    x1, y1, z1 = pts[i1]
    e01x, e01y, e01z = x1 - x0, y1 - y0, z1 - z0
    e01_len = math.sqrt((e01x * e01x + e01y * e01y) + e01z * e01z)
    if e01_len <= eps:
        return []
    d01x, d01y, d01z = e01x / e01_len, e01y / e01_len, e01z / e01_len

    def line_dist(idx: int) -> tuple[float, int]:
        px, py, pz = pts[idx][0] - x0, pts[idx][1] - y0, pts[idx][2] - z0
        cx = py * d01z - pz * d01y
        cy = pz * d01x - px * d01z
        cz = px * d01y - py * d01x
        return (math.sqrt((cx * cx + cy * cy) + cz * cz), -idx)

    i2 = max((i for i in range(len(pts)) if i not in (i0, i1)), key=line_dist)
    if line_dist(i2)[0] <= eps:
        return []

    x2, y2, z2 = pts[i2]
    u2x, u2y, u2z = x2 - x0, y2 - y0, z2 - z0
    pn_raw = _normalize3(
        e01y * u2z - e01z * u2y,
        e01z * u2x - e01x * u2z,
        e01x * u2y - e01y * u2x,
    )
    if pn_raw is None:
        return []
    pnx, pny, pnz = pn_raw
    pd0 = (pnx * x0 + pny * y0) + pnz * z0

    i3 = max(
        (i for i in range(len(pts)) if i not in (i0, i1, i2)),
        key=lambda i: (abs((pnx * pts[i][0] + pny * pts[i][1]) + pnz * pts[i][2] - pd0), -i),
    )
    if abs((pnx * pts[i3][0] + pny * pts[i3][1]) + pnz * pts[i3][2] - pd0) <= eps:
        return []

    x3, y3, z3 = pts[i3]
    interior = (0.25 * (x0 + x1 + x2 + x3), 0.25 * (y0 + y1 + y2 + y3), 0.25 * (z0 + z1 + z2 + z3))

    def make_outward_face(a: int, b: int, c: int) -> tuple[int, int, int, float, float, float, float, float] | None:
        pa, pb, pc = pts[a], pts[b], pts[c]
        ux, uy, uz = pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]
        vx, vy, vz = pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]
        cx = uy * vz - uz * vy
        cy = uz * vx - ux * vz
        cz = ux * vy - uy * vx
        area2 = math.sqrt((cx * cx + cy * cy) + cz * cz)
        if area2 <= 1e-11:
            return None
        nx, ny, nz = cx / area2, cy / area2, cz / area2
        orient_dot = (nx * (pa[0] - interior[0]) + ny * (pa[1] - interior[1])) + nz * (pa[2] - interior[2])
        if orient_dot < 0.0:
            b, c = c, b
            nx, ny, nz = -nx, -ny, -nz
            orient_dot = -orient_dot
        if orient_dot <= vis_eps:
            return None
        off = (nx * pa[0] + ny * pa[1]) + nz * pa[2]
        return (a, b, c, nx, ny, nz, off, 0.5 * area2)

    faces: dict[int, tuple[int, int, int, float, float, float, float, float]] = {}
    conflicts: dict[int, list[int]] = {}
    edge_owner: dict[tuple[int, int], int] = {}
    next_fid = 0

    def add_face(rec: tuple[int, int, int, float, float, float, float, float]) -> int:
        nonlocal next_fid
        fid = next_fid
        next_fid += 1
        faces[fid] = rec
        conflicts[fid] = []
        a, b, c = rec[0], rec[1], rec[2]
        edge_owner[(a, b)] = fid
        edge_owner[(b, c)] = fid
        edge_owner[(c, a)] = fid
        return fid

    def remove_face(fid: int) -> None:
        rec = faces.pop(fid)
        conflicts.pop(fid, None)
        a, b, c = rec[0], rec[1], rec[2]
        for e in ((a, b), (b, c), (c, a)):
            if edge_owner.get(e) == fid:
                del edge_owner[e]

    for ta, tb, tc in ((i0, i1, i2), (i0, i2, i3), (i0, i3, i1), (i1, i3, i2)):
        rec = make_outward_face(ta, tb, tc)
        if rec is None:
            return []
        add_face(rec)

    initial_set = {i0, i1, i2, i3}
    for pidx, (px, py, pz) in enumerate(pts):
        if pidx in initial_set:
            continue
        best_fid = -1
        best_d = eps
        for fid, rec in faces.items():
            d = (rec[3] * px + rec[4] * py) + rec[5] * pz - rec[6]
            if d > best_d:
                best_d = d
                best_fid = fid
        if best_fid >= 0:
            conflicts[best_fid].append(pidx)

    processed_eyes: set[int] = set(initial_set)
    while True:
        seed_fid = -1
        eye_idx = -1
        best_dist = eps
        for fid in sorted(faces):
            c_list = conflicts[fid]
            if not c_list:
                continue
            rec = faces[fid]
            nx, ny, nz, off = rec[3], rec[4], rec[5], rec[6]
            for pidx in c_list:
                if pidx in processed_eyes:
                    continue
                px, py, pz = pts[pidx]
                d = (nx * px + ny * py) + nz * pz - off
                if d > best_dist or (abs(d - best_dist) <= 1e-12 and (eye_idx < 0 or pidx < eye_idx)):
                    best_dist = d
                    seed_fid = fid
                    eye_idx = pidx
        if seed_fid < 0 or eye_idx < 0:
            break
        processed_eyes.add(eye_idx)
        ex, ey, ez = pts[eye_idx]

        # Connected BFS visibility from seed_fid
        visible: set[int] = {seed_fid}
        queue: deque[int] = deque([seed_fid])
        while queue:
            cur = queue.popleft()
            ca, cb, cc = faces[cur][:3]
            for u, v in ((ca, cb), (cb, cc), (cc, ca)):
                nb = edge_owner.get((v, u))
                if nb is not None and nb not in visible and nb in faces:
                    nrec = faces[nb]
                    nd = (nrec[3] * ex + nrec[4] * ey) + nrec[5] * ez - nrec[6]
                    if nd > vis_eps:
                        visible.add(nb)
                        queue.append(nb)

        horizon: list[tuple[int, int]] = []
        out_deg: dict[int, int] = defaultdict(int)
        in_deg: dict[int, int] = defaultdict(int)
        for vfid in sorted(visible):
            va, vb, vc = faces[vfid][:3]
            for u, v in ((va, vb), (vb, vc), (vc, va)):
                nb = edge_owner.get((v, u))
                if nb is None or nb not in visible:
                    horizon.append((u, v))
                    out_deg[u] += 1
                    in_deg[v] += 1

        if (
            len(horizon) < 3
            or any(deg != 1 for deg in out_deg.values())
            or any(deg != 1 for deg in in_deg.values())
            or set(out_deg) != set(in_deg)
        ):
            continue

        new_recs: list[tuple[int, int, int, float, float, float, float, float]] = []
        valid_cone = True
        for u, v in horizon:
            nrec = make_outward_face(u, v, eye_idx)
            if nrec is None or (nrec[0], nrec[1], nrec[2]) != (u, v, eye_idx):
                valid_cone = False
                break
            new_recs.append(nrec)
        if not valid_cone:
            continue

        orphans: list[int] = []
        for vfid in visible:
            orphans.extend(p for p in conflicts[vfid] if p not in processed_eyes)
            remove_face(vfid)

        new_fids = [add_face(nrec) for nrec in new_recs]
        for pidx in orphans:
            px, py, pz = pts[pidx]
            best_nfid = -1
            best_nd = eps
            for nfid in new_fids:
                nrec = faces[nfid]
                nd = (nrec[3] * px + nrec[4] * py) + nrec[5] * pz - nrec[6]
                if nd > best_nd:
                    best_nd = nd
                    best_nfid = nfid
            if best_nfid >= 0:
                conflicts[best_nfid].append(pidx)

    # Merge hull triangles only when they are coplanar within half the base-plane tolerance,
    # preventing shallow fillet/bevel hull triangles from skewing a flat support plane normal.
    cos_1p5 = math.cos(math.radians(1.5))
    coplanar_tol = 0.5 * BASE_PLANE_TOLERANCE_MM
    merged_hull: list[list[float]] = []  # [area, wx, wy, wz, ux, uy, uz, seed_off]
    ordered_faces = sorted(
        faces.values(),
        key=lambda rec: (-round(rec[7], 6), _rvec((rec[3], rec[4], rec[5]))),
    )
    for rec in ordered_faces:
        va_idx, vb_idx, vc_idx, nx, ny, nz, off, area = rec
        pa, pb, pc = pts[va_idx], pts[vb_idx], pts[vc_idx]
        placed = False
        for mh in merged_hull:
            mux, muy, muz, moff = mh[4], mh[5], mh[6], mh[7]
            if (mux * nx + muy * ny) + muz * nz >= cos_1p5:
                d_a = abs(((mux * pa[0] + muy * pa[1]) + muz * pa[2]) - moff)
                d_b = abs(((mux * pb[0] + muy * pb[1]) + muz * pb[2]) - moff)
                d_c = abs(((mux * pc[0] + muy * pc[1]) + muz * pc[2]) - moff)
                if d_a <= coplanar_tol and d_b <= coplanar_tol and d_c <= coplanar_tol:
                    mh[0] += area
                    mh[1] += area * nx
                    mh[2] += area * ny
                    mh[3] += area * nz
                    nu = _normalize3(mh[1], mh[2], mh[3])
                    if nu is not None:
                        mh[4], mh[5], mh[6] = nu
                    placed = True
                    break
        if not placed:
            merged_hull.append([area, area * nx, area * ny, area * nz, nx, ny, nz, off])

    hull_candidates = [
        ((mh[4], mh[5], mh[6]), mh[0])
        for mh in merged_hull
        if mh[0] >= 1.0
    ]
    hull_candidates.sort(key=lambda item: (-_r(item[1]), _rvec(item[0])))
    return hull_candidates[:MAX_CONVEX_HULL_CANDIDATES]


def _base_contact_facet_indices(rot_mesh: dict[str, Any]) -> frozenset[int]:
    """Return exact facet indices qualifying as build-plate contact in `evaluate_base_stability`."""
    z_min = rot_mesh["boundsMm"]["min"][2]
    cos5 = math.cos(math.radians(5.0))
    indices: list[int] = []
    for idx, f in enumerate(rot_mesh["facets"]):
        if f[17] <= z_min + BASE_PLANE_TOLERANCE_MM and f[11] <= -cos5:
            indices.append(idx)
    return frozenset(indices)


def _probe_candidate_normal(
    down_normal: tuple[float, float, float],
    raw_tris: list[tuple[float, ...]],
    verts_np: Any,
    *,
    profile: dict[str, Any] | None = None,
    overhang_threshold_deg: float = DEFAULT_OVERHANG_THRESHOLD_DEG,
    use_numpy: bool | None = None,
) -> dict[str, Any]:
    rot_base_raw = rotation_mapping_down_normal(down_normal)
    rot_base = tuple(tuple(_r(v, 9) for v in row) for row in rot_base_raw)
    rot_bytes = _pack_rotated_tris(raw_tris, verts_np, rot_base, use_numpy=use_numpy)
    rot_mesh = _parse_and_build_facets(rot_bytes, use_numpy=use_numpy)
    bed_fit = evaluate_bed_fit(rot_mesh, profile) if profile is not None else None
    base_facets = _base_contact_facet_indices(rot_mesh)
    base_stability = evaluate_base_stability(rot_mesh)
    overhangs = evaluate_overhangs(rot_mesh, threshold_deg=overhang_threshold_deg)
    return {
        "rotBaseRaw": rot_base_raw,
        "rotBase": rot_base,
        "rotBytes": rot_bytes,
        "rotMesh": rot_mesh,
        "bedFit": bed_fit,
        "baseFacetIndices": base_facets,
        "baseStability": base_stability,
        "overhangs": overhangs,
    }


def _collapsing_preserves_base_contact(
    existing_normal: tuple[float, float, float],
    existing_probe: dict[str, Any],
    new_normal: tuple[float, float, float],
    new_probe: dict[str, Any],
) -> bool:
    """Return True iff collapsing `new_normal` onto `existing_normal` provably preserves base contact."""
    if existing_normal == new_normal:
        return True

    dot = (
        existing_normal[0] * new_normal[0]
        + existing_normal[1] * new_normal[1]
    ) + existing_normal[2] * new_normal[2]
    # Necessary same-face sanity guard (base facets themselves must be within 5 deg of -Z);
    # never sufficient without re-evaluating base contact on the collapsed normal below.
    if dot < math.cos(math.radians(5.0)):
        return False

    new_facets: frozenset[int] = new_probe["baseFacetIndices"]
    ex_facets: frozenset[int] = existing_probe["baseFacetIndices"]
    if not new_facets:
        return (not ex_facets) and (dot >= 1.0 - 1e-12)
    if ex_facets != new_facets:
        return False

    ex_stab = existing_probe["baseStability"]
    new_stab = new_probe["baseStability"]
    if bool(ex_stab["hasFlatBase"]) != bool(new_stab["hasFlatBase"]):
        return False
    if bool(ex_stab["isStable"]) != bool(new_stab["isStable"]):
        return False
    if abs(float(ex_stab["flatBaseAreaMm2"]) - float(new_stab["flatBaseAreaMm2"])) > 1e-3:
        return False
    if float(ex_stab["supportHullAreaMm2"]) + 1e-2 < float(new_stab["supportHullAreaMm2"]):
        return False
    if float(ex_stab["comSupportMarginMm"]) + 1e-2 < float(new_stab["comSupportMarginMm"]):
        return False
    if float(ex_stab["minTipAngleDeg"]) + 0.05 < float(new_stab["minTipAngleDeg"]):
        return False

    ex_oh = existing_probe["overhangs"]
    new_oh = new_probe["overhangs"]
    if bool(ex_oh["requiresSupports"]) and not bool(new_oh["requiresSupports"]):
        return False
    if float(ex_oh["overhangAreaMm2"]) > float(new_oh["overhangAreaMm2"]) + 1e-2:
        return False

    ex_fit = existing_probe["bedFit"]
    new_fit = new_probe["bedFit"]
    if ex_fit is not None and new_fit is not None:
        ex_ok = bool(ex_fit["fits"] and existing_probe["rotMesh"]["watertight"])
        new_ok = bool(new_fit["fits"] and new_probe["rotMesh"]["watertight"])
        if new_ok and not ex_ok:
            return False

    return True


def generate_candidate_normals(
    mesh: dict[str, Any],
    *,
    profile: dict[str, Any] | None = None,
    overhang_threshold_deg: float = DEFAULT_OVERHANG_THRESHOLD_DEG,
    raw_tris: list[tuple[float, ...]] | None = None,
    verts_np: Any = None,
    use_numpy: bool | None = None,
    _keep_probes: bool = False,
) -> list[dict[str, Any]]:
    """Collect candidate downward normals from axis-aligned, flat-cluster, and convex-hull sources.

    Near-axis or near-collinear normals are collapsed onto an existing candidate
    only when re-evaluating the rotated mesh proves that the collapsed normal
    preserves exact base-contact facet membership, stability, bed fit, and
    support status — never via a fixed angular tolerance alone.
    """
    cos_same_face = math.cos(math.radians(5.0))
    if raw_tris is None and verts_np is None:
        raw_tris = [
            (
                f[0], f[1], f[2],
                f[0] + f[3], f[1] + f[4], f[2] + f[5],
                f[0] + f[6], f[1] + f[7], f[2] + f[8],
            )
            for f in mesh["facets"]
        ]
    tris_list = raw_tris if raw_tris is not None else []

    def get_probe(cand_dict: dict[str, Any]) -> dict[str, Any]:
        probe = cand_dict.get("_probe")
        if probe is None:
            probe = _probe_candidate_normal(
                cand_dict["downNormal"],
                tris_list,
                verts_np,
                profile=profile,
                overhang_threshold_deg=overhang_threshold_deg,
                use_numpy=use_numpy,
            )
            cand_dict["_probe"] = probe
        return probe

    candidates: list[dict[str, Any]] = []
    for axis_rank, (cid, normal) in enumerate(AXIS_ALIGNED_CANDIDATES):
        candidates.append({
            "candidateId": cid,
            "downNormal": normal,
            "axisOrderRank": axis_rank,
            "sources": ["axis-aligned"],
        })

    def merge_or_append(normal: tuple[float, float, float], source_name: str, prefix: str, counter: int) -> int:
        new_probe: dict[str, Any] | None = None
        for existing in candidates:
            en = existing["downNormal"]
            if en == normal:
                if source_name not in existing["sources"]:
                    existing["sources"].append(source_name)
                return counter
            if (en[0] * normal[0] + en[1] * normal[1]) + en[2] * normal[2] < cos_same_face:
                continue
            if new_probe is None:
                new_probe = _probe_candidate_normal(
                    normal,
                    tris_list,
                    verts_np,
                    profile=profile,
                    overhang_threshold_deg=overhang_threshold_deg,
                    use_numpy=use_numpy,
                )
            if _collapsing_preserves_base_contact(en, get_probe(existing), normal, new_probe):
                if source_name not in existing["sources"]:
                    existing["sources"].append(source_name)
                return counter

        counter += 1
        entry: dict[str, Any] = {
            "candidateId": f"{prefix}:{counter}",
            "downNormal": normal,
            "axisOrderRank": 6,
            "sources": [source_name],
        }
        if new_probe is not None:
            entry["_probe"] = new_probe
        candidates.append(entry)
        return counter

    cluster_idx = 0
    for normal, _area in _flat_facet_cluster_normals(mesh):
        cluster_idx = merge_or_append(normal, "flat-facet-cluster", "cluster", cluster_idx)

    hull_idx = 0
    for normal, _area in _convex_hull_3d_normals(mesh):
        hull_idx = merge_or_append(normal, "convex-hull", "hull", hull_idx)

    for cand in candidates:
        cand["sources"] = sorted(cand["sources"])
        if not _keep_probes:
            cand.pop("_probe", None)
    return candidates


def _score_candidate(
    *,
    rot_mesh: dict[str, Any],
    bed_fit: dict[str, Any],
    base_stability: dict[str, Any],
    overhangs: dict[str, Any],
    ref_surface_area_mm2: float,
) -> tuple[float, dict[str, Any]]:
    """Compute deterministic composite score in [0, 100] from bed fit, stability/base, overhang, and height."""
    fits_bed = bool(bed_fit["fits"] and rot_mesh["watertight"])
    has_flat_base = bool(base_stability["hasFlatBase"])
    is_stable = bool(base_stability["isStable"] and rot_mesh["watertight"])
    requires_supports = bool(overhangs["requiresSupports"])

    flat_area = float(base_stability["flatBaseAreaMm2"])
    hull_area = float(base_stability["supportHullAreaMm2"])
    tip_deg = float(base_stability["minTipAngleDeg"])
    overhang_pct = float(overhangs["overhangAreaPercent"])
    dx, dy, dz = rot_mesh["extentsMm"]

    ref_face_area = max(ref_surface_area_mm2 / 6.0, 1e-6)
    char_len = math.sqrt(ref_face_area)

    flat_ratio = flat_area / ref_face_area
    hull_ratio = hull_area / ref_face_area
    sub_base = 0.65 * (flat_ratio / (flat_ratio + 0.5)) + 0.35 * (hull_ratio / (hull_ratio + 0.5))
    sub_height = 1.0 / (1.0 + 0.5 * (dz / max(char_len, 1e-6)))
    sub_overhang_general = 1.0 / (1.0 + overhang_pct / 10.0)

    if fits_bed and is_stable and not requires_supports:
        tier = "printable"
        sub_overhang_clean = max(0.0, 1.0 - overhang_pct / 2.0)
        sub_tip = max(0.0, min(1.0, (tip_deg - 10.0) / 65.0))
        c_overhang = 6.0 * sub_overhang_clean
        c_stability = 6.0 * sub_tip
        c_base = 6.0 * sub_base
        c_height = 12.0 * sub_height
        total = 70.0 + c_overhang + c_stability + c_base + c_height
    elif fits_bed and is_stable and requires_supports:
        tier = "printable-with-supports"
        sub_tip = max(0.0, min(1.0, (tip_deg - 10.0) / 65.0))
        c_overhang = 14.0 * sub_overhang_general
        c_stability = 5.0 * sub_tip
        c_base = 5.0 * sub_base
        c_height = 5.9 * sub_height
        total = 40.0 + c_overhang + c_stability + c_base + c_height
    elif fits_bed and not is_stable:
        tier = "unstable-or-missing-flat-base"
        sub_tip_u = max(0.0, min(1.0, tip_deg / 10.0)) * (0.8 if has_flat_base else 0.1)
        c_overhang = 7.0 * sub_overhang_general
        c_stability = 8.0 * sub_tip_u
        c_base = 10.0 * sub_base
        c_height = 4.9 * sub_height
        total = 10.0 + c_overhang + c_stability + c_base + c_height
    else:
        tier = "exceeds-bed"
        bx = max(float(bed_fit["bedMm"]["x"]), 1e-6)
        by = max(float(bed_fit["bedMm"]["y"]), 1e-6)
        bz = max(float(bed_fit["bedMm"]["z"]), 1e-6)
        excess = max(0.0, dx / bx - 1.0) + max(0.0, dy / by - 1.0) + max(0.0, dz / bz - 1.0)
        fit_factor = 1.0 / (1.0 + excess)
        c_overhang = 3.0 * fit_factor * sub_overhang_general
        c_stability = 2.0 * fit_factor * (1.0 if is_stable else 0.2)
        c_base = 2.9 * fit_factor * sub_base
        c_height = 2.0 * fit_factor * sub_height
        total = c_overhang + c_stability + c_base + c_height

    score = _r(total)
    breakdown = {
        "tier": tier,
        "fitsBed": fits_bed,
        "isStable": is_stable,
        "requiresSupports": requires_supports,
        "overhangComponent": _r(c_overhang),
        "stabilityComponent": _r(c_stability),
        "baseAreaComponent": _r(c_base),
        "heightComponent": _r(c_height),
    }
    return score, breakdown


def orient_stl(
    stl_path: Path,
    profile: dict[str, Any],
    *,
    overhang_threshold_deg: float = DEFAULT_OVERHANG_THRESHOLD_DEG,
    max_input_bytes: int = MAX_INPUT_BYTES,
    stl_bytes: bytes | None = None,
    use_numpy: bool | None = None,
) -> dict[str, Any]:
    """Evaluate candidate orientations for a watertight STL and return ranked deterministic scores."""
    if not (0.0 < overhang_threshold_deg < 90.0):
        raise PrintabilityError("parameters", "overhang threshold_deg must be in (0, 90)")

    path = Path(stl_path)
    data = read_stl_bounded(path, max_input_bytes) if stl_bytes is None else stl_bytes
    if not data:
        raise PrintabilityError("input", "STL file is empty")
    if len(data) > max_input_bytes:
        raise PrintabilityError("limits", f"STL exceeds {max_input_bytes} byte limit")

    sha256 = hashlib.sha256(data).hexdigest()
    mesh = _parse_and_build_facets(data, use_numpy=use_numpy)
    _validate_orientable_mesh(mesh)
    raw_tris, verts_np = _extract_raw_tris(data, use_numpy=use_numpy)

    ref_surface_area = float(mesh["surfaceAreaMm2"])
    raw_candidates = generate_candidate_normals(
        mesh,
        profile=profile,
        overhang_threshold_deg=overhang_threshold_deg,
        raw_tris=raw_tris,
        verts_np=verts_np,
        use_numpy=use_numpy,
        _keep_probes=True,
    )

    evaluated: list[dict[str, Any]] = []
    baseline_entry: dict[str, Any] | None = None

    for cand in raw_candidates:
        down_normal: tuple[float, float, float] = cand["downNormal"]
        cached_probe = cand.pop("_probe", None)
        if cached_probe is not None:
            rot_base_raw = cached_probe["rotBaseRaw"]
            rot_base = cached_probe["rotBase"]
            rot_bytes = cached_probe["rotBytes"]
            rot_mesh = cached_probe["rotMesh"]
            bed_fit = cached_probe["bedFit"] if cached_probe["bedFit"] is not None else evaluate_bed_fit(rot_mesh, profile)
            base_stability = cached_probe["baseStability"]
            overhangs = cached_probe["overhangs"]
        else:
            rot_base_raw = rotation_mapping_down_normal(down_normal)
            rot_base = tuple(tuple(_r(v, 9) for v in row) for row in rot_base_raw)
            rot_bytes = _pack_rotated_tris(raw_tris, verts_np, rot_base, use_numpy=use_numpy)
            rot_mesh = _parse_and_build_facets(rot_bytes, use_numpy=use_numpy)
            bed_fit = evaluate_bed_fit(rot_mesh, profile)
            base_stability = evaluate_base_stability(rot_mesh)
            overhangs = evaluate_overhangs(rot_mesh, threshold_deg=overhang_threshold_deg)

        z_yaw_deg = 0
        final_rot = rot_base
        if bed_fit["fits"] and bed_fit["requiresZRotation90"]:
            z_yaw_deg = 90
            final_rot_raw = _matmul3(_R_Z90, rot_base_raw)
            final_rot = tuple(tuple(_r(v, 9) for v in row) for row in final_rot_raw)
            rot_bytes = _pack_rotated_tris(raw_tris, verts_np, final_rot, use_numpy=use_numpy)
            rot_mesh = _parse_and_build_facets(rot_bytes, use_numpy=use_numpy)
            bed_fit = evaluate_bed_fit(rot_mesh, profile)
            base_stability = evaluate_base_stability(rot_mesh)
            overhangs = evaluate_overhangs(rot_mesh, threshold_deg=overhang_threshold_deg)

        score, breakdown = _score_candidate(
            rot_mesh=rot_mesh,
            bed_fit=bed_fit,
            base_stability=base_stability,
            overhangs=overhangs,
            ref_surface_area_mm2=ref_surface_area,
        )

        axis_vec, angle_deg = axis_angle_from_matrix(final_rot)
        is_identity = (down_normal == (0.0, 0.0, -1.0)) and (z_yaw_deg == 0)
        cid = cand["candidateId"] if z_yaw_deg == 0 else f"{cand['candidateId']}+z90"

        entry = {
            "candidateId": cid,
            "applied": not is_identity,
            "isIdentity": is_identity,
            "sources": cand["sources"],
            "downNormal": _rvec(down_normal),
            "zYawDeg": z_yaw_deg,
            "rotationMatrix": [list(row) for row in final_rot],
            "_axisOrderRank": cand["axisOrderRank"],
            "axis": _rvec(axis_vec),
            "angleDeg": _r(angle_deg),
            "score": score,
            "scoreBreakdown": breakdown,
            "metrics": {
                "fitsBed": bool(bed_fit["fits"] and rot_mesh["watertight"]),
                "fitsHeight": bool(bed_fit["fitsHeight"]),
                "fitsFootprint": bool(bed_fit["fitsFootprint"]),
                "blockedByExcludeZone": bool(bed_fit["blockedByExcludeZone"]),
                "partExtentsMm": bed_fit["partExtentsMm"],
                "heightMm": _r(rot_mesh["extentsMm"][2]),
                "hasFlatBase": bool(base_stability["hasFlatBase"]),
                "isStable": bool(base_stability["isStable"] and rot_mesh["watertight"]),
                "flatBaseAreaMm2": base_stability["flatBaseAreaMm2"],
                "supportHullAreaMm2": base_stability["supportHullAreaMm2"],
                "minTipAngleDeg": base_stability["minTipAngleDeg"],
                "comSupportMarginMm": base_stability["comSupportMarginMm"],
                "requiresSupports": bool(overhangs["requiresSupports"]),
                "overhangAreaMm2": overhangs["overhangAreaMm2"],
                "overhangAreaPercent": overhangs["overhangAreaPercent"],
                "maxOverhangDeg": overhangs["maxOverhangDeg"],
            },
        }
        evaluated.append(entry)
        if down_normal == (0.0, 0.0, -1.0):
            if z_yaw_deg == 0:
                baseline_entry = dict(entry)
            else:
                base0_bytes = _pack_rotated_tris(raw_tris, verts_np, rot_base, use_numpy=use_numpy)
                base0_mesh = _parse_and_build_facets(base0_bytes, use_numpy=use_numpy)
                base0_fit = evaluate_bed_fit(base0_mesh, profile)
                base0_stab = evaluate_base_stability(base0_mesh)
                base0_oh = evaluate_overhangs(base0_mesh, threshold_deg=overhang_threshold_deg)
                base0_score, base0_bd = _score_candidate(
                    rot_mesh=base0_mesh,
                    bed_fit=base0_fit,
                    base_stability=base0_stab,
                    overhangs=base0_oh,
                    ref_surface_area_mm2=ref_surface_area,
                )
                baseline_entry = {
                    "candidateId": "axis:-z",
                    "applied": False,
                    "isIdentity": True,
                    "sources": cand["sources"],
                    "downNormal": [0.0, 0.0, -1.0],
                    "zYawDeg": 0,
                    "rotationMatrix": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                    "axis": [0.0, 0.0, 1.0],
                    "angleDeg": 0.0,
                    "score": base0_score,
                    "scoreBreakdown": base0_bd,
                    "metrics": {
                        "fitsBed": bool(base0_fit["fits"] and base0_mesh["watertight"]),
                        "fitsHeight": bool(base0_fit["fitsHeight"]),
                        "fitsFootprint": bool(base0_fit["fitsFootprint"]),
                        "blockedByExcludeZone": bool(base0_fit["blockedByExcludeZone"]),
                        "partExtentsMm": base0_fit["partExtentsMm"],
                        "heightMm": _r(base0_mesh["extentsMm"][2]),
                        "hasFlatBase": bool(base0_stab["hasFlatBase"]),
                        "isStable": bool(base0_stab["isStable"] and base0_mesh["watertight"]),
                        "flatBaseAreaMm2": base0_stab["flatBaseAreaMm2"],
                        "supportHullAreaMm2": base0_stab["supportHullAreaMm2"],
                        "minTipAngleDeg": base0_stab["minTipAngleDeg"],
                        "comSupportMarginMm": base0_stab["comSupportMarginMm"],
                        "requiresSupports": bool(base0_oh["requiresSupports"]),
                        "overhangAreaMm2": base0_oh["overhangAreaMm2"],
                        "overhangAreaPercent": base0_oh["overhangAreaPercent"],
                        "maxOverhangDeg": base0_oh["maxOverhangDeg"],
                    },
                }

    evaluated.sort(
        key=lambda item: (
            -item["score"],
            not item["isIdentity"],
            item["_axisOrderRank"],
            item["zYawDeg"],
            item["metrics"]["overhangAreaMm2"],
            -item["metrics"]["flatBaseAreaMm2"],
            item["metrics"]["heightMm"],
            item["angleDeg"],
            item["downNormal"],
        )
    )

    ranked_candidates: list[dict[str, Any]] = []
    for rank_idx, item in enumerate(evaluated, start=1):
        item.pop("_axisOrderRank")
        ranked_candidates.append({"rank": rank_idx, **item})

    assert baseline_entry is not None
    baseline_entry.pop("_axisOrderRank", None)

    selected = dict(ranked_candidates[0])
    return {
        "schema": ORIENTATION_SCHEMA,
        "dispatchAuthorized": False,
        "printerContacted": False,
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
        "selected": selected,
        "baseline": baseline_entry,
        "candidateCount": len(ranked_candidates),
        "candidates": ranked_candidates,
    }


def orient_and_rotate_stl(
    stl_path: Path,
    profile: dict[str, Any],
    *,
    overhang_threshold_deg: float = DEFAULT_OVERHANG_THRESHOLD_DEG,
    max_input_bytes: int = MAX_INPUT_BYTES,
    stl_bytes: bytes | None = None,
    use_numpy: bool | None = None,
) -> tuple[dict[str, Any], bytes]:
    """Run `orient_stl` and return `(report, effective_stl_bytes)`.

    When the selected orientation is the identity (`applied == False`), the
    original input bytes are returned unchanged. When `applied == True`, the
    part is rotated by `report['selected']['rotationMatrix']` and emitted as
    canonical binary STL bytes.
    """
    path = Path(stl_path)
    data = read_stl_bounded(path, max_input_bytes) if stl_bytes is None else stl_bytes
    report = orient_stl(
        path,
        profile,
        overhang_threshold_deg=overhang_threshold_deg,
        max_input_bytes=max_input_bytes,
        stl_bytes=data,
        use_numpy=use_numpy,
    )
    if report["selected"]["applied"]:
        raw_tris, verts_np = _extract_raw_tris(data, use_numpy=use_numpy)
        rot = tuple(tuple(float(v) for v in row) for row in report["selected"]["rotationMatrix"])
        oriented_bytes = _pack_rotated_tris(raw_tris, verts_np, rot, use_numpy=use_numpy)
    else:
        oriented_bytes = data
    return report, oriented_bytes
