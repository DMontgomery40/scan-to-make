# SPDX-License-Identifier: MIT
"""Invented rounded box with smooth lumps, generated with stdlib math only."""
import math
from pathlib import Path


def lumpy_box(directory):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    vertices=[];indices={};faces=[];n=12
    def vertex(point):
        inner=(8,4,2)
        nearest=[max(-inner[i],min(inner[i],point[i])) for i in range(3)]
        delta=[point[i]-nearest[i] for i in range(3)]
        length=math.sqrt(sum(v*v for v in delta))
        value=[nearest[i]+2*delta[i]/length for i in range(3)]
        if point[0]>9.99:value[0]+=.4*math.exp(-(point[1]**2+point[2]**2)/3)
        key=tuple(round(v,7) for v in value)
        if key not in indices:indices[key]=len(vertices)+1;vertices.append(key)
        return indices[key]
    # Mapping tangents have outward cross products for the positive faces.
    for axis in range(3):
        u,v=(axis+1)%3,(axis+2)%3
        ext=(10,6,4)
        for sign in (-1,1):
            grid=[]
            for i in range(n+1):
                row=[]
                for j in range(n+1):
                    p=[0,0,0];p[axis]=sign*ext[axis];p[u]=-ext[u]+2*ext[u]*i/n;p[v]=-ext[v]+2*ext[v]*j/n
                    row.append(vertex(p))
                grid.append(row)
            for i in range(n):
                for j in range(n):
                    face=[grid[i][j],grid[i+1][j],grid[i+1][j+1],grid[i][j+1]]
                    face=face if sign>0 else list(reversed(face))
                    faces.extend((face[:3],[face[0],face[2],face[3]]))
    path=directory/'lumpy.obj'
    path.write_text(''.join('v %s %s %s\n'%p for p in vertices)+''.join('f '+' '.join(map(str,f))+'\n' for f in faces))
    return path


def usdz_from_obj(mesh,destination):
    # Optional existing converter test runtime; no model or capture data.
    from pxr import Usd, UsdGeom, UsdUtils, UsdShade, Sdf
    from PIL import Image
    points=[];indices=[];counts=[]
    for line in mesh.read_text().splitlines():
        f=line.split()
        if f and f[0]=='v':points.append(tuple(map(float,f[1:4])))
        elif f and f[0]=='f':counts.append(len(f)-1);indices.extend(int(v)-1 for v in f[1:])
    layer=destination.with_suffix('.usdc');stage=Usd.Stage.CreateNew(str(layer))
    UsdGeom.SetStageMetersPerUnit(stage,.001);UsdGeom.SetStageUpAxis(stage,'Z')
    obj=UsdGeom.Mesh.Define(stage,'/Synthetic');obj.CreatePointsAttr(points)
    obj.CreateFaceVertexCountsAttr(counts);obj.CreateFaceVertexIndicesAttr(indices)
    obj.CreateSubdivisionSchemeAttr('none')
    texture=destination.parent/'synthetic.png';Image.new('RGB',(2,2),(180,180,180)).save(texture)
    UsdGeom.PrimvarsAPI(obj).CreatePrimvar('st',Sdf.ValueTypeNames.TexCoord2fArray,'constant').Set([(.5,.5)])
    material=UsdShade.Material.Define(stage,'/Material')
    surface=UsdShade.Shader.Define(stage,'/Material/Surface');surface.CreateIdAttr('UsdPreviewSurface')
    sampler=UsdShade.Shader.Define(stage,'/Material/Texture');sampler.CreateIdAttr('UsdUVTexture')
    sampler.CreateInput('file',Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath('./synthetic.png'))
    for wrap in ('wrapS','wrapT'):sampler.CreateInput(wrap,Sdf.ValueTypeNames.Token).Set('repeat')
    reader=UsdShade.Shader.Define(stage,'/Material/UV');reader.CreateIdAttr('UsdPrimvarReader_float2')
    reader.CreateInput('varname',Sdf.ValueTypeNames.String).Set('st')
    sampler.CreateInput('st',Sdf.ValueTypeNames.Float2).ConnectToSource(reader.ConnectableAPI(),'result')
    surface.CreateInput('diffuseColor',Sdf.ValueTypeNames.Color3f).ConnectToSource(sampler.ConnectableAPI(),'rgb')
    material.CreateSurfaceOutput().ConnectToSource(surface.ConnectableAPI(),'surface')
    UsdShade.MaterialBindingAPI.Apply(obj.GetPrim()).Bind(material)
    stage.GetRootLayer().Save()
    assert UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(str(layer)),str(destination))
    return destination
