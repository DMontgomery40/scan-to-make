#!/usr/bin/env python3
"""Bounded duplicate: emit an exact copy of a qualified capture mesh, or reject it.

Runs the offline capture pipeline, then gates its converted mesh for duplication:

* only a pipeline ``pass-bounds-only`` result is eligible;
* the mesh must be closed, edge-manifold, consistently oriented, free of degenerate
  triangles and of nonzero volume, checked independently here (open or broken
  surfaces are rejected, never capped, filled or repaired);
* vertex count, triangle count and the native extents (converted to mm only for the
  comparison) must fit the declared bounds; the mesh is never rotated, moved or scaled
  to fit.

The duplicate is the converter's OBJ, copied byte for byte and re-verified by hash, so
its geometry and units are exactly the source's. Units live in the manifest; no scale is
applied to the geometry.
"""
import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

from pipeline import _held, _normalize, dumps, run_pipeline, TOOLS

SCHEMA = "scan-to-make.capture-duplicate/0.1.0"
UNIT_TO_MM = {"mm": 1.0, "cm": 10.0, "in": 25.4, "m": 1000.0}  # exact, same map as FIT006
AXES = ("x", "y", "z")

DEFAULT_BUILD_VOLUME_MM = {"x": 256.0, "y": 256.0, "z": 256.0}
DEFAULT_MAX_VERTICES = 1_000_000
DEFAULT_MAX_TRIANGLES = 2_000_000

EXIT = {"duplicate-ready": 0, "evaluation-failed": 2, "rejected-input": 3, "rejected-conversion": 4,
        "rejected-units": 5, "rejected-bounds": 6, "rejected-topology": 7}


class Rejected(Exception):
    def __init__(self, verdict, reason, evidence=None):
        super().__init__(reason)
        self.verdict, self.reason, self.evidence = verdict, reason, evidence or {}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def parse_triangle_obj(data, max_vertices, max_triangles):
    """Strict reader for the converter's OBJ: ``v x y z``, triangular ``f``, ``o``, comments.

    Anything else (n-gons, texture/normal indices, other directives) is rejected rather than
    re-triangulated or dropped, so the duplicate can never differ from what was checked.
    """
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise Rejected("rejected-topology", "mesh is not valid UTF-8") from None
    verts, tris = [], []
    for n, line in enumerate(text.splitlines(), 1):
        parts = line.split()
        if not parts or parts[0].startswith("#") or parts[0] == "o":
            continue
        if parts[0] == "v":
            if len(parts) != 4:
                raise Rejected("rejected-topology", f"line {n}: vertex must have exactly 3 coordinates")
            try:
                xyz = tuple(float(p) for p in parts[1:])
            except ValueError:
                raise Rejected("rejected-topology", f"line {n}: malformed vertex") from None
            if any(c != c or c in (float("inf"), float("-inf")) for c in xyz):
                raise Rejected("rejected-topology", f"line {n}: non-finite vertex")
            verts.append(xyz)
            if len(verts) > max_vertices:
                raise Rejected("rejected-bounds", f"more than {max_vertices} vertices",
                               {"limit": "maxVertices", "value": max_vertices})
        elif parts[0] == "f":
            if len(parts) != 4:
                raise Rejected("rejected-topology", f"line {n}: face is not a triangle (not re-triangulated)")
            try:
                idx = tuple(int(p) for p in parts[1:])
            except ValueError:
                raise Rejected("rejected-topology", f"line {n}: face index must be a plain integer") from None
            if any(i < 1 or i > len(verts) for i in idx):
                raise Rejected("rejected-topology", f"line {n}: face index out of range")
            tris.append(tuple(i - 1 for i in idx))
            if len(tris) > max_triangles:
                raise Rejected("rejected-bounds", f"more than {max_triangles} triangles",
                               {"limit": "maxTriangles", "value": max_triangles})
        else:
            raise Rejected("rejected-topology", f"line {n}: unsupported OBJ directive {parts[0]!r}")
    if not verts or not tris:
        raise Rejected("rejected-topology", "mesh has no triangles")
    return verts, tris


