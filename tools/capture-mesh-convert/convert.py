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

Gf = Usd = UsdGeom = None  # pxr is imported lazily so a missing install exits 2

TOOL_VERSION = "0.2.0"
SUBDIVISION_POLICY = ("unauthored-is-polygonal: an unauthored subdivisionScheme (USD fallback catmullClark) "
                      "is treated as a polygonal cage and recorded per mesh; an authored scheme other than "
                      "'none' is an unsupported feature")
SKIPPED_PURPOSES = ("guide", "proxy", "render")


def _load_pxr():
    global Gf, Usd, UsdGeom
    if Usd is None:
        try:
            from pxr import Gf as _g, Usd as _u, UsdGeom as _ug
        except ImportError as e:
            raise RuntimeError(f"USD runtime unavailable (pip install usd-core): {e}") from e
        Gf, Usd, UsdGeom = _g, _u, _ug


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def _has_time_samples(attr):
    return attr and attr.IsValid() and attr.GetNumTimeSamples() > 0


def convert(src, out_obj):
    _load_pxr()
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
    skipped = []
    meshes = []
    lines = [f"# capture-mesh-convert {TOOL_VERSION} from {src.name}",
             f"# native stage units; metersPerUnit={mpu!r} (authored={units_authored}); upAxis={up} (authored={up_authored})"]
    v_offset = 0
    t = Usd.TimeCode.Default()

    it = iter(Usd.PrimRange(stage.GetPseudoRoot(), Usd.TraverseInstanceProxies(Usd.PrimAllPrimsPredicate)))
    for prim in it:
        path = str(prim.GetPath())
        if prim.IsPseudoRoot():
            continue
        if prim.IsAbstract() or not prim.IsDefined():
            it.PruneChildren()
            continue
        if not prim.IsActive():
            skipped.append({"prim": path, "reason": "inactive"})
            it.PruneChildren()
            continue
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
        purpose = str(img.ComputePurpose())
        if purpose in SKIPPED_PURPOSES:
            skipped.append({"prim": path, "reason": f"purpose={purpose}"})
            continue
        if img.ComputeVisibility(t) == UsdGeom.Tokens.invisible:
            skipped.append({"prim": path, "reason": "invisible"})
            continue
        scheme_attr = mesh.GetSubdivisionSchemeAttr()
        scheme_authored = scheme_attr.HasAuthoredValue()
        scheme = scheme_attr.Get(t)
        if scheme_authored and scheme != UsdGeom.Tokens.none:
            unsupported.append({"feature": "subdivision", "prim": path,
                                "detail": f"subdivisionScheme={scheme}; exported control cage only"})
        for name, attr in (("points", mesh.GetPointsAttr()),
                           ("faceVertexCounts", mesh.GetFaceVertexCountsAttr()),
                           ("faceVertexIndices", mesh.GetFaceVertexIndicesAttr()),
                           ("holeIndices", mesh.GetHoleIndicesAttr()),
                           ("orientation", mesh.GetOrientationAttr()),
                           ("subdivisionScheme", scheme_attr)):
            if _has_time_samples(attr):
                feat = "animatedPoints" if name == "points" else "timeSampledTopology"
                unsupported.append({"feature": feat, "prim": path,
                                    "detail": f"{name} is time-sampled; default time used"})
        anc = prim
        while anc and anc.IsValid() and not anc.IsPseudoRoot():
            xf = UsdGeom.Xformable(anc)
            if xf and xf.TransformMightBeTimeVarying():
                unsupported.append({"feature": "animatedTransform", "prim": str(anc.GetPath()),
                                    "detail": "default time used"})
            anc = anc.GetParent()
        holes = set(mesh.GetHoleIndicesAttr().Get(t) or [])
        if holes:
            unsupported.append({"feature": "holeIndices", "prim": path,
                                "detail": f"{len(holes)} hole face(s) omitted from OBJ"})

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
        written = 0
        for fi, c in enumerate(counts):
            face = indices[k:k + c]
            k += c
            if fi in holes:
                continue
            if c < 3:
                warnings.append(f"{path}: degenerate face with {c} vertices skipped")
                continue
            if flip:
                face = [face[0]] + face[1:][::-1]
            lines.append("f " + " ".join(str(i + 1 + v_offset) for i in face))
            written += 1
        v_offset += len(points)
        meshes.append({"prim": path, "points": len(points), "faces": written, "authoredFaces": len(counts),
                       "holeFacesOmitted": len(holes), "purpose": purpose,
                       "worldDeterminant": det, "authoredOrientation": "leftHanded" if left else "rightHanded",
                       "windingFlipped": flip, "subdivisionScheme": str(scheme),
                       "subdivisionSchemeAuthored": scheme_authored})

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
        "subdivisionPolicy": SUBDIVISION_POLICY,
        "skippedPurposes": list(SKIPPED_PURPOSES), "skippedPrims": skipped,
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
