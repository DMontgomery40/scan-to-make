# mac-reconstruct

macOS command-line tools for rebuilding and checking scans on the Mac.

- `mac-reconstruct <images-folder> <output.usdz> [reduced|medium|full|raw]` rebuilds a model from an
  Object Capture photo folder with Apple's `PhotogrammetrySession`. On a Mac it can use detail levels
  above the iPhone's `.reduced`. It prints one JSON line per progress step, then `{"done":…}` or `{"error":…}`.
- `mac-reconstruct samples <images-folder> <output.usdz> [detail]` rebuilds a Scan in hand capture that an
  earlier phone build saved (the phone no longer records one: KAN-217). The phone stayed still and the object
  turned in the hand. Each photo becomes a `PhotogrammetrySample` with its embedded depth (metres), EXIF and
  calibration, and no gravity (the object moves relative to it). Apple's own object masking finds the object; there
  is no mask of our own. A mirrored photo set is refused before anything is built. `--save-masks <dir>`, which the
  companion passes, is accepted and writes nothing. `--no-object-masking` and `--no-depth` switch off Apple's own
  masking or the photos' depth, for tests.
- `model-look <model.usdz|.stl|.obj> <output-prefix> [--clay] [--pca]` prints the triangle count, the size in
  millimetres along the model's own axes (`sizeMm`) and along its principal axes (`pcaSizeMm`, which doesn't
  depend on orientation), and writes front, side and top renders. `--clay` renders plain grey so the shape shows
  instead of the photo texture; `--pca` renders in the principal-axis frame.
- `model-compare <reference> <candidate>` rigidly aligns the candidate to the reference (no scaling) and prints the
  candidate's size in the reference's axes and its mean, 95th-percentile and maximum surface distance in mm.

Build: `swift build -c release --package-path tools/mac-reconstruct`. Unit tests: `swift test --package-path tools/mac-reconstruct`.
