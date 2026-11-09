#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Inventory and verify the Mac distribution, including its actual runtime payload.

The app's GPL boundary is unchanged. GPL workers and Blender are external installs;
this module adds checks rather than exemptions to detect bundled/downloaded code.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
import sys

from inventory import inventory_workspace_npm
from spdx import classify_licence_text, evaluate_expression, normalize_expression

MANIFEST = Path("apps/mac/distribution.json")
NOTICES = Path("apps/mac/THIRD_PARTY_NOTICES.md")
# Third-party source adapted into the helper (not a package: it is compiled in as first-party code, so its licence
# notice must travel with the source and the app's notices).
EARCUT = dict(name="earcut", licence="ISC", sourceUrl="https://github.com/mapbox/earcut",
    licenceUrl="https://raw.githubusercontent.com/mapbox/earcut/main/LICENSE",
    revision="934e54d8bed85387330b7acaa5d2f5ba30a460a3",
    licencePath="tools/mac-reconstruct/Licenses/earcut.txt",
    sha256="0b348fff56384b43dbb37593906904e56d0f9deb51eae590d4dc6d427fbf1808",
    noticePath="tools/mac-reconstruct/THIRD_PARTY.md",
    files=["tools/mac-reconstruct/Sources/HandheldKit/Cap.swift"],
    adapted="The polygon-with-holes ear clipping that closes a cut scan's bottom (earcut's linked-list polygon, "
            "hole bridging, ear test and fallback passes), ported from JavaScript to Swift.")
RECONSTRUCTION_HELPER = dict(name="mac-reconstruct", path="bin/mac-reconstruct",
    sourcePath="tools/mac-reconstruct", licence="MIT", licencePath="tools/mac-reconstruct/LICENSE",
    adaptedCode=[EARCUT])


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_manifest(root: Path) -> dict:
    return json.loads((root / MANIFEST).read_text())


def first_party_executables(root: Path, manifest: dict) -> list[dict]:
    helpers = manifest.get("firstPartyExecutables")
    if helpers != [RECONSTRUCTION_HELPER]:
        raise ValueError("Unapproved first-party executable manifest")
    for helper in helpers:
        if helper["sourcePath"] not in manifest["sourcePaths"]:
            raise ValueError("First-party executable source is absent from the payload manifest")
        if classify_licence_text((root / helper["licencePath"]).read_text()) != helper["licence"]:
            raise ValueError("First-party executable source licence differs from its declaration")
        for code in helper.get("adaptedCode", []):
            adapted_code_notice(root, code)
    return helpers


def adapted_code_notice(root: Path, code: dict) -> str:
    """The retained licence of third-party code adapted into a helper, checked to travel with every copy."""
    path = root / code["licencePath"]
    if sha256(path) != code["sha256"]:
        raise ValueError(f"{code['name']}: adapted code licence text differs from its retained checksum")
    text = path.read_text().strip()
    if classify_licence_text(text) != code["licence"]:
        raise ValueError(f"{code['name']}: adapted code licence differs from its declaration")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for file in [code["noticePath"], *code["files"]]:
        body = " ".join(line.strip().lstrip("/").strip() for line in (root / file).read_text().splitlines())
        if not all(line in body for line in lines):
            raise ValueError(f"{code['name']}: licence notice missing from {file}")
    return text


