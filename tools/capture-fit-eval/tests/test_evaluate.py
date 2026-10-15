#!/usr/bin/env python3
import hashlib
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evaluate import InvalidMesh, UnsupportedFormat, evaluate, main  # noqa: E402


def box_faces():
    vertices = [
        (0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
        (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1),
    ]
    faces = [
        (0, 2, 1), (0, 3, 2),      # bottom
        (4, 5, 6), (4, 6, 7),      # top
        (0, 1, 5), (0, 5, 4),      # front
        (3, 6, 2), (3, 7, 6),      # back
        (0, 4, 7), (0, 7, 3),      # left
        (1, 2, 6), (1, 6, 5),      # right
    ]
    return vertices, faces


def write_binary_stl(path, dims, *, omit_top=False):
    base, faces = box_faces()
    if omit_top:
        faces = [f for f in faces if f not in {(4, 5, 6), (4, 6, 7)}]
    vertices = [(x * dims[0], y * dims[1], z * dims[2]) for x, y, z in base]
    data = bytearray(b"\0" * 80)
    data.extend(struct.pack("<I", len(faces)))
    for face in faces:
        points = [vertices[i] for i in face]
        data.extend(struct.pack("<12fH", 0, 0, 0, *points[0], *points[1], *points[2], 0))
    path.write_bytes(data)
    return bytes(data)


def write_ascii_stl(path, dims):
    base, faces = box_faces()
    vertices = [(x * dims[0], y * dims[1], z * dims[2]) for x, y, z in base]
    lines = ["solid box"]
    for face in faces:
        lines.append(" facet normal 0 0 0")
        lines.append("  outer loop")
        for idx in face:
            lines.append("   vertex {} {} {}".format(*vertices[idx]))
        lines.append("  endloop")
        lines.append(" endfacet")
    lines.append("endsolid box")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_obj(path, dims):
    base, faces = box_faces()
    lines = ["# deterministic box"]
    for x, y, z in base:
        lines.append(f"v {x * dims[0]} {y * dims[1]} {z * dims[2]}")
    for a, b, c in faces:
        lines.append(f"f {a + 1} {b + 1} {c + 1}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


class EvaluateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_native_binary_stl_pass_is_bounds_only(self):
        path = self.dir / "box.stl"
        data = write_binary_stl(path, (80, 55, 95))
        report = evaluate(path, units="mm", held_out_mm={"x": 80, "y": 55, "z": 95})
        self.assertEqual(report["verdict"], "pass-bounds-only")
        self.assertTrue(report["scale"]["nativeScalePass"])
        self.assertTrue(report["mesh"]["closedOriented"])
        self.assertEqual(report["artifact"]["sha256"], hashlib.sha256(data).hexdigest())
        self.assertFalse(report["provesCompleteCapture"])
        self.assertFalse(report["provesPhysicalFit"])

    def test_native_scale_error_fails_and_preserves_signed_errors(self):
        path = self.dir / "box.stl"
        write_binary_stl(path, (82, 55, 95))
        report = evaluate(path, units="mm", held_out_mm={"x": 80, "y": 55, "z": 95})
        self.assertEqual(report["verdict"], "fail")
        self.assertFalse(report["scale"]["nativeScalePass"])
        self.assertAlmostEqual(report["scale"]["rawErrors"]["x"]["signedErrorMm"], 2.0)

    def test_ascii_stl_uses_same_bounds_gate(self):
        path = self.dir / "box-ascii.stl"
        write_ascii_stl(path, (80, 55, 95))
        report = evaluate(path, units="mm", held_out_mm={"x": 80, "y": 55, "z": 95})
        self.assertEqual(report["verdict"], "pass-bounds-only")
        self.assertEqual(report["mesh"]["triangleCount"], 12)

    def test_units_are_declared_and_converted(self):
        path = self.dir / "box.obj"
        write_obj(path, (0.08, 0.055, 0.095))
        report = evaluate(path, units="m", held_out_mm={"x": 80, "y": 55, "z": 95})
        self.assertEqual(report["verdict"], "pass-bounds-only")
        self.assertAlmostEqual(report["mesh"]["extentsMm"]["x"], 80.0)

    def test_open_mesh_cannot_pass_even_with_exact_bounds(self):
        path = self.dir / "open.stl"
        write_binary_stl(path, (80, 55, 95), omit_top=True)
        report = evaluate(path, units="mm", held_out_mm={"x": 80, "y": 55, "z": 95})
        self.assertEqual(report["verdict"], "fail")
        self.assertFalse(report["mesh"]["closedOriented"])
        self.assertGreater(report["mesh"]["boundaryEdgeCount"], 0)

    def test_assisted_distinct_reference_preserves_raw_failure(self):
        path = self.dir / "box.stl"
        write_binary_stl(path, (84, 57.75, 99.75))  # exactly 5% large
        report = evaluate(
            path,
            units="mm",
            held_out_mm={"x": 80, "y": 55, "z": 95},
            scale_mode="assisted",
            calibration={
                "source": "distinct-reference",
                "reference": "reference-block-01",
                "factor": 1 / 1.05,
                "axis": None,
            },
        )
        self.assertEqual(report["verdict"], "pass-bounds-only")
        self.assertFalse(report["scale"]["nativeScalePass"])
        self.assertFalse(report["scale"]["rawErrors"]["x"]["withinTolerance"])
        self.assertTrue(report["scale"]["evaluatedErrors"]["x"]["withinTolerance"])
        self.assertEqual(report["scale"]["independentAxes"], ["x", "y", "z"])

    def test_target_axis_calibration_axis_is_not_independent(self):
        path = self.dir / "box.stl"
        write_binary_stl(path, (84, 55, 95))
        report = evaluate(
            path,
            units="mm",
            held_out_mm={"x": 80, "y": 55, "z": 95},
            scale_mode="assisted",
            calibration={
                "source": "target-axis",
                "reference": "same-target-x",
                "factor": 80 / 84,
                "axis": "x",
            },
        )
        # y/z are squeezed by the same factor and fail; x is reported but not independent.
        self.assertEqual(report["scale"]["independentAxes"], ["y", "z"])
        self.assertEqual(report["scale"]["calibration"]["excludedFromIndependentScoring"], "x")
        self.assertFalse(report["scale"]["nativeScalePass"])

    def test_native_mode_rejects_hidden_calibration(self):
        path = self.dir / "box.stl"
        write_binary_stl(path, (80, 55, 95))
        with self.assertRaises(InvalidMesh):
            evaluate(
                path,
                units="mm",
                held_out_mm={"x": 80, "y": 55},
                calibration={"source": "distinct-reference", "reference": "r", "factor": 1},
            )

    def test_unsupported_format_is_rejected_without_guessing(self):
        path = self.dir / "capture.usdz"
        path.write_bytes(b"PK synthetic placeholder")
        with self.assertRaises(UnsupportedFormat):
            evaluate(path, units="mm", held_out_mm={"x": 80, "y": 55})
        code = main([
            "evaluate", str(path), "--units", "mm",
            "--held-out", "x=80", "--held-out", "y=55", "--json",
        ])
        self.assertEqual(code, 3)

    def test_cli_writes_deterministic_json_report(self):
        path = self.dir / "box.stl"
        write_binary_stl(path, (80, 55, 95))
        out = self.dir / "report.json"
        code = main([
            "evaluate", str(path), "--units", "mm",
            "--held-out", "x=80", "--held-out", "y=55", "--held-out", "z=95",
            "--out", str(out),
        ])
        self.assertEqual(code, 0)
        report = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(report["schema"], "scan-to-make.capture-fit-eval/0.1.0")
        self.assertEqual(report["verdict"], "pass-bounds-only")


if __name__ == "__main__":
    unittest.main()
