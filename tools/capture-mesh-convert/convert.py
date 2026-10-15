#!/usr/bin/env python3
"""Offline USDZ/USD -> OBJ converter (INT-003).

Requires usd-core (pxr). Composes each mesh's local-to-world transform exactly
once, writes native (unrescaled) stage-unit coordinates, and emits a JSON report.
No rescaling, fitting, hole filling, or completeness/fit claims.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

from pxr import Gf, Usd, UsdGeom

TOOL_VERSION = "0.1.0"


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def _has_time_samples(attr):
    return attr and attr.IsValid() and attr.GetNumTimeSamples() > 0


def convert(src, out_obj):
    src = Path(src)
    src_bytes = src.read_bytes()
    stage = Usd.Stage.Open(str(src))
    if stage is None:
        raise RuntimeError(f"could not open USD stage: {src}")

    units_authored = UsdGeom.StageHasAuthoredMetersPerUnit(stage)
    up_authored = stage.HasAuthoredMetadata("upAxis")
    mpu = UsdGeom.GetStageMetersPerUnit(stage)
    up = UsdGeom.GetStageUpAxis(stage)
    unsupported = []
    warnings = []
    meshes = []
    lines = [f"# capture-mesh-convert {TOOL_VERSION} from {src.name}",
             f"# native stage units; metersPerUnit={mpu!r} (authored={units_authored}); upAxis={up} (authored={up_authored})"]
    v_offset = 0
    t = Usd.TimeCode.Default()

    for prim in Usd.PrimRange(stage.GetPseudoRoot(), Usd.TraverseInstanceProxies()):
        path = str(prim.GetPath())
        if prim.IsInstance() or prim.IsInstanceProxy():
            if prim.IsInstance():
                unsupported.append({"feature": "nativeInstancing", "prim": path,
                                    "detail": "instanced prims are not exported"})
            continue
        if prim.IsA(UsdGeom.PointInstancer):
            unsupported.append({"feature": "pointInstancer", "prim": path, "detail": "not exported"})
            continue
        if prim.IsA(UsdGeom.Gprim) and not prim.IsA(UsdGeom.Mesh):
            unsupported.append({"feature": "nonMeshGprim:" + prim.GetTypeName(), "prim": path,
                                "detail": "not exported"})
            continue
        if not prim.IsA(UsdGeom.Mesh):
            continue
        mesh = UsdGeom.Mesh(prim)
        img = UsdGeom.Imageable(prim)
        if img.ComputeVisibility(t) == UsdGeom.Tokens.invisible:
            warnings.append(f"{path}: invisible mesh skipped")
            continue
        scheme = mesh.GetSubdivisionSchemeAttr().Get()
        if scheme != UsdGeom.Tokens.none:
            unsupported.append({"feature": "subdivision", "prim": path,
                                "detail": f"subdivisionScheme={scheme}; exported control cage only"})
        if _has_time_samples(mesh.GetPointsAttr()):
            unsupported.append({"feature": "animatedPoints", "prim": path, "detail": "default time used"})
        anc = prim
        while anc and anc.IsValid() and not anc.IsPseudoRoot():
            xf = UsdGeom.Xformable(anc)
            if xf and xf.TransformMightBeTimeVarying():
                unsupported.append({"feature": "animatedTransform", "prim": str(anc.GetPath()),
                                    "detail": "default time used"})
            anc = anc.GetParent()

        points = mesh.GetPointsAttr().Get(t) or []
        counts = list(mesh.GetFaceVertexCountsAttr().Get(t) or [])
        indices = list(mesh.GetFaceVertexIndicesAttr().Get(t) or [])
        if sum(counts) != len(indices):
            raise RuntimeError(f"{path}: faceVertexCounts/indices mismatch")
        # Composed exactly once: full local-to-world (includes the prim's own ops).
        m = img.ComputeLocalToWorldTransform(t)
        det = Gf.Matrix3d(m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2],
                          m[2][0], m[2][1], m[2][2]).GetDeterminant()
        left = mesh.GetOrientationAttr().Get(t) == UsdGeom.Tokens.leftHanded
        flip = (det < 0) != left
        lines.append(f"o {prim.GetName()}")
        for p in points:
            w = m.Transform(Gf.Vec3d(p))
            lines.append(f"v {w[0]!r} {w[1]!r} {w[2]!r}")
        k = 0
        for c in counts:
            face = indices[k:k + c]
            k += c
            if c < 3:
                warnings.append(f"{path}: degenerate face with {c} vertices skipped")
                continue
            if flip:
                face = [face[0]] + face[1:][::-1]
            lines.append("f " + " ".join(str(i + 1 + v_offset) for i in face))
        v_offset += len(points)
        meshes.append({"prim": path, "points": len(points), "faces": len(counts),
                       "worldDeterminant": det, "authoredOrientation": "leftHanded" if left else "rightHanded",
                       "windingFlipped": flip, "subdivisionScheme": str(scheme)})

    if not meshes:
        raise RuntimeError("no exportable meshes found")
    obj_bytes = ("\n".join(lines) + "\n").encode()
    Path(out_obj).write_bytes(obj_bytes)
    metric_qualified = bool(units_authored and not unsupported)
    return {
        "tool": "capture-mesh-convert", "toolVersion": TOOL_VERSION,
        "usdVersion": ".".join(map(str, Usd.GetVersion())),
        "source": {"path": src.name, "sha256": sha256_bytes(src_bytes), "bytes": len(src_bytes)},
        "output": {"path": Path(out_obj).name, "format": "obj", "sha256": sha256_bytes(obj_bytes),
                   "bytes": len(obj_bytes)},
        "metersPerUnit": mpu, "unitsAuthored": units_authored,
        "upAxis": str(up), "upAxisAuthored": up_authored,
        "outputBasis": {"coordinates": "world", "units": "native stage units (unrescaled)",
                        "metersPerUnit": mpu, "upAxis": str(up), "handedness": "right",
                        "winding": "counter-clockwise front faces"},
        "metricQualified": metric_qualified,
        "metricQualifiedReason": None if metric_qualified else
            ("metersPerUnit not authored (default used)" if not units_authored else "unsupported features present"),
        "unsupportedFeatures": unsupported, "warnings": warnings, "meshes": meshes,
        "provesCompleteCapture": False, "provesPhysicalFit": False,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source")
    ap.add_argument("--out", required=True, help="output .obj path")
    ap.add_argument("--report", help="output JSON report path (default: stdout)")
    a = ap.parse_args(argv)
    try:
        report = convert(a.source, a.out)
    except Exception as e:  # noqa: BLE001
        print(f"error: {e}", file=sys.stderr)
        return 2
    text = json.dumps(report, indent=2, sort_keys=True)
    if a.report:
        Path(a.report).write_text(text + "\n")
    else:
        print(text)
    return 0 if report["metricQualified"] else 4


if __name__ == "__main__":
    sys.exit(main())
