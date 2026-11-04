# SPDX-License-Identifier: MIT
"""Synthetic fixture tests for licence allowlist auditing and third-party notices."""

from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

AUDIT_DIR = Path(__file__).resolve().parents[1]
if str(AUDIT_DIR) not in sys.path:
    sys.path.insert(0, str(AUDIT_DIR))

import audit  # noqa: E402

MIT_TEXT = """MIT License

Copyright (c) 2026 Synthetic Fixture Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
"""

GPL3_TEXT = """                    GNU GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007

 Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>
 Everyone is permitted to copy and distribute verbatim copies
 of this license document, but changing it is not allowed.

  13. Use with the GNU Affero General Public License.
  Notwithstanding any other provision of this License, you have
  permission to link or combine any covered work with a work licensed
  under version 3 of the GNU Affero General Public License.
"""

UNLICENSE_TEXT = """This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.
"""


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _make_dist_info(
    site_packages: Path,
    dist_name: str,
    version: str,
    licence_header: str | None = None,
    licence_file_text: str | None = None,
    requires_dist: list[str] | None = None,
    top_level: str | None = None,
) -> None:
    slug = dist_name.replace("-", "_")
    dist_dir = site_packages / f"{slug}-{version}.dist-info"
    dist_dir.mkdir(parents=True, exist_ok=True)
    lines = [
        "Metadata-Version: 2.3",
        f"Name: {dist_name}",
        f"Version: {version}",
    ]
    if licence_header is not None:
        lines.append(f"License: {licence_header}")
    for req in requires_dist or []:
        lines.append(f"Requires-Dist: {req}")
    _write_text(dist_dir / "METADATA", "\n".join(lines) + "\n")
    _write_text(dist_dir / "top_level.txt", (top_level or slug) + "\n")
    if licence_file_text is not None:
        _write_text(dist_dir / "licenses" / "LICENSE.txt", licence_file_text)


