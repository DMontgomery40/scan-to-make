# Packaging linux-reconstruct

The machine-readable manifest is [`packaging-manifest.json`](packaging-manifest.json)
(versions, licences, source pins, layout, install steps, smoke checks).
This page records the decisions behind it. **Nothing is bundled yet**: no
binaries are committed, and the `.deb`/AppImage and on-device installer work
belongs to the apps/linux and tools/linux-host scopes. Until an actual
package runs the manifest's verification steps on a clean machine, the
companion's `reconstructionReviewV1` capability only reflects tool presence
(launcher found on the host), and a missing USD runtime fails a run plainly
rather than silently — release packaging should gate the capability on the
smoke receipt, not on files.

## Why these components

- **COLMAP 3.12.6 (BSD-3)** does CPU sparse reconstruction. The tool pins
  the CPU path (`--SiftExtraction.use_gpu 0`), so a GPU is never required
  and the distro package is preferred over a bundled build.
- **OpenMVS 2.4.0 (AGPL-3.0)** densifies and meshes. It is invoked as
  separate processes, but shipping its binaries still carries AGPL duties:
  the exact source (pinned archive, SHA-256 in the manifest) plus a written
  offer must accompany the package, and the build receipt (compiler, flags,
  distro dependency versions) is part of that offer's exactness.
- **Python ≥3.11 + usd-core 26.8 (Apache-2.0)** run this tool and nothing
  else. The venv lives inside the tool directory and is created at install
  time; the system interpreter is never modified.
- **Pillow is not ours**: the companion's stills/photo helpers need it under
  the companion's Python. It is listed in the manifest so the combined
  installer accounts for it once, in the companion's payload — this tool's
  `requirements.txt` stays usd-core only, and image headers are parsed with
  the standard library.

## Layout and discovery

One prefix holds the tool source, its `.venv`, `openmvs/` and optionally
`bin/colmap`. The companion finds the launcher via
`SCAN_TO_MAKE_LINUX_RECONSTRUCT`, OpenMVS via `SCAN_TO_MAKE_OPENMVS_DIR`,
COLMAP via `SCAN_TO_MAKE_COLMAP` or `PATH` — no paths are compiled in, so
the same payload works for the Linux app, a Mac checkout (qualify mode
only), and ad-hoc SSH hosts. On a Mac, only `qualify` is used (Apple does
the reconstruction); COLMAP/OpenMVS are not needed there, but the same
launcher + venv layout applies.

## Updating

Bump one pinned component at a time, rerun the manifest's verification
(unit tests plus the exit-5 smoke on a fixture capture), and update the
manifest in the same commit. A version that has only been built, not
smoke-run, must not be recorded as verified.
