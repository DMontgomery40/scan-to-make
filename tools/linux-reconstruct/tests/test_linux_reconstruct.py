"""Unit checks for linux-reconstruct: schemas, scale math, mesh handling,
CLI exit paths that need no COLMAP/OpenMVS. Run: python3 -m unittest
discover -s tests (from tools/linux-reconstruct). The USDZ check runs only
when usd-core is importable.
"""
import hashlib
import json
import math
import random
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import mesh as mesh_mod
import scale as scale_mod
import schemas


def rot_matrix(axis, degrees):
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    if axis == "z":
        return [[c, -s, 0], [s, c, 0], [0, 0, 1]]
    if axis == "y":
        return [[c, 0, s], [0, 1, 0], [-s, 0, c]]
    return [[1, 0, 0], [0, c, -s], [0, s, c]]


def mat_vec(m, v):
    return tuple(sum(m[r][k] * v[k] for k in range(3)) for r in range(3))


def mat_mul(a, b):
    return [[sum(a[r][k] * b[k][c] for k in range(3)) for c in range(3)] for r in range(3)]


class ScaleMath(unittest.TestCase):
    def setUp(self):
        rng = random.Random(7)
        self.rotation = mat_mul(rot_matrix("y", 35), rot_matrix("x", -20))
        self.true_scale = 0.0042
        self.translation = (1.5, -0.3, 2.0)
        # Camera ring around a tabletop object, in COLMAP units.
        self.src = []
        for i in range(24):
            ang = 2 * math.pi * i / 24
            self.src.append((120 * math.cos(ang) + rng.uniform(-1, 1),
                             40 + 15 * math.sin(2 * ang) + rng.uniform(-1, 1),
                             120 * math.sin(ang) + rng.uniform(-1, 1)))
        self.dst = [tuple(self.true_scale * c + t for c, t in
                          zip(mat_vec(self.rotation, p), self.translation))
                    for p in self.src]

    def test_umeyama_recovers_known_similarity(self):
        s, r, t = scale_mod.umeyama(self.src, self.dst)
        self.assertAlmostEqual(s, self.true_scale, places=9)
        for p, q in zip(self.src, self.dst):
            got = scale_mod.apply_similarity(s, r, t, p)
            self.assertLess(math.dist(got, q), 1e-7)

    def test_fit_accepts_clean_alignment(self):
        fit = scale_mod.fit_camera_scale(self.src, self.dst, 24)
        self.assertTrue(fit["ok"], fit)
        self.assertAlmostEqual(fit["scaleMPerUnit"], self.true_scale, places=6)
        self.assertEqual(fit["inliers"], 24)

    def test_fit_tolerates_two_outliers(self):
        dst = list(self.dst)
        dst[3] = (dst[3][0] + 0.2, dst[3][1], dst[3][2])
        dst[11] = (dst[11][0], dst[11][1] - 0.15, dst[11][2])
        fit = scale_mod.fit_camera_scale(self.src, dst, 24)
        self.assertTrue(fit["ok"], fit)
        self.assertAlmostEqual(fit["scaleMPerUnit"], self.true_scale, delta=2e-4)

    def test_fit_rejects_shuffled_association(self):
        dst = list(self.dst)
        random.Random(3).shuffle(dst)
        fit = scale_mod.fit_camera_scale(self.src, dst, 24)
        self.assertFalse(fit["ok"])

    def test_fit_rejects_straight_line_path(self):
        src = [(float(i * 10), 0.0, 0.0) for i in range(20)]
        dst = [(float(i) * 0.05, 1.0, 0.0) for i in range(20)]
        fit = scale_mod.fit_camera_scale(src, dst, 20)
        self.assertFalse(fit["ok"])

    def test_fit_rejects_stationary_camera(self):
        src = [(1.0, 2.0, 3.0)] * 20
        dst = [(0.1, 0.2, 0.3)] * 20
        fit = scale_mod.fit_camera_scale(src, dst, 20)
        self.assertFalse(fit["ok"])

    def test_fit_rejects_too_few(self):
        fit = scale_mod.fit_camera_scale(self.src[:5], self.dst[:5], 24)
        self.assertFalse(fit["ok"])


