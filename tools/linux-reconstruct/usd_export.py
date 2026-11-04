"""Metric USDZ export: explicit metres, Y-up, right-handed, polygonal.

The stage authors metersPerUnit=1.0 and upAxis=Y and every mesh authors
subdivisionScheme=none (an unauthored scheme means catmullClark in OpenUSD,
which downstream metric tooling rightly refuses). Faces are emitted
counter-clockwise when viewed from outside (USD right-handed winding);
the caller guarantees outward orientation via signed volume. The file is
reopened and checked before the caller may publish it.
"""
import math
from pathlib import Path

_pxr = None


def _load_pxr():
    global _pxr
    if _pxr is None:
        try:
            from pxr import Gf, Usd, UsdGeom, UsdUtils, Vt
        except ImportError as e:
            raise RuntimeError(
                "USD runtime unavailable (pip install usd-core): " + str(e)) from e
        _pxr = (Gf, Usd, UsdGeom, UsdUtils, Vt)
    return _pxr


def export_usdz(mesh, usdc_path, usdz_path):
    """Write mesh (already in metres) to usdc_path, package as usdz_path,
    then validate the package by reopening it. Raises on any mismatch."""
    Gf, Usd, UsdGeom, UsdUtils, Vt = _load_pxr()
    usdc_path, usdz_path = Path(usdc_path), Path(usdz_path)
    stage = Usd.Stage.CreateNew(str(usdc_path))
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
    root = UsdGeom.Xform.Define(stage, "/Scan")
    stage.SetDefaultPrim(root.GetPrim())
    prim = UsdGeom.Mesh.Define(stage, "/Scan/Mesh")
    prim.CreatePointsAttr(Vt.Vec3fArray([Gf.Vec3f(*v) for v in mesh.vertices]))
    prim.CreateFaceVertexCountsAttr(Vt.IntArray([3] * len(mesh.faces)))
    prim.CreateFaceVertexIndicesAttr(
        Vt.IntArray([i for face in mesh.faces for i in face]))
    prim.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
    lo = [min(v[i] for v in mesh.vertices) for i in range(3)]
    hi = [max(v[i] for v in mesh.vertices) for i in range(3)]
    prim.CreateExtentAttr([Gf.Vec3f(*lo), Gf.Vec3f(*hi)])
    stage.Save()
    if not UsdUtils.CreateNewUsdzPackage(str(usdc_path), str(usdz_path)):
        raise RuntimeError("USDZ packaging failed")
    validate_usdz(usdz_path, expect_vertices=len(mesh.vertices),
                  expect_faces=len(mesh.faces))


def read_usdz_mesh(usdz_path):
    """All mesh prims of a USD/USDZ merged into one mesh in world (stage)
    coordinates: points composed through each prim's local-to-world
    transform exactly once, faces triangulated as fans. Units are whatever
    the source stage used; callers must not assume metres. Raises on
    non-finite or missing geometry. Returns (vertices, faces).
    """
    Gf, Usd, UsdGeom, _uu, _vt = _load_pxr()
    stage = Usd.Stage.Open(str(usdz_path))
    if stage is None:
        raise RuntimeError("input USDZ does not open")
    cache = UsdGeom.XformCache()
    vertices, faces = [], []
    for prim in stage.Traverse():
        if not prim.IsA(UsdGeom.Mesh):
            continue
        mesh = UsdGeom.Mesh(prim)
        points = mesh.GetPointsAttr().Get()
        counts = mesh.GetFaceVertexCountsAttr().Get()
        indices = mesh.GetFaceVertexIndicesAttr().Get()
        if points is None or counts is None or indices is None:
            raise RuntimeError("input USDZ mesh is missing geometry attributes")
        matrix = cache.GetLocalToWorldTransform(prim)
        base = len(vertices)
        for p in points:
            w = matrix.Transform(Gf.Vec3d(float(p[0]), float(p[1]), float(p[2])))
            v = (float(w[0]), float(w[1]), float(w[2]))
            if not all(math.isfinite(c) for c in v):
                raise RuntimeError("input USDZ contains non-finite points")
            vertices.append(v)
        offset = 0
        for count in counts:
            face = [base + int(i) for i in indices[offset:offset + count]]
            offset += count
            for k in range(1, count - 1):
                faces.append((face[0], face[k], face[k + 1]))
    if not faces:
        raise RuntimeError("input USDZ contains no mesh faces")
    return vertices, faces


def validate_usdz(usdz_path, expect_vertices=None, expect_faces=None):
    Gf, Usd, UsdGeom, UsdUtils, Vt = _load_pxr()
    stage = Usd.Stage.Open(str(usdz_path))
    if stage is None:
        raise RuntimeError("exported USDZ does not reopen")
    if not stage.HasAuthoredMetadata("metersPerUnit") \
            or abs(UsdGeom.GetStageMetersPerUnit(stage) - 1.0) > 1e-12:
        raise RuntimeError("exported USDZ does not author metersPerUnit=1")
    if not stage.HasAuthoredMetadata("upAxis") \
            or str(UsdGeom.GetStageUpAxis(stage)) != "Y":
        raise RuntimeError("exported USDZ does not author upAxis=Y")
    meshes = [p for p in stage.Traverse() if p.IsA(UsdGeom.Mesh)]
    if len(meshes) != 1:
        raise RuntimeError(f"exported USDZ has {len(meshes)} meshes, expected 1")
    mesh = UsdGeom.Mesh(meshes[0])
    if str(mesh.GetSubdivisionSchemeAttr().Get()) != "none":
        raise RuntimeError("exported mesh does not author subdivisionScheme=none")
    points = mesh.GetPointsAttr().Get()
    counts = mesh.GetFaceVertexCountsAttr().Get()
    indices = mesh.GetFaceVertexIndicesAttr().Get()
    if points is None or counts is None or indices is None:
        raise RuntimeError("exported mesh is missing geometry attributes")
    if expect_vertices is not None and len(points) != expect_vertices:
        raise RuntimeError("exported vertex count changed")
    if expect_faces is not None and len(counts) != expect_faces:
        raise RuntimeError("exported face count changed")
    if any(c != 3 for c in counts) or len(indices) != 3 * len(counts):
        raise RuntimeError("exported mesh is not all triangles")
    if any(i < 0 or i >= len(points) for i in indices):
        raise RuntimeError("exported mesh has out-of-range indices")
    if any(not all(math.isfinite(c) for c in p) for p in points):
        raise RuntimeError("exported mesh has non-finite points")
    if str(mesh.GetOrientationAttr().Get() or "rightHanded") != "rightHanded":
        raise RuntimeError("exported mesh orientation is not rightHanded")
    return {"vertices": len(points), "faces": len(counts)}
