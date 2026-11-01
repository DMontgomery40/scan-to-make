# mac-reconstruct

Two small macOS command-line tools for rebuilding and checking scans on the Mac.

- `mac-reconstruct <images-folder> <output.usdz> [reduced|medium|full|raw]` rebuilds a model from an
  Object Capture photo folder with Apple's `PhotogrammetrySession`. On a Mac it can use detail levels
  above the iPhone's `.reduced`. It prints one JSON line per progress step, then `{"done":…}` or `{"error":…}`.
- `model-look <model.usdz|.stl|.obj> <output-prefix> [--clay]` prints the triangle count and size in
  millimetres and writes front, side and top renders. `--clay` renders plain grey so the shape shows instead
  of the photo texture.

Build: `swift build -c release --package-path tools/mac-reconstruct`