def topology(verts, tris):
    """Closedness/manifold/orientation/degeneracy in index space; no geometry is changed."""
    directed, undirected = Counter(), Counter()
    degenerate, vol6 = 0, 0.0
    for a, b, c in tris:
        pa, pb, pc = verts[a], verts[b], verts[c]
        u = (pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2])
        v = (pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2])
        cr = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        if len({a, b, c}) != 3 or cr == (0.0, 0.0, 0.0):
            degenerate += 1
        vol6 += pa[0] * (pb[1] * pc[2] - pb[2] * pc[1]) - pa[1] * (pb[0] * pc[2] - pb[2] * pc[0]) \
            + pa[2] * (pb[0] * pc[1] - pb[1] * pc[0])
        for e in ((a, b), (b, c), (c, a)):
            directed[e] += 1
            undirected[tuple(sorted(e))] += 1
    used = {i for t in tris for i in t}
    return {
        "vertexCount": len(verts),
        "triangleCount": len(tris),
        "unreferencedVertexCount": len(verts) - len(used),
        "boundaryEdgeCount": sum(1 for k in undirected.values() if k == 1),
        "nonManifoldEdgeCount": sum(1 for k in undirected.values() if k > 2),
        "inconsistentlyOrientedEdgeCount": sum(1 for (a, b), k in directed.items()
                                               if k != 1 or directed.get((b, a), 0) != 1),
        "degenerateTriangleCount": degenerate,
        "signedVolumeNative": vol6 / 6.0,
    }


def check_duplicate(obj_bytes, units, build_volume_mm=None, max_vertices=DEFAULT_MAX_VERTICES,
                    max_triangles=DEFAULT_MAX_TRIANGLES):
    """Gate one converted mesh. Returns the geometry section of the manifest or raises Rejected."""
    build = dict(DEFAULT_BUILD_VOLUME_MM if build_volume_mm is None else build_volume_mm)
    if units not in UNIT_TO_MM:
        raise Rejected("rejected-units", f"units {units!r} have no exact mm factor")
    verts, tris = parse_triangle_obj(obj_bytes, max_vertices, max_triangles)
    topo = topology(verts, tris)
    problems = [k for k in ("boundaryEdgeCount", "nonManifoldEdgeCount", "inconsistentlyOrientedEdgeCount",
                            "degenerateTriangleCount") if topo[k]]
    if topo["signedVolumeNative"] <= 0:
        problems.append("nonPositiveVolume")
    if problems:
        raise Rejected("rejected-topology", "mesh is not a closed, manifold, outward-oriented solid; "
                       "no surfaces are invented to close it: " + ", ".join(problems), {"topology": topo})
    mins = [min(p[i] for p in verts) for i in range(3)]
    maxs = [max(p[i] for p in verts) for i in range(3)]
    factor = UNIT_TO_MM[units]
    native = {a: {"min": mins[i], "max": maxs[i], "extent": maxs[i] - mins[i]} for i, a in enumerate(AXES)}
    extents_mm = {a: native[a]["extent"] * factor for a in AXES}
    over = {a: {"extentMm": extents_mm[a], "limitMm": build[a]} for a in AXES if extents_mm[a] > build[a]}
    geometry = {"topology": topo, "boundsNative": native, "extentsMm": extents_mm, "buildVolumeMm": build,
                "limits": {"maxVertices": max_vertices, "maxTriangles": max_triangles}}
    if over:
        raise Rejected("rejected-bounds", "native extents exceed the build volume; the mesh is not "
                       "scaled, rotated or moved to fit", {"exceeded": over, "geometry": geometry})
    return geometry


