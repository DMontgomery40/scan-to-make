#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Deterministic THIRD_PARTY_NOTICES.md generator and freshness checker for apps/mobile."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any

from inventory import inventory_cocoapods, inventory_mobile_npm, inventory_workspace_npm
from spdx import FIRST_PARTY, UNKNOWN

_SPDX_URL_SAFE_RE = re.compile(r"^[A-Za-z0-9.\-+]+$")


def _spdx_url(licence_expr: str) -> str | None:
    if not licence_expr or licence_expr in (UNKNOWN, FIRST_PARTY, "NON-COMMERCIAL"):
        return None
    if licence_expr.startswith("LicenseRef-"):
        return None
    if _SPDX_URL_SAFE_RE.match(licence_expr):
        return f"https://spdx.org/licenses/{licence_expr}.html"
    return None


def _clean_repo_url(url: str | None) -> str | None:
    if not url:
        return None
    cleaned = url.strip()
    if cleaned.startswith("git+"):
        cleaned = cleaned[4:]
    if cleaned.startswith("git://github.com/"):
        cleaned = "https://github.com/" + cleaned[len("git://github.com/") :]
    if cleaned.startswith("ssh://git@github.com/"):
        cleaned = "https://github.com/" + cleaned[len("ssh://git@github.com/") :]
    if cleaned.endswith(".git"):
        cleaned = cleaned[:-4]
    if cleaned.startswith(("http://", "https://")):
        return cleaned
    return None


