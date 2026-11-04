# linux-reconstruct

Builds a metric USDZ from handheld photos on Linux: COLMAP (CPU sparse) →
OpenMVS (CPU dense mesh) → USDZ. The Linux counterpart of
`tools/mac-reconstruct`; the companion runs it behind the same `Reconstruct`
interface (`services/companion/src/objects/reconstruct.ts`). Apple
reconstruction is untouched.

Scale is never assumed. COLMAP output is in arbitrary units, and writing
`metersPerUnit` into a file proves nothing. A run only produces output when
one of two proofs holds:

1. **Camera-centre alignment.** The capture app supplies
   `capture-camera.json` (below) with ARCore camera centres in metres. A
   robust similarity fit (Umeyama + median-trimmed refit) between COLMAP
   centres and ARCore centres must pass recorded gates: ≥12 matched tracking
   frames covering ≥50% of tracking frames, path spread ≥0.15 m, path not
   near-collinear (second/first scatter eigenvalue ≥0.02), ≥80% inliers at
   residual ≤2% of spread, median relative residual ≤2%, p90 ≤5%. The
   receipt records coverage, spread, inliers and residuals. A bad fit falls
   back to path 2 — it never guesses.
2. **Explicit measurement.** Otherwise the run exits 4 (`needs-scale`) with a
   versioned receipt naming the cached unscaled mesh (SHA-256), its exact
   per-axis extents and a private preview mesh. The companion turns that into
   an in-app question; the answer comes back as `capture-measurement.json`
   (strict numeric millimetres, bound to the mesh hash and one named axis).
   A rerun with `--measurement` finishes scaling and export from the cache —
   reconstruction is not replayed (stages are cached in the work directory,
   keyed by photo hashes).

Unscaled geometry stays in the private work directory (mode 0700) and is
never written to the output path. Output is published atomically and `done`
is emitted only after the USDZ is in place and re-validated.

## CLI

```
linux-reconstruct samples <photosDir> <output.usdz> full --save-masks <masksDir> \
    [--camera-metadata <capture-camera.json>] \
    [--measurement <capture-measurement.json>] \
    [--work-dir <path>]
```

NDJSON on stdout, one object per line: `{"stage": ..., "progress": 0..1}` for
`inventory, features, matching, mapping, undistorting, interfacing,
densifying, meshing, exporting`; then exactly one of `{"done": "<output>"}`,
`{"needsScale": {"receipt": path, "meshSha256": ..., "extents": {...},
"previewMesh": path}}`, or `{"error": ..., "code": ...}`. Exit codes: 0
success, 4 needs-scale, 2 actionable error. SIGINT/SIGTERM kills only this
tool's own process group and never reports success. Tool logs are bounded
files under `<work-dir>/logs/`, never stdout.

Receipts: `<work-dir>/receipt.json` always; on success also
`<output>.receipt.json`; on needs-scale also `<work-dir>/needs-scale.json`.
Receipt `version: 1` fields: `tool`, `toolVersion`, `status`
(`done|needs-scale|failed`), `photos`, `registration {registered,total}`,
`cameraScaleFit` (when metadata supplied), `objectSelection`, `scale`
(`{method, scaleMPerUnit, extentsM, upAxisProvenance, ...}` or null),
`outputSha256`, `timingsSeconds`, `elapsedSeconds`.

Error codes include: `too-few-photos`, `too-many-photos`, `capture-too-large`,
`camera-metadata-invalid`, `measurement-invalid`, `tool-missing`,
`reconstruction-failed`, `needs-object-region` (fragmented mesh and no
recorded object position — the app must collect an object region/anchor or
the capture must be retaken; no arbitrary cropping is attempted),
`scale-implausible`, `stage-timeout`, `stage-failed`,
`workspace-too-large`, `cancelled`.

Bounds: 8–300 photos (.jpg/.jpeg/.png, ≤64 MiB each, ≤2 GiB total), images
downscaled to 2000 px for SIFT/dense, threads `min(8, cores)`
(`SCAN_TO_MAKE_RECONSTRUCT_THREADS`), per-stage wall-times (features/matching
30 min, mapping/densifying 60 min, others 5–30 min;
`SCAN_TO_MAKE_RECONSTRUCT_TIMEOUT_<STAGE>` overrides), workspace ≤20 GiB.
Matching is exhaustive up to 80 photos, sequential (overlap 15, capture
order = walking order) beyond that.

Masks: `--save-masks` is accepted for CLI parity with mac-reconstruct. The
Linux pipeline does not segment photos, so the directory is created empty and
the receipt says so; no masks are fabricated.

