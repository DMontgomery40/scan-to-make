#!/usr/bin/env python3
"""One-command synthetic repro: builds converter fixtures and runs pass + reject cases.

    /workspace/usdz-venv/bin/python tools/capture-pipeline/repro.py [OUT_DIR]
"""
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "capture-mesh-convert"))
from make_fixtures import make_all  # noqa: E402
from pipeline import dumps, run_pipeline  # noqa: E402

BOX_CM = {"x": 10.0, "y": 20.0, "z": 30.0}  # reflected fixture: 1 x 2 x 3 cm
CASES = [
    # name, fixture, held-out, extra kwargs, expected verdict
    ("pass", "reflected", BOX_CM, {}, "pass-bounds-only"),
    ("wrong-held-out", "reflected", {"x": 50.0, "y": 20.0, "z": 30.0}, {}, "evaluation-failed"),
    ("no-units", "no_units", BOX_CM, {}, "rejected-conversion"),
    ("subdivision", "unauthored_subdiv", BOX_CM, {}, "rejected-conversion"),
    ("nan-point", "nan_point", BOX_CM, {}, "rejected-conversion"),
    ("external-ref", "external_ref", BOX_CM, {}, "rejected-conversion"),
    ("too-large", "reflected", BOX_CM, {"max_bytes": 100}, "rejected-input"),
    ("too-many-entries", "two_layer", BOX_CM, {"max_entries": 1}, "rejected-input"),
]


def main(out_dir=None):
    root = Path(out_dir or tempfile.mkdtemp(prefix="capture-pipeline-repro-"))
    fx = make_all(root / "fixtures")
    ok = True
    for name, fixture, held, kw, expected in CASES:
        rep = run_pipeline(fx[fixture], held, root / "work" / name, **kw)
        (root / f"{name}.json").write_text(dumps(rep))
        good = rep["verdict"] == expected and (expected != "rejected-conversion" or rep["evaluator"] is None)
        ok &= good
        print(f"{'OK ' if good else 'BAD'} {name:18s} verdict={rep['verdict']:20s} exit={rep['exitCode']} "
              f"(expected {expected})")
    print(f"reports: {root}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else None))
