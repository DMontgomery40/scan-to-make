#!/usr/bin/env python3
"""Offline USDZ/USD -> OBJ converter (INT-003).

Requires usd-core (pxr). Composes each mesh's local-to-world transform exactly
once, writes native (unrescaled) stage-unit coordinates, and emits a JSON report.
No rescaling, fitting, hole filling, or completeness/fit claims.
"""
import argparse
import hashlib
import json
import math
import zipfile
import sys
from pathlib import Path

from textures import UnsupportedTexture, base_colour, uv_coordinates, safe_stem

Ar = Gf = Sdf = Usd = UsdGeom = UsdUtils = None  # pxr is imported lazily so a missing install exits 2

TOOL_VERSION = "0.4.0"
SUBDIVISION_POLICY = ("explicit-none-only: per OpenUSD an unauthored subdivisionScheme means catmullClark "
                      "(a subdivision surface, not a polygon mesh); only an explicitly authored 'none' is polygonal. "
                      "Any other scheme exports the control cage and is not metric-qualified")
SKIPPED_PURPOSES = ("guide", "proxy", "render")


def _load_pxr():
    global Ar, Gf, Sdf, Usd, UsdGeom, UsdUtils
    if Usd is None:
        try:
            from pxr import Ar as _a, Gf as _g, Sdf as _s, Usd as _u, UsdGeom as _ug, UsdUtils as _uu
        except ImportError as e:
            raise RuntimeError(f"USD runtime unavailable (pip install usd-core): {e}") from e
        Ar, Gf, Sdf, Usd, UsdGeom, UsdUtils = _a, _g, _s, _u, _ug, _uu


def _finite(*vals):
    return all(math.isfinite(v) for v in vals)


def _layer_bytes(src, ident):
    """Return (relative name, bytes) for a layer/asset identifier inside src, or raise."""
    src_abs = str(src.resolve())
    # Ar (not Sdf.Layer) owns the package-relative path API in pxr 26.x: "/a/x.usdz[mesh.usdc]".
    outer, inner = Ar.SplitPackageRelativePathOuter(ident) if Ar.IsPackageRelativePath(ident) else (ident, "")
    if inner:
        if str(Path(outer).resolve()) != src_abs:
            raise RuntimeError(f"asset boundary: dependency outside package: {ident}")
        with zipfile.ZipFile(src) as z:
            try:
                return inner, z.read(inner)
            except KeyError:
                raise RuntimeError(f"asset boundary: packaged entry missing: {ident}") from None
    if str(Path(ident).resolve()) != src_abs:
        raise RuntimeError(f"asset boundary: dependency outside source: {ident}")
    if zipfile.is_zipfile(src):  # package root layer = first zip entry
        with zipfile.ZipFile(src) as z:
            first = z.infolist()[0].filename
            return first, z.read(first)
    return src.name, src.read_bytes()


def check_asset_boundary(src, stage):
    layers, assets, unresolved = UsdUtils.ComputeAllDependencies(Sdf.AssetPath(str(src)))
    if unresolved:
        raise RuntimeError(f"asset boundary: unresolved dependencies: {sorted(map(str, unresolved))}")
    idents = [l.identifier for l in layers] + [str(a) for a in assets]
    session = stage.GetSessionLayer()
    idents += [l.identifier for l in stage.GetUsedLayers() if l != session and not l.anonymous]
    out = {}
    for ident in idents:
        name, data = _layer_bytes(src, ident)
        out[name] = {"identifier": name, "sha256": sha256_bytes(data), "bytes": len(data)}
    return [out[k] for k in sorted(out)]


def _newell(pts):
    nx = ny = nz = 0.0
    for i, p in enumerate(pts):
        q = pts[(i + 1) % len(pts)]
        nx += (p[1] - q[1]) * (p[2] + q[2])
        ny += (p[2] - q[2]) * (p[0] + q[0])
        nz += (p[0] - q[0]) * (p[1] + q[1])
    return nx, ny, nz


