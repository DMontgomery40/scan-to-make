# Scan repair (preview geometry)

A deterministic, headless Blender first pass for rough phone scans. It repairs
mesh topology, retains declared metric scale, and reports geometric changes.
It cannot recover missing details or establish physical accuracy. Every report
carries `provesPhysicalAccuracy: false`. No slicing or printer dispatch.

## Runtime and licensing

Tested with **Blender 5.0.1**. The Python CLI wrapper uses only the standard
library. The Blender-side core uses Blender's bundled `bpy`, `bmesh` and
`mathutils` (GPL-3.0-or-later), plus its bundled NumPy (BSD-3-Clause). No pip
dependencies are installed. Python itself uses the PSF licence. Blender's
distribution includes additional runtime components under their own licences;
retain those notices when redistributing Blender.

**This entire directory is GPL-3.0-or-later**, including scripts that import
`bpy`; see [LICENSE](LICENSE) and SPDX headers. The repository has no top-level
licence: this grant applies only to this directory. It runs only on the companion
or hosted side and **must never be bundled into the iOS or Android app**.

## Commands

```sh
python3 tools/scan-repair/repair.py repair scan.obj --units m --out /tmp/clean
python3 tools/scan-repair/repair.py measure /tmp/clean/repaired.stl --units mm
python3 tools/scan-repair/repair.py render /tmp/clean/repaired.obj --units mm --out /tmp/views
python3 -m unittest discover -s tools/scan-repair/tests -v
```

Blender discovery: `$BLENDER`, then `PATH`, then
`/Applications/Blender.app/Contents/MacOS/Blender`. An invalid explicit
`BLENDER` fails. Invocation always uses `--background --factory-startup
--python-exit-code 1 --python blender_tool.py -- REQUEST.json`. Blender runs
in a subprocess; stdout contains JSON only. Exit 0 means success, 2 means an
input/runtime/repair error. Tests skip with an explicit message if Blender is
absent; CI installs the pinned Linux release and uses Xvfb/software graphics
for Workbench renders.

All commands require `--units m|cm|mm` **or** `--units-sidecar FILE.json`.
A sidecar must contain `unitsAuthored: true` and positive finite
`metersPerUnit`, matching the capture converter's report. Units are declarations,
not measurements. OBJ comments are not treated as unit authority. Coordinate
basis is preserved on import (including Y-up captures); PCA later chooses a
geometric frame. OBJ and STL inputs are supported; USDZ must first pass through
`tools/capture-mesh-convert`. Repair is intended primarily for OBJ.

### Repair parameters and order

All distances below are in mm, independent of input units.

| Step | Flags and defaults | Behaviour |
| --- | --- | --- |
| Weld | `--weld-mm .01` | Merge vertices within distance |
| Floaters | `--component-fraction .01 --component-metric area` | Drop vertex-connected components whose area is below the fraction of the largest component; `volume` requires closed components |
| Holes | `--hole-max-edges 0` | Fill boundary loops; 0 allows all sizes, positive values bound loop edge count |
| Manifold | `--voxel-size-mm .3`, optional `--force-voxel` | Recalculate normals; use voxel remesh if topology is still open/non-manifold, or explicitly forced |
| Denoise | `--denoise-iterations 15 --denoise-factor .5 --denoise-mu -.53 --denoise-max-mm .35 --sharp-angle-deg 30` | Taubin cycles: a shrinking λ (`factor`) step then an inflating μ step, each moving vertices toward their inverse-edge-length-weighted neighbour average; freeze sharp-edge and boundary vertices; after each whole cycle, clamp cumulative vertex displacement from this step's start |
| Decimate | optional `--target-faces N` | Triangulate, then collapse toward a target triangle count; Blender may not achieve the exact target |
| Orient | always | Vertex-covariance PCA, descending eigenvalues, sign convention and right-handed frame; centre XY bounds and rest lowest vertex at Z=0 |

Denoise cycles are bounded to 0–50, λ to (0, 0.5], μ to [−1, 0), and sharp
angle to 0–90 degrees. The Taubin pass-band 1/λ + 1/μ must lie in (0, 0.2]:
at or below 0 the cycles shrink the mesh, and above 0.2 they amplify noise
(λ .1 with μ −.53 gives 8.1, so every frequency grows). The defaults give 0.113. Inverse edge-length
weights stop long Object Capture fill edges from pulling their vertices, and
clamping whole cycles stops a clipped λ step leaving the μ step to inflate
the vertex. `--denoise-iterations 0` disables denoising. The voxel fallback is bounded to 512 cells along the longest
axis; choose a larger voxel size if rejected. Voxelization and decimation can
erase detail, including sharp features; denoising alone protects the detected
sharp vertices. The fallback runs only when needed unless forced.
Large hole fills can invent surfaces: lower the hole edge limit for cautious
work, then inspect any fallback. There is no universal repair for arbitrary
bad meshes; a final topology failure exits nonzero without a success report.
Use a new output directory per attempt; failed attempts do not clear old files.

