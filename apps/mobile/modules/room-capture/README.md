# RoomPlan suitability for fitted additions

Source assessment, 2026-10-15. This directory contains a capability decision,
not a capture application. No runtime capture or physical accuracy is established.

**Exclude RoomPlan's parametric output as the measurement authority for a fitted
drawer organizer.** Keep it as a candidate for room context, furniture placement
and architectural surroundings. The selected drawer scenario needs observed
interior surfaces, usable depth, obstructions and uncertainty. The public output
does not supply that evidence. This is an engineering suitability conclusion from
the API contract, not a claim that a physical drawer can never appear in a scan.

## Evidence and limits

| Public API | What it represents | Consequence for a drawer interior |
| --- | --- | --- |
| [CapturedRoom.Object.dimensions](https://developer.apple.com/documentation/roomplan/capturedroom/object/dimensions) | Object extremities as a bounding box, with a separate pose transform. | Outer bounds cannot establish inner clearances, wall thickness, bottom height or rails. |
| [StorageType](https://developer.apple.com/documentation/roomplan/storagetype) | Storage classification; the inspected SDK exposes `cabinet` and `shelf`. | Recognition of storage does not provide a separate measured cavity. The exclusion does not depend solely on the absence of a drawer category. |
| [CapturedRoom.Surface](https://developer.apple.com/documentation/roomplan/capturedroom/surface) | Architectural surfaces: walls, openings, windows, doors and floors. | Treating a small cavity wall as a room wall would be an unvalidated reinterpretation. |
| [Surface.polygonCorners](https://developer.apple.com/documentation/roomplan/capturedroom/surface/polygoncorners) | Planar outlines for wall heights and floor shapes. | These polygons do not constitute an arbitrary furniture interior surface reconstruction. |
| [CapturedRoom.ModelProvider](https://developer.apple.com/documentation/roomplan/capturedroom/modelprovider) | App-supplied detailed models replace the approximate object boxes at export. | A detailed substituted drawer model is supplied geometry, not newly observed drawer geometry. |
| [USDExportOptions.mesh](https://developer.apple.com/documentation/roomplan/capturedroom/usdexportoptions/mesh) | Triangle representation of exported elements. | A mesh file extension or triangle count does not establish that inner surfaces were observed. |
| [CapturedRoom.Confidence](https://developer.apple.com/documentation/roomplan/capturedroom/confidence) | Discrete certainty about feature classification. | `high` is not a calibrated millimeter error interval or a surface-completeness measurement. |

[RoomPlan's documented purpose](https://developer.apple.com/documentation/roomplan)
is interior-room capture with native guidance and parametric output. It remains
useful for that broader product context. A room-level evaluation can later score
its real guidance, export and dimensions against room-level acceptance criteria.
It must not be presented as drawer fit qualification.

RoomCaptureSession also exposes an underlying
[ARSession](https://developer.apple.com/documentation/roomplan/roomcapturesession/arsession).
Collecting independent ARKit depth or mesh data from a coordinated session would
be an additional capture path with its own evidence obligations. It does not
change the meaning of `CapturedRoom` output.

## Installed SDK cross-check

Inspected Xcode 27.0, build 27A266a, iPhoneOS SDK 27.0, on the assessment date.
The SDK's `RoomPlan.framework/Modules/RoomPlan.swiftmodule/arm64e-apple-ios.swiftinterface`
has SHA-256:

```text
5db7ddd326b6067448650291165c45085bfdb0b33bfe99eee0b42c50d0fb1c79
```

Within that exact interface, `StorageType` is at lines 227–245,
`CapturedRoom` collections at 291–310, classification confidence at 347–357,
`Surface` and its categories/polygon corners at 388–438, `Object` at 475–541,
and the session's `arSession` at 688. `Object` exposes category, confidence,
dimensions, transform, identifier, attributes, story and parent identifier;
it exposes no per-object measured interior mesh or cavity clearance map.
SDK declarations establish available types, not device support or measurement
performance. Recheck these ranges and the conclusion when upgrading the SDK.

Reproduce the interface inspection with the selected full Xcode installation:

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -version
sdk_path=$(xcrun --sdk iphoneos --show-sdk-path)
interface_path="$sdk_path/System/Library/Frameworks/RoomPlan.framework/Modules/RoomPlan.swiftmodule/arm64e-apple-ios.swiftinterface"
shasum -a 256 "$interface_path"
sed -n '227,245p;291,357p;388,541p;680,692p' "$interface_path"
```

## Next bounded source evaluation

Evaluate ARKit's observed depth and environment mesh for cavity evidence in a
separate isolated module before building a consumer capture flow. This is a
proposal; no custom collector or new UI is implemented here.

1. Gate world tracking, `.sceneDepth` and `.mesh` independently using the public
   support checks. Missing required input produces an explicit unavailable result.
   [ARFrame.sceneDepth](https://developer.apple.com/documentation/arkit/arframe/scenedepth)
   requires supported frame semantics;
   [scene reconstruction](https://developer.apple.com/documentation/arkit/arconfiguration/scenereconstruction)
   supplies an approximate environment mesh. Neither implies fit readiness.
2. Retain bounded, timestamped depth/confidence observations with camera
   intrinsics, poses, coordinate convention and units, plus copied mesh vertices,
   faces and anchor transforms. Preserve originals and record derived hashes.
   [ARDepthData](https://developer.apple.com/documentation/arkit/ardepthdata)
   describes camera-plane depth in meters. Its
   [confidence map](https://developer.apple.com/documentation/arkit/ardepthdata/confidencemap)
   requires special care with reflective and light-absorbing surfaces. A high
   ordinal confidence still needs independent metric validation.
3. First acceptance is an unsigned native compile plus synthetic tests for buffer
   copying/stride handling, transforms, declared units, finite values, truncation,
   size limits and deterministic export. Record unsupported capability and missing
   confidence separately. Do not fill unseen areas, cap cavities or derive a
   numerical uncertainty interval from uncalibrated confidence labels.
4. Keep physical qualification separate: inspect actual interior bottom, walls,
   corners and obstructions; retain missing regions; compare held-out dimensions
   on matte and adverse glossy/dark surfaces. The
   [existing evaluation targets](../object-capture/EVALUATION.md#predeclared-physical-evaluation) are
   useful guidance within 5 seconds, an inspectable outcome within 5 minutes and
   per-dimension error no greater than `max(1 mm, 1%)`. These are targets, not
   achieved results; successful bounds checks alone cannot pass them.

The existing `scan-capture` module already conditionally enables scene depth and
mesh reconstruction, but records counters rather than retaining those surfaces.
Reuse its capability-check knowledge while keeping its diagnostic behavior out
of the consumer acceptance claim. The existing Object Capture evaluation remains
a separate source of reconstructed objects and original images. Do not replace
either installed application to execute this source-only investigation.