PLANAR_TOL = 1e-6      # max out-of-plane distance, relative to the face's largest extent
DEGENERATE_TOL = 1e-9  # min |Newell normal| (2x area), relative to extent^2


def face_validity(pts):
    """Return None if the face is a valid planar, non-degenerate polygon, else a reason string.
    Applies to every face size, including triangles."""
    if len(pts) < 3:
        return "fewer than 3 vertices"
    ext = max(max(p[k] for p in pts) - min(p[k] for p in pts) for k in range(3))
    if not (ext > 0 and math.isfinite(ext)):
        return "zero extent"
    nrm = _newell(pts)
    mag = math.sqrt(sum(c * c for c in nrm))
    if mag <= DEGENERATE_TOL * ext * ext:
        return "degenerate (zero area / collinear)"
    nh = [c / mag for c in nrm]
    cen = [sum(p[k] for p in pts) / len(pts) for k in range(3)]
    dev = max(abs(sum((p[k] - cen[k]) * nh[k] for k in range(3))) for p in pts)
    if dev > PLANAR_TOL * ext:
        return f"nonplanar (max out-of-plane {dev:.3g})"
    return None


def triangulate(pts):
    """Ear-clip a planar polygon (list of xyz) on its face plane.
    Returns triangles as index triples into pts, preserving winding, or None if the face is
    invalid (see face_validity) or cannot be ear-clipped (e.g. self-intersecting)."""
    if face_validity(pts) is not None:
        return None
    n = len(pts)
    nrm = _newell(pts)
    mag = math.sqrt(sum(c * c for c in nrm))
    ax = max(range(3), key=lambda i: abs(nrm[i]))
    u, v = [i for i in range(3) if i != ax]
    # (u, v) is right-handed about +axis for x and z; for y, (x, z) is left-handed.
    sign = (1.0 if nrm[ax] > 0 else -1.0) * (-1.0 if ax == 1 else 1.0)
    p2 = [(p[u], p[v]) for p in pts]

    def cross(a, b, c):
        return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * sign

    eps = 1e-12 * mag
    idx = list(range(n))
    tris = []
    guard = 0
    while len(idx) > 3:
        guard += 1
        if guard > n * n:
            return None
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            a, b, c = p2[i0], p2[i1], p2[i2]
            if cross(a, b, c) <= eps:
                continue
            if any(j not in (i0, i1, i2) and cross(a, b, p2[j]) >= 0 and cross(b, c, p2[j]) >= 0
                   and cross(c, a, p2[j]) >= 0 for j in idx):
                continue
            tris.append((i0, i1, i2))
            idx.pop(k)
            break
        else:
            return None
    if cross(p2[idx[0]], p2[idx[1]], p2[idx[2]]) <= eps:
        return None
    tris.append(tuple(idx))
    return tris


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def _has_time_samples(attr):
    return attr and attr.IsValid() and attr.GetNumTimeSamples() > 0