def jpeg_bytes(width, height):
    """Minimal JPEG: SOI + SOF0 with dimensions + EOI (header parse only)."""
    sof = struct.pack(">HBHHB", 17, 8, height, width, 3) + b"\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    return b"\xff\xd8\xff\xc0" + sof + b"\xff\xd9"


def make_capture(tmp, n=3, tracking="tracking"):
    photos = {}
    frames = []
    for i in range(n):
        name = f"IMG_{i:04d}.jpg"
        data = jpeg_bytes(640, 480) + bytes([i]) * 10
        path = tmp / name
        path.write_bytes(data)
        photos[name] = path
        frames.append({
            "image": name, "sha256": hashlib.sha256(data).hexdigest(),
            "width": 640, "height": 480, "fx": 500.0, "fy": 500.0,
            "cx": 320.0, "cy": 240.0, "timestampMs": 1700000000000 + i * 100,
            "tracking": tracking, "center": [0.1 * i, 1.2, 0.05 * i],
        })
    meta = {"version": 1, "kind": "capture-camera", "frames": frames,
            "objectAnchor": None}
    meta_path = tmp / "capture-camera.json"
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    return photos, meta_path, meta


class CameraSchema(unittest.TestCase):
    def test_valid_metadata_loads(self):
        with tempfile.TemporaryDirectory() as d:
            photos, path, _ = make_capture(Path(d))
            camera = schemas.load_camera_metadata(path, photos)
            self.assertEqual(len(camera.tracking_frames()), 3)

    def test_digest_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            photos, path, meta = make_capture(Path(d))
            meta["frames"][0]["sha256"] = "0" * 64
            path.write_text(json.dumps(meta), encoding="utf-8")
            with self.assertRaises(schemas.SchemaError):
                schemas.load_camera_metadata(path, photos)

    def test_dimension_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            photos, path, meta = make_capture(Path(d))
            meta["frames"][1]["width"] = 800
            path.write_text(json.dumps(meta), encoding="utf-8")
            with self.assertRaises(schemas.SchemaError):
                schemas.load_camera_metadata(path, photos)

    def test_unknown_key_and_bad_basename_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            photos, path, meta = make_capture(Path(d))
            meta["frames"][0]["extra"] = 1
            path.write_text(json.dumps(meta), encoding="utf-8")
            with self.assertRaises(schemas.SchemaError):
                schemas.load_camera_metadata(path, photos)
            photos, path, meta = make_capture(Path(d))
            meta["frames"][0]["image"] = "../escape.jpg"
            path.write_text(json.dumps(meta), encoding="utf-8")
            with self.assertRaises(schemas.SchemaError):
                schemas.load_camera_metadata(path, photos)

    def test_nonfinite_and_implausible_intrinsics_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            for bad in ({"fx": float("inf")}, {"fx": 1.0}, {"cx": 5000.0}):
                photos, path, meta = make_capture(Path(d))
                meta["frames"][0].update(bad)
                path.write_text(json.dumps(meta), encoding="utf-8")
                with self.assertRaises(schemas.SchemaError, msg=str(bad)):
                    schemas.load_camera_metadata(path, photos)

    def test_anchor_requires_source_and_confidence(self):
        with tempfile.TemporaryDirectory() as d:
            photos, path, meta = make_capture(Path(d))
            meta["objectAnchor"] = {"center": [0, 1, 0], "radiusM": 0.2}
            path.write_text(json.dumps(meta), encoding="utf-8")
            with self.assertRaises(schemas.SchemaError):
                schemas.load_camera_metadata(path, photos)
            meta["objectAnchor"] = {"center": [0, 1, 0], "radiusM": 0.2,
                                    "confidence": 0.9, "source": "arcore-anchor"}
            path.write_text(json.dumps(meta), encoding="utf-8")
            camera = schemas.load_camera_metadata(path, photos)
            self.assertEqual(camera.anchor["source"], "arcore-anchor")


