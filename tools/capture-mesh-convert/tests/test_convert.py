#!/usr/bin/env python3
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from convert import convert  # noqa: E402
from make_fixtures import make_all  # noqa: E402

REPO = HERE.parents[1]
FIT006 = REPO / "tools" / "capture-fit-eval" / "evaluate.py"


def decode_obj(path):
    """Independent OBJ decoder (no pxr): returns vertices, faces (0-based)."""
    verts, faces = [], []
    for line in Path(path).read_text().splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "v":
            verts.append(tuple(float(x) for x in parts[1:4]))
        elif parts[0] == "f":
            faces.append([int(p.split("/")[0]) - 1 for p in parts[1:]])
    return verts, faces


def bounds(verts, idx=None):
    vs = [verts[i] for i in idx] if idx is not None else verts
    return ([min(v[k] for v in vs) for k in range(3)], [max(v[k] for v in vs) for k in range(3)])


def signed_volume(verts, faces):
    vol = 0.0
    for f in faces:
        a = verts[f[0]]
        for i in range(1, len(f) - 1):
            b, c = verts[f[i]], verts[f[i + 1]]
            vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                    + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
    return vol


class ConvertTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.fx = make_all(cls.dir / "fx")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_fx(self, name):
        out = self.dir / f"{name}.obj"
        report = convert(self.fx[name], out)
        return report, out

    def assertBounds(self, got, lo, hi):
        for g, e in zip(got[0] + got[1], lo + hi):
            self.assertAlmostEqual(g, e, places=5)

    def test_fixtures_are_binary_usdc_packages(self):
        for name, p in self.fx.items():
            with zipfile.ZipFile(p) as z:
                first = z.infolist()[0]
                self.assertTrue(first.filename.endswith(".usdc"), name)
                self.assertEqual(z.read(first)[:8], b"PXR-USDC", name)

    def test_nested_multi_bounds_and_report(self):
        r, out = self.run_fx("nested_multi")
        v, f = decode_obj(out)
        self.assertEqual(len(v), 16)
        self.assertEqual(len(f), 24)
        self.assertTrue(all(len(x) == 3 for x in f))
        self.assertBounds(bounds(v, range(0, 8)), [0, 20, 0], [3, 22, 2])
        self.assertBounds(bounds(v, range(8, 16)), [100, 0, 0], [101, 2, 3])
        self.assertAlmostEqual(signed_volume(v, f[:12]), 12.0, places=5)  # 1*2*3 scaled x2
        self.assertAlmostEqual(signed_volume(v, f[12:]), 6.0, places=5)
        self.assertEqual([m["triangles"] for m in r["meshes"]], [12, 12])
        self.assertTrue(r["unitsAuthored"])
        self.assertEqual(r["metersPerUnit"], 0.01)
        self.assertEqual(r["upAxis"], "Z")
        self.assertTrue(r["metricQualified"])
        self.assertEqual(r["source"]["sha256"], hashlib.sha256(self.fx["nested_multi"].read_bytes()).hexdigest())
        self.assertEqual(r["output"]["sha256"], hashlib.sha256(out.read_bytes()).hexdigest())
        self.assertFalse(r["provesPhysicalFit"])

    def test_reflection_flips_winding(self):
        r, out = self.run_fx("reflected")
        v, f = decode_obj(out)
        self.assertBounds(bounds(v), [-1, 0, 0], [0, 2, 3])
        self.assertAlmostEqual(signed_volume(v, f), 6.0, places=5)
        self.assertTrue(r["meshes"][0]["windingFlipped"])
        self.assertLess(r["meshes"][0]["worldDeterminant"], 0)

    def test_no_units_is_not_metric(self):
        r, out = self.run_fx("no_units")
        self.assertFalse(r["unitsAuthored"])
        self.assertFalse(r["upAxisAuthored"])
        self.assertFalse(r["metricQualified"])
        self.assertEqual(r["metersPerUnit"], 0.01)  # USD fallback, reported not trusted
        self.assertBounds(bounds(decode_obj(out)[0]), [0, 0, 0], [1, 2, 3])

    def test_subdivision_reported_unsupported(self):
        r, _ = self.run_fx("subdiv")
        self.assertTrue(r["unitsAuthored"])
        self.assertFalse(r["metricQualified"])
        self.assertEqual(r["unsupportedFeatures"][0]["feature"], "subdivision")

    def test_unauthored_subdivision_is_catmull_clark_not_qualified(self):
        r, out = self.run_fx("unauthored_subdiv")
        self.assertFalse(r["metricQualified"])
        self.assertEqual([u["feature"] for u in r["unsupportedFeatures"]], ["subdivision"])
        self.assertFalse(r["meshes"][0]["subdivisionSchemeAuthored"])
        self.assertEqual(r["meshes"][0]["subdivisionScheme"], "catmullClark")
        self.assertIn("explicit-none-only", r["subdivisionPolicy"])

    def test_authored_subdivision_cli_exit_4(self):
        r, _ = self.run_fx("subdiv")
        self.assertTrue(r["meshes"][0]["subdivisionSchemeAuthored"])
        res = subprocess.run([sys.executable, str(HERE / "convert.py"), str(self.fx["subdiv"]),
                              "--out", str(self.dir / "s.obj")], capture_output=True)
        self.assertEqual(res.returncode, 4)

    def test_holes_flagged_and_omitted_degenerate_not_counted(self):
        r, out = self.run_fx("holes")
        v, f = decode_obj(out)
        self.assertEqual(len(f), 12)
        self.assertTrue(all(len(x) == 3 for x in f))
        self.assertFalse(r["metricQualified"])
        self.assertIn("holeIndices", [u["feature"] for u in r["unsupportedFeatures"]])
        m = r["meshes"][0]
        self.assertEqual((m["faces"], m["authoredFaces"], m["holeFacesOmitted"]), (6, 8, 1))
        self.assertAlmostEqual(signed_volume(v, f), 6.0, places=5)

    def test_purpose_and_inactive_skipped(self):
        r, out = self.run_fx("purpose")
        v, _ = decode_obj(out)
        self.assertBounds(bounds(v), [0, 0, 0], [1, 2, 3])
        reasons = {s["prim"]: s["reason"] for s in r["skippedPrims"]}
        self.assertEqual(reasons, {"/P_guide": "purpose=guide", "/P_proxy": "purpose=proxy",
                                   "/P_render": "purpose=render", "/Inactive": "inactive"})
        self.assertTrue(r["metricQualified"])

    def test_time_sampled_topology_flagged(self):
        r, _ = self.run_fx("animated_topology")
        self.assertFalse(r["metricQualified"])
        self.assertIn("timeSampledTopology", [u["feature"] for u in r["unsupportedFeatures"]])

    def test_exit_2_missing_pxr_and_missing_input(self):
        fake = self.dir / "nopxr" / "pxr"
        fake.mkdir(parents=True, exist_ok=True)
        (fake / "__init__.py").write_text("raise ImportError('simulated missing usd-core')\n")
        env = dict(os.environ, PYTHONPATH=str(fake.parent))
        res = subprocess.run([sys.executable, str(HERE / "convert.py"), str(self.fx["reflected"]),
                              "--out", str(self.dir / "x.obj")], capture_output=True, text=True, env=env)
        self.assertEqual(res.returncode, 2)
        self.assertIn("USD runtime unavailable", res.stderr)
        res = subprocess.run([sys.executable, str(HERE / "convert.py"), str(self.dir / "nope.usdz"),
                              "--out", str(self.dir / "y.obj")], capture_output=True, text=True)
        self.assertEqual(res.returncode, 2)

    def assertRejected(self, name, msg):
        out = self.dir / f"rej_{name}.obj"
        with self.assertRaisesRegex(RuntimeError, msg):
            convert(self.fx[name], out)
        self.assertFalse(out.exists(), "no output may be written on rejection")
        res = subprocess.run([sys.executable, str(HERE / "convert.py"), str(self.fx[name]), "--out", str(out)],
                             capture_output=True, text=True)
        self.assertEqual(res.returncode, 2)
        self.assertFalse(out.exists())

    def test_reject_nan_point(self):
        self.assertRejected("nan_point", "non-finite point")

    def test_reject_out_of_range_index(self):
        self.assertRejected("bad_index", "index 99 out of range for 4 points")

    def test_reject_zero_meters_per_unit(self):
        self.assertRejected("zero_mpu", "invalid metersPerUnit")

    def test_reject_external_reference(self):
        self.assertRejected("external_ref", "asset boundary: dependency outside")

    def test_reject_unresolved_reference(self):
        self.assertRejected("missing_ref", "asset boundary: unresolved")

    def test_contributing_layers_hashed(self):
        r, _ = self.run_fx("reflected")
        with zipfile.ZipFile(self.fx["reflected"]) as z:
            data = z.read("reflected.usdc")
        self.assertEqual(r["contributingLayers"],
                         [{"identifier": "reflected.usdc", "sha256": hashlib.sha256(data).hexdigest(),
                           "bytes": len(data)}])

    def test_concave_triangulation_invents_no_faces(self):
        from make_fixtures import CONCAVE
        r, out = self.run_fx("concave")
        v, f = decode_obj(out)
        self.assertTrue(r["metricQualified"])
        self.assertEqual(len(f), 4)  # n - 2
        self.assertTrue(all(len(x) == 3 for x in f))
        poly = [(float(x), float(y)) for x, y in CONCAVE]
        self.assertTrue(all(p[2] == 0.0 for p in v))

        def area2(a, b, c):
            return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

        def inside(pt):
            hit = False
            for i in range(len(poly)):
                (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % len(poly)]
                if (y1 > pt[1]) != (y2 > pt[1]) and pt[0] < x1 + (pt[1] - y1) * (x2 - x1) / (y2 - y1):
                    hit = not hit
            return hit

        total = 0.0
        for tri in f:
            a, b, c = (v[i][:2] for i in tri)
            self.assertGreater(area2(a, b, c), 0)  # CCW, non-degenerate
            total += area2(a, b, c) / 2
            for w in ((1, 1, 1), (4, 1, 1), (1, 4, 1), (1, 1, 4)):
                s = sum(w)
                pt = ((a[0] * w[0] + b[0] * w[1] + c[0] * w[2]) / s, (a[1] * w[0] + b[1] * w[1] + c[1] * w[2]) / s)
                self.assertTrue(inside(pt), (tri, pt))
        self.assertAlmostEqual(total, 3.0, places=9)

    def test_cli_exit_codes(self):
        cli = [sys.executable, str(HERE / "convert.py")]
        ok = subprocess.run(cli + [str(self.fx["reflected"]), "--out", str(self.dir / "c.obj"),
                                   "--report", str(self.dir / "c.json")])
        self.assertEqual(ok.returncode, 0)
        self.assertIn("sha256", json.loads((self.dir / "c.json").read_text())["source"])
        nu = subprocess.run(cli + [str(self.fx["no_units"]), "--out", str(self.dir / "d.obj")],
                            capture_output=True)
        self.assertEqual(nu.returncode, 4)

    def test_fit006_accepts_output(self):
        _, out = self.run_fx("reflected")  # metersPerUnit 0.01 -> declare cm
        res = subprocess.run([sys.executable, str(FIT006), "evaluate", str(out), "--units", "cm",
                              "--held-out", "x=10", "--held-out", "y=20", "--held-out", "z=30", "--json"],
                             capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)


if __name__ == "__main__":
    unittest.main()
