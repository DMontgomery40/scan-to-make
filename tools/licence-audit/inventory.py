# SPDX-License-Identifier: MIT
"""Dependency and tool licence inventory across npm, CocoaPods, and Python."""

from __future__ import annotations

import ast
from collections import deque
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import sys
import tomllib
from typing import Any

from spdx import (
    FIRST_PARTY,
    NON_COMMERCIAL,
    UNKNOWN,
    classify_licence_text,
    extract_spdx_headers,
    has_non_commercial_restriction,
    is_gpl_family,
    normalize_classifier,
    normalize_expression,
)

_LICENCE_FILENAMES_RE = re.compile(
    r"^(?:licen[cs]e|copying)(?:[-_.]?[a-z0-9]+)*$",
    re.IGNORECASE,
)

_BLENDER_EMBEDDED_MODULES = frozenset(
    {
        "aud",
        "bl_math",
        "blf",
        "bmesh",
        "bpy",
        "bpy_extras",
        "freestyle",
        "gpu",
        "gpu_extras",
        "idprop",
        "imbuf",
        "mathutils",
    }
)

_IGNORED_TOOL_SUBDIRS = frozenset(
    {
        "__pycache__",
        ".build",
        ".pytest_cache",
        ".ruff_cache",
        ".venv",
        "venv",
        "node_modules",
        "tests",
        "Tests",
        "Sources",
        "examples",
        "fixtures",
    }
)

_IGNORED_APP_DIRS = frozenset(
    {
        "__pycache__",
        ".bundle",
        ".cxx",
        ".expo",
        ".git",
        ".gradle",
        ".idea",
        ".kotlin",
        ".yarn",
        "DerivedData",
        "Pods",
        "build",
        "coverage",
        "node_modules",
    }
)

_TEXT_SCAN_EXTENSIONS = frozenset(
    {
        ".c",
        ".cc",
        ".cjs",
        ".cmake",
        ".cpp",
        ".cts",
        ".gradle",
        ".h",
        ".hpp",
        ".java",
        ".js",
        ".json",
        ".jsx",
        ".kt",
        ".kts",
        ".m",
        ".mjs",
        ".mm",
        ".mts",
        ".pbxproj",
        ".plist",
        ".podspec",
        ".py",
        ".rb",
        ".sh",
        ".swift",
        ".toml",
        ".ts",
        ".tsx",
        ".xcconfig",
        ".xml",
        ".yaml",
        ".yml",
    }
)


