"""Synthetic packaged textures; independent OBJ/MTL checks, no personal captures."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from convert import convert
from make_fixtures import add_box, BOX_FACES
try:
    from PIL import Image
except ImportError:
    Image = None
from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade, UsdUtils


@unittest.skipUnless(Image is not None, "Pillow absent; install converter requirements for texture tests")
class TextureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.source = self.base/'source'
        self.source.mkdir()
        self.output = self.base/'out'
        self.output.mkdir()

    def fixture(self, mode='faceVarying', indexed=True, reflected=False,
                kind='PNG', bad=None, multiple=False, inherited=False, concave=False, wraps=None, outside=False, wrap_metadata=None,
                surface_maps=None):
        texture = self.source/('colour.png' if kind == 'PNG' else 'colour.jpg')
        image = Image.new('RGB',(2,2))
        image.putdata([(255,0,0),(0,255,0),(0,0,255),(255,255,0)])
        if wrap_metadata:
            from PIL.PngImagePlugin import PngInfo
            info = PngInfo()
            for name,value in wrap_metadata.items():
                info.add_text(name,value)
            image.save(texture,format=kind,pnginfo=info)
        else:
            image.save(texture,format=kind)
        stage = Usd.Stage.CreateNew(str(self.source/'root.usdc'))
        UsdGeom.SetStageMetersPerUnit(stage,.01)
        UsdGeom.SetStageUpAxis(stage,UsdGeom.Tokens.z)
        mesh = add_box(stage,'/Box')
        if concave:
            mesh.GetPointsAttr().Set([Gf.Vec3f(x,y,0) for x,y in [(0,0),(2,0),(2,1),(1,1),(1,2),(0,2)]])
            mesh.GetFaceVertexCountsAttr().Set([6])
            mesh.GetFaceVertexIndicesAttr().Set(list(range(6)))
        if reflected:
            UsdGeom.Xformable(mesh).AddScaleOp().Set(Gf.Vec3f(-1,1,1))
        count = {'faceVarying':24,'vertex':8,'varying':8,'uniform':6,'constant':1}[mode]
        if concave:
            count = 6
        values = [(i/(count+1),1-i/(count+1)) for i in range(count)]
        if outside:
            values[0] = (-.25,1.25)
        pv = UsdGeom.PrimvarsAPI(mesh).CreatePrimvar('uvCapture',Sdf.ValueTypeNames.TexCoord2fArray,mode)
        pv.Set([Gf.Vec2f(*v) for v in (values[::-1] if indexed else values)])
        if indexed:
            pv.SetIndices(list(range(count-1,-1,-1)))
        if bad == 'indices':
            pv.SetIndices([99]*count)
        if bad == 'cardinality':
            pv.Set([Gf.Vec2f(0,0)])
            pv.BlockIndices()
        if bad == 'nan':
            pv.Set([Gf.Vec2f(float('nan'),0)]*count)
            pv.BlockIndices()
        if bad == 'animated':
            pv.GetAttr().Set([Gf.Vec2f(0,0)]*count,Usd.TimeCode(1))
        mat = UsdShade.Material.Define(stage,'/Material')
        surface = UsdShade.Shader.Define(stage,'/Material/Surface')
        surface.CreateIdAttr('UsdPreviewSurface')
        tex = UsdShade.Shader.Define(stage,'/Material/Texture')
        tex.CreateIdAttr('UsdUVTexture')
        for name,value in (wraps or {}).items():
            tex.CreateInput(name,Sdf.ValueTypeNames.Token).Set(value)
        tex.CreateInput('file',Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath('./'+texture.name))
        reader = UsdShade.Shader.Define(stage,'/Material/UV')
        reader.CreateIdAttr('UsdPrimvarReader_float2')
        reader.CreateInput('varname',Sdf.ValueTypeNames.String).Set('uvCapture')
        tex.CreateInput('st',Sdf.ValueTypeNames.Float2).ConnectToSource(reader.ConnectableAPI(),'result')
        surface.CreateInput('diffuseColor',Sdf.ValueTypeNames.Color3f).ConnectToSource(tex.ConnectableAPI(),'rgb')
        mat.CreateSurfaceOutput().ConnectToSource(surface.ConnectableAPI(),'surface')
        # Object Capture's graph: normal (scale 2, bias -1, raw) and occlusion (raw) maps on the same UVs.
        for role,output,varname in (surface_maps or []):
            image = Image.new('RGB' if output == 'rgb' else 'L',(4,4),(128,128,255) if output == 'rgb' else 200)
            image.save(self.source/f'{role}.png')
            shader = UsdShade.Shader.Define(stage,f'/Material/{role}_texture')
            shader.CreateIdAttr('UsdUVTexture')
            shader.CreateInput('file',Sdf.ValueTypeNames.Asset).Set(Sdf.AssetPath(f'./{role}.png'))
            shader.CreateInput('sourceColorSpace',Sdf.ValueTypeNames.Token).Set('raw')
            if role == 'normal':
                shader.CreateInput('scale',Sdf.ValueTypeNames.Float4).Set(Gf.Vec4f(2,2,2,2))
                shader.CreateInput('bias',Sdf.ValueTypeNames.Float4).Set(Gf.Vec4f(-1,-1,-1,-1))
            uv = reader
            if varname != 'uvCapture':
                uv = UsdShade.Shader.Define(stage,f'/Material/{role}_uv')
                uv.CreateIdAttr('UsdPrimvarReader_float2')
                uv.CreateInput('varname',Sdf.ValueTypeNames.String).Set(varname)
            shader.CreateInput('st',Sdf.ValueTypeNames.Float2).ConnectToSource(uv.ConnectableAPI(),'result')
            kind_ = Sdf.ValueTypeNames.Normal3f if role == 'normal' else Sdf.ValueTypeNames.Float
            surface.CreateInput(role,kind_).ConnectToSource(shader.ConnectableAPI(),output)
        UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(mat)
        if bad == 'graph':
            tex.CreateInput('scale',Sdf.ValueTypeNames.Float4).Set(Gf.Vec4f(2,1,1,1))
        if bad == 'hole':
            mesh.CreateHoleIndicesAttr([0])
        if bad == 'late_geometry':
            broken = add_box(stage,'/Broken')
            broken.GetFaceVertexIndicesAttr().Set([99]*24)
        if bad == 'missing_uv':
            mesh.GetPrim().RemoveProperty('primvars:uvCapture')
        if multiple:
            second = add_box(stage,'/Second')
            UsdGeom.Xformable(second).AddTranslateOp().Set(Gf.Vec3d(5,0,0))
            uv = UsdGeom.PrimvarsAPI(second).CreatePrimvar('uvCapture',Sdf.ValueTypeNames.TexCoord2fArray,'vertex')
            uv.Set([Gf.Vec2f(0,0)]*8)
            UsdShade.MaterialBindingAPI.Apply(second.GetPrim()).Bind(mat)
            add_box(stage,'/Unbound')
        if inherited:
            parent = UsdGeom.Xform.Define(stage,'/Parent')
            parent_uv = UsdGeom.PrimvarsAPI(parent).CreatePrimvar('uvCapture',Sdf.ValueTypeNames.TexCoord2fArray,'constant')
            parent_uv.Set([Gf.Vec2f(.25,.75)])
            child = add_box(stage,'/Parent/Child')
            UsdShade.MaterialBindingAPI.Apply(parent.GetPrim()).Bind(mat)
            interface = mat.CreateInput('frame:stPrimvarName',Sdf.ValueTypeNames.String)
            interface.Set('uvCapture')
            reader.GetInput('varname').ConnectToSource(interface)
        stage.SetDefaultPrim(mesh.GetPrim())
        stage.GetRootLayer().Save()
        package = self.base/'capture.usdz'
        if bad in ('external','missing'):
            tex.GetInput('file').Set(Sdf.AssetPath(str(texture if bad=='external' else self.source/'absent.png')))
            stage.GetRootLayer().Save()
            writer = Sdf.ZipFileWriter.CreateNew(str(package))
            writer.AddFile(str(self.source/'root.usdc'),'root.usdc')
            writer.Save()
        else:
            self.assertTrue(UsdUtils.CreateNewUsdzPackage(Sdf.AssetPath(str(self.source/'root.usdc')),str(package)))
        return package,texture,values

    def decode(self,path):
        vertices,uvs,faces,assignments = [],[],[],[]
        material = None
        for line in path.read_text().splitlines():
            fields = line.split()
            if fields[0] == 'v': vertices.append(tuple(map(float,fields[1:])))
            elif fields[0] == 'vt': uvs.append(tuple(map(float,fields[1:])))
            elif fields[0] == 'usemtl': material = fields[1]
            elif fields[0] == 'f':
                faces.append([tuple(int(i)-1 for i in f.split('/')) for f in fields[1:]])
                assignments.append(material)
        return vertices,uvs,faces,assignments

    def test_indexed_corner_uvs_survive_reflection_and_triangulation(self):
        package,texture,values = self.fixture(reflected=True)
        out = self.output/'capture.obj'
        report = convert(package,out)
        vertices,uvs,faces,_ = self.decode(out)
        self.assertTrue(report['metricQualified'])
        self.assertEqual(len(uvs),24)
        self.assertEqual(len(faces),12)
        for face in faces:
            source_face = face[0][1]//4
            for vi,ti in face:
                self.assertEqual(ti//4,source_face)
                self.assertEqual(vi,BOX_FACES[source_face][ti%4])
                self.assertAlmostEqual(uvs[ti][0],values[ti][0],places=6)
        volume = sum((vertices[f[0][0]][0]*(vertices[f[1][0]][1]*vertices[f[2][0]][2]-vertices[f[1][0]][2]*vertices[f[2][0]][1])
                      -vertices[f[0][0]][1]*(vertices[f[1][0]][0]*vertices[f[2][0]][2]-vertices[f[1][0]][2]*vertices[f[2][0]][0])
                      +vertices[f[0][0]][2]*(vertices[f[1][0]][0]*vertices[f[2][0]][1]-vertices[f[1][0]][1]*vertices[f[2][0]][0]))/6 for f in faces)
        self.assertAlmostEqual(volume,6)
        png = self.output/'capture_basecolor_0.png'
        self.assertEqual(png.read_bytes(),texture.read_bytes())
        self.assertIn('map_Kd -clamp off capture_basecolor_0.png',(self.output/'capture.mtl').read_text())
        self.assertIn('mtllib capture.mtl',out.read_text())
        for artifact in report['outputs']:
            data = (self.output/artifact['path']).read_bytes()
            self.assertEqual(artifact['sha256'],hashlib.sha256(data).hexdigest())
            self.assertEqual(artifact['bytes'],len(data))
        self.assertEqual(len(report['outputs']),3)
        with zipfile.ZipFile(package) as z:
            for layer in report['contributingLayers']:
                self.assertEqual(layer['sha256'],hashlib.sha256(z.read(layer['identifier'])).hexdigest())
        self.assertEqual(report,convert(package,out))

    def test_missing_wrap_outside_unit_square_is_not_silently_qualified(self):
        package,_,_ = self.fixture(outside=True)
        report = convert(package,self.output/'capture.obj')
        self.assertFalse(report['metricQualified'])
        self.assertTrue(any('wrapping' in u['detail'] and 'black' in u['detail']
                            for u in report['unsupportedFeatures']))
        self.assertTrue(any('wrap' in w and 'repeat' in w for w in report['warnings']))
        self.assertTrue((self.output/'capture_basecolor_0.png').exists())

    def test_explicit_repeat_accepts_outside_uvs(self):
        package,_,_ = self.fixture(outside=True,wraps={'wrapS':'repeat','wrapT':'repeat'})
        report = convert(package,self.output/'capture.obj')
        self.assertTrue(report['metricQualified'])
        self.assertEqual(report['warnings'],[])

    def test_use_metadata_black_border_and_repeat_metadata(self):
        for metadata in (None, {'wrapS':'repeat','wrapT':'repeat'}):
            with self.subTest(metadata=metadata):
                package,_,_ = self.fixture(outside=True,wraps={'wrapS':'useMetadata','wrapT':'useMetadata'},
                                           wrap_metadata=metadata)
                report = convert(package,self.output/'capture.obj')
                self.assertEqual(report['metricQualified'],metadata is not None)
                self.assertEqual(report['materials'][0]['wrapModes'],
                                 ['repeat','repeat'] if metadata else ['black','black'])

    def test_all_uv_interpolations(self):
        for mode in ('constant','uniform','vertex','varying','faceVarying'):
            with self.subTest(mode=mode):
                package,_,values = self.fixture(mode=mode,indexed=False)
                out = self.output/'capture.obj'
                convert(package,out)
                _,uvs,faces,_ = self.decode(out)
                for face in faces:
                    for vi,ti in face:
                        fi = ti//4
                        index = {'constant':0,'uniform':fi,'vertex':vi,'varying':vi,'faceVarying':ti}[mode]
                        self.assertAlmostEqual(uvs[ti][0],values[index][0],places=6)

    def test_jpeg_becomes_png_without_uv_flip(self):
        package,texture,_ = self.fixture(kind='JPEG')
        r = convert(package,self.output/'capture.obj')
        with Image.open(texture) as original,Image.open(self.output/'capture_basecolor_0.png') as output:
            self.assertEqual(output.format,'PNG')
            self.assertEqual(original.tobytes(),output.tobytes())
        self.assertEqual(r['materials'][0]['sourceFormat'],'JPEG')

    def test_normal_and_occlusion_maps_are_kept_beside_base_colour(self):
        package,_,_ = self.fixture(surface_maps=[('normal','rgb','uvCapture'),('occlusion','r','uvCapture')])
        r = convert(package,self.output/'capture.obj')
        maps = {m['role']:m for m in r['materials'][0]['surfaceMaps']}
        self.assertEqual(set(maps),{'normal','occlusion'})
        self.assertEqual(maps['normal']['textureOutput'],'capture_normal_0.png')
        self.assertEqual((maps['normal']['scale'],maps['normal']['bias']),([2,2,2,2],[-1,-1,-1,-1]))
        self.assertEqual((maps['normal']['uvPrimvar'],maps['normal']['sourceColorSpace']),('uvCapture','raw'))
        self.assertEqual(maps['occlusion']['textureOutput'],'capture_occlusion_0.png')
        for role in ('normal','occlusion'):
            data = (self.output/f'capture_{role}_0.png').read_bytes()
            self.assertEqual(data,(self.source/f'{role}.png').read_bytes())
            self.assertIn({'path':f'capture_{role}_0.png','sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)},r['outputs'])
        # The MTL stays base colour only: every OBJ reader sees what it saw before.
        mtl = (self.output/'capture.mtl').read_text()
        self.assertNotIn('normal',mtl)
        self.assertNotIn('occlusion',mtl)
        self.assertTrue(r['metricQualified'])

    def test_surface_map_on_other_uvs_is_left_out_with_a_warning(self):
        package,_,_ = self.fixture(surface_maps=[('normal','rgb','otherUVs')])
        r = convert(package,self.output/'capture.obj')
        self.assertEqual(r['materials'][0]['surfaceMaps'],[])
        self.assertTrue(any('normal map not exported' in w for w in r['warnings']),r['warnings'])
        self.assertFalse((self.output/'capture_normal_0.png').exists())
        self.assertTrue(r['metricQualified'])

    def test_multiple_mesh_uv_offsets_materials_and_reset(self):
        package,_,_ = self.fixture(multiple=True)
        r = convert(package,self.output/'capture.obj')
        _,uvs,faces,materials = self.decode(self.output/'capture.obj')
        self.assertEqual(materials,['material_0']*12+['material_1']*12+['unbound']*12)
        self.assertTrue(all(vi>=8 and ti>=24 for face in faces[12:24] for vi,ti in face))
        self.assertEqual(len(uvs),48)
        self.assertEqual(len(r['outputs']),4)

    def test_invalid_uvs_and_assets_write_nothing(self):
        for bad in ('indices','cardinality','nan','missing_uv','external','missing','late_geometry'):
            with self.subTest(bad=bad):
                package,_,_ = self.fixture(bad=bad)
                with self.assertRaises(RuntimeError):
                    convert(package,self.output/'capture.obj')
                self.assertEqual(list(self.output.iterdir()),[])

    def test_unsupported_graph_and_animated_uv_are_reported(self):
        for bad in ('graph','animated'):
            with self.subTest(bad=bad):
                package,_,_ = self.fixture(bad=bad)
                r = convert(package,self.output/'capture.obj')
                self.assertFalse(r['metricQualified'])
                self.assertIn('baseColour',[u['feature'] for u in r['unsupportedFeatures']])

    def test_concave_uvs_and_omitted_hole_corner_offsets(self):
        package,_,_ = self.fixture(concave=True)
        convert(package,self.output/'capture.obj')
        _,_,faces,_ = self.decode(self.output/'capture.obj')
        self.assertEqual(len(faces),4)
        self.assertTrue(all(vi == ti for face in faces for vi,ti in face))
        package,_,_ = self.fixture(bad='hole')
        r = convert(package,self.output/'capture.obj')
        _,_,faces,_ = self.decode(self.output/'capture.obj')
        self.assertEqual(len(faces),10)
        self.assertTrue(all(ti>=4 for face in faces for _,ti in face))
        self.assertFalse(r['metricQualified'])

    def test_inherited_uv_material_and_connected_varname(self):
        package,_,_ = self.fixture(inherited=True)
        r = convert(package,self.output/'capture.obj')
        self.assertTrue(r['metricQualified'])
        _,uvs,faces,materials = self.decode(self.output/'capture.obj')
        self.assertEqual(uvs[24:],[(.25,.75)]*24)
        self.assertEqual(materials[12:],['material_1']*12)

    def test_corrupt_texture_fails_before_writing(self):
        package,_,_ = self.fixture()
        # Repackage synthetic layer and invalid image as an aligned USDZ.
        with zipfile.ZipFile(package) as z:
            blobs = {n:z.read(n) for n in z.namelist()}
        corrupt = self.base/'corrupt.usdz'
        writer = Sdf.ZipFileWriter.CreateNew(str(corrupt))
        for name,data in blobs.items():
            path = self.base/('bad_'+Path(name).name)
            path.write_bytes(b'not an image' if name.endswith('.png') else data)
            writer.AddFile(str(path),name)
        writer.Save()
        with self.assertRaises(Exception):
            convert(corrupt,self.output/'capture.obj')
        self.assertEqual(list(self.output.iterdir()),[])

    @unittest.skipUnless(os.environ.get('BLENDER'), 'set BLENDER for actual OBJ/MTL/PNG import check')
    def test_blender_imports_serialized_uvs_and_texture(self):
        package,_,_ = self.fixture()
        out = self.output/'capture.obj'
        convert(package,out)
        script = self.base/'check_import.py'
        script.write_text("""import bpy, sys
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.wm.obj_import(filepath=sys.argv[-1],forward_axis='Y',up_axis='Z')
obj = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
assert len(obj.data.polygons) == 12
assert len(obj.data.uv_layers.active.data) == 36
images = [n.image for slot in obj.material_slots for n in slot.material.node_tree.nodes
          if n.type == 'TEX_IMAGE' and n.image]
assert len(images) == 1
assert tuple(images[0].size) == (2,2)
assert images[0].filepath.endswith('capture_basecolor_0.png')
""")
        result = subprocess.run([os.environ['BLENDER'],'--background','--factory-startup',
                                 '--python-exit-code','1','--python',str(script),'--',str(out)],
                                capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)

    def test_cli_report_cannot_overwrite_artifacts(self):
        package,_,_ = self.fixture()
        for report in (package,self.output/'capture.obj',self.output/'capture.mtl',self.output/'capture_basecolor_0.png'):
            result = subprocess.run([sys.executable,str(HERE/'convert.py'),str(package),'--out',str(self.output/'capture.obj'),
                                     '--report',str(report)],capture_output=True)
            self.assertEqual(result.returncode,2)
            self.assertEqual(list(self.output.iterdir()),[])


if __name__ == '__main__':
    unittest.main()
