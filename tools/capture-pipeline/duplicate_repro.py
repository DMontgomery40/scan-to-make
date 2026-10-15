#!/usr/bin/env python3
"""One-command synthetic repro for the bounded duplicate.

    /workspace/usdz-venv/bin/python tools/capture-pipeline/duplicate_repro.py [OUT_DIR]
"""
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "capture-mesh-convert"))
from make_fixtures import make_all  # noqa: E402
from pipeline import dumps  # noqa: E402
from duplicate import run_duplicate  # noqa: E402

BOX_CM = {"x": 10.0, "y": 20.0, "z": 30.0}  # reflected fixture: 1 x 2 x 3 cm
CASES = [
    # name, fixture, held-out, extra kwargs, expected verdict
    ("ready", "reflected", BOX_CM, {}, "duplicate-ready"),
    ("wrong-held-out", "reflected", {"x": 50.0, "y": 20.0, "z": 30.0}, {}, "evaluation-failed"),
    ("holes", "holes", BOX_CM, {}, "rejected-conversion"),
    ("no-units", "no_units", BOX_CM, {}, "rejected-conversion"),
    ("over-build-volume", "reflected", BOX_CM, {"build_volume_mm": {"x": 9.0, "y": 256.0, "z": 256.0}},
     "rejected-bounds"),
    ("over-triangles", "reflected", BOX_CM, {"max_triangles": 11}, "rejected-bounds"),
]


def main(out_dir=None):
    root = Path(out_dir or tempfile.mkdtemp(prefix="capture-duplicate-repro-"))
    fx = make_all(root / "fixtures")
    ok = True
    for name, fixture, held, kw, expected in CASES:
        out = root / "out" / name
        m = run_duplicate(fx[fixture], held, root / "work" / name, out, **kw)
        (root / f"{name}.json").write_text(dumps(m))
        written = (out / "duplicate.obj").exists()
        good = m["verdict"] == expected and written == (expected == "duplicate-ready")
        if written:
            good &= (out / "duplicate.obj").read_bytes() == (root / "work" / name / "mesh.obj").read_bytes()
        ok &= good
        print(f"{'OK ' if good else 'BAD'} {name:18s} verdict={m['verdict']:20s} exit={m['exitCode']} "
              f"duplicate={'written' if written else 'none'} (expected {expected})")
    print(f"reports: {root}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else None))
