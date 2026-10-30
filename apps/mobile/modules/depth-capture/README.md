# Bounded ARKit evidence collector

An isolated Swift library for retaining observed depth/confidence buffers and
mesh snapshots. It does not start a session, request permissions, modify an app,
or provide consumer capture UI. Runtime hardware support, capture usability,
measurement accuracy and fit remain unverified.

## Integration boundary

On iOS 17+, use `ARKitEvidenceCollector.makeConfiguration()` with a caller-owned
`ARSession`. World tracking, scene depth and mesh reconstruction are checked
independently; unsupported input is never enabled. After starting that authorized
session, initialize `ARKitEvidenceCollector(session:)`. Call `capture(session)`
serially on the session owner's queue when a snapshot is wanted. It copies the
current frame's buffers synchronously and retains no `ARFrame`, pixel buffer,
Metal buffer or session object. No asynchronous borrowed pointer survives the call.
A changed session identifier rejects the snapshot; create a new collector after
reset/restart. Session interruption and reset remain the owning application's
responsibility. Do not run a second competing session for this library.

Default retention limits are 8 snapshots and 32 MiB of original buffer bytes.
The caller may lower them; hard ceilings are 32 snapshots and 32 MiB. A snapshot
also permits at most 256 nonempty mesh anchors, 100,000 vertices and 200,000 faces
per anchor, and 2048 by 2048 depth pixels. Bounds are checked before native buffer
copies; malformed layouts, missing inputs, nonfinite/negative depth, nonfinite
geometry, invalid indices, out-of-order timestamps and session changes reject the
whole snapshot without altering previously retained evidence. Zero depth is
retained as invalid/unmeasured, not converted into a surface. Missing confidence
is explicit. Supported capability is distinct from observed data.

The pure `CaptureEvidence`/`FrameEvidence` types provide the same validation for
synthetic fixtures. Their initializers take a declared session UUID; this is a
coordinate-frame binding, not authentication or proof of native origin. Do not
label fixture-created records as physical capture.

## Export

`collector.evidence.export()` returns a deterministic dictionary of relative
filenames and bytes. Persist it privately with the application's bounded,
no-overwrite/atomic storage policy; this library does not write files itself.

- `manifest.json` records session ID, session timestamps, tracking state, camera
  image resolution, camera intrinsics and poses, depth/mesh layouts, capabilities,
  units, coordinate conventions, and SHA-256/byte lengths for every binary and
  derived OBJ file. Hash and retain the manifest itself at the ingestion boundary.
- `frames/NNNN/depth.bin` and optional `confidence.bin` preserve copied source
  buffers including row padding. Depth is little-endian Float32 in meters from
  the camera plane. Confidence is an ordinal byte in 0–2; no millimeter interval
  is inferred. Only meaningful pixels are validated; padding is never a sample.
- `frames/NNNN/meshes/NNNN/{vertices,indices}.bin` preserve copied native buffers,
  including padding, with declared offsets, strides, counts and transforms. They
  are snapshots of ARKit's reconstruction output, not raw sensor readings.
- `mesh.obj`, when the final retained frame has meshes, contains only that frame's
  transformed anchor geometry in session-world meters. It never merges duplicate
  anchors across timestamps, resurrects removed anchors, fills holes or caps
  cavities. Earlier snapshots remain as originals. Text export is capped at
  32 MiB; overflow fails export without changing retained evidence.

Original identity here means copied ARKit buffer bytes. RGB camera images,
calibration beyond the listed camera metadata, and an independently measured
metric reference are not captured. Raw-byte limits do not describe total process
memory: validation copies, export text, output files and manifest incur additional
bounded allocations. Export is intended for a stopped/bounded evaluation, not
continuous per-frame background streaming.

Every manifest keeps metric accuracy, surface completeness and physical fit
`unknown`. A valid OBJ or high confidence value does not qualify a drawer or an
object for manufacture. This raw-evidence format is distinct from the USDZ
converter's conversion receipt; consumers must not relabel it as a qualified
conversion. Retain it unchanged before any separately declared transformation.

## Reproduce source validation

From this directory, with the full Xcode selected:

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
swift test
sdk_path=$(xcrun --sdk iphoneos --show-sdk-path)
xcrun --sdk iphoneos swiftc -warnings-as-errors -parse-as-library \
  -emit-library -static -emit-module -module-name DepthCapture \
  -sdk "$sdk_path" -target arm64-apple-ios17.0 Sources/DepthCapture/*.swift \
  -emit-module-path /tmp/DepthCapture.swiftmodule -o /tmp/libDepthCapture.a
```

The macOS suite exercises synthetic inputs; it does not execute ARKit. The
unsigned arm64 iPhoneOS archive verifies the native adapter compiles, with no
provisioning, signing, installation or device action. No app/runtime result is
implied. Public API basis: [scene depth](https://developer.apple.com/documentation/arkit/arframe/scenedepth),
[depth confidence](https://developer.apple.com/documentation/arkit/ardepthdata/confidencemap),
[mesh geometry](https://developer.apple.com/documentation/arkit/armeshgeometry),
and [session identity](https://developer.apple.com/documentation/arkit/arsession/identifier).
