#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Automated licence allowlist audit and third-party notices CLI."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any

# Ensure sibling modules in tools/licence-audit resolve regardless of CWD
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from inventory import (  # noqa: E402
    detect_app_gpl_tool_imports,
    inventory_cocoapods,
    inventory_mobile_npm,
    inventory_tools,
    inventory_workspace_npm,
)
from notices import run_notices_cli  # noqa: E402
from spdx import (  # noqa: E402
    FIRST_PARTY,
    NON_COMMERCIAL,
    UNKNOWN,
    evaluate_expression,
    is_gpl_family,
    normalize_expression,
)


def _validate_policy(policy: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Validate policy exemptions and return (valid_exemptions, policy_violations)."""
    valid_exemptions: list[dict[str, Any]] = []
    violations: list[dict[str, Any]] = []

    raw_exemptions = policy.get("exemptions")
    if raw_exemptions is None:
        return valid_exemptions, violations
    if not isinstance(raw_exemptions, list):
        violations.append(
            {
                "code": "invalid-policy",
                "ecosystem": "policy",
                "evidence": "policy.json:exemptions",
                "licence": UNKNOWN,
                "message": "policy.json 'exemptions' must be a list.",
                "name": "exemptions",
                "scope": "policy",
                "version": None,
            }
        )
        return valid_exemptions, violations

    for idx, entry in enumerate(raw_exemptions):
        if not isinstance(entry, dict):
            violations.append(
                {
                    "code": "invalid-exemption",
                    "ecosystem": "policy",
                    "evidence": f"policy.json:exemptions[{idx}]",
                    "licence": UNKNOWN,
                    "message": "Exemption entry must be a JSON object.",
                    "name": f"exemptions[{idx}]",
                    "scope": "policy",
                    "version": None,
                }
            )
            continue

        ecosystem = str(entry.get("ecosystem") or "").strip()
        name = str(entry.get("name") or "").strip()
        scope = str(entry.get("scope") or "").strip()
        raw_lic = str(entry.get("licence") or "").strip()
        reason = str(entry.get("reason") or "").strip()
        version = str(entry.get("version") or "*").strip()

        if not (ecosystem and name and scope and raw_lic and reason):
            violations.append(
                {
                    "code": "invalid-exemption-missing-reason",
                    "ecosystem": ecosystem or "policy",
                    "evidence": f"policy.json:exemptions[{idx}]",
                    "licence": raw_lic or UNKNOWN,
                    "message": "Exemption must specify non-empty ecosystem, name, scope, licence, and reason.",
                    "name": name or f"exemptions[{idx}]",
                    "scope": scope or "policy",
                    "version": version,
                }
            )
            continue

        valid_exemptions.append(
            {
                "ecosystem": ecosystem,
                "licence": normalize_expression(raw_lic) if raw_lic != UNKNOWN else UNKNOWN,
                "name": name,
                "reason": reason,
                "scope": scope,
                "version": version,
            }
        )

    return valid_exemptions, violations


def _find_matching_exemption(
    exemptions: list[dict[str, Any]],
    ecosystem: str,
    name: str,
    version: str,
    scope: str,
    licence: str,
) -> dict[str, Any] | None:
    for ex in exemptions:
        if ex["ecosystem"] != ecosystem:
            continue
        if ex["name"] != name:
            continue
        if ex["scope"] not in (scope, "*"):
            continue
        if ex["version"] not in ("*", version):
            continue
        if ex["licence"] in ("*", licence):
            return ex
    return None


def _classify_violation_code(scope: str, offending: list[str], licence: str) -> str:
    if NON_COMMERCIAL in offending or licence == NON_COMMERCIAL:
        return "non-commercial-licence"
    if UNKNOWN in offending or licence == UNKNOWN:
        return "unknown-licence"
    if any(tok.startswith("AGPL-") for tok in offending):
        return "agpl-prohibited"
    if scope == "app" and (any(is_gpl_family(tok) for tok in offending) or is_gpl_family(licence)):
        return "copyleft-in-app"
    return "disallowed-licence"


def run_audit(
    repo_root: Path,
    policy_path: Path,
    python_paths: list[Path] | None = None,
) -> dict[str, Any]:
    """Execute the full repository licence audit and return a deterministic JSON-serializable report."""
    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    allowlists_cfg = policy.get("allowlists") or {}
    denied_cfg = policy.get("denied") or {}

    app_allow = {normalize_expression(x) for x in (allowlists_cfg.get("app") or [])}
    server_allow = {normalize_expression(x) for x in (allowlists_cfg.get("server") or [])}
    app_denied = {normalize_expression(x) if x not in (UNKNOWN, NON_COMMERCIAL) else x for x in (denied_cfg.get("app") or [])}
    server_denied = {normalize_expression(x) if x not in (UNKNOWN, NON_COMMERCIAL) else x for x in (denied_cfg.get("server") or [])}

    isolated_cfg = policy.get("isolatedGplTools") or {}
    isolated_gpl_folders = set(isolated_cfg.get("folders") or [])
    isolated_gpl_licences = {normalize_expression(x) for x in (isolated_cfg.get("allowedLicences") or [])}

    exemptions, violations = _validate_policy(policy)

    mobile_npm = inventory_mobile_npm(repo_root)
    cocoapods = inventory_cocoapods(repo_root, policy)
    workspace_npm = inventory_workspace_npm(repo_root)
    tool_folders, tool_python = inventory_tools(repo_root, python_paths=python_paths)
    app_gpl_imports = detect_app_gpl_tool_imports(repo_root, tool_folders)

    def _audit_standard_item(item: dict[str, Any]) -> None:
        if item.get("firstParty") and item.get("licence") == FIRST_PARTY:
            item["status"] = "first-party"
            return

        scope = item["scope"]
        allow = app_allow if scope == "app" else server_allow
        denied = app_denied if scope == "app" else server_denied
        lic = item["licence"]

        allowed, offending = evaluate_expression(lic, allow, denied)
        if allowed:
            item["status"] = "allowed"
            return

        ex = _find_matching_exemption(
            exemptions=exemptions,
            ecosystem=item["ecosystem"],
            name=item["name"],
            version=str(item.get("version") or ""),
            scope=scope,
            licence=lic,
        )
        if ex is not None:
            item["status"] = "exempted"
            item["exemptionReason"] = ex["reason"]
            return

        code = _classify_violation_code(scope, offending, lic)
        item["status"] = "violation"
        item["violationCode"] = code
        violations.append(
            {
                "code": code,
                "ecosystem": item["ecosystem"],
                "evidence": item["evidence"],
                "licence": lic,
                "message": f"{item['ecosystem']} dependency '{item['name']}@{item['version']}' has disallowed licence '{lic}' in {scope} scope.",
                "name": item["name"],
                "offendingLicences": offending,
                "scope": scope,
                "version": item["version"],
            }
        )

    for item in mobile_npm:
        _audit_standard_item(item)

    for item in cocoapods:
        _audit_standard_item(item)

    for item in workspace_npm:
        _audit_standard_item(item)

    for tool in tool_folders:
        lic = tool["licence"]
        folder_name = tool["name"]
        if folder_name in isolated_gpl_folders and lic in isolated_gpl_licences:
            tool["status"] = "allowed-isolated-gpl"
            continue

        allowed, offending = evaluate_expression(lic, server_allow, server_denied)
        if allowed:
            tool["status"] = "allowed"
            continue

        ex = _find_matching_exemption(
            exemptions=exemptions,
            ecosystem="tool",
            name=folder_name,
            version="workspace",
            scope="server",
            licence=lic,
        )
        if ex is not None:
            tool["status"] = "exempted"
            tool["exemptionReason"] = ex["reason"]
            continue

        if lic == UNKNOWN:
            code = "missing-tool-licence"
            msg = f"Tool folder '{folder_name}' has no recognized LICENSE file (resolved '{UNKNOWN}')."
        elif is_gpl_family(lic):
            code = "unisolated-gpl-tool"
            msg = (
                f"Tool folder '{folder_name}' declares copyleft licence '{lic}' "
                "but is not listed in policy.json isolatedGplTools.folders."
            )
        else:
            code = _classify_violation_code("server", offending, lic)
            msg = f"Tool folder '{folder_name}' has disallowed licence '{lic}'."

        tool["status"] = "violation"
        tool["violationCode"] = code
        violations.append(
            {
                "code": code,
                "ecosystem": "tool",
                "evidence": tool["evidence"],
                "licence": lic,
                "message": msg,
                "name": folder_name,
                "offendingLicences": offending,
                "scope": "server",
                "version": "workspace",
            }
        )

    for py_item in tool_python:
        lic = py_item["licence"]
        tool_folder = py_item["toolFolder"]
        is_declared = bool(py_item.get("declared", True))

        eff_allow = set(server_allow)
        if tool_folder in isolated_gpl_folders:
            eff_allow |= isolated_gpl_licences

        allowed, offending = evaluate_expression(lic, eff_allow, server_denied)

        ex = _find_matching_exemption(
            exemptions=exemptions,
            ecosystem="python",
            name=py_item["name"],
            version=str(py_item.get("version") or ""),
            scope="server",
            licence=lic,
        )

        if not is_declared and ex is None:
            py_item["status"] = "violation"
            code = "undeclared-python-requirement" if allowed else _classify_violation_code("server", offending, lic)
            py_item["violationCode"] = code
            violations.append(
                {
                    "code": code,
                    "ecosystem": "python",
                    "evidence": py_item["evidence"],
                    "licence": lic,
                    "message": (
                        f"Tool '{tool_folder}' imports third-party Python package '{py_item['name']}' "
                        f"(licence '{lic}') without declaring it in requirements/pyproject lock metadata."
                    ),
                    "name": py_item["name"],
                    "offendingLicences": offending if not allowed else [lic],
                    "scope": "server",
                    "toolFolder": tool_folder,
                    "version": py_item["version"],
                }
            )
            continue

        if allowed:
            py_item["status"] = "allowed"
            continue

        if ex is not None:
            py_item["status"] = "exempted"
            py_item["exemptionReason"] = ex["reason"]
            continue

        code = _classify_violation_code("server", offending, lic)
        py_item["status"] = "violation"
        py_item["violationCode"] = code
        violations.append(
            {
                "code": code,
                "ecosystem": "python",
                "evidence": py_item["evidence"],
                "licence": lic,
                "message": (
                    f"Python requirement '{py_item['name']}@{py_item['version']}' in '{tool_folder}' "
                    f"has disallowed licence '{lic}'."
                ),
                "name": py_item["name"],
                "offendingLicences": offending,
                "scope": "server",
                "toolFolder": tool_folder,
                "version": py_item["version"],
            }
        )

    for leak in app_gpl_imports:
        violations.append(
            {
                "code": "gpl-tool-imported-by-app",
                "ecosystem": "tool",
                "evidence": f"{leak['appFile']}:{leak['line']}",
                "licence": leak["toolLicence"],
                "message": (
                    f"App file '{leak['appFile']}' (line {leak['line']}) imports or references "
                    f"GPL tool folder '{leak['toolFolder']}' ({leak['toolLicence']})."
                ),
                "name": leak["toolFolder"],
                "offendingLicences": [leak["toolLicence"]],
                "scope": "app",
                "version": "workspace",
            }
        )

    violations.sort(
        key=lambda v: (
            v["scope"],
            v["ecosystem"],
            v["code"],
            v["name"],
            str(v.get("version") or ""),
            v["evidence"],
        )
    )

    all_items = mobile_npm + cocoapods + workspace_npm + tool_folders + tool_python
    status_counts: dict[str, int] = {}
    for rec in all_items:
        st = str(rec.get("status") or "unknown")
        status_counts[st] = status_counts.get(st, 0) + 1

    return {
        "appGplToolImports": app_gpl_imports,
        "inventory": {
            "cocoapods": cocoapods,
            "mobileNpm": mobile_npm,
            "toolFolders": tool_folders,
            "toolPythonRequirements": tool_python,
            "workspaceNpm": workspace_npm,
        },
        "ok": len(violations) == 0,
        "policySchemaVersion": policy.get("schemaVersion", 1),
        "schemaVersion": 1,
        "summary": {
            "appGplToolImportCount": len(app_gpl_imports),
            "cocoapodsCount": len(cocoapods),
            "mobileNpmCount": len(mobile_npm),
            "statusCounts": dict(sorted(status_counts.items())),
            "toolFoldersCount": len(tool_folders),
            "toolPythonRequirementsCount": len(tool_python),
            "violationCount": len(violations),
            "workspaceNpmCount": len(workspace_npm),
        },
        "violations": violations,
    }


def _build_parser() -> argparse.ArgumentParser:
    default_repo = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(
        description="Audit repository dependency licences against policy.json and manage mobile THIRD_PARTY_NOTICES.md."
    )
    sub = parser.add_subparsers(dest="command")

    def _add_audit_args(p: argparse.ArgumentParser) -> None:
        p.add_argument("--repo-root", type=Path, default=default_repo, help="Repository root directory.")
        p.add_argument(
            "--policy",
            type=Path,
            default=None,
            help="Policy JSON file (defaults to <repo-root>/tools/licence-audit/policy.json).",
        )
        p.add_argument("--out", "--output", dest="out", type=Path, default=None, help="Optional path to write the deterministic JSON report.")
        p.add_argument(
            "--python-path",
            action="append",
            type=Path,
            default=None,
            help="Optional Python site-packages directory to inspect instead of the active interpreter environment.",
        )

    _add_audit_args(parser)
    audit_sub = sub.add_parser("audit", help="Run licence allowlist audit and emit deterministic JSON report.")
    _add_audit_args(audit_sub)

    notices_sub = sub.add_parser("notices", help="Generate or check apps/mobile/THIRD_PARTY_NOTICES.md.")
    notices_sub.add_argument("--repo-root", type=Path, default=default_repo, help="Repository root directory.")
    notices_sub.add_argument(
        "--policy",
        type=Path,
        default=None,
        help="Policy JSON file (defaults to <repo-root>/tools/licence-audit/policy.json).",
    )
    notices_sub.add_argument(
        "--out",
        "--output",
        dest="out",
        type=Path,
        default=None,
        help="Target notices file (defaults to <repo-root>/apps/mobile/THIRD_PARTY_NOTICES.md).",
    )
    mode = notices_sub.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="Write THIRD_PARTY_NOTICES.md (default).")
    mode.add_argument("--check", action="store_true", help="Fail if THIRD_PARTY_NOTICES.md is missing or stale.")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    repo_root = args.repo_root.resolve()
    policy_path = (args.policy or (repo_root / "tools" / "licence-audit" / "policy.json")).resolve()

    if args.command == "notices":
        out_path = (args.out or (repo_root / "apps" / "mobile" / "THIRD_PARTY_NOTICES.md")).resolve()
        return run_notices_cli(
            repo_root=repo_root,
            policy_path=policy_path,
            out_path=out_path,
            check_only=bool(args.check),
        )

    if not policy_path.is_file():
        print(f"error: policy file not found: {policy_path}", file=sys.stderr)
        return 2

    python_paths = [p.resolve() for p in args.python_path] if args.python_path else None
    try:
        report = run_audit(repo_root=repo_root, policy_path=policy_path, python_paths=python_paths)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: audit failed: {exc}", file=sys.stderr)
        return 2

    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)

    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
