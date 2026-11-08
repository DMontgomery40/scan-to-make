# mac-reconstruct

macOS command-line tools for rebuilding and checking scans on the Mac.

- `mac-reconstruct <images-folder> <output.usdz> [reduced|medium|full|raw]` rebuilds a model from an
  Object Capture photo folder with Apple's `PhotogrammetrySession`. On a Mac it can use detail levels
  above the iPhone's `.reduced`. It prints one JSON line per progress step, then `{"done":…}` or `{"error":…}`.
  First it prints `{"images":N,"depth":D}`: how many photos carry LiDAR depth, where the model's real-world size
  comes from. Apple's `stitchingIncomplete` and `automaticDownsampling` come out as `{"warning":…}`. This mode uses
  Object Capture's capture box, which the person drags on the phone.
- `mac-reconstruct walkaround <images-folder> <output.usdz> [detail] [--no-masks] [--save-masks <dir> [--masks-only]]`
  rebuilds a walk-around or scan-rig session (the object stays still, the phone moves) without the capture box. The
  companion runs it at `full` on every image a walk-around sent (`ReconstructInput.objectCapture`).
  - Each HEIC becomes a `PhotogrammetrySample` as Apple wrote it: LiDAR depth for scale, gravity and camera.
  - Its `objectMask` is the obvious object from Vision's foreground instances (`VNGenerateForegroundInstanceMaskRequest`). `ObviousObjectMasker` picks the instance nearest the middle and nearest the camera, that doesn't run off the frame, and that continues the last photo. Inside it, anything more than 0.30 m behind its nearest surface is cut (a person standing behind).
  - Where Vision finds nothing, the photo stays unmasked and RealityKit masks it itself.
  - The session runs with `isObjectMaskingEnabled`, `featureSensitivity = .high`, `sampleOrdering = .sequential` and `ignoreBoundingBox = true`.
  - Masks are saved as `<dir>/<photo-name>.png`, so a run can be checked afterwards (`turntable-synth overlay`).
- `mac-reconstruct stl <model.usdz> <output.stl>` writes the model's triangles as a binary STL in millimetres
  (PhotogrammetrySession writes metres, `metersPerUnit = 1`), each mesh placed by its composed transform. The
  companion uses it to keep a scan as the project's model without a touch-up.
- `mac-reconstruct samples <images-folder> <output.usdz> [detail] [--masks <dir> | --no-masks] [--save-masks <dir> [--masks-only]]`
  rebuilds a handheld scan: the phone stays still and the object turns in the hand. Each photo becomes a
  `PhotogrammetrySample` with its embedded depth (metres), EXIF and calibration, and no gravity (the object moves
  relative to it). Without `--masks`, each photo's object mask is made on the Mac with Vision (below).
  `--no-object-masking` and `--no-depth` switch off Apple's own masking or the photos' depth, for tests.
- `model-look <model.usdz|.stl|.obj> <output-prefix> [--clay] [--pca]` prints the triangle count, the size in
  millimetres along the model's own axes (`sizeMm`) and along its principal axes (`pcaSizeMm`, which doesn't
  depend on orientation), and writes front, side and top renders. `--clay` renders plain grey so the shape shows
  instead of the photo texture; `--pca` renders in the principal-axis frame.
- `model-compare <reference> <candidate>` rigidly aligns the candidate to the reference (no scaling) and prints the
  candidate's size in the reference's axes and its mean, 95th-percentile and maximum surface distance in mm.
- `turntable-synth render|score|overlay` makes a synthetic handheld capture of a known model (fixed camera with the
  iPhone's field of view, a still real photo 0.8 m behind, a real hand cut out of a photo holding it in half the
  frames, exact depth), scores masks against its ground truth, and draws masks over photos.

## Object masks

`HandheldKit/ObjectMasker.swift`. Measured on real photos: Vision's foreground-instance mask merges a hand with
the object it touches, and person segmentation counts a held object as part of the person, so "foreground minus
person" deletes the object. Instead:

1. Hands are segmented with Vision's promptable segmentation (`GenerateIterativeSegmentationRequest`, macOS 27),
   seeded on hand-pose knuckles and on person-segmented pixels nearest the frame edge (hand pose often finds
   nothing on a close-up hand cut off by the frame).
2. A seed for the object comes from the foreground minus those hands, minus anything more than 0.2 m behind the
   nearest surface in the depth map, preferring blobs near the middle of the frame and continuing the last photo.
3. The object is segmented from a box around that blob (a point alone often returns part of the object), and
   the hands are subtracted.

Set `MASK_DEBUG_DIR=<dir>` to write the hand segments, candidate and person mask for each photo.

## The handheld gate

`scripts/handheld-gate.sh <reference.usdz> <background-photo> <hand-photo> <work-dir>` renders the synthetic
capture, rebuilds it from ground-truth masks, Vision masks and no masks, and passes when the Vision-mask rebuild
is within ±2 mm of the reference on every axis with a mean surface distance under 1 mm, nothing is skipped, and the
masks have a mean IoU of at least 0.9 while keeping at most 5% of the hand.

Build: `swift build -c release --package-path tools/mac-reconstruct`. Unit tests: `swift test --package-path tools/mac-reconstruct`.
