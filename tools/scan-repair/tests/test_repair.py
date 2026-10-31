# SPDX-License-Identifier: GPL-3.0-or-later
import hashlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[1]
BLENDER = os.environ.get("BLENDER") or shutil.which("blender") or "/Applications/Blender.app/Contents/MacOS/Blender"
CUBE = [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]
FACES = [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]


def icosphere(radius, levels, noise=0, seed=0):
    t = (1+5**.5)/2
    verts = [(-1,t,0),(1,t,0),(-1,-t,0),(1,-t,0),(0,-1,t),(0,1,t),(0,-1,-t),(0,1,-t),
             (t,0,-1),(t,0,1),(-t,0,-1),(-t,0,1)]
    faces = [(0,11,5),(0,5,1),(0,1,7),(0,7,10),(0,10,11),(1,5,9),(5,11,4),(11,10,2),(10,7,6),(7,1,8),
             (3,9,4),(3,4,2),(3,2,6),(3,6,8),(3,8,9),(4,9,5),(2,4,11),(6,2,10),(8,6,7),(9,8,1)]
    for _ in range(levels):
        cache, split = {}, []
        def mid(a, b):
            key = (min(a,b), max(a,b))
            if key not in cache:
                cache[key] = len(verts)
                verts.append(tuple((p+q)/2 for p,q in zip(verts[a], verts[b])))
            return cache[key]
        for a,b,c in faces:
            ab, bc, ca = mid(a,b), mid(b,c), mid(c,a)
            split += [(a,ab,ca),(b,bc,ab),(c,ca,bc),(ab,bc,ca)]
        faces = split
    rng = random.Random(seed)
    return [tuple(c/math.hypot(*v)*(radius+rng.uniform(-noise,noise)) for c in v) for v in verts], faces


def radial_roughness(points):
    centre = [sum(axis)/len(points) for axis in zip(*points)]
    radii = [math.dist(v, centre) for v in points]
    mean = sum(radii)/len(radii)
    return math.sqrt(sum((r-mean)**2 for r in radii)/len(radii))


def fan_box(size=(40,20,10), step=.4, centre=(4,1), fans=((2,1),), drop=()):
    """Lattice box; each (axis, side) in fans is closed by one coarse fan, like Object
    Capture's unseen side. Sides in drop are left open."""
    n = [round(s/step) for s in size]
    index, vertices, faces = {}, [], []
    def vid(*c):
        if c not in index:
            index[c] = len(vertices)
            vertices.append(tuple(i*step for i in c))
        return index[c]
    for axis in range(3):
        a, b = (axis+1)%3, (axis+2)%3
        for side in (0, 1):
            if (axis, side) in drop:
                continue
            def point(u, w):
                c = [0,0,0]
                c[axis], c[a], c[b] = side*n[axis], u, w
                return c
            if (axis, side) in fans:
                rim = ([(u,0) for u in range(n[a])] + [(n[a],w) for w in range(n[b])] +
                       [(u,n[b]) for u in range(n[a],0,-1)] + [(0,w) for w in range(n[b],0,-1)])
                ring = [vid(*point(u,w)) for u,w in rim]
                tip = [0,0,0]
                tip[axis], tip[a], tip[b] = side*size[axis], size[a]/2+centre[0], size[b]/2+centre[1]
                vertices.append(tuple(tip))
                faces += [(ring[k], ring[(k+1)%len(ring)], len(vertices)-1) for k in range(len(ring))]
                continue
            faces += [tuple(vid(*point(u+du,w+dw)) for du,dw in ((0,0),(1,0),(1,1),(0,1)))
                      for u in range(n[a]) for w in range(n[b])]
    return vertices, faces


