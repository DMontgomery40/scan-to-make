# SPDX-License-Identifier: GPL-3.0-or-later
"""Blender-side geometry core. All coordinates and dimensional parameters are mm."""
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree


def write_json(path, data):
    Path(path).write_text(json.dumps(data, sort_keys=True, indent=2, allow_nan=False)+"\n")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(path, scale):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    suffix = Path(path).suffix.lower()
    if suffix == ".obj":
        bpy.ops.wm.obj_import(filepath=path, forward_axis="Y", up_axis="Z")
    elif suffix == ".stl":
        bpy.ops.wm.stl_import(filepath=path, forward_axis="Y", up_axis="Z")
    else:
        raise ValueError("only OBJ and STL inputs are supported")
    meshes = sorted((o for o in bpy.context.scene.objects if o.type=="MESH"), key=lambda o:o.name)
    if not meshes:
        raise ValueError("input has no mesh")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    obj = bpy.context.object
    bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
    for v in obj.data.vertices:
        v.co *= scale
        if not all(math.isfinite(x) for x in v.co):
            raise ValueError("nonfinite geometry")
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    if not bm.faces or any(f.calc_area() <= 1e-14 for f in bm.faces):
        raise ValueError("empty or degenerate input faces")
    bm.normal_update()
    return obj,bm


def components(bm):
    remaining = set(bm.verts)
    groups = []
    for seed in bm.verts:
        if seed not in remaining:
            continue
        remaining.remove(seed)
        group, stack = {seed}, [seed]
        while stack:
            v = stack.pop()
            for edge in v.link_edges:
                other = edge.other_vert(v)
                if other in remaining:
                    remaining.remove(other)
                    group.add(other)
                    stack.append(other)
        groups.append(group)
    return groups


def axes(bm):
    coords = np.array([tuple(v.co) for v in bm.verts])
    centre = coords.mean(axis=0)
    eigenvalues, basis = np.linalg.eigh(np.cov(coords.T, bias=True))
    basis = basis[:,np.argsort(-eigenvalues)]
    for i in range(3):
        if basis[np.argmax(np.abs(basis[:,i])),i] < 0:
            basis[:,i] *= -1
    if np.linalg.det(basis)<0:
        basis[:,2] *= -1
    return coords, centre, basis


def stats(bm):
    coords, centre, basis = axes(bm)
    principal = (coords-centre) @ basis
    boundary = sum(e.is_boundary for e in bm.edges)
    nonmanifold = sum(not e.is_manifold for e in bm.edges)
    inconsistent = sum(e.is_manifold and not e.is_contiguous for e in bm.edges)
    closed = bool(bm.faces) and nonmanifold==0 and inconsistent==0
    return {"vertices":len(bm.verts),"faces":len(bm.faces),"edges":len(bm.edges),
            "components":len(components(bm)),"boundaryEdges":boundary,
            "nonManifoldEdges":nonmanifold,"inconsistentWindingEdges":inconsistent,
            "watertight":closed,"bboxMm":{"min":coords.min(axis=0).tolist(),
            "max":coords.max(axis=0).tolist(),"extents":np.ptp(coords,axis=0).tolist()},
            "principalExtentsMm":np.ptp(principal,axis=0).tolist(),
            "volumeMm3":abs(bm.calc_volume(signed=True)) if closed else None,
            "surfaceAreaMm2":sum(f.calc_area() for f in bm.faces)}


def normals(bm):
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.normal_update()


def apply_modifier(obj,bm,kind, **params):
    bm.to_mesh(obj.data)
    modifier = obj.modifiers.new(kind,kind)
    for k,v in params.items():
        setattr(modifier,k,v)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bm.free()
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    normals(bm)
    return bm


def denoise(bm,a):
    original = {v:v.co.copy() for v in bm.verts}
    locked = {v for e in bm.edges if not e.is_manifold or e.calc_face_angle(0)>math.radians(a["sharp_angle_deg"]) for v in e.verts}
    for _ in range(a["denoise_iterations"]):
        positions = {}
        for v in bm.verts:
            if v in locked or not v.link_edges:
                continue
            avg = sum((e.other_vert(v).co for e in v.link_edges), Vector())/len(v.link_edges)
            delta = v.co.lerp(avg,a["denoise_factor"])-original[v]
            if delta.length > a["denoise_max_mm"]:
                delta = delta.normalized()*a["denoise_max_mm"]
            positions[v] = original[v]+delta
        for v,p in positions.items():
            v.co = p
    normals(bm)


