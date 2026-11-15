#!/usr/bin/env python3
"""A scan shaped like a Mac's Object Capture rebuild (#852): one textured mesh in metres, Y up, packaged as USDZ.

    make_rebuild_fixture.py <out.usdz> [--texture-bytes N]

The object is an asymmetric box the size of a real rig rebuild (195.7 x 22.7 x 107 mm). `--texture-bytes` makes its
base colour an incompressible PNG of about that many bytes, so the same object can be packaged small or over the
converter's 32 MiB limit, as a full-detail rebuild is (its size is textures; the mesh is a few MB).
"""
import argparse
import math
import os
import sys
import tempfile
from pathlib import Path

from PIL import Image
from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade, UsdUtils

SIZE_M = (0.1957, 0.107, 0.0227)  # x, y (up), z


def build(out, texture_bytes):
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        side = max(2, math.ceil(math.sqrt(max(12, texture_bytes) / 3)))
        Image.frombytes("RGB", (side, side), os.urandom(side * side * 3)).save(tmp / "tex0.png", compress_level=0)
        stage = Usd.Stage.CreateNew(str(tmp / "baked_mesh.usdc"))
        UsdGeom.SetStageMetersPerUnit(stage, 1.0)
        UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
        root = UsdGeom.Xform.Define(stage, "/Root")
        stage.SetDefaultPrim(root.GetPrim())
        mesh = UsdGeom.Mesh.Define(stage, "/Root/Mesh")
        x, y, z = SIZE_M
        # Placed off the origin, as a rebuild is: the converter keeps world coordinates unrescaled.
        ox, oy, oz = 0.031, 0.012, -0.044
        corners = [(ox + a * x, oy + b * y, oz + c * z) for a in (0, 1) for b in (0, 1) for c in (0, 1)]
        mesh.CreatePointsAttr([Gf.Vec3f(*p) for p in corners])
        faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        mesh.CreateFaceVertexCountsAttr([4] * len(faces))
        mesh.CreateFaceVertexIndicesAttr([i for face in faces for i in face])
        mesh.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
        uv = UsdGeom.PrimvarsAPI(mesh).CreatePrimvar("st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.faceVarying)
        uv.Set([Gf.Vec2f(u, v) for _ in faces for u, v in ((0, 0), (1, 0), (1, 1), (0, 1))])
        material = UsdShade.Material.Define(stage, "/Root/Material")
        surface = UsdShade.Shader.Define(stage, "/Root/Material/Surface")
        surface.CreateIdAttr("UsdPreviewSurface")
        texture = UsdShade.Shader.Define(stage, "/Root/Material/Texture")
        texture.CreateIdAttr("UsdUVTexture")
        texture.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath("./tex0.png"))
        texture.CreateInput("wrapS", Sdf.ValueTypeNames.Token).Set("repeat")
        texture.CreateInput("wrapT", Sdf.ValueTypeNames.Token).Set("repeat")
        reader = UsdShade.Shader.Define(stage, "/Root/Material/UV")
        reader.CreateIdAttr("UsdPrimvarReader_float2")
        reader.CreateInput("varname", Sdf.ValueTypeNames.String).Set("st")
        texture.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(reader.ConnectableAPI(), "result")
        surface.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(texture.ConnectableAPI(), "rgb")
        material.CreateSurfaceOutput().ConnectToSource(surface.ConnectableAPI(), "surface")
        UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(material)
        stage.GetRootLayer().Save()
        if not UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(str(tmp / "baked_mesh.usdc")), str(out)):
            raise RuntimeError(f"usdz packaging failed: {out}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out")
    parser.add_argument("--texture-bytes", type=int, default=12)
    args = parser.parse_args()
    build(Path(args.out), args.texture_bytes)
    return 0


if __name__ == "__main__":
    sys.exit(main())