Outputs: `repaired.obj` and binary `repaired.stl` both use **mm**, plus
`report.json`. The report records runtime version, input/output SHA-256, units,
all operation parameters, before/after topology, bounds, principal extents,
area (mm²) and volume (mm³). Volume is null for open or inconsistently wound
input. Boundary edges are included in the non-manifold edge count; components
are connected through vertices. “Watertight” means closed edges and consistent
winding; it does **not** rule out intersecting surfaces or certify a printable
solid. Disconnected closed solids may remain above the floater threshold.

Deviation is measured **before orientation**, original → repaired: deterministic
area-stratified triangle samples plus every original vertex, nearest repaired
surface distances. `--deviation-samples 10000` controls surface samples. Mean,
p95 (linear percentile) and max combine both sets, in mm. This is one-sided,
sampled geometric change, not a Hausdorff bound or real-world error.
It can miss newly added bulges and defects between samples. Removed floaters
contribute to the distances.

### Measure and render reuse

`measure` emits the same topology and geometry metrics as the repair report,
including the existing `principalExtentsMm` projected along vertex PCA axes.
`boxExtentsMm` instead uses a minimum-volume oriented-box search: convex-hull
support vertices, PCA seed plus a deterministic 30° rotation sweep, and four
lowest-volume seeds refined by axis rotations down to 0.005°. All original
vertices are enclosed; no outlier trimming or dimension fitting occurs. The
search is bounded (40 descent moves per angular step) and approximate: it does
not certify the global minimum for arbitrary shapes. Extents are ordered long
to short. `boxRotation` is a right-handed world-to-box rotation matrix:
`boxPoint = boxRotation @ (inputPoint - boxInputCentreMm)`. Axis signs follow
the PCA sign convention; symmetric shapes may have equivalent frames.
PCA metrics and repair orientation remain unchanged for compatibility.
Surface area and volume
describe the mesh only. Closed components with opposing winding can cancel
signed volumes; intersecting solids can overcount. No semantic upright or
physical dimensions are inferred.

`render` produces `pos_x/y/z.png`, `neg_x/y/z.png` and four upper isometric
views (`iso_pp/np/nn/pn.png`). By default it preserves input coordinates and
axes, also explicitly selectable with `--keep-orientation`. Use this for already
oriented parts, including pocket-up cradles. `--pca-orientation` opts into the
previous PCA/ground frame. No semantic upright detection is attempted. The
JSON result records `orientation` and the applied `transform` (null when kept).
Both modes use orthographic
cameras, neutral studio Workbench shading, no shadows/specular highlights and
fixed **512×512** resolution (`--resolution 16..4096` for explicit overrides).
PNG timestamp/render-duration metadata is removed losslessly. Renders use
a common enclosing sphere scale across all ten cameras. These views are
reusable by a later photo-guided repair step; they do not perform photo matching.

JSON uses sorted keys and no timestamps. Identical inputs/parameters on the
same pinned Blender/runtime produce identical reports and output hashes in
the tests. GPU drivers, Blender builds, numeric libraries and platforms may
change floating-point geometry or rasterization. PCA is ambiguous for symmetric
or nearly symmetric objects, sensitive to vertex density, and can rotate or
flip the perceived object orientation. Compare principal extents or transform
frames, not raw axis bounds before versus after orientation.

## Verification

Only synthetic fixtures are generated in temporary directories: cube with a
floater, sphere with open poles, noisy sharp box, non-manifold join, and
metres/mm versions, a 5°-rotated box with uneven tessellation, and an
asymmetric oriented part. The box test checks true extents within 0.05 mm and
independently projects its vertices using the reported rotation; render tests
compare default/explicit preservation against PCA. Tests exercise actual Blender, hashes/repeatability,
topology, volume, unit declarations/sidecars, STL framing, decimation and all
ten PNGs. CI downloads Blender 5.0.1 from download.blender.org and verifies the
archive against Blender's published `blender-5.0.1.sha256` file before caching.
Personal captures, outputs and their private paths never belong in Git.
