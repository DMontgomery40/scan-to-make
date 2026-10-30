#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Declarative Bambu Lab printer profile catalog and strict validator."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

PROFILES_SCHEMA = "scan-to-make.printer-profiles/0.1.0"
DEFAULT_PROFILES_PATH = Path(__file__).resolve().with_name("profiles.json")
SUPPORTED_NOZZLE_DIAMETERS = (0.2, 0.4, 0.6, 0.8)
SUPPORTED_BED_TYPES = ("textured_plate", "cool_plate", "engineering_plate", "hot_plate")
SUPPORTED_NOZZLE_TYPES = ("stainless_steel", "hardened_steel", "tungsten_carbide", "brass")


class ProfileError(ValueError):
    """Raised when a printer profile or material lookup is missing or malformed."""


def _pos_float(val: Any, label: str) -> float:
    if isinstance(val, bool) or not isinstance(val, (int, float)) or not math.isfinite(val) or val <= 0:
        raise ProfileError(f"{label} must be a positive finite number")
    return float(val)


def _nonneg_float(val: Any, label: str) -> float:
    if isinstance(val, bool) or not isinstance(val, (int, float)) or not math.isfinite(val) or val < 0:
        raise ProfileError(f"{label} must be a non-negative finite number")
    return float(val)


def validate_profile(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ProfileError("printer profile must be a JSON object")
    required = {
        "id",
        "bambuModel",
        "displayName",
        "bedMm",
        "excludeZonesMm",
        "nozzleDiameterMm",
        "nozzleCount",
        "nozzleType",
        "bedType",
        "filamentDiameterMm",
        "defaultMaterial",
        "slicerPresets",
    }
    missing = sorted(required - set(raw))
    if missing:
        raise ProfileError(f"printer profile missing fields: {missing}")
    pid = raw["id"]
    model = raw["bambuModel"]
    name = raw["displayName"]
    if not all(isinstance(v, str) and v.strip() for v in (pid, model, name)):
        raise ProfileError("id, bambuModel and displayName must be non-empty strings")
    bed = raw["bedMm"]
    if not isinstance(bed, dict) or set(bed) != {"x", "y", "z"}:
        raise ProfileError("bedMm must contain exactly x, y, z")
    bx, by, bz = _pos_float(bed["x"], "bedMm.x"), _pos_float(bed["y"], "bedMm.y"), _pos_float(bed["z"], "bedMm.z")

    zones_raw = raw["excludeZonesMm"]
    if not isinstance(zones_raw, list):
        raise ProfileError("excludeZonesMm must be a list")
    zones = []
    for idx, z in enumerate(zones_raw):
        if not isinstance(z, dict) or set(z) != {"xMin", "yMin", "xMax", "yMax", "reason"}:
            raise ProfileError(f"excludeZonesMm[{idx}] must contain xMin, yMin, xMax, yMax, reason")
        x0 = _nonneg_float(z["xMin"], f"excludeZonesMm[{idx}].xMin")
        y0 = _nonneg_float(z["yMin"], f"excludeZonesMm[{idx}].yMin")
        x1 = _pos_float(z["xMax"], f"excludeZonesMm[{idx}].xMax")
        y1 = _pos_float(z["yMax"], f"excludeZonesMm[{idx}].yMax")
        if not (x0 < x1 <= bx and y0 < y1 <= by):
            raise ProfileError(f"excludeZonesMm[{idx}] bounds out of bed range")
        if not isinstance(z["reason"], str) or not z["reason"].strip():
            raise ProfileError(f"excludeZonesMm[{idx}].reason must be a non-empty string")
        zones.append({"xMin": x0, "yMin": y0, "xMax": x1, "yMax": y1, "reason": z["reason"]})

    nozzle = _pos_float(raw["nozzleDiameterMm"], "nozzleDiameterMm")
    if nozzle not in SUPPORTED_NOZZLE_DIAMETERS:
        raise ProfileError(f"unsupported nozzleDiameterMm {nozzle!r}; expected {SUPPORTED_NOZZLE_DIAMETERS}")
    nozzle_count = raw["nozzleCount"]
    if isinstance(nozzle_count, bool) or not isinstance(nozzle_count, int) or nozzle_count not in (1, 2):
        raise ProfileError("nozzleCount must be 1 or 2")
    if raw["nozzleType"] not in SUPPORTED_NOZZLE_TYPES:
        raise ProfileError(f"unsupported nozzleType {raw['nozzleType']!r}")
    if raw["bedType"] not in SUPPORTED_BED_TYPES:
        raise ProfileError(f"unsupported bedType {raw['bedType']!r}")
    fil_diam = _pos_float(raw["filamentDiameterMm"], "filamentDiameterMm")
    def_mat = raw["defaultMaterial"]
    if not isinstance(def_mat, str) or not def_mat.strip():
        raise ProfileError("defaultMaterial must be a non-empty string")
    presets = raw["slicerPresets"]
    if not isinstance(presets, dict) or set(presets) != {"machine", "process", "filament"}:
        raise ProfileError("slicerPresets must contain machine, process, filament")
    for k in ("machine", "process", "filament"):
        if not isinstance(presets[k], str) or not presets[k].strip():
            raise ProfileError(f"slicerPresets.{k} must be a non-empty string")
    return {
        "id": pid,
        "bambuModel": model,
        "displayName": name,
        "bedMm": {"x": bx, "y": by, "z": bz},
        "excludeZonesMm": zones,
        "nozzleDiameterMm": nozzle,
        "nozzleCount": nozzle_count,
        "nozzleType": raw["nozzleType"],
        "bedType": raw["bedType"],
        "filamentDiameterMm": fil_diam,
        "defaultMaterial": def_mat.upper(),
        "slicerPresets": {
            "machine": presets["machine"],
            "process": presets["process"],
            "filament": presets["filament"],
        },
    }


def load_catalog(catalog_path: Path | None = None) -> dict[str, Any]:
    path = Path(catalog_path or DEFAULT_PROFILES_PATH)
    if not path.is_file():
        raise ProfileError(f"profile catalog not found: {path}")
    data_bytes = path.read_bytes()
    if len(data_bytes) > (1 << 20):
        raise ProfileError("profile catalog exceeds 1 MiB")
    try:
        catalog = json.loads(data_bytes.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ProfileError(f"invalid JSON in profile catalog: {exc}") from exc
    if not isinstance(catalog, dict) or catalog.get("schema") != PROFILES_SCHEMA:
        raise ProfileError(f"expected catalog schema {PROFILES_SCHEMA!r}")
    materials_raw = catalog.get("materials")
    if not isinstance(materials_raw, dict) or not materials_raw:
        raise ProfileError("catalog materials must be a non-empty object")
    materials: dict[str, dict[str, Any]] = {}
    for key, val in materials_raw.items():
        if not isinstance(val, dict):
            raise ProfileError(f"material {key!r} must be an object")
        dens = _pos_float(val.get("densityGPerCm3"), f"materials.{key}.densityGPerCm3")
        fam = val.get("family", key)
        if not isinstance(fam, str) or not fam.strip():
            raise ProfileError(f"materials.{key}.family must be a non-empty string")
        materials[key.upper()] = {"family": fam.upper(), "densityGPerCm3": dens}
    profiles_list = catalog.get("profiles")
    if not isinstance(profiles_list, list) or not profiles_list:
        raise ProfileError("catalog profiles must be a non-empty list")
    by_id: dict[str, dict[str, Any]] = {}
    for entry in profiles_list:
        validated = validate_profile(entry)
        if validated["id"] in by_id:
            raise ProfileError(f"duplicate profile id {validated['id']!r}")
        if validated["defaultMaterial"] not in materials:
            raise ProfileError(f"profile {validated['id']!r} references unknown material {validated['defaultMaterial']!r}")
        by_id[validated["id"]] = validated
    aliases_raw = catalog.get("aliases", {})
    if not isinstance(aliases_raw, dict):
        raise ProfileError("catalog aliases must be an object")
    aliases: dict[str, str] = {}
    for alias, target in aliases_raw.items():
        if not isinstance(alias, str) or not isinstance(target, str) or target not in by_id:
            raise ProfileError(f"invalid profile alias {alias!r} -> {target!r}")
        aliases[alias] = target
    default_id = catalog.get("defaultOperatorProfile")
    if not isinstance(default_id, str) or default_id not in by_id:
        raise ProfileError("defaultOperatorProfile must name a defined profile")
    return {
        "schema": PROFILES_SCHEMA,
        "defaultOperatorProfile": default_id,
        "operatorBaselineNote": catalog.get("operatorBaselineNote", ""),
        "aliases": dict(sorted(aliases.items())),
        "materials": dict(sorted(materials.items())),
        "profilesById": by_id,
    }


def resolve_profile(
    profile_id: str | None = None,
    *,
    profile_file: Path | None = None,
    material: str | None = None,
    catalog_path: Path | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return `(profile, material_spec)` for an explicit ID/alias or custom profile JSON file."""
    catalog = load_catalog(catalog_path)
    if profile_file is not None:
        if profile_id is not None:
            raise ProfileError("supply either --profile or --profile-file, not both")
        p = Path(profile_file)
        if not p.is_file():
            raise ProfileError(f"custom profile file not found: {p}")
        raw_bytes = p.read_bytes()
        if len(raw_bytes) > 65536:
            raise ProfileError("custom profile file exceeds 64 KiB")
        try:
            custom = json.loads(raw_bytes.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ProfileError(f"invalid JSON in custom profile: {exc}") from exc
        prof = validate_profile(custom)
    else:
        key = (profile_id or catalog["defaultOperatorProfile"]).strip()
        resolved_key = catalog["aliases"].get(key, key)
        if resolved_key not in catalog["profilesById"]:
            known = sorted(set(catalog["profilesById"]) | set(catalog["aliases"]))
            raise ProfileError(f"unknown printer profile {profile_id!r}; choose from {known}")
        prof = dict(catalog["profilesById"][resolved_key])
    mat_key = (material or prof["defaultMaterial"]).strip().upper()
    if mat_key not in catalog["materials"]:
        raise ProfileError(f"unknown material {material!r}; choose from {sorted(catalog['materials'])}")
    return prof, dict(catalog["materials"][mat_key])