class MeasurementSchema(unittest.TestCase):
    def _write(self, tmp, obj):
        p = tmp / "m.json"
        p.write_text(json.dumps(obj), encoding="utf-8")
        return p

    def test_valid_measurement_scales(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._write(Path(d), {"version": 1, "kind": "capture-measurement",
                                      "meshSha256": "a" * 64, "axis": "x",
                                      "extentMm": 150.0})
            axis, mm, s = schemas.load_measurement(p, "a" * 64,
                                                   {"x": 3.0, "y": 1.0, "z": 2.0})
            self.assertEqual(axis, "x")
            self.assertAlmostEqual(s, 0.05)

    def test_wrong_mesh_and_prose_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._write(Path(d), {"version": 1, "kind": "capture-measurement",
                                      "meshSha256": "b" * 64, "axis": "x",
                                      "extentMm": 150.0})
            with self.assertRaises(schemas.SchemaError):
                schemas.load_measurement(p, "a" * 64, {"x": 3.0, "y": 1.0, "z": 2.0})
            p = self._write(Path(d), {"version": 1, "kind": "capture-measurement",
                                      "meshSha256": "a" * 64, "axis": "widest",
                                      "extentMm": "about 15cm"})
            with self.assertRaises(schemas.SchemaError):
                schemas.load_measurement(p, "a" * 64, {"x": 3.0, "y": 1.0, "z": 2.0})


def box_mesh(size=(2.0, 1.0, 3.0), offset=(0.0, 0.0, 0.0)):
    x, y, z = size
    ox, oy, oz = offset
    v = [(ox, oy, oz), (ox + x, oy, oz), (ox + x, oy + y, oz), (ox, oy + y, oz),
         (ox, oy, oz + z), (ox + x, oy, oz + z), (ox + x, oy + y, oz + z),
         (ox, oy + y, oz + z)]
    f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
         (2, 3, 7), (2, 7, 6), (1, 2, 6), (1, 6, 5), (3, 0, 4), (3, 4, 7)]
    return mesh_mod.Mesh(v, f)


