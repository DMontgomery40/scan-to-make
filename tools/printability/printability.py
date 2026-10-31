#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""CLI for deterministic STL printability checks.

Commands:
  python3 tools/printability/printability.py profiles
  python3 tools/printability/printability.py check part.stl --profile p1s-0.4-hardened

Slicing, orientation and dispatch belong to bambu-printer-mcp (slice_stl,
lay_flat, inspect_print_file, print_3mf); see docs/print-path.md.
Never contacts a printer or dispatches a print job.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

# -I implies -P: deliberately admit only this entry point's trusted sibling
# directory, never the caller's working directory or PYTHONPATH.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from analyzer import DEFAULT_OVERHANG_THRESHOLD_DEG, PrintabilityError, analyze_stl
from profiles import ProfileError, load_catalog, resolve_profile


def _write_json_atomic(path: Path, payload: dict) -> None:
    out = Path(path)
    if out.exists():
        raise PrintabilityError("output", f"output file already exists: {out}")
    if not out.parent.is_dir():
        raise PrintabilityError("output", f"output parent directory missing: {out.parent}")
    blob = (json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")
    fd, tmp_name = tempfile.mkstemp(prefix=f".{out.name}.tmp-", dir=out.parent)
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as f:
            fd = -1
            f.write(blob)
            f.flush()
            os.fsync(f.fileno())
        os.link(tmp_path, out)
    except FileExistsError:
        raise PrintabilityError("output", f"output file already exists: {out}") from None
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    sub.add_parser("profiles", help="list bundled Bambu Lab printer profiles as JSON")

    chk = sub.add_parser("check", help="evaluate STL printability against a printer profile")
    chk.add_argument("stl", type=Path, help="input binary or ASCII STL (millimetres)")
    chk.add_argument("--profile", help="explicit bundled printer profile ID or alias, e.g. p1s-0.4-hardened")
    chk.add_argument("--profile-file", type=Path, help="custom printer profile JSON file")
    chk.add_argument("--material", help="material family override, e.g. PLA, PETG, TPU")
    chk.add_argument("--overhang-deg", type=float, default=DEFAULT_OVERHANG_THRESHOLD_DEG,
                     help="overhang angle threshold from vertical in degrees (default: 45)")
    chk.add_argument("--out", type=Path, help="optional path to write JSON verdict (must not exist)")
    chk.add_argument("--strict", action="store_true",
                     help="exit 2 when verdict is not-printable (or printable-with-supports without --allow-supports)")
    chk.add_argument("--allow-supports", action="store_true",
                     help="with --strict, accept printable-with-supports")

    return ap


def main(argv: list[str] | None = None) -> int:
    ap = build_parser()
    args = ap.parse_args(argv)
    try:
        if args.command == "profiles":
            cat = load_catalog()
            out = {
                "schema": cat["schema"],
                "defaultOperatorProfile": cat["defaultOperatorProfile"],
                "operatorBaselineNote": cat["operatorBaselineNote"],
                "aliases": cat["aliases"],
                "materials": cat["materials"],
                "profiles": [cat["profilesById"][k] for k in sorted(cat["profilesById"])],
            }
            sys.stdout.write(json.dumps(out, indent=2, sort_keys=True, allow_nan=False) + "\n")
            return 0

        if args.command == "check":
            if args.profile is None and args.profile_file is None:
                raise ProfileError("check requires an explicit --profile or --profile-file; profiles are never guessed")
            profile, material_spec = resolve_profile(
                args.profile,
                profile_file=args.profile_file,
                material=args.material,
            )
            report = analyze_stl(
                args.stl,
                profile,
                material_spec,
                overhang_threshold_deg=args.overhang_deg,
            )
            if args.out is not None:
                _write_json_atomic(args.out, report)
            sys.stdout.write(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n")
            if args.strict:
                if report["verdict"] == "not-printable":
                    return 2
                if report["verdict"] == "printable-with-supports" and not args.allow_supports:
                    return 2
            return 0

    except ProfileError as exc:
        sys.stderr.write(
            json.dumps({"error": {"stage": "profile", "message": str(exc), "evidence": {}}}, indent=2, sort_keys=True) + "\n"
        )
        return 2
    except PrintabilityError as exc:
        sys.stderr.write(
            json.dumps({"error": {"stage": exc.stage, "message": exc.detail, "evidence": {}}}, indent=2, sort_keys=True) + "\n"
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
