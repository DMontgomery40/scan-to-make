#!/usr/bin/env python3
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "capture-mesh-convert"))
from make_fixtures import make_all  # noqa: E402
from pipeline import dumps, sha256  # noqa: E402
from duplicate import Rejected, check_duplicate, run_duplicate  # noqa: E402
import duplicate_repro  # noqa: E402

BOX = {"x": 10.0, "y": 20.0, "z": 30.0}
CUBE_V = ["v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0", "v 0 0 1", "v 1 0 1", "v 1 1 1", "v 0 1 1"]
CUBE_F = ["f 1 3 2", "f 1 4 3", "f 5 6 7", "f 5 7 8", "f 1 2 6", "f 1 6 5",
          "f 2 3 7", "f 2 7 6", "f 3 4 8", "f 3 8 7", "f 4 1 5", "f 4 5 8"]


def obj(v=CUBE_V, f=CUBE_F):
    return ("\n".join(["o C"] + v + f) + "\n").encode()


class DuplicateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.fx = make_all(cls.dir / "fx")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def dup(self, fixture, tag, held=BOX, **kw):
        return run_duplicate(self.fx[fixture], held, self.dir / "work" / tag, self.dir / "out" / tag, **kw)

    def out(self, tag):
        return self.dir / "out" / tag / "duplicate.obj"

    def test_ready_is_byte_identical_with_exact_units(self):
        m = self.dup("reflected", "ready")
        self.assertEqual((m["verdict"], m["exitCode"]), ("duplicate-ready", 0))
        data = self.out("ready").read_bytes()
        mesh = (self.dir / "work" / "ready" / "mesh.obj").read_bytes()
        self.assertEqual(data, mesh)
        self.assertEqual(m["duplicate"]["sha256"], sha256(data))
        self.assertEqual(m["duplicate"]["sha256"], m["pipeline"]["converter"]["report"]["output"]["sha256"])
        self.assertEqual(m["duplicate"]["sourceSha256"], sha256(self.fx["reflected"].read_bytes()))
        self.assertEqual((m["duplicate"]["units"], m["duplicate"]["metersPerUnit"], m["duplicate"]["mmPerUnit"]),
                         ("cm", 0.01, 10.0))
        b = m["geometry"]["boundsNative"]  # hand-derived reflected fixture bounds, native cm
        self.assertEqual([(b[a]["min"], b[a]["max"]) for a in "xyz"], [(-1.0, 0.0), (0.0, 2.0), (0.0, 3.0)])
        self.assertEqual(m["geometry"]["extentsMm"], BOX)
        self.assertEqual(m["geometry"]["topology"]["boundaryEdgeCount"], 0)
        self.assertFalse(m["scaleApplied"] or m["geometryModified"] or m["surfacesInvented"])
        self.assertFalse(m["provesCompleteCapture"] or m["provesPhysicalFit"])

    def test_manifest_deterministic_and_path_free(self):
        a, b = dumps(self.dup("reflected", "det-a")), dumps(self.dup("reflected", "det-b"))
        self.assertEqual(a, b)
        for s in (str(self.dir), "/workspace", "/home", "/tmp"):
            self.assertNotIn(s, a)

    def test_pipeline_failure_writes_nothing(self):
        m = self.dup("reflected", "fail", {"x": 50.0, "y": 20.0, "z": 30.0})
        self.assertEqual((m["verdict"], m["exitCode"]), ("evaluation-failed", 2))
        self.assertFalse(self.out("fail").exists())
        self.assertIsNone(m["duplicate"])

    def test_holes_are_never_filled(self):
        m = self.dup("holes", "holes")
        self.assertEqual((m["verdict"], m["exitCode"]), ("rejected-conversion", 4))
        self.assertFalse(self.out("holes").exists())

    def test_unqualified_units_rejected(self):
        m = self.dup("no_units", "nounits")
        self.assertEqual(m["verdict"], "rejected-conversion")
        self.assertFalse(self.out("nounits").exists())

    def test_build_volume_exceeded_not_scaled(self):
        m = self.dup("reflected", "big", build_volume_mm={"x": 9.0, "y": 300.0, "z": 300.0})
        self.assertEqual((m["verdict"], m["exitCode"]), ("rejected-bounds", 6))
        self.assertEqual(m["rejection"]["evidence"]["exceeded"], {"x": {"extentMm": 10.0, "limitMm": 9.0}})
        self.assertFalse(self.out("big").exists())

    def test_count_limits(self):
        self.assertEqual(self.dup("reflected", "tris", max_triangles=11)["verdict"], "rejected-bounds")
        self.assertEqual(self.dup("reflected", "verts", max_vertices=7)["verdict"], "rejected-bounds")
        self.assertEqual(self.dup("reflected", "exact", max_triangles=12, max_vertices=8)["verdict"],
                         "duplicate-ready")

    def test_stale_duplicate_removed_on_rejection(self):
        self.assertEqual(self.dup("reflected", "stale")["verdict"], "duplicate-ready")
        self.assertTrue(self.out("stale").exists())
        self.dup("reflected", "stale", build_volume_mm={"x": 1.0, "y": 1.0, "z": 1.0})
        self.assertFalse(self.out("stale").exists())

    def assertTopology(self, data, key):
        with self.assertRaises(Rejected) as cm:
            check_duplicate(data, "mm")
        self.assertEqual(cm.exception.verdict, "rejected-topology")
        self.assertIn(key, cm.exception.reason)
        return cm.exception

    def test_closed_cube_passes(self):
        g = check_duplicate(obj(), "mm")
        self.assertEqual(g["topology"]["signedVolumeNative"], 1.0)

    def test_open_surface_rejected_not_capped(self):
        e = self.assertTopology(obj(f=CUBE_F[:-1]), "boundaryEdgeCount")
        self.assertEqual(e.evidence["topology"]["boundaryEdgeCount"], 3)
        self.assertEqual(e.evidence["topology"]["triangleCount"], 11)

    def test_non_manifold_rejected(self):
        self.assertTopology(obj(v=CUBE_V + ["v 0 0 -1"], f=CUBE_F + ["f 1 2 9"]), "nonManifoldEdgeCount")

    def test_inverted_winding_rejected(self):
        flipped = [" ".join([f.split()[0], f.split()[1], f.split()[3], f.split()[2]]) for f in CUBE_F]
        self.assertTopology(obj(f=flipped), "nonPositiveVolume")

    def test_inconsistent_orientation_rejected(self):
        self.assertTopology(obj(f=["f 1 2 3"] + CUBE_F[1:]), "inconsistentlyOrientedEdgeCount")

    def test_degenerate_rejected(self):
        self.assertTopology(obj(f=CUBE_F + ["f 1 1 2"]), "degenerateTriangleCount")

    def test_strict_reader(self):
        for bad in (obj(f=CUBE_F + ["f 1 2 3 4"]), obj(v=CUBE_V + ["vt 0 0"]), obj(f=["f 1/1 2/2 3/3"] + CUBE_F),
                    obj(v=CUBE_V + ["v nan 0 0"]), obj(f=CUBE_F + ["f 1 2 99"]), b"\xff"):
            with self.assertRaises(Rejected) as cm:
                check_duplicate(bad, "mm")
            self.assertEqual(cm.exception.verdict, "rejected-topology")

    def test_unknown_units_rejected(self):
        with self.assertRaises(Rejected) as cm:
            check_duplicate(obj(), "ft")
        self.assertEqual(cm.exception.verdict, "rejected-units")

    def test_cli_exit_codes(self):
        base = [sys.executable, str(HERE / "duplicate.py"), str(self.fx["reflected"]), "--held-out", "x=10",
                "--held-out", "y=20", "--held-out", "z=30"]
        ok = subprocess.run(base + ["--work-dir", str(self.dir / "cw"), "--out-dir", str(self.dir / "co")],
                            capture_output=True, text=True)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(json.loads(ok.stdout)["verdict"], "duplicate-ready")
        big = subprocess.run(base + ["--work-dir", str(self.dir / "cw2"), "--out-dir", str(self.dir / "co2"),
                                     "--build-volume", "5x5x5"], capture_output=True, text=True)
        self.assertEqual(big.returncode, 6)

    def test_repro(self):
        self.assertEqual(duplicate_repro.main(self.dir / "repro"), 0)


if __name__ == "__main__":
    unittest.main()
