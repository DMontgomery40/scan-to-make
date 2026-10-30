# Capture mesh convert (offline USDZ -> OBJ)

`convert.py` converts a `.usdz` / `.usdc` / `.usda` stage into a single OBJ plus a JSON report (and MTL/PNG assets when a base-colour material is present), so captures can enter `tools/capture-fit-eval` (FIT006). It uses the real USD runtime (`usd-core`, `pxr`), which reads packaged binary USDC; no USDC parsing is hand-rolled.

## Setup

```sh
python3 -m venv .venv
.venv/bin/pip install -r tools/capture-mesh-convert/requirements.txt
# tested with usd-core 26.8 and Pillow 13.0.0
```

## Usage

```sh
.venv/bin/python tools/capture-mesh-convert/convert.py capture.usdz --out capture.obj --report capture.json
```

Exit codes: `0` = converted and metric-qualified, `4` = converted but **not** metric-qualified (units not authored or unsupported features), `2` = error.

Feed FIT006 with units derived from the report's `metersPerUnit` (0.01 -> `cm`, 1.0 -> `m`, 0.001 -> `mm`), only when `unitsAuthored` is true:

```sh
python3 tools/capture-fit-eval/evaluate.py evaluate capture.obj --units cm --held-out x=.. --held-out y=.. --held-out z=..
```

## What it does