def run_duplicate(source, held_out, work_dir, out_dir, build_volume_mm=None, max_vertices=DEFAULT_MAX_VERTICES,
                  max_triangles=DEFAULT_MAX_TRIANGLES, **pipeline_kw):
    work, out = Path(work_dir), Path(out_dir)
    roots = [(out.resolve(), "<out>"), (work.resolve(), "<work>"), (TOOLS.parent.resolve(), "<repo>"),
             (Path(source).resolve().parent, "<input-dir>")]
    pipe = run_pipeline(source, held_out, work, **pipeline_kw)
    manifest = {"schema": SCHEMA, "pipeline": pipe, "duplicate": None, "geometry": None, "rejection": None,
                "geometryModified": False, "surfacesInvented": False, "scaleApplied": False,
                "provesCompleteCapture": False, "provesPhysicalFit": False}
    dup = out / "duplicate.obj"
    dup.unlink(missing_ok=True)
    try:
        if pipe["verdict"] != "pass-bounds-only":
            raise Rejected(pipe["verdict"], f"pipeline verdict {pipe['verdict']}; nothing is duplicated",
                           {"pipelineRejection": pipe.get("rejection")})
        mesh = work / "mesh.obj"
        data = mesh.read_bytes()
        expected = pipe["converter"]["report"]["output"]["sha256"]
        if sha256(data) != expected:
            raise Rejected("rejected-conversion", "converted mesh changed after the pipeline ran")
        units = pipe["declaredUnits"]["units"]
        manifest["geometry"] = check_duplicate(data, units, build_volume_mm, max_vertices, max_triangles)
        out.mkdir(parents=True, exist_ok=True)
        dup.write_bytes(data)
        copy = dup.read_bytes()
        if copy != data or sha256(copy) != expected:
            dup.unlink(missing_ok=True)
            raise Rejected("rejected-conversion", "duplicate copy does not match the converted mesh")
        manifest["duplicate"] = {"path": "<out>/duplicate.obj", "format": "obj", "byteLength": len(copy),
                                 "sha256": sha256(copy), "byteIdenticalToConvertedMesh": True,
                                 "sourceSha256": pipe["input"]["sha256"], "units": units,
                                 "metersPerUnit": pipe["declaredUnits"]["metersPerUnit"],
                                 "mmPerUnit": UNIT_TO_MM[units]}
        manifest["verdict"] = "duplicate-ready"
    except Rejected as r:
        manifest["verdict"] = r.verdict
        manifest["rejection"] = {"verdict": r.verdict, "reason": _normalize(r.reason, roots), "evidence": r.evidence}
        if "geometry" in r.evidence:
            manifest["geometry"] = r.evidence.pop("geometry")
    manifest["exitCode"] = EXIT[manifest["verdict"]]
    return json.loads(_normalize(dumps(manifest), roots))


def _volume(s):
    try:
        vals = [float(v) for v in s.lower().split("x")]
    except ValueError:
        vals = []
    if len(vals) != 3 or not all(v > 0 and v != float("inf") for v in vals):
        raise argparse.ArgumentTypeError("build volume must be XxYxZ in mm, e.g. 256x256x256")
    return dict(zip(AXES, vals))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source")
    ap.add_argument("--held-out", type=_held, action="append", required=True, help="axis=mm, e.g. x=80")
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--out-dir", required=True, help="duplicate.obj is written here only when ready")
    ap.add_argument("--report", help="write JSON manifest here (default: stdout)")
    ap.add_argument("--python", default=sys.executable, help="interpreter with usd-core for the converter")
    ap.add_argument("--build-volume", type=_volume, default=None, help="XxYxZ mm (default 256x256x256)")
    ap.add_argument("--max-vertices", type=int, default=DEFAULT_MAX_VERTICES)
    ap.add_argument("--max-triangles", type=int, default=DEFAULT_MAX_TRIANGLES)
    a = ap.parse_args(argv)
    m = run_duplicate(a.source, dict(a.held_out), a.work_dir, a.out_dir, a.build_volume, a.max_vertices,
                      a.max_triangles, python=a.python)
    text = dumps(m)
    if a.report:
        Path(a.report).write_text(text)
    else:
        sys.stdout.write(text)
    return m["exitCode"]


if __name__ == "__main__":
    sys.exit(main())
