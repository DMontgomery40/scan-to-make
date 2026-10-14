#!/usr/bin/env python3
"""Tests for the FIT-002 cup-holder adapter template.

Run from tools/templates/cup-holder-adapter/:  python3 -m unittest discover -s tests -v
"""

import copy
import hashlib
import json
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from adapter import build, profile, sizing, to_binary_stl  # noqa: E402

FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..",
                            "packages", "contracts", "fixtures", "tapered-holder.json")
FIXTURE = json.load(open(FIXTURE_PATH, encoding="utf-8"))
GOLDEN_SHA256 = "59f3e291fe71df7d6806971608fefd545bf1ed09a38433c7d07b6885f64517c4"


class SizingTests(unittest.TestCase):
    def test_conservative_interval_sizing_on_fixture(self):
        s = sizing(FIXTURE)
        # outside: holder lower bound / 2 - 0.3 clearance per side
        self.assertAlmostEqual(s["rInsertOuterBottomMm"], 57.8 / 2 - 0.3)
        self.assertAlmostEqual(s["rInsertOuterTopMm"], 61.8 / 2 - 0.3)
        # length: depth lower bound; cradle: cup upper bound / 2 + clearance
        self.assertAlmostEqual(s["insertDepthMm"], 34.8)
        self.assertAlmostEqual(s["rCradleInnerMm"], 86.2 / 2 + 0.3)
        self.assertAlmostEqual(s["topZMm"], 34.8 + 45.0)
        self.assertAlmostEqual(s["cupEngagedHeightMm"], 45.0 - 2.4)

    def test_inverted_taper_still_insertable(self):
        spec = copy.deepcopy(FIXTURE)
        spec["dimensions"]["holderInnerBottomDiameter"] = {
            "nominalMm": 64.0, "lowerMm": 63.8, "upperMm": 64.2,
            "source": "manual", "sourceId": "m-bottom"}
        spec["dimensions"]["holderInnerTopDiameter"] = {
            "nominalMm": 62.0, "lowerMm": 61.8, "upperMm": 62.2,
            "source": "manual", "sourceId": "m-top"}
        s = sizing(spec)
        # Bottom is capped by the rim opening: straight insert, never wedged.
        self.assertAlmostEqual(s["rInsertOuterBottomMm"], 61.8 / 2 - 0.3)
        self.assertAlmostEqual(s["rInsertOuterBottomMm"], s["rInsertOuterTopMm"])
        self.assertLessEqual(2 * s["rInsertOuterBottomMm"] + 2 * 0.3, 61.8 + 1e-9)
        build(spec)  # emits geometry instead of refusing a valid holder

    def test_clearance_interval_consumed_at_upper_bound(self):
        spec = copy.deepcopy(FIXTURE)
        spec["dimensions"]["radialClearance"] = {
            "nominalMm": 0.3, "lowerMm": 0.2, "upperMm": 0.5,
            "source": "design", "sourceId": "design-clearance"}
        s = sizing(spec)
        self.assertAlmostEqual(s["radialClearanceMm"], 0.5)
        self.assertAlmostEqual(s["rInsertOuterTopMm"], 61.8 / 2 - 0.5)
        self.assertAlmostEqual(s["rCradleInnerMm"], 86.2 / 2 + 0.5)

    def test_guarantees_hold_over_interval(self):
        s = sizing(FIXTURE)
        c = FIXTURE["dimensions"]["radialClearance"]["upperMm"]
        # insert fits even the smallest holder; cradle takes even the largest cup
        self.assertLessEqual(2 * s["rInsertOuterBottomMm"] + 2 * c,
                             FIXTURE["dimensions"]["holderInnerBottomDiameter"]["lowerMm"] + 1e-9)
        self.assertGreaterEqual(2 * s["rCradleInnerMm"] - 2 * c,
                                FIXTURE["dimensions"]["cupOuterDiameter"]["upperMm"] - 1e-9)

    def test_malformed_specs_rejected(self):
        bad = copy.deepcopy(FIXTURE)
        bad["dimensions"]["insertionDepth"]["lowerMm"] = 99  # > nominal
        with self.assertRaises(ValueError):
            sizing(bad)
        bad = copy.deepcopy(FIXTURE)
        del bad["dimensions"]["wallThickness"]
        with self.assertRaises(ValueError):
            sizing(bad)
        bad = copy.deepcopy(FIXTURE)
        bad["template"] = "something-else"
        with self.assertRaises(ValueError):
            sizing(bad)
        bad = copy.deepcopy(FIXTURE)
        bad["dimensions"]["wallThickness"] = {"nominalMm": 40, "lowerMm": 40, "upperMm": 40,
                                              "source": "design", "sourceId": "x"}
        with self.assertRaises(ValueError):
            sizing(bad)


class GeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tris, cls.derived = build(FIXTURE)
        cls.stl = to_binary_stl(cls.tris)

    def test_deterministic_golden_hash(self):
        self.assertEqual(hashlib.sha256(self.stl).hexdigest(), GOLDEN_SHA256)
        self.assertEqual(to_binary_stl(build(FIXTURE)[0]), self.stl)

    def test_volume_matches_exact_revolve(self):
        vol = sum((a[0] * (b[1] * c[2] - c[1] * b[2]) - a[1] * (b[0] * c[2] - c[0] * b[2])
                   + a[2] * (b[0] * c[1] - c[0] * b[1])) / 6.0 for a, b, c in self.tris)
        pts = profile(self.derived)
        exact = abs(sum(math.pi * (z2 - z1) * (r1 * r1 + r1 * r2 + r2 * r2) / 3.0
                        for (r1, z1), (r2, z2) in zip(pts, pts[1:] + pts[:1])))
        n = 96
        corrected = exact * (n / 2 * math.sin(2 * math.pi / n)) / math.pi
        self.assertAlmostEqual(vol, corrected, delta=corrected * 1e-5)
        self.assertGreater(vol, 0, "positive volume = consistent outward winding")

    def test_bbox(self):
        flat = [v for t in self.tris for v in t]
        s = self.derived
        self.assertAlmostEqual(max(v[0] for v in flat), s["rCradleOuterMm"], places=5)
        self.assertAlmostEqual(min(v[0] for v in flat), -s["rCradleOuterMm"], places=5)
        self.assertAlmostEqual(min(v[2] for v in flat), 0.0, places=6)
        self.assertAlmostEqual(max(v[2] for v in flat), s["topZMm"], places=5)


if __name__ == "__main__":
    unittest.main()
