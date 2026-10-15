#!/usr/bin/env python3
"""Generate synthetic asymmetric .usdz fixtures (binary USDC) with pxr."""
import sys
import tempfile
from pathlib import Path

from pxr import Gf, Sdf, Usd, UsdGeom, UsdUtils

# Asymmetric box 1 x 2 x 3, outward-facing CCW (right-handed) quads.
BOX_POINTS = [(0, 0, 0), (1, 0, 0), (1, 2, 0), (0, 2, 0),
              (0, 0, 3), (1, 0, 3), (1, 2, 3), (0, 2, 3)]
BOX_FACES = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
             (3, 7, 6, 2), (0, 4, 7, 3), (1, 2, 6, 5)]


def add_box(stage, path, size=(1, 2, 3), scheme=UsdGeom.Tokens.none):
    mesh = UsdGeom.Mesh.Define(stage, path)
    mesh.CreatePointsAttr([Gf.Vec3f(x * size[0], y * size[1] / 2, z * size[2] / 3)
                           for x, y, z in BOX_POINTS])
    mesh.CreateFaceVertexCountsAttr([4] * 6)
    mesh.CreateFaceVertexIndicesAttr([i for f in BOX_FACES for i in f])
    if scheme is not None:
        mesh.CreateSubdivisionSchemeAttr(scheme)
    return mesh


def _package(build, out_usdz):
    with tempfile.TemporaryDirectory() as d:
        usdc = Path(d) / (Path(out_usdz).stem + ".usdc")
        layer = Sdf.Layer.CreateNew(str(usdc), args={"format": "usdc"})
        stage = Usd.Stage.Open(layer)
        build(stage)
        stage.GetRootLayer().Save()
        if not UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(str(usdc)), str(out_usdz)):
            raise RuntimeError(f"usdz packaging failed: {out_usdz}")
    return Path(out_usdz)


def _units(stage, mpu=0.01, up=UsdGeom.Tokens.z):
    UsdGeom.SetStageMetersPerUnit(stage, mpu)
    UsdGeom.SetStageUpAxis(stage, up)


def build_nested_multi(stage):
    """/A: scale(2,1,1) then rotateZ 90; /A/B: rotateX 90 then translate(10,0,0).
    Expected world bounds of /A/B/Box: min (0,20,0) max (3,22,2).
    /Second: translate(100,0,0), box 1x2x3 -> min (100,0,0) max (101,2,3)."""
    _units(stage)
    a = UsdGeom.Xform.Define(stage, "/A")
    a.AddRotateZOp().Set(90.0)
    a.AddScaleOp().Set(Gf.Vec3f(2, 1, 1))
    b = UsdGeom.Xform.Define(stage, "/A/B")
    b.AddTranslateOp().Set(Gf.Vec3d(10, 0, 0))
    b.AddRotateXOp().Set(90.0)
    add_box(stage, "/A/B/Box")
    s = UsdGeom.Xform.Define(stage, "/Second")
    s.AddTranslateOp().Set(Gf.Vec3d(100, 0, 0))
    add_box(stage, "/Second/Box")
    stage.SetDefaultPrim(a.GetPrim())


def build_reflected(stage):
    """/M: scale(-1,1,1). Expected bounds min (-1,0,0) max (0,2,3), cm."""
    _units(stage)
    m = UsdGeom.Xform.Define(stage, "/M")
    m.AddScaleOp().Set(Gf.Vec3f(-1, 1, 1))
    add_box(stage, "/M/Box")
    stage.SetDefaultPrim(m.GetPrim())


def build_no_units(stage):
    """No metersPerUnit/upAxis authored. Box bounds (0,0,0)-(1,2,3)."""
    add_box(stage, "/Box")
    stage.SetDefaultPrim(stage.GetPrimAtPath("/Box"))


def build_subdiv(stage):
    _units(stage)
    add_box(stage, "/Box").GetSubdivisionSchemeAttr().Set(UsdGeom.Tokens.catmullClark)


def build_unauthored_subdiv(stage):
    """subdivisionScheme not authored (USD fallback catmullClark): treated as polygonal."""
    _units(stage)
    add_box(stage, "/Box", scheme=None)


def build_holes(stage):
    """Box + one extra quad marked as a hole (face 6) + one 2-vertex degenerate face (face 7)."""
    _units(stage)
    m = add_box(stage, "/Box")
    m.GetFaceVertexCountsAttr().Set([4] * 7 + [2])
    m.GetFaceVertexIndicesAttr().Set([i for f in BOX_FACES for i in f] + [0, 1, 2, 3, 0, 1])
    m.CreateHoleIndicesAttr([6])


def build_purpose(stage):
    """Default-purpose box; guide/proxy/render-purpose meshes and an inactive mesh far away."""
    _units(stage)
    add_box(stage, "/Box")
    for i, p in enumerate(("guide", "proxy", "render")):
        g = add_box(stage, f"/P_{p}")
        g.CreatePurposeAttr(p)
        UsdGeom.Xformable(g).AddTranslateOp().Set(Gf.Vec3d(1000 * (i + 1), 0, 0))
    off = add_box(stage, "/Inactive")
    UsdGeom.Xformable(off).AddTranslateOp().Set(Gf.Vec3d(-1000, 0, 0))
    off.GetPrim().SetActive(False)


def build_animated_topology(stage):
    _units(stage)
    m = add_box(stage, "/Box")
    m.GetFaceVertexIndicesAttr().Set([i for f in BOX_FACES for i in f], Usd.TimeCode(1))


FIXTURES = {"unauthored_subdiv": build_unauthored_subdiv, "holes": build_holes,
            "purpose": build_purpose, "animated_topology": build_animated_topology,
"nested_multi": build_nested_multi, "reflected": build_reflected,
            "no_units": build_no_units, "subdiv": build_subdiv}


def make_all(out_dir):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    return {n: _package(b, out_dir / f"{n}.usdz") for n, b in FIXTURES.items()}


if __name__ == "__main__":
    for name, p in make_all(sys.argv[1] if len(sys.argv) > 1 else "fixtures").items():
        print(name, p)
