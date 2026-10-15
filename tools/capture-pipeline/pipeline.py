#!/usr/bin/env python3
"""Offline capture pipeline: bounded input -> capture-mesh-convert -> capture-fit-eval.

Composes the existing tool entry points as subprocesses; it never edits, rescales, or
re-derives geometry. A conversion that is not metric-qualified (or exits nonzero) is
rejected before evaluation, and the raw converter evidence is kept in the report.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

SCHEMA = "scan-to-make.capture-pipeline/0.1.0"
TOOLS = Path(__file__).resolve().parents[1]
CONVERTER = TOOLS / "capture-mesh-convert" / "convert.py"
EVALUATOR = TOOLS / "capture-fit-eval" / "evaluate.py"

DEFAULT_MAX_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_ENTRIES = 256
DEFAULT_MAX_UNCOMPRESSED = 1024 * 1024 * 1024
ALLOWED_SUFFIXES = (".usdz", ".usdc", ".usda", ".usd")
# Exact metersPerUnit values accepted by FIT006 --units; anything else is rejected, never rounded.
MPU_TO_UNITS = {0.001: "mm", 0.01: "cm", 0.0254: "in", 1.0: "m"}

EXIT = {"pass-bounds-only": 0, "evaluation-failed": 2, "rejected-input": 3,
        "rejected-conversion": 4, "rejected-units": 5}


class Rejected(Exception):
    def __init__(self, verdict, reason, evidence=None):
        super().__init__(reason)
        self.verdict, self.reason, self.evidence = verdict, reason, evidence or {}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def _normalize(text, roots):
    for root, label in roots:
        text = text.replace(str(root), label)
    return text


def check_input(data, name, max_bytes, max_entries, max_uncompressed):
    suffix = Path(name).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise Rejected("rejected-input", f"unsupported input suffix {suffix!r}")
    if len(data) > max_bytes:
        raise Rejected("rejected-input", f"input is {len(data)} bytes, limit {max_bytes}")
    info = {"suffix": suffix}
    if suffix == ".usdz":
        import io
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as e:
            raise Rejected("rejected-input", f"not a zip package: {e}") from None
        entries = z.infolist()
        if len(entries) > max_entries:
            raise Rejected("rejected-input", f"package has {len(entries)} entries, limit {max_entries}")
        total = sum(e.file_size for e in entries)
        if total > max_uncompressed:
            raise Rejected("rejected-input", f"package uncompressed size {total}, limit {max_uncompressed}")
        for e in entries:
            p = e.filename
            if p.startswith(("/", "\\")) or ".." in Path(p).parts or ":" in p:
                raise Rejected("rejected-input", f"unsafe package entry name {p!r}")
            if e.compress_type != zipfile.ZIP_STORED:
                raise Rejected("rejected-input", f"package entry {p!r} is compressed (usdz requires stored)")
        info.update({"entries": len(entries), "uncompressedBytes": total,
                     "entryNames": sorted(e.filename for e in entries)})
    return info


def _run(cmd, roots):
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return proc.returncode, _normalize(proc.stdout, roots), _normalize(proc.stderr, roots)


def run_pipeline(source, held_out, work_dir, python=sys.executable, max_bytes=DEFAULT_MAX_BYTES,
                 max_entries=DEFAULT_MAX_ENTRIES, max_uncompressed=DEFAULT_MAX_UNCOMPRESSED):
    source, work = Path(source), Path(work_dir)
    roots = [(work.resolve(), "<work>"), (TOOLS.parent.resolve(), "<repo>"), (source.resolve().parent, "<input-dir>")]
    report = {"schema": SCHEMA, "heldOutDimensions": dict(sorted(held_out.items())),
              "limits": {"maxBytes": max_bytes, "maxEntries": max_entries, "maxUncompressedBytes": max_uncompressed},
              "converter": None, "evaluator": None, "declaredUnits": None, "rejection": None,
              "provesCompleteCapture": False, "provesPhysicalFit": False}
    try:
        if source.stat().st_size > max_bytes:  # check before reading into memory
            raise Rejected("rejected-input", f"input is {source.stat().st_size} bytes, limit {max_bytes}")
        data = source.read_bytes()
        report["input"] = {"fileName": source.name, "byteLength": len(data), "sha256": sha256(data)}
        report["input"].update(check_input(data, source.name, max_bytes, max_entries, max_uncompressed))

        # Preserve the original bytes, content-addressed, and verify the copy.
        work.mkdir(parents=True, exist_ok=True)
        kept = work / "input" / (report["input"]["sha256"] + report["input"]["suffix"])
        kept.parent.mkdir(exist_ok=True)
        kept.write_bytes(data)
        if sha256(kept.read_bytes()) != report["input"]["sha256"]:
            raise Rejected("rejected-input", "preserved copy hash mismatch")
        report["input"]["preservedPath"] = "<work>/input/" + kept.name

        obj, conv_json = work / "mesh.obj", work / "convert.json"
        for p in (obj, conv_json):
            p.unlink(missing_ok=True)
        code, out, err = _run([python, str(CONVERTER), str(kept), "--out", str(obj), "--report", str(conv_json)], roots)
        conv = json.loads(conv_json.read_text()) if conv_json.exists() else None
        report["converter"] = {"exitCode": code, "stderr": err, "stdout": out, "report": conv}
        if code != 0 or conv is None or conv.get("metricQualified") is not True:
            raise Rejected("rejected-conversion",
                           f"converter exit {code}; metricQualified={None if conv is None else conv.get('metricQualified')}",
                           {"converterExitCode": code, "converterStderr": err,
                            "metricQualifiedReason": None if conv is None else conv.get("metricQualifiedReason"),
                            "unsupportedFeatures": None if conv is None else conv.get("unsupportedFeatures")})
        if conv["output"]["sha256"] != sha256(obj.read_bytes()):
            raise Rejected("rejected-conversion", "converter output hash mismatch")

        units = MPU_TO_UNITS.get(conv["metersPerUnit"])
        if units is None or not conv.get("unitsAuthored"):
            raise Rejected("rejected-units", f"metersPerUnit={conv['metersPerUnit']!r} has no exact FIT006 unit")
        report["declaredUnits"] = {"units": units, "metersPerUnit": conv["metersPerUnit"],
                                   "source": "converter report (authored metersPerUnit)"}

        cmd = [sys.executable, str(EVALUATOR), "evaluate", str(obj), "--units", units, "--json"]
        for axis, val in sorted(held_out.items()):
            cmd += ["--held-out", f"{axis}={val:g}"]
        code, out, err = _run(cmd, roots)
        try:
            ev = json.loads(out)
        except ValueError:
            ev = None
        report["evaluator"] = {"exitCode": code, "stderr": err, "report": ev}
        verdict = "pass-bounds-only" if code == 0 and ev and ev.get("verdict") == "pass-bounds-only" \
            else "evaluation-failed"
        report["verdict"] = verdict
    except Rejected as r:
        report["verdict"] = r.verdict
        report["rejection"] = {"verdict": r.verdict, "reason": _normalize(r.reason, roots),
                               "evidence": r.evidence}
    except FileNotFoundError as e:
        report["verdict"] = "rejected-input"
        report["rejection"] = {"verdict": "rejected-input", "reason": _normalize(str(e), roots), "evidence": {}}
    report["exitCode"] = EXIT[report["verdict"]]
    return report


def dumps(report):
    return json.dumps(report, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


def _held(s):
    axis, _, val = s.partition("=")
    if axis not in ("x", "y", "z"):
        raise argparse.ArgumentTypeError("held-out must be x=, y= or z=")
    return axis, float(val)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source")
    ap.add_argument("--held-out", type=_held, action="append", required=True, help="axis=mm, e.g. x=80")
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--report", help="write JSON report here (default: stdout)")
    ap.add_argument("--python", default=sys.executable, help="interpreter with usd-core for the converter")
    ap.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    ap.add_argument("--max-entries", type=int, default=DEFAULT_MAX_ENTRIES)
    ap.add_argument("--max-uncompressed-bytes", type=int, default=DEFAULT_MAX_UNCOMPRESSED)
    a = ap.parse_args(argv)
    report = run_pipeline(a.source, dict(a.held_out), a.work_dir, a.python, a.max_bytes, a.max_entries,
                          a.max_uncompressed_bytes)
    text = dumps(report)
    if a.report:
        Path(a.report).write_text(text)
    else:
        sys.stdout.write(text)
    return report["exitCode"]


if __name__ == "__main__":
    sys.exit(main())
