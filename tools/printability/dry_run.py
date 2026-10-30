#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Dry-run print-path orchestrator: template output -> printability gate -> sandboxed slice."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from analyzer import PrintabilityError, analyze_stl, read_stl_bounded
from orient import orient_and_rotate_stl
from profiles import ProfileError, resolve_profile

DRY_RUN_SCHEMA = "scan-to-make.print-path-dry-run/0.1.0"
MAX_MANIFEST_BYTES = 1 << 20
DEFAULT_DRY_RUN_TIMEOUT_S = 90

_PRODUCER_PATH = Path(__file__).resolve().parents[1] / "slicer-producer" / "producer.py"
_PRODUCER_SPEC = importlib.util.spec_from_file_location("stm_slicer_producer", _PRODUCER_PATH)
if _PRODUCER_SPEC is None or _PRODUCER_SPEC.loader is None:  # pragma: no cover
    raise RuntimeError(f"cannot load slicer producer at {_PRODUCER_PATH}")
producer = importlib.util.module_from_spec(_PRODUCER_SPEC)
_PRODUCER_SPEC.loader.exec_module(producer)


class DryRunError(Exception):
    """Fail-closed error from template verification, printability gate, or slicing."""

    def __init__(self, stage: str, message: str, evidence: dict[str, Any] | None = None) -> None:
        super().__init__(f"{stage}: {message}")
        self.stage = stage
        self.message = message
        self.evidence = evidence or {}


