# SPDX-License-Identifier: MIT
"""Synthetic textured metric box and PNG still for the full companion job."""
from pathlib import Path
import sys
from PIL import Image
from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade, UsdUtils
root = Path(sys.argv[1]); root.mkdir(parents=True, exist_ok=True)
image = Image.new('RGB', (32, 32), 'white')
for x in range(10, 22):
    for y in range(14, 18): image.putpixel((x, y), (10, 10, 10))
image.save(root/'synthetic.png')
stage = Usd.Stage.CreateNew(str(root/'source.usdc'))
UsdGeom.SetStageMetersPerUnit(stage, .001)
UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
mesh = UsdGeom.Mesh.Define(stage, '/Box')
mesh.GetSubdivisionSchemeAttr().Set('none')
mesh.GetPointsAttr().Set([Gf.Vec3f(x, y, z) for z in (0, 21) for y in (0, 42) for x in (0, 63)])
faces = [0,2,3,1,4,5,7,6,0,1,5,4,2,6,7,3,0,4,6,2,1,3,7,5]
mesh.GetFaceVertexCountsAttr().Set([4]*6)
mesh.GetFaceVertexIndicesAttr().Set(faces)
uv = UsdGeom.PrimvarsAPI(mesh).CreatePrimvar('st', Sdf.ValueTypeNames.TexCoord2fArray, 'faceVarying')
uv.Set([Gf.Vec2f(*p) for p in [(0,0),(1,0),(1,1),(0,1)]*6])
mat = UsdShade.Material.Define(stage, '/Skin')
surface = UsdShade.Shader.Define(stage, '/Skin/Surface'); surface.CreateIdAttr('UsdPreviewSurface')
tex = UsdShade.Shader.Define(stage, '/Skin/Tex'); tex.CreateIdAttr('UsdUVTexture')
tex.CreateInput('file', Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath('./synthetic.png'))
for name in ('wrapS', 'wrapT'): tex.CreateInput(name, Sdf.ValueTypeNames.Token).Set('repeat')
reader = UsdShade.Shader.Define(stage, '/Skin/UV'); reader.CreateIdAttr('UsdPrimvarReader_float2')
reader.CreateInput('varname', Sdf.ValueTypeNames.String).Set('st')
tex.CreateInput('st', Sdf.ValueTypeNames.Float2).ConnectToSource(reader.ConnectableAPI(), 'result')
surface.CreateInput('diffuseColor', Sdf.ValueTypeNames.Color3f).ConnectToSource(tex.ConnectableAPI(), 'rgb')
mat.CreateSurfaceOutput().ConnectToSource(surface.ConnectableAPI(), 'surface')
UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(mat)
stage.SetDefaultPrim(mesh.GetPrim()); stage.GetRootLayer().Save()
assert UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(str(root/'source.usdc')), str(root/'capture.usdz'))
