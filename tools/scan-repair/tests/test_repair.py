# SPDX-License-Identifier: GPL-3.0-or-later
import hashlib
import json
import math
import os
from pathlib import Path
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
        for args in [("--voxel-size-mm","0"),("--denoise-iterations","11"),
                     ("--weld-mm","nan"),("--target-faces","0")]:
            self.run_cli("repair",p,"--units","mm","--out",self.base/"invalid",*args,ok=False)

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