def _create_allowed_repo_fixture(root: Path, site_packages: Path) -> Path:
    """Populate a complete synthetic repository where all app, server, and isolated tool deps pass."""
    policy = {
        "schemaVersion": 1,
        "allowlists": {
            "app": [
                "0BSD",
                "Apache-2.0",
                "BSD-2-Clause",
                "BSD-3-Clause",
                "BSL-1.0",
                "ISC",
                "MIT",
                "MPL-2.0",
                "Unlicense",
                "Zlib",
            ],
            "server": [
                "0BSD",
                "Apache-2.0",
                "BSD-2-Clause",
                "BSD-3-Clause",
                "BSL-1.0",
                "ISC",
                "MIT",
                "MPL-2.0",
                "PSF-2.0",
                "Python-2.0",
                "Unlicense",
                "Zlib",
            ],
        },
        "denied": {
            "app": [
                "AGPL-3.0-only",
                "AGPL-3.0-or-later",
                "GPL-2.0-only",
                "GPL-2.0-or-later",
                "GPL-3.0-only",
                "GPL-3.0-or-later",
                "LGPL-2.1-only",
                "LGPL-2.1-or-later",
                "LGPL-3.0-only",
                "LGPL-3.0-or-later",
                "NON-COMMERCIAL",
                "UNKNOWN",
            ],
            "server": [
                "AGPL-3.0-only",
                "AGPL-3.0-or-later",
                "NON-COMMERCIAL",
                "UNKNOWN",
            ],
        },
        "isolatedGplTools": {
            "allowedLicences": ["GPL-3.0-only", "GPL-3.0-or-later"],
            "folders": ["tools/scan-repair"],
        },
        "verifiedCocoaPodsSpecs": [],
        "exemptions": [],
    }
    policy_path = root / "tools" / "licence-audit" / "policy.json"
    _write_json(policy_path, policy)
    _write_text(root / "tools" / "licence-audit" / "LICENSE", MIT_TEXT)
    _write_text(root / "tools" / "licence-audit" / "placeholder.py", "# SPDX-License-Identifier: MIT\n")

    # Shared contracts workspace package
    _write_json(
        root / "packages" / "contracts" / "package.json",
        {
            "name": "@synthetic/contracts",
            "version": "0.1.0",
            "private": True,
            "dependencies": {"zod": "4.0.0"},
        },
    )
    _write_json(
        root / "packages" / "contracts" / "package-lock.json",
        {
            "name": "@synthetic/contracts",
            "lockfileVersion": 3,
            "packages": {
                "": {
                    "name": "@synthetic/contracts",
                    "version": "0.1.0",
                    "dependencies": {"zod": "4.0.0"},
                },
                "node_modules/zod": {
                    "version": "4.0.0",
                    "resolved": "https://registry.npmjs.org/zod/-/zod-4.0.0.tgz",
                    "license": "MIT",
                },
            },
        },
    )

    # Server companion service
    _write_json(
        root / "services" / "companion" / "package.json",
        {
            "name": "@synthetic/companion",
            "version": "0.1.0",
            "private": True,
            "dependencies": {"ajv": "8.0.0"},
        },
    )
    _write_json(
        root / "services" / "companion" / "package-lock.json",
        {
            "name": "@synthetic/companion",
            "lockfileVersion": 3,
            "packages": {
                "": {
                    "name": "@synthetic/companion",
                    "version": "0.1.0",
                    "dependencies": {"ajv": "8.0.0"},
                },
                "node_modules/ajv": {
                    "version": "8.0.0",
                    "resolved": "https://registry.npmjs.org/ajv/-/ajv-8.0.0.tgz",
                    "license": "MIT",
                },
            },
        },
    )

    # Mobile app with prod deps (MIT, Apache-2.0, dual MIT OR CC0-1.0) + a dev-only GPL linter
    _write_json(
        root / "apps" / "mobile" / "package.json",
        {
            "name": "synthetic-mobile",
            "version": "0.0.1",
            "private": True,
            "dependencies": {
                "@synthetic/contracts": "file:../../packages/contracts",
                "react": "19.0.0",
                "type-fest": "1.0.0",
                "unlicense-helper": "1.0.0",
            },
            "devDependencies": {
                "dev-only-gpl-linter": "1.0.0",
            },
        },
    )
    _write_json(
        root / "apps" / "mobile" / "package-lock.json",
        {
            "name": "synthetic-mobile",
            "lockfileVersion": 3,
            "packages": {
                "": {
                    "name": "synthetic-mobile",
                    "version": "0.0.1",
                    "dependencies": {
                        "@synthetic/contracts": "file:../../packages/contracts",
                        "react": "19.0.0",
                        "type-fest": "1.0.0",
                        "unlicense-helper": "1.0.0",
                    },
                    "devDependencies": {
                        "dev-only-gpl-linter": "1.0.0",
                    },
                },
                "../../packages/contracts": {
                    "version": "0.1.0",
                },
                "node_modules/@synthetic/contracts": {
                    "resolved": "../../packages/contracts",
                    "link": True,
                },
                "node_modules/react": {
                    "version": "19.0.0",
                    "resolved": "https://registry.npmjs.org/react/-/react-19.0.0.tgz",
                    "license": "MIT",
                },
                "node_modules/type-fest": {
                    "version": "1.0.0",
                    "resolved": "https://registry.npmjs.org/type-fest/-/type-fest-1.0.0.tgz",
                    "license": "(MIT OR CC0-1.0)",
                },
                "node_modules/unlicense-helper": {
                    "version": "1.0.0",
                    "resolved": "https://registry.npmjs.org/unlicense-helper/-/unlicense-helper-1.0.0.tgz",
                },
                "node_modules/dev-only-gpl-linter": {
                    "version": "1.0.0",
                    "resolved": "https://registry.npmjs.org/dev-only-gpl-linter/-/dev-only-gpl-linter-1.0.0.tgz",
                    "dev": True,
                    "license": "GPL-3.0-only",
                },
            },
        },
    )
    _write_text(root / "apps" / "mobile" / "node_modules" / "react" / "LICENSE", MIT_TEXT)
    _write_text(root / "apps" / "mobile" / "node_modules" / "unlicense-helper" / "LICENSE", UNLICENSE_TEXT)
    _write_text(root / "apps" / "mobile" / "src" / "App.tsx", "export const App = () => null;\n")

    # Mobile CocoaPods Podfile.lock + podspecs
    _write_text(
        root / "apps" / "mobile" / "node_modules" / "safe-area" / "SafeArea.podspec",
        """Pod::Spec.new do |s|
  s.name = "SafeArea"
  s.version = "2.1.0"
  s.homepage = "https://example.invalid/safe-area"
  s.license = { :type => "MIT", :file => "LICENSE" }
end
""",
    )
    _write_text(root / "apps" / "mobile" / "node_modules" / "safe-area" / "LICENSE", MIT_TEXT)
    _write_text(
        root / "apps" / "mobile" / "ios" / "Podfile.lock",
        """PODS:
  - SafeArea (2.1.0)

DEPENDENCIES:
  - SafeArea

EXTERNAL SOURCES:
  SafeArea:
    :path: "../node_modules/safe-area"

SPEC CHECKSUMS:
  SafeArea: 1111111111111111111111111111111111111111

PODFILE CHECKSUM: 2222222222222222222222222222222222222222

COCOAPODS: 1.15.2
""",
    )

    # Permissive Python tool + installed metadata
    _write_text(root / "tools" / "mesh-helper" / "LICENSE", MIT_TEXT)
    _write_text(root / "tools" / "mesh-helper" / "requirements.txt", "geom-kernel==1.4.0\n")
    _write_text(
        root / "tools" / "mesh-helper" / "helper.py",
        "# SPDX-License-Identifier: MIT\nimport geom_kernel\n",
    )
    _make_dist_info(
        site_packages,
        dist_name="geom-kernel",
        version="1.4.0",
        licence_header="Apache-2.0",
        top_level="geom_kernel",
    )

    # Isolated GPL-3.0-or-later headless Blender server tool
    _write_text(root / "tools" / "scan-repair" / "LICENSE", GPL3_TEXT)
    _write_text(
        root / "tools" / "scan-repair" / "repair.py",
        "# SPDX-License-Identifier: GPL-3.0-or-later\nimport bpy\nimport numpy\n",
    )

    return policy_path


