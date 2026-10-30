#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Synthetic-only unit and local BambuStudio integration tests for tools/printability."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import math
import plistlib
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest import mock
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR))

import analyzer  # noqa: E402
import dry_run  # noqa: E402
import orient  # noqa: E402
import printability  # noqa: E402
import profiles  # noqa: E402


def _tri_normal(a: tuple[float, float, float], b: tuple[float, float, float], c: tuple[float, float, float]) -> tuple[float, float, float]:
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    ln = math.sqrt(nx * nx + ny * ny + nz * nz)
    return (nx / ln, ny / ln, nz / ln)


def pack_binary_stl(tris: list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]], *, zero_normals: bool = False) -> bytes:
    buf = bytearray(80) + struct.pack("<I", len(tris))
    for a, b, c in tris:
        n = (0.0, 0.0, 0.0) if zero_normals else _tri_normal(a, b, c)
        buf += struct.pack("<12fH", *n, *a, *b, *c, 0)
    return bytes(buf)


def build_rectilinear_solid(
    xs: list[float],
    ys: list[float],
    zs: list[float],
    occupied_fn,
) -> bytes:
    """Build a closed, outward-wound binary STL from a rectilinear cell complex."""
    nx, ny, nz = len(xs) - 1, len(ys) - 1, len(zs) - 1

    def occ(i: int, j: int, k: int) -> bool:
        if 0 <= i < nx and 0 <= j < ny and 0 <= k < nz:
            return bool(occupied_fn(i, j, k))
        return False

    tris: list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]] = []
    for i in range(nx):
        x0, x1 = xs[i], xs[i + 1]
        for j in range(ny):
            y0, y1 = ys[j], ys[j + 1]
            for k in range(nz):
                if not occ(i, j, k):
                    continue
                z0, z1 = zs[k], zs[k + 1]
                if not occ(i, j, k - 1):  # -Z face
                    tris.append(((x0, y0, z0), (x0, y1, z0), (x1, y1, z0)))
                    tris.append(((x0, y0, z0), (x1, y1, z0), (x1, y0, z0)))
                if not occ(i, j, k + 1):  # +Z face
                    tris.append(((x0, y0, z1), (x1, y0, z1), (x1, y1, z1)))
                    tris.append(((x0, y0, z1), (x1, y1, z1), (x0, y1, z1)))
                if not occ(i, j - 1, k):  # -Y face
                    tris.append(((x0, y0, z0), (x1, y0, z0), (x1, y0, z1)))
                    tris.append(((x0, y0, z0), (x1, y0, z1), (x0, y0, z1)))
                if not occ(i, j + 1, k):  # +Y face
                    tris.append(((x0, y1, z0), (x0, y1, z1), (x1, y1, z1)))
                    tris.append(((x0, y1, z0), (x1, y1, z1), (x1, y1, z0)))
                if not occ(i - 1, j, k):  # -X face
                    tris.append(((x0, y0, z0), (x0, y0, z1), (x0, y1, z1)))
                    tris.append(((x0, y0, z0), (x0, y1, z1), (x0, y1, z0)))
                if not occ(i + 1, j, k):  # +X face
                    tris.append(((x1, y0, z0), (x1, y1, z0), (x1, y1, z1)))
                    tris.append(((x1, y0, z0), (x1, y1, z1), (x1, y0, z1)))
    return pack_binary_stl(tris)


def synthetic_cube_stl(size: float = 20.0) -> bytes:
    return build_rectilinear_solid([0.0, size], [0.0, size], [0.0, size], lambda _i, _j, _k: True)


def synthetic_pocketed_cradle_stl(
    width: float = 70.0,
    depth: float = 44.0,
    height: float = 20.0,
    wall: float = 3.0,
    floor: float = 2.0,
) -> bytes:
    xs = [0.0, wall, width - wall, width]
    ys = [0.0, wall, depth - wall, depth]
    zs = [0.0, floor, height]
    return build_rectilinear_solid(
        xs,
        ys,
        zs,
        lambda i, j, k: not (i == 1 and j == 1 and k == 1),
    )


def synthetic_overhang_cantilever_stl() -> bytes:
    # Base [0, 50] x [0, 30] x [0, 6]; pillar [0, 12] x [0, 30] x [6, 20];
    # horizontal mid-air arm [12, 34] x [0, 30] x [14, 20] (660 mm^2 at 90 deg overhang).
    xs = [0.0, 12.0, 34.0, 50.0]
    ys = [0.0, 30.0]
    zs = [0.0, 6.0, 14.0, 20.0]

    def occ(i: int, _j: int, k: int) -> bool:
        if k == 0:
            return True
        if i == 0 and k in (1, 2):
            return True
        if i == 1 and k == 2:
            return True
        return False

    return build_rectilinear_solid(xs, ys, zs, occ)


FAKE_SLICER_SCRIPT = r"""#!{py}
import json, os, sys, zipfile
a = sys.argv[1:]
def opt(k): return a[a.index(k) + 1]
out, settings_out, three_mf_name = opt("--outputdir"), opt("--export-settings"), opt("--export-3mf")
mp, pp = opt("--load-settings").split(";")
merged = dict(json.load(open(mp)))
merged.update(json.load(open(pp)))
merged.update(json.load(open(opt("--load-filaments"))))
bed = merged.get("curr_bed_type", "Cool Plate")
nozzle_t = ",".join(merged.get("nozzle_type", ["stainless_steel"]))
sup = merged.get("enable_support", "0")
density = {"PLA": 1.26, "PETG": 1.27}[merged["filament_type"][0]]
gcode = (
    "; HEADER_BLOCK_START\n"
    "; BambuStudio 02.08.02.61\n"
    "; model printing time: 18m 12s; total estimated time: 24m 30s\n"
    "; total layer number: 100\n"
    "; total filament length [mm] : 3120.50\n"
    "; total filament volume [cm^3] : 7505.68\n"
    f"; total filament weight [g] : {9.46 * density / 1.26:.2f}\n"
    f"; filament_density: {density}\n"
    "; filament_diameter: 1.75\n"
    "; max_z_height: 20.00\n"
    "; HEADER_BLOCK_END\n"
    "; CONFIG_BLOCK_START\n"
    f"; curr_bed_type = {bed}\n"
    f"; nozzle_type = {nozzle_t}\n"
    f"; enable_support = {sup}\n"
    "; CONFIG_BLOCK_END\n"
    "M620 S0A\n"
    "G28\n"
)
with open(os.path.join(out, "plate_1.gcode"), "w") as f:
    f.write(gcode)
with zipfile.ZipFile(os.path.join(out, three_mf_name), "w", compression=zipfile.ZIP_DEFLATED) as zf:
    zf.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    zf.writestr("3D/3dmodel.model", '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter"/>')
    zf.writestr("Metadata/plate_1.gcode", gcode)
    zf.writestr("Metadata/plate_1.json", json.dumps({"plate_index": 0, "bed_type": bed}))
    zf.writestr("Metadata/slice_info.config", '<?xml version="1.0" encoding="UTF-8"?><config><plate><metadata key="index" value="1"/></plate></config>')
with open(settings_out, "w") as f:
    json.dump(merged, f, sort_keys=True)
"""

FAKE_SANDBOX_SCRIPT = r"""#!{py}
import os, re, sys
assert sys.argv[1] == "-f"
prof = open(sys.argv[2]).read()
assert "(deny network*)" in prof and "(deny mach-lookup)" in prof and "(deny signal)" in prof
assert not re.search(r"\(\s*allow\s+mach-lookup\s*\)", prof)
os.execv(sys.argv[3], sys.argv[3:])
"""


def make_fake_bambu_bundle(root: Path) -> tuple[Path, object]:
    b = root / "FakeBambuStudio.app"
    c = b / "Contents"
    (c / "MacOS").mkdir(parents=True, exist_ok=True)
    (c / "Info.plist").write_bytes(
        plistlib.dumps({"CFBundleShortVersionString": "02.08.02.61", "CFBundleVersion": "02.08.02.61"})
    )
    exe = c / "MacOS" / "BambuStudio"
    exe.write_text(FAKE_SLICER_SCRIPT.replace("{py}", sys.executable))
    exe.chmod(0o755)

    prof = c / "Resources" / "profiles"
    (prof / "BBL" / "machine").mkdir(parents=True, exist_ok=True)
    (prof / "BBL" / "process").mkdir(parents=True, exist_ok=True)
    (prof / "BBL" / "filament").mkdir(parents=True, exist_ok=True)
    (prof / "BBL.json").write_text('{"name": "BBL"}')
    (prof / "BBL" / "cli_config.json").write_text('{"machine_limits": {}}')
    (prof / "BBL/machine/Bambu Lab P1S 0.4 nozzle.json").write_text(
        json.dumps({"printer_model": "Bambu Lab P1S", "nozzle_diameter": ["0.4"], "nozzle_type": ["stainless_steel", "stainless_steel"]})
    )
    (prof / "BBL/process/0.20mm Standard @BBL X1C.json").write_text(json.dumps({"layer_height": "0.2", "enable_support": "0"}))
    (prof / "BBL/filament/Bambu PLA Basic @BBL P1S 0.4 nozzle.json").write_text(json.dumps({"filament_type": ["PLA"]}))

    sb_path = root / "fake-sandbox-exec"
    sb_path.write_text(FAKE_SANDBOX_SCRIPT.replace("{py}", sys.executable))
    sb_path.chmod(0o755)

    class _FakeSandbox:
        path = str(sb_path)

        def describe(self):
            return {"kind": "macos-sandbox-exec", "path": "/usr/bin/sandbox-exec"}

        def check(self):
            if not sb_path.is_file():
                raise RuntimeError("missing fake sandbox")

    return b, _FakeSandbox()


class PrintabilityGeometryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="stm-printability-test-")
        self.root = Path(self.tmp.name)
        self.p1s, self.pla = profiles.resolve_profile("p1s-0.4-hardened")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write_stl(self, name: str, data: bytes) -> Path:
        p = self.root / name
        p.write_bytes(data)
        return p

    def test_catalog_contains_operator_baseline_and_common_bambu_models(self) -> None:
        cat = profiles.load_catalog()
        self.assertEqual(cat["defaultOperatorProfile"], "p1s-0.4-hardened")
        p1s, mat = profiles.resolve_profile("p1s")
        self.assertEqual(p1s["id"], "p1s-0.4-hardened")
        self.assertEqual(p1s["bambuModel"], "p1s")
        self.assertEqual(p1s["nozzleDiameterMm"], 0.4)
        self.assertEqual(p1s["nozzleType"], "hardened_steel")
        self.assertEqual(p1s["bedType"], "textured_plate")
        self.assertEqual(mat["family"], "PLA")
        for alias in ("p1p", "p2s", "x1c", "x1e", "a1", "a1mini", "h2d", "h2s"):
            prof, _ = profiles.resolve_profile(alias)
            self.assertEqual(prof["bambuModel"], alias)

    def test_synthetic_cube_printable_and_exact_metrics(self) -> None:
        stl = self.write_stl("cube.stl", synthetic_cube_stl(20.0))
        rep = analyzer.analyze_stl(stl, self.p1s, self.pla)
        self.assertEqual(rep["verdict"], "printable")
        self.assertEqual(rep["reasonCodes"], ["all-checks-passed"])
        self.assertTrue(rep["topology"]["watertight"])
        self.assertTrue(rep["checks"]["bedFit"]["fits"])
        self.assertEqual(rep["checks"]["bedFit"]["partExtentsMm"], [20.0, 20.0, 20.0])
        self.assertTrue(rep["checks"]["baseStability"]["ok"])
        self.assertAlmostEqual(rep["checks"]["baseStability"]["flatBaseAreaMm2"], 400.0, places=4)
        self.assertAlmostEqual(rep["checks"]["baseStability"]["minTipAngleDeg"], 45.0, places=2)
        self.assertAlmostEqual(rep["checks"]["wallThickness"]["minWallMm"], 20.0, places=3)
        self.assertEqual(rep["checks"]["overhangs"]["overhangAreaPercent"], 0.0)
        self.assertEqual(rep["checks"]["overhangs"]["locations"], [])
        self.assertAlmostEqual(rep["estimates"]["meshSolidVolumeMm3"], 8000.0, places=3)
        self.assertAlmostEqual(rep["estimates"]["meshSolidVolumeCm3"], 8.0, places=5)

    def test_synthetic_pocketed_cradle_block_printable(self) -> None:
        stl = self.write_stl("pocket_cradle.stl", synthetic_pocketed_cradle_stl())
        rep = analyzer.analyze_stl(stl, self.p1s, self.pla)
        self.assertEqual(rep["verdict"], "printable")
        self.assertTrue(rep["topology"]["watertight"])
        self.assertAlmostEqual(rep["checks"]["baseStability"]["flatBaseAreaMm2"], 3080.0, places=3)
        # Floor is 2.0 mm thick; side walls are 3.0 mm thick -> minWallMm == 2.0 mm (5x 0.4 mm nozzle)
        self.assertAlmostEqual(rep["checks"]["wallThickness"]["minWallMm"], 2.0, places=3)
        self.assertAlmostEqual(rep["checks"]["wallThickness"]["wallToNozzleRatio"], 5.0, places=2)
        self.assertEqual(rep["checks"]["overhangs"]["overhangAreaMm2"], 0.0)
        expected_vol = 70.0 * 44.0 * 20.0 - (70.0 - 6.0) * (44.0 - 6.0) * (20.0 - 2.0)
        self.assertAlmostEqual(rep["estimates"]["meshSolidVolumeMm3"], expected_vol, places=2)

    def test_synthetic_overhang_piece_printable_with_supports_and_locates_region(self) -> None:
        stl = self.write_stl("overhang.stl", synthetic_overhang_cantilever_stl())
        rep = analyzer.analyze_stl(stl, self.p1s, self.pla)
        self.assertEqual(rep["verdict"], "printable-with-supports")
        self.assertEqual(rep["reasonCodes"], ["overhangs-require-supports"])
        self.assertTrue(rep["checks"]["baseStability"]["ok"])
        oh = rep["checks"]["overhangs"]
        self.assertTrue(oh["requiresSupports"])
        self.assertAlmostEqual(oh["overhangAreaMm2"], 660.0, places=3)
        self.assertAlmostEqual(oh["maxOverhangDeg"], 90.0, places=3)
        self.assertEqual(len(oh["locations"]), 1)
        loc = oh["locations"][0]
        self.assertAlmostEqual(loc["areaMm2"], 660.0, places=3)
        self.assertEqual(loc["centroidMm"], [23.0, 15.0, 14.0])

    def test_bed_fit_and_exclusion_zone_checks(self) -> None:
        # 200x200x20 fits P1S (256x256) but exceeds A1 mini (180x180)
        med = self.write_stl("plate200.stl", build_rectilinear_solid([0.0, 200.0], [0.0, 200.0], [0.0, 20.0], lambda *_: True))
        a1m, pla = profiles.resolve_profile("a1mini-0.4")
        self.assertEqual(analyzer.analyze_stl(med, self.p1s, pla)["verdict"], "printable")
        rep_a1m = analyzer.analyze_stl(med, a1m, pla)
        self.assertEqual(rep_a1m["verdict"], "not-printable")
        self.assertIn("exceeds-build-volume", rep_a1m["reasonCodes"])

        # 255x255x10 collides with P1S 18x28 cutter exclusion zone, but fits A1 (256x256, no exclusion)
        full = self.write_stl("plate255.stl", build_rectilinear_solid([0.0, 255.0], [0.0, 255.0], [0.0, 10.0], lambda *_: True))
        a1, _ = profiles.resolve_profile("a1-0.4")
        rep_p1s = analyzer.analyze_stl(full, self.p1s, pla)
        self.assertEqual(rep_p1s["verdict"], "not-printable")
        self.assertIn("intersects-bed-exclusion-zone", rep_p1s["reasonCodes"])
        self.assertEqual(analyzer.analyze_stl(full, a1, pla)["verdict"], "printable")

    def test_thin_wall_vs_nozzle_diameter(self) -> None:
        # 0.25 mm side walls: unprintable on 0.4 mm nozzle, single-perimeter warning on 0.2 mm nozzle
        xs = [0.0, 0.25, 19.75, 20.0]
        ys = [0.0, 0.25, 19.75, 20.0]
        zs = [0.0, 2.0, 12.0]
        thin = self.write_stl("thin.stl", build_rectilinear_solid(xs, ys, zs, lambda i, j, k: not (i == 1 and j == 1 and k == 1)))
        rep_04 = analyzer.analyze_stl(thin, self.p1s, self.pla)
        self.assertEqual(rep_04["verdict"], "not-printable")
        self.assertIn("wall-thinner-than-nozzle", rep_04["reasonCodes"])
        self.assertAlmostEqual(rep_04["checks"]["wallThickness"]["minWallMm"], 0.25, places=3)

        p1s_02, pla = profiles.resolve_profile("p1s-0.2")
        rep_02 = analyzer.analyze_stl(thin, p1s_02, pla)
        self.assertEqual(rep_02["verdict"], "printable")
        self.assertEqual([w["code"] for w in rep_02["warnings"]], ["single-perimeter-thin-wall"])

    def test_missing_flat_base_and_unstable_com_rejected(self) -> None:
        # Octahedron resting on a single point at (0, 0, 0) -> zero flat base area
        pts_top = (0.0, 0.0, 20.0)
        pts_bot = (0.0, 0.0, 0.0)
        ring = [(10.0, 0.0, 10.0), (0.0, 10.0, 10.0), (-10.0, 0.0, 10.0), (0.0, -10.0, 10.0)]
        oct_tris = []
        for idx in range(4):
            a, b = ring[idx], ring[(idx + 1) % 4]
            oct_tris.append((a, b, pts_top))
            oct_tris.append((b, a, pts_bot))
        point_stl = self.write_stl("point_base.stl", pack_binary_stl(oct_tris))
        rep_pt = analyzer.analyze_stl(point_stl, self.p1s, self.pla)
        self.assertEqual(rep_pt["verdict"], "not-printable")
        self.assertIn("missing-flat-base", rep_pt["reasonCodes"])

        # Top-heavy block whose CoM projects outside its narrow [0, 4] base support polygon
        xs = [0.0, 4.0, 34.0]
        ys = [0.0, 20.0]
        zs = [0.0, 8.0, 26.0]
        tipping = self.write_stl(
            "tipping.stl",
            build_rectilinear_solid(xs, ys, zs, lambda i, _j, k: (i == 0 and k == 0) or k == 1),
        )
        rep_tip = analyzer.analyze_stl(tipping, self.p1s, self.pla)
        self.assertEqual(rep_tip["verdict"], "not-printable")
        self.assertIn("unstable-base-contact", rep_tip["reasonCodes"])

    def test_disconnected_solids_cannot_mask_an_unstable_part(self) -> None:
        # A 4 x 4 x 100 mm tower plus a separate 40 x 40 x 5 mm block: the block must
        # not lend the tower its stability (connector review on PR #79).
        xs, ys, zs = [0.0, 4.0, 10.0, 50.0], [0.0, 4.0, 40.0], [0.0, 5.0, 100.0]
        both = self.write_stl(
            "tower_and_block.stl",
            build_rectilinear_solid(xs, ys, zs, lambda i, j, k: (i == 0 and j == 0) or (i == 2 and k == 0)),
        )
        rep = analyzer.analyze_stl(both, self.p1s, self.pla)
        self.assertEqual(rep["verdict"], "not-printable")
        self.assertIn("multiple-disconnected-solids", rep["reasonCodes"])
        cube = self.write_stl("single_cube.stl", synthetic_cube_stl())
        self.assertEqual(analyzer.analyze_stl(cube, self.p1s, self.pla)["topology"]["solidCount"], 1)

    def test_duplicated_facets_are_not_manifold(self) -> None:
        cube = synthetic_cube_stl()
        count = struct.unpack_from("<I", cube, 80)[0]
        duplicated = cube[:80] + struct.pack("<I", count * 2) + cube[84:] * 2
        stl = self.write_stl("duplicated.stl", duplicated)
        for use_numpy in (False, True):
            with self.subTest(use_numpy=use_numpy):
                rep = analyzer.analyze_stl(stl, self.p1s, self.pla, use_numpy=use_numpy)
                self.assertEqual(rep["verdict"], "not-printable")
                self.assertFalse(rep["topology"]["watertight"])
                self.assertEqual(rep["topology"]["nonManifoldSharedEdgeCount"], 18)
                self.assertIn("mesh-not-watertight", rep["reasonCodes"])

    def test_degenerate_facets_rejected_in_check_and_dry_run(self) -> None:
        # Regression test for PR #79 review comment 4429096115: appending a zero-area
        # facet with a unit normal to an otherwise watertight 20 mm cube must block
        # printability and dry-run rather than silently analyzing a cleaned subset.
        cube = synthetic_cube_stl(20.0)
        count = struct.unpack_from("<I", cube, 80)[0]
        degen_facet = struct.pack(
            "<12fH",
            0.0, 0.0, 1.0,
            0.0, 0.0, 0.0,
            10.0, 0.0, 0.0,
            20.0, 0.0, 0.0,
            0,
        )
        cube_with_degen = cube[:80] + struct.pack("<I", count + 1) + cube[84:] + degen_facet
        stl = self.write_stl("cube_with_degen.stl", cube_with_degen)
        for use_numpy in (False, True):
            with self.subTest(use_numpy=use_numpy):
                rep = analyzer.analyze_stl(stl, self.p1s, self.pla, use_numpy=use_numpy)
                self.assertEqual(rep["verdict"], "not-printable")
                self.assertFalse(rep["topology"]["watertight"])
                self.assertEqual(rep["topology"]["degenerateFacetCount"], 1)
                self.assertIn("degenerate-facets", rep["reasonCodes"])

        # Dry-run must also refuse to slice before invoking BambuStudio
        fake_bundle, fake_sandbox = make_fake_bambu_bundle(self.root / "degen-bundle")
        tpl = self.root / "degen-tpl"
        tpl.mkdir()
        (tpl / "cradle.stl").write_bytes(cube_with_degen)
        (tpl / "manifest.json").write_text(
            json.dumps({
                "schemaVersion": 1,
                "units": "mm",
                "previewOnly": True,
                "provesPhysicalAccuracy": False,
                "watertight": True,
                "outputSha256": {"cradle.stl": hashlib.sha256(cube_with_degen).hexdigest()},
            }) + "\n"
        )
        out_degen = self.root / "out-degen"
        with mock.patch.object(dry_run.producer, "produce") as mocked_produce:
            with self.assertRaises(dry_run.DryRunError) as cm:
                dry_run.run_dry_run(
                    template_dir=tpl,
                    profile_id="p1s-0.4-hardened",
                    out_dir=out_degen,
                    bundle=str(fake_bundle),
                    _sandbox=fake_sandbox,
                )
            mocked_produce.assert_not_called()
        self.assertEqual(cm.exception.stage, "printability")
        self.assertIn("degenerate-facets", cm.exception.evidence["reasonCodes"])
        self.assertFalse(out_degen.exists())

    def test_open_mesh_and_zero_normals_rejected(self) -> None:
        # Open box (missing +Z face)
        open_tris = [
            ((0.0, 0.0, 0.0), (0.0, 10.0, 0.0), (10.0, 10.0, 0.0)),
            ((0.0, 0.0, 0.0), (10.0, 10.0, 0.0), (10.0, 0.0, 0.0)),
            ((0.0, 0.0, 0.0), (10.0, 0.0, 0.0), (10.0, 0.0, 10.0)),
            ((0.0, 0.0, 0.0), (10.0, 0.0, 10.0), (0.0, 0.0, 10.0)),
            ((0.0, 10.0, 0.0), (0.0, 10.0, 10.0), (10.0, 10.0, 10.0)),
            ((0.0, 10.0, 0.0), (10.0, 10.0, 10.0), (10.0, 10.0, 0.0)),
        ]
        open_stl = self.write_stl("open.stl", pack_binary_stl(open_tris))
        rep_open = analyzer.analyze_stl(open_stl, self.p1s, self.pla)
        self.assertEqual(rep_open["verdict"], "not-printable")
        self.assertIn("mesh-not-watertight", rep_open["reasonCodes"])

        # Binary STL with zero normals
        zero_norm_cube = self.write_stl(
            "zero_norm.stl",
            pack_binary_stl([
                ((0.0, 0.0, 0.0), (0.0, 10.0, 0.0), (10.0, 10.0, 0.0)),
                ((0.0, 0.0, 0.0), (10.0, 10.0, 0.0), (10.0, 0.0, 0.0)),
                ((0.0, 0.0, 0.0), (10.0, 0.0, 0.0), (5.0, 5.0, 10.0)),
                ((10.0, 0.0, 0.0), (10.0, 10.0, 0.0), (5.0, 5.0, 10.0)),
                ((10.0, 10.0, 0.0), (0.0, 10.0, 0.0), (5.0, 5.0, 10.0)),
                ((0.0, 10.0, 0.0), (0.0, 0.0, 0.0), (5.0, 5.0, 10.0)),
            ], zero_normals=True),
        )
        rep_zn = analyzer.analyze_stl(zero_norm_cube, self.p1s, self.pla)
        self.assertEqual(rep_zn["verdict"], "not-printable")
        self.assertIn("invalid-stl-normals", rep_zn["reasonCodes"])

    def test_determinism_and_ascii_and_backend_parity(self) -> None:
        stl = self.write_stl("pocket.stl", synthetic_pocketed_cradle_stl())
        r1 = json.dumps(analyzer.analyze_stl(stl, self.p1s, self.pla, use_numpy=False), sort_keys=True)
        r2 = json.dumps(analyzer.analyze_stl(stl, self.p1s, self.pla, use_numpy=False), sort_keys=True)
        self.assertEqual(r1, r2)
        if analyzer.HAS_NUMPY:
            r_np = json.dumps(analyzer.analyze_stl(stl, self.p1s, self.pla, use_numpy=True), sort_keys=True)
            self.assertEqual(r1, r_np)

        # ASCII STL tetrahedron with wide flat base
        ascii_stl = self.write_stl(
            "tet.stl",
            (
                "solid tet\n"
                "facet normal 0 0 -1\nouter loop\nvertex 0 0 0\nvertex 0 20 0\nvertex 20 0 0\nendloop\nendfacet\n"
                "facet normal 0 -1 0\nouter loop\nvertex 0 0 0\nvertex 20 0 0\nvertex 5 5 10\nendloop\nendfacet\n"
                "facet normal -1 0 0\nouter loop\nvertex 0 0 0\nvertex 5 5 10\nvertex 0 20 0\nendloop\nendfacet\n"
                "facet normal 0.577 0.577 0.577\nouter loop\nvertex 20 0 0\nvertex 0 20 0\nvertex 5 5 10\nendloop\nendfacet\n"
                "endsolid tet\n"
            ).encode("utf-8"),
        )
        rep_ascii = analyzer.analyze_stl(ascii_stl, self.p1s, self.pla)
        self.assertEqual(rep_ascii["input"]["format"], "ascii-stl")
        self.assertEqual(rep_ascii["verdict"], "printable")


class DryRunIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="stm-dryrun-test-")
        self.root = Path(self.tmp.name)
        self.fake_bundle, self.fake_sandbox = make_fake_bambu_bundle(self.root)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def make_scan_cradle_dir(self, name: str, stl_bytes: bytes) -> Path:
        d = self.root / name
        d.mkdir(parents=True, exist_ok=True)
        stl_path = d / "cradle.stl"
        stl_path.write_bytes(stl_bytes)
        manifest = {
            "schemaVersion": 1,
            "units": "mm",
            "previewOnly": True,
            "provesPhysicalAccuracy": False,
            "watertight": True,
            "outputSha256": {"cradle.stl": hashlib.sha256(stl_bytes).hexdigest()},
        }
        (d / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        return d

    def make_drawer_dir(self, name: str, stl_bytes: bytes) -> Path:
        d = self.root / name
        d.mkdir(parents=True, exist_ok=True)
        stl_path = d / "drawer-tray.stl"
        stl_path.write_bytes(stl_bytes)
        manifest = {
            "schemaVersion": "0.1.0",
            "kind": "drawer-tray",
            "status": "preview-geometry-not-print-authorized",
            "artifact": {
                "mediaType": "model/stl",
                "byteLength": len(stl_bytes),
                "sha256": hashlib.sha256(stl_bytes).hexdigest(),
            },
        }
        (d / "drawer-tray.manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        return d

    def test_source_swap_cannot_bypass_verified_unprintable_snapshot(self) -> None:
        tpl = self.make_scan_cradle_dir("swap", synthetic_cube_stl(300.0))
        original_verify = dry_run.verify_template_output

        def swap_source(stl, manifest):
            verified = original_verify(stl, manifest)
            stl.write_bytes(synthetic_cube_stl())
            return verified

        out = self.root / "out-swap"
        with mock.patch.object(dry_run, "verify_template_output", side_effect=swap_source), \
                mock.patch.object(dry_run.producer, "produce") as produce:
            with self.assertRaisesRegex(dry_run.DryRunError, "unprintable"):
                dry_run.run_dry_run(template_dir=tpl, profile_id="p1s", out_dir=out,
                                    bundle=str(self.fake_bundle), _sandbox=self.fake_sandbox)
            produce.assert_not_called()
        self.assertFalse(out.exists())

    def test_printability_digest_mismatch_blocks_slicing(self) -> None:
        tpl = self.make_scan_cradle_dir("digest", synthetic_cube_stl())
        original_analyze = dry_run.analyze_stl

        def wrong_digest(*args, **kwargs):
            report = original_analyze(*args, **kwargs)
            report["input"]["sha256"] = "0" * 64
            return report

        out = self.root / "out-digest"
        with mock.patch.object(dry_run, "analyze_stl", side_effect=wrong_digest), \
                mock.patch.object(dry_run.producer, "produce") as produce:
            with self.assertRaisesRegex(dry_run.DryRunError, "digest mismatch"):
                dry_run.run_dry_run(template_dir=tpl, profile_id="p1s", out_dir=out,
                                    bundle=str(self.fake_bundle), _sandbox=self.fake_sandbox)
            produce.assert_not_called()
        self.assertFalse(out.exists())

    def test_material_and_resolved_filament_must_agree(self) -> None:
        tpl = self.make_scan_cradle_dir("material", synthetic_cube_stl())
        petg = "Synthetic PETG"
        preset = self.fake_bundle / "Contents/Resources/profiles/BBL/filament" / (petg + ".json")
        preset.write_text(json.dumps({"filament_type": ["PETG"]}))
        for label, options in (
            ("petg-with-default-pla", {"material": "PETG"}),
            ("pla-with-petg-override", {"material": "PLA", "filament_preset": petg}),
            ("default-pla-with-petg-override", {"filament_preset": petg}),
        ):
            with self.subTest(label=label):
                out = self.root / label
                with mock.patch.object(dry_run.producer, "produce") as produce:
                    with self.assertRaisesRegex(dry_run.DryRunError, "filament.*material"):
                        dry_run.run_dry_run(template_dir=tpl, profile_id="p1s", out_dir=out,
                                            bundle=str(self.fake_bundle), **options)
                    produce.assert_not_called()
                self.assertFalse(out.exists())

    def test_matching_petg_override_binds_estimate_selection_and_preset(self) -> None:
        tpl = self.make_scan_cradle_dir("matching-material", synthetic_cube_stl())
        filament_dir = self.fake_bundle / "Contents/Resources/profiles/BBL/filament"
        (filament_dir / "Synthetic PETG base.json").write_text(json.dumps({"filament_type": ["PETG"]}))
        (filament_dir / "Synthetic PETG.json").write_text(json.dumps({"inherits": "Synthetic PETG base"}))
        out = self.root / "out-matching-material"
        result = dry_run.run_dry_run(
            template_dir=tpl, profile_id="p1s", out_dir=out,
            material="PETG", filament_preset="Synthetic PETG",
            bundle=str(self.fake_bundle), _sandbox=self.fake_sandbox,
        )
        report = json.loads((out / "printability.json").read_text())
        self.assertEqual(report["estimates"]["material"], "PETG")
        self.assertEqual(report["estimates"]["densityGPerCm3"], 1.27)
        self.assertEqual(result["companionPreparedSelectionCandidate"]["materials"][0]["material"], "PETG")
        settings = json.loads((out / "slice/exported-settings.json").read_text())
        self.assertEqual(settings["filament_type"], ["PETG"])

    def test_fake_bundle_dry_run_for_cradle_and_drawer_templates(self) -> None:
        cradle_dir = self.make_scan_cradle_dir("cradle-tpl", synthetic_pocketed_cradle_stl())
        out_cradle = self.root / "out-cradle"
        res = dry_run.run_dry_run(
            template_dir=cradle_dir,
            profile_id="p1s-0.4-hardened",
            out_dir=out_cradle,
            bundle=str(self.fake_bundle),
            _sandbox=self.fake_sandbox,
        )
        self.assertFalse(res["dispatchAuthorized"])
        self.assertFalse(res["printerContacted"])
        self.assertEqual(res["printability"]["verdict"], "printable")
        self.assertEqual(res["slice"]["overrides"]["bedType"], "textured_plate")
        self.assertEqual(res["slice"]["overrides"]["nozzleType"], "hardened_steel")
        self.assertIs(res["slice"]["overrides"]["enableSupport"], False)
        settings_sha = hashlib.sha256((out_cradle / "slice" / "exported-settings.json").read_bytes()).hexdigest()
        self.assertEqual(res["slice"]["slicerSettingsSha256"], settings_sha)
        self.assertEqual(res["companionPreparedSelectionCandidate"]["slicerSettingsSha256"], settings_sha)
        self.assertEqual(res["slice"]["summary"]["estimatedPrintSeconds"], 1470)
        self.assertEqual(res["slice"]["summary"]["filamentWeightG"], 9.46)

        three_mf_path = out_cradle / "slice" / "sliced-plate.3mf"
        gcode_path = out_cradle / "slice" / "plate_1.gcode"
        self.assertTrue(three_mf_path.is_file())
        self.assertFalse(three_mf_path.name.lower().endswith(".gcode.3mf"))
        three_mf_sha = hashlib.sha256(three_mf_path.read_bytes()).hexdigest()
        gcode_sha = hashlib.sha256(gcode_path.read_bytes()).hexdigest()
        self.assertEqual(res["slice"]["printableArtifact"]["file"], "slice/sliced-plate.3mf")
        self.assertEqual(res["slice"]["printableArtifact"]["mediaType"], "model/3mf")
        self.assertEqual(res["slice"]["printableArtifact"]["sha256"], three_mf_sha)
        self.assertEqual(res["slice"]["threeMfArtifact"]["sha256"], three_mf_sha)
        self.assertEqual(res["slice"]["threeMfArtifact"]["plateGcodeSha256"], gcode_sha)
        self.assertEqual(res["slice"]["gcodeArtifact"]["sha256"], gcode_sha)
        self.assertEqual(res["dispatchCandidate"]["artifact"]["file"], "slice/sliced-plate.3mf")
        self.assertEqual(res["dispatchCandidate"]["artifact"]["mediaType"], "model/3mf")
        self.assertEqual(res["dispatchCandidate"]["artifact"]["sha256"], three_mf_sha)
        self.assertEqual(res["dispatchCandidate"]["plateGcodeSha256"], gcode_sha)
        self.assertEqual(res["dispatchCandidate"]["tool"], "print_3mf")
        self.assertEqual(
            res["dispatchCandidate"]["argumentsTemplate"],
            {
                "three_mf_path": "slice/sliced-plate.3mf",
                "bambu_model": "p1s",
                "bed_type": "textured_plate",
                "plate_index": 0,
                "use_ams": True,
                "ams_slots": None,
            },
        )
        with zipfile.ZipFile(three_mf_path, "r") as zf:
            self.assertEqual(hashlib.sha256(zf.read("Metadata/plate_1.gcode")).hexdigest(), gcode_sha)
            self.assertIn("Metadata/plate_1.json", zf.namelist())
            self.assertIn("Metadata/slice_info.config", zf.namelist())

        # FitSpec drawer template output with custom non-.gcode.3mf project name
        drawer_stl = synthetic_pocketed_cradle_stl(width=140.0, depth=100.0, height=30.0, wall=2.0, floor=2.0)
        drawer_dir = self.make_drawer_dir("drawer-tpl", drawer_stl)
        out_drawer = self.root / "out-drawer"
        res_d = dry_run.run_dry_run(
            template_dir=drawer_dir,
            profile_id="p1s",
            out_dir=out_drawer,
            bundle=str(self.fake_bundle),
            three_mf_name="drawer-tray-p1s.3mf",
            _sandbox=self.fake_sandbox,
        )
        self.assertEqual(res_d["template"]["kind"], "drawer-tray")
        self.assertEqual(res_d["printability"]["verdict"], "printable")
        self.assertEqual(res_d["dispatchCandidate"]["artifact"]["file"], "slice/drawer-tray-p1s.3mf")
        self.assertTrue((out_drawer / "slice" / "drawer-tray-p1s.3mf").is_file())

        # Any *.gcode.3mf suffix is rejected fail-closed before slicing
        for bad_name in ("plate_1.gcode.3mf", "STAND.GCODE.3MF"):
            bad_out = self.root / f"out-bad-{bad_name}"
            with mock.patch.object(dry_run.producer, "produce") as mocked_produce:
                with self.assertRaises(dry_run.DryRunError) as bad_cm:
                    dry_run.run_dry_run(
                        template_dir=drawer_dir,
                        profile_id="p1s",
                        out_dir=bad_out,
                        bundle=str(self.fake_bundle),
                        three_mf_name=bad_name,
                        _sandbox=self.fake_sandbox,
                    )
                mocked_produce.assert_not_called()
            self.assertEqual(bad_cm.exception.stage, "input")
            self.assertFalse(bad_out.exists())

    def test_dry_run_gates_unprintable_supports_and_tampered_manifests(self) -> None:
        # 1. Oversized drawer refused before slicing
        big_stl = build_rectilinear_solid([0.0, 300.0], [0.0, 400.0], [0.0, 40.0], lambda *_: True)
        big_dir = self.make_drawer_dir("big-drawer", big_stl)
        with self.assertRaises(dry_run.DryRunError) as cm:
            dry_run.run_dry_run(
                template_dir=big_dir,
                profile_id="p1s-0.4-hardened",
                out_dir=self.root / "out-big",
                bundle=str(self.fake_bundle),
                _sandbox=self.fake_sandbox,
            )
        self.assertEqual(cm.exception.stage, "printability")
        self.assertFalse((self.root / "out-big").exists())

        # 2. Overhang piece refused without --allow-supports, accepted with allow_supports=True
        oh_dir = self.make_scan_cradle_dir("oh-tpl", synthetic_overhang_cantilever_stl())
        with self.assertRaises(dry_run.DryRunError) as cm2:
            dry_run.run_dry_run(
                template_dir=oh_dir,
                profile_id="p1s-0.4-hardened",
                out_dir=self.root / "out-oh-denied",
                bundle=str(self.fake_bundle),
                _sandbox=self.fake_sandbox,
            )
        self.assertEqual(cm2.exception.stage, "printability")
        self.assertFalse((self.root / "out-oh-denied").exists())

        res_oh = dry_run.run_dry_run(
            template_dir=oh_dir,
            profile_id="p1s-0.4-hardened",
            out_dir=self.root / "out-oh-allowed",
            bundle=str(self.fake_bundle),
            allow_supports=True,
            _sandbox=self.fake_sandbox,
        )
        self.assertEqual(res_oh["printability"]["verdict"], "printable-with-supports")
        self.assertIs(res_oh["slice"]["overrides"]["enableSupport"], True)

        # 3. Tampered STL fails template hash binding
        tampered_dir = self.make_scan_cradle_dir("tampered", synthetic_cube_stl(20.0))
        (tampered_dir / "cradle.stl").write_bytes(synthetic_cube_stl(25.0))
        with self.assertRaises(dry_run.DryRunError) as cm3:
            dry_run.run_dry_run(
                template_dir=tampered_dir,
                profile_id="p1s-0.4-hardened",
                out_dir=self.root / "out-tampered",
                bundle=str(self.fake_bundle),
                _sandbox=self.fake_sandbox,
            )
        self.assertEqual(cm3.exception.stage, "template")

        # 4. Missing explicit profile fails closed
        with self.assertRaises(dry_run.DryRunError) as cm4:
            dry_run.run_dry_run(
                template_dir=oh_dir,
                profile_id=None,
                out_dir=self.root / "out-no-prof",
                bundle=str(self.fake_bundle),
                _sandbox=self.fake_sandbox,
            )
        self.assertEqual(cm4.exception.stage, "profile")

    def test_cli_check_and_profiles_subcommands(self) -> None:
        stl = self.root / "cube.stl"
        stl.write_bytes(synthetic_cube_stl(20.0))
        out_json = self.root / "verdict.json"
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = printability.main(["check", str(stl), "--profile", "p1s-0.4-hardened", "--out", str(out_json), "--strict"])
        self.assertEqual(rc, 0)
        saved_text = out_json.read_text()
        self.assertEqual(buf.getvalue(), saved_text)
        saved = json.loads(saved_text)
        self.assertEqual(saved["verdict"], "printable")

        proc = subprocess.run(
            [sys.executable, str(ROOT_DIR / "printability.py"), "profiles"],
            capture_output=True,
            text=True,
            check=True,
        )
        cat = json.loads(proc.stdout)
        self.assertEqual(cat["defaultOperatorProfile"], "p1s-0.4-hardened")

    @unittest.skipUnless(
        sys.platform == "darwin" and Path("/Applications/BambuStudio.app/Contents/MacOS/BambuStudio").is_file(),
        "Real sandboxed BambuStudio slice runs on macOS hosts with /Applications/BambuStudio.app installed",
    )
    def test_real_bambustudio_slice_on_synthetic_cradle_and_overhang(self) -> None:
        cradle_dir = self.make_scan_cradle_dir("real-cradle", synthetic_pocketed_cradle_stl())
        out_cradle = self.root / "real-out-cradle"
        proc = subprocess.run(
            [
                sys.executable,
                str(ROOT_DIR / "printability.py"),
                "dry-run",
                "--template-dir",
                str(cradle_dir),
                "--profile",
                "p1s-0.4-hardened",
                "--out",
                str(out_cradle),
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        res = json.loads(proc.stdout)
        self.assertEqual(res["printability"]["verdict"], "printable")
        gcode_path = out_cradle / "slice" / "plate_1.gcode"
        three_mf_path = out_cradle / "slice" / "sliced-plate.3mf"
        settings_path = out_cradle / "slice" / "exported-settings.json"
        self.assertTrue(gcode_path.is_file() and gcode_path.stat().st_size > 1000)
        self.assertTrue(three_mf_path.is_file() and three_mf_path.stat().st_size > 1000)
        self.assertFalse(three_mf_path.name.lower().endswith(".gcode.3mf"))
        gcode_sha = hashlib.sha256(gcode_path.read_bytes()).hexdigest()
        three_mf_sha = hashlib.sha256(three_mf_path.read_bytes()).hexdigest()
        self.assertEqual(res["dispatchCandidate"]["artifact"]["file"], "slice/sliced-plate.3mf")
        self.assertEqual(res["dispatchCandidate"]["artifact"]["sha256"], three_mf_sha)
        self.assertEqual(res["dispatchCandidate"]["plateGcodeSha256"], gcode_sha)
        with zipfile.ZipFile(three_mf_path, "r") as zf:
            names = set(zf.namelist())
            self.assertIn("Metadata/plate_1.gcode", names)
            self.assertIn("Metadata/plate_1.json", names)
            self.assertIn("Metadata/slice_info.config", names)
            self.assertEqual(hashlib.sha256(zf.read("Metadata/plate_1.gcode")).hexdigest(), gcode_sha)
        self.assertEqual(res["slice"]["slicerSettingsSha256"], hashlib.sha256(settings_path.read_bytes()).hexdigest())
        summary = res["slice"]["summary"]
        self.assertGreater(summary["estimatedPrintSeconds"], 0)
        self.assertGreater(summary["filamentWeightG"], 0.0)
        self.assertEqual(summary["bedType"], "Textured PEI Plate")
        self.assertIn("hardened_steel", summary["nozzleType"])
        self.assertIs(summary["enableSupport"], False)

        # Also exercise real BambuStudio slice with supports enabled on the synthetic overhang piece
        oh_dir = self.make_scan_cradle_dir("real-oh", synthetic_overhang_cantilever_stl())
        out_oh = self.root / "real-out-oh"
        proc_oh = subprocess.run(
            [
                sys.executable,
                str(ROOT_DIR / "printability.py"),
                "dry-run",
                "--template-dir",
                str(oh_dir),
                "--profile",
                "p1s-0.4-hardened",
                "--allow-supports",
                "--out",
                str(out_oh),
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc_oh.returncode, 0, msg=proc_oh.stderr)
        res_oh = json.loads(proc_oh.stdout)
        self.assertEqual(res_oh["printability"]["verdict"], "printable-with-supports")
        self.assertIs(res_oh["slice"]["summary"]["enableSupport"], True)
        self.assertTrue((out_oh / "slice" / "sliced-plate.3mf").is_file())


class CliContractTests(unittest.TestCase):
    """Review follow-ups on PR #79: explicit profiles, strict exit code, companion-aligned caps."""

    def test_isolated_cli_profiles_and_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            stl = Path(tmp) / "cube.stl"
            stl.write_bytes(synthetic_cube_stl())
            for args in (["profiles"], ["check", str(stl), "--profile", "p1s", "--strict"]):
                with self.subTest(args=args):
                    result = subprocess.run(
                        [sys.executable, "-I", "-B", str(ROOT_DIR / "printability.py"), *args],
                        cwd=tmp, capture_output=True, text=True,
                    )
                    self.assertEqual(result.returncode, 0, msg=result.stderr)
                    report = json.loads(result.stdout)
                    if args[0] == "check":
                        self.assertEqual(report["verdict"], "printable")
                        self.assertEqual(report["input"]["sha256"], hashlib.sha256(stl.read_bytes()).hexdigest())
                    else:
                        self.assertEqual(report["schema"], profiles.PROFILES_SCHEMA)

    def test_check_requires_explicit_profile_and_strict_failure_exits_2(self):
        self.assertEqual(analyzer.MAX_INPUT_BYTES, 32 << 20)
        self.assertEqual(analyzer.MAX_FACETS, 500_000)
        with tempfile.TemporaryDirectory() as tmp:
            stl = Path(tmp) / "open.stl"
            stl.write_text("solid open\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid open\n")
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(printability.main(["check", str(stl)]), 2)
                self.assertEqual(printability.main(["check", str(stl), "--profile", "p1s-0.4-hardened", "--strict"]), 2)


def _rotate_binary_stl_arbitrary(stl_bytes: bytes, rx_deg: float, ry_deg: float, rz_deg: float = 0.0) -> bytes:
    """Apply an arbitrary Euler rotation to a synthetic binary STL for off-axis test fixtures."""
    ax, ay, az = math.radians(rx_deg), math.radians(ry_deg), math.radians(rz_deg)
    cx, sx = math.cos(ax), math.sin(ax)
    cy, sy = math.cos(ay), math.sin(ay)
    cz, sz = math.cos(az), math.sin(az)
    rx = ((1.0, 0.0, 0.0), (0.0, cx, -sx), (0.0, sx, cx))
    ry = ((cy, 0.0, sy), (0.0, 1.0, 0.0), (-sy, 0.0, cy))
    rz = ((cz, -sz, 0.0), (sz, cz, 0.0), (0.0, 0.0, 1.0))
    rot = orient._matmul3(rz, orient._matmul3(ry, rx))
    return orient.rotate_stl_bytes(stl_bytes, rot, use_numpy=False)


def synthetic_l_bracket_stl(
    leg_x: float = 50.0,
    leg_z: float = 50.0,
    width_y: float = 20.0,
    wall: float = 6.0,
    *,
    inverted: bool = False,
) -> bytes:
    xs = [0.0, wall, leg_x]
    ys = [0.0, width_y]
    zs = [0.0, leg_z - wall, leg_z] if inverted else [0.0, wall, leg_z]
    if inverted:
        return build_rectilinear_solid(xs, ys, zs, lambda i, _j, k: i == 0 or k == 1)
    return build_rectilinear_solid(xs, ys, zs, lambda i, _j, k: i == 0 or k == 0)


def synthetic_three_foot_tripod_stl() -> bytes:
    """Closed 24-triangle vaulted pyramid on three disconnected ~3.8 mm^2 foot pads.

    All outer and inner-vault walls slope steeply (< 40 deg from vertical, zero
    overhangs), and each foot triangle has area ~3.8 mm^2 (< 4.5 mm^2 flat-cluster
    threshold) while all three together supply ~11.4 mm^2 (>= 9.0 mm^2 base gate)
    on the resting plane discovered exclusively by the 3D convex hull.
    """
    r_out = 12.0
    r_foot_in = 8.4
    half_ang = math.radians(7.2)
    r_arch = 6.5
    z_arch = 2.5
    top_apex = (0.0, 0.0, 18.0)
    vault_apex = (0.0, 0.0, 11.0)

    outer_ring: list[tuple[float, float, float]] = []
    inner_ring: list[tuple[float, float, float]] = []
    foot_tris: list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]] = []

    for i in range(3):
        th = math.radians(120.0 * i)
        th_mid = math.radians(120.0 * i + 60.0)
        l_pt = (r_foot_in * math.cos(th - half_ang), r_foot_in * math.sin(th - half_ang), 0.0)
        o_pt = (r_out * math.cos(th), r_out * math.sin(th), 0.0)
        r_pt = (r_foot_in * math.cos(th + half_ang), r_foot_in * math.sin(th + half_ang), 0.0)
        m_pt = (r_arch * math.cos(th_mid), r_arch * math.sin(th_mid), z_arch)

        outer_ring.extend((l_pt, o_pt, r_pt, m_pt))
        inner_ring.extend((l_pt, r_pt, m_pt))
        # CW when viewed from +Z -> exact (0, 0, -1) outward normal
        foot_tris.append((r_pt, o_pt, l_pt))

    tris: list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]] = []
    n_out = len(outer_ring)
    for k in range(n_out):
        tris.append((outer_ring[k], outer_ring[(k + 1) % n_out], top_apex))
    tris.extend(foot_tris)
    n_in = len(inner_ring)
    for k in range(n_in):
        tris.append((inner_ring[(k + 1) % n_in], inner_ring[k], vault_apex))
    return pack_binary_stl(tris)


class OrientationTests(unittest.TestCase):
    """KAN-101 follow-up: deterministic auto-orientation candidate generation, scoring, and backend parity."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="stm-orient-test-")
        self.root = Path(self.tmp.name)
        self.p1s, self.pla = profiles.resolve_profile("p1s-0.4-hardened")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write_stl(self, name: str, data: bytes) -> Path:
        p = self.root / name
        p.write_bytes(data)
        return p

    def test_l_bracket_lays_flat_on_side(self) -> None:
        for label, inverted in (("upright", False), ("inverted", True)):
            with self.subTest(label=label):
                stl = self.write_stl(f"l_{label}.stl", synthetic_l_bracket_stl(inverted=inverted))
                rep, rot_bytes = orient.orient_and_rotate_stl(stl, self.p1s)
                sel = rep["selected"]
                self.assertTrue(sel["applied"])
                # Extrusion axis is Y, so laying the L-bracket flat puts -Y (by tie-break over +Y) on the bed
                self.assertEqual(sel["downNormal"], [0.0, -1.0, 0.0])
                self.assertEqual(sel["metrics"]["heightMm"], 20.0)
                self.assertEqual(sel["metrics"]["overhangAreaMm2"], 0.0)
                self.assertFalse(sel["metrics"]["requiresSupports"])
                self.assertTrue(sel["metrics"]["isStable"])
                self.assertGreater(sel["score"], rep["baseline"]["score"])

                oriented_path = self.write_stl(f"l_{label}_oriented.stl", rot_bytes)
                verdict_rep = analyzer.analyze_stl(oriented_path, self.p1s, self.pla)
                self.assertEqual(verdict_rep["verdict"], "printable")
                self.assertEqual(verdict_rep["checks"]["overhangs"]["overhangAreaMm2"], 0.0)
                self.assertEqual(verdict_rep["checks"]["bedFit"]["partExtentsMm"][2], 20.0)

    def test_tall_thin_box_uses_large_face_unless_unstable(self) -> None:
        # 1. Tall thin slab (4 x 40 x 80 mm): standing on 4x40 or 4x80 is unstable; large 40x80 face wins
        thin_stl = self.write_stl(
            "tall_thin.stl",
            build_rectilinear_solid([0.0, 4.0], [0.0, 40.0], [0.0, 80.0], lambda *_: True),
        )
        rep_thin = orient.orient_stl(thin_stl, self.p1s)
        self.assertFalse(rep_thin["baseline"]["metrics"]["isStable"])
        self.assertEqual(rep_thin["selected"]["downNormal"], [-1.0, 0.0, 0.0])
        self.assertEqual(rep_thin["selected"]["metrics"]["flatBaseAreaMm2"], 3200.0)
        self.assertEqual(rep_thin["selected"]["metrics"]["heightMm"], 4.0)
        self.assertTrue(rep_thin["selected"]["metrics"]["isStable"])

        # 2. 20 x 40 x 80 mm upright box (where upright IS stable): still selects largest 40x80 face
        box_stl = self.write_stl(
            "tall_box_stable.stl",
            build_rectilinear_solid([0.0, 20.0], [0.0, 40.0], [0.0, 80.0], lambda *_: True),
        )
        rep_box = orient.orient_stl(box_stl, self.p1s)
        self.assertTrue(rep_box["baseline"]["metrics"]["isStable"])
        self.assertEqual(rep_box["selected"]["downNormal"], [-1.0, 0.0, 0.0])
        self.assertEqual(rep_box["selected"]["metrics"]["flatBaseAreaMm2"], 3200.0)
        self.assertEqual(rep_box["selected"]["metrics"]["heightMm"], 20.0)

        # 3. Counterfactual where the largest flat face (-X: 50 x 40 = 2000 mm^2) is UNSTABLE because a
        # heavy offset base block at y in [40, 90] pulls CoM outside x=0's [0, 50] support hull:
        # orient must reject the unstable 2000 mm^2 face and pick the stable -Z face (1800 mm^2).
        xs, ys, zs = [0.0, 6.0, 36.0], [0.0, 40.0, 50.0, 90.0], [0.0, 25.0, 40.0]
        skewed_bytes = build_rectilinear_solid(
            xs,
            ys,
            zs,
            lambda i, j, k: (i == 0 and j in (0, 1)) or (i == 1 and j in (1, 2) and k == 0),
        )
        skewed_stl = self.write_stl("skewed_large_face_unstable.stl", skewed_bytes)
        rep_skewed = orient.orient_stl(skewed_stl, self.p1s)
        by_id = {c["candidateId"]: c for c in rep_skewed["candidates"]}
        self.assertEqual(by_id["axis:-x"]["metrics"]["flatBaseAreaMm2"], 2000.0)
        self.assertFalse(by_id["axis:-x"]["metrics"]["isStable"])
        self.assertEqual(rep_skewed["selected"]["candidateId"], "axis:-z")
        self.assertTrue(rep_skewed["selected"]["metrics"]["isStable"])
        self.assertFalse(rep_skewed["selected"]["metrics"]["requiresSupports"])
        self.assertGreater(rep_skewed["selected"]["score"], by_id["axis:-x"]["score"])

    def test_cantilever_overhang_orients_to_drop_supports(self) -> None:
        stl = self.write_stl("cantilever.stl", synthetic_overhang_cantilever_stl())
        before = analyzer.analyze_stl(stl, self.p1s, self.pla)
        self.assertEqual(before["verdict"], "printable-with-supports")
        self.assertAlmostEqual(before["checks"]["overhangs"]["overhangAreaMm2"], 660.0, places=3)

        rep, rot_bytes = orient.orient_and_rotate_stl(stl, self.p1s)
        self.assertTrue(rep["selected"]["applied"])
        self.assertEqual(rep["selected"]["downNormal"], [0.0, -1.0, 0.0])
        self.assertEqual(rep["selected"]["metrics"]["overhangAreaMm2"], 0.0)
        self.assertFalse(rep["selected"]["metrics"]["requiresSupports"])

        oriented_stl = self.write_stl("cantilever_oriented.stl", rot_bytes)
        after = analyzer.analyze_stl(oriented_stl, self.p1s, self.pla)
        self.assertEqual(after["verdict"], "printable")
        self.assertEqual(after["checks"]["overhangs"]["overhangAreaMm2"], 0.0)

    def test_cube_equivalent_scores_and_deterministic_identity_tie_break(self) -> None:
        stl = self.write_stl("cube.stl", synthetic_cube_stl(20.0))
        rep, rot_bytes = orient.orient_and_rotate_stl(stl, self.p1s)
        self.assertEqual(rep["candidateCount"], 6)
        scores = [c["score"] for c in rep["candidates"]]
        self.assertEqual(len(set(scores)), 1)
        self.assertEqual(rep["selected"]["candidateId"], "axis:-z")
        self.assertEqual(rep["selected"]["downNormal"], [0.0, 0.0, -1.0])
        self.assertFalse(rep["selected"]["applied"])
        self.assertTrue(rep["selected"]["isIdentity"])
        self.assertEqual(rep["selected"]["angleDeg"], 0.0)
        self.assertEqual(rot_bytes, stl.read_bytes())
        # Canonical deterministic rank order for all 6 tied faces
        self.assertEqual(
            [c["candidateId"] for c in rep["candidates"]],
            ["axis:-z", "axis:+z", "axis:-x", "axis:+x", "axis:-y", "axis:+y"],
        )

    def test_off_axis_flat_cluster_and_convex_hull_rescue_tilted_parts(self) -> None:
        # 1. Tilted pocketed cradle: none of the 6 axis-aligned normals has a flat base
        tilted_cradle_bytes = _rotate_binary_stl_arbitrary(synthetic_pocketed_cradle_stl(), 31.0, 19.0)
        tilted_cradle = self.write_stl("tilted_cradle.stl", tilted_cradle_bytes)
        raw_check = analyzer.analyze_stl(tilted_cradle, self.p1s, self.pla)
        self.assertEqual(raw_check["verdict"], "not-printable")
        self.assertIn("missing-flat-base", raw_check["reasonCodes"])

        rep_cradle, oriented_cradle_bytes = orient.orient_and_rotate_stl(tilted_cradle, self.p1s)
        axis_cands = [c for c in rep_cradle["candidates"] if "axis-aligned" in c["sources"]]
        self.assertEqual(len(axis_cands), 6)
        self.assertTrue(all(not c["metrics"]["hasFlatBase"] for c in axis_cands))
        self.assertTrue(rep_cradle["selected"]["applied"])
        self.assertTrue(
            "flat-facet-cluster" in rep_cradle["selected"]["sources"]
            or "convex-hull" in rep_cradle["selected"]["sources"]
        )
        rescued_check = analyzer.analyze_stl(
            self.write_stl("rescued_cradle.stl", oriented_cradle_bytes),
            self.p1s,
            self.pla,
        )
        self.assertEqual(rescued_check["verdict"], "printable")

        # 2. Tilted 3-foot tripod: individual foot pads are 3.6 mm^2 (< flat-cluster threshold),
        # so ONLY the 3D convex-hull face spanning all 3 feet discovers the resting plane!
        tilted_tripod_bytes = _rotate_binary_stl_arbitrary(synthetic_three_foot_tripod_stl(), 27.0, -16.0)
        tilted_tripod = self.write_stl("tilted_tripod.stl", tilted_tripod_bytes)
        rep_tripod, oriented_tripod_bytes = orient.orient_and_rotate_stl(tilted_tripod, self.p1s)
        self.assertIn("convex-hull", rep_tripod["selected"]["sources"])
        self.assertNotIn("axis-aligned", rep_tripod["selected"]["sources"])
        self.assertNotIn("flat-facet-cluster", rep_tripod["selected"]["sources"])
        self.assertTrue(rep_tripod["selected"]["metrics"]["isStable"])
        self.assertGreaterEqual(rep_tripod["selected"]["metrics"]["flatBaseAreaMm2"], 10.5)
        tripod_check = analyzer.analyze_stl(
            self.write_stl("rescued_tripod.stl", oriented_tripod_bytes),
            self.p1s,
            self.pla,
        )
        self.assertEqual(tripod_check["verdict"], "printable")

    def test_rectangular_bed_folds_90_deg_z_yaw_into_rotation(self) -> None:
        rect_profile = dict(self.p1s)
        rect_profile["bedMm"] = {"x": 180.0, "y": 120.0, "z": 180.0}
        rect_profile["excludeZonesMm"] = []
        # 100 x 160 x 12 mm tray: fits 180 x 120 bed only when rotated 90 deg around Z
        tray = self.write_stl(
            "rect_tray.stl",
            build_rectilinear_solid([0.0, 100.0], [0.0, 160.0], [0.0, 12.0], lambda *_: True),
        )
        rep, rot_bytes = orient.orient_and_rotate_stl(tray, rect_profile)
        self.assertTrue(rep["selected"]["applied"])
        self.assertEqual(rep["selected"]["zYawDeg"], 90)
        self.assertEqual(rep["selected"]["candidateId"], "axis:-z+z90")
        after = analyzer.analyze_stl(self.write_stl("rect_tray_oriented.stl", rot_bytes), rect_profile, self.pla)
        self.assertEqual(after["verdict"], "printable")
        self.assertFalse(after["checks"]["bedFit"]["requiresZRotation90"])
        self.assertEqual(after["warnings"], [])

    @unittest.skipUnless(analyzer.HAS_NUMPY, "NumPy parity test requires NumPy installed")
    def test_stdlib_and_numpy_byte_identical_parity(self) -> None:
        fixtures = {
            "cube": synthetic_cube_stl(20.0),
            "l_bracket": synthetic_l_bracket_stl(inverted=True),
            "cantilever": synthetic_overhang_cantilever_stl(),
            "tall_thin": build_rectilinear_solid([0.0, 4.0], [0.0, 40.0], [0.0, 80.0], lambda *_: True),
            "tilted_cradle": _rotate_binary_stl_arbitrary(synthetic_pocketed_cradle_stl(), 31.0, 19.0),
            "tilted_tripod": _rotate_binary_stl_arbitrary(synthetic_three_foot_tripod_stl(), 27.0, -16.0),
        }
        for name, raw_stl in fixtures.items():
            with self.subTest(fixture=name):
                path = self.write_stl(f"{name}.stl", raw_stl)
                rep_std, bytes_std = orient.orient_and_rotate_stl(path, self.p1s, use_numpy=False)
                rep_np, bytes_np = orient.orient_and_rotate_stl(path, self.p1s, use_numpy=True)
                json_std = json.dumps(rep_std, sort_keys=True, indent=2).encode("utf-8")
                json_np = json.dumps(rep_np, sort_keys=True, indent=2).encode("utf-8")
                self.assertEqual(json_std, json_np)
                self.assertEqual(bytes_std, bytes_np)

    def test_orient_rejects_non_watertight_degenerate_and_multi_solid_meshes(self) -> None:
        # Open mesh
        open_stl = self.write_stl(
            "open.stl",
            (
                "solid open\n"
                "facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\n"
                "endsolid open\n"
            ).encode("utf-8"),
        )
        with self.assertRaises(analyzer.PrintabilityError) as cm_open:
            orient.orient_stl(open_stl, self.p1s)
        self.assertEqual(cm_open.exception.stage, "topology")

        # Degenerate facet appended to watertight cube
        cube = synthetic_cube_stl(20.0)
        count = struct.unpack_from("<I", cube, 80)[0]
        degen = struct.pack("<12fH", 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 5.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0)
        degen_stl = self.write_stl("degen.stl", cube[:80] + struct.pack("<I", count + 1) + cube[84:] + degen)
        with self.assertRaises(analyzer.PrintabilityError) as cm_deg:
            orient.orient_stl(degen_stl, self.p1s)
        self.assertEqual(cm_deg.exception.stage, "topology")

        # CLI orient requires explicit --profile and writes --out / --write-stl atomically
        cantilever = self.write_stl("cli_cantilever.stl", synthetic_overhang_cantilever_stl())
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(printability.main(["orient", str(cantilever)]), 2)

        out_json = self.root / "orient_report.json"
        out_stl = self.root / "oriented_out.stl"
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = printability.main([
                "orient",
                str(cantilever),
                "--profile",
                "p1s-0.4-hardened",
                "--out",
                str(out_json),
                "--write-stl",
                str(out_stl),
            ])
        self.assertEqual(rc, 0)
        self.assertEqual(buf.getvalue(), out_json.read_text())
        self.assertTrue(out_stl.is_file())
        self.assertEqual(analyzer.analyze_stl(out_stl, self.p1s, self.pla)["verdict"], "printable")


class DryRunAutoOrientTests(unittest.TestCase):
    """KAN-101 follow-up: dry-run --auto-orient rotates before printability gate and seals orientation in manifest."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="stm-autoorient-dryrun-")
        self.root = Path(self.tmp.name)
        self.fake_bundle, self.fake_sandbox = make_fake_bambu_bundle(self.root)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def make_template_dir(self, name: str, stl_bytes: bytes) -> Path:
        d = self.root / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "cradle.stl").write_bytes(stl_bytes)
        manifest = {
            "schemaVersion": 1,
            "units": "mm",
            "previewOnly": True,
            "provesPhysicalAccuracy": False,
            "watertight": True,
            "outputSha256": {"cradle.stl": hashlib.sha256(stl_bytes).hexdigest()},
        }
        (d / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        return d

    def test_auto_orient_rotates_cantilever_to_slice_without_supports_and_leaves_default_unchanged(self) -> None:
        oh_bytes = synthetic_overhang_cantilever_stl()
        oh_dir = self.make_template_dir("cantilever-tpl", oh_bytes)

        # Without --auto-orient, behaviour is unchanged: refuses cantilever without --allow-supports
        with self.assertRaises(dry_run.DryRunError) as cm:
            dry_run.run_dry_run(
                template_dir=oh_dir,
                profile_id="p1s-0.4-hardened",
                out_dir=self.root / "out-no-orient",
                bundle=str(self.fake_bundle),
                _sandbox=self.fake_sandbox,
            )
        self.assertEqual(cm.exception.stage, "printability")

        # Also verify a printable cradle WITHOUT --auto-orient does not emit an "orientation" key
        cradle_dir = self.make_template_dir("cradle-tpl", synthetic_pocketed_cradle_stl())
        res_plain = dry_run.run_dry_run(
            template_dir=cradle_dir,
            profile_id="p1s-0.4-hardened",
            out_dir=self.root / "out-plain",
            bundle=str(self.fake_bundle),
            _sandbox=self.fake_sandbox,
        )
        self.assertNotIn("orientation", res_plain)
        self.assertFalse((self.root / "out-plain" / "oriented.stl").exists())
        self.assertFalse((self.root / "out-plain" / "orientation.json").exists())

        # With --auto-orient (and WITHOUT --allow-supports!), cantilever rotates onto its side,
        # passes printability with verdict "printable", and slices with enableSupport=False
        out_oriented = self.root / "out-oriented"
        res_ori = dry_run.run_dry_run(
            template_dir=oh_dir,
            profile_id="p1s-0.4-hardened",
            out_dir=out_oriented,
            bundle=str(self.fake_bundle),
            auto_orient=True,
            _sandbox=self.fake_sandbox,
        )
        self.assertEqual(res_ori["printability"]["verdict"], "printable")
        self.assertIs(res_ori["slice"]["overrides"]["enableSupport"], False)
        ori_meta = res_ori["orientation"]
        self.assertTrue(ori_meta["autoOrient"])
        self.assertTrue(ori_meta["applied"])
        self.assertEqual(ori_meta["downNormal"], [0.0, -1.0, 0.0])
        self.assertGreater(ori_meta["score"], ori_meta["baselineScore"])
        self.assertEqual(ori_meta["slicedStlArtifact"]["file"], "oriented.stl")

        # Original source.stl is preserved untouched while slice/manifest.json binds oriented.stl
        self.assertEqual((out_oriented / "source.stl").read_bytes(), oh_bytes)
        oriented_disk = (out_oriented / "oriented.stl").read_bytes()
        oriented_sha = hashlib.sha256(oriented_disk).hexdigest()
        self.assertEqual(ori_meta["slicedStlArtifact"]["sha256"], oriented_sha)
        slice_manifest = json.loads((out_oriented / "slice" / "manifest.json").read_text())
        self.assertEqual(slice_manifest["input"]["sha256"], oriented_sha)
        printability_disk = json.loads((out_oriented / "printability.json").read_text())
        self.assertEqual(printability_disk["input"]["sha256"], oriented_sha)
        orientation_disk = json.loads((out_oriented / "orientation.json").read_text())
        self.assertEqual(
            ori_meta["reportArtifact"]["sha256"],
            hashlib.sha256((out_oriented / "orientation.json").read_bytes()).hexdigest(),
        )
        self.assertEqual(orientation_disk["selected"]["score"], ori_meta["score"])

    def test_auto_orient_on_cube_keeps_identity_bytes_and_records_unrotated_score(self) -> None:
        cube_bytes = synthetic_cube_stl(20.0)
        cube_dir = self.make_template_dir("cube-tpl", cube_bytes)
        out_cube = self.root / "out-cube-sandbox"
        res_cube = dry_run.run_dry_run(
            template_dir=cube_dir,
            profile_id="p1s-0.4-hardened",
            out_dir=out_cube,
            bundle=str(self.fake_bundle),
            auto_orient=True,
            _sandbox=self.fake_sandbox,
        )
        self.assertFalse(res_cube["orientation"]["applied"])
        self.assertEqual(res_cube["orientation"]["angleDeg"], 0.0)
        self.assertEqual(res_cube["orientation"]["slicedStlArtifact"]["file"], "source.stl")
        self.assertEqual(res_cube["orientation"]["slicedStlArtifact"]["sha256"], hashlib.sha256(cube_bytes).hexdigest())
        self.assertFalse((out_cube / "oriented.stl").exists())
        self.assertTrue((out_cube / "orientation.json").is_file())

    @unittest.skipUnless(
        sys.platform == "darwin" and Path("/Applications/BambuStudio.app/Contents/MacOS/BambuStudio").is_file(),
        "Real sandboxed BambuStudio auto-orient slice runs on macOS hosts with /Applications/BambuStudio.app installed",
    )
    def test_real_bambustudio_dry_run_auto_orient_drops_supports_on_cantilever(self) -> None:
        oh_dir = self.make_template_dir("real-cantilever", synthetic_overhang_cantilever_stl())
        out_dir = self.root / "real-out-cantilever-oriented"
        proc = subprocess.run(
            [
                sys.executable,
                str(ROOT_DIR / "printability.py"),
                "dry-run",
                "--template-dir",
                str(oh_dir),
                "--profile",
                "p1s-0.4-hardened",
                "--auto-orient",
                "--out",
                str(out_dir),
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        res = json.loads(proc.stdout)
        self.assertTrue(res["orientation"]["applied"])
        self.assertEqual(res["printability"]["verdict"], "printable")
        self.assertIs(res["slice"]["summary"]["enableSupport"], False)
        self.assertTrue((out_dir / "oriented.stl").is_file())
        self.assertTrue((out_dir / "slice" / "sliced-plate.3mf").is_file())


if __name__ == "__main__":
    unittest.main()