def inventory_mac(root: Path, workspace: list[dict]) -> tuple[list[dict], list[dict]]:
    if not (root / "apps/mac").is_dir():
        return [], []
    records, violations = [], []

    def fail(message: str, name: str = "distribution") -> None:
        violations.append(dict(code="invalid-mac-distribution", ecosystem="mac", scope="mac",
                               name=name, version="", licence="UNKNOWN", evidence=str(MANIFEST), message=message))

    try:
        manifest = load_manifest(root)
        if manifest.get("schemaVersion") != 1:
            raise ValueError("Unsupported Mac distribution schema")
        components = manifest["components"]
        names = [c["name"] for c in components]
        if sorted(names) != ["CPython standalone", "Node.js", "OpenUSD", "Pillow", "Sparkle"]:
            raise ValueError("Mac distribution must declare each runtime and framework exactly once")
        for component in components:
            name = component["name"]
            if not component.get("version") or not component.get("sourceUrl", "").startswith("https://"):
                raise ValueError(f"{name}: version and HTTPS source URL required")
            if name != "Sparkle":
                if not component.get("downloadUrl", "").startswith("https://") or not re.fullmatch(r"[0-9a-f]{64}", component.get("sha256", "")):
                    raise ValueError(f"{name}: pinned HTTPS download and SHA-256 required")
            if not component.get("notices"):
                raise ValueError(f"{name}: retained licence text required")
            for notice in component["notices"]:
                path = root / "apps/mac" / notice["path"]
                if not path.resolve().is_relative_to((root / "apps/mac/Licenses").resolve()):
                    raise ValueError(f"{name}: notice must be inside Licenses")
                if not notice.get("sourceUrl", "").startswith("https://") or sha256(path) != notice["sha256"]:
                    raise ValueError(f"{name}: licence text/source missing or checksum differs")
            records.append(dict(ecosystem="mac", name=name, version=component["version"], scope="mac",
                                licence=normalize_expression(component["licence"]), sourceUrl=component["sourceUrl"],
                                evidence=str(MANIFEST), notices=component["notices"]))
        for helper in first_party_executables(root, manifest):
            records.append(dict(ecosystem="mac", name=helper["name"], version="source", scope="mac",
                                licence=helper["licence"], firstParty=True,
                                evidence=helper["licencePath"], sourceUrl=helper["sourcePath"]))
            for code in helper.get("adaptedCode", []):
                records.append(dict(ecosystem="mac", name=f"{code['name']} (adapted in {helper['name']})",
                                    version=code["revision"], scope="mac", licence=normalize_expression(code["licence"]),
                                    evidence=code["licencePath"], sourceUrl=code["sourceUrl"]))
        sparkle = next(c for c in components if c["name"] == "Sparkle")
        lock = json.loads((root / "apps/mac/ScanToMake.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved").read_text())
        if len(lock["pins"]) != 1 or lock["pins"][0]["identity"] != "sparkle" or lock["pins"][0]["state"] != dict(version=sparkle["version"], revision=sparkle["revision"]):
            raise ValueError("Swift package lock differs from audited Sparkle distribution")
        packages = manifest["npmPackages"]
        if packages != ["packages/contracts", "services/project", "services/printer-handoff", "services/companion"]:
            raise ValueError("Unexpected Mac npm workspace set")
        for item in workspace:
            if item.get("production") and not item.get("firstParty") and item["lockfile"] in {p + "/package-lock.json" for p in packages}:
                record = dict(item, scope="mac")
                records.append(record)
                if not item.get("licenceFile") or not (root / item["licenceFile"]).is_file():
                    fail("Production npm dependency has no retained licence text; install the lockfiles before auditing", item["name"])
                if not (item.get("repositoryUrl") or item.get("resolvedUrl")):
                    fail("Production npm dependency has no source URL", item["name"])
        expected = render_notices(root, manifest, records)
        if not (root / NOTICES).is_file() or (root / NOTICES).read_text() != expected:
            fail("Mac THIRD_PARTY_NOTICES.md is missing or stale; run mac_distribution.py --write-notices")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        fail(str(exc))
    return records, violations


