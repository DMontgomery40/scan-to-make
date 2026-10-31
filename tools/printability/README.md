# Printability analyzer (`tools/printability`)

Deterministic pre-slice mesh checker for preview STLs produced by Scan to Make templates (`scan-cradle`, `drawer-organizer`, and compatible STL + manifest outputs). It covers what `bambu-printer-mcp` does not: watertightness, bed fit with keep-out zones, base stability, wall thickness and overhangs.

**Slicing, orientation and printing are not done here.** They go through `bambu-printer-mcp`: `slice_stl` (bed type, nozzle type, `orient`, `arrange`, sliced 3MF export), `lay_flat`, `inspect_print_file` and `print_3mf`. See [docs/print-path.md](../../docs/print-path.md). This tool's former `dry-run` slicer duplicated `slice_stl` and was removed; `tools/slicer-producer` is removed with the companion re-route (#97).

It never authorises dispatch, and never claims physical fit or structural strength. Every report carries `dispatchAuthorized: false` and `provesPhysicalFit: false`.

## Licence decision and runtime

This directory is licensed under **MIT** (see [LICENSE](LICENSE) and `SPDX-License-Identifier: MIT` headers).

- **Why MIT + Python/NumPy with no Blender:** Every required printability check operates directly on the triangulated STL surface in millimetres (signed tetrahedral volume and first moments, directed half-edge manifold audit, 2D monotone-chain support hull, 3D uniform-grid Amanatides–Woo DDA ray-cast thickness, and surface-normal overhang clustering). None of those require mesh repair or boolean constructive solid geometry, so introducing headless Blender (`GPL-3.0-or-later`) is unnecessary. Keeping `tools/printability` permissive avoids any GPL boundary when invoked by host services.
- **Runtime:** Python 3.11+ standard library, with optional `numpy` (`BSD-3-Clause`) vectorised parsing and metric acceleration when installed. Both execution paths coerce STL float32 facets to IEEE-754 `float64` and reduce areas, volumes, and moments in facet order via `math.fsum`, producing **byte-identical JSON** whether `numpy` is installed or not.

## Printer profiles (`profiles.json`)

Profiles are declarative data in [profiles.json](profiles.json) (`schema: "scan-to-make.printer-profiles/0.1.0"`):

- **Operator hardware baseline (`p1s-0.4-hardened`):** Discovered read-only from the local `bambu-printer-mcp` configuration and field notes without touching any printer — **Bambu Lab P1S** (`256 × 256 × 250 mm`, front-left filament cutter exclusion zone `[0, 18] × [0, 28] mm`), **0.4 mm `hardened_steel` standard-flow nozzle**, and **`textured_plate`** (Textured PEI Plate).
- **Included Bambu profiles:** `p1s-0.4-hardened`, `p1s-0.4-stainless`, `p1s-0.2`, `p1s-0.6`, `p1p-0.4`, `p2s-0.4`, `x1c-0.4`, `x1c-0.6`, `x1e-0.4`, `a1-0.4`, `a1-0.2`, `a1mini-0.4`, `a1mini-0.2`, `h2d-0.4`, and `h2s-0.4`.
- Each profile records the bed size, keep-out zones, nozzle, `bedType` and `nozzleType` the checks use. Pass the same `bedType` and `nozzleType` to `slice_stl` (`bed_type`, `nozzle_type`) so the sliced file matches the printer.

## CLI usage

```sh
# List bundled Bambu printer profiles (JSON)
python3 tools/printability/printability.py profiles

# Evaluate an STL against an explicit printer profile
python3 tools/printability/printability.py check model.stl \
  --profile p1s-0.4-hardened \
  --material PLA \
  --out /tmp/printability.json

```

Exit codes:
- `0`: command succeeded (`check` without `--strict` exits `0` for any valid mesh report so callers can inspect `verdict`).
- `2`: invalid arguments, unreadable/corrupt STL, or failed `--strict` verdict (`not-printable`, or `printable-with-supports` without `--allow-supports`).

## Geometric checks and deterministic verdict

Inputs are capped at 32 MiB and 500,000 facets, matching the companion's `readVerifiedStl` intake, so anything that passes here can also be prepared there. `check` requires an explicit `--profile` or `--profile-file`.

Given an ASCII or binary STL in millimetres and an explicit profile, [analyzer.py](analyzer.py) emits `schema: "scan-to-make.printability/0.1.0"` with `verdict` in `{"printable", "printable-with-supports", "not-printable"}`:

| Check | Method | Gate |
| --- | --- | --- |
| Topology & normals | Directed half-edge manifold audit (quantised `1e-5 mm`), non-degenerate triangle check, positive signed volume, and declared STL normal check | Open, non-manifold, degenerate, inside-out, or corrupt-normal meshes → `not-printable` |
| Bed fit | Axis-aligned extents against `bedMm` (`x`, `y`, `z`), optional 90° Z rotation, and placement search avoiding `excludeZonesMm` (e.g. P1S `[0, 18] × [0, 28] mm` cutter keep-out). Absolute STL coordinates are deliberately ignored: `slice_stl` arranges STL input on the plate by default, which re-places the part and drops it to the bed. | Exceeds X/Y footprint, Z height, or unavoidable exclude zone → `not-printable` |
| Flat base & stability | Downward facets within 5° of straight down (`nz <= -cos 5°`) and within `0.05 mm` of `zMin`, 2D convex support hull, exact tetrahedral solid centre of mass `(cx, cy, cz)` projection, and minimum static tipping angle `atan2(margin, cz - zMin)` | Flat base `< 9 mm²` or `< 2%` of the footprint, CoM outside support hull, or tipping angle `< 10°` → `not-printable` |
| Minimum wall vs nozzle | Deterministic 2-point centroid-blended sampling across non-horizontal facets (up to `8000` strided samples by default) + 3D uniform-grid DDA ray casting along inward 3D surface normal and XY slice plane; if no opposing wall is hit, `minWallMm` falls back to the smallest extent (`minWallMode: bounds-fallback`) | Global minimum wall `< nozzleDiameterMm` → `not-printable`; `< 2 × nozzleDiameterMm` emits a `single-perimeter-thin-wall` warning |
| Overhangs (`> 45°`) | Downward tilt angle `asin(-nz) > 45°` above the base layer (`zMax > zMin + 0.30 mm`), reporting percentage of total surface area and connected spatial region bounding boxes/centroids | Overhang area `>= 10 mm²`, or `>= 1%` of the surface, or any region `>= 4 mm²` steeper than `55°` → `printable-with-supports` (assuming printable otherwise); smaller local overhangs stay `printable` with a `minor-localized-overhang` warning |
| Volume & filament | Exact mesh solid volume (`mm³`/`cm³`), solid 100%-infill filament upper bound (`mm`, `m`, `g`), and pre-slice 2-wall + 15%-infill FFF estimate for `PLA` (`1.26 g/cm³` Bambu PLA Basic default), `PETG`, `TPU`, `ABS`, or `ASA` | Informational pre-slice estimate; actual extrusion comes from the sliced file |

## Tests

All fixtures in [tests/test_printability.py](tests/test_printability.py) are generated synthetically in memory (cube, pocketed cradle block, cantilevered 60° overhang piece, plus oversized, cutter-blocked, thin-wall, unstable-CoM, open-mesh, and corrupt-normal negative cases).

```sh
python3 -m unittest discover -s tools/printability/tests -v
```