def _read_regular_bounded(path: Path, limit: int, label: str) -> bytes:
    p = Path(path)
    try:
        fd = os.open(p, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        raise DryRunError("input", f"{label} not found: {p}") from None
    except OSError as exc:
        raise DryRunError("input", f"cannot open {label} {p}: {exc}") from exc
    try:
        st = os.fstat(fd)
        if not os.path.isfile(p) or (st.st_mode & 0o170000) != 0o100000:
            raise DryRunError("input", f"{label} must be a regular non-symlink file: {p}")
        if st.st_size == 0:
            raise DryRunError("input", f"{label} is empty: {p}")
        if st.st_size > limit:
            raise DryRunError("limits", f"{label} exceeds {limit} byte limit ({st.st_size} bytes)")
        with os.fdopen(fd, "rb") as f:
            fd = -1
            data = f.read(limit + 1)
    finally:
        if fd >= 0:
            os.close(fd)
    if len(data) > limit:
        raise DryRunError("limits", f"{label} exceeds {limit} byte limit")
    return data


def discover_template_pair(template_dir: Path) -> tuple[Path, Path]:
    d = Path(template_dir)
    if not d.is_dir() or d.is_symlink():
        raise DryRunError("input", f"template directory must be an existing directory: {d}")
    stls = sorted(p for p in d.iterdir() if p.is_file() and not p.is_symlink() and p.suffix.lower() == ".stl")
    manifests = sorted(
        p for p in d.iterdir()
        if p.is_file()
        and not p.is_symlink()
        and (p.name == "manifest.json" or p.name.endswith(".manifest.json"))
    )
    if len(stls) != 1 or len(manifests) != 1:
        raise DryRunError(
            "input",
            f"template directory must contain exactly 1 .stl and 1 manifest JSON "
            f"(found stls={[p.name for p in stls]}, manifests={[p.name for p in manifests]})",
        )
    return stls[0], manifests[0]


def verify_template_output(stl_path: Path, manifest_path: Path) -> dict[str, Any]:
    """Verify that the STL bytes match the template manifest's cryptographic binding."""
    try:
        stl_bytes = read_stl_bounded(stl_path)
    except PrintabilityError as exc:
        raise DryRunError(exc.stage, exc.detail) from exc

    manifest_bytes = _read_regular_bounded(manifest_path, MAX_MANIFEST_BYTES, "template manifest")
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise DryRunError("template", f"template manifest is not valid UTF-8 JSON: {exc}") from exc
    if not isinstance(manifest, dict):
        raise DryRunError("template", "template manifest must be a JSON object")

    stl_sha = hashlib.sha256(stl_bytes).hexdigest()
    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()

    # Family A: FitSpec template manifests (drawer-organizer, cup-holder-adapter, etc.)
    if isinstance(manifest.get("artifact"), dict):
        art = manifest["artifact"]
        if art.get("mediaType") != "model/stl":
            raise DryRunError("template", f"manifest artifact.mediaType must be 'model/stl', got {art.get('mediaType')!r}")
        if art.get("byteLength") != len(stl_bytes):
            raise DryRunError(
                "template",
                f"STL byte length {len(stl_bytes)} does not match manifest artifact.byteLength {art.get('byteLength')!r}",
            )
        if art.get("sha256") != stl_sha:
            raise DryRunError("template", "STL SHA-256 does not match manifest artifact.sha256")
        kind = manifest.get("kind") or (manifest.get("sourceSpec") or {}).get("template") or "fitspec-template"
        if not isinstance(kind, str) or not kind.strip():
            raise DryRunError("template", "template manifest kind must be a non-empty string")
        return {
            "family": "fitspec-template",
            "kind": kind,
            "stlBytes": stl_bytes,
            "stlSha256": stl_sha,
            "manifestBytes": manifest_bytes,
            "manifestSha256": manifest_sha,
            "previewOnly": True,
        }

    # Family B: Scan-derived template manifests (scan-cradle and sibling scan templates)
    if isinstance(manifest.get("outputSha256"), dict):
        if manifest.get("units") != "mm":
            raise DryRunError("template", f"scan template manifest units must be 'mm', got {manifest.get('units')!r}")
        if manifest.get("previewOnly") is not True:
            raise DryRunError("template", "scan template manifest must carry previewOnly: true")
        if manifest.get("watertight") is False:
            raise DryRunError("template", "scan template manifest reports watertight: false")
        out_hashes = manifest["outputSha256"]
        expected_sha = out_hashes.get(stl_path.name)
        if not isinstance(expected_sha, str) or expected_sha != stl_sha:
            raise DryRunError(
                "template",
                f"STL SHA-256 {stl_sha} does not match manifest outputSha256[{stl_path.name!r}]={expected_sha!r}",
            )
        kind = manifest.get("kind") or ("scan-cradle" if stl_path.name == "cradle.stl" else stl_path.stem)
        return {
            "family": "scan-template",
            "kind": str(kind),
            "stlBytes": stl_bytes,
            "stlSha256": stl_sha,
            "manifestBytes": manifest_bytes,
            "manifestSha256": manifest_sha,
            "previewOnly": True,
        }

    raise DryRunError(
        "template",
        "unrecognized template manifest: expected 'artifact' (FitSpec template) or 'outputSha256' (scan template)",
    )


def run_dry_run(
    *,
    out_dir: Path,
    profile_id: str | None = None,
    profile_file: Path | None = None,
    template_dir: Path | None = None,
    stl_path: Path | None = None,
    manifest_path: Path | None = None,
    material: str | None = None,
    process_preset: str | None = None,
    filament_preset: str | None = None,
    bundle: str = producer.DEFAULT_BUNDLE,
    expected_version: str = producer.EXPECTED_VERSION,
    expected_binary_sha256: str | None = None,
    allow_supports: bool = False,
    auto_orient: bool = False,
    overhang_threshold_deg: float = 45.0,
    timeout: int = DEFAULT_DRY_RUN_TIMEOUT_S,
    three_mf_name: str = producer.THREE_MF_NAME,
    _sandbox: Any = None,
) -> dict[str, Any]:
    """Validate template output, optionally auto-orient, check printability, slice offline, and publish sealed dry-run artifacts."""
    if profile_id is None and profile_file is None:
        raise DryRunError("profile", "an explicit --profile or --profile-file is required for slicing dry-runs")

    try:
        three_mf_name = producer.validate_three_mf_name(three_mf_name)
    except producer.ProducerError as exc:
        raise DryRunError("input", exc.message, exc.evidence) from exc

    if template_dir is not None:
        if stl_path is not None or manifest_path is not None:
            raise DryRunError("input", "pass either --template-dir or (--stl and --manifest), not both")
        resolved_stl, resolved_manifest = discover_template_pair(template_dir)
    else:
        if stl_path is None or manifest_path is None:
            raise DryRunError("input", "pass --template-dir or both --stl and --manifest")
        resolved_stl, resolved_manifest = Path(stl_path), Path(manifest_path)

    out = Path(out_dir)
    if out.exists():
        raise DryRunError("publish", f"output directory already exists: {out}")
    if not out.parent.is_dir():
        raise DryRunError("publish", f"output parent directory missing: {out.parent}")

    try:
        profile, material_spec = resolve_profile(profile_id, profile_file=profile_file, material=material)
    except ProfileError as exc:
        raise DryRunError("profile", str(exc)) from exc

    verified = verify_template_output(resolved_stl, resolved_manifest)

    orientation_report: dict[str, Any] | None = None
    effective_stl_label: Path = resolved_stl
    effective_stl_bytes: bytes = verified["stlBytes"]
    effective_stl_sha256: str = verified["stlSha256"]

    if auto_orient:
        try:
            orientation_report, oriented_bytes = orient_and_rotate_stl(
                resolved_stl,
                profile,
                overhang_threshold_deg=overhang_threshold_deg,
                stl_bytes=verified["stlBytes"],
            )
        except PrintabilityError as exc:
            raise DryRunError(exc.stage, exc.detail) from exc
        if orientation_report["input"]["sha256"] != verified["stlSha256"]:
            raise DryRunError("orient", "verified STL / orientation input digest mismatch")
        if orientation_report["selected"]["applied"]:
            effective_stl_label = Path("oriented.stl")
            effective_stl_bytes = oriented_bytes
            effective_stl_sha256 = hashlib.sha256(oriented_bytes).hexdigest()

    try:
        printability = analyze_stl(
            effective_stl_label,
            profile,
            material_spec,
            overhang_threshold_deg=overhang_threshold_deg,
            stl_bytes=effective_stl_bytes,
        )
    except PrintabilityError as exc:
        raise DryRunError(exc.stage, exc.detail) from exc

    if printability["input"]["sha256"] != effective_stl_sha256:
        raise DryRunError("printability", "verified STL / printability input digest mismatch")

    verdict = printability["verdict"]
    if verdict == "not-printable":
        raise DryRunError(
            "printability",
            f"refusing to slice unprintable design ({', '.join(printability['reasonCodes'])})",
            {
                "verdict": verdict,
                "reasonCodes": printability["reasonCodes"],
                "reasons": printability["reasons"],
                "profileId": profile["id"],
            },
        )
    if verdict == "printable-with-supports" and not allow_supports:
        raise DryRunError(
            "printability",
            "design requires supports; re-run with --allow-supports to authorize support generation",
            {
                "verdict": verdict,
                "reasonCodes": printability["reasonCodes"],
                "reasons": printability["reasons"],
                "profileId": profile["id"],
            },
        )

    need_supports = verdict == "printable-with-supports"
    chosen_machine = profile["slicerPresets"]["machine"]
    chosen_process = process_preset or profile["slicerPresets"]["process"]
    chosen_filament = filament_preset or profile["slicerPresets"]["filament"]
    try:
        filament_settings, _ = producer.resolve_preset(bundle, "filament", chosen_filament)
    except producer.ProducerError as exc:
        raise DryRunError(f"slicer.{exc.stage}", exc.message, exc.evidence) from exc
    # Resolve inheritance rather than inferring a family from the preset's name.
    # A material override alone must never silently slice with the profile's PLA.
    if filament_settings.get("filament_type") != [material_spec["family"]]:
        raise DryRunError(
            "profile",
            f"filament preset {chosen_filament!r} has filament_type "
            f"{filament_settings.get('filament_type')!r}; selected material is {material_spec['family']!r}. "
            "Pass --filament and --material with matching material families.",
        )

    stage = Path(tempfile.mkdtemp(prefix=f".{out.name}.dryrun-staging-", dir=out.parent))
    try:
        staged_stl = stage / "source.stl"
        staged_stl.write_bytes(verified["stlBytes"])
        staged_stl.chmod(0o444)
        if producer.sha256_file(staged_stl) != verified["stlSha256"]:
            raise DryRunError("seal", "staged source.stl digest mismatch")

        staged_slice_input = staged_stl
        staged_oriented_stl: Path | None = None
        orientation_bytes: bytes | None = None
        if orientation_report is not None:
            orientation_bytes = (
                json.dumps(orientation_report, indent=2, sort_keys=True, allow_nan=False) + "\n"
            ).encode("utf-8")
            staged_orientation = stage / "orientation.json"
            staged_orientation.write_bytes(orientation_bytes)
            staged_orientation.chmod(0o444)
            if orientation_report["selected"]["applied"]:
                staged_oriented_stl = stage / "oriented.stl"
                staged_oriented_stl.write_bytes(effective_stl_bytes)
                staged_oriented_stl.chmod(0o444)
                if producer.sha256_file(staged_oriented_stl) != effective_stl_sha256:
                    raise DryRunError("seal", "staged oriented.stl digest mismatch")
                staged_slice_input = staged_oriented_stl

        staged_tmanifest = stage / "template-manifest.json"
        staged_tmanifest.write_bytes(verified["manifestBytes"])
        staged_tmanifest.chmod(0o444)

        printability_bytes = (json.dumps(printability, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")
        staged_printability = stage / "printability.json"
        staged_printability.write_bytes(printability_bytes)
        staged_printability.chmod(0o444)

        slice_dir = stage / "slice"
        try:
            slice_manifest = producer.produce(
                staged_slice_input,
                slice_dir,
                chosen_machine,
                chosen_process,
                chosen_filament,
                bundle=bundle,
                expected_version=expected_version,
                expected_binary_sha256=expected_binary_sha256,
                timeout=timeout,
                expected_input_sha256=effective_stl_sha256,
                expected_input_bytes=len(effective_stl_bytes),
                bed_type=profile["bedType"],
                nozzle_type=profile["nozzleType"],
                enable_support=need_supports,
                three_mf_name=three_mf_name,
                _sandbox=_sandbox,
            )
        except producer.ProducerError as exc:
            raise DryRunError(f"slicer.{exc.stage}", exc.message, exc.evidence) from exc

        gcode_meta = slice_manifest["outputs"]["gcode"]
        three_mf_meta = slice_manifest["outputs"]["threeMf"]
        settings_meta = slice_manifest["outputs"]["exportedSettings"]
        producer_manifest_path = slice_dir / "manifest.json"
        producer_manifest_bytes = producer_manifest_path.read_bytes()
        producer_manifest_sha = hashlib.sha256(producer_manifest_bytes).hexdigest()

        if not three_mf_meta["file"].endswith(".3mf") or three_mf_meta["file"].lower().endswith(".gcode.3mf"):
            raise DryRunError("seal", f"invalid sliced 3MF dispatch filename {three_mf_meta['file']!r}")

        # Re-verify staged artifacts before sealing dry-run-manifest.json
        if producer.sha256_file(staged_stl) != verified["stlSha256"]:
            raise DryRunError("seal", "source.stl mutated during dry-run")
        if staged_oriented_stl is not None and producer.sha256_file(staged_oriented_stl) != effective_stl_sha256:
            raise DryRunError("seal", "oriented.stl mutated during dry-run")
        if producer.sha256_file(slice_dir / gcode_meta["file"]) != gcode_meta["sha256"]:
            raise DryRunError("seal", "sliced G-code digest mismatch")
        if producer.sha256_file(slice_dir / three_mf_meta["file"]) != three_mf_meta["sha256"]:
            raise DryRunError("seal", "sliced 3MF digest mismatch")
        if three_mf_meta["plateGcodeSha256"] != gcode_meta["sha256"]:
            raise DryRunError("seal", "sliced 3MF embedded plate G-code digest mismatch")
        if producer.sha256_file(slice_dir / settings_meta["file"]) != settings_meta["sha256"]:
            raise DryRunError("seal", "exported-settings.json digest mismatch")

        settings_digest = settings_meta["sha256"]
        three_mf_rel = f"slice/{three_mf_meta['file']}"
        dry_run_manifest: dict[str, Any] = {
            "schema": DRY_RUN_SCHEMA,
            "dispatchAuthorized": False,
            "printerContacted": False,
            "provesPhysicalFit": False,
            "template": {
                "family": verified["family"],
                "kind": verified["kind"],
                "previewOnly": verified["previewOnly"],
                "manifestArtifact": {
                    "file": "template-manifest.json",
                    "mediaType": "application/json",
                    "sha256": verified["manifestSha256"],
                    "byteLength": len(verified["manifestBytes"]),
                },
                "sourceArtifact": {
                    "file": "source.stl",
                    "originalFileName": resolved_stl.name,
                    "mediaType": "model/stl",
                    "sha256": verified["stlSha256"],
                    "byteLength": len(verified["stlBytes"]),
                },
            },
            "profile": profile,
            "printability": {
                "verdict": verdict,
                "reasonCodes": printability["reasonCodes"],
                "reasons": printability["reasons"],
                "warnings": printability["warnings"],
                "reportArtifact": {
                    "file": "printability.json",
                    "mediaType": "application/json",
                    "sha256": hashlib.sha256(printability_bytes).hexdigest(),
                    "byteLength": len(printability_bytes),
                },
            },
            "slice": {
                "printableArtifact": {
                    "file": three_mf_rel,
                    "mediaType": "model/3mf",
                    "sha256": three_mf_meta["sha256"],
                    "byteLength": three_mf_meta["bytes"],
                },
                "threeMfArtifact": {
                    "file": three_mf_rel,
                    "mediaType": "model/3mf",
                    "sha256": three_mf_meta["sha256"],
                    "byteLength": three_mf_meta["bytes"],
                    "plateGcodeInternalPath": three_mf_meta["plateGcodeInternalPath"],
                    "plateGcodeSha256": three_mf_meta["plateGcodeSha256"],
                    "plateGcodeBytes": three_mf_meta["plateGcodeBytes"],
                },
                "gcodeArtifact": {
                    "file": f"slice/{gcode_meta['file']}",
                    "mediaType": "text/x.gcode",
                    "sha256": gcode_meta["sha256"],
                    "byteLength": gcode_meta["bytes"],
                },
                "slicerSettingsSha256": settings_digest,
                "exportedSettingsArtifact": {
                    "file": f"slice/{settings_meta['file']}",
                    "mediaType": "application/json",
                    "sha256": settings_digest,
                    "byteLength": settings_meta["bytes"],
                },
                "producerManifestArtifact": {
                    "file": "slice/manifest.json",
                    "mediaType": "application/json",
                    "sha256": producer_manifest_sha,
                    "byteLength": len(producer_manifest_bytes),
                },
                "slicer": {
                    "version": slice_manifest["slicer"]["version"],
                    "binarySha256": slice_manifest["slicer"]["binary"]["sha256"],
                },
                "presets": {
                    k: {
                        "name": v["name"],
                        "flattenedSha256": v["flattenedSha256"],
                        "flattenedBytes": v["flattenedBytes"],
                    }
                    for k, v in sorted(slice_manifest["presets"].items())
                },
                "overrides": slice_manifest["overrides"],
                "summary": slice_manifest["outputs"]["gcodeSummary"],
            },
            "dispatchCandidate": {
                "artifact": {
                    "file": three_mf_rel,
                    "mediaType": "model/3mf",
                    "sha256": three_mf_meta["sha256"],
                    "byteLength": three_mf_meta["bytes"],
                },
                "plateGcodeInternalPath": three_mf_meta["plateGcodeInternalPath"],
                "plateGcodeSha256": three_mf_meta["plateGcodeSha256"],
                "tool": "print_3mf",
                "argumentsTemplate": {
                    "three_mf_path": three_mf_rel,
                    "bambu_model": profile["bambuModel"],
                    "bed_type": profile["bedType"],
                    "plate_index": 0,
                    "use_ams": True,
                    "ams_slots": None,
                },
                "amsSlotMappingRule": "tray_index = ams_unit * 4 + slot (taken from a fresh get_printer_status; 254 for external spool with use_ams=false)",
                "note": "Bind ams_slots=[tray_index] from a fresh get_printer_status at dispatch time; physical dispatch remains human-authorized.",
            },
            "companionPreparedSelectionCandidate": {
                "printerId": None,
                "model": profile["bambuModel"],
                "plateIndex": 0,
                "nozzleDiameters": [profile["nozzleDiameterMm"]] * int(profile["nozzleCount"]),
                "bedType": profile["bedType"],
                "materials": [
                    {
                        "projectSlot": 0,
                        "material": material_spec["family"],
                        "physicalTray": None,
                    }
                ],
                "slicerSettingsSha256": settings_digest,
                "note": "Bind concrete printerId and physicalTray (0..15 AMS slot or 254 external spool) at PreparedJob preparation time; physical dispatch remains a separate human-authorized step.",
            },
        }
        if orientation_report is not None and orientation_bytes is not None:
            sel = orientation_report["selected"]
            sliced_stl_file = "oriented.stl" if sel["applied"] else "source.stl"
            dry_run_manifest["orientation"] = {
                "autoOrient": True,
                "applied": sel["applied"],
                "candidateId": sel["candidateId"],
                "sources": sel["sources"],
                "downNormal": sel["downNormal"],
                "zYawDeg": sel["zYawDeg"],
                "rotationMatrix": sel["rotationMatrix"],
                "axis": sel["axis"],
                "angleDeg": sel["angleDeg"],
                "score": sel["score"],
                "scoreBreakdown": sel["scoreBreakdown"],
                "baselineScore": orientation_report["baseline"]["score"],
                "candidateCount": orientation_report["candidateCount"],
                "metrics": sel["metrics"],
                "slicedStlArtifact": {
                    "file": sliced_stl_file,
                    "mediaType": "model/stl",
                    "sha256": effective_stl_sha256,
                    "byteLength": len(effective_stl_bytes),
                },
                "reportArtifact": {
                    "file": "orientation.json",
                    "mediaType": "application/json",
                    "sha256": hashlib.sha256(orientation_bytes).hexdigest(),
                    "byteLength": len(orientation_bytes),
                },
            }
        dry_bytes = (json.dumps(dry_run_manifest, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")
        dry_path = stage / "dry-run-manifest.json"
        dry_path.write_bytes(dry_bytes)
        dry_path.chmod(0o444)

        try:
            producer._rename_noreplace(stage, out)
        except producer.ProducerError as exc:
            raise DryRunError("publish", exc.message) from exc
        return dry_run_manifest
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
