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
                     ("--weld-mm","nan"),("--target-faces","0")]:
            self.run_cli("repair",p,"--units","mm","--out",self.base/"invalid",*args,ok=False)

    def test_refined_box_rotated_five_degrees(self):
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
