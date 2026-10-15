# Capture fit evaluation (offline, bounds-only)

`evaluate.py` is a small stdlib-only acceptance tool for captured-mesh exports after they have been converted to a supported mesh format. It reports axis-aligned extents versus declared held-out dimensions, plus closed/oriented triangle-mesh statistics.

A `pass-bounds-only` result means only that the evaluated extents are within the declared tolerance on the independent axes and the mesh is closed/oriented. It does **not** prove complete capture, accurate surfaces away from the bounds, manufacturability, or physical fit. Every report carries:

```json
"provesCompleteCapture": false,
"provesPhysicalFit": false
```

## Supported inputs

- STL: binary and ASCII
- OBJ: vertices plus polygon faces, triangulated deterministically as fans
- Units: declared on every run as `mm`, `cm`, `m`, or `in`; the report converts extents to mm

USDZ and all other formats are rejected by name. The tool never guesses units or a format conversion. Object Capture USDZ files need a separately declared converter before they can enter this evaluator.

## Scale provenance

Native mode is the baseline: no calibration may be declared, and raw extents are scored unrescaled against held-out caliper dimensions.

Assisted mode requires provenance:

- `distinct-reference`: the calibration factor came from a reference chosen before capture and distinct from the scored target dimensions. All declared target axes remain independent.
- `target-axis`: the named axis is excluded from independent scoring. It is still reported, but it cannot help pass the scale gate.

Raw and calibrated errors are always reported separately. An assisted pass is never relabelled as a native-scale pass.

The default per-axis tolerance is `max(1 mm, 1% of expected)`, matching the pre-registered capture bake-off gate. At least two independent axes are required for a scale pass.

## Usage

```sh
python3 tools/capture-fit-eval/evaluate.py evaluate capture.stl \
  --units mm \
  --held-out x=80 --held-out y=55 --held-out z=95 \
  --json --out report.json
```

Assisted example:

```sh
python3 tools/capture-fit-eval/evaluate.py evaluate capture.obj \
  --units m \
  --held-out x=80 --held-out y=55 --held-out z=95 \
  --scale-mode assisted \
  --calibration-source distinct-reference \
  --calibration-reference reference-block-01 \
  --calibration-factor 0.995
```

Exit codes: `0` = `pass-bounds-only`, `2` = fail or invalid mesh/inputs, `3` = rejected format.

## Tests

Tests generate deterministic synthetic boxes in a temporary directory; no personal captures are committed.

```sh
python3 -m unittest discover -s tools/capture-fit-eval/tests -v
```
