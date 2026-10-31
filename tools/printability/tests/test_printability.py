#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Synthetic-only unit tests for tools/printability."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import math
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR))

import analyzer  # noqa: E402
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

    def test_degenerate_facets_rejected_in_check(self) -> None:
        # Regression test for PR #79 review comment 4429096115: appending a zero-area
        # facet with a unit normal to an otherwise watertight 20 mm cube must block
        # printability rather than silently analyzing a cleaned subset.
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


class CliSubcommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="stm-printability-cli-")
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

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


if __name__ == "__main__":
    unittest.main()


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
        import printability
        import analyzer
        self.assertEqual(analyzer.MAX_INPUT_BYTES, 32 << 20)
        self.assertEqual(analyzer.MAX_FACETS, 500_000)
        with tempfile.TemporaryDirectory() as tmp:
            stl = Path(tmp) / "open.stl"
            stl.write_text("solid open\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid open\n")
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(printability.main(["check", str(stl)]), 2)
                self.assertEqual(printability.main(["check", str(stl), "--profile", "p1s-0.4-hardened", "--strict"]), 2)