Object selection: with a proven camera fit **and** an `objectAnchor`, faces
inside the recorded anchor sphere (radius ×1.15) form the object region and
its largest piece is the object — an object on a table reconstructs as one
component with the table, so the recorded region, not connectivity, is what
separates them. Without an anchor, the largest connected component is used only when
the mesh is not fragmented (largest share ≥40%, ≤20 significant components);
this is recorded as `largest-component-unverified` — it may be the table, so
in the measurement flow the person confirms the previewed component is the
object before the measurement binds. Fragmented output without an anchor is
`needs-object-region`, not a guess.

Export: vertices are transformed to metres (full similarity incl. rotation
into the ARCore Y-up frame when the camera fit proved scale; uniform scale
only for a measurement — then `upAxisProvenance` records that orientation is
unverified and the app must confirm it), recentred (footprint centre at the
origin, lowest point at y=0; translation only), winding flipped to outward
when the signed volume is negative. The stage authors `metersPerUnit=1.0`,
`upAxis=Y`; the mesh authors `subdivisionScheme=none`, right-handed
orientation, triangles only. The package is reopened and checked before
publishing. Scaled extents over 10 m are refused as implausible.

## capture-camera.json (version 1) — the contract for the capture app

Written by the Android app next to the photos. Deliberately **not** the iOS
capture-frames format. Strict: unknown keys, non-finite numbers, mismatched
digests/dimensions are rejected (`camera-metadata-invalid`).

```json
{
  "version": 1,
  "kind": "capture-camera",
  "frames": [
    {
      "image": "IMG_0001.jpg",
      "sha256": "<64 lowercase hex of the saved file bytes>",
      "width": 4032, "height": 3024,
      "fx": 2900.0, "fy": 2900.0, "cx": 2016.0, "cy": 1512.0,
      "timestampMs": 1730000000000,
      "tracking": "tracking",
      "center": [0.12, 1.05, -0.30]
    }
  ],
  "objectAnchor": null
}
```

- `image`: safe basename of a photo in the capture directory (no paths).
  One frame per image; duplicates rejected.
- `sha256` / `width` / `height`: of the **saved** file; verified against the
  actual bytes and header. Mismatch rejects the whole file.
- `fx, fy, cx, cy`: CPU-image intrinsics **adjusted to the saved image's
  orientation and pixel size** (pixels). Must be plausible for the saved
  size (focal within [0.05, 20]× diagonal; principal point within the image
  ±25%). (v1 records them for provenance/future priors; COLMAP still
  calibrates its own OPENCV model.)
- `timestampMs`: non-negative integer, capture order.
- `tracking`: `"tracking" | "limited" | "not-tracking"` (ARCore tracking
  state). Only `tracking` frames can qualify scale.
- `center`: camera centre `[x,y,z]` in **metres**, ARCore world frame
  (Y-up, gravity aligned). This is the position of the camera, not a pose
  matrix element.
- `objectAnchor` (optional, nullable): `{"center": [x,y,z] metres,
  "radiusM": 0.01–5, "confidence": 0–1, "source":
  "arcore-anchor"|"user-tap"|"depth-centroid"}`. Only include it when the
  source and confidence are real; it selects the object component.

Duplicate centres (paused capture) are dropped before fitting; a path that
barely moves or is a straight line cannot establish scale and falls back to
measurement.

## capture-measurement.json (version 1)

Written by the companion from the person's in-app answer. Strict numeric
JSON; no prose is interpreted.

```json
{"version": 1, "kind": "capture-measurement",
 "meshSha256": "<needs-scale receipt meshSha256>",
 "axis": "x", "extentMm": 142.5}
```

`axis` is one of `x|y|z` — the axes/extents named in the needs-scale
receipt. `extentMm` ∈ [1, 10000]. A receipt for a different mesh is refused.

## Dependencies and licences

- COLMAP 3.12.6 (BSD-style licence), CPU build (`--SiftExtraction.use_gpu 0`).
  Binary from the distro/official release; `SCAN_TO_MAKE_COLMAP` overrides.
- OpenMVS 2.4.0 (AGPL-3.0) `InterfaceCOLMAP`, `DensifyPointCloud`,
  `ReconstructMesh`. Point `SCAN_TO_MAKE_OPENMVS_DIR` at the directory
  containing them, or put them on `PATH`. AGPL note: these are invoked as
  separate processes, not linked; distribution of the binaries themselves
  carries AGPL obligations — the app installer must ship their licence and
  source offer (tracked by the linux-host packaging task).
- Python ≥3.11 stdlib plus `usd-core` (Apache-2.0) from `requirements.txt`:

```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

No binaries or caches are committed; `.venv/` is ignored.

## Checks

```
python3 -m unittest discover -s tests
```

Covers scale recovery against a known similarity, outlier/shuffle/line
rejection, strict schema accept/reject, PLY round-trip, components, COLMAP
centre parsing, CLI exit paths, and (when usd-core is present) USDZ validity.
These are engineering checks only, never app acceptance.
