#!/usr/bin/env python3
"""Tests for the FIT-001 characterization coupon generator.

Run from tools/characterization/:  python3 -m unittest discover -s tests -v
"""

import hashlib
import math
import os
import re
import struct
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from coupon import CouponParams, build, build_manifest, derive_profile, to_binary_stl  # noqa: E402

GOLDEN_SHA256 = "dd44ee4b818d5369e290c1954896e3abe575d6249a711e194ee69f5895935e95"
PARAMS = CouponParams()


def parse_stl(data: bytes):
    (count,) = struct.unpack("<I", data[80:84])
    assert len(data) == 84 + count * 50, "STL byte length must match its triangle count"
    tris = []
    for i in range(count):
        off = 84 + i * 50
        normal = struct.unpack("<3f", data[off:off + 12])
        verts = struct.unpack("<9f", data[off + 12:off + 48])
        tris.append((normal, [verts[j:j + 3] for j in (0, 3, 6)]))
    return tris


class CouponGeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tris, cls.layout = build(PARAMS)
        cls.stl = to_binary_stl(cls.tris)

    def test_deterministic_golden_hash(self):
        self.assertEqual(hashlib.sha256(self.stl).hexdigest(), GOLDEN_SHA256)
        again = to_binary_stl(build(PARAMS)[0])
        self.assertEqual(again, self.stl, "same params must emit identical bytes")

    def test_stl_structure_and_unit_normals(self):
        parsed = parse_stl(self.stl)
        self.assertEqual(len(parsed), len(self.tris))
        for normal, _ in parsed:
            self.assertAlmostEqual(math.hypot(*normal), 1.0, places=5)
        flat = [v for _, vs in parsed for v in vs]
        self.assertTrue(all(math.isfinite(c) for v in flat for c in v))
        self.assertAlmostEqual(min(v[2] for v in flat), 0.0, places=6, msg="everything sits on the plate")

    def test_closed_mesh_volume_matches_design(self):
        vol = 0.0
        for a, b, c in self.tris:
            vol += (a[0] * (b[1] * c[2] - c[1] * b[2])
                    - a[1] * (b[0] * c[2] - c[0] * b[2])
                    + a[2] * (b[0] * c[1] - c[0] * b[1])) / 6.0

        def poly_area(r, n=PARAMS.circle_segments):
            return 0.5 * n * r * r * math.sin(2 * math.pi / n)

        slots = PARAMS.slot_widths_mm
        total_x = 6.0 * (len(slots) + 1) + sum(slots)
        ladder = total_x * 14 * 3 + 7 * (6 * 10 * 10) + sum(i + 1 for i in range(6)) * (1.2 * 1.2 * 1.5)
        relief, foot_h = PARAMS.peg_foot_relief_mm, PARAMS.peg_foot_height_mm
        peg = ((12 - 2 * relief) * (6 - 2 * relief) * foot_h
               + 12 * 6 * (18 - foot_h) + 12 * 12 * 6)
        rings = sum((poly_area(b / 2 + 3) - poly_area(b / 2)) * 8 for b in PARAMS.ring_bores_mm)
        bosses = 20 * 20 * 6 + poly_area(10) * 6
        bar = 100 * 8 * 4 + 2 * (6 * 8 * 6)
        strip_len = sum(PARAMS.wall_steps_mm) + 12 * 4 + 16
        walls = strip_len * 18 * 2.5 + sum(w * 14 * 9.5 for w in PARAMS.wall_steps_mm)
        self.assertAlmostEqual(vol, ladder + peg + rings + bosses + bar + walls, places=4)

    def test_peg_insertion_end_is_relieved(self):
        relief, foot_h = PARAMS.peg_foot_relief_mm, PARAMS.peg_foot_height_mm
        self.assertGreater(relief, 0)
        foot = [v for t in self.tris for v in t if 20.0 < v[1] < 34.0 and v[2] < foot_h]
        self.assertTrue(foot)
        # First-layer flare zone is narrower than nominal on every side, so it
        # cannot be the section that decides which slot the peg enters.
        self.assertAlmostEqual(min(v[0] for v in foot), relief, places=6)
        self.assertAlmostEqual(max(v[0] for v in foot), PARAMS.peg_width_mm - relief, places=6)
        body = [v for t in self.tris for v in t
                if 23.0 < v[1] < 31.0 and abs(v[2] - foot_h) < 1e-9]
        self.assertAlmostEqual(min(v[0] for v in body), 0.0, places=6)
        self.assertAlmostEqual(max(v[0] for v in body), PARAMS.peg_width_mm, places=6)

    def test_slot_widths_are_peg_plus_two_sided_clearance(self):
        self.assertEqual(self.layout.slot_widths_mm,
                         [PARAMS.peg_width_mm + 2 * s for s in PARAMS.clearance_steps_mm])
        self.assertEqual(self.layout.slot_widths_mm, sorted(self.layout.slot_widths_mm))

    def test_ring_bores_exist_in_mesh(self):
        flat = [v for t in self.tris for v in t]
        for cx, cy, bore in self.layout.ring_centers:
            near = [math.hypot(v[0] - cx, v[1] - cy) for v in flat
                    if abs(v[0] - cx) < bore and abs(v[1] - cy) < bore]
            self.assertAlmostEqual(min(near), bore / 2.0, places=5,
                                   msg=f"inner wall of the {bore} mm ring must be present")

    def test_bbox(self):
        lo, hi = self.layout.bbox_mm
        self.assertEqual(lo, (0.0, 0.0, 0.0))
        self.assertAlmostEqual(hi[0], 42.0 + sum(PARAMS.slot_widths_mm), places=6)
        self.assertAlmostEqual(hi[2], 18.0, places=6)

    def test_invalid_params_rejected(self):
        with self.assertRaises(ValueError):
            build(CouponParams(clearance_steps_mm=(0.2, 0.1)))
        with self.assertRaises(ValueError):
            build(CouponParams(clearance_steps_mm=(-0.1,)))
        with self.assertRaises(ValueError):
            build(CouponParams(peg_width_mm=0))
        with self.assertRaises(ValueError):
            build(CouponParams(peg_foot_relief_mm=6.0))


class ManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tris, layout = build(PARAMS)
        cls.stl = to_binary_stl(tris)
        cls.manifest = build_manifest(PARAMS, layout, cls.stl,
                                      printer_id="p1s-01", printer_model="Bambu P1S",
                                      nozzle_mm=0.4, material="PLA", slicer_settings="test-profile")

    def test_artifact_identity_matches_bytes_and_contract_shape(self):
        art = self.manifest["artifact"]
        self.assertEqual(art["sha256"], hashlib.sha256(self.stl).hexdigest())
        self.assertEqual(art["byteLength"], len(self.stl))
        # Same formats the TypeScript contract enforces (packages/contracts).
        self.assertRegex(art["sha256"], r"^[a-f0-9]{64}$")
        self.assertRegex(art["mediaType"], r"^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$")
        scope = self.manifest["calibrationScope"]
        self.assertRegex(scope["slicerSettingsSha256"], r"^[a-f0-9]{64}$")
        self.assertAlmostEqual(math.hypot(*scope["orientation"]), 1.0, places=9)
        self.assertGreater(scope["nozzleDiameterMm"], 0)

    def test_scope_status_flags_unspecified(self):
        tris, layout = build(PARAMS)
        manifest = build_manifest(PARAMS, layout, self.stl, printer_id="unspecified-printer",
                                  printer_model="unspecified-model", nozzle_mm=0.4,
                                  material="unspecified-material", slicer_settings="x")
        self.assertEqual(manifest["scopeStatus"], "template-replace-before-evidence")
        self.assertEqual(self.manifest["scopeStatus"], "declared-by-operator-not-verified-here")

    def test_non_unit_orientation_rejected(self):
        tris, layout = build(PARAMS)
        with self.assertRaises(ValueError):
            build_manifest(PARAMS, layout, self.stl, printer_id="a", printer_model="b",
                           nozzle_mm=0.4, material="c", slicer_settings="d",
                           orientation=(1.0, 1.0, 0.0))


class ProfileTests(unittest.TestCase):
    def test_derive_profile_math(self):
        profile = derive_profile(PARAMS, {
            "shrinkageBarMm": 99.6, "squareBossMm": 20.15,
            "ringBoresMm": [3.8, 5.8, 7.85, 9.85],
            "firstFreeSlotIndex": 3, "minReliableWallMm": 1.6,
        })
        self.assertAlmostEqual(profile["xyScaleMeasured"], 0.996)
        self.assertAlmostEqual(profile["xyScaleCorrection"], 100 / 99.6)
        self.assertAlmostEqual(profile["outerBiasMm"], 0.15)
        self.assertAlmostEqual(profile["holeBiasMm"], -0.175, msg="holes printing small = negative bias")
        self.assertEqual(profile["recommendedRadialClearanceMm"], 0.15)
        self.assertEqual(profile["minReliableWallMm"], 1.6)

    def test_derive_profile_rejects_garbage(self):
        base = {"shrinkageBarMm": 100.0, "squareBossMm": 20.0,
                "ringBoresMm": [4.0, 6.0, 8.0, 10.0],
                "firstFreeSlotIndex": None, "minReliableWallMm": None}
        with self.assertRaises(ValueError):
            derive_profile(PARAMS, {**base, "ringBoresMm": [4.0]})
        with self.assertRaises(ValueError):
            derive_profile(PARAMS, {**base, "firstFreeSlotIndex": 99})
        with self.assertRaises(ValueError):
            derive_profile(PARAMS, {**base, "minReliableWallMm": 1.7})
        with self.assertRaises(ValueError):
            derive_profile(PARAMS, {**base, "shrinkageBarMm": -1})


if __name__ == "__main__":
    unittest.main()
