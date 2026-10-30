#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""CLI for deterministic STL printability checks and template-to-slice dry runs.

Commands:
  python3 tools/printability/printability.py profiles
  python3 tools/printability/printability.py check part.stl --profile p1s-0.4-hardened
  python3 tools/printability/printability.py dry-run --template-dir <dir> --profile p1s-0.4-hardened --out <out>

Never contacts a printer or dispatches a print job.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

from analyzer import DEFAULT_OVERHANG_THRESHOLD_DEG, PrintabilityError, analyze_stl
from dry_run import DEFAULT_DRY_RUN_TIMEOUT_S, DryRunError, producer, run_dry_run
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
                     help="exit 1 when verdict is not-printable (or printable-with-supports without --allow-supports)")
    chk.add_argument("--allow-supports", action="store_true",
                     help="with --strict, accept printable-with-supports")

    dr = sub.add_parser("dry-run", help="verify template STL+manifest, check printability, and slice offline")
    dr.add_argument("--template-dir", type=Path, help="template output directory containing one STL + manifest")
    dr.add_argument("--stl", type=Path, help="explicit template STL path")
    dr.add_argument("--manifest", type=Path, help="explicit template manifest JSON path")
    dr.add_argument("--profile", help="explicit bundled printer profile ID or alias, e.g. p1s-0.4-hardened")
    dr.add_argument("--profile-file", type=Path, help="custom printer profile JSON file")
    dr.add_argument("--out", required=True, type=Path, help="output directory (must not exist; published atomically)")
    dr.add_argument("--material", help="material family override for filament density/selection")
    dr.add_argument("--process", help="optional bundled BambuStudio process preset override")
    dr.add_argument("--filament", help="optional bundled BambuStudio filament preset override")
    dr.add_argument("--bundle", default=producer.DEFAULT_BUNDLE, help="BambuStudio.app bundle path")
    dr.add_argument("--expected-version", default=producer.EXPECTED_VERSION, help="expected BambuStudio version")
    dr.add_argument("--expected-binary-sha256", help="optional SHA-256 pin for Contents/MacOS/BambuStudio")
    dr.add_argument("--allow-supports", action="store_true",
                    help="permit slicing designs with verdict printable-with-supports (enables supports)")
    dr.add_argument("--overhang-deg", type=float, default=DEFAULT_OVERHANG_THRESHOLD_DEG)
    dr.add_argument("--timeout", type=int, default=DEFAULT_DRY_RUN_TIMEOUT_S)
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

        if args.command == "dry-run":
            result = run_dry_run(
                out_dir=args.out,
                profile_id=args.profile,
                profile_file=args.profile_file,
                template_dir=args.template_dir,
                stl_path=args.stl,
                manifest_path=args.manifest,
                material=args.material,
                process_preset=args.process,
                filament_preset=args.filament,
                bundle=args.bundle,
                expected_version=args.expected_version,
                expected_binary_sha256=args.expected_binary_sha256,
                allow_supports=args.allow_supports,
                overhang_threshold_deg=args.overhang_deg,
                timeout=args.timeout,
            )
            sys.stdout.write(json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + "\n")
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
    except DryRunError as exc:
        sys.stderr.write(
            json.dumps(
                {"error": {"stage": exc.stage, "message": exc.message, "evidence": exc.evidence}},
                indent=2,
                sort_keys=True,
            ) + "\n"
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
