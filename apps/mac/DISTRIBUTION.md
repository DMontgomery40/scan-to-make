# Mac distribution inventory

The inventory in `distribution.json` drives every runtime download and the
source archive whitelist. Download SHA-256 values are checked before extraction
or wheel installation. The original runtime binaries and Python wheels are not
modified except for code signing; compiled bytecode is prepared before signing.

| Component | Distribution and notice evidence |
|---|---|
| Node 24.22.2 | Official Darwin arm64 archive; MIT primary licence. `Licenses/Node.txt` is the full upstream notice, including embedded dependencies. npm/npx/corepack and their vendored dependency tree are removed after the build. |
| CPython 3.12.16, standalone build 20261026 | Python-2.0 / CNRI-Python plus the permissive library licences declared in the matching full archive's `PYTHON.json`. The retained `Licenses/python/` files cover libedit (not GNU readline), libffi, ncurses, bzip2, mpdecimal, OpenSSL, liblzma, SQLite, zlib, Tcl/Tk, libuuid and expat. SQLite's retained public-domain dedication is named `LicenseRef-SQLite-Public-Domain`. pip/ensurepip and their vendored dependency trees are removed after installing the approved wheels. |
| Sparkle 2.9.3 | Exact Swift package revision; MIT plus BSD-2-Clause and Zlib notices in its complete upstream LICENSE. |
| Pillow 13.0.0 | Exact cp312 macOS arm64 wheel; MIT-CMU primary licence. The full wheel notice retains its bundled native dependency notices. For FreeType, select the FreeType License option: this software is based in part on the work of the FreeType Team. This software is based in part on the work of the Independent JPEG Group. |
| OpenUSD 26.8 | Exact cp312 macOS universal2 wheel; Tomorrow Open Source Technology License 1.0 (`LicenseRef-TOST-1.0`), not plain Apache-2.0. The full wheel licence retains its embedded third-party notices. Used by the companion's separate Python conversion process. |
| Companion npm packages | Production lockfile closure only, validated by the repository's existing npm inventory. Each package's real licence text and source URL are included in generated notices. |
| Capture conversion/pipeline/fit tools | First-party repository sources from the same committed snapshot; preserve their source and existing repository licence treatment. No cleanup worker is copied. |
| mac-reconstruct | First-party MIT-licensed Swift helper, built from the same extracted source archive as the companion. Its source and licence ship under `Payload/source/tools/mac-reconstruct`; `bin/mac-reconstruct` is the only permitted helper executable. It uses Apple's system frameworks. |

Composite expressions include bundled libraries, not only the wrapper licence.
Node selects BSD-2-Clause for HdrHistogram and MIT for ada/simdutf. Pillow selects
FTL for FreeType. ICU Autoconf scripts and RapidJSON jsonchecker are not runtime
components; the payload check rejects them rather than allowlisting their licences.

The additional permissive licence identifiers apply only to the explicit `mac`
distribution scope. Mobile/server allowlists and the global check prohibiting
app references to GPL tool folders are unchanged. GPL/LGPL/AGPL, unknown and
non-commercial runtime licences remain denied. There is no broad exception for
code that happens to run as a subprocess.

## External cleanup workers (L06)

The GPL-3.0-or-later `tools/scan-repair` and `tools/scan-correct` sources stay in
the independent companion installation. The Mac app does not copy or download
them. The `pillow-heif` 1.8.1 wheel is also excluded: its wheel notice declares
GPLv2 binaries and LGPLv3 libheif/libde265, despite the wrapper's BSD-3-Clause
metadata. A new app-owned installation therefore needs separately installed
cleanup workers to provide repair/correction. Capture conversion still works
with the two approved wheels.

The user-run [independent worker installer](../../deploy/companion/README.md#independent-workers-for-the-signed-counterpart-mac-app)
can provision those workers from an exact local source commit into a separate
private directory, using an existing Python 3.12 and Blender 5.0.1. It retains
worker source/licenses and wheel download receipts, qualifies the existing
HEIC/network-isolation/cleanup tests, and optionally attaches only their paths to
the app's `companion.env`. It does not modify the app payload or install another
companion service. The legacy full companion installer remains a different path.

Blender is not bundled or fetched by this app. An existing worker installation
can invoke the unmodified Blender CLI in a separate process, matching PRD L06.
The independently installed worker's licence/source obligations remain with that
distribution. Bambu's proprietary networking plug-in is never included here.

Migration records only explicit worker executable paths from the legacy
launcher's quoted exports, without evaluating it or copying credentials. It
retains the external Python environment and old release, so existing cleanup
capability is not silently replaced with the smaller app payload. These paths
can also be set explicitly in `companion.env`.

## Reproduce the checks

Install the same workspace lockfiles and Python metadata as the licence CI job,
then run:

```sh
python3 tools/licence-audit/audit.py audit --out /tmp/licence-audit.json
python3 tools/licence-audit/mac_distribution.py --write-notices
python3 -m unittest discover -s tools/licence-audit/tests -v
```

`audit` checks notice freshness; only use `--write-notices` when intentionally
updating dependencies. Regenerate notices and re-review upstream texts/checksums
when a pin changes. Do not relabel a composite wheel as its wrapper's licence.
All full upstream notices are included, not replaced with links alone.

The payload builder and Xcode embed phase additionally invoke
`mac_distribution.py --payload <path>`. That check rejects stale worker folders,
extra runtimes, package-manager trees, undeclared wheels, mismatched licence
texts and unlisted/disallowed npm packages. Embedding replaces the destination
payload instead of merging it, so removed packages cannot survive an incremental
build.