def _rel_posix(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def find_licence_files(directory: Path) -> list[Path]:
    """Return sorted top-level LICENSE / COPYING files inside directory."""
    if not directory.is_dir():
        return []
    matches = [
        entry
        for entry in directory.iterdir()
        if entry.is_file() and _LICENCE_FILENAMES_RE.match(entry.name)
    ]
    return sorted(matches, key=lambda p: (0 if p.name.upper().startswith("LICEN") else 1, p.name))


def _extract_legacy_npm_licence(pkg_data: dict[str, Any]) -> str | None:
    lic = pkg_data.get("license")
    if isinstance(lic, str) and lic.strip():
        return lic.strip()
    if isinstance(lic, dict) and isinstance(lic.get("type"), str):
        return lic["type"].strip()
    lics = pkg_data.get("licenses")
    if isinstance(lics, list):
        parts = []
        for item in lics:
            if isinstance(item, str) and item.strip():
                parts.append(item.strip())
            elif isinstance(item, dict) and isinstance(item.get("type"), str):
                parts.append(item["type"].strip())
        if len(parts) == 1:
            return parts[0]
        if len(parts) > 1:
            return "(" + " OR ".join(parts) + ")"
    return None


def _lockfile_lookup_candidates(parent_key: str, dep_name: str) -> list[str]:
    """Return lockfile package key candidates walking ancestor directories up to root node_modules."""
    segments = [seg for seg in parent_key.split("/") if seg] if parent_key else []
    candidates: list[str] = []
    for length in range(len(segments), -1, -1):
        if length == 0:
            candidates.append(f"node_modules/{dep_name}")
            continue
        last = segments[length - 1]
        if last == "node_modules":
            continue
        if last.startswith("@") and length >= 2 and segments[length - 2] == "node_modules":
            continue
        prefix = "/".join(segments[:length])
        candidates.append(f"{prefix}/node_modules/{dep_name}")
    return candidates


def _resolve_lockfile_dep_key(
    packages: dict[str, dict[str, Any]],
    parent_key: str,
    dep_name: str,
) -> str | None:
    for candidate in _lockfile_lookup_candidates(parent_key, dep_name):
        if candidate in packages:
            entry = packages[candidate]
            if entry.get("link") and isinstance(entry.get("resolved"), str):
                target = entry["resolved"]
                if target in packages:
                    return target
            return candidate
    return None


def _read_local_pkg_json(workspace_dir: Path | None, key: str) -> dict[str, Any]:
    if workspace_dir is None or key.startswith("node_modules/"):
        return {}
    pkg_json_path = (workspace_dir / key) / "package.json"
    if not pkg_json_path.is_file():
        return {}
    try:
        data = json.loads(pkg_json_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _collect_npm_prod_keys(
    packages: dict[str, dict[str, Any]],
    workspace_dir: Path | None = None,
) -> set[str]:
    root_entry = packages.get("", {})
    root_pkg_json = _read_local_pkg_json(workspace_dir, "")
    queue: deque[tuple[str, str, bool]] = deque()

    def _enqueue_edges(
        parent_key: str,
        entry: dict[str, Any],
        fallback_pkg: dict[str, Any],
    ) -> None:
        deps = dict(fallback_pkg.get("dependencies") or {}) | dict(entry.get("dependencies") or {})
        opt_deps = dict(fallback_pkg.get("optionalDependencies") or {}) | dict(
            entry.get("optionalDependencies") or {}
        )
        peer_deps = dict(fallback_pkg.get("peerDependencies") or {}) | dict(
            entry.get("peerDependencies") or {}
        )
        peer_meta = dict(fallback_pkg.get("peerDependenciesMeta") or {}) | dict(
            entry.get("peerDependenciesMeta") or {}
        )
        for dep in sorted(set(deps.keys()) | set(opt_deps.keys())):
            queue.append((parent_key, dep, False))
        for peer in sorted(peer_deps.keys()):
            meta_entry = peer_meta.get(peer)
            is_opt_peer = isinstance(meta_entry, dict) and bool(meta_entry.get("optional"))
            queue.append((parent_key, peer, is_opt_peer))

    _enqueue_edges("", root_entry, root_pkg_json)
    if queue:
        visited: set[str] = set()
        while queue:
            parent_key, dep_name, is_opt_peer = queue.popleft()
            resolved_key = _resolve_lockfile_dep_key(packages, parent_key, dep_name)
            if not resolved_key or resolved_key in visited:
                continue
            entry = packages.get(resolved_key, {})
            if is_opt_peer and (entry.get("dev") is True or entry.get("devOptional") is True):
                continue
            visited.add(resolved_key)
            local_pkg = _read_local_pkg_json(workspace_dir, resolved_key)
            _enqueue_edges(resolved_key, entry, local_pkg)
        return visited

    return {
        key
        for key, entry in packages.items()
        if key != "" and not entry.get("dev") and not entry.get("devOptional") and not entry.get("link")
    }


def _package_name_from_lock_key(key: str, entry: dict[str, Any]) -> str:
    if isinstance(entry.get("name"), str) and entry["name"].strip():
        return entry["name"].strip()
    if "node_modules/" in key:
        return key.split("node_modules/")[-1]
    return key


def _resolve_npm_entry(
    repo_root: Path,
    workspace_dir: Path,
    lockfile_rel: str,
    key: str,
    entry: dict[str, Any],
    scope: str,
    production: bool,
) -> dict[str, Any]:
    pkg_dir = (workspace_dir / key).resolve()
    pkg_json_path = pkg_dir / "package.json"
    pkg_json: dict[str, Any] = {}
    if pkg_json_path.is_file():
        try:
            pkg_json = json.loads(pkg_json_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pkg_json = {}

    name = pkg_json.get("name") if isinstance(pkg_json.get("name"), str) else _package_name_from_lock_key(key, entry)
    version = str(entry.get("version") or pkg_json.get("version") or "0.0.0")
    resolved_url = str(entry.get("resolved") or "")

    is_local_workspace_pkg = (
        not key.startswith("node_modules/")
        and not resolved_url.startswith(("http://", "https://"))
        and _is_within(pkg_dir, repo_root)
    )

    licence_files = find_licence_files(pkg_dir)
    licence_file_text = ""
    licence_file_rel: str | None = None
    if licence_files:
        licence_file_text = licence_files[0].read_text(encoding="utf-8", errors="replace")
        licence_file_rel = _rel_posix(licence_files[0], repo_root)

    if is_local_workspace_pkg:
        if licence_file_text:
            resolved_lic = classify_licence_text(licence_file_text)
            return {
                "ecosystem": "npm",
                "evidence": licence_file_rel or lockfile_rel,
                "firstParty": False,
                "licence": resolved_lic,
                "licenceFile": licence_file_rel,
                "lockfile": lockfile_rel,
                "name": name,
                "packagePath": _rel_posix(pkg_dir, repo_root),
                "production": production,
                "resolvedUrl": resolved_url or None,
                "scope": scope,
                "version": version,
            }
        declared = _extract_legacy_npm_licence(entry) or _extract_legacy_npm_licence(pkg_json)
        if declared:
            return {
                "ecosystem": "npm",
                "evidence": _rel_posix(pkg_json_path, repo_root) if pkg_json_path.is_file() else lockfile_rel,
                "firstParty": False,
                "licence": normalize_expression(declared),
                "licenceFile": None,
                "lockfile": lockfile_rel,
                "name": name,
                "packagePath": _rel_posix(pkg_dir, repo_root),
                "production": production,
                "resolvedUrl": resolved_url or None,
                "scope": scope,
                "version": version,
            }
        if pkg_json.get("private") is True:
            return {
                "ecosystem": "npm",
                "evidence": _rel_posix(pkg_json_path, repo_root),
                "firstParty": True,
                "licence": FIRST_PARTY,
                "licenceFile": None,
                "lockfile": lockfile_rel,
                "name": name,
                "packagePath": _rel_posix(pkg_dir, repo_root),
                "production": production,
                "resolvedUrl": None,
                "scope": scope,
                "version": version,
            }

    raw_lic = _extract_legacy_npm_licence(entry) or _extract_legacy_npm_licence(pkg_json)
    evidence = lockfile_rel
    if not _extract_legacy_npm_licence(entry) and _extract_legacy_npm_licence(pkg_json):
        evidence = _rel_posix(pkg_json_path, repo_root)

    resolved_lic = normalize_expression(raw_lic)
    if licence_file_text:
        if has_non_commercial_restriction(licence_file_text):
            resolved_lic = NON_COMMERCIAL
            evidence = licence_file_rel or evidence
        elif resolved_lic == UNKNOWN:
            classified = classify_licence_text(licence_file_text)
            if classified != UNKNOWN:
                resolved_lic = classified
                evidence = licence_file_rel or evidence

    homepage = pkg_json.get("homepage") if isinstance(pkg_json.get("homepage"), str) else None
    repo_field = pkg_json.get("repository")
    repo_url: str | None = None
    if isinstance(repo_field, str):
        repo_url = repo_field
    elif isinstance(repo_field, dict) and isinstance(repo_field.get("url"), str):
        repo_url = repo_field["url"]

    return {
        "ecosystem": "npm",
        "evidence": evidence,
        "firstParty": False,
        "homepage": homepage,
        "licence": resolved_lic,
        "licenceFile": licence_file_rel,
        "lockfile": lockfile_rel,
        "name": name,
        "packagePath": key,
        "production": production,
        "repositoryUrl": repo_url,
        "resolvedUrl": resolved_url or None,
        "scope": scope,
        "version": version,
    }


def inventory_mobile_npm(repo_root: Path) -> list[dict[str, Any]]:
    """Inventory production npm dependencies shipping in apps/mobile."""
    lockfile = repo_root / "apps" / "mobile" / "package-lock.json"
    if not lockfile.is_file():
        return []
    data = json.loads(lockfile.read_text(encoding="utf-8"))
    packages: dict[str, dict[str, Any]] = data.get("packages") or {}
    workspace_dir = lockfile.parent
    prod_keys = _collect_npm_prod_keys(packages, workspace_dir=workspace_dir)
    lockfile_rel = _rel_posix(lockfile, repo_root)

    items: list[dict[str, Any]] = []
    for key in sorted(prod_keys):
        entry = packages.get(key)
        if not entry or entry.get("link"):
            continue
        items.append(
            _resolve_npm_entry(
                repo_root=repo_root,
                workspace_dir=workspace_dir,
                lockfile_rel=lockfile_rel,
                key=key,
                entry=entry,
                scope="app",
                production=True,
            )
        )
    return sorted(items, key=lambda x: (x["name"], x["version"], x["packagePath"]))


def inventory_mobile_embedded_modules(repo_root: Path) -> list[dict[str, Any]]:
    """Third-party source embedded in the iPhone app: `apps/mobile/modules/*` with LICENSE.txt and PROVENANCE.md.

    The Swift app has no package manager closure for these, so they are found by their own licence and
    provenance files. The module's package.json, when present, names and versions it.
    """
    modules_dir = repo_root / "apps" / "mobile" / "modules"
    if not modules_dir.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for module_dir in sorted(p for p in modules_dir.iterdir() if p.is_dir()):
        licence_path = module_dir / "LICENSE.txt"
        if not licence_path.is_file() or not (module_dir / "PROVENANCE.md").is_file():
            continue
        meta: dict[str, Any] = {}
        meta_path = module_dir / "package.json"
        if meta_path.is_file():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                meta = {}
        licence_rel = _rel_posix(licence_path, repo_root)
        items.append(
            {
                "ecosystem": "embedded",
                "evidence": licence_rel,
                "firstParty": False,
                "licence": classify_licence_text(licence_path.read_text(encoding="utf-8", errors="replace")),
                "licenceFile": licence_rel,
                "lockfile": None,
                "name": meta.get("name") if isinstance(meta.get("name"), str) else f"@scan-to-make/{module_dir.name}",
                "packagePath": _rel_posix(module_dir, repo_root),
                "production": True,
                "resolvedUrl": None,
                "scope": "app",
                "version": str(meta.get("version") or "0.0.0"),
            }
        )
    return items


def _collect_mobile_linked_workspace_dirs(repo_root: Path) -> set[Path]:
    """Return resolved directories of workspace packages linked into apps/mobile's production closure."""
    linked_dirs: set[Path] = set()
    dir_queue: deque[Path] = deque()
    mobile_dir = repo_root / "apps" / "mobile"
    if mobile_dir.is_dir():
        dir_queue.append(mobile_dir.resolve())

    mobile_lock = mobile_dir / "package-lock.json"
    if mobile_lock.is_file():
        try:
            ldata = json.loads(mobile_lock.read_text(encoding="utf-8"))
            pkgs = ldata.get("packages") or {}
            for key in _collect_npm_prod_keys(pkgs, workspace_dir=mobile_dir):
                if not key.startswith("node_modules/"):
                    cand = (mobile_dir / key).resolve()
                    if cand.is_dir() and _is_within(cand, repo_root) and cand != mobile_dir.resolve():
                        if cand not in linked_dirs:
                            linked_dirs.add(cand)
                            dir_queue.append(cand)
        except (OSError, json.JSONDecodeError):
            pass

    visited_pkg_dirs: set[Path] = set()
    while dir_queue:
        cur_dir = dir_queue.popleft()
        if cur_dir in visited_pkg_dirs:
            continue
        visited_pkg_dirs.add(cur_dir)
        pkg_json = cur_dir / "package.json"
        if not pkg_json.is_file():
            continue
        try:
            pdata = json.loads(pkg_json.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        peer_meta = pdata.get("peerDependenciesMeta") or {}
        specs: list[str] = []
        for section in ("dependencies", "optionalDependencies"):
            for spec in (pdata.get(section) or {}).values():
                if isinstance(spec, str):
                    specs.append(spec)
        for peer_name, spec in (pdata.get("peerDependencies") or {}).items():
            meta_entry = peer_meta.get(peer_name)
            if isinstance(meta_entry, dict) and bool(meta_entry.get("optional")):
                continue
            if isinstance(spec, str):
                specs.append(spec)
        for spec in specs:
            if spec.startswith("file:"):
                target = (cur_dir / spec[5:]).resolve()
                if target.is_dir() and _is_within(target, repo_root) and target != mobile_dir.resolve():
                    if target not in linked_dirs:
                        linked_dirs.add(target)
                        dir_queue.append(target)

    return linked_dirs


def inventory_workspace_npm(repo_root: Path) -> list[dict[str, Any]]:
    """Inventory npm dependencies across services/** and packages/**."""
    lockfiles: list[Path] = []
    for base_name in ("services", "packages"):
        base_dir = repo_root / base_name
        if not base_dir.is_dir():
            continue
        for candidate in base_dir.rglob("package-lock.json"):
            if "node_modules" in candidate.parts:
                continue
            lockfiles.append(candidate)

    # Identify workspace packages depended on by apps/mobile so their
    # production dependencies are also checked against the app allowlist and notices.
    mobile_linked_dirs = _collect_mobile_linked_workspace_dirs(repo_root)

    items: list[dict[str, Any]] = []
    for lockfile in sorted(lockfiles):
        data = json.loads(lockfile.read_text(encoding="utf-8"))
        packages: dict[str, dict[str, Any]] = data.get("packages") or {}
        workspace_dir = lockfile.parent.resolve()
        prod_keys = _collect_npm_prod_keys(packages, workspace_dir=workspace_dir)
        lockfile_rel = _rel_posix(lockfile, repo_root)
        ships_in_app = workspace_dir in mobile_linked_dirs

        for key in sorted(packages.keys()):
            if key == "":
                continue
            entry = packages[key]
            if entry.get("link"):
                continue
            is_prod = key in prod_keys
            target_scope = "app" if (ships_in_app and is_prod) else "server"
            items.append(
                _resolve_npm_entry(
                    repo_root=repo_root,
                    workspace_dir=workspace_dir,
                    lockfile_rel=lockfile_rel,
                    key=key,
                    entry=entry,
                    scope=target_scope,
                    production=is_prod,
                )
            )
    return sorted(items, key=lambda x: (x["lockfile"], x["name"], x["version"], x["packagePath"]))


# --- CocoaPods Podfile.lock + Podspec Resolution ---

_POD_BULLET_RE = re.compile(r"^  - ([^\s()]+)\s+\(([^)]+)\):?\s*$")
_TOP_SECTION_RE = re.compile(r"^([A-Z][A-Z0-9 _]+):(?:\s*(.*))?$")


def parse_podfile_lock(lockfile_text: str) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, str]], dict[str, str]]:
    """Parse PODS, EXTERNAL SOURCES, and SPEC CHECKSUMS from a Podfile.lock."""
    sections: dict[str, list[str]] = {}
    current_section: str | None = None
    for line in lockfile_text.splitlines():
        sec_match = _TOP_SECTION_RE.match(line)
        if sec_match and not line.startswith(" "):
            current_section = sec_match.group(1).strip()
            sections[current_section] = []
            continue
        if current_section is not None:
            sections[current_section].append(line)

    pods: dict[str, dict[str, Any]] = {}
    for line in sections.get("PODS", []):
        m = _POD_BULLET_RE.match(line)
        if not m:
            continue
        full_name, version = m.group(1), m.group(2)
        root_name = full_name.split("/", 1)[0]
        rec = pods.setdefault(root_name, {"version": version, "subspecs": []})
        if "/" in full_name:
            sub = full_name.split("/", 1)[1]
            if sub not in rec["subspecs"]:
                rec["subspecs"].append(sub)

    external_sources: dict[str, dict[str, str]] = {}
    cur_pod: str | None = None
    for line in sections.get("EXTERNAL SOURCES", []):
        if re.match(r"^  [^ :][^:]*:\s*$", line):
            cur_pod = line.strip()[:-1].strip("'\"")
            external_sources[cur_pod] = {}
        elif cur_pod and re.match(r"^    :[^:]+:", line):
            stripped = line.strip()
            # e.g. ":path: ../node_modules/react-native"
            key_end = stripped.find(":", 1)
            k = stripped[:key_end].strip()
            v = stripped[key_end + 1 :].strip().strip("'\"")
            external_sources[cur_pod][k] = v

    spec_checksums: dict[str, str] = {}
    for line in sections.get("SPEC CHECKSUMS", []):
        if re.match(r"^  [^:]+:\s*[0-9a-fA-F]+\s*$", line):
            k, v = line.strip().split(":", 1)
            spec_checksums[k.strip().strip("'\"")] = v.strip()

    return pods, external_sources, spec_checksums


def _load_rn_facade_maps(rn_dir: Path) -> tuple[dict[str, str], set[str]]:
    """Parse FACADE_PODS mappings from React Native's cocoapods facade scripts."""
    podspec_map: dict[str, str] = {}
    synthesized: set[str] = set()
    cocoapods_dir = rn_dir / "scripts" / "cocoapods"
    for script_name in ("rncore_facades.rb", "rndeps_facades.rb"):
        script = cocoapods_dir / script_name
        if not script.is_file():
            continue
        text = script.read_text(encoding="utf-8", errors="replace")
        block_match = re.search(r"FACADE_PODS\s*=\s*\{([^}]+)\}", text, re.DOTALL)
        if not block_match:
            continue
        block = block_match.group(1)
        for m in re.finditer(r'["\']([^"\']+)["\']\s*=>\s*(?:["\']([^"\']+)["\']|:([a-zA-Z_]+))', block):
            pod_name, rel_podspec, sym = m.group(1), m.group(2), m.group(3)
            if rel_podspec:
                podspec_map[pod_name] = rel_podspec
            elif sym == "synthesized":
                synthesized.add(pod_name)
    return podspec_map, synthesized


def _find_enclosing_package_json(start_path: Path, stop_root: Path) -> dict[str, Any]:
    cur = start_path if start_path.is_dir() else start_path.parent
    while True:
        candidate = cur / "package.json"
        if candidate.is_file():
            try:
                return json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return {}
        if cur == stop_root or cur.parent == cur:
            break
        cur = cur.parent
    return {}


def _parse_podspec_licence(
    podspec_path: Path,
    repo_root: Path,
    rn_package_licence: str | None,
) -> tuple[str | None, str | None, str | None, bool]:
    """Return (raw_licence_type, licence_file_rel, homepage, is_private_unlicensed_local)."""
    text = podspec_path.read_text(encoding="utf-8", errors="replace")
    podspec_dir = podspec_path.parent

    if podspec_path.suffix == ".json":
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return None, None, None, False
        lic = data.get("license")
        homepage = data.get("homepage") if isinstance(data.get("homepage"), str) else None
        raw_type: str | None = None
        lic_file: str | None = None
        if isinstance(lic, str):
            raw_type = lic
        elif isinstance(lic, dict):
            raw_type = lic.get("type") if isinstance(lic.get("type"), str) else None
            lic_file = lic.get("file") if isinstance(lic.get("file"), str) else None
        lic_file_rel = _resolve_podspec_lic_file(podspec_dir, lic_file, repo_root)
        return raw_type, lic_file_rel, homepage, False

    homepage_match = re.search(r"\b(?:s|spec)\.homepage\s*=\s*['\"]([^'\"]+)['\"]", text)
    homepage = homepage_match.group(1) if homepage_match else None

    # Template placeholder in ReactAppDependencyProvider.podspec.template
    if "{react-native-licence}" in text and rn_package_licence:
        return rn_package_licence, None, homepage, False

    # package['license'] / package["license"]
    if re.search(r"\b(?:s|spec)\.license\s*=\s*package\[['\"]license['\"]\]", text):
        pkg_data = _find_enclosing_package_json(podspec_dir, repo_root)
        pkg_lic = _extract_legacy_npm_licence(pkg_data)
        lic_files = find_licence_files(podspec_dir)
        lic_rel = _rel_posix(lic_files[0], repo_root) if lic_files else None
        return pkg_lic, lic_rel, homepage or (pkg_data.get("homepage") if isinstance(pkg_data.get("homepage"), str) else None), False

    # Hash syntax: s.license = { :type => '...', :file => '...' } or { type: '...' }
    hash_match = re.search(r"\b(?:s|spec)\.license\s*=\s*\{([^}]+)\}", text, re.DOTALL)
    if hash_match:
        body = hash_match.group(1)
        type_match = re.search(r"(?::type\s*=>|type:)\s*['\"]([^'\"]+)['\"]", body)
        file_match = re.search(r"(?::file\s*=>|file:)\s*['\"]([^'\"]+)['\"]", body)
        raw_type = type_match.group(1) if type_match else None
        lic_file_rel = _resolve_podspec_lic_file(podspec_dir, file_match.group(1) if file_match else None, repo_root)
        is_private_local = False
        if raw_type and raw_type.upper() == "UNLICENSED" and _is_within(podspec_dir, repo_root) and "node_modules" not in podspec_path.parts:
            pkg_json = _find_enclosing_package_json(podspec_dir, repo_root)
            if pkg_json.get("private") is True and not find_licence_files(podspec_dir):
                is_private_local = True
        return raw_type, lic_file_rel, homepage, is_private_local

    # Direct string: s.license = 'MIT'
    str_match = re.search(r"\b(?:s|spec)\.license\s*=\s*['\"]([^'\"]+)['\"]", text)
    if str_match:
        raw_type = str_match.group(1)
        lic_files = find_licence_files(podspec_dir)
        lic_rel = _rel_posix(lic_files[0], repo_root) if lic_files else None
        return raw_type, lic_rel, homepage, False

    return None, None, homepage, False


def _resolve_podspec_lic_file(podspec_dir: Path, file_attr: str | None, repo_root: Path) -> str | None:
    if file_attr:
        candidate = (podspec_dir / file_attr).resolve()
        if candidate.is_file():
            return _rel_posix(candidate, repo_root)
    found = find_licence_files(podspec_dir)
    if found:
        return _rel_posix(found[0], repo_root)
    return None


def _locate_podspec_in_path(target: Path, pod_name: str) -> Path | None:
    if target.is_file():
        return target
    if not target.is_dir():
        return None
    for ext in (".podspec", ".podspec.json"):
        exact = target / f"{pod_name}{ext}"
        if exact.is_file():
            return exact
    podspecs = sorted(target.glob("*.podspec")) + sorted(target.glob("*.podspec.json"))
    if len(podspecs) == 1:
        return podspecs[0]
    return None


def inventory_cocoapods(repo_root: Path, policy: dict[str, Any]) -> list[dict[str, Any]]:
    """Inventory iOS CocoaPods locked in apps/mobile/ios/Podfile.lock."""
    lockfile = repo_root / "apps" / "mobile" / "ios" / "Podfile.lock"
    if not lockfile.is_file():
        return []

    pods, external_sources, spec_checksums = parse_podfile_lock(lockfile.read_text(encoding="utf-8"))
    ios_dir = lockfile.parent
    mobile_dir = ios_dir.parent
    rn_dir = mobile_dir / "node_modules" / "react-native"

    rn_package_licence: str | None = None
    rn_pkg_json = rn_dir / "package.json"
    if rn_pkg_json.is_file():
        try:
            rn_package_licence = _extract_legacy_npm_licence(json.loads(rn_pkg_json.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            rn_package_licence = None

    facade_map, synthesized_pods = _load_rn_facade_maps(rn_dir)

    # Map local file: dependencies from apps/mobile/package.json so local modules
    # resolve cleanly even before npm ci creates node_modules symlinks.
    local_module_map: dict[str, Path] = {}
    mobile_pkg_path = mobile_dir / "package.json"
    if mobile_pkg_path.is_file():
        try:
            mpkg = json.loads(mobile_pkg_path.read_text(encoding="utf-8"))
            for dep_name, spec in (mpkg.get("dependencies") or {}).items():
                if isinstance(spec, str) and spec.startswith("file:"):
                    local_module_map[dep_name] = (mobile_dir / spec[5:]).resolve()
        except (OSError, json.JSONDecodeError):
            pass

    verified_specs: dict[tuple[str, str, str], dict[str, Any]] = {}
    for entry in policy.get("verifiedCocoaPodsSpecs") or []:
        if all(isinstance(entry.get(k), str) and entry[k] for k in ("name", "version", "specChecksum", "licence")):
            verified_specs[(entry["name"], entry["version"], entry["specChecksum"])] = entry

    lockfile_rel = _rel_posix(lockfile, repo_root)
    items: list[dict[str, Any]] = []

    for pod_name in sorted(pods.keys()):
        version = pods[pod_name]["version"]
        subspecs = sorted(pods[pod_name]["subspecs"])
        ext = external_sources.get(pod_name, {})
        checksum = spec_checksums.get(pod_name, "")

        podspec_path: Path | None = None
        ext_ref = ext.get(":podspec") or ext.get(":path") or ""

        if ext_ref.startswith(("build/rncore-facades/", "build/rndeps-facades/")):
            mapped_rel = facade_map.get(pod_name)
            if mapped_rel:
                candidate = rn_dir / mapped_rel
                if candidate.is_file():
                    podspec_path = candidate
        elif ext_ref.startswith("build/generated/ios/"):
            template = rn_dir / "scripts" / "codegen" / "templates" / f"{pod_name}.podspec.template"
            if template.is_file():
                podspec_path = template
            else:
                local_gen = _locate_podspec_in_path(ios_dir / ext_ref, pod_name)
                if local_gen:
                    podspec_path = local_gen
        elif ext_ref:
            candidate_target = ios_dir / ext_ref
            if not candidate_target.exists() and "node_modules/" in ext_ref:
                pkg_suffix = ext_ref.split("node_modules/", 1)[1].strip("/")
                if pkg_suffix in local_module_map:
                    candidate_target = local_module_map[pkg_suffix]
            # Resolve symlinks so local modules under apps/mobile/modules/* are recognized as in-repo
            if candidate_target.exists():
                candidate_target = candidate_target.resolve()
            podspec_path = _locate_podspec_in_path(candidate_target, pod_name)

        resolved_lic = UNKNOWN
        evidence = lockfile_rel
        licence_file_rel: str | None = None
        licence_url: str | None = None
        homepage: str | None = None
        first_party = False

        if podspec_path is not None and podspec_path.is_file():
            raw_type, lic_rel, pod_homepage, is_private_local = _parse_podspec_licence(
                podspec_path, repo_root, rn_package_licence
            )
            homepage = pod_homepage
            licence_file_rel = lic_rel
            evidence = _rel_posix(podspec_path, repo_root)

            if is_private_local:
                first_party = True
                resolved_lic = FIRST_PARTY
            else:
                lic_text = ""
                if lic_rel:
                    lic_abs = repo_root / lic_rel
                    if lic_abs.is_file():
                        lic_text = lic_abs.read_text(encoding="utf-8", errors="replace")

                if lic_text and has_non_commercial_restriction(lic_text):
                    resolved_lic = NON_COMMERCIAL
                    evidence = lic_rel or evidence
                else:
                    norm_raw = normalize_expression(raw_type) if raw_type else UNKNOWN
                    # Check if raw_type is a non-SPDX label like "Apple Sample Code" or "Google"
                    if norm_raw != UNKNOWN and (
                        norm_raw in ("0BSD", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "BSL-1.0", "ISC", "MIT", "MPL-2.0", "Unlicense", "Zlib", NON_COMMERCIAL)
                        or is_gpl_family(norm_raw)
                        or " AND " in norm_raw
                        or " OR " in norm_raw
                        or norm_raw.startswith("LicenseRef-")
                    ):
                        resolved_lic = norm_raw
                    elif lic_text:
                        classified = classify_licence_text(lic_text)
                        if classified != UNKNOWN:
                            resolved_lic = classified
                            evidence = lic_rel or evidence

        # Fall back to exact checksum-pinned verified CocoaPods spec when archive
        # files live outside node_modules (e.g., glog@0.3.5 or synthesized SocketRocket@0.7.1).
        if resolved_lic == UNKNOWN and (pod_name, version, checksum) in verified_specs:
            vspec = verified_specs[(pod_name, version, checksum)]
            resolved_lic = normalize_expression(vspec["licence"])
            homepage = homepage or vspec.get("homepage")
            licence_url = vspec.get("licenceUrl")
            evidence = f"policy.json:verifiedCocoaPodsSpecs:{pod_name}@{version}#{checksum[:12]}"

        # Inherit React Native root LICENSE file reference for React-* internal pods when none local
        if (
            not licence_file_rel
            and resolved_lic == "MIT"
            and podspec_path
            and _is_within(podspec_path, rn_dir)
            and ("third-party-podspecs" not in podspec_path.parts or pod_name == "ReactNativeDependencies")
        ):
            rn_lic_files = find_licence_files(rn_dir)
            if rn_lic_files:
                licence_file_rel = _rel_posix(rn_lic_files[0], repo_root)

        items.append(
            {
                "ecosystem": "cocoapods",
                "evidence": evidence,
                "firstParty": first_party,
                "homepage": homepage,
                "licence": resolved_lic,
                "licenceFile": licence_file_rel,
                "licenceUrl": licence_url,
                "lockfile": lockfile_rel,
                "name": pod_name,
                "production": True,
                "scope": "app",
                "specChecksum": checksum or None,
                "subspecs": subspecs,
                "synthesizedFacade": pod_name in synthesized_pods,
                "version": version,
            }
        )

    return items


# --- Python Requirements + Tool Folder Inventory ---

def _pep503_normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name.strip()).lower()


_REQ_NAME_RE = re.compile(r"^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[([^\]]+)\])?")


def _parse_req_spec(line: str) -> tuple[str, set[str], str | None] | None:
    """Parse a PEP 508 requirement string into (norm_name, extras, marker)."""
    marker: str | None = None
    if ";" in line:
        spec_part, marker_part = line.split(";", 1)
        marker = marker_part.strip()
    else:
        spec_part = line
    spec_part = spec_part.strip()
    if not spec_part or spec_part.startswith(("http://", "https://", "git+")):
        return None
    m = _REQ_NAME_RE.match(spec_part)
    if not m:
        return None
    name = _pep503_normalize(m.group(1))
    extras = {_pep503_normalize(e) for e in (m.group(2) or "").split(",") if e.strip()}
    return name, extras, marker


_PEP440_RE = re.compile(
    r"^v?"
    r"(?:(?P<epoch>\d+)!)?"
    r"(?P<release>\d+(?:\.\d+)*)"
    r"(?P<pre>[-_.]?(?P<pre_l>a|b|c|rc|alpha|beta|pre|preview)[-_.]?(?P<pre_n>\d*))?"
    r"(?P<post>(?:-(?P<post_n1>\d+))|(?:[-_.]?(?P<post_l>post|rev|r)[-_.]?(?P<post_n2>\d*)))?"
    r"(?P<dev>[-_.]?dev[-_.]?(?P<dev_n>\d*))?"
    r"(?:\+(?P<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?$",
    re.IGNORECASE,
)

_PRE_PHASE_RANK = {
    "a": 0,
    "alpha": 0,
    "b": 1,
    "beta": 1,
    "c": 2,
    "pre": 2,
    "preview": 2,
    "rc": 2,
}

_MARKER_TOKEN_RE = re.compile(
    r"""
    (?P<WS>\s+)
    | (?P<PAREN>[()])
    | (?P<NOT_IN>\bnot\s+in\b)
    | (?P<CMP>===|==|!=|<=|>=|~=|<>|<|>)
    | (?P<IN>\bin\b)
    | (?P<BOOL>\b(?:and|or|not)\b)
    | '(?P<SQ>[^']*)'
    | "(?P<DQ>[^"]*)"
    | (?P<IDENT>[A-Za-z_][A-Za-z0-9_.]*)
    """,
    re.VERBOSE,
)

_LEGACY_MARKER_ALIASES = {
    "os.name": "os_name",
    "platform.machine": "platform_machine",
    "platform.python_implementation": "platform_python_implementation",
    "platform.version": "platform_version",
    "python_implementation": "platform_python_implementation",
    "sys.platform": "sys_platform",
}


class _MarkerParseError(ValueError):
    """Raised when a PEP 508 environment marker cannot be parsed or resolved."""


def _format_full_version(info: Any) -> str:
    version = f"{info.major}.{info.minor}.{info.micro}"
    kind = getattr(info, "releaselevel", "final")
    if kind != "final":
        version += f"{kind[0]}{getattr(info, 'serial', 0)}"
    return version


def default_marker_environment() -> dict[str, str]:
    """Return the standard PEP 508 marker evaluation environment for the active runtime."""
    return {
        "implementation_name": sys.implementation.name,
        "implementation_version": _format_full_version(sys.implementation.version),
        "os_name": os.name,
        "platform_machine": platform.machine(),
        "platform_python_implementation": platform.python_implementation(),
        "platform_release": platform.release(),
        "platform_system": platform.system(),
        "platform_version": platform.version(),
        "python_full_version": platform.python_version(),
        "python_version": ".".join(platform.python_version_tuple()[:2]),
        "sys_platform": sys.platform,
    }


def _parse_pep440(raw: str) -> dict[str, Any] | None:
    m = _PEP440_RE.match(raw.strip())
    if not m:
        return None
    epoch = int(m.group("epoch") or 0)
    release_raw = tuple(int(p) for p in m.group("release").split("."))
    trimmed = list(release_raw)
    while len(trimmed) > 1 and trimmed[-1] == 0:
        trimmed.pop()
    release_norm = tuple(trimmed)

    has_pre = m.group("pre") is not None
    pre_rank = _PRE_PHASE_RANK[m.group("pre_l").lower()] if has_pre else 0
    pre_num = int(m.group("pre_n") or 0) if has_pre else 0

    has_post = m.group("post") is not None
    post_raw = m.group("post_n1") if m.group("post_n1") is not None else m.group("post_n2")
    post_num = int(post_raw or 0) if has_post else 0

    has_dev = m.group("dev") is not None
    dev_num = int(m.group("dev_n") or 0) if has_dev else 0

    local_raw = m.group("local")
    local_key: tuple[tuple[int, int | str], ...] = ()
    if local_raw:
        parts = re.split(r"[-_.]", local_raw.lower())
        local_key = tuple((1, int(p)) if p.isdigit() else (0, p) for p in parts)

    if not has_pre and not has_post and has_dev:
        phase = 0
        detail: tuple[int, ...] = (dev_num,)
    elif has_pre:
        phase = 1
        post_flag = 1 if has_post else (-1 if has_dev else 0)
        dev_after_post = -1 if (has_post and has_dev) else 0
        detail = (
            pre_rank,
            pre_num,
            post_flag,
            post_num if has_post else (dev_num if has_dev else 0),
            dev_after_post,
            dev_num if (has_post and has_dev) else 0,
        )
    elif not has_post:
        phase = 2
        detail = ()
    else:
        phase = 3
        detail = (post_num, -1 if has_dev else 0, dev_num if has_dev else 0)

    return {
        "dev": has_dev,
        "epoch": epoch,
        "key": (epoch, release_norm, phase, detail, (1, local_key) if local_key else (0, ())),
        "local": bool(local_raw),
        "post": has_post,
        "pre": has_pre,
        "release_raw": release_raw,
    }


def _pep440_compare(lhs_str: str, op: str, rhs_str: str) -> bool | None:
    if op in ("==", "!=") and rhs_str.strip().endswith(".*") and "+" not in rhs_str:
        lhs = _parse_pep440(lhs_str)
        rhs = _parse_pep440(rhs_str.strip()[:-2])
        if lhs is not None and rhs is not None and not rhs["pre"] and not rhs["post"] and not rhs["dev"]:
            prefix = rhs["release_raw"]
            padded = lhs["release_raw"] + (0,) * max(0, len(prefix) - len(lhs["release_raw"]))
            matched = lhs["epoch"] == rhs["epoch"] and padded[: len(prefix)] == prefix
            return matched if op == "==" else not matched

    lhs = _parse_pep440(lhs_str)
    rhs = _parse_pep440(rhs_str)
    if lhs is None or rhs is None:
        return None

    if op == "~=":
        if len(rhs["release_raw"]) < 2:
            return None
        prefix = rhs["release_raw"][:-1]
        padded = lhs["release_raw"] + (0,) * max(0, len(prefix) - len(lhs["release_raw"]))
        return lhs["key"] >= rhs["key"] and lhs["epoch"] == rhs["epoch"] and padded[: len(prefix)] == prefix

    lk, rk = lhs["key"], rhs["key"]
    if op == "==":
        return lk == rk
    if op == "!=":
        return lk != rk
    if op == "<":
        return lk < rk
    if op == "<=":
        return lk <= rk
    if op == ">":
        return lk > rk
    if op == ">=":
        return lk >= rk
    return None


def _tokenize_marker(marker: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    pos = 0
    while pos < len(marker):
        m = _MARKER_TOKEN_RE.match(marker, pos)
        if not m:
            raise _MarkerParseError(f"Unexpected marker syntax at {pos}: {marker!r}")
        pos = m.end()
        kind = m.lastgroup
        if kind == "WS":
            continue
        if kind == "PAREN":
            tokens.append(("PAREN", m.group("PAREN")))
        elif kind == "NOT_IN":
            tokens.append(("OP", "not in"))
        elif kind == "CMP":
            op = m.group("CMP")
            tokens.append(("OP", "!=" if op == "<>" else op))
        elif kind == "IN":
            tokens.append(("OP", "in"))
        elif kind == "BOOL":
            tokens.append(("BOOL", m.group("BOOL")))
        elif kind == "SQ":
            tokens.append(("STR", m.group("SQ")))
        elif kind == "DQ":
            tokens.append(("STR", m.group("DQ")))
        elif kind == "IDENT":
            ident = m.group("IDENT")
            tokens.append(("IDENT", _LEGACY_MARKER_ALIASES.get(ident, ident)))
    return tokens


def _eval_marker_comparison(
    lhs_tok: tuple[str, str],
    op: str,
    rhs_tok: tuple[str, str],
    env: dict[str, str],
) -> bool:
    def _resolve(tok: tuple[str, str]) -> str:
        kind, val = tok
        if kind == "STR":
            return val
        if val in env:
            return env[val]
        raise _MarkerParseError(f"Unknown marker variable: {val}")

    lhs_val = _resolve(lhs_tok)
    rhs_val = _resolve(rhs_tok)

    uses_extra = (lhs_tok == ("IDENT", "extra")) or (rhs_tok == ("IDENT", "extra"))
    if uses_extra:
        # Extra names compare in normalised form for every operator, including
        # membership and arbitrary equality (active extras are already normalised).
        lhs_norm = _pep503_normalize(lhs_val) if lhs_val.strip() else ""
        rhs_norm = _pep503_normalize(rhs_val) if rhs_val.strip() else ""
        if op == "===":
            return lhs_norm == rhs_norm
        if op == "in":
            return lhs_norm in rhs_norm
        if op == "not in":
            return lhs_norm not in rhs_norm
        if op == "==":
            return lhs_norm == rhs_norm
        if op == "!=":
            return lhs_norm != rhs_norm
        if op == "<":
            return lhs_norm < rhs_norm
        if op == "<=":
            return lhs_norm <= rhs_norm
        if op == ">":
            return lhs_norm > rhs_norm
        if op == ">=":
            return lhs_norm >= rhs_norm
        raise _MarkerParseError(f"Unsupported extra operator: {op}")

    if op == "===":
        return lhs_val == rhs_val
    if op == "in":
        return lhs_val in rhs_val
    if op == "not in":
        return lhs_val not in rhs_val

    pep440_res = _pep440_compare(lhs_val, op, rhs_val)
    if pep440_res is not None:
        return pep440_res

    if op == "==":
        return lhs_val == rhs_val
    if op == "!=":
        return lhs_val != rhs_val
    if op == "<":
        return lhs_val < rhs_val
    if op == "<=":
        return lhs_val <= rhs_val
    if op == ">":
        return lhs_val > rhs_val
    if op == ">=":
        return lhs_val >= rhs_val
    raise _MarkerParseError(f"Unsupported marker operator: {op}")


def _eval_marker_tokens(tokens: list[tuple[str, str]], env: dict[str, str]) -> bool:
    idx = 0

    def _parse_or() -> bool:
        nonlocal idx
        left = _parse_and()
        while idx < len(tokens) and tokens[idx] == ("BOOL", "or"):
            idx += 1
            right = _parse_and()
            left = left or right
        return left

    def _parse_and() -> bool:
        nonlocal idx
        left = _parse_not()
        while idx < len(tokens) and tokens[idx] == ("BOOL", "and"):
            idx += 1
            right = _parse_not()
            left = left and right
        return left

    def _parse_not() -> bool:
        nonlocal idx
        if idx < len(tokens) and tokens[idx] == ("BOOL", "not"):
            idx += 1
            return not _parse_not()
        return _parse_atom()

    def _parse_atom() -> bool:
        nonlocal idx
        if idx >= len(tokens):
            raise _MarkerParseError("Unexpected end of marker expression")
        if tokens[idx] == ("PAREN", "("):
            idx += 1
            val = _parse_or()
            if idx >= len(tokens) or tokens[idx] != ("PAREN", ")"):
                raise _MarkerParseError("Unclosed '(' in marker expression")
            idx += 1
            return val
        lhs = tokens[idx]
        if lhs[0] not in ("IDENT", "STR"):
            raise _MarkerParseError(f"Expected marker operand, got {lhs!r}")
        idx += 1
        if idx >= len(tokens) or tokens[idx][0] != "OP":
            raise _MarkerParseError("Expected comparison operator in marker expression")
        op = tokens[idx][1]
        idx += 1
        if idx >= len(tokens) or tokens[idx][0] not in ("IDENT", "STR"):
            raise _MarkerParseError("Expected right-hand marker operand")
        rhs = tokens[idx]
        idx += 1
        return _eval_marker_comparison(lhs, op, rhs, env)

    result = _parse_or()
    if idx != len(tokens):
        raise _MarkerParseError(f"Trailing tokens in marker expression: {tokens[idx:]!r}")
    return result


def _marker_allows(
    marker: str | None,
    active_extras: set[str],
    marker_env: dict[str, str] | None = None,
) -> bool:
    if not marker or not marker.strip():
        return True
    base_env = default_marker_environment()
    if marker_env:
        base_env.update(marker_env)
    try:
        tokens = _tokenize_marker(marker)
        if not tokens:
            return True
        contexts = [""] + sorted({_pep503_normalize(e) for e in active_extras if e and e.strip()})
        for extra_val in contexts:
            env = dict(base_env)
            env["extra"] = extra_val
            if _eval_marker_tokens(tokens, env):
                return True
        return False
    except _MarkerParseError:
        # Fail closed on malformed markers so disallowed dependencies cannot hide behind syntax quirks.
        return True


def _parse_requirements_txt(
    req_file: Path,
    visited: set[Path] | None = None,
    marker_env: dict[str, str] | None = None,
) -> list[tuple[str, set[str], str]]:
    if visited is None:
        visited = set()
    resolved_file = req_file.resolve()
    if resolved_file in visited or not req_file.is_file():
        return []
    visited.add(resolved_file)

    results: list[tuple[str, set[str], str]] = []
    logical_lines: list[str] = []
    buf = ""
    for raw_line in req_file.read_text(encoding="utf-8", errors="replace").splitlines():
        line = re.sub(r"(?:^|\s)#.*$", "", raw_line).rstrip()
        if line.endswith("\\"):
            buf += line[:-1].strip() + " "
            continue
        buf += line.strip()
        if buf:
            logical_lines.append(buf)
        buf = ""
    if buf:
        logical_lines.append(buf)

    for entry in logical_lines:
        tokens = entry.split()
        if not tokens:
            continue
        if tokens[0] in ("-r", "--requirement") and len(tokens) >= 2:
            nested = req_file.parent / tokens[1]
            results.extend(_parse_requirements_txt(nested, visited, marker_env=marker_env))
            continue
        if tokens[0].startswith("-"):
            continue
        cleaned = re.sub(r"--hash=\S+", "", entry).strip()
        parsed = _parse_req_spec(cleaned)
        if parsed and _marker_allows(parsed[2], set(), marker_env=marker_env):
            results.append((parsed[0], parsed[1], req_file.name))
    return results


def _collect_declared_tool_requirements(
    tool_dir: Path,
    marker_env: dict[str, str] | None = None,
) -> list[tuple[str, set[str], str]]:
    """Collect declared Python requirements from requirements*.txt, pyproject.toml, uv.lock, pylock.toml, Pipfile.lock."""
    declared: list[tuple[str, set[str], str]] = []

    for req_file in sorted(tool_dir.glob("requirements*.txt")):
        declared.extend(_parse_requirements_txt(req_file, marker_env=marker_env))

    pyproject = tool_dir / "pyproject.toml"
    if pyproject.is_file():
        try:
            pdata = tomllib.loads(pyproject.read_text(encoding="utf-8"))
            project = pdata.get("project") or {}
            for spec in project.get("dependencies") or []:
                if isinstance(spec, str):
                    parsed = _parse_req_spec(spec)
                    if parsed and _marker_allows(parsed[2], set(), marker_env=marker_env):
                        declared.append((parsed[0], parsed[1], "pyproject.toml"))
        except (OSError, tomllib.TOMLDecodeError):
            pass

    for lock_name in ("uv.lock", "pylock.toml"):
        tlock = tool_dir / lock_name
        if tlock.is_file():
            try:
                ldata = tomllib.loads(tlock.read_text(encoding="utf-8"))
                pkgs = ldata.get("package") or ldata.get("packages") or []
                if isinstance(pkgs, list):
                    for pkg in pkgs:
                        if isinstance(pkg, dict) and isinstance(pkg.get("name"), str):
                            declared.append((_pep503_normalize(pkg["name"]), set(), lock_name))
            except (OSError, tomllib.TOMLDecodeError):
                pass

    pipfile_lock = tool_dir / "Pipfile.lock"
    if pipfile_lock.is_file():
        try:
            pdata = json.loads(pipfile_lock.read_text(encoding="utf-8"))
            for section in ("default",):
                for pkg_name, pkg_meta in (pdata.get(section) or {}).items():
                    extras: set[str] = set()
                    markers: str | None = None
                    if isinstance(pkg_meta, dict):
                        raw_extras = pkg_meta.get("extras") or []
                        if isinstance(raw_extras, list):
                            extras = {_pep503_normalize(str(e)) for e in raw_extras if str(e).strip()}
                        if isinstance(pkg_meta.get("markers"), str):
                            markers = pkg_meta["markers"]
                    if _marker_allows(markers, set(), marker_env=marker_env):
                        declared.append((_pep503_normalize(pkg_name), extras, "Pipfile.lock"))
        except (OSError, json.JSONDecodeError):
            pass

    return declared


def _build_python_dist_index(python_paths: list[Path] | None = None) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    """Index installed Python distributions and top-level import packages."""
    dists = (
        importlib.metadata.distributions(path=[str(p) for p in python_paths])
        if python_paths is not None
        else importlib.metadata.distributions()
    )

    dist_index: dict[str, dict[str, Any]] = {}
    module_to_dist: dict[str, str] = {}

    for dist in dists:
        meta = dist.metadata
        raw_name = meta["Name"] if "Name" in meta else None
        if not raw_name:
            continue
        norm_name = _pep503_normalize(raw_name)
        if norm_name in dist_index:
            continue

        version = dist.version or "0.0.0"

        # Read embedded licence files from .dist-info / .egg-info to detect hidden NC clauses
        lic_texts: list[str] = []
        seen_lic_paths: set[str] = set()
        for f in dist.files or []:
            parts_lower = [p.lower() for p in f.parts]
            base_name = f.name
            if (
                ("dist-info" in "".join(parts_lower) or "egg-info" in "".join(parts_lower))
                and ("licenses" in parts_lower or _LICENCE_FILENAMES_RE.match(base_name))
            ):
                try:
                    resolved_key = str(Path(dist.locate_file(f)).resolve())
                except OSError:
                    resolved_key = str(f)
                if resolved_key in seen_lic_paths:
                    continue
                try:
                    content = dist.read_text(str(f))
                    if content:
                        seen_lic_paths.add(resolved_key)
                        lic_texts.append(content)
                except OSError:
                    pass

        dist_info_dir = getattr(dist, "_path", None)
        if dist_info_dir is not None:
            dist_path = Path(str(dist_info_dir))
            if dist_path.is_dir():
                for candidate in sorted(dist_path.rglob("*")):
                    if not candidate.is_file():
                        continue
                    rel_parts = [p.lower() for p in candidate.relative_to(dist_path).parts]
                    if "licenses" in rel_parts or _LICENCE_FILENAMES_RE.match(candidate.name):
                        try:
                            resolved_key = str(candidate.resolve())
                        except OSError:
                            resolved_key = str(candidate)
                        if resolved_key in seen_lic_paths:
                            continue
                        try:
                            content = candidate.read_text(encoding="utf-8", errors="replace")
                            if content:
                                seen_lic_paths.add(resolved_key)
                                lic_texts.append(content)
                        except OSError:
                            pass

        has_nc_text = any(has_non_commercial_restriction(t) for t in lic_texts)

        lic_expr = meta["License-Expression"] if "License-Expression" in meta else None
        raw_lic = meta["License"] if "License" in meta else None
        classifiers = meta.get_all("Classifier") or []

        resolved_lic = UNKNOWN
        if has_nc_text:
            resolved_lic = NON_COMMERCIAL
        elif lic_expr and lic_expr.strip():
            resolved_lic = normalize_expression(lic_expr)
        elif raw_lic and raw_lic.strip():
            stripped_lic = raw_lic.strip()
            if "\n" in stripped_lic or len(stripped_lic) > 120:
                resolved_lic = classify_licence_text(stripped_lic)
            else:
                resolved_lic = normalize_expression(stripped_lic)
                if resolved_lic == UNKNOWN:
                    resolved_lic = classify_licence_text(stripped_lic)
        if resolved_lic == UNKNOWN and classifiers:
            resolved_lic = normalize_classifier(classifiers)
        if resolved_lic == UNKNOWN and lic_texts:
            for lt in lic_texts:
                classified = classify_licence_text(lt)
                if classified != UNKNOWN:
                    resolved_lic = classified
                    break

        requires_dist: list[tuple[str, set[str], str | None]] = []
        for req_str in meta.get_all("Requires-Dist") or []:
            parsed = _parse_req_spec(req_str)
            if parsed:
                requires_dist.append(parsed)

        # Map importable top-level module names to this distribution
        top_level_txt = dist.read_text("top_level.txt")
        if top_level_txt:
            for mod in top_level_txt.splitlines():
                mod_clean = mod.strip().split("/")[0]
                if mod_clean:
                    module_to_dist.setdefault(mod_clean, norm_name)
        else:
            for f in dist.files or []:
                if not f.parts:
                    continue
                first = f.parts[0]
                if first.endswith((".dist-info", ".data")) or first.startswith(".."):
                    continue
                if first.endswith(".py"):
                    module_to_dist.setdefault(first[:-3], norm_name)
                elif len(f.parts) > 1:
                    module_to_dist.setdefault(first, norm_name)
            module_to_dist.setdefault(norm_name.replace("-", "_"), norm_name)

        dist_index[norm_name] = {
            "evidence": f"dist-info:{raw_name}-{version}",
            "licence": resolved_lic,
            "name": raw_name,
            "normName": norm_name,
            "requiresDist": requires_dist,
            "version": version,
        }

    return dist_index, module_to_dist


def _has_non_ignored_files(directory: Path) -> bool:
    for p in directory.rglob("*"):
        if any(part in ("__pycache__", ".build", "node_modules", ".venv", "venv") or part.startswith(".") for part in p.relative_to(directory).parts):
            continue
        if p.is_file():
            return True
    return False


_TOOL_ROOT_CODE_SUFFIXES = frozenset({".py", ".swift", ".sh", ".mjs", ".js", ".ts"})
_TOOL_ROOT_MANIFEST_NAMES = frozenset(
    {"Package.swift", "pyproject.toml", "package.json", "Pipfile.lock", "uv.lock", "pylock.toml"}
)


def discover_tool_folders(repo_root: Path) -> list[Path]:
    """Discover concrete tool folders under tools/ (including nested category folders like tools/templates/*)."""
    tools_root = repo_root / "tools"
    if not tools_root.is_dir():
        return []

    found: list[Path] = []

    def _walk(folder: Path) -> None:
        direct_files = [
            f
            for f in folder.iterdir()
            if f.is_file() and not f.name.startswith(".") and not f.name.endswith(".pyc")
        ]
        child_dirs = sorted(
            d
            for d in folder.iterdir()
            if d.is_dir() and not d.name.startswith(".") and d.name not in _IGNORED_TOOL_SUBDIRS
        )
        has_tool_root_file = any(
            f.suffix in _TOOL_ROOT_CODE_SUFFIXES
            or f.name in _TOOL_ROOT_MANIFEST_NAMES
            or f.name.startswith("requirements")
            or bool(_LICENCE_FILENAMES_RE.match(f.name))
            for f in direct_files
        )
        non_empty_children = [d for d in child_dirs if _has_non_ignored_files(d)]
        # Category/grouping folder (like tools/templates): has child tool folders and no root code/manifest/licence
        if not has_tool_root_file and non_empty_children:
            if direct_files:
                found.append(folder)
            for child in child_dirs:
                _walk(child)
            return
        if _has_non_ignored_files(folder):
            found.append(folder)

    for top in sorted(tools_root.iterdir()):
        if not top.is_dir() or top.name.startswith(".") or top.name in _IGNORED_TOOL_SUBDIRS:
            continue
        _walk(top)

    return sorted(found)


def _collect_local_tool_module_names(tools_root: Path) -> set[str]:
    names: set[str] = set()
    if not tools_root.is_dir():
        return names
    for py_file in tools_root.rglob("*.py"):
        if "__pycache__" in py_file.parts:
            continue
        names.add(py_file.stem)
        if py_file.name == "__init__.py":
            names.add(py_file.parent.name)
    return names


def inventory_tools(
    repo_root: Path,
    python_paths: list[Path] | None = None,
    marker_env: dict[str, str] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return (tool_folder_records, tool_python_requirement_records)."""
    tool_folders = discover_tool_folders(repo_root)
    dist_index, module_to_dist = _build_python_dist_index(python_paths)
    local_module_names = _collect_local_tool_module_names(repo_root / "tools")
    stdlib_names = set(sys.stdlib_module_names) | {"__future__"}

    tool_records: list[dict[str, Any]] = []
    python_records: list[dict[str, Any]] = []

    for folder in tool_folders:
        rel_folder = _rel_posix(folder, repo_root)
        descendant_tool_folders = [
            other for other in tool_folders if other != folder and _is_within(other, folder)
        ]

        # Gather source texts for SPDX header hints
        source_texts: list[str] = []
        py_files: list[Path] = []
        for f in sorted(folder.rglob("*")):
            if any(_is_within(f, desc) for desc in descendant_tool_folders):
                continue
            rel_parts = f.relative_to(folder).parts
            if any(part in ("__pycache__", ".build", "node_modules", ".venv", "venv") or part.startswith(".") for part in rel_parts):
                continue
            if not f.is_file():
                continue
            if f.suffix in (".py", ".swift", ".sh", ".mjs", ".js", ".ts"):
                try:
                    txt = f.read_text(encoding="utf-8", errors="replace")
                    source_texts.append(txt)
                except OSError:
                    pass
            if f.suffix == ".py" and "tests" not in rel_parts and "Tests" not in rel_parts:
                py_files.append(f)

        spdx_hints = extract_spdx_headers(source_texts)
        lic_files = find_licence_files(folder)
        if lic_files:
            lic_path = lic_files[0]
            lic_text = lic_path.read_text(encoding="utf-8", errors="replace")
            folder_lic = classify_licence_text(lic_text, spdx_hints=spdx_hints)
            lic_evidence = _rel_posix(lic_path, repo_root)
            lic_file_rel: str | None = lic_evidence
        else:
            folder_lic = UNKNOWN
            lic_evidence = f"{rel_folder} (missing LICENSE)"
            lic_file_rel = None

        tool_records.append(
            {
                "ecosystem": "tool",
                "evidence": lic_evidence,
                "firstParty": True,
                "licence": folder_lic,
                "licenceFile": lic_file_rel,
                "name": rel_folder,
                "scope": "server",
                "spdxHeaders": spdx_hints,
                "version": "workspace",
            }
        )

        # Declared Python requirements + transitive Requires-Dist closure,
        # revisiting distributions whenever new extras are accumulated.
        declared = _collect_declared_tool_requirements(folder, marker_env=marker_env)
        evaluated_extras: dict[str, set[str]] = {}
        recorded_by_norm: dict[str, dict[str, Any]] = {}
        queue: deque[tuple[str, set[str], str, bool]] = deque(
            (norm_name, extras, f"{rel_folder}/{src}", True)
            for norm_name, extras, src in declared
        )

        def _enqueue_requires_dist(
            dist_meta: dict[str, Any],
            active_extras: set[str],
            via_label: str,
        ) -> None:
            for child_norm, child_extras, child_marker in dist_meta["requiresDist"]:
                if not _marker_allows(child_marker, active_extras, marker_env=marker_env):
                    continue
                norm_child_extras = {_pep503_normalize(e) for e in child_extras if e and e.strip()}
                if child_norm not in evaluated_extras or not norm_child_extras.issubset(
                    evaluated_extras[child_norm]
                ):
                    queue.append(
                        (
                            child_norm,
                            norm_child_extras,
                            f"{via_label} -> {dist_meta['name']}@{dist_meta['version']}",
                            False,
                        )
                    )

        while queue:
            req_norm, req_extras, declared_in, is_direct = queue.popleft()
            norm_extras = {_pep503_normalize(e) for e in req_extras if e and e.strip()}

            if req_norm in evaluated_extras:
                if is_direct and req_norm in recorded_by_norm and not recorded_by_norm[req_norm]["direct"]:
                    recorded_by_norm[req_norm]["direct"] = True
                    recorded_by_norm[req_norm]["declaredIn"] = declared_in
                added_extras = norm_extras - evaluated_extras[req_norm]
                if not added_extras:
                    continue
                evaluated_extras[req_norm] |= added_extras
                dist_info = dist_index.get(req_norm)
                if dist_info is not None:
                    _enqueue_requires_dist(dist_info, evaluated_extras[req_norm], declared_in)
                continue

            evaluated_extras[req_norm] = set(norm_extras)
            dist_info = dist_index.get(req_norm)
            if dist_info is None:
                rec = {
                    "declared": True,
                    "declaredIn": declared_in,
                    "direct": is_direct,
                    "ecosystem": "python",
                    "evidence": f"{declared_in} (package '{req_norm}' not installed in Python metadata)",
                    "firstParty": False,
                    "licence": UNKNOWN,
                    "name": req_norm,
                    "scope": "server",
                    "toolFolder": rel_folder,
                    "version": "uninstalled",
                }
                python_records.append(rec)
                recorded_by_norm[req_norm] = rec
                continue

            rec = {
                "declared": True,
                "declaredIn": declared_in,
                "direct": is_direct,
                "ecosystem": "python",
                "evidence": dist_info["evidence"],
                "firstParty": False,
                "licence": dist_info["licence"],
                "name": dist_info["name"],
                "scope": "server",
                "toolFolder": rel_folder,
                "version": dist_info["version"],
            }
            python_records.append(rec)
            recorded_by_norm[req_norm] = rec
            _enqueue_requires_dist(dist_info, evaluated_extras[req_norm], declared_in)

        # AST import check on non-test .py files to detect undeclared third-party imports
        imported_modules: dict[str, str] = {}
        for py_file in py_files:
            try:
                tree = ast.parse(py_file.read_text(encoding="utf-8", errors="replace"))
            except SyntaxError:
                continue
            py_rel = _rel_posix(py_file, repo_root)
            file_mods: set[str] = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        file_mods.add(alias.name.split(".", 1)[0])
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    file_mods.add(node.module.split(".", 1)[0])

            file_uses_blender = bool(file_mods & _BLENDER_EMBEDDED_MODULES) or (
                py_file.name == "blender_tool.py" and is_gpl_family(folder_lic)
            )
            for top_mod in sorted(file_mods):
                # Headless Blender scripts receive numpy bundled inside the isolated Blender runtime
                if top_mod == "numpy" and file_uses_blender:
                    continue
                imported_modules.setdefault(top_mod, py_rel)

        for mod_name, py_rel in sorted(imported_modules.items()):
            if mod_name in stdlib_names or mod_name in local_module_names:
                continue
            if mod_name in _BLENDER_EMBEDDED_MODULES:
                continue

            mapped_dist = module_to_dist.get(mod_name) or _pep503_normalize(mod_name)
            if mapped_dist in evaluated_extras:
                continue
            evaluated_extras.setdefault(mapped_dist, set())

            dist_info = dist_index.get(mapped_dist)
            if dist_info is not None:
                python_records.append(
                    {
                        "declared": False,
                        "declaredIn": None,
                        "direct": True,
                        "ecosystem": "python",
                        "evidence": f"{py_rel} (undeclared import '{mod_name}'; resolved {dist_info['evidence']})",
                        "firstParty": False,
                        "importedModule": mod_name,
                        "licence": dist_info["licence"],
                        "name": dist_info["name"],
                        "scope": "server",
                        "toolFolder": rel_folder,
                        "version": dist_info["version"],
                    }
                )
            else:
                python_records.append(
                    {
                        "declared": False,
                        "declaredIn": None,
                        "direct": True,
                        "ecosystem": "python",
                        "evidence": f"{py_rel} (undeclared and uninstalled third-party import '{mod_name}')",
                        "firstParty": False,
                        "importedModule": mod_name,
                        "licence": UNKNOWN,
                        "name": mod_name,
                        "scope": "server",
                        "toolFolder": rel_folder,
                        "version": "undeclared",
                    }
                )

    python_records.sort(key=lambda r: (r["toolFolder"], r["name"], r["version"]))
    return tool_records, python_records


# --- Cross-Boundary Check: apps/ Importing or Bundling GPL tools/ ---

_PATH_LIKE_TOKEN_RE = re.compile(r"""['"`]([^'"`\n]*tools/[A-Za-z0-9_./-]+)['"`]|(tools/[A-Za-z0-9_./-]+)""")
_JS_IMPORT_RE = re.compile(
    r"""(?:import\s+(?:[^'"`]+?\s+from\s+)?|export\s+[^'"`]*?\s+from\s+|require\s*\(\s*|import\s*\(\s*)['"`]([^'"`\n]+)['"`]"""
)


def _collect_gpl_tool_aliases(repo_root: Path, gpl_tools: dict[str, str]) -> dict[str, tuple[str, str]]:
    """Map declared npm/Python package names of GPL tool folders -> (tool_folder, licence)."""
    aliases: dict[str, tuple[str, str]] = {}
    for folder_rel, lic in sorted(gpl_tools.items()):
        folder = repo_root / folder_rel
        pkg_json = folder / "package.json"
        if pkg_json.is_file():
            try:
                data = json.loads(pkg_json.read_text(encoding="utf-8"))
                if isinstance(data.get("name"), str) and data["name"].strip():
                    aliases[data["name"].strip()] = (folder_rel, lic)
            except (OSError, json.JSONDecodeError):
                pass
        pyproject = folder / "pyproject.toml"
        if pyproject.is_file():
            try:
                pdata = tomllib.loads(pyproject.read_text(encoding="utf-8"))
                proj_name = (pdata.get("project") or {}).get("name")
                if isinstance(proj_name, str) and proj_name.strip():
                    aliases[proj_name.strip()] = (folder_rel, lic)
                    aliases[proj_name.strip().replace("-", "_")] = (folder_rel, lic)
            except (OSError, tomllib.TOMLDecodeError):
                pass
        slug = Path(folder_rel).name.replace("-", "_")
        if slug:
            aliases.setdefault(f"tools.{slug}", (folder_rel, lic))
    return aliases


def detect_app_gpl_tool_imports(
    repo_root: Path,
    tool_records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Detect any file under apps/ that imports, references, or bundles a GPL/LGPL/AGPL tools/ folder."""
    apps_dir = repo_root / "apps"
    if not apps_dir.is_dir():
        return []

    gpl_tools = {
        rec["name"]: rec["licence"]
        for rec in tool_records
        if is_gpl_family(rec["licence"])
    }
    if not gpl_tools:
        return []

    aliases = _collect_gpl_tool_aliases(repo_root, gpl_tools)
    findings: list[dict[str, Any]] = []
    seen: set[tuple[str, int, str]] = set()

    for app_file in sorted(apps_dir.rglob("*")):
        rel_parts = app_file.relative_to(apps_dir).parts
        if any(part in _IGNORED_APP_DIRS for part in rel_parts):
            continue
        if not app_file.is_file():
            continue
        app_rel = _rel_posix(app_file, repo_root)
        if app_rel == "apps/mobile/THIRD_PARTY_NOTICES.md":
            continue
        if app_file.suffix.lower() not in _TEXT_SCAN_EXTENSIONS and app_file.name not in ("Podfile", "Gemfile"):
            continue

        try:
            text = app_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        for line_no, line in enumerate(text.splitlines(), start=1):
            for match in _PATH_LIKE_TOKEN_RE.finditer(line):
                raw_ref = match.group(1) or match.group(2) or ""
                idx = raw_ref.find("tools/")
                if idx < 0:
                    continue
                norm_ref = raw_ref[idx:].rstrip("/")
                for gpl_folder, gpl_lic in sorted(gpl_tools.items()):
                    if norm_ref == gpl_folder or norm_ref.startswith(gpl_folder + "/"):
                        key = (app_rel, line_no, gpl_folder)
                        if key not in seen:
                            seen.add(key)
                            findings.append(
                                {
                                    "appFile": app_rel,
                                    "line": line_no,
                                    "reference": raw_ref,
                                    "toolFolder": gpl_folder,
                                    "toolLicence": gpl_lic,
                                }
                            )

            if app_file.suffix.lower() in (".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"):
                for im in _JS_IMPORT_RE.finditer(line):
                    spec = im.group(1)
                    for alias_name, (gpl_folder, gpl_lic) in aliases.items():
                        if spec == alias_name or spec.startswith(alias_name + "/"):
                            key = (app_rel, line_no, gpl_folder)
                            if key not in seen:
                                seen.add(key)
                                findings.append(
                                    {
                                        "appFile": app_rel,
                                        "line": line_no,
                                        "reference": spec,
                                        "toolFolder": gpl_folder,
                                        "toolLicence": gpl_lic,
                                    }
                                )

        if app_file.suffix.lower() == ".py":
            try:
                tree = ast.parse(text)
            except SyntaxError:
                continue
            for node in ast.walk(tree):
                mod_candidates: list[tuple[int, str]] = []
                if isinstance(node, ast.Import):
                    for a in node.names:
                        mod_candidates.append((node.lineno, a.name))
                elif isinstance(node, ast.ImportFrom) and node.module:
                    mod_candidates.append((node.lineno, node.module))
                for lineno, mod_str in mod_candidates:
                    for alias_name, (gpl_folder, gpl_lic) in aliases.items():
                        if mod_str == alias_name or mod_str.startswith(alias_name + "."):
                            key = (app_rel, lineno, gpl_folder)
                            if key not in seen:
                                seen.add(key)
                                findings.append(
                                    {
                                        "appFile": app_rel,
                                        "line": lineno,
                                        "reference": mod_str,
                                        "toolFolder": gpl_folder,
                                        "toolLicence": gpl_lic,
                                    }
                                )

    findings.sort(key=lambda f: (f["appFile"], f["line"], f["toolFolder"]))
    return findings
