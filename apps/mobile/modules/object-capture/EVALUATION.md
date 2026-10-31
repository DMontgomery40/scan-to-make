# Native Object Capture evaluation

This isolated iOS 27+ application starts from Apple's public GuidedCaptureSample. See PROVENANCE.md and LICENSE.txt. The shared capture model is also compiled into Scan to Make saved-project capture; its watchdog applies there too. Source target identity is `org.scantomake.capture-evaluation`; select an already-authorized development identity locally when deploying. Never commit team, profile, signing or device data.

## Build and start

```sh
xcodebuild -project GuidedCaptureSample/GuidedCaptureSample.xcodeproj \
  -scheme GuidedCaptureSample -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath /tmp/capture-evaluation \
  CODE_SIGNING_ALLOWED=NO build
python3 -m unittest discover -s tests -v
./tests/watchdog/run_watchdog_checks.sh
```

Apple's sample requires physical LiDAR hardware with A14 or later. This target deliberately does not compile for Simulator. On launch, the evaluation landing screen displays `ObjectCaptureSession.isSupported` and `PhotogrammetrySession.isSupported` separately. Begin is disabled if either is unavailable. The camera/session is created only after Begin; permission refusal and capture failure use the sample's error/restart flow. Device build, signing, installation, launch, usable capture, reconstruction and accuracy are separate results.

## Camera release

`CaptureWatchdog` requests cancellation when tracking is unavailable for 15 s, not normal for 90 s, the session stays paused for 5 minutes, no new shot arrives during active capture for 5 minutes, or the thermal state is critical. Tracking availability is a proxy, not a direct camera-frame measurement. Paused time does not count toward tracking and progress limits; background observations reset those budgets. Detection and bounding-box setup do not consume the shot-progress budget. Finishing is never interrupted.

Stopping retains the session until a terminal SDK state. `evaluation.json` records `cancel-terminal`, or `cancel-still-pending` after 10 s. Begin remains blocked while cancellation is pending, including after that timeout. A terminal state does not verify hardware release. In embedded saved-project capture, automatic stop reasons are delivered through the existing completion error path after cancellation finishes.

## Capture matrix and recovery

Run matte/textured and glossy/transparent objects separately. Include a dark cavity as a rejection/partial-surface case. Begin with a well-lit textured object, with enough space to orbit it. Preserve Apple's reticle/detection box, native feedback and coverage indicator. Use Continue to detect and adjust the bounds, then Start Capture. If detection fails or feedback asks for movement, lighting or distance changes, follow that feedback; a world-tracking state is not a usable-surface measurement.

Object mode uses complete exterior orbits. Next shows Apple's pass review and flip coaching. `beginNewScanPassAfterFlip()` starts underside/re-boxing; `beginNewScanPass()` is another view of the same orientation. If flipping is unsuitable, record that the underside is missing rather than treating coverage as complete geometry. Area mode is the separate freeform row (mode button before capture): it bypasses object detection, hides the object reticle and disables object masking for reconstruction. Partial area output cannot pass complete-object reconstruction.

The baseline is on-device `.reduced` reconstruction. Original images remain available for a separately declared Mac detail comparison. The app records capture/feedback events, current-pass completion, shot/pass/flip counts, runtime support flags, OS, mode and reconstruction warnings. These are raw observations, not pass/fail scoring. A success file does not establish accurate dimensions; incomplete stitching and unobserved/guessed regions require independent inspection. Stop and retain failed captures instead of trying to make a glossy/dark cavity look successful.

## Inspect and export

Files → On My iPhone → Capture Evaluation contains each unique run folder:

- `Images/`: original images and their embedded capture metadata, unchanged.
- `Models/model-mobile.usdz`: actual reconstruction output, unchanged.
- `evaluation.json`: raw event and provenance record. Missing/guessed regions, metric accuracy and complete-object/physical fit remain unassessed or false.

Quick Look displays the model and supports native sharing. Share the whole folder through Files to preserve original capture references; sharing only the USDZ is insufficient for scale audit. On a Mac, package a copied folder with:

```sh
python3 export_capture.py /private/path/to/run /private/path/to/capture.zip
```

The archive contains exact original bytes plus SHA-256/length inventory, rejects symlinks and future formats, and refuses to overwrite prior evidence. It performs no conversion or rescaling and does not assert depth metadata exists merely because hardware supports depth. Native metric evaluation must independently confirm retained depth/scale metadata. USDZ is inspectable by RealityKit/Quick Look; consumers supporting only STL/OBJ need a declared conversion with source/output hashes and unit/transform provenance. That conversion is not implemented here.

## Predeclared physical evaluation

Record separate duplicate/replacement/backup/revised-object intent, object/area mode, exact device/OS, material and missing surfaces. Target useful guidance within 5 seconds and an inspectable outcome within 5 minutes; these are evaluation targets, not achieved claims. Compare unrescaled native output with held-out caliper dimensions using max(1 mm, 1%) per dimension. Missing depth/scale fails the native metric gate. Assisted calibration is a separate sensitivity pass: declare the reference dimension beforehand, exclude it from independent scoring and never promote assisted accuracy into the native result. Geometry bounds alone cannot prove completeness, useful cavities or physical fit. No printer dispatch is part of this evaluation.