- Each mesh's points are transformed by `ComputeLocalToWorldTransform` (the full composed hierarchy, applied exactly once) into world space.
- Coordinates are native stage units, never rescaled, re-oriented, or fitted. The output basis equals the stage basis (`outputBasis` in the report: stage `upAxis`, `metersPerUnit`, right-handed, CCW front faces).
- Winding is reversed when the world transform has negative determinant XOR the mesh is authored `leftHanded`.
- Output faces are triangles only: each polygon is ear-clipped on its face plane (Newell normal) using only its own vertices. Every face, triangles included, is validated first. Faces are rejected when they are degenerate (zero area or collinear: Newell normal below 1e-9 x extent²), nonplanar (any vertex more than 1e-6 x extent off the best-fit plane), or not ear-clippable (self-intersecting). Rejected faces are not emitted and are flagged `untriangulatablePolygon` with a reason for each face, which means the result is not metric-qualified.
- Rejected with exit `2` and **no output written**:
  - `metersPerUnit` that is not positive and finite
  - non-finite points or composed transforms
  - invalid topology (counts don't sum to the index length, or an index is out of range)
  - asset-boundary violations: any unresolved dependency, or any reference, sublayer, payload or asset outside the source package
- Every contributing layer is hashed in `contributingLayers`. For a `.usdz`, that means each packaged entry, resolved with `Ar.SplitPackageRelativePathOuter`. A multi-layer package (for example root.usdc referencing ./mesh.usdc) gets a hash for each layer.
- Multiple meshes are written as separate `o` groups into one OBJ. UVs use separate `vt` indices per authored face corner, so UV seams survive ear clipping and winding reversal. Indexed/unindexed `faceVarying`, `vertex`, `varying`, `uniform` and `constant` float2 UVs are expanded through the USD runtime. Inherited primvars and materials are supported. No V flip is applied: USD and OBJ UVs both use the lower-left image origin.
- Base colour follows the bound `UsdPreviewSurface.diffuseColor` → `UsdUVTexture.rgb` → `UsdPrimvarReader_float2.result` graph (including a literal material interface supplying the UV name). Constant diffuse colours become MTL `Kd`. Textures become `map_Kd` and sibling `<stem>_basecolor_N.png`; the OBJ references `<stem>.mtl`. Auxiliary stems are sanitized to ASCII letters/digits/underscore/hyphen. Each mesh has its own material assignment, with an explicit reset for unbound meshes.
- Texture reads reuse the existing source-package boundary check. PNGs are decoded for validation, then copied byte-for-byte; other Pillow-readable images (including JPEG) become PNG without rotating image pixels or changing UVs. Pillow is imported only for textured materials; untextured conversion still requires only `usd-core`.
- `outputs` hashes every emitted geometry/material/image asset (SHA-256 and byte size). Existing singular `output` remains the OBJ receipt for compatibility. `materials` records material prim, source asset, image dimensions/format and texture output. The JSON report does not hash itself. Packaged texture dependencies are included in `contributingLayers`, alongside all existing layer hashes. All validation and texture decoding finish before any asset is written.
- Report: `metersPerUnit`, `unitsAuthored`, `upAxis`, `upAxisAuthored`, `outputBasis`, SHA-256 + byte size of source and output, per-mesh determinant/winding, `unsupportedFeatures`, `warnings`, `metricQualified`, and `provesCompleteCapture: false`, `provesPhysicalFit: false`.

## Limits (explicit, never silent)

- Missing `metersPerUnit`: USD fallback (0.01) is reported but `unitsAuthored: false`, `metricQualified: false`.
- Subdivision policy (`subdivisionPolicy`: `explicit-none-only`): per OpenUSD, an unauthored `subdivisionScheme` means `catmullClark`, a subdivision surface rather than a polygon mesh. Only an explicitly authored `none` is polygonal. Any other scheme, authored or not, exports the control cage and is flagged unsupported (not metric-qualified). `meshes[].subdivisionSchemeAuthored` records which case applied.
- `holeIndices`: hole faces are omitted from the OBJ (never emitted as merged n-gons) and flagged unsupported.
- Time-sampled `points`, `faceVertexCounts`, `faceVertexIndices`, `holeIndices`, `orientation`, or `subdivisionScheme`: default time used, flagged unsupported.
- Skipped and listed in `skippedPrims` (not unsupported, not exported): inactive prims (and their subtree), meshes whose computed purpose is `guide`, `proxy`, or `render` (only `default` purpose is exported), and invisible meshes.
- Native instancing, PointInstancers, and non-Mesh gprims: not exported, flagged unsupported.
- Animated transforms: default time used, flagged unsupported.
- Faces with <3 vertices are skipped with a warning; `meshes[].faces` counts only faces written (`authoredFaces` is the source count).
- A missing `usd-core` / `pxr` exits `2` with `error: USD runtime unavailable ...`.
- Omitted `wrapS`/`wrapT` mean `useMetadata`, not repeat. Wrap strings exposed by Pillow's image metadata (including PNG text fields) are resolved; missing metadata falls back to black per Preview Surface. Black/repeat combinations retain the PNG/UVs but use MTL repeat with an explicit `warnings` entry and per-material `textureWarnings`/`wrapModes`. UVs outside [0,1] on an axis requiring black additionally produce `textureWrapping` in `unsupportedFeatures` (exit `4`, not qualified). Even in-range UVs retain the warning because border filtering can differ. This is a reported approximation, not a faithful black-border sampler.
- Invalid/non-finite UVs, invalid UV indices/cardinality, missing required UVs, or corrupt images exit `2` before writing assets. Report/source/asset path collisions are rejected. Use a fresh output directory: validation failures do not remove files from earlier runs, and filesystem write failures can leave partial outputs.
- Unsupported material/UV features are listed as `baseColour` in `unsupportedFeatures` (exit `4`, geometry exported without that material/UV set): per-face material subsets, arbitrary shader graphs/UV transforms, non-identity texture scale/bias, time-sampled base-colour/UV inputs, raw/linear texture colour space, UDIMs and wrapping combinations other than repeat/repeat, clamp/clamp or black/repeat combinations. Unresolved UDIM dependencies may instead fail the existing asset-boundary check (exit `2`). This exports base colour only: normals, opacity shader connections, normal/roughness/metalness maps and other primvars are not exported. PNG alpha bytes survive but are not wired to MTL opacity.
- No hole filling, size fitting, or claims about capture completeness or physical fit.

## Tests (local-only)

Fixtures are generated programmatically with `pxr` (`make_fixtures.py`) as `.usdz` packages containing binary USDC: nested rotate+scale with two meshes, a reflected (`scale(-1,1,1)`) transform, no units authored, authored and unauthored subdivision, hole faces plus a degenerate face, guide/proxy/render/inactive prims, and time-sampled topology, a NaN point, an out-of-range index, metersPerUnit=0, an absolute external reference, an unresolved reference, a nonplanar quad, a collinear triangle, a two-layer binary package, and a concave L-shaped polygon (triangle area sum = polygon area, all triangles inside). A test also simulates a missing `pxr` (exit 2). Tests decode the OBJ independently (no `pxr`), check bounds against hand-derived values and signed volume (winding), and run FIT006 on one output.

```sh
.venv/bin/python -m unittest discover -s tools/capture-mesh-convert/tests -v
```

Additional synthetic textured USDC packages test indexed seams, all five UV interpolation modes, inherited material/UV data, connected UV-name interfaces, reflected winding, concave triangulation, omitted-hole corner offsets, multiple meshes/material resets, PNG byte identity, JPEG pixel identity, all output/dependency hashes and repeatability. Invalid UV/image/asset inputs and failures on later meshes write no new assets. No private captures are used.

An optional Blender 5.0.1 integration check imports the serialized OBJ/MTL/PNG and verifies the UV loop count and linked 2×2 texture:

```sh
BLENDER=$HOME/opt/blender-5.0.1/blender .venv/bin/python -m unittest discover -s tools/capture-mesh-convert/tests -v
```

The supported graph and UV conventions follow the [OpenUSD Preview Surface specification](https://openusd.org/dev/spec_usdpreviewsurface.html) and [primvar interpolation rules](https://openusd.org/dev/user_guides/primvars.html).

CI: the capture-tools workflow installs pinned `usd-core` and Pillow and runs the converter and downstream suites, including texture regressions. Texture tests skip explicitly if Pillow is absent locally; the Blender import test skips explicitly if `BLENDER` is unset. Run the full command above with pinned Blender to include the serialized import check.