class MeshHandling(unittest.TestCase):
    def test_ply_roundtrip_and_extents(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "box.ply"
            mesh_mod.write_ply(p, box_mesh())
            back = mesh_mod.read_ply(p)
            self.assertEqual(len(back.vertices), 8)
            _lo, _hi, ext = back.extents()
            self.assertEqual(ext, {"x": 2.0, "y": 1.0, "z": 3.0})
            self.assertGreater(back.signed_volume(), 0)

    def test_stl_roundtrip_shape(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "box.stl"
            mesh_mod.write_stl(p, box_mesh())
            data = p.read_bytes()
            self.assertIn(b"NOT metres", data[:80])
            (count,) = struct.unpack_from("<I", data, 80)
            self.assertEqual(count, 12)
            self.assertEqual(len(data), 84 + 50 * 12)

    def test_components_split(self):
        a, b = box_mesh(), box_mesh(offset=(10.0, 0.0, 0.0))
        merged = mesh_mod.Mesh(a.vertices + b.vertices,
                               a.faces + [tuple(i + 8 for i in f) for f in b.faces])
        comps = mesh_mod.connected_components(merged)
        self.assertEqual(len(comps), 2)

    def test_colmap_centre_from_identity_pose(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "images.txt"
            # Identity rotation, t=(1,2,3) -> centre (-1,-2,-3).
            p.write_text("1 1 0 0 0 1 2 3 1 IMG_0000.jpg\n\n", encoding="utf-8")
            centres = mesh_mod.read_colmap_cameras(p)
            self.assertEqual(centres["IMG_0000.jpg"], (-1.0, -2.0, -3.0))


class ObjectSelection(unittest.TestCase):
    def _cluster_mesh(self):
        table = box_mesh(size=(4.0, 0.1, 4.0), offset=(-2.0, 0.0, -2.0))
        verts, faces = list(table.vertices), list(table.faces)
        for k in range(12):
            b = box_mesh(size=(0.1, 0.1, 0.1),
                         offset=(3.0 + 0.05 * k, 0.05 * k, 3.0))
            base = len(verts)
            verts += b.vertices
            faces += [tuple(i + base for i in f) for f in b.faces]
        return mesh_mod.Mesh(verts, faces)

    def test_suggestion_is_anchor_region_but_not_applied(self):
        import reconstruct
        merged = self._cluster_mesh()
        comps = mesh_mod.connected_components(merged)
        anchor = {"center": (3.3, 0.3, 3.05), "radiusM": 0.6,
                  "confidence": 0.9, "source": "user-tap"}
        kind, _payload, report = reconstruct.suggested_selection(
            merged, comps, anchor, lambda p: p)
        self.assertEqual(kind, "anchor-region")
        self.assertIn("support surface", report["reason"])

    def test_confirmed_suggested_excludes_table(self):
        import reconstruct
        merged = self._cluster_mesh()
        comps = mesh_mod.connected_components(merged)
        anchor = {"center": (3.3, 0.3, 3.05), "radiusM": 0.6,
                  "confidence": 0.9, "source": "user-tap"}
        chosen, report = reconstruct.apply_selection(
            merged, comps, {"type": "suggested"}, anchor, lambda p: p)
        self.assertEqual(report["method"], "user-confirmed-suggested-anchor-region")
        self.assertTrue(report["confirmedByUser"])
        _lo, _hi, ext = chosen.extents()
        self.assertLess(ext["x"], 1.5)   # table (4.0 wide) excluded

    def test_user_crop_and_component(self):
        import reconstruct
        merged = self._cluster_mesh()
        comps = mesh_mod.connected_components(merged)
        chosen, report = reconstruct.apply_selection(
            merged, comps,
            {"type": "crop", "min": (2.9, -0.1, 2.9), "max": (3.8, 0.8, 3.2)},
            None, None)
        self.assertEqual(report["method"], "user-crop")
        _lo, _hi, ext = chosen.extents()
        self.assertLessEqual(ext["x"], 0.9)
        chosen, report = reconstruct.apply_selection(
            merged, comps, {"type": "component", "index": 0}, None, None)
        self.assertEqual(report["method"], "user-component")

    def test_empty_crop_rejected(self):
        import reconstruct
        merged = self._cluster_mesh()
        comps = mesh_mod.connected_components(merged)
        with self.assertRaises(reconstruct.RunError) as cm:
            reconstruct.apply_selection(
                merged, comps,
                {"type": "crop", "min": (100.0, 100.0, 100.0),
                 "max": (101.0, 101.0, 101.0)}, None, None)
        self.assertEqual(cm.exception.code, "object-region-invalid")

    def test_fragmented_suggestion_flagged_not_fatal(self):
        import reconstruct
        verts, faces = [], []
        for k in range(6):
            b = box_mesh(offset=(10.0 * k, 0.0, 0.0))
            base = len(verts)
            verts += b.vertices
            faces += [tuple(i + base for i in f) for f in b.faces]
        mesh_obj = mesh_mod.Mesh(verts, faces)
        comps = mesh_mod.connected_components(mesh_obj)
        _kind, _payload, report = reconstruct.suggested_selection(
            mesh_obj, comps, None, None)
        self.assertTrue(report["fragmented"])

    def test_images_txt_skips_points_lines(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "images.txt"
            p.write_text(
                "# comment\n1 1 0 0 0 1 2 3 1 a.jpg\n0.5 0.5 -1 1.5 2.5 7\n"
                "2 1 0 0 0 4 5 6 1 b.jpg\n\n", encoding="utf-8")
            centres = mesh_mod.read_colmap_cameras(p)
            self.assertEqual(set(centres), {"a.jpg", "b.jpg"})
            self.assertEqual(centres["b.jpg"], (-4.0, -5.0, -6.0))


class ObjectRegionSchema(unittest.TestCase):
    def _write(self, tmp, obj):
        p = tmp / "r.json"
        p.write_text(json.dumps(obj), encoding="utf-8")
        return p

    def test_valid_variants_load(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            base = {"version": 1, "kind": "capture-object-region",
                    "previewMeshSha256": "a" * 64}
            for sel in ({"type": "suggested"},
                        {"type": "component", "index": 2},
                        {"type": "crop", "min": [0, 0, 0], "max": [1, 2, 3]}):
                p = self._write(tmp, {**base, "selection": sel})
                got = schemas.load_object_region(p, "a" * 64, 5,
                                                 (-1, -1, -1), (4, 4, 4))
                self.assertEqual(got["type"], sel["type"])

    def test_wrong_preview_and_bad_shapes_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            base = {"version": 1, "kind": "capture-object-region",
                    "previewMeshSha256": "b" * 64,
                    "selection": {"type": "suggested"}}
            p = self._write(tmp, base)
            with self.assertRaises(schemas.SchemaError):
                schemas.load_object_region(p, "a" * 64, 5, (-1, -1, -1), (4, 4, 4))
            base["previewMeshSha256"] = "a" * 64
            for bad in ({"type": "component", "index": 9},
                        {"type": "component", "index": True},
                        {"type": "crop", "min": [2, 0, 0], "max": [1, 2, 3]},
                        {"type": "crop", "min": [10, 0, 0], "max": [11, 2, 3]},
                        {"type": "suggested", "index": 0},
                        {"type": "everything"}):
                p = self._write(tmp, {**base, "selection": bad})
                with self.assertRaises(schemas.SchemaError, msg=str(bad)):
                    schemas.load_object_region(p, "a" * 64, 5, (-1, -1, -1), (4, 4, 4))


class CliPaths(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(HERE / "reconstruct.py"), *args],
                              capture_output=True, text=True, timeout=60)

    def test_too_few_photos_exit2_ndjson(self):
        with tempfile.TemporaryDirectory() as d:
            photos = Path(d) / "photos"
            photos.mkdir()
            (photos / "a.jpg").write_bytes(jpeg_bytes(64, 64))
            r = self.run_cli("samples", str(photos), str(Path(d) / "o.usdz"), "full",
                             "--save-masks", str(Path(d) / "masks"))
            self.assertEqual(r.returncode, 2)
            lines = [json.loads(ln) for ln in r.stdout.splitlines() if ln.strip()]
            self.assertEqual(lines[-1]["code"], "too-few-photos")
            self.assertNotIn("done", lines[-1])

    def test_bad_quality_exit2(self):
        with tempfile.TemporaryDirectory() as d:
            r = self.run_cli("samples", d, str(Path(d) / "o.usdz"), "preview",
                             "--save-masks", str(Path(d) / "masks"))
            self.assertEqual(r.returncode, 2)

    def test_work_dir_bound_to_capture_key(self):
        with tempfile.TemporaryDirectory() as d:
            photos = Path(d) / "photos"
            photos.mkdir()
            make_capture(photos, n=10)
            work = Path(d) / "work"
            work.mkdir()
            (work / "capture-key.json").write_text(
                json.dumps({"captureKey": "some-other-capture"}), encoding="utf-8")
            r = self.run_cli("samples", str(photos), str(Path(d) / "o.usdz"), "full",
                             "--save-masks", str(Path(d) / "masks"),
                             "--work-dir", str(work))
            self.assertEqual(r.returncode, 2)
            lines = [json.loads(ln) for ln in r.stdout.splitlines() if ln.strip()]
            self.assertEqual(lines[-1]["code"], "work-dir-mismatch")

    def test_invalid_camera_metadata_exit2(self):
        with tempfile.TemporaryDirectory() as d:
            photos = Path(d) / "photos"
            photos.mkdir()
            _pfiles, meta_path, meta = make_capture(photos, n=10)
            meta["frames"][0]["sha256"] = "0" * 64
            meta_path.write_text(json.dumps(meta), encoding="utf-8")
            r = self.run_cli("samples", str(photos), str(Path(d) / "o.usdz"), "full",
                             "--save-masks", str(Path(d) / "masks"),
                             "--camera-metadata", str(meta_path))
            self.assertEqual(r.returncode, 2)
            lines = [json.loads(ln) for ln in r.stdout.splitlines() if ln.strip()]
            self.assertEqual(lines[-1]["code"], "camera-metadata-invalid")


try:
    import pxr  # noqa: F401
    HAVE_PXR = True
except ImportError:
    HAVE_PXR = False


@unittest.skipUnless(HAVE_PXR, "usd-core not installed")
class UsdzExport(unittest.TestCase):
    def test_exported_usdz_is_metric_and_valid(self):
        import usd_export
        with tempfile.TemporaryDirectory() as d:
            usdc, usdz = Path(d) / "m.usdc", Path(d) / "m.usdz"
            usd_export.export_usdz(box_mesh(size=(0.2, 0.1, 0.3)), usdc, usdz)
            info = usd_export.validate_usdz(usdz)
            self.assertEqual(info, {"vertices": 8, "faces": 12})

    def test_read_usdz_mesh_roundtrip(self):
        import usd_export
        with tempfile.TemporaryDirectory() as d:
            usdc, usdz = Path(d) / "m.usdc", Path(d) / "m.usdz"
            usd_export.export_usdz(box_mesh(size=(2.0, 1.0, 3.0)), usdc, usdz)
            vertices, faces = usd_export.read_usdz_mesh(usdz)
            self.assertEqual((len(vertices), len(faces)), (8, 12))

    def test_qualify_gates_then_scales_by_measurement(self):
        import usd_export
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            source = tmp / "apple.usdz"
            # Untrusted units: a 2x1x3 box that is really 200x100x300 mm.
            usd_export.export_usdz(box_mesh(size=(2.0, 1.0, 3.0)), tmp / "s.usdc", source)
            out, work = tmp / "out.usdz", tmp / "work"

            def run(*extra):
                return subprocess.run(
                    [sys.executable, str(HERE / "reconstruct.py"), "qualify",
                     str(source), str(out), "--work-dir", str(work), *extra],
                    capture_output=True, text=True, timeout=120)
            r = run()
            self.assertEqual(r.returncode, 5, r.stdout)
            self.assertFalse(out.exists())
            region_receipt = json.loads((work / "needs-object-region.json").read_text())
            self.assertFalse(region_receipt["scaleKnown"])
            (tmp / "region.json").write_text(json.dumps({
                "version": 1, "kind": "capture-object-region",
                "previewMeshSha256": region_receipt["previewMeshSha256"],
                "selection": {"type": "suggested"}}))
            r = run("--object-region", str(tmp / "region.json"))
            self.assertEqual(r.returncode, 4, r.stdout)
            scale_receipt = json.loads((work / "needs-scale.json").read_text())
            (tmp / "measurement.json").write_text(json.dumps({
                "version": 1, "kind": "capture-measurement",
                "meshSha256": scale_receipt["meshSha256"], "axis": "x", "extentMm": 200.0}))
            r = run("--measurement", str(tmp / "measurement.json"))
            self.assertEqual(r.returncode, 0, r.stdout)
            receipt = json.loads((tmp / "out.receipt.json").read_text())
            self.assertEqual(receipt["mode"], "qualify")
            self.assertAlmostEqual(receipt["scale"]["extentsM"]["x"], 0.2, places=6)
            self.assertAlmostEqual(receipt["scale"]["extentsM"]["z"], 0.3, places=6)

    def test_qualify_rejects_missing_input(self):
        with tempfile.TemporaryDirectory() as d:
            r = subprocess.run(
                [sys.executable, str(HERE / "reconstruct.py"), "qualify",
                 str(Path(d) / "none.usdz"), str(Path(d) / "o.usdz"),
                 "--work-dir", str(Path(d) / "w")],
                capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main()