class LicenceAuditTests(unittest.TestCase):
    def test_local_python_package_is_not_an_undeclared_dependency(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo, site = base / "repo", base / "site-packages"
            site.mkdir()
            policy = _create_allowed_repo_fixture(repo, site)
            tool = repo / "tools" / "mesh-helper"
            package = tool / "local_geometry"
            package.mkdir(parents=True)
            (package / "__init__.py").write_text("")
            (tool / "preview.py").write_text("from local_geometry import mesh\nimport unknown_external_package\n")
            report = audit.run_audit(repo, policy, python_paths=[site])
            names = {v["name"] for v in report["violations"]}
            self.assertNotIn("local_geometry", names)
            self.assertIn("unknown_external_package", names)

    def test_allowed_set_passes_and_report_is_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)

            out_one = base / "report1.json"
            out_two = base / "report2.json"

            rc1 = audit.main(
                [
                    "audit",
                    "--repo-root",
                    str(repo),
                    "--policy",
                    str(policy_path),
                    "--python-path",
                    str(site),
                    "--out",
                    str(out_one),
                ]
            )
            rc2 = audit.main(
                [
                    "audit",
                    "--repo-root",
                    str(repo),
                    "--policy",
                    str(policy_path),
                    "--python-path",
                    str(site),
                    "--out",
                    str(out_two),
                ]
            )
            self.assertEqual(rc1, 0)
            self.assertEqual(rc2, 0)
            self.assertEqual(out_one.read_text(encoding="utf-8"), out_two.read_text(encoding="utf-8"))

            report = json.loads(out_one.read_text(encoding="utf-8"))
            self.assertTrue(report["ok"])
            self.assertEqual(report["summary"]["violationCount"], 0)
            # Verify Unlicense text with "commercial or non-commercial" classified as Unlicense, not NC
            mobile_lics = {item["name"]: item["licence"] for item in report["inventory"]["mobileNpm"]}
            self.assertEqual(mobile_lics["unlicense-helper"], "Unlicense")
            self.assertNotIn("dev-only-gpl-linter", mobile_lics)

    def test_gpl_and_lgpl_dependency_in_app_fails(self) -> None:
        # Subcase A: GPL-3.0 npm production dependency in apps/mobile
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)

            lock_path = repo / "apps" / "mobile" / "package-lock.json"
            lock_data = json.loads(lock_path.read_text(encoding="utf-8"))
            lock_data["packages"][""]["dependencies"]["gpl-mesh-lib"] = "2.0.0"
            lock_data["packages"]["node_modules/gpl-mesh-lib"] = {
                "version": "2.0.0",
                "resolved": "https://registry.npmjs.org/gpl-mesh-lib/-/gpl-mesh-lib-2.0.0.tgz",
                "license": "GPL-3.0-only",
            }
            _write_json(lock_path, lock_data)

            report = audit.run_audit(repo, policy_path, python_paths=[site])
            self.assertFalse(report["ok"])
            codes = [(v["code"], v["name"], v["scope"]) for v in report["violations"]]
            self.assertIn(("copyleft-in-app", "gpl-mesh-lib", "app"), codes)

            rc = audit.main(
                [
                    "audit",
                    "--repo-root",
                    str(repo),
                    "--policy",
                    str(policy_path),
                    "--python-path",
                    str(site),
                    "--out",
                    str(base / "gpl-npm.json"),
                ]
            )
            self.assertEqual(rc, 1)

        # Subcase B: LGPL-2.1 static CocoaPod in apps/mobile/ios/Podfile.lock
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)

            _write_text(
                repo / "apps" / "mobile" / "node_modules" / "lgpl-pod" / "LgplPod.podspec",
                """Pod::Spec.new do |s|
  s.name = "LgplPod"
  s.version = "1.0.0"
  s.license = { :type => "LGPL-2.1-only" }
end
""",
            )
            _write_text(
                repo / "apps" / "mobile" / "ios" / "Podfile.lock",
                """PODS:
  - LgplPod (1.0.0)

DEPENDENCIES:
  - LgplPod

EXTERNAL SOURCES:
  LgplPod:
    :path: "../node_modules/lgpl-pod"

SPEC CHECKSUMS:
  LgplPod: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

PODFILE CHECKSUM: 2222222222222222222222222222222222222222

COCOAPODS: 1.15.2
""",
            )
            report = audit.run_audit(repo, policy_path, python_paths=[site])
            self.assertFalse(report["ok"])
            codes = [(v["code"], v["name"], v["scope"]) for v in report["violations"]]
            self.assertIn(("copyleft-in-app", "LgplPod", "app"), codes)

    def test_nc_licence_anywhere_fails_including_mit_wrapper_poisoning(self) -> None:
        # Subcase A: Direct NC npm dependency on server
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)

            svc_lock = repo / "services" / "companion" / "package-lock.json"
            sdata = json.loads(svc_lock.read_text(encoding="utf-8"))
            sdata["packages"][""]["dependencies"]["nc-weights-sdk"] = "1.0.0"
            sdata["packages"]["node_modules/nc-weights-sdk"] = {
                "version": "1.0.0",
                "resolved": "https://registry.npmjs.org/nc-weights-sdk/-/nc-weights-sdk-1.0.0.tgz",
                "license": "CC-BY-NC-4.0",
            }
            _write_json(svc_lock, sdata)

            report = audit.run_audit(repo, policy_path, python_paths=[site])
            self.assertFalse(report["ok"])
            self.assertIn(
                ("non-commercial-licence", "nc-weights-sdk", "server"),
                [(v["code"], v["name"], v["scope"]) for v in report["violations"]],
            )

        # Subcase B: MIT Python wrapper pulling a transitive non-commercial dependency ("MIT wrapper poisoning")
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)

            _write_text(repo / "tools" / "pose-bridge" / "LICENSE", MIT_TEXT)
            _write_text(repo / "tools" / "pose-bridge" / "requirements.txt", "mit-pose-wrapper==1.0.0\n")
            _write_text(repo / "tools" / "pose-bridge" / "run.py", "import mit_pose_wrapper\n")

            _make_dist_info(
                site,
                dist_name="mit-pose-wrapper",
                version="1.0.0",
                licence_header="MIT",
                requires_dist=["superpoint-nc (>=2.0.0)"],
                top_level="mit_pose_wrapper",
            )
            # Transitive dependency falsely claims MIT in header but embeds an academic NC rider in LICENSE.txt
            _make_dist_info(
                site,
                dist_name="superpoint-nc",
                version="2.0.0",
                licence_header="MIT",
                licence_file_text=(
                    "Copyright (c) Synthetic Research Lab.\n"
                    "Permission is granted solely for academic and non-commercial research use only.\n"
                    "Commercial use is strictly prohibited.\n"
                ),
                top_level="superpoint_nc",
            )

            report = audit.run_audit(repo, policy_path, python_paths=[site])
            self.assertFalse(report["ok"])
            violations = [(v["code"], v["name"], v["licence"]) for v in report["violations"]]
            self.assertIn(("non-commercial-licence", "superpoint-nc", "NON-COMMERCIAL"), violations)

    def test_unknown_licence_fails_unless_exempted_with_reason(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)

            svc_lock = repo / "services" / "companion" / "package-lock.json"
            sdata = json.loads(svc_lock.read_text(encoding="utf-8"))
            sdata["packages"][""]["dependencies"]["mystery-pkg"] = "0.9.0"
            sdata["packages"]["node_modules/mystery-pkg"] = {
                "version": "0.9.0",
                "resolved": "https://registry.npmjs.org/mystery-pkg/-/mystery-pkg-0.9.0.tgz",
            }
            _write_json(svc_lock, sdata)

            # 1. Must fail when unexempted
            report_unexempted = audit.run_audit(repo, policy_path, python_paths=[site])
            self.assertFalse(report_unexempted["ok"])
            self.assertIn(
                ("unknown-licence", "mystery-pkg", "UNKNOWN"),
                [(v["code"], v["name"], v["licence"]) for v in report_unexempted["violations"]],
            )

            # 2. Must still fail if exemption omits a non-empty reason
            pdata = json.loads(policy_path.read_text(encoding="utf-8"))
            pdata["exemptions"] = [
                {
                    "ecosystem": "npm",
                    "licence": "UNKNOWN",
                    "name": "mystery-pkg",
                    "reason": "   ",
                    "scope": "server",
                    "version": "0.9.0",
                }
            ]
            _write_json(policy_path, pdata)
            report_blank_reason = audit.run_audit(repo, policy_path, python_paths=[site])
            self.assertFalse(report_blank_reason["ok"])
            codes_blank = [v["code"] for v in report_blank_reason["violations"]]
            self.assertIn("invalid-exemption-missing-reason", codes_blank)
            self.assertIn("unknown-licence", codes_blank)

            # 3. Passes once explicitly exempted with a documented reason
            pdata["exemptions"] = [
                {
                    "ecosystem": "npm",
                    "licence": "UNKNOWN",
                    "name": "mystery-pkg",
                    "reason": "Upstream tarball omits package.json license field; verified MIT in tagged commit.",
                    "scope": "server",
                    "version": "0.9.0",
                }
            ]
            _write_json(policy_path, pdata)
            report_exempted = audit.run_audit(repo, policy_path, python_paths=[site])
            self.assertTrue(report_exempted["ok"])
            self.assertEqual(report_exempted["summary"]["violationCount"], 0)
            mystery_items = [
                i for i in report_exempted["inventory"]["workspaceNpm"] if i["name"] == "mystery-pkg"
            ]
            self.assertEqual(len(mystery_items), 1)
            self.assertEqual(mystery_items[0]["status"], "exempted")

    def test_gpl_tool_imported_from_apps_or_unisolated_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)

            # Import isolated GPL server tool from apps/mobile
            _write_text(
                repo / "apps" / "mobile" / "src" / "illegalImport.ts",
                'import { runRepair } from "../../../tools/scan-repair/repair";\nexport { runRepair };\n',
            )
            # Also add an unlisted GPL tool folder not in isolatedGplTools.folders
            _write_text(repo / "tools" / "unlisted-gpl" / "LICENSE", GPL3_TEXT)
            _write_text(repo / "tools" / "unlisted-gpl" / "worker.py", "print('hi')\n")

            report = audit.run_audit(repo, policy_path, python_paths=[site])
            self.assertFalse(report["ok"])
            violation_codes = {(v["code"], v["name"], v["scope"]) for v in report["violations"]}
            self.assertIn(("gpl-tool-imported-by-app", "tools/scan-repair", "app"), violation_codes)
            self.assertIn(("unisolated-gpl-tool", "tools/unlisted-gpl", "server"), violation_codes)

    def test_third_party_notices_generation_and_staleness_check(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)
            notices_path = repo / "apps" / "mobile" / "THIRD_PARTY_NOTICES.md"

            # Missing notices file fails --check
            stderr_buf = io.StringIO()
            with contextlib.redirect_stderr(stderr_buf):
                rc_missing = audit.main(
                    ["notices", "--repo-root", str(repo), "--policy", str(policy_path), "--check"]
                )
            self.assertEqual(rc_missing, 1)

            # Generate notices with --write, then verify --check succeeds
            rc_write = audit.main(
                ["notices", "--repo-root", str(repo), "--policy", str(policy_path), "--write"]
            )
            self.assertEqual(rc_write, 0)
            self.assertTrue(notices_path.is_file())
            rendered = notices_path.read_text(encoding="utf-8")
            self.assertIn("`SafeArea`", rendered)
            self.assertIn("`react`", rendered)
            self.assertIn("`zod`", rendered)
            self.assertNotIn("dev-only-gpl-linter", rendered)

            rc_fresh = audit.main(
                ["notices", "--repo-root", str(repo), "--policy", str(policy_path), "--check"]
            )
            self.assertEqual(rc_fresh, 0)

            # Bump a locked mobile dependency without regenerating notices -> --check must fail
            lock_path = repo / "apps" / "mobile" / "package-lock.json"
            lock_data = json.loads(lock_path.read_text(encoding="utf-8"))
            lock_data["packages"]["node_modules/react"]["version"] = "19.0.1"
            _write_json(lock_path, lock_data)

            with contextlib.redirect_stderr(io.StringIO()):
                rc_stale = audit.main(
                    ["notices", "--repo-root", str(repo), "--policy", str(policy_path), "--check"]
                )
            self.assertEqual(rc_stale, 1)

    def test_embedded_mobile_modules_listed_without_npm_or_cocoapods(self) -> None:
        """The Swift app has no lockfiles: modules with LICENSE.txt and PROVENANCE.md are still noticed and audited."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)
            mobile = repo / "apps" / "mobile"
            for name in ("package.json", "package-lock.json", "ios/Podfile.lock"):
                (mobile / name).unlink(missing_ok=True)
            module = mobile / "modules" / "sample-capture"
            _write_text(module / "LICENSE.txt", "Copyright (c) 2024 Example Inc.\n\n" + MIT_TEXT)
            _write_text(module / "PROVENANCE.md", "# Provenance\n\nRetrieved from the vendor.\n")
            _write_json(module / "package.json", {"name": "@scan-to-make/sample-capture", "version": "0.0.1", "private": True})
            # A module without provenance is first-party code, not an embedded third-party module.
            _write_text(mobile / "modules" / "ours" / "LICENSE.txt", MIT_TEXT)

            rc_write = audit.main(["notices", "--repo-root", str(repo), "--policy", str(policy_path), "--write"])
            self.assertEqual(rc_write, 0)
            rendered = (mobile / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
            self.assertIn("| `@scan-to-make/sample-capture` | `0.0.1` | `MIT` | `apps/mobile/modules/sample-capture` |", rendered)
            self.assertIn("Copyright (c) 2024 Example Inc.", rendered)
            self.assertNotIn("modules/ours", rendered)
            self.assertNotIn("Podfile.lock`)", rendered.split("This file lists", 1)[1].split("\n", 1)[1])
            rc_check = audit.main(["notices", "--repo-root", str(repo), "--policy", str(policy_path), "--check"])
            self.assertEqual(rc_check, 0)

            report = audit.run_audit(repo, policy_path, python_paths=[site])
            embedded = report["inventory"]["mobileEmbedded"]
            self.assertEqual([item["name"] for item in embedded], ["@scan-to-make/sample-capture"])
            self.assertEqual(embedded[0]["status"], "allowed")

    def test_mobile_peer_dependencies_traversed_and_absent_optional_peers_ignored(self) -> None:
        # 1. Production package with a resolved GPL-3.0-only peer fails app allowlist
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)

            lock_path = repo / "apps" / "mobile" / "package-lock.json"
            lock_data = json.loads(lock_path.read_text(encoding="utf-8"))
            lock_data["packages"]["node_modules/react"]["peerDependencies"] = {"gpl-peer-runtime": "^1.0.0"}
            lock_data["packages"]["node_modules/gpl-peer-runtime"] = {
                "version": "1.2.0",
                "resolved": "https://registry.npmjs.org/gpl-peer-runtime/-/gpl-peer-runtime-1.2.0.tgz",
                "license": "GPL-3.0-only",
            }
            _write_json(lock_path, lock_data)

            report = audit.run_audit(repo, policy_path, python_paths=[site])
            self.assertFalse(report["ok"])
            codes = [(v["code"], v["name"], v["scope"]) for v in report["violations"]]
            self.assertIn(("copyleft-in-app", "gpl-peer-runtime", "app"), codes)

        # 2. Resolved permissive peer is included in closure & notices, while absent or dev-only optional peers are excluded
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)

            lock_path = repo / "apps" / "mobile" / "package-lock.json"
            lock_data = json.loads(lock_path.read_text(encoding="utf-8"))
            lock_data["packages"]["node_modules/react"]["peerDependencies"] = {
                "absent-opt-peer": "^1.0.0",
                "dev-opt-gpl-peer": "^1.0.0",
                "resolved-mit-peer": "^2.0.0",
            }
            lock_data["packages"]["node_modules/react"]["peerDependenciesMeta"] = {
                "absent-opt-peer": {"optional": True},
                "dev-opt-gpl-peer": {"optional": True},
            }
            lock_data["packages"]["node_modules/resolved-mit-peer"] = {
                "version": "2.0.0",
                "resolved": "https://registry.npmjs.org/resolved-mit-peer/-/resolved-mit-peer-2.0.0.tgz",
                "license": "MIT",
            }
            lock_data["packages"]["node_modules/dev-opt-gpl-peer"] = {
                "version": "1.0.0",
                "resolved": "https://registry.npmjs.org/dev-opt-gpl-peer/-/dev-opt-gpl-peer-1.0.0.tgz",
                "dev": True,
                "license": "GPL-3.0-only",
            }
            _write_json(lock_path, lock_data)

            report = audit.run_audit(repo, policy_path, python_paths=[site])
            self.assertTrue(report["ok"])
            mobile_names = {item["name"] for item in report["inventory"]["mobileNpm"]}
            self.assertIn("resolved-mit-peer", mobile_names)
            self.assertNotIn("absent-opt-peer", mobile_names)
            self.assertNotIn("dev-opt-gpl-peer", mobile_names)

            notices_path = repo / "apps" / "mobile" / "THIRD_PARTY_NOTICES.md"
            rc = audit.main(["notices", "--repo-root", str(repo), "--policy", str(policy_path), "--write"])
            self.assertEqual(rc, 0)
            rendered = notices_path.read_text(encoding="utf-8")
            self.assertIn("`resolved-mit-peer`", rendered)
            self.assertNotIn("absent-opt-peer", rendered)
            self.assertNotIn("dev-opt-gpl-peer", rendered)

    def test_linked_local_module_hoisted_dependencies_resolved(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)

            _write_json(
                repo / "apps" / "mobile" / "modules" / "local" / "package.json",
                {
                    "name": "@synthetic/local",
                    "version": "0.1.0",
                    "private": True,
                    "dependencies": {"hoisted-gpl-dep": "1.0.0"},
                },
            )
            lock_path = repo / "apps" / "mobile" / "package-lock.json"
            lock_data = json.loads(lock_path.read_text(encoding="utf-8"))
            lock_data["packages"][""]["dependencies"]["@synthetic/local"] = "file:./modules/local"
            lock_data["packages"]["modules/local"] = {
                "version": "0.1.0",
                "dependencies": {"hoisted-gpl-dep": "1.0.0"},
            }
            lock_data["packages"]["node_modules/@synthetic/local"] = {
                "resolved": "modules/local",
                "link": True,
            }
            lock_data["packages"]["node_modules/hoisted-gpl-dep"] = {
                "version": "1.0.0",
                "resolved": "https://registry.npmjs.org/hoisted-gpl-dep/-/hoisted-gpl-dep-1.0.0.tgz",
                "license": "GPL-3.0-only",
            }
            _write_json(lock_path, lock_data)

            report_fail = audit.run_audit(repo, policy_path, python_paths=[site])
            self.assertFalse(report_fail["ok"])
            self.assertIn(
                ("copyleft-in-app", "hoisted-gpl-dep", "app"),
                [(v["code"], v["name"], v["scope"]) for v in report_fail["violations"]],
            )

            # Switch hoisted dep to permissive Apache-2.0 -> passes audit and appears in notices
            lock_data["packages"]["node_modules/hoisted-gpl-dep"]["license"] = "Apache-2.0"
            _write_json(lock_path, lock_data)
            report_ok = audit.run_audit(repo, policy_path, python_paths=[site])
            self.assertTrue(report_ok["ok"])

            notices_path = repo / "apps" / "mobile" / "THIRD_PARTY_NOTICES.md"
            self.assertEqual(
                audit.main(["notices", "--repo-root", str(repo), "--policy", str(policy_path), "--write"]),
                0,
            )
            self.assertIn("`hoisted-gpl-dep`", notices_path.read_text(encoding="utf-8"))

    def test_linked_workspace_production_dependencies_included_in_notices_and_deduplicated(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)

            zod_lic = MIT_TEXT.replace(
                "2026 Synthetic Fixture Contributors",
                "2026 Synthetic Zod Workspace Contributors",
            )
            _write_text(repo / "packages" / "contracts" / "node_modules" / "zod" / "LICENSE", zod_lic)

            # Add both a duplicate mobile package (react@19.0.0) and a dev-only workspace package
            contracts_lock = repo / "packages" / "contracts" / "package-lock.json"
            cdata = json.loads(contracts_lock.read_text(encoding="utf-8"))
            cdata["packages"][""]["dependencies"]["react"] = "19.0.0"
            cdata["packages"][""]["devDependencies"] = {"contracts-dev-linter": "1.0.0"}
            cdata["packages"]["node_modules/react"] = {
                "version": "19.0.0",
                "resolved": "https://registry.npmjs.org/react/-/react-19.0.0.tgz",
                "license": "MIT",
            }
            cdata["packages"]["node_modules/contracts-dev-linter"] = {
                "version": "1.0.0",
                "resolved": "https://registry.npmjs.org/contracts-dev-linter/-/contracts-dev-linter-1.0.0.tgz",
                "dev": True,
                "license": "GPL-3.0-only",
            }
            _write_json(contracts_lock, cdata)

            notices_path = repo / "apps" / "mobile" / "THIRD_PARTY_NOTICES.md"
            self.assertEqual(
                audit.main(["notices", "--repo-root", str(repo), "--policy", str(policy_path), "--write"]),
                0,
            )
            rendered = notices_path.read_text(encoding="utf-8")
            self.assertIn("| `zod` | `4.0.0` | `MIT` |", rendered)
            self.assertIn("2026 Synthetic Zod Workspace Contributors", rendered)
            self.assertNotIn("contracts-dev-linter", rendered)
            self.assertNotIn("`ajv`", rendered)  # server-only companion workspace dep stays excluded
            self.assertEqual(rendered.count("| `react` | `19.0.0` |"), 1)

    def test_python_revisits_distributions_when_additional_extras_accumulate(self) -> None:
        # Subcase A: Direct `geom-kernel` followed by `geom-kernel[mesh]`
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)

            _write_text(
                repo / "tools" / "mesh-helper" / "requirements.txt",
                "geom-kernel==1.4.0\ngeom-kernel[mesh]==1.4.0\n",
            )
            _make_dist_info(
                site,
                dist_name="geom-kernel",
                version="1.4.0",
                licence_header="Apache-2.0",
                requires_dist=['nc-mesh-addon (>=1.0.0) ; extra == "mesh"'],
                top_level="geom_kernel",
            )
            _make_dist_info(
                site,
                dist_name="nc-mesh-addon",
                version="1.0.0",
                licence_header="CC-BY-NC-4.0",
                top_level="nc_mesh_addon",
            )

            report = audit.run_audit(repo, policy_path, python_paths=[site])
            self.assertFalse(report["ok"])
            self.assertIn(
                ("non-commercial-licence", "nc-mesh-addon", "NON-COMMERCIAL"),
                [(v["code"], v["name"], v["licence"]) for v in report["violations"]],
            )
            geom_rows = [
                r
                for r in report["inventory"]["toolPythonRequirements"]
                if r["toolFolder"] == "tools/mesh-helper" and r["name"] == "geom-kernel"
            ]
            self.assertEqual(len(geom_rows), 1)

        # Subcase B: Separate transitive branches requesting distinct extras on the same shared distribution
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)

            _write_text(
                repo / "tools" / "mesh-helper" / "requirements.txt",
                "branch-alpha==1.0.0\nbranch-beta==1.0.0\ngeom-kernel==1.4.0\n",
            )
            _make_dist_info(
                site,
                dist_name="branch-alpha",
                version="1.0.0",
                licence_header="MIT",
                requires_dist=["shared-hub[io] (>=1.0.0)"],
            )
            _make_dist_info(
                site,
                dist_name="branch-beta",
                version="1.0.0",
                licence_header="MIT",
                requires_dist=["shared-hub[gpu] (>=1.0.0)"],
            )
            _make_dist_info(
                site,
                dist_name="shared-hub",
                version="1.0.0",
                licence_header="MIT",
                requires_dist=[
                    'io-codec (>=1.0.0) ; extra == "io"',
                    'gpu-nc-kernel (>=1.0.0) ; extra == "gpu"',
                ],
            )
            _make_dist_info(site, dist_name="io-codec", version="1.0.0", licence_header="MIT")
            _make_dist_info(site, dist_name="gpu-nc-kernel", version="1.0.0", licence_header="CC-BY-NC-4.0")

            report = audit.run_audit(repo, policy_path, python_paths=[site])
            self.assertFalse(report["ok"])
            self.assertIn(
                ("non-commercial-licence", "gpu-nc-kernel", "NON-COMMERCIAL"),
                [(v["code"], v["name"], v["licence"]) for v in report["violations"]],
            )
            hub_rows = [
                r
                for r in report["inventory"]["toolPythonRequirements"]
                if r["toolFolder"] == "tools/mesh-helper" and r["name"] == "shared-hub"
            ]
            self.assertEqual(len(hub_rows), 1)

    def test_pep508_environment_markers_evaluated_completely(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo = base / "repo"
            site = base / "site-packages"
            site.mkdir()
            policy_path = _create_allowed_repo_fixture(repo, site)

            _make_dist_info(
                site,
                dist_name="geom-kernel",
                version="1.4.0",
                licence_header="Apache-2.0",
                requires_dist=[
                    'windows-only-uninstalled (>=1.0) ; sys_platform == "win32"',
                    'legacy-py37-uninstalled (>=1.0) ; python_version < "3.8"',
                    'compound-or-dep (>=1.0) ; sys_platform == "linux" or extra == "mesh"',
                    'modern-py-dep (>=1.0) ; python_version >= "3.8" and sys_platform != "win32"',
                ],
                top_level="geom_kernel",
            )
            _make_dist_info(site, dist_name="compound-or-dep", version="1.0.0", licence_header="MIT")
            _make_dist_info(site, dist_name="modern-py-dep", version="1.0.0", licence_header="BSD-3-Clause")

            linux_env = {
                "os_name": "posix",
                "platform_machine": "x86_64",
                "platform_system": "Linux",
                "python_full_version": "3.12.4",
                "python_version": "3.12",
                "sys_platform": "linux",
            }
            report_ok = audit.run_audit(repo, policy_path, python_paths=[site], marker_env=linux_env)
            self.assertTrue(report_ok["ok"], msg=json.dumps(report_ok["violations"], indent=2))
            py_names = {
                r["name"]
                for r in report_ok["inventory"]["toolPythonRequirements"]
                if r["toolFolder"] == "tools/mesh-helper"
            }
            self.assertIn("compound-or-dep", py_names)
            self.assertIn("modern-py-dep", py_names)
            self.assertNotIn("windows-only-uninstalled", py_names)
            self.assertNotIn("legacy-py37-uninstalled", py_names)

            # On win32, the uninstalled Windows-only dependency IS active and raises unknown-licence
            win_env = dict(linux_env, os_name="nt", platform_system="Windows", sys_platform="win32")
            report_win = audit.run_audit(repo, policy_path, python_paths=[site], marker_env=win_env)
            self.assertFalse(report_win["ok"])
            self.assertIn(
                ("unknown-licence", "windows-only-uninstalled", "UNKNOWN"),
                [(v["code"], v["name"], v["licence"]) for v in report_win["violations"]],
            )


if __name__ == "__main__":
    unittest.main()


class ExtraMarkerNormalisationTests(unittest.TestCase):
    """Connector review on PR #90: membership operators must compare normalised extra names."""

    def test_membership_and_arbitrary_equality_normalise_extra_names(self):
        from inventory import _marker_allows
        active = {"mesh-io"}  # active extras arrive PEP 503-normalised
        self.assertTrue(_marker_allows('extra != "" and extra in "mesh_io"', active))
        self.assertTrue(_marker_allows('extra in "Mesh.IO"', active))
        self.assertFalse(_marker_allows('extra not in "mesh_io"', active))
        self.assertTrue(_marker_allows('extra === "mesh_io"', active))
        self.assertFalse(_marker_allows('extra != "" and extra in "other"', active))
