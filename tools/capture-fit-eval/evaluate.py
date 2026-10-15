#!/usr/bin/env python3
"""Offline mesh scale/extent acceptance for captured artifacts.

This tool answers one narrow question: do a mesh's axis-aligned extents match
declared held-out dimensions closely enough, and is the triangle mesh closed
and consistently oriented? A pass is bounds-only evidence. It never proves
complete capture, surface accuracy away from the bounds, or physical fit.

Supported inputs are binary/ASCII STL and OBJ. Units are always declared by
the caller; the tool converts them to millimetres in its report and never
guesses a unit from the file. USDZ and other formats are rejected until the
team chooses a declared converter.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from collections import Counter
from pathlib import Path
from typing import Iterable, Mapping, Sequence

SCHEMA = "scan-to-make.capture-fit-eval/0.2.0"
AXES = ("x", "y", "z")
UNIT_TO_MM = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4}
SUPPORTED_FORMATS = {"stl", "obj"}
EPSILON = 1e-12

Vec = tuple[float, float, float]
Tri = tuple[int, int, int]


class UnsupportedFormat(ValueError):
    pass


class InvalidMesh(ValueError):
    pass


def _finite(value: float, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise InvalidMesh(f"{label} must be a finite number")
    return float(value)


def _vec(values: Iterable[float], factor: float) -> Vec:
    items = tuple(values)
    if len(items) != 3:
        raise InvalidMesh("vertex must have exactly three coordinates")
    return tuple(_finite(v, "vertex coordinate") * factor for v in items)  # type: ignore[return-value]


def _mesh_from_triangles(triangles: Sequence[tuple[Vec, Vec, Vec]]) -> tuple[list[Vec], list[Tri]]:
    vertices: list[Vec] = []
    index_by_vertex: dict[Vec, int] = {}
    indexed: list[Tri] = []
    for tri in triangles:
        ids: list[int] = []
        for vertex in tri:
            idx = index_by_vertex.get(vertex)
            if idx is None:
                idx = len(vertices)
                index_by_vertex[vertex] = idx
                vertices.append(vertex)
            ids.append(idx)
        indexed.append((ids[0], ids[1], ids[2]))
    if not vertices or not indexed:
        raise InvalidMesh("mesh contains no triangles")
    return vertices, indexed


def _binary_stl_count(data: bytes) -> int | None:
    if len(data) < 84:
        return None
    (count,) = struct.unpack_from("<I", data, 80)
    if count > 0 and len(data) == 84 + count * 50:
        return count
    return None


def _parse_ascii_stl(data: bytes, factor: float) -> tuple[list[Vec], list[Tri]]:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise InvalidMesh("ASCII STL is not valid UTF-8") from exc
    raw_vertices: list[Vec] = []
    saw_facet = False
    for line in text.splitlines():
        parts = line.strip().split()
        if parts[:1] == ["facet"]:
            saw_facet = True
        if len(parts) == 4 and parts[0] == "vertex":
            try:
                coords = (float(parts[1]), float(parts[2]), float(parts[3]))
            except ValueError as exc:
                raise InvalidMesh("ASCII STL vertex is malformed") from exc
            raw_vertices.append(_vec(coords, factor))
    if not saw_facet or not raw_vertices or len(raw_vertices) % 3:
        raise InvalidMesh("ASCII STL vertex count is not a positive multiple of three")
    tris = [
        (raw_vertices[i], raw_vertices[i + 1], raw_vertices[i + 2])
        for i in range(0, len(raw_vertices), 3)
    ]
    return _mesh_from_triangles(tris)


def _parse_binary_stl(data: bytes, factor: float, count: int) -> tuple[list[Vec], list[Tri]]:
    tris: list[tuple[Vec, Vec, Vec]] = []
    for i in range(count):
        values = struct.unpack_from("<12fH", data, 84 + i * 50)
        tris.append(
            (
                _vec(values[3:6], factor),
                _vec(values[6:9], factor),
                _vec(values[9:12], factor),
            )
        )
    return _mesh_from_triangles(tris)


def parse_stl(data: bytes, factor: float) -> tuple[list[Vec], list[Tri]]:
    binary_count = _binary_stl_count(data)
    ascii_candidate = (
        data[:5].lower() == b"solid"
        and b"endsolid" in data[-256:].lower()
        and b"facet" in data.lower()
        and b"vertex" in data.lower()
    )
    if ascii_candidate:
        try:
            return _parse_ascii_stl(data, factor)
        except InvalidMesh:
            if binary_count is None:
                raise
            return _parse_binary_stl(data, factor, binary_count)
    if binary_count is not None:
        return _parse_binary_stl(data, factor, binary_count)
    if data[:5].lower() == b"solid":
        return _parse_ascii_stl(data, factor)
    raise InvalidMesh("STL is neither structurally valid binary nor ASCII")


def parse_obj(data: bytes, factor: float) -> tuple[list[Vec], list[Tri]]:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise InvalidMesh("OBJ is not valid UTF-8") from exc
    vertices: list[Vec] = []
    triangles: list[Tri] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        parts = line.strip().split()
        if not parts or parts[0].startswith("#"):
            continue
        if parts[0] == "v":
            if len(parts) != 4:
                raise InvalidMesh(f"OBJ vertex on line {line_number} must have three coordinates")
            try:
                coords = (float(parts[1]), float(parts[2]), float(parts[3]))
            except ValueError as exc:
                raise InvalidMesh(f"OBJ vertex on line {line_number} is malformed") from exc
            vertices.append(_vec(coords, factor))
        elif parts[0] == "f":
            if len(parts) < 4:
                raise InvalidMesh(f"OBJ face on line {line_number} has fewer than three vertices")
            face: list[int] = []
            for token in parts[1:]:
                try:
                    raw = int(token.split("/", 1)[0])
                except ValueError as exc:
                    raise InvalidMesh(f"OBJ face index on line {line_number} is malformed") from exc
                if raw == 0:
                    raise InvalidMesh(f"OBJ face index on line {line_number} is zero")
                idx = raw - 1 if raw > 0 else len(vertices) + raw
                if idx < 0 or idx >= len(vertices):
                    raise InvalidMesh(f"OBJ face index on line {line_number} is out of range")
                face.append(idx)
            for i in range(1, len(face) - 1):
                triangles.append((face[0], face[i], face[i + 1]))
    if not vertices or not triangles:
        raise InvalidMesh("OBJ contains no triangles")
    return vertices, triangles


def load_mesh(path: Path, declared_format: str | None, units: str) -> tuple[str, bytes, list[Vec], list[Tri]]:
    fmt = (declared_format or path.suffix.removeprefix(".")).lower()
    if fmt not in SUPPORTED_FORMATS:
        raise UnsupportedFormat(
            f"unsupported mesh format {fmt or '(none)'!r}; supported formats: obj, stl"
        )
    suffix = path.suffix.removeprefix(".").lower()
    if declared_format and suffix and suffix != fmt:
        raise InvalidMesh("declared format does not match file extension")
    if units not in UNIT_TO_MM:
        raise InvalidMesh("units must be one of: cm, in, m, mm")
    data = path.read_bytes()
    if not data:
        raise InvalidMesh("mesh file is empty")
    factor = UNIT_TO_MM[units]
    vertices, triangles = parse_stl(data, factor) if fmt == "stl" else parse_obj(data, factor)
    return fmt, data, vertices, triangles


def _sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a: Vec, b: Vec) -> Vec:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def mesh_stats(vertices: Sequence[Vec], triangles: Sequence[Tri]) -> dict:
    mins = tuple(min(v[i] for v in vertices) for i in range(3))
    maxs = tuple(max(v[i] for v in vertices) for i in range(3))
    directed: Counter[tuple[int, int]] = Counter()
    undirected: Counter[tuple[int, int]] = Counter()
    degenerate = 0
    signed_volume = 0.0
    for tri in triangles:
        a, b, c = (vertices[i] for i in tri)
        normal = _cross(_sub(b, a), _sub(c, a))
        if len(set(tri)) != 3 or _dot(normal, normal) <= EPSILON:
            degenerate += 1
        signed_volume += _dot(a, _cross(b, c)) / 6.0
        for edge in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            directed[edge] += 1
            undirected[tuple(sorted(edge))] += 1
    closed_oriented = bool(directed) and all(
        count == 1 and directed[(b, a)] == 1 for (a, b), count in directed.items()
    )
    return {
        "vertexCount": len(vertices),
        "triangleCount": len(triangles),
        "degenerateTriangleCount": degenerate,
        "boundsMm": {
            axis: {"min": mins[i], "max": maxs[i], "extent": maxs[i] - mins[i]}
            for i, axis in enumerate(AXES)
        },
        "extentsMm": {axis: maxs[i] - mins[i] for i, axis in enumerate(AXES)},
        "signedVolumeMm3": signed_volume,
        "absoluteVolumeMm3": abs(signed_volume),
        "closedOriented": closed_oriented,
        "boundaryEdgeCount": sum(1 for count in undirected.values() if count == 1),
        "nonManifoldEdgeCount": sum(1 for count in undirected.values() if count > 2),
    }


def _validate_dimensions(values: Mapping[str, float], label: str) -> dict[str, float]:
    if not values:
        raise InvalidMesh(f"{label} must declare at least one axis")
    out: dict[str, float] = {}
    for axis, value in values.items():
        if axis not in AXES:
            raise InvalidMesh(f"{label} axis must be x, y, or z")
        number = _finite(value, f"{label}.{axis}")
        if number <= 0:
            raise InvalidMesh(f"{label}.{axis} must be positive")
        out[axis] = number
    return out


def _errors(actual: Mapping[str, float], expected: Mapping[str, float], tol_mm: float, tol_rel: float) -> dict:
    result = {}
    for axis, expected_mm in expected.items():
        tolerance = max(tol_mm, tol_rel * expected_mm)
        signed = actual[axis] - expected_mm
        result[axis] = {
            "actualMm": actual[axis],
            "expectedMm": expected_mm,
            "signedErrorMm": signed,
            "absoluteErrorMm": abs(signed),
            "relativeError": signed / expected_mm,
            "toleranceMm": tolerance,
            "withinTolerance": abs(signed) <= tolerance + 1e-9,
        }
    return result


def _evidence(*, bounds_status: str, topology_status: str) -> dict:
    """Separate what this tool measured from what it cannot qualify.

    Bounds and topology are geometric checks over the supplied artifact.
    Native metric accuracy, surface coverage/completeness, and mechanical
    fit require independent physical evidence and therefore stay unknown,
    including for a closed mesh whose bounds happen to match.
    """
    return {
        "geometricChecks": {
            "bounds": {
                "status": bounds_status,
                "basis": "evaluated extents versus declared held-out dimensions",
            },
            "topology": {
                "status": topology_status,
                "basis": "closed/oriented triangles, degenerate count, and signed-volume magnitude",
            },
        },
        "physicalQualification": {
            "nativeAccuracy": "unknown",
            "coverageCompleteness": "unknown",
            "mechanicalFit": "unknown",
        },
    }


def evaluate(
    path: Path,
    *,
    units: str,
    held_out_mm: Mapping[str, float],
    scale_mode: str = "native",
    calibration: Mapping | None = None,
    declared_format: str | None = None,
    tolerance_mm: float = 1.0,
    tolerance_relative: float = 0.01,
) -> dict:
    expected = _validate_dimensions(held_out_mm, "heldOutDimensionsMm")
    tol_mm = _finite(tolerance_mm, "toleranceMm")
    tol_rel = _finite(tolerance_relative, "toleranceRelative")
    if tol_mm < 0 or tol_rel < 0:
        raise InvalidMesh("tolerances must be non-negative")
    if scale_mode not in ("native", "assisted"):
        raise InvalidMesh("scale mode must be native or assisted")

    factor = 1.0
    calibration_report = None
    excluded_axis: str | None = None
    if scale_mode == "native":
        if calibration is not None:
            raise InvalidMesh("native scale mode must not declare a calibration")
    else:
        if not isinstance(calibration, Mapping):
            raise InvalidMesh("assisted scale mode requires calibration provenance")
        source = calibration.get("source")
        if source not in ("distinct-reference", "target-axis"):
            raise InvalidMesh("calibration source must be distinct-reference or target-axis")
        reference = calibration.get("reference")
        if not isinstance(reference, str) or not reference.strip():
            raise InvalidMesh("calibration reference must be a non-empty string")
        factor = _finite(calibration.get("factor"), "calibration.factor")
        if factor <= 0:
            raise InvalidMesh("calibration factor must be positive")
        axis = calibration.get("axis")
        if source == "target-axis":
            if axis not in AXES:
                raise InvalidMesh("target-axis calibration must name axis x, y, or z")
            excluded_axis = str(axis)
        elif axis is not None and axis not in AXES:
            raise InvalidMesh("calibration axis must be x, y, or z")
        calibration_report = {
            "source": source,
            "reference": reference.strip(),
            "factor": factor,
            "axis": axis,
            "excludedFromIndependentScoring": excluded_axis,
        }

    fmt, data, vertices, triangles = load_mesh(path, declared_format, units)
    stats = mesh_stats(vertices, triangles)
    raw_extents = stats["extentsMm"]
    evaluated_extents = {axis: raw_extents[axis] * factor for axis in AXES}
    raw_errors = _errors(raw_extents, expected, tol_mm, tol_rel)
    evaluated_errors = _errors(evaluated_extents, expected, tol_mm, tol_rel)
    independent_axes = [axis for axis in expected if axis != excluded_axis]
    native_scale_pass = (
        scale_mode == "native"
        and len(independent_axes) >= 2
        and all(raw_errors[axis]["withinTolerance"] for axis in independent_axes)
    )
    evaluated_scale_pass = len(independent_axes) >= 2 and all(
        evaluated_errors[axis]["withinTolerance"] for axis in independent_axes
    )
    topology_pass = (
        stats["closedOriented"]
        and stats["degenerateTriangleCount"] == 0
        and stats["absoluteVolumeMm3"] > 0
    )
    verdict = "pass-bounds-only" if evaluated_scale_pass and topology_pass else "fail"
    evidence = _evidence(
        bounds_status="pass" if evaluated_scale_pass else "fail",
        topology_status="pass" if topology_pass else "fail",
    )
    return {
        "schema": SCHEMA,
        "verdict": verdict,
        "artifact": {
            "fileName": path.name,
            "format": fmt,
            "byteLength": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "declaredUnits": units,
            "unitsConvertedTo": "mm",
        },
        "mesh": stats,
        "scale": {
            "mode": scale_mode,
            "appliedFactor": factor,
            "calibration": calibration_report,
            "rawExtentsMm": raw_extents,
            "evaluatedExtentsMm": evaluated_extents,
            "rawErrors": raw_errors,
            "evaluatedErrors": evaluated_errors,
            "independentAxes": independent_axes,
            "nativeScalePass": native_scale_pass,
            "evaluatedScalePass": evaluated_scale_pass,
        },
        "heldOutDimensionsMm": expected,
        "thresholds": {"absoluteMm": tol_mm, "relative": tol_rel},
        "evidence": evidence,
        "provesCompleteCapture": False,
        "provesPhysicalFit": False,
        "boundaries": [
            "Bounds and closedness do not prove complete capture, surface accuracy, or physical fit.",
            "Assisted results preserve raw errors separately and never count as native scale evidence.",
        ],
    }


def _parse_held_out(items: Sequence[str]) -> dict[str, float]:
    out: dict[str, float] = {}
    for item in items:
        if "=" not in item:
            raise InvalidMesh("held-out dimensions must use axis=value")
        axis, raw = item.split("=", 1)
        axis = axis.strip().lower()
        if axis in out:
            raise InvalidMesh(f"duplicate held-out axis {axis}")
        try:
            out[axis] = float(raw)
        except ValueError as exc:
            raise InvalidMesh(f"held-out dimension {axis} is malformed") from exc
    return _validate_dimensions(out, "heldOutDimensionsMm")


def _error_report(state: str, message: str) -> dict:
    return {
        "schema": SCHEMA,
        "verdict": state,
        "error": message,
        "evidence": _evidence(bounds_status="not-evaluated", topology_status="not-evaluated"),
        "provesCompleteCapture": False,
        "provesPhysicalFit": False,
    }


def _print_human(report: Mapping) -> None:
    if "error" in report:
        print(f"Capture fit evaluation: {report['verdict']}: {report['error']}")
        return
    artifact = report["artifact"]
    mesh = report["mesh"]
    print(f"Capture fit evaluation: {report['verdict']}")
    print(
        f"Artifact: {artifact['fileName']} ({artifact['format']}, {artifact['byteLength']} bytes, "
        f"sha256 {artifact['sha256']})"
    )
    scale = report["scale"]
    print(
        f"Mesh: {mesh['triangleCount']} triangles, closedOriented={mesh['closedOriented']}, "
        f"evaluatedExtentsMm={scale['evaluatedExtentsMm']} (mode={scale['mode']})"
    )
    if scale["mode"] == "assisted":
        print(f"Raw extents before calibration: {scale['rawExtentsMm']}")
    checks = report["evidence"]["geometricChecks"]
    physical = report["evidence"]["physicalQualification"]
    print(
        f"Geometric checks: bounds={checks['bounds']['status']}, "
        f"topology={checks['topology']['status']}"
    )
    print(
        "Physical qualification: "
        f"nativeAccuracy={physical['nativeAccuracy']}, "
        f"coverageCompleteness={physical['coverageCompleteness']}, "
        f"mechanicalFit={physical['mechanicalFit']}"
    )
    print("Bounds-only: this does not prove complete capture or physical fit.")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline mesh scale/extent acceptance")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("evaluate", help="evaluate one STL or OBJ artifact")
    run.add_argument("mesh", type=Path)
    run.add_argument("--units", required=True, choices=sorted(UNIT_TO_MM))
    run.add_argument("--format", choices=sorted(SUPPORTED_FORMATS), dest="declared_format")
    run.add_argument(
        "--held-out",
        action="append",
        required=True,
        metavar="AXIS=MM",
        help="held-out target extent in mm; repeat for x/y/z",
    )
    run.add_argument("--scale-mode", choices=("native", "assisted"), default="native")
    run.add_argument("--calibration-source", choices=("distinct-reference", "target-axis"))
    run.add_argument("--calibration-reference")
    run.add_argument("--calibration-factor", type=float)
    run.add_argument("--calibration-axis", choices=AXES)
    run.add_argument("--tolerance-mm", type=float, default=1.0)
    run.add_argument("--tolerance-relative", type=float, default=0.01)
    run.add_argument("--json", action="store_true")
    run.add_argument("--out", type=Path, help="also write the JSON report to this path")
    args = parser.parse_args(argv)

    calibration = None
    if args.scale_mode == "assisted":
        calibration = {
            "source": args.calibration_source,
            "reference": args.calibration_reference,
            "factor": args.calibration_factor,
            "axis": args.calibration_axis,
        }
    try:
        report = evaluate(
            args.mesh,
            units=args.units,
            held_out_mm=_parse_held_out(args.held_out),
            scale_mode=args.scale_mode,
            calibration=calibration,
            declared_format=args.declared_format,
            tolerance_mm=args.tolerance_mm,
            tolerance_relative=args.tolerance_relative,
        )
        exit_code = 0 if report["verdict"] == "pass-bounds-only" else 2
    except UnsupportedFormat as exc:
        report = _error_report("rejected-format", str(exc))
        exit_code = 3
    except (InvalidMesh, OSError) as exc:
        report = _error_report("invalid", str(exc))
        exit_code = 2

    if args.out:
        args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.json or args.out:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        _print_human(report)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
