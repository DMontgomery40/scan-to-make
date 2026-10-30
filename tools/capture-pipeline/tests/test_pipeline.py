#!/usr/bin/env python3
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "capture-mesh-convert"))
from make_fixtures import make_all  # noqa: E402
from pipeline import dumps, run_pipeline, sha256  # noqa: E402
import repro  # noqa: E402

BOX = {"x": 10.0, "y": 20.0, "z": 30.0}


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.fx = make_all(cls.dir / "fx")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_fx(self, fixture, held=BOX, tag=None, **kw):
        return run_pipeline(self.fx[fixture] if fixture in self.fx else fixture, held,
                            self.dir / "work" / (tag or str(fixture).replace("/", "_")), **kw)

    def test_pass_case(self):
        r = self.run_fx("reflected")
        self.assertEqual((r["verdict"], r["exitCode"]), ("pass-bounds-only", 0))
        self.assertEqual(r["declaredUnits"]["units"], "cm")
        self.assertEqual(r["evaluator"]["report"]["verdict"], "pass-bounds-only")
        self.assertEqual(r["evaluator"]["report"]["mesh"]["extentsMm"], {"x": 10.0, "y": 20.0, "z": 30.0})
        self.assertTrue(r["converter"]["report"]["metricQualified"])
        self.assertIsNone(r["rejection"])
        self.assertFalse(r["provesPhysicalFit"])

    def test_original_bytes_preserved(self):
        r = self.run_fx("reflected", tag="preserve")
        src = self.fx["reflected"].read_bytes()
        self.assertEqual(r["input"]["sha256"], sha256(src))
        kept = self.dir / "work" / "preserve" / "input" / (sha256(src) + ".usdz")
        self.assertEqual(kept.read_bytes(), src)
        self.assertEqual(r["converter"]["report"]["source"]["sha256"], sha256(src))

    def test_report_deterministic_and_path_free(self):
        a = dumps(self.run_fx("reflected", tag="det-a"))
        b = dumps(self.run_fx("reflected", tag="det-b"))
        self.assertEqual(a, b)
        for s in (str(self.dir), "/workspace", "/home", "/tmp"):
            self.assertNotIn(s, a)
        self.assertEqual(a, json.dumps(json.loads(a), indent=2, sort_keys=True) + "\n")

    def test_evaluation_failure(self):
        r = self.run_fx("reflected", {"x": 50.0, "y": 20.0, "z": 30.0}, tag="fail")
        self.assertEqual((r["verdict"], r["exitCode"]), ("evaluation-failed", 2))
        self.assertEqual(r["evaluator"]["exitCode"], 2)

    def assertConversionRejected(self, fixture, exit_code):
        r = self.run_fx(fixture)
        self.assertEqual((r["verdict"], r["exitCode"]), ("rejected-conversion", 4))
        self.assertIsNone(r["evaluator"], "evaluator must not run")
        self.assertEqual(r["converter"]["exitCode"], exit_code)
        self.assertEqual(r["rejection"]["evidence"]["converterExitCode"], exit_code)
        return r

    def test_reject_unqualified_units(self):
        r = self.assertConversionRejected("no_units", 4)
        self.assertIn("metersPerUnit not authored", r["rejection"]["evidence"]["metricQualifiedReason"])

    def test_reject_unqualified_subdivision(self):
        r = self.assertConversionRejected("unauthored_subdiv", 4)
        self.assertEqual([u["feature"] for u in r["rejection"]["evidence"]["unsupportedFeatures"]], ["subdivision"])

    def test_reject_converter_error_keeps_stderr(self):
        r = self.assertConversionRejected("nan_point", 2)
        self.assertIn("non-finite point", r["rejection"]["evidence"]["converterStderr"])
        self.assertIsNone(r["converter"]["report"])
        r = self.assertConversionRejected("external_ref", 2)
        self.assertIn("asset boundary", r["converter"]["stderr"])

    def test_reject_size_limit(self):
        r = self.run_fx("reflected", tag="big", max_bytes=100)
        self.assertEqual((r["verdict"], r["exitCode"]), ("rejected-input", 3))
        self.assertIsNone(r["converter"])
        self.assertIn("limit 100", r["rejection"]["reason"])

    def test_reject_entry_and_uncompressed_limits(self):
        r = self.run_fx("two_layer", tag="entries", max_entries=1)
        self.assertEqual(r["verdict"], "rejected-input")
        self.assertIn("2 entries, limit 1", r["rejection"]["reason"])
        r = self.run_fx("reflected", tag="uncomp", max_uncompressed=10)
        self.assertIn("uncompressed size", r["rejection"]["reason"])

    def _zip(self, name, entry, compress=zipfile.ZIP_STORED):
        p = self.dir / name
        with zipfile.ZipFile(p, "w", compress) as z:
            z.writestr(entry, b"PXR-USDC" + b"\0" * 64)
        return p

    def test_reject_unsafe_and_compressed_entries(self):
        r = self.run_fx(self._zip("trav.usdz", "../evil.usdc"), tag="trav")
        self.assertIn("unsafe package entry", r["rejection"]["reason"])
        r = self.run_fx(self._zip("defl.usdz", "a.usdc", zipfile.ZIP_DEFLATED), tag="defl")
        self.assertIn("compressed", r["rejection"]["reason"])
        self.assertIsNone(r["converter"])

    def test_reject_suffix_and_missing(self):
        p = self.dir / "mesh.obj"
        p.write_text("v 0 0 0\n")
        self.assertIn("suffix", self.run_fx(p, tag="suffix")["rejection"]["reason"])
        r = self.run_fx(self.dir / "nope.usdz", tag="missing")
        self.assertEqual(r["verdict"], "rejected-input")

    def test_cli_exit_codes(self):
        cli = [sys.executable, str(HERE / "pipeline.py")]
        out = self.dir / "cli.json"
        res = subprocess.run(cli + [str(self.fx["reflected"]), "--held-out", "x=10", "--held-out", "y=20",
                                    "--held-out", "z=30", "--work-dir", str(self.dir / "cli"), "--report", str(out)])
        self.assertEqual(res.returncode, 0)
        self.assertEqual(json.loads(out.read_text())["verdict"], "pass-bounds-only")
        res = subprocess.run(cli + [str(self.fx["no_units"]), "--held-out", "x=10", "--work-dir",
                                    str(self.dir / "cli2")], capture_output=True, text=True)
        self.assertEqual(res.returncode, 4)
        self.assertEqual(json.loads(res.stdout)["verdict"], "rejected-conversion")

    def test_repro_script(self):
        self.assertEqual(repro.main(self.dir / "repro"), 0)


if __name__ == "__main__":
    unittest.main()