def _normalize_notice_text(raw: str) -> str:
    lines = [line.rstrip() for line in raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return "\n".join(lines).strip()


def _fence_for(text: str) -> str:
    longest = 3
    for match in re.finditer(r"~+", text):
        longest = max(longest, len(match.group(0)))
    return "~" * max(4, longest + 1)


def _escape_md_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ").strip()


def generate_third_party_notices(repo_root: Path, policy: dict[str, Any]) -> str:
    """Render deterministic Markdown notices for all third-party dependencies in apps/mobile."""
    mobile_npm = inventory_mobile_npm(repo_root)
    app_workspace_npm = [
        item
        for item in inventory_workspace_npm(repo_root)
        if item.get("scope") == "app" and item.get("production")
    ]
    cocoapods = inventory_cocoapods(repo_root, policy)

    # Register verbatim licence texts keyed by normalized SHA-256 prefix
    notice_texts: dict[str, str] = {}
    notice_packages: dict[str, list[str]] = {}

    def _register_licence_file(lic_rel: str | None, label: str) -> str | None:
        if not lic_rel:
            return None
        lic_path = repo_root / lic_rel
        if not lic_path.is_file():
            return None
        norm_text = _normalize_notice_text(lic_path.read_text(encoding="utf-8", errors="replace"))
        if not norm_text:
            return None
        digest = hashlib.sha256(norm_text.encode("utf-8")).hexdigest()[:12]
        notice_texts.setdefault(digest, norm_text)
        pkgs = notice_packages.setdefault(digest, [])
        if label not in pkgs:
            pkgs.append(label)
        return digest

    # 1. Embedded third-party local modules (e.g., Apple GuidedCaptureSample in modules/object-capture)
    embedded_rows: list[dict[str, str]] = []
    seen_embedded: set[tuple[str, str, str]] = set()
    # 2. External production npm dependencies deduplicated by (name, version)
    npm_by_key: dict[tuple[str, str], dict[str, Any]] = {}

    for item in mobile_npm + app_workspace_npm:
        if item.get("firstParty"):
            continue
        pkg_path = str(item.get("packagePath") or "")
        if not pkg_path.startswith("node_modules/"):
            emb_key = (item["name"], item["version"], pkg_path)
            if emb_key in seen_embedded:
                continue
            seen_embedded.add(emb_key)
            digest = _register_licence_file(item.get("licenceFile"), f"{item['name']}@{item['version']} (embedded module)")
            embedded_rows.append(
                {
                    "licence": item["licence"],
                    "location": pkg_path,
                    "name": item["name"],
                    "noticeRef": f"[#notice-{digest}](#notice-{digest})" if digest else (_spdx_url(item["licence"]) or "—"),
                    "version": item["version"],
                }
            )
            continue
        key = (item["name"], item["version"])
        if key not in npm_by_key:
            npm_by_key[key] = dict(item)
        else:
            existing = npm_by_key[key]
            for field in ("licenceFile", "repositoryUrl", "homepage", "resolvedUrl"):
                if not existing.get(field) and item.get(field):
                    existing[field] = item[field]
            if existing.get("licence") == UNKNOWN and item.get("licence") not in (None, UNKNOWN):
                existing["licence"] = item["licence"]

    # 3. Third-party CocoaPods from Podfile.lock
    pod_rows: list[dict[str, str]] = []
    for pod in cocoapods:
        if pod.get("firstParty"):
            continue
        label = f"pod:{pod['name']}@{pod['version']}"
        digest = _register_licence_file(pod.get("licenceFile"), label)
        source_url = _clean_repo_url(pod.get("homepage")) or pod.get("licenceUrl") or _spdx_url(pod["licence"]) or "—"
        if digest:
            notice_cell = f"[#notice-{digest}](#notice-{digest})"
        elif pod.get("licenceUrl"):
            notice_cell = f"[Upstream licence]({pod['licenceUrl']})"
        elif _spdx_url(pod["licence"]):
            notice_cell = f"[SPDX {pod['licence']}]({_spdx_url(pod['licence'])})"
        else:
            notice_cell = "—"

        pod_rows.append(
            {
                "licence": pod["licence"],
                "name": pod["name"],
                "noticeRef": notice_cell,
                "source": f"[{source_url}]({source_url})" if source_url.startswith("http") else source_url,
                "version": pod["version"],
            }
        )

    npm_rows: list[dict[str, str]] = []
    for (name, version), item in sorted(npm_by_key.items()):
        label = f"npm:{name}@{version}"
        digest = _register_licence_file(item.get("licenceFile"), label)
        src_url = (
            _clean_repo_url(item.get("repositoryUrl"))
            or _clean_repo_url(item.get("homepage"))
            or _clean_repo_url(item.get("resolvedUrl"))
            or "—"
        )
        if digest:
            notice_cell = f"[#notice-{digest}](#notice-{digest})"
        elif _spdx_url(item["licence"]):
            notice_cell = f"[SPDX {item['licence']}]({_spdx_url(item['licence'])})"
        else:
            notice_cell = "—"

        npm_rows.append(
            {
                "licence": item["licence"],
                "name": name,
                "noticeRef": notice_cell,
                "source": f"[{src_url}]({src_url})" if src_url.startswith("http") else src_url,
                "version": version,
            }
        )

    out: list[str] = [
        "# Third-Party Notices (`apps/mobile`)",
        "",
        "This file lists third-party software packages and native pods resolved from",
        "`apps/mobile/package-lock.json` (production dependency closure), linked workspace",
        "package lockfiles, and `apps/mobile/ios/Podfile.lock`.",
        "",
        "- Regenerate: `python3 tools/licence-audit/audit.py notices --write`",
        "- Verify freshness: `python3 tools/licence-audit/audit.py notices --check`",
        "",
    ]

    if embedded_rows:
        out.extend(
            [
                "## Embedded Third-Party Modules",
                "",
                "| Module | Version | Licence | Path | Notice |",
                "| --- | --- | --- | --- | --- |",
            ]
        )
        for row in sorted(embedded_rows, key=lambda r: (r["name"], r["version"])):
            out.append(
                f"| `{_escape_md_cell(row['name'])}` | `{_escape_md_cell(row['version'])}` "
                f"| `{_escape_md_cell(row['licence'])}` | `{_escape_md_cell(row['location'])}` | {row['noticeRef']} |"
            )
        out.append("")

    out.extend(
        [
            "## iOS CocoaPods (`apps/mobile/ios/Podfile.lock`)",
            "",
            "| Pod | Version | Licence | Source | Notice |",
            "| --- | --- | --- | --- | --- |",
        ]
    )
    if pod_rows:
        for row in sorted(pod_rows, key=lambda r: (r["name"].lower(), r["name"], r["version"])):
            out.append(
                f"| `{_escape_md_cell(row['name'])}` | `{_escape_md_cell(row['version'])}` "
                f"| `{_escape_md_cell(row['licence'])}` | {row['source']} | {row['noticeRef']} |"
            )
    else:
        out.append("| _None_ | — | — | — | — |")
    out.append("")

    out.extend(
        [
            "## Production npm Packages (`apps/mobile/package-lock.json`)",
            "",
            "| Package | Version | Licence | Source | Notice |",
            "| --- | --- | --- | --- | --- |",
        ]
    )
    if npm_rows:
        for row in sorted(npm_rows, key=lambda r: (r["name"].lower(), r["name"], r["version"])):
            out.append(
                f"| `{_escape_md_cell(row['name'])}` | `{_escape_md_cell(row['version'])}` "
                f"| `{_escape_md_cell(row['licence'])}` | {row['source']} | {row['noticeRef']} |"
            )
    else:
        out.append("| _None_ | — | — | — | — |")
    out.append("")

    out.extend(
        [
            "## Verbatim Licence Texts",
            "",
        ]
    )
    if notice_texts:
        for digest in sorted(notice_texts.keys()):
            text = notice_texts[digest]
            applies_to = ", ".join(f"`{p}`" for p in sorted(notice_packages.get(digest, [])))
            fence = _fence_for(text)
            out.append(f'<a id="notice-{digest}"></a>')
            out.append(f"### Notice `{digest}`")
            out.append("")
            out.append(f"Applies to: {applies_to}")
            out.append("")
            out.append(f"{fence}text")
            out.append(text)
            out.append(fence)
            out.append("")
    else:
        out.append("_No local third-party licence text files found._")
        out.append("")

    return "\n".join(out).rstrip() + "\n"


def run_notices_cli(
    repo_root: Path,
    policy_path: Path,
    out_path: Path,
    check_only: bool,
) -> int:
    if not policy_path.is_file():
        print(f"error: policy file not found: {policy_path}", file=sys.stderr)
        return 2
    try:
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: failed to load policy JSON: {exc}", file=sys.stderr)
        return 2

    expected = generate_third_party_notices(repo_root, policy)

    if check_only:
        if not out_path.is_file():
            print(
                f"error: third-party notices file is missing: {out_path}\n"
                "Run `python3 tools/licence-audit/audit.py notices --write` to generate it.",
                file=sys.stderr,
            )
            return 1
        actual = out_path.read_text(encoding="utf-8", errors="replace")
        if actual != expected:
            diff_lines = list(
                difflib.unified_diff(
                    actual.splitlines(),
                    expected.splitlines(),
                    fromfile=str(out_path),
                    tofile=f"{out_path} (expected)",
                    lineterm="",
                    n=2,
                )
            )
            preview = "\n".join(diff_lines[:60])
            print(
                f"error: {out_path} is stale relative to current lockfiles.\n"
                "Run `python3 tools/licence-audit/audit.py notices --write` to update it.\n"
                f"{preview}",
                file=sys.stderr,
            )
            return 1
        return 0

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(expected, encoding="utf-8")
    return 0


def build_arg_parser() -> argparse.ArgumentParser:
    default_repo = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="Generate or verify apps/mobile/THIRD_PARTY_NOTICES.md.")
    parser.add_argument("--repo-root", type=Path, default=default_repo, help="Repository root path.")
    parser.add_argument(
        "--policy",
        type=Path,
        default=None,
        help="Path to policy.json (defaults to <repo-root>/tools/licence-audit/policy.json).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Target notices file (defaults to <repo-root>/apps/mobile/THIRD_PARTY_NOTICES.md).",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="Write THIRD_PARTY_NOTICES.md (default).")
    mode.add_argument("--check", action="store_true", help="Fail if THIRD_PARTY_NOTICES.md is missing or stale.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    repo_root = args.repo_root.resolve()
    policy_path = (args.policy or (repo_root / "tools" / "licence-audit" / "policy.json")).resolve()
    out_path = (args.out or (repo_root / "apps" / "mobile" / "THIRD_PARTY_NOTICES.md")).resolve()
    return run_notices_cli(
        repo_root=repo_root,
        policy_path=policy_path,
        out_path=out_path,
        check_only=bool(args.check),
    )


if __name__ == "__main__":
    sys.exit(main())
