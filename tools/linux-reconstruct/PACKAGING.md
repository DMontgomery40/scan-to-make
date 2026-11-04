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

- **COLMAP** comes from the Ubuntu 26.04 archive: the pinned package list
  (COLMAP plus every package owning a library in its `ldd` closure) is
  downloaded and extracted with `dpkg -x` — downloaded, never installed —
  and run through a wrapper setting `LD_LIBRARY_PATH` and
  `QT_QPA_PLATFORM=offscreen`. Debian copyright files for the closure ship
  in `licenses/debian/`. Supported target is stated honestly: Ubuntu
  26.04 x86_64, host provides glibc/ld-linux only.
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
probe (imports USD; samples also launches COLMAP/OpenMVS `--help`). The
companion's `reconstructionReviewV1` capability is its cached result —
per binary path+mtime, failures re-probed after 30 s and never cached as
success — so health requests do not spawn probes, and a broken closure
reports false with an actionable error instead of advertising support.

## Updating

Bump one pin at a time in the build script, rebuild, keep the relocated
`env -i` check + smoke green, and update the manifest (hashes, versions,
BUILD-ID) in the same commit.