@unittest.skipUnless(Path(BLENDER).is_file(), "Blender absent; set BLENDER to Blender 5.0.1 to run real integration tests")
class RepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

    def mesh(self, name, vertices, faces):
        p = self.base / name
        p.write_text("".join("v %s %s %s\n" % tuple(v) for v in vertices) +
                     "".join("f " + " ".join(str(i+1) for i in f) + "\n" for f in faces))
        return p

    def run_cli(self, *args, ok=True):
        r = subprocess.run([sys.executable, str(ROOT/"repair.py"), *map(str,args)],
                           text=True, capture_output=True, env={**os.environ, "BLENDER": BLENDER})
        self.assertEqual(r.returncode, 0 if ok else 2, r.stdout+r.stderr)
        return json.loads(r.stdout) if ok else r

    def repair(self, p, *args, name="out"):
        out = self.base/name
        self.run_cli("repair", p, "--units", "mm", "--out", out, *args)
        r = json.loads((out/"report.json").read_text())
        self.assertTrue(r["after"]["watertight"])
        self.assertFalse(r["provesPhysicalAccuracy"])
        for filename, digest in r["outputSha256"].items():
            self.assertEqual(hashlib.sha256((out/filename).read_bytes()).hexdigest(), digest)
        raw = (out/"repaired.stl").read_bytes()
        count = struct.unpack_from("<I", raw, 80)[0]
        self.assertEqual(len(raw), 84+count*50)
        return r

    def test_cube_floater_and_determinism(self):
        p = self.mesh("cube.obj", CUBE + [(x*.05+5,y*.05,z*.05) for x,y,z in CUBE],
                      FACES + [tuple(i+8 for i in f) for f in FACES])
        a = self.repair(p)
        self.assertEqual(a["before"]["components"], 2)
        self.assertEqual(a["after"]["components"], 1)
        self.assertAlmostEqual(a["after"]["volumeMm3"], 8, places=4)
        self.assertEqual(a, self.repair(p, name="again"))
        self.assertGreater(a["deviation"]["maxMm"], 3)

    def test_sphere_holes(self):
        vertices = [(0,0,1),(0,0,-1)]
        n = 24
        for j in range(1,12):
            t = math.pi*j/12
            vertices += [(math.sin(t)*math.cos(2*math.pi*i/n), math.sin(t)*math.sin(2*math.pi*i/n), math.cos(t)) for i in range(n)]
        faces = []
        for j in range(10):
            for i in range(n):
                a,b = 2+j*n+i, 2+j*n+(i+1)%n
                faces.append((a,a+n,b+n,b))
        p = self.mesh("sphere.obj", vertices[2:], [tuple(i-2 for i in f) for f in faces])
        r = self.repair(p)
        self.assertGreater(r["before"]["boundaryEdges"], 0)
        self.assertEqual(r["after"]["boundaryEdges"], 0)

    def test_noisy_box_preserves_sharp_corners(self):
        verts = [(x+(0.015 if i%2 else -0.015),y,z) for i,(x,y,z) in enumerate(CUBE)]
        p = self.mesh("noise.obj", verts, FACES)
        r = self.repair(p, "--denoise-iterations", 3)
        self.assertLess(r["deviation"]["maxMm"], 1e-5)
        self.assertEqual(r["after"]["vertices"], 8)

    def test_default_denoise_smooths_without_shrinking(self):
        # Seeded radial noise on a sphere: plain Laplacian steps shrink it; Taubin must not.
        vertices, faces = icosphere(20, 4, noise=.05, seed=7)
        r = self.repair(self.mesh("noisy-sphere.obj", vertices, faces))
        repaired = [tuple(map(float, line.split()[1:])) for line in
                    (self.base/"out"/"repaired.obj").read_text().splitlines() if line.startswith("v ")]
        self.assertLess(radial_roughness(repaired), radial_roughness(vertices)*.5)
        # Laplacian steps at the same lambda lose about 5% here; Taubin stays within 0.5%.
        self.assertAlmostEqual(r["after"]["volumeMm3"]/r["before"]["volumeMm3"], 1, delta=.005)
        self.assertEqual((r["after"]["vertices"], r["after"]["faces"]),
                         (r["before"]["vertices"], r["before"]["faces"]))
        denoise = next(o for o in r["operations"] if o["name"]=="denoise")
        self.assertEqual((denoise["iterations"], denoise["factor"], denoise["mu"], denoise["maxDisplacementMm"]),
                         (15, .5, -.53, .35))

    def test_rejects_amplifying_taubin_pair(self):
        # Lambda .1 with the default mu has pass-band 8.1: every frequency grows, so noise is amplified.
        p = self.mesh("pair.obj", CUBE, FACES)
        r = self.run_cli("repair", p, "--units", "mm", "--out", self.base/"pair",
                         "--denoise-iterations", "1", "--denoise-factor", ".1", ok=False)
        self.assertIn("pass-band", r.stderr)
        self.assertFalse((self.base/"pair").exists())
        # A different smoothing pair inside the pass-band bound is accepted and smooths.
        vertices, faces = icosphere(20, 3, noise=.05, seed=3)
        self.repair(self.mesh("pair-sphere.obj", vertices, faces), "--denoise-factor", ".33",
                    "--denoise-mu=-.34", name="pair-ok")
        repaired = [tuple(map(float, line.split()[1:])) for line in
                    (self.base/"pair-ok"/"repaired.obj").read_text().splitlines() if line.startswith("v ")]
        self.assertLess(radial_roughness(repaired), radial_roughness(vertices)*.7)

    def test_coarse_fan_refills_flat_without_moving_captured_surface(self):
        vertices, faces = fan_box()
        p = self.mesh("fan.obj", vertices, faces)
        r = self.repair(p, "--denoise-iterations", "0", "--orient", "keep", name="fan")
        self.assertEqual((r["before"]["coarseFillFaces"], r["after"]["coarseFillFaces"]), (300, 0))
        refill = next(o for o in r["operations"] if o["name"]=="refillCoarse")
        self.assertEqual((refill["regions"], refill["refilled"], refill["capturedMaxMoveMm"]), (1, 1, 0))
        self.assertTrue(refill["solverConverged"])
        self.assertAlmostEqual(refill["removedAreaMm2"], 800, places=3)
        self.assertAlmostEqual(refill["inferredAreaMm2"], 800, places=3)
        out = (self.base/"fan"/"repaired.obj").read_text().splitlines()
        points = [tuple(map(float, line.split()[1:])) for line in out if line.startswith("v ")]
        # Every vertex stays on the box surface: the faired top is flat, not bulged.
        for x,y,z in points:
            self.assertLess(min(x, 40-x, y, 20-y, z, 10-z), 1e-4)
            self.assertGreater(min(x, 40-x, y, 20-y, z, 10-z), -1e-4)
        # Captured vertices are kept exactly; only the fan centre is replaced.
        kept = {tuple(round(c, 4) for c in v) for v in points}
        centre = vertices.index((24, 11, 10))
        self.assertTrue({tuple(round(c, 4) for c in v) for i,v in enumerate(vertices) if i != centre} <= kept)
        top = [[points[int(i.split("/")[0])-1] for i in line.split()[1:]] for line in out
               if line.startswith("f ") and all(abs(points[int(i.split("/")[0])-1][2]-10) < 1e-4 for i in line.split()[1:])]
        self.assertLess(max(math.dist(f[k], f[k-1]) for f in top for k in range(3)), 1)
        # Untextured output relies on the reported ranges: they must be exactly the refilled top.
        export = next(o for o in r["operations"] if o["name"]=="export")
        ranges = {n for a,b in export["inferredFaceRanges"] for n in range(a, b+1)}
        numbers = [n for n,line in enumerate((l for l in out if l.startswith("f ")), 1)
                   if all(abs(points[int(i.split("/")[0])-1][2]-10) < 1e-4 for i in line.split()[1:])]
        self.assertEqual(ranges, set(numbers))
        self.assertEqual(len(ranges), refill["inferredFaces"])
        # Defaults: Taubin and box frame keep the 40 x 20 x 10 box.
        r = self.repair(p, name="fan-default")
        for actual, expected in zip(r["after"]["boxExtentsMm"], (40, 20, 10)):
            self.assertAlmostEqual(actual, expected, delta=.02)
        self.assertLess(r["deviation"]["maxMm"], .02)
        # Box edges are creases, so the curvature-continuing mode stays flat too.
        r = self.repair(p, "--fill-fairing", "biharmonic", "--denoise-iterations", "0", name="fan-bi")
        self.assertLess(next(o for o in r["operations"] if o["name"]=="refillCoarse")["patchMaxOffsetMm"], 1e-3)
        kept = self.repair(p, "--coarse-fill", "keep", name="fan-keep")
        self.assertEqual(kept["after"]["coarseFillFaces"], 300)

    def test_adjacent_fans_keep_their_crease(self):
        # Two coarse regions meeting at a box edge are refilled separately; the edge stays sharp.
        vertices, faces = fan_box(size=(40,30,24), step=.5, centre=(1,1), fans=((2,1),(1,0)))
        r = self.repair(self.mesh("two-fans.obj", vertices, faces), "--denoise-iterations", "0",
                        "--orient", "keep", "--fill-fairing", "biharmonic", name="two-fans")
        refill = next(o for o in r["operations"] if o["name"]=="refillCoarse")
        self.assertEqual((refill["regions"], refill["refilled"], refill["capturedMaxMoveMm"]), (2, 2, 0))
        for line in (self.base/"two-fans"/"repaired.obj").read_text().splitlines():
            if line.startswith("v "):
                x,y,z = map(float, line.split()[1:])
                self.assertLess(abs(min(x, 40-x, y, 30-y, z, 24-z)), 1e-4)

    def test_coarse_fan_on_open_boundary_is_refilled(self):
        # The fan's rim along the missing side belongs only to the fan; it must survive the swap.
        vertices, faces = fan_box(drop=((1,0),))
        r = self.repair(self.mesh("open-fan.obj", vertices, faces), "--hole-max-edges", "3", name="open-fan")
        refill = next(o for o in r["operations"] if o["name"]=="refillCoarse")
        self.assertEqual((refill["refilled"], refill["capturedMaxMoveMm"]), (1, 0))
        self.assertTrue(next(o for o in r["operations"] if o["name"]=="voxelRemesh")["applied"])
        export = next(o for o in r["operations"] if o["name"]=="export")
        self.assertTrue(export["inferredFaceRanges"])
        self.assertIn("approximately", export["inferredNote"])

    def test_textured_refill_marks_inferred_faces_unbound(self):
        # Captured faces keep their UVs and texture; every inferred face is explicitly unbound.
        vertices, faces = fan_box()
        folder = self.base/"textured-fan"
        folder.mkdir()
        lines = ["mtllib tex.mtl"] + ["v %s %s %s" % v for v in vertices]
        lines += ["vt %r %r" % (vertices[i][0]/40, vertices[i][1]/20+vertices[i][2]/100) for f in faces for i in f]
        lines += ["usemtl skin"]
        corner = 0
        for f in faces:
            lines.append("f "+" ".join("%d/%d" % (i+1, corner+k+1) for k,i in enumerate(f)))
            corner += len(f)
        (folder/"fan.obj").write_text("\n".join(lines)+"\n")
        (folder/"tex.mtl").write_text("newmtl skin\nmap_Kd tex.png\n")
        (folder/"tex.png").write_bytes(self.png())
        r = self.repair(folder/"fan.obj", "--denoise-iterations", "0", "--orient", "keep", name="textured-fan-out")
        out = (self.base/"textured-fan-out"/"repaired.obj").read_text().splitlines()
        points = [tuple(map(float, line.split()[1:])) for line in out if line.startswith("v ")]
        uvs = [tuple(map(float, line.split()[1:])) for line in out if line.startswith("vt ")]
        export = next(o for o in r["operations"] if o["name"]=="export")
        inferred = {n for a,b in export["inferredFaceRanges"] for n in range(a, b+1)}
        current, number = None, 0
        for line in out:
            if line.startswith("usemtl "):
                current = line.split()[1]
            elif line.startswith("f "):
                number += 1
                corners = [tuple(map(int, c.split("/"))) for c in line.split()[1:]]
                top = all(abs(points[v-1][2]-10) < 1e-6 for v,_ in corners)
                self.assertEqual(number in inferred, top)
                self.assertEqual(current, "unbound" if top else "skin")
                if not top:
                    for v,t in corners:
                        x,y,z = points[v-1]
                        self.assertAlmostEqual(uvs[t-1][0], x/40, places=5)
                        self.assertAlmostEqual(uvs[t-1][1], y/20+z/100, places=5)
        self.assertEqual(len(inferred), next(o for o in r["operations"] if o["name"]=="refillCoarse")["inferredFaces"])

    def test_fan_pinned_to_captured_face_is_skipped(self):
        # A captured triangle shares only the fan centre; replacing the fan would delete it.
        vertices, faces = fan_box()
        tip = vertices.index((24, 11, 10))
        vertices += [(24.5, 11, 10.5), (24, 11.5, 10.5)]
        faces.append((tip, len(vertices)-2, len(vertices)-1))
        r = self.repair(self.mesh("pinned-fan.obj", vertices, faces), name="pinned-fan")
        refill = next(o for o in r["operations"] if o["name"]=="refillCoarse")
        self.assertEqual((refill["refilled"], refill["capturedMaxMoveMm"]), (0, 0))
        self.assertEqual(refill["skipped"][0]["reason"], "interior vertex touches captured geometry")

    def test_nonmanifold_join_uses_fallback(self):
        p = self.mesh("join.obj", CUBE+[(0,0,2)], FACES+[(4,5,8)])
        r = self.repair(p, "--voxel-size-mm", ".15")
        self.assertGreater(r["before"]["nonManifoldEdges"], 0)
        self.assertTrue(next(o for o in r["operations"] if o["name"]=="voxelRemesh")["applied"])

    def test_metres_mm_and_sidecar(self):
        mm = self.mesh("mm.obj", CUBE, FACES)
        m = self.mesh("m.obj", [(x/1000,y/1000,z/1000) for x,y,z in CUBE], FACES)
        a = self.run_cli("measure", mm, "--units", "mm")
        b = self.run_cli("measure", m, "--units", "m")
        self.assertEqual(a,b)
        sidecar = self.base/"units.json"
        sidecar.write_text('{"unitsAuthored":true,"metersPerUnit":0.001}')
        self.assertEqual(a,self.run_cli("measure", mm, "--units-sidecar", sidecar))
        r = self.repair(m, "--units", "m")
        self.assertAlmostEqual(r["after"]["volumeMm3"],8,places=4)
        self.run_cli("measure", mm, ok=False)

    def test_weld_and_exported_grounding(self):
        vertices = [CUBE[i] for face in FACES for i in face]
        faces = [tuple(range(i,i+4)) for i in range(0,24,4)]
        p = self.mesh("seams.obj", vertices, faces)
        r = self.repair(p)
        self.assertEqual(r["before"]["components"],6)
        self.assertEqual(r["after"]["vertices"],8)
        self.assertFalse(next(o for o in r["operations"] if o["name"]=="voxelRemesh")["applied"])
        measured = self.run_cli("measure", self.base/"out"/"repaired.stl", "--units","mm")
        self.assertAlmostEqual(measured["volumeMm3"],8,places=4)
        self.assertAlmostEqual(measured["bboxMm"]["min"][2],0,places=5)
        for size in measured["principalExtentsMm"]:
            self.assertAlmostEqual(size,2,places=4)

    @staticmethod
    def png():
        def chunk(kind, data):
            return struct.pack(">I", len(data))+kind+data+struct.pack(">I", zlib.crc32(kind+data))
        return (b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))+
                chunk(b"IDAT", zlib.compress(b"\0"+b"\xff\0\0"*2+b"\0"+b"\0\xff\0"*2))+chunk(b"IEND", b""))

    def textured_cube(self, folder, mtllib="tex.mtl", texture="tex.png", unbound_from=None):
        # One UV chart per side, so the cube has UV seams on every edge.
        folder.mkdir()
        corners = [(0,0),(1,0),(1,1),(0,1)]
        lines = ["mtllib "+mtllib] + ["v %s %s %s" % v for v in CUBE]
        lines += ["vt %g %g" % ((side+u)/6, v) for side in range(6) for u,v in corners] + ["usemtl skin"]
        faces = ["f "+" ".join("%d/%d" % (i+1, side*4+k+1) for k,i in enumerate(face)) for side,face in enumerate(FACES)]
        if unbound_from is not None:
            # capture-mesh-convert assigns `usemtl unbound` to meshes without a material.
            faces.insert(unbound_from, "usemtl unbound")
        lines += faces
        (folder/"cube.obj").write_text("\n".join(lines)+"\n")
        (folder/"tex.mtl").write_text("newmtl skin\nKd 1 1 1\nmap_Kd -clamp off %s\n" % texture)
        (folder/"tex.png").write_bytes(self.png())
        return folder/"cube.obj"

    def test_textured_obj_keeps_uvs_and_material(self):
        p = self.textured_cube(self.base/"textured")
        r = self.repair(p, name="kept")
        out = (self.base/"kept"/"repaired.obj").read_text().splitlines()
        self.assertIn("mtllib tex.mtl", out)
        self.assertIn("usemtl skin", out)
        faces = [line.split()[1:] for line in out if line.startswith("f ")]
        uvs = [tuple(map(float, line.split()[1:])) for line in out if line.startswith("vt ")]
        self.assertEqual(len(uvs), sum(map(len, faces)))
        self.assertTrue(all("/" in corner for face in faces for corner in face))
        source = {(round((side+u)/6, 5), v) for side in range(6) for u,v in [(0,0),(1,0),(1,1),(0,1)]}
        self.assertTrue({(round(u, 5), v) for u,v in uvs} <= source)
        for name in ("tex.mtl", "tex.png"):
            self.assertEqual((self.base/"kept"/name).read_bytes(), (self.base/"textured"/name).read_bytes())
            self.assertIn(name, r["outputSha256"])
        export = next(o for o in r["operations"] if o["name"]=="export")
        self.assertEqual((export["uvRetained"], export["materialFiles"]), (True, ["tex.mtl", "tex.png"]))
        # Voxel remeshing replaces the surface, so UVs and materials cannot follow it.
        r = self.repair(p, "--force-voxel", name="voxel")
        self.assertNotIn("vt ", (self.base/"voxel"/"repaired.obj").read_text())
        self.assertFalse((self.base/"voxel"/"tex.png").exists())
        self.assertFalse(next(o for o in r["operations"] if o["name"]=="export")["uvRetained"])
        # A JPEG texture keeps UVs but is not copied.
        jpeg = self.textured_cube(self.base/"jpeg", texture="tex.jpg")
        (jpeg.parent/"tex.jpg").write_bytes(b"\xff\xd8\xff")
        r = self.repair(jpeg, name="jpeg-out")
        export = next(o for o in r["operations"] if o["name"]=="export")
        self.assertEqual((export["uvRetained"], export["materialFiles"]), (True, []))
        self.assertIn("tex.jpg", export["materialNote"])

    def test_unbound_faces_after_textured_faces_reset_material(self):
        p = self.textured_cube(self.base/"mixed", unbound_from=3)
        self.repair(p, name="mixed-out")
        counts, current = {}, None
        for line in (self.base/"mixed-out"/"repaired.obj").read_text().splitlines():
            if line.startswith("usemtl "):
                current = line.split()[1]
            elif line.startswith("f "):
                counts[current] = counts.get(current, 0)+1
        self.assertEqual(counts, {"skin": 6, "unbound": 6})

    def test_material_references_cannot_escape_input_folder(self):
        (self.base/"secret.mtl").write_text("newmtl skin\n")
        (self.base/"secret.png").write_bytes(self.png())
        cases = [("mtllib", "../secret.mtl"), ("mtllib", str(self.base/"secret.mtl")),
                 ("texture", "../secret.png"), ("texture", "/etc/hostname"), ("link", "tex.png")]
        for i,(kind,target) in enumerate(cases):
            folder = self.base/("escape%d" % i)
            p = self.textured_cube(folder, **({"mtllib":target} if kind=="mtllib" else
                                              {"texture":target} if kind=="texture" else {}))
            if kind == "link":
                (folder/"tex.png").unlink()
                (folder/"tex.png").symlink_to(self.base/"secret.png")
            r = self.run_cli("repair", p, "--units", "mm", "--out", self.base/("escaped%d" % i), ok=False)
            self.assertIn("material", r.stderr)
            self.assertFalse((self.base/("escaped%d" % i)).exists())

    def test_volume_floater_metric(self):
        p = self.mesh("volume.obj", CUBE + [(x*.05+5,y*.05,z*.05) for x,y,z in CUBE],
                      FACES + [tuple(i+8 for i in f) for f in FACES])
        r = self.repair(p,"--component-metric","volume")
        self.assertEqual(r["after"]["components"],1)
        self.assertAlmostEqual(r["after"]["volumeMm3"],8,places=4)

    def test_reject_invalid_parameters(self):
        p = self.mesh("invalid.obj", CUBE,FACES)
        for args in [("--voxel-size-mm","0"),("--denoise-iterations","51"),("--denoise-mu","-.4"),("--denoise-mu","-.6"),
                     ("--denoise-mu","nan"),("--denoise-factor","0"),
                     ("--weld-mm","nan"),("--fill-crease-deg","181"),("--target-faces","0")]:
            self.run_cli("repair",p,"--units","mm","--out",self.base/"invalid",*args,ok=False)

    def rotated_box(self):
        # Uneven face tessellation tilts PCA even though the surface is a box.
        vertices = [(x*30.3,y*22.6,z*10.85) for x,y,z in CUBE]
        faces = list(FACES)
        face = faces.pop(1)
        centre = len(vertices)
        vertices.append((18, 10, 10.85))
        faces += [(face[i],face[(i+1)%4],centre) for i in range(4)]
        c, sn = math.cos(math.radians(5)), math.sin(math.radians(5))
        for axis in range(3):
            i,j = (axis+1)%3,(axis+2)%3
            turned = []
            for v in vertices:
                v = list(v)
                v[i],v[j] = c*v[i]-sn*v[j],sn*v[i]+c*v[j]
                turned.append(v)
            vertices = turned
        return vertices, faces

    def test_refined_box_rotated_five_degrees(self):
        vertices, faces = self.rotated_box()
        p = self.mesh("rotated.obj",vertices,faces)
        result = self.run_cli("measure",p,"--units","mm")
        self.assertGreater(max(abs(a-b) for a,b in zip(result["principalExtentsMm"],
                                                       (60.6,45.2,21.7))), .1)
        for actual,expected in zip(result["boxExtentsMm"],(60.6,45.2,21.7)):
            self.assertAlmostEqual(actual,expected,delta=.05)
        # Independently project input vertices using the returned world-to-box rotation.
        rotation,origin = result["boxRotation"],result["boxInputCentreMm"]
        projected = [[sum(row[i]*(v[i]-origin[i]) for i in range(3)) for row in rotation]
                     for v in vertices]
        for axis,span in enumerate(result["boxExtentsMm"]):
            self.assertAlmostEqual(max(v[axis] for v in projected)-min(v[axis] for v in projected),
                                   span,delta=1e-4)
        self.assertEqual(result,self.run_cli("measure",p,"--units","mm"))

    def test_repair_orients_by_box_frame(self):
        vertices, faces = self.rotated_box()
        p = self.mesh("rotated.obj",vertices,faces)
        def output(name):
            return [tuple(map(float,line.split()[1:])) for line in
                    (self.base/name/"repaired.obj").read_text().splitlines() if line.startswith("v ")]
        def errors(points):
            return [max(axis)-min(axis)-true for axis,true in zip(zip(*points),(60.6,45.2,21.7))]
        r = self.repair(p,name="box")
        self.assertEqual(next(o for o in r["operations"] if o["name"]=="orient")["frame"],"box")
        self.assertLess(max(map(abs,errors(output("box")))),.05)
        self.assertAlmostEqual(r["after"]["bboxMm"]["min"][2],0,places=6)
        self.assertEqual(r["before"]["coarseFillFaces"],0)
        # PCA stays available, with the tessellation skew that motivated the box default.
        self.repair(p,"--orient","pca",name="pca")
        self.assertGreater(max(map(abs,errors(output("pca")))),.1)
        keep = self.repair(p,"--orient","keep","--denoise-iterations","0",name="keep")
        transform = next(o for o in keep["operations"] if o["name"]=="orient")
        self.assertEqual((transform["frame"],transform["translationMm"]),("keep",[0,0,0]))
        # Blender stores float32 coordinates.
        for kept,source in zip(sorted(output("keep")),sorted(map(tuple,vertices)),strict=True):
            for a,b in zip(kept,source):
                self.assertAlmostEqual(a,b,delta=1e-4)

    def test_coarse_fill_area(self):
        # Object Capture closes unseen sides with a few huge faces among fine ones.
        vertices = [(x,y,0) for y in range(11) for x in range(11)]
        faces = [(y*11+x,y*11+x+1,(y+1)*11+x+1,(y+1)*11+x) for y in range(10) for x in range(10)]
        vertices += [(20,0,0),(25,0,0),(25,4,0),(20,4,0)]
        faces.append((121,122,123,124))
        result = self.run_cli("measure",self.mesh("coarse.obj",vertices,faces),"--units","mm")
        self.assertEqual(result["coarseFillFaces"],1)
        self.assertAlmostEqual(result["coarseFillAreaMm2"],20,places=6)

    def test_planar_measure(self):
        p = self.mesh("plane.obj",[(0,0,0),(4,0,0),(4,2,0),(0,2,0)],[(0,1,2,3)])
        result = self.run_cli("measure",p,"--units","mm")
        self.assertEqual(result["boxExtentsMm"],[4,2,0])
        self.assertIsNone(result["volumeMm3"])

    def test_render_preserves_asymmetric_input_frame(self):
        # An off-centre raised block represents a pocket-up part with a visual datum.
        vertices = [(x*8,y*5,z) for x,y,z in CUBE]
        vertices += [(x+5,y+2,z+3) for x,y,z in CUBE]
        faces = FACES+[tuple(i+8 for i in face) for face in FACES]
        p = self.mesh("oriented.obj",vertices,faces)
        before = p.read_bytes()
        outputs = []
        for name,args in (("default",()),("keep",("--keep-orientation",)),
                          ("pca",("--pca-orientation",))):
            out = self.base/name
            result = self.run_cli("render",p,"--units","mm","--out",out,
                                  "--resolution",32,*args)
            self.assertEqual(result["orientation"],"pca" if name=="pca" else "input")
            self.assertEqual(result["transform"] is None,name!="pca")
            outputs.append([hashlib.sha256(f.read_bytes()).hexdigest()
                            for f in sorted(out.glob("*.png"))])
        self.assertEqual(outputs[0],outputs[1])
        self.assertNotEqual(outputs[0],outputs[2])
        self.assertEqual(before,p.read_bytes())

    def test_render_and_decimate(self):
        p = self.mesh("box.obj", CUBE, FACES)
        self.repair(p, "--target-faces", 8)
        out = self.base/"views"
        self.run_cli("render", p, "--units", "mm", "--out", out, "--resolution", 64)
        pngs = sorted(out.glob("*.png"))
        self.assertEqual(len(pngs),10)
        for png in pngs:
            self.assertEqual(png.read_bytes()[:8],b"\x89PNG\r\n\x1a\n")
        first = [hashlib.sha256(p.read_bytes()).hexdigest() for p in pngs]
        self.run_cli("render", p, "--units", "mm", "--out", out, "--resolution", 64)
        self.assertEqual(first,[hashlib.sha256(p.read_bytes()).hexdigest() for p in pngs])


if __name__ == "__main__":
    unittest.main()
