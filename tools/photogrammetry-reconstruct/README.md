# Photogrammetry reconstruct (preview geometry)

Rebuild a capture's original photos with Apple's local
`RealityKit.PhotogrammetrySession` at preview, reduced, medium, full or raw detail.
Requires **macOS 14+ and supported Apple silicon**. SwiftPM needs Swift 5.9+
and an Apple SDK; `swift test` needs full Xcode selected (Command Line Tools
alone may not supply XCTest). No network service, mobile app or printer access.

```sh
cd tools/photogrammetry-reconstruct
swift build
swift test
swift run --skip-build photogrammetry-reconstruct /path/to/images \
  --output /path/to/new/medium.usdz --detail medium \
  --ordering unordered --sensitivity normal --masking on \
  --timeout-seconds 3600 --obj-directory /path/to/new/medium-obj
```

`--output` is required. Defaults: medium, unordered, normal sensitivity,
masking on, 3600 seconds. `--obj-directory` optionally requests Apple's native
OBJ folder output (OBJ, material and texture files); supported on macOS 14+.
All destinations must be new, distinct and outside the input tree. Do not run
concurrent writers against the same destinations. Failures can leave partial
artifacts; only a successful report qualifies completion. Use fresh paths on retry.

Input is a flat image folder: HEIC/HEIF, JPEG, PNG or TIFF. Missing/empty
folders, unreadable images, subfolders, symlinks, unsupported entries and
case/Unicode-equivalent duplicate names fail. `.DS_Store` is ignored. Validation
checks the image container/properties; RealityKit performs full sample decoding
and may reject or skip samples (recorded in warnings). Input names and hashes
are sorted; rehashing after reconstruction detects input changes. Keep the
input folder immutable throughout the run.

The original folder goes directly to Apple's folder initializer. HEIC depth,
gravity and capture metadata remain available to the framework: no JPEG
conversion or synthetic gravity/depth is substituted. Metadata availability and
its actual use are decided by RealityKit, and are not independently certified
by this tool. Sequential ordering is Apple's ordering hint, not a custom
manifest order. High sensitivity can help images with fewer landmarks.
See Apple's [session API](https://developer.apple.com/documentation/realitykit/photogrammetrysession),
[configuration](https://developer.apple.com/documentation/realitykit/photogrammetrysession/configuration-swift.struct)
and [output requests](https://developer.apple.com/documentation/realitykit/photogrammetrysession/request).

Progress and warnings go to stderr. Exit 0 means all requested models completed;
2 means validation, unsupported hardware or reconstruction failure. A wall-clock
timer bounds the **session processing**, requests cancellation at the limit,
and allows at most ten seconds for cancellation acknowledgment (exit 124 if
that grace expires). Pre/post hashing and model inspection are outside that
session limit. Interrupted or failed runs never write a success report. The
executable's minimum deployment target is macOS 14; older macOS may reject it
at load time before its own supported-hardware diagnostic can run.

## Report and limits

`MODEL.usdz.report.json` and stdout contain sorted-key JSON. `payloadSHA256`
is SHA-256 of the compact sorted-key UTF-8 serialization of `payload` with
unescaped slashes (no trailing newline). `elapsedSeconds` is outside that hash.
The payload contains image names and SHA-256 values, image count, options,
output file hashes, OS, API identification, warnings and
`provesPhysicalAccuracy: false`. Paths are parameters and therefore affect the
hash. There is no public independent PhotogrammetrySession API version number;
the report records the macOS 14 API surface used and exact runtime OS version.

ModelIO supplies vertex/triangle counts when it can read triangle meshes.
Vertices may be split by normals/UV seams; independent converter counts can
differ. Missing counts are omitted. Native OBJ companion material/texture files
are hashed too. ModelIO import is not a physical accuracy or topology check.
Reports are deterministic for identical payload values; Apple reconstruction
itself and output bytes are **not promised deterministic** across runs, hardware
or OS versions. More triangles do not establish more accurate dimensions.

## Feed the existing offline chain

Use the USDZ as the authoritative source for unit provenance, even if native
OBJ was also requested. From the repository root:

```sh
.venv/bin/python tools/capture-mesh-convert/convert.py /path/to/medium.usdz \
  --out /path/to/medium.obj --report /path/to/medium-conversion.json
python3 tools/scan-repair/repair.py measure /path/to/medium.obj \
  --units-sidecar /path/to/medium-conversion.json
python3 tools/scan-repair/repair.py render /path/to/medium.obj \
  --units-sidecar /path/to/medium-conversion.json --out /path/to/views
python3 tools/scan-repair/repair.py repair /path/to/medium.obj \
  --units-sidecar /path/to/medium-conversion.json --out /path/to/repaired
```

Install `usd-core` for the converter and Blender for scan-repair, as described
in their READMEs. Check converter exit status and provenance before proceeding;
unauthored units are not a metric authority. Repair can invent surfaces or erase
detail. Reconstruction, measurement and rendering remain preview geometry;
physical accuracy, fit and print approval need separate evidence.

## Tests and CI

Unit tests use generated temporary files and a one-pixel synthetic PNG; no real
photos or captures are tracked. They cover parsing, folder validation, duplicate
names and the canonical report hash boundary. CI builds and runs these tests
on `macos-15`, a standard [GitHub macOS runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
It never claims reconstruction on virtual GPU hardware. Real reconstruction
qualification uses local public sample photos with private outputs.

## Licence

This directory is MIT licensed; see [LICENSE](LICENSE). Its implementation is
original API client code, with no copied/adapted Apple sample implementation.
Apple's RealityKit, ModelIO and ImageIO remain proprietary system frameworks
subject to Apple's terms and are not redistributed here. Apple sample photos
and generated meshes are not included. The separate scan-repair tool retains
its GPL-3.0-or-later licence.