def convert(src, out_obj):
    _load_pxr()
    src = Path(src)
    out_obj = Path(out_obj)
    if src.resolve() == out_obj.resolve():
        raise RuntimeError("output must not overwrite source")
    src_bytes = src.read_bytes()
    stage = Usd.Stage.Open(str(src))
    if stage is None:
        raise RuntimeError(f"could not open USD stage: {src}")
    layer_hashes = check_asset_boundary(src, stage)

    units_authored = UsdGeom.StageHasAuthoredMetersPerUnit(stage)
    up_authored = stage.HasAuthoredMetadata("upAxis")
    mpu = UsdGeom.GetStageMetersPerUnit(stage)
    up = UsdGeom.GetStageUpAxis(stage)
    if not (isinstance(mpu, (int, float)) and math.isfinite(mpu) and mpu > 0):
        raise RuntimeError(f"invalid metersPerUnit={mpu!r}: must be positive and finite")
    unsupported = []
    warnings = []
    skipped = []
    meshes = []
    lines = [f"# capture-mesh-convert {TOOL_VERSION} from {src.name}",
             f"# native stage units; metersPerUnit={mpu!r} (authored={units_authored}); upAxis={up} (authored={up_authored})"]
    v_offset = 0
    vt_offset = 0
    materials = []
    artifacts = {}
    stem = safe_stem(out_obj)
    mtl_name = stem + ".mtl"
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
        if scheme != UsdGeom.Tokens.none:
            unsupported.append({"feature": "subdivision", "prim": path,
                                "detail": f"subdivisionScheme={scheme} (authored={scheme_authored}); "
                                          "exported control cage only"})
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
        if any(c < 0 for c in counts) or sum(counts) != len(indices):
            raise RuntimeError(f"{path}: invalid topology: faceVertexCounts sum {sum(counts)} != "
                               f"faceVertexIndices length {len(indices)}")
        bad = [i for i in indices if i < 0 or i >= len(points)]
        if bad:
            raise RuntimeError(f"{path}: invalid topology: index {bad[0]} out of range for {len(points)} points")
        material = None
        uv_name = "st"
        try:
            material = base_colour(prim, src, _layer_bytes)
            if material:
                uv_name = material.get("uvPrimvar", "st")
            uvs = uv_coordinates(prim, uv_name, counts, indices, len(points))
            if material and "png" in material and uvs is None:
                raise RuntimeError(f"{path}: textured mesh missing UV primvar {uv_name}")
        except UnsupportedTexture as exc:
            unsupported.append({"feature":"baseColour", "prim":path, "detail":str(exc)})
            material, uvs = None, None
        material_name = None
        if material:
            material_name = "material_%d" % len(materials)
            mtl = ["newmtl " + material_name, "Kd " + " ".join(map(str,material["colour"]))]
            if "png" in material:
                png_name = stem + "_basecolor_%d.png" % len(materials)
                artifacts[png_name] = material.pop("png")
                mtl.append("map_Kd -clamp %s %s" % ("on" if material["clamp"] else "off",png_name))
                material["textureOutput"] = png_name
            materials.append((mtl, material))
        # Composed exactly once: full local-to-world (includes the prim's own ops).
        m = img.ComputeLocalToWorldTransform(t)
        if not _finite(*(m[r][c] for r in range(4) for c in range(4))):
            raise RuntimeError(f"{path}: non-finite composed transform")
        det = Gf.Matrix3d(m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2],
                          m[2][0], m[2][1], m[2][2]).GetDeterminant()
        left = mesh.GetOrientationAttr().Get(t) == UsdGeom.Tokens.leftHanded
        flip = (det < 0) != left
        lines.append(f"o {prim.GetName()}")
        world = []
        for p in points:
            if not _finite(p[0], p[1], p[2]):
                raise RuntimeError(f"{path}: non-finite point {tuple(p)}")
            w = m.Transform(Gf.Vec3d(p))
            if not _finite(w[0], w[1], w[2]):
                raise RuntimeError(f"{path}: non-finite transformed point")
            world.append((w[0], w[1], w[2]))
            lines.append(f"v {w[0]!r} {w[1]!r} {w[2]!r}")
        if uvs is not None:
            lines += [f"vt {u!r} {v!r}" for u,v in uvs]
        # Explicit reset avoids a preceding mesh's material leaking to an unbound mesh.
        if material_name or materials:
            lines.append("usemtl " + (material_name or "unbound"))
        rejected = 0
        reasons = []
        triangles = 0
        k = 0
        written = 0
        for fi, c in enumerate(counts):
            face = indices[k:k + c]
            corner = k
            k += c
            if fi in holes:
                continue
            if c < 3:
                warnings.append(f"{path}: degenerate face with {c} vertices skipped")
                continue
            fpts = [world[i] for i in face]
            reason = face_validity(fpts)
            tris = None if reason else triangulate(fpts)
            if tris is None:
                rejected += 1
                reasons.append(f"face {fi}: {reason or 'not ear-clippable (self-intersecting?)'}")
                continue
            for tri in tris:
                if flip:
                    tri = tri[::-1]
                lines.append("f " + " ".join(
                    str(face[j] + 1 + v_offset) +
                    ("/" + str(corner+j+1+vt_offset) if uvs is not None else "") for j in tri))
                triangles += 1
            written += 1
        if rejected:
            unsupported.append({"feature": "untriangulatablePolygon", "prim": path,
                                "detail": f"{rejected} invalid face(s) not emitted: " + "; ".join(reasons[:10])})
        v_offset += len(points)
        if uvs is not None:
            vt_offset += len(uvs)
        meshes.append({"prim": path, "points": len(points), "faces": written, "triangles": triangles,
                       "rejectedFaces": rejected, "authoredFaces": len(counts),
                       "holeFacesOmitted": len(holes), "purpose": purpose,
                       "worldDeterminant": det, "authoredOrientation": "leftHanded" if left else "rightHanded",
                       "windingFlipped": flip, "subdivisionScheme": str(scheme),
                       "subdivisionSchemeAuthored": scheme_authored,
                       "uvPrimvar":uv_name if uvs is not None else None,
                       "uvCorners":len(uvs) if uvs is not None else 0,
                       "material":material_name})

    if not meshes:
        raise RuntimeError("no exportable meshes found")
    if materials:
        lines.insert(2, "mtllib " + mtl_name)
        artifacts[mtl_name] = ("newmtl unbound\nKd 0.18 0.18 0.18\n\n" +
                               "\n\n".join("\n".join(mtl) for mtl,_ in materials)+"\n").encode()
    obj_bytes = ("\n".join(lines) + "\n").encode()
    if out_obj.name in artifacts or any((out_obj.parent/name).resolve() == src.resolve() for name in artifacts):
        raise RuntimeError("output artifact collision")
    artifacts[out_obj.name] = obj_bytes
    # All validation, texture decoding and hashing precede the first output write.
    outputs = [{"path":name, "sha256":sha256_bytes(data), "bytes":len(data)}
               for name,data in sorted(artifacts.items())]
    for name,data in artifacts.items():
        (out_obj.parent/name).write_bytes(data)
    metric_qualified = bool(units_authored and not unsupported)
    return {
        "tool": "capture-mesh-convert", "toolVersion": TOOL_VERSION,
        "usdVersion": ".".join(map(str, Usd.GetVersion())),
        "contributingLayers": layer_hashes,
        "outputs":outputs, "materials":[desc for _,desc in materials],
        "source": {"path": src.name, "sha256": sha256_bytes(src_bytes), "bytes": len(src_bytes)},
        "output": {"path": Path(out_obj).name, "format": "obj", "sha256": sha256_bytes(obj_bytes),
                   "bytes": len(obj_bytes)},
        "metersPerUnit": mpu, "unitsAuthored": units_authored,
        "upAxis": str(up), "upAxisAuthored": up_authored,
        "outputBasis": {"coordinates": "world", "units": "native stage units (unrescaled)",
                        "metersPerUnit": mpu, "upAxis": str(up), "handedness": "right",
                        "winding": "counter-clockwise front faces",
                        "faces": "triangles (ear clipping on face plane)"},
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
        if a.report:
            report_path = Path(a.report).resolve()
            out = Path(a.out)
            stem = safe_stem(out)
            if report_path in (Path(a.source).resolve(), out.resolve()) or (
                report_path.parent == out.resolve().parent and
                (report_path.name == stem+".mtl" or
                 (report_path.name.startswith(stem+"_basecolor_") and report_path.suffix == ".png"))):
                raise RuntimeError("report must not overwrite source or output artifacts")
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