def deviation(original, repaired, count):
    # Area-stratified triangle samples with a fixed low-discrepancy barycentric sequence.
    tri = original.copy()
    bmesh.ops.triangulate(tri,faces=list(tri.faces))
    tree = BVHTree.FromBMesh(repaired)
    faces = list(tri.faces)
    areas = np.array([f.calc_area() for f in faces])
    cumulative = np.cumsum(areas)
    distances = []
    for i in range(count):
        f = faces[int(np.searchsorted(cumulative,(i+.5)/count*cumulative[-1]))]
        u = math.sqrt(((i+.5)*.6180339887498949)%1)
        v = ((i+.5)*.7548776662466927)%1
        p = f.verts[0].co*(1-u)+f.verts[1].co*(u*(1-v))+f.verts[2].co*(u*v)
        hit = tree.find_nearest(p)
        distances.append(hit[3])
    # Include vertices so tiny deleted floaters cannot evade the sample set.
    distances += [tree.find_nearest(v.co)[3] for v in original.verts]
    tri.free()
    return {"direction":"original-to-repaired-before-orientation","surfaceSamples":count,
            "vertexSamples":len(original.verts),"meanMm":float(np.mean(distances)),
            "p95Mm":float(np.percentile(distances,95)),"maxMm":max(distances)}


def orient(bm):
    _, centre, basis = axes(bm)
    rotation = Matrix(basis.T.tolist())
    for v in bm.verts:
        v.co = rotation @ (v.co-Vector(centre))
    coords = np.array([tuple(v.co) for v in bm.verts])
    shift = Vector((-(coords[:,0].min()+coords[:,0].max())/2,
                    -(coords[:,1].min()+coords[:,1].max())/2,-coords[:,2].min()))
    for v in bm.verts:
        v.co += shift
    return {"rotation":list(map(list,rotation)),"inputCentreMm":centre.tolist(),"translationMm":list(shift),
            "method":"vertex-PCA descending eigenvalues; deterministic signs; ground Z=0; XY bbox centred"}


def export(bm,out):
    bm.verts.index_update()
    with (out/"repaired.obj").open("w") as f:
        f.write("# units: mm\n")
        for v in bm.verts:
            f.write("v "+" ".join(format(c,".9g") for c in v.co)+"\n")
        for face in bm.faces:
            f.write("f "+" ".join(str(v.index+1) for v in face.verts)+"\n")
    tri = bm.copy()
    bmesh.ops.triangulate(tri,faces=list(tri.faces))
    tri.normal_update()
    with (out/"repaired.stl").open("wb") as f:
        f.write(b"scan-repair preview; units mm".ljust(80,b"\0"))
        f.write(struct.pack("<I",len(tri.faces)))
        for face in tri.faces:
            f.write(struct.pack("<12fH",*face.normal,*(c for v in face.verts for c in v.co),0))
    tri.free()


def repair(obj,bm,a):
    before = stats(bm)
    original = bm.copy()
    ops = []
    bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=a["weld_mm"])
    ops.append({"name":"weld","distanceMm":a["weld_mm"]})
    removed = 0
    bm.verts.index_update()
    groups = components(bm)
    scores = []
    for group in groups:
        faces = [f for f in bm.faces if f.verts[0] in group]
        if a["component_metric"]=="volume":
            # Signed tetrahedron sum; reject volume ranking of open components.
            if any(not e.is_manifold for v in group for e in v.link_edges):
                raise ValueError("volume floater metric requires closed components; use area")
            keep = {v.index for v in group}
            part = bm.copy()
            bmesh.ops.delete(part,geom=[v for v in part.verts if v.index not in keep],context="VERTS")
            normals(part)
            score = abs(part.calc_volume(signed=True))
            part.free()
        else:
            score = sum(f.calc_area() for f in faces)
        scores.append(score)
    largest = max(scores)
    for group,score in zip(groups,scores):
        if score < largest*a["component_fraction"]:
            bmesh.ops.delete(bm,geom=list(group),context="VERTS")
            removed += 1
    ops.append({"name":"dropComponents","metric":a["component_metric"],"fractionOfLargest":a["component_fraction"],"removed":removed})
    filled = bmesh.ops.holes_fill(bm,edges=[e for e in bm.edges if e.is_boundary],sides=a["hole_max_edges"])
    normals(bm)
    ops.append({"name":"fillHoles","maxEdges":a["hole_max_edges"],"facesAdded":len(filled["faces"])})
    fallback = a["force_voxel"] or not stats(bm)["watertight"]
    if fallback:
        extent = max(stats(bm)["bboxMm"]["extents"])
        if extent/a["voxel_size_mm"] > 512:
            raise ValueError("voxel grid exceeds 512 cells per longest axis; increase voxel size")
        bm.to_mesh(obj.data)
        obj.data.remesh_voxel_size = a["voxel_size_mm"]
        obj.data.remesh_voxel_adaptivity = 0
        bpy.ops.object.voxel_remesh()
        bm.free()
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        normals(bm)
    ops.append({"name":"voxelRemesh","applied":fallback,"forced":a["force_voxel"],"voxelSizeMm":a["voxel_size_mm"],"adaptivity":0})
    denoise(bm,a)
    ops.append({"name":"denoise","iterations":a["denoise_iterations"],"factor":a["denoise_factor"],
                "maxDisplacementMm":a["denoise_max_mm"],"sharpAngleDeg":a["sharp_angle_deg"]})
    bmesh.ops.triangulate(bm,faces=list(bm.faces))
    ops.append({"name":"triangulate","quadMethod":"BEAUTY","ngonMethod":"BEAUTY"})
    target = a["target_faces"]
    ratio = min(1,target/len(bm.faces)) if target else 1
    if ratio < 1:
        bm = apply_modifier(obj,bm,"DECIMATE",ratio=ratio,use_collapse_triangulate=True)
    ops.append({"name":"decimate","targetFaces":target,"ratio":ratio})
    normals(bm)
    ops.append({"name":"recalculateNormals","method":"consistent face winding"})
    if not stats(bm)["watertight"]:
        raise ValueError("repair could not produce topologically watertight geometry; no successful report")
    dev = deviation(original,bm,a["deviation_samples"])
    original.free()
    transform = orient(bm)
    ops.append({"name":"orient",**transform})
    out = Path(a["out"])
    out.mkdir(parents=True,exist_ok=True)
    export(bm,out)
    return {"schemaVersion":1,"blenderVersion":bpy.app.version_string,"provesPhysicalAccuracy":False,
            "previewOnly":True,"inputSha256":sha(a["input"]),"inputScaleMm":a["scale_mm"],
            "outputUnits":"mm","outputSha256":{n:sha(out/n) for n in ("repaired.obj","repaired.stl")},
            "before":before,"after":stats(bm),"operations":ops,"deviation":dev,
            "limitations":["Topological watertightness does not detect self intersections or certify a valid solid.",
                           "PCA is ambiguous for symmetric objects and does not infer semantic upright.",
                           "One-sided sampled deviation can miss added geometry and unsampled defects."]}


