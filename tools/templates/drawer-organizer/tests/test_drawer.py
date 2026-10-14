#!/usr/bin/env python3
"""Tests for the drawer organizer template.

Run from tools/templates/drawer-organizer/: python3 -m unittest discover -s tests -v
"""

import copy
import hashlib
import json
import math
import os
import struct
import sys
import unittest
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from drawer import build, build_manifest, sizing, to_binary_stl  # noqa: E402

FIXTURE_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "..",
    "packages", "contracts", "fixtures", "drawer-tray.json",
)
FIXTURE = json.load(open(FIXTURE_PATH, encoding="utf-8"))
GOLDEN_SHA256 = "d1906903d69a7028f37cb6c2590d843a44bb6c776f929dbce722f47ee1d3667e"


def parse_stl(data: bytes):
    (count,) = struct.unpack("<I", data[80:84])
    assert len(data) == 84 + count * 50
    tris = []
    for i in range(count):
        off = 84 + i * 50
        values = struct.unpack("<12fH", data[off:off + 50])
        tris.append(tuple(tuple(values[3 + j:6 + j]) for j in (0, 3, 6)))
    return tris


def edge_counts(tris):
    counts = defaultdict(int)
    directed = defaultdict(int)
    vertices = set()
    for tri in tris:
        assert len(set(tri)) == 3, "degenerate triangle"
        vertices.update(tri)
        for a, b in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            counts[tuple(sorted((a, b)))] += 1
            directed[(a, b)] += 1
    for (a, b), count in directed.items():
        assert count == 1 and directed[(b, a)] == 1, "inconsistent triangle winding"
    return vertices, counts


def signed_volume(tris):
    return sum(
        (
            a[0] * (b[1] * c[2] - c[1] * b[2])
            - a[1] * (b[0] * c[2] - c[0] * b[2])
            + a[2] * (b[0] * c[1] - c[0] * b[1])
        )
        / 6.0
        for a, b, c in tris
    )


class SizingTests(unittest.TestCase):
    def test_fixture_uses_merged_contract_formulas_exactly(self):
        s = sizing(FIXTURE)
        self.assertAlmostEqual(s["outerWidthMm"], 297.8)
        self.assertAlmostEqual(s["outerDepthMm"], 397.8)
        self.assertAlmostEqual(s["outerHeightMm"], 40.0)
        self.assertAlmostEqual(s["wallMm"], 2.0)
        self.assertAlmostEqual(s["floorMm"], 2.0)
        self.assertAlmostEqual(s["dividerTopMm"], 38.0)
        self.assertAlmostEqual(s["innerWidthMm"], 293.8)
        self.assertAlmostEqual(s["innerDepthMm"], 393.8)
        self.assertAlmostEqual(s["clearCellWidthMm"], 96.6)
        self.assertAlmostEqual(s["clearCellDepthMm"], 195.9)
        self.assertAlmostEqual(s["peripheralClearanceMm"], 0.6)

    def test_clearance_upper_bound_is_consumed(self):
        spec = copy.deepcopy(FIXTURE)
        spec["dimensions"]["peripheralClearance"] = {
            "nominalMm": 0.3,
            "lowerMm": 0.2,
            "upperMm": 0.9,
            "source": "design",
            "sourceId": "design-clearance",
        }
        s = sizing(spec)
        self.assertAlmostEqual(s["outerWidthMm"], 299.0 - 1.8)
        self.assertAlmostEqual(s["outerDepthMm"], 399.0 - 1.8)

    def test_worst_case_cell_uses_interval_extremes(self):
        spec = copy.deepcopy(FIXTURE)
        spec["dimensions"]["wallThickness"] = {
            "nominalMm": 2.0,
            "lowerMm": 1.5,
            "upperMm": 2.5,
            "source": "design",
            "sourceId": "design-wall",
        }
        s = sizing(spec)
        expected_width = (299.0 - 2 * 0.6 - (2 + 2) * 2.5) / 3
        self.assertAlmostEqual(s["worstCaseClearCellWidthMm"], expected_width)

    def test_malformed_or_impossible_specs_rejected(self):
        cases = []
        bad = copy.deepcopy(FIXTURE); bad["schemaVersion"] = "0.1.0"; cases.append(bad)
        bad = copy.deepcopy(FIXTURE); bad["template"] = "cup-holder-adapter"; cases.append(bad)
        bad = copy.deepcopy(FIXTURE); bad["frame"]["origin"] = "holder-base-center"; cases.append(bad)
        bad = copy.deepcopy(FIXTURE); bad["parameters"]["dividersAcross"] = 9; cases.append(bad)
        bad = copy.deepcopy(FIXTURE); bad["parameters"]["dividersAlong"] = 1.5; cases.append(bad)
        bad = copy.deepcopy(FIXTURE); bad["dimensions"]["extra"] = bad["dimensions"]["wallThickness"]; cases.append(bad)
        bad = copy.deepcopy(FIXTURE); bad["dimensions"]["trayHeight"]["upperMm"] = 60; cases.append(bad)
        bad = copy.deepcopy(FIXTURE); bad["dimensions"]["floorThickness"]["upperMm"] = 40; cases.append(bad)
        bad = copy.deepcopy(FIXTURE); bad["dimensions"]["drawerInnerWidth"]["lowerMm"] = 20; cases.append(bad)
        bad = copy.deepcopy(FIXTURE); bad["dimensions"]["wallThickness"]["nominalMm"] = 0; cases.append(bad)
        for case in cases:
            with self.assertRaises(ValueError):
                sizing(case)


class GeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tris, cls.derived = build(FIXTURE)
        cls.stl = to_binary_stl(cls.tris)
        cls.parsed = parse_stl(cls.stl)

    def test_deterministic_golden_hash(self):
        self.assertEqual(hashlib.sha256(self.stl).hexdigest(), GOLDEN_SHA256)
        self.assertEqual(to_binary_stl(build(FIXTURE)[0]), self.stl)

    def test_closed_manifold_and_positive_volume(self):
        vertices, counts = edge_counts(self.parsed)
        self.assertTrue(all(count == 2 for count in counts.values()))
        self.assertEqual(len(vertices) - len(counts) + len(self.parsed), 2)
        s = self.derived
        expected = (
            s["outerWidthMm"] * s["outerDepthMm"] * s["floorMm"]
            + (
                s["outerWidthMm"] * s["outerDepthMm"]
                - s["innerWidthMm"] * s["innerDepthMm"]
            )
            * (s["outerHeightMm"] - s["floorMm"])
            + FIXTURE["parameters"]["dividersAcross"]
            * s["wallMm"] * s["innerDepthMm"] * (s["dividerTopMm"] - s["floorMm"])
            + FIXTURE["parameters"]["dividersAlong"]
            * s["wallMm"] * s["innerWidthMm"] * (s["dividerTopMm"] - s["floorMm"])
            - FIXTURE["parameters"]["dividersAcross"]
            * FIXTURE["parameters"]["dividersAlong"]
            * s["wallMm"] * s["wallMm"] * (s["dividerTopMm"] - s["floorMm"])
        )
        volume = signed_volume(self.parsed)
        self.assertGreater(volume, 0)
        self.assertAlmostEqual(volume, expected, delta=max(1.0, expected * 2e-6))

    def test_bbox_is_centered_on_contract_origin(self):
        flat = [v for tri in self.parsed for v in tri]
        self.assertAlmostEqual(min(v[0] for v in flat), -297.8 / 2, places=4)
        self.assertAlmostEqual(max(v[0] for v in flat), 297.8 / 2, places=4)
        self.assertAlmostEqual(min(v[1] for v in flat), -397.8 / 2, places=4)
        self.assertAlmostEqual(max(v[1] for v in flat), 397.8 / 2, places=4)
        self.assertAlmostEqual(min(v[2] for v in flat), 0.0, places=6)
        self.assertAlmostEqual(max(v[2] for v in flat), 40.0, places=5)

    def test_divider_centers_and_top(self):
        s = self.derived
        self.assertEqual(len(s["dividerCentersAcrossMm"]), 2)
        self.assertEqual(len(s["dividerCentersAlongMm"]), 1)
        self.assertAlmostEqual(s["dividerCentersAlongMm"][0], 0.0)
        step = s["clearCellWidthMm"] + s["wallMm"]
        self.assertAlmostEqual(
            s["dividerCentersAcrossMm"][1] - s["dividerCentersAcrossMm"][0], step
        )
        self.assertAlmostEqual(s["dividerTopMm"], 38.0)

    def test_cells_are_open_above_the_floor(self):
        s = self.derived
        # A cell-centre point must not lie inside any surface triangle above
        # the floor; otherwise the builder has accidentally roofed the tray.
        for cx in (-98.2, 1.5, 98.2):
            for cy in (-97.95, 97.95):
                for tri in self.parsed:
                    if min(v[2] for v in tri) <= s["floorMm"] + 1e-9:
                        continue
                    xs = [v[0] for v in tri]
                    ys = [v[1] for v in tri]
                    self.assertFalse(min(xs) <= cx <= max(xs) and min(ys) <= cy <= max(ys))

    def test_zero_divider_tray_is_still_closed(self):
        spec = copy.deepcopy(FIXTURE)
        spec["parameters"] = {"dividersAcross": 0, "dividersAlong": 0}
        tris, _ = build(spec)
        parsed = parse_stl(to_binary_stl(tris))
        vertices, counts = edge_counts(parsed)
        self.assertTrue(all(count == 2 for count in counts.values()))
        self.assertEqual(len(vertices) - len(counts) + len(parsed), 2)
        self.assertGreater(signed_volume(parsed), 0)


class ManifestTests(unittest.TestCase):
    def test_manifest_is_honest_about_synthetic_square_corner_preview(self):
        tris, derived = build(FIXTURE)
        stl = to_binary_stl(tris)
        manifest = build_manifest(FIXTURE, derived, stl)
        self.assertEqual(manifest["cornerRadiusAssumedMm"], 0)
        self.assertEqual(manifest["sourceSpec"]["schemaVersion"], "0.2.0")
        self.assertEqual(manifest["artifact"]["sha256"], hashlib.sha256(stl).hexdigest())
        self.assertEqual(manifest["artifact"]["byteLength"], len(stl))
        self.assertEqual(manifest["status"], "preview-geometry-not-print-authorized")
        self.assertNotIn("fitEvidence", json.dumps(manifest).lower())
        self.assertIn("synthetic fixture", manifest["evidenceBoundary"].lower())


if __name__ == "__main__":
    unittest.main()
