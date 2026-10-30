# Licence Audit & Third-Party Notices (`tools/licence-audit`)

Automated licence-compliance audit and `THIRD_PARTY_NOTICES.md` generator for Scan to Make.

This directory is **MIT** licensed; see [LICENSE](LICENSE). Implementation uses **Python 3.11+ standard library only** (no third-party pip dependencies).

## What It Checks

1. **`apps/mobile` (`app` scope)**
   - Production npm dependency closure from `apps/mobile/package-lock.json` and installed `node_modules` metadata/licence files (dev-only dependencies are excluded).
   - Native iOS CocoaPods from `apps/mobile/ios/Podfile.lock`, resolving real podspecs (including React Native's `rncore_facades.rb` / `rndeps_facades.rb` real third-party podspecs, codegen podspec templates, local module `LICENSE.txt` files, and checksum-pinned `verifiedCocoaPodsSpecs` in `policy.json`).
2. **`services/**` and `packages/**` (`server` / shared `app` scope)**
   - All locked npm dependencies across `services/**/package-lock.json` and `packages/**/package-lock.json` (production dependencies of workspace packages imported by `apps/mobile` are enforced against the `app` allowlist).
3. **`tools/**` (`server` scope + isolation boundary)**
   - Each concrete `tools/*` (and `tools/templates/*`) folder's own declared `LICENSE`.
   - Declared Python requirements (`requirements*.txt`, `pyproject.toml`, `uv.lock`, `pylock.toml`, `Pipfile.lock`) and their full transitive `Requires-Dist` closure in installed `.dist-info` metadata, including embedded `LICENSE*` clause scanning to catch hidden non-commercial sub-dependencies behind permissive wrappers.
   - AST import checks on `.py` files to flag undeclared third-party imports.
   - Cross-boundary check flagging any file under `apps/` that imports, references, or bundles a GPL/LGPL/AGPL `tools/` folder.

## Policy (`policy.json`)

- **`allowlists.app`**: `0BSD`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `BSL-1.0`, `ISC`, `MIT`, `MPL-2.0`, `Unlicense`, `Zlib`.
- **`allowlists.server`**: Same permissive set plus `PSF-2.0` / `Python-2.0`.
- **`isolatedGplTools`**: Permits `GPL-3.0-only` / `GPL-3.0-or-later` **only** for explicitly listed isolated server process folders (`tools/scan-repair`, `tools/templates/scan-cradle`), and never if imported from `apps/`.
- **`denied`**: Blocks `GPL`/`LGPL` in `app`, `AGPL` everywhere, `NON-COMMERCIAL` everywhere, and `UNKNOWN` everywhere unless explicitly listed in `exemptions` with a non-empty `reason`.

## Usage

Run the repository licence audit (deterministic sorted JSON on stdout, exit `0` when compliant, `1` on violations, `2` on usage/config error):

```sh
python3 tools/licence-audit/audit.py audit
python3 tools/licence-audit/audit.py audit --out /tmp/licence-audit-report.json
```

Regenerate or check `apps/mobile/THIRD_PARTY_NOTICES.md`:

```sh
python3 tools/licence-audit/audit.py notices --write
python3 tools/licence-audit/audit.py notices --check
```

Run synthetic fixture unit tests:

```sh
python3 -m unittest discover -s tools/licence-audit/tests -v
```