def render_notices(root: Path, manifest: dict, records: list[dict]) -> str:
    lines = ["# Scan to Make for Mac — third-party notices", "",
             "Generated by `tools/licence-audit/mac_distribution.py`. Full licence texts are retained in",
             "the adjacent `Licenses` directory and in this document; both ship in Contents/Resources.", "",
             "Node and Python execute as separate companion processes. The scan cleanup workers,",
             "pillow-heif and Blender are **not bundled or downloaded** by this app. An independently",
             "installed, unmodified Blender may be invoked by independently installed workers, as a",
             "separate CLI process (PRD L06). No GPL worker is imported into the Swift application.", "",
             "Pillow's complete wheel notice includes its native dependencies. The FreeType License",
             "option is selected. This software is based in part on the work of the FreeType Team.",
             "This software is based in part on the work of the Independent JPEG Group.",
             "OpenUSD's complete wheel notice includes the Tomorrow Open Source Technology License 1.0",
             "and its bundled third-party notices. Node's complete upstream licence includes its dependencies.", "",
             "| Component | Version | Licence | Source |", "|---|---|---|---|"]
    for c in manifest["components"]:
        lines.append(f"| {c['name']} | {c['version']} | {c['licence']} | {c['sourceUrl']} |")
    for c in manifest["components"]:
        lines += ["", f"## {c['name']}", "", c["role"], ""]
        if c.get("licenceDetails"):
            lines += [c["licenceDetails"], ""]
        for n in c["notices"]:
            lines.append(f"- [{n['path']}]({n['path']}) — [upstream]({n['sourceUrl']}), SHA-256 `{n['sha256']}`.")
        if c.get("noticeArchiveUrl"):
            lines += ["", f"Python library notices were extracted from the [matching full distribution]({c['noticeArchiveUrl']})",
                      f"(SHA-256 `{c['noticeArchiveSha256']}`)."]
    for helper in manifest.get("firstPartyExecutables", []):
        lines += ["", f"## Bundled first-party executable: {helper['name']}", "",
                  f"Built from `{helper['sourcePath']}` in the same source archive as the companion.",
                  f"Licence: {helper['licence']}. The source and licence ship in `Payload/source/{helper['sourcePath']}`.",
                  "Uses Apple's system frameworks; no third-party Swift package is bundled with this helper."
                  + (" It contains source code adapted from the third-party code listed below." if helper.get("adaptedCode") else ""),
                  "", "~~~~", (root / helper['licencePath']).read_text().strip(), "~~~~"]
        for code in helper.get("adaptedCode", []):
            lines += ["", f"### Adapted third-party code in {helper['name']}: {code['name']}", "",
                      f"Licence: {code['licence']}. Source: {code['sourceUrl']} (licence text from {code['licenceUrl']},",
                      f"revision `{code['revision']}`).", code["adapted"],
                      "Adapted in " + ", ".join(f"`{f}`" for f in code["files"]) + f"; notice also in `{code['noticePath']}`.",
                      "", "~~~~", (root / code['licencePath']).read_text().strip(), "~~~~"]
    lines += ["", "## Companion npm production dependencies", "",
              "Development dependencies, npm itself, pip and ensurepip are not shipped.", ""]
    seen = set()
    for item in sorted(records, key=lambda i: (i["name"], i["version"])):
        if item["ecosystem"] != "npm" or (item["name"], item["version"]) in seen:
            continue
        seen.add((item["name"], item["version"]))
        source = item.get("repositoryUrl") or item.get("resolvedUrl")
        lines += [f"### {item['name']} {item['version']}", "", f"Licence: {item['licence']}. Source: {source}", "", "~~~~"]
        path = item.get("licenceFile")
        lines += [(root / path).read_text(errors="replace").strip() if path and (root / path).is_file() else "MISSING LICENCE TEXT", "~~~~", ""]
    return "\n".join(lines).rstrip() + "\n"


