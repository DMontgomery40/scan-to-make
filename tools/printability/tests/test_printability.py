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
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR))

import analyzer  # noqa: E402
import dry_run  # noqa: E402
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
import json, os, sys
a = sys.argv[1:]
def opt(k): return a[a.index(k) + 1]
out, settings_out = opt("--outputdir"), opt("--export-settings")
mp, pp = opt("--load-settings").split(";")
merged = dict(json.load(open(mp)))
merged.update(json.load(open(pp)))
bed = merged.get("curr_bed_type", "Cool Plate")
nozzle_t = ",".join(merged.get("nozzle_type", ["stainless_steel"]))
sup = merged.get("enable_support", "0")
gcode = (
    "; HEADER_BLOCK_START\n"
    "; BambuStudio 02.08.02.61\n"
    "; model printing time: 18m 12s; total estimated time: 24m 30s\n"
    "; total layer number: 100\n"
    "; total filament length [mm] : 3120.50\n"
    "; total filament volume [cm^3] : 7505.68\n"
    "; total filament weight [g] : 9.46\n"
    "; filament_density: 1.26\n"
    "; filament_diameter: 1.75\n"
    "; max_z_height: 20.00\n"
    "; HEADER_BLOCK_END\n"
    "; CONFIG_BLOCK_START\n"
    f"; curr_bed_type = {bed}\n"
    f"; nozzle_type = {nozzle_t}\n"
    f"; enable_support = {sup}\n"
    "; CONFIG_BLOCK_END\n"
    "G28\n"
)
with open(os.path.join(out, "plate_1.gcode"), "w") as f:
    f.write(gcode)
with open(settings_out, "w") as f:
    json.dump(merged, f, sort_keys=True)
"""

FAKE_SANDBOX_SCRIPT = r"""#!{py}
import os, sys
assert sys.argv[1] == "-f"
prof = open(sys.argv[2]).read()
assert "(deny network*)" in prof and "(deny mach-lookup)" in prof
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

        # FitSpec drawer template output
        drawer_stl = synthetic_pocketed_cradle_stl(width=140.0, depth=100.0, height=30.0, wall=2.0, floor=2.0)
        drawer_dir = self.make_drawer_dir("drawer-tpl", drawer_stl)
        out_drawer = self.root / "out-drawer"
        res_d = dry_run.run_dry_run(
            template_dir=drawer_dir,
            profile_id="p1s",
            out_dir=out_drawer,
            bundle=str(self.fake_bundle),
            _sandbox=self.fake_sandbox,
        )
        self.assertEqual(res_d["template"]["kind"], "drawer-tray")
        self.assertEqual(res_d["printability"]["verdict"], "printable")

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
        settings_path = out_cradle / "slice" / "exported-settings.json"
        self.assertTrue(gcode_path.is_file() and gcode_path.stat().st_size > 1000)
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


if __name__ == "__main__":
    unittest.main()
