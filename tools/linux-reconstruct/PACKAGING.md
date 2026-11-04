# Packaging linux-reconstruct

The machine-readable manifest is [`packaging-manifest.json`](packaging-manifest.json);
the builder is [`packaging/build-linux-payload.sh`](packaging/build-linux-payload.sh).
This page records decisions and corrections. The payload is **built and
verified** on Ubuntu 26.04 x86_64; it is not yet shipped inside a
Counterpart `.deb`/AppImage — apps/linux consumes it through
`RECONSTRUCTION_PAYLOAD` in `tools/linux-host/prepare-payload.sh`, which
copies it to `Payload/reconstruction/` and re-runs its relocated check.
The build id for siblings to pin is the payload's `BUILD-ID` file
(`reconstruction-<toolVersion>-g<commit12>-linux-x64`).

## Corrections to the earlier draft manifest

- The `7104ae…` hash is the official OpenMVS **Ubuntu binary zip**, not a
  source archive. The corresponding v2.4.0 source tarball (separate hash)
  ships in `licenses/` to satisfy AGPL source duties for those binaries.
- usd-core is **not** "Apache-2.0": the exact shipped wheel declares
  `LicenseRef-TOST-1.0` with its full `LICENSE.txt`; notices are extracted
  from the shipped wheels at build time, never retyped.
- Pillow's shipped wheel declares `MIT-CMU`, not a generic HPND.

## Closure choices

- **COLMAP** comes from the Ubuntu 26.04 archive at exact pins
  (`packaging/colmap-packages.txt`: name, version, .deb SHA-256 — COLMAP
  plus every package owning a library in its `ldd` closure, plus
  `libposelib`, which the package links but does not declare). Each .deb
  is hash-verified, extracted with `dpkg -x` — downloaded, never
  installed — and run through a wrapper setting `LD_LIBRARY_PATH` and
  `QT_QPA_PLATFORM=offscreen`. The build then proves closure strictly:
  with only the payload's library paths, every needed library of every
  shipped binary must resolve inside the payload, except the documented
  Ubuntu 26.04 glibc baseline (ld-linux, libc/libm/libdl/libpthread/
  librt/libutil/libresolv). A resolution into the build host's `/usr/lib`
  fails the build. Debian copyright files ship in `licenses/debian/`.
- **OpenMVS** official binaries are nearly static (libgomp/libstdc++/
  libgcc_s + glibc); the GCC runtimes ship in `lib/` from the same .deb
  closure.
- **Python** is the pinned astral standalone CPython (hash matches the
  GitHub release digest) with usd-core 26.8 + Pillow 13.0.0 from
  hash-pinned wheels. No system Python, no `pip install` at runtime: a
  shipped install needs no terminal.
- **Mac** needs no second closure: `qualify` runs under the already-audited
  Mac payload Python (standalone CPython 3.12 + Pillow 13 + usd-core 26.8
  from `apps/mac/distribution.json`). The tool source joined the payload
  via `sourcePaths`, and its committed launcher resolves
  `Payload/python/bin/python3` relative to itself. COLMAP/OpenMVS are
  never part of the Mac payload.

## Readiness, not presence

`linux-reconstruct check --mode samples|qualify` is the bounded evidence
probe (imports the exact USD modules qualification loads — Gf, Usd,
UsdGeom, UsdUtils, Vt; samples also launches COLMAP/OpenMVS `--help`).
The companion's `reconstructionReviewV1` capability is its cached
result — per packaged BUILD-ID (mtime fallback for unpackaged
checkouts), failures re-probed after 30 s and never cached as success,
probed with the companion-supplied environment and drained stderr — so
health requests do not spawn probes, and a broken closure reports false
with an actionable error instead of advertising support.

## Updating

Bump one pin at a time in the build script, rebuild, keep the relocated
`env -i` check + smoke green, and update the manifest (hashes, versions,
BUILD-ID) in the same commit.