def verify_payload(root: Path, payload: Path) -> None:
    """Fail closed on stale/extra worker trees, wheels, or package-manager payloads."""
    manifest = load_manifest(root)
    helpers = first_party_executables(root, manifest)
    policy = json.loads((root / "tools/licence-audit/policy.json").read_text())
    allow, denied = set(policy["allowlists"]["mac"]), set(policy["denied"]["mac"])
    expected_tools = {Path(p).name for p in manifest["sourcePaths"] if p.startswith("tools/")}
    actual_tools = {p.name for p in (payload / "source/tools").iterdir()}
    if actual_tools != expected_tools:
        raise ValueError("Payload tool folders differ from audited source manifest")
    if {p.name for p in payload.iterdir()} != {"node", "python", "source", "bin", "BUILD-ID"}:
        raise ValueError("Unapproved top-level runtime payload")
    identity = payload / "BUILD-ID"
    if identity.is_symlink() or not identity.is_file() or not re.fullmatch(r"mac-[0-9a-f]{64}\n", identity.read_text()):
        raise ValueError("Invalid payload BUILD-ID")
    binary_directory = payload / "bin"
    if binary_directory.is_symlink() or {p.name for p in binary_directory.iterdir()} != {"mac-reconstruct"}:
        raise ValueError("Unapproved first-party executable directory")
    for helper in helpers:
        binary = payload / helper["path"]
        if binary.is_symlink() or not binary.is_file() or not binary.stat().st_mode & 0o111:
            raise ValueError("Missing or invalid first-party executable: " + helper["name"])
        with binary.open("rb") as stream:
            magic = stream.read(4)
        if magic not in [b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca']:
            raise ValueError("First-party executable is not a Mach-O binary: " + helper["name"])
        if sha256(payload / "source" / helper["licencePath"]) != sha256(root / helper["licencePath"]):
            raise ValueError("First-party executable source licence differs from retained licence")
        for code in helper.get("adaptedCode", []):
            adapted_code_notice(payload / "source", code)
    # Superset upstream notices mention these source/build-only licences; their
    # code is not in the approved binary distributions and is never allowlisted.
    if any(p.name in {"jsonchecker", "aclocal.m4", "config.guess"} for p in payload.rglob("*")):
        raise ValueError("Unapproved source/build-only component in runtime payload")
    for path in ["node/lib/node_modules", "python/lib/python3.12/ensurepip"]:
        if (payload / path).exists():
            raise ValueError(f"Unapproved package-manager payload: {path}")
    expected_wheels = {c["pythonPackage"].replace("-", "_"): c for c in manifest["components"] if "pythonPackage" in c}
    site = payload / "python/lib/python3.12/site-packages"
    allowed_roots = {"README.txt"} | {p for c in expected_wheels.values() for p in c["pythonPaths"]}
    if any(p.name not in allowed_roots for p in site.iterdir()):
        raise ValueError("Unapproved bundled Python package directory or file")
    actual_wheels = {}
    for dist in importlib.metadata.distributions(path=[str(site)]):
        name = dist.metadata["Name"].lower().replace("-", "_")
        actual_wheels[name] = dist.version
        if name not in expected_wheels or dist.version != expected_wheels[name]["version"]:
            raise ValueError(f"Unapproved bundled Python distribution: {name}@{dist.version}")
        expected_notice = expected_wheels[name]["notices"][0]["sha256"]
        if not any(sha256(p) == expected_notice for p in Path(dist._path).rglob("*") if p.is_file() and p.name.startswith("LICENSE")):
            raise ValueError(f"Wheel licence differs from retained notice: {name}")
    if set(actual_wheels) != set(expected_wheels):
        raise ValueError("Missing approved Python wheel")
    for component in manifest["components"]:
        if component.get("runtimeNoticePath"):
            notice = next(n for n in component["notices"] if n["path"] == component["runtimeNotice"])
            if sha256(payload / component["runtimeNoticePath"]) != notice["sha256"]:
                raise ValueError(component["name"] + " licence differs from retained notice")
    # Inventory the real pruned node_modules, not just the source lockfiles.
    expected_npm = {(i["name"], i["version"]) for i in inventory_workspace_npm(payload / "source") if i.get("production") and not i.get("firstParty")}
    for directory in (payload / "source").glob("**/node_modules"):
        for package in directory.glob("**/package.json"):
            if "node_modules" not in package.parts or package.parent.is_symlink():
                continue
            # Only package roots, not examples/test fixtures shipped inside a package.
            if package.parent.parent.name != "node_modules" and not (package.parent.parent.name.startswith("@") and package.parent.parent.parent.name == "node_modules"):
                continue
            metadata = json.loads(package.read_text())
            if metadata.get("name", "").startswith("@scan-to-make/"):
                continue
            if (metadata.get("name"), metadata.get("version")) not in expected_npm:
                raise ValueError(f"Unapproved bundled npm package: {metadata.get('name')}")
            allowed, _ = evaluate_expression(normalize_expression(metadata.get("license")), allow, denied)
            if not allowed:
                raise ValueError(f"Disallowed bundled npm licence: {metadata.get('name')}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--write-notices", action="store_true")
    parser.add_argument("--payload", type=Path)
    args = parser.parse_args()
    root = args.repo_root.resolve()
    workspace_root = args.payload / "source" if args.payload else root
    workspace = inventory_workspace_npm(workspace_root)
    if args.payload:
        for item in workspace:
            if item.get("licenceFile"):
                item["licenceFile"] = str((workspace_root / item["licenceFile"]).resolve())
    records, violations = inventory_mac(root, workspace)
    if args.write_notices:
        (root / NOTICES).write_text(render_notices(root, load_manifest(root), records))
        records, violations = inventory_mac(root, workspace)
    if args.payload:
        try:
            verify_payload(root, args.payload)
        except (OSError, ValueError, KeyError) as exc:
            violations.append({"message": str(exc)})
    for item in records:
        policy = json.loads((root / "tools/licence-audit/policy.json").read_text())
        if not evaluate_expression(item["licence"], set(policy["allowlists"]["mac"]), set(policy["denied"]["mac"]))[0]:
            violations.append({"message": f"Disallowed Mac component: {item['name']} ({item['licence']})"})
    for violation in violations:
        print(violation["message"], file=sys.stderr)
    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main())
