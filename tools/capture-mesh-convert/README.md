# Capture mesh convert (offline USDZ -> OBJ)

`convert.py` converts a `.usdz` / `.usdc` / `.usda` stage into a single OBJ plus a JSON report, so captures can enter `tools/capture-fit-eval` (FIT006). It uses the real USD runtime (`usd-core`, `pxr`), which reads packaged binary USDC; no USDC parsing is hand-rolled.

## Setup

```sh
python3 -m venv .venv && .venv/bin/pip install usd-core   # tested with usd-core 26.8
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
- Multiple meshes are written as separate `o` groups into one OBJ.
- Report: `metersPerUnit`, `unitsAuthored`, `upAxis`, `upAxisAuthored`, `outputBasis`, SHA-256 + byte size of source and output, per-mesh determinant/winding, `unsupportedFeatures`, `warnings`, `metricQualified`, and `provesCompleteCapture: false`, `provesPhysicalFit: false`.

## Limits (explicit, never silent)

- Missing `metersPerUnit`: USD fallback (0.01) is reported but `unitsAuthored: false`, `metricQualified: false`.
- `subdivisionScheme` other than `none` (USD's default is `catmullClark`): control cage exported, flagged unsupported.
- Native instancing, PointInstancers, and non-Mesh gprims: not exported, flagged unsupported.
- Animated points/transforms: default time used, flagged unsupported.
- Invisible meshes and <3-vertex faces skipped with a warning.
- Normals, UVs, materials, and primvars are not exported.
- No hole filling, size fitting, or claims about capture completeness or physical fit.

## Tests

Fixtures are generated programmatically with `pxr` (`make_fixtures.py`) as `.usdz` packages containing binary USDC: nested rotate+scale with two meshes, a reflected (`scale(-1,1,1)`) transform, no units authored, and a subdivision mesh. Tests decode the OBJ independently (no `pxr`), check bounds against hand-derived values and signed volume (winding), and run FIT006 on one output.

```sh
.venv/bin/python -m unittest discover -s tools/capture-mesh-convert/tests -v
```