def strip_png_metadata(path):
    """Keep image chunks byte-for-byte; remove Blender wall-clock metadata."""
    raw = Path(path).read_bytes()
    clean = bytearray(raw[:8])
    offset = 8
    while offset < len(raw):
        length = struct.unpack_from(">I",raw,offset)[0]
        end = offset+length+12
        if raw[offset+4:offset+8] not in (b"tEXt",b"zTXt",b"iTXt",b"tIME",b"eXIf"):
            clean.extend(raw[offset:end])
        offset = end
    Path(path).write_bytes(clean)


def render(obj,bm,a):
    orient(bm)
    bm.to_mesh(obj.data)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "SINGLE"
    scene.display.shading.single_color = (.65,.65,.65)
    scene.display.shading.show_shadows = False
    scene.display.shading.show_cavity = False
    scene.display.shading.show_specular_highlight = False
    scene.display.shading.background_type = "WORLD"
    scene.world.color = (.12,.12,.12)
    scene.render.resolution_x = scene.render.resolution_y = a["resolution"]
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    coords = [v.co for v in bm.verts]
    centre = sum(coords,Vector())/len(coords)
    radius = max((v-centre).length for v in coords)
    cam_data = bpy.data.cameras.new("canonical")
    cam = bpy.data.objects.new("canonical",cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = radius*2.4
    cam_data.clip_start = max(radius*.001,.0001)
    cam_data.clip_end = radius*20
    views = {"pos_x":(1,0,0),"neg_x":(-1,0,0),"pos_y":(0,1,0),"neg_y":(0,-1,0),
             "pos_z":(0,0,1),"neg_z":(0,0,-1),"iso_pp":(1,1,1),"iso_np":(-1,1,1),
             "iso_nn":(-1,-1,1),"iso_pn":(1,-1,1)}
    out = Path(a["out"])
    out.mkdir(parents=True,exist_ok=True)
    for name,direction in views.items():
        cam.location = centre+Vector(direction).normalized()*radius*5
        cam.rotation_euler = (centre-cam.location).to_track_quat("-Z","Y").to_euler()
        scene.render.filepath = str(out/(name+".png"))
        bpy.ops.render.render(write_still=True)
        strip_png_metadata(scene.render.filepath)
    return {"views":views,"resolution":a["resolution"],"provesPhysicalAccuracy":False}


def main():
    a = json.loads(Path(sys.argv[sys.argv.index("--")+1]).read_text())
    obj,bm = load(a["input"],a["scale_mm"])
    if a["command"]=="repair":
        result = repair(obj,bm,a)
        write_json(Path(a["out"])/"report.json",result)
    elif a["command"]=="measure":
        result = stats(bm)
        result["provesPhysicalAccuracy"] = False
    else:
        result = render(obj,bm,a)
    write_json(a["result"],result)


if __name__ == "__main__":
    main()
