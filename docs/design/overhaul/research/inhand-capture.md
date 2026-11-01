# In-hand ("hold it and turn it") capture for Counterpart: audit and specification

Date: 2026-11-01. Read-only audit. Worktree audited: `/Users/davidmontgomery/.codex/worktrees/counterpart-workspace/scan-to-make` (W below), branch `feat/counterpart-project-workspace`. Device evidence: `~/Library/Application Support/Scan to Make/capture/objects/{5bef7cf1…,485defc7…}` and `~/scan-to-make-work/takeover-2026-11-01/` (T below). Apple sources are listed at the end. Where something is my inference rather than a documented fact, it says **[inference]**.

---

## 1. Root cause, with evidence

The phone made two real handheld captures, and each failed for a different reason. A third, later build has never produced a capture on the device.

### 1a. Capture 5bef7cf1 (black frames): front camera, no LiDAR
- **The code the phone was running** (commit `43edcb4`, `apps/mobile/ios/ScanToMake/Objects/HandheldCapture.swift`):
  - line 12: "The front TrueDepth camera is the default".
  - line 19: `frontCamera = AVCaptureDevice.default(.builtInTrueDepthCamera, for: .video, position: .front)`.
  - line 146: `configure(front: HandheldCapture.frontCamera != nil)`. The front camera was always chosen, because every iPhone has one.
  - Photos used `AVCapturePhotoOutput`, with `embedsDepthDataInPhoto` and `isDepthDataFiltered = true` (lines 243–249).
  - Exposure, focus and white balance were set to `.locked` at Start (lines 214–221).
- **The frames** (T/capture-failure-5bef7cf1/README.md, compact-findings.json, all-frame-exposure-metadata.json):
  - All 120 HEICs carry EXIF `iPhone 17 Pro Max front TrueDepth camera 2.715mm f/1.9`.
  - Every frame has ExposureTime 0 and ISO 0.
  - **No frame contains embedded depth or disparity.**
  - Mean luminance is 0.03–0.07 out of 255; 98.3–99.3% of pixels have every RGB channel ≤ 8.
  - The Vision masks cover 98.9–99.8% of the frame, so they are useless.
- **Conclusion:**
  - LiDAR was **not** used. The rear LiDAR camera was never opened, and even TrueDepth depth never reached the files.
  - EXIF reports 0 s at ISO 0, together with near-black pixels. A merely dark scene would normally record a real exposure value. The zeros could also mean the field was never filled in, so they don't prove on their own that the sensor didn't expose.
  - The black preview the owner saw "the whole time", including before Start, agrees with this: the front-camera session never streamed usable frames.
  - The mechanism inside AVFoundation is not recoverable from the retained logs. The `.locked` exposure at Start (lines 214–221) can't explain it, because the preview was already black before Start. It doesn't matter for the spec: this whole path has since been deleted.
- **Mac side:** CoreOC `Output error with code = -15` → `PhotogrammetrySession.Error.processError`. That error follows from the black input.

### 1b. Capture 485defc7 (visible picture): LiDAR was captured, but the input was poor
Source: T/capture-inspection-485defc7/README.md and T/capture-failure-485defc7/README.md.
- **Depth and camera:**
  - All 120 HEICs come from the `back camera 6.765mm f/1.78`.
  - Each carries a 768×576 LiDAR disparity map with absolute accuracy and full calibration: intrinsics and both distortion lookup tables.
  - `PhotogrammetrySample(contentsOf:)` loads the depth. It agrees with the source AVDepthData to within 0.011 mm. **LiDAR depth was captured on this run.**
- **Exposure:**
  - 118 frames were shot at **1/40 s, ISO 1000**; two at 1/120 s, ISO 3200.
  - With the object turning in a hand, 1/40 s produces motion blur. For example, a 30°/s rotation at 5 cm radius moves the surface about 26 mm/s. At 1/40 s that is about 0.65 mm of travel. At 4032 px across a ~35 cm field of view (about 11.5 px/mm) that is about 7.5 px of blur. At 1/500 s it is about 0.6 px. **[inference: arithmetic]**
  - The owner is right: the cure for blur is a shutter-speed policy. "Move slowly" is not.
- **Framing:** the object mask covers a median of **1.9%** of the frame (maximum 12%). Apple says to "position the object so it fills as much of the camera's frame as possible".
- **Masks:** three masks are empty (0048, 0074, 0089). Frame 0100 kept only a sliver of thumb.
- **The object itself:** a reflective, thin, metallic multitool. Apple's photography guide says to avoid objects that are "very thin in one dimension, highly reflective".
- **Mac result:** 117 samples were accepted, then the same CoreOC -15/processError. The detailed CorePhotogrammetry message is redacted (`<private>`).
- **Logging gap:** the companion discards the helper's stderr (`services/companion/src/objects/reconstruct.ts:51-55` spawns the helper without keeping a transcript). That is an observability defect to fix.

### 1c. Current build (5cd5f55 and later; W/…/HandheldCapture.swift, HandheldDepthRecorder.swift): not yet proven on the device
- **What the build now does:**
  - Streams rear `builtInLiDARDepthCamera` video plus depth through `AVCaptureDataOutputSynchronizer`:
    - HandheldCapture.swift:45 opens the camera.
    - HandheldDepthRecorder.swift:331–408 picks the formats; line 400 sets up the synchronizer.
  - Runs at 30 fps with unfiltered depth (line 384).
  - Saves HEIC pairs plus lossless Float32 depth sidecars.
  - The Start gate refuses frames with exposure or ISO of 0 (HandheldCapture.swift:122–127). This directly guards against failure 1a.
- **The only device diagnostic:** T/phone-stream-failure-4535/capture-ui-diagnostics.json holds a single `configured` snapshot, taken just after `startRunning`: `sessionRunning: true, previewRendering: true, rgbReceived: false, depthReceived: false, framesSaved: 0`.
  - That snapshot proves nothing either way.
  - Later diagnostic launches failed because the phone was locked (T/phone-diagnostic-launch-bb081354.json, FBS "Locked").
  - **Whether this build streams synchronized RGB-D on the device is still unverified.**
  - **Next device check:** the bb08135 diagnostic harness already exists. Launch on an *unlocked* phone with `-STMHandheldPreview ready -STMHandheldDiagnosticSeconds 10`, then read `capture-stream-diagnostics.json` (written every second) for `synchronizedCallbacks`, the `videoReceived`/`depthReceived`/`calibratedPair` counts and the drop reasons.
- **Design problems with this build, even if it streams:**
  - It records *video* frames with continuous auto-exposure. `setExposureModeCustom` and `activeMaxExposureDuration` appear nowhere in the recorder. At 30 fps, auto-exposure may run up to about 1/30 s, which is the same blur problem as 1b.
  - Video frames are lower resolution than stills (`preferredMaximumVideoWidth`).
  - The guidance problems remain: the device-era 43edcb4 lines 15 and 241 say "Turn it slowly" and "Once more on its side".

**Bottom line for Q1:** the black run used the front camera and never touched LiDAR. The visible run used LiDAR correctly but failed on input quality: long shutter, tiny object in frame, a reflective thin object and mask misses. The streaming rewrite fixes the camera choice but not the exposure policy, and it has not been verified on the device.

---

## 2. Apple's current facts (sourced)

1. **ObjectCaptureSession (iOS 17+).**
   - Its only object-reorientation feature is flipping the object on a surface: `beginNewScanPassAfterFlip()`. Apple's description: "after capturing one side of an object, the session can be paused and the user can be prompted to flip the object to a new side… transition the session back to the `.ready` state waiting for a new bounding box selection… the reconstruction process in PhotogrammetrySession will stitch these multiple captures together automatically… only valid in object-centric scanning." [S1]
   - Area mode (WWDC24) is the other mode. [S2]
   - I found **no** in-hand or handheld-object mode in iOS 26 or iOS 27 documentation or WWDC25/26 sessions. [S3]
   - The iOS 26 release notes (as summarized in search results; I could not fetch the page body) list an improved PhotogrammetrySession algorithm for low-texture objects, which needs no code change. [S3]
   - WWDC26 shows RealityKit object scanning into Gaussian splats on visionOS 27, and ARKit reference objects on iOS 27 [S4]. Neither is an in-hand photogrammetry mode for iOS. I treat this as "no native in-hand mode" with moderate confidence; check the iOS 27 RealityKit release notes once before building.
2. **PhotogrammetrySession on macOS (macOS 12+).**
   - `PhotogrammetrySample` holds "a single input image… along with… a depth buffer, an object mask, or gravity vector". [S5]
   - **depthDataMap:** "can help PhotogrammetrySession determine the real-world scale… Depth data can be in either `kCVPixelFormatType_DisparityFloat32` or `kCVPixelFormatType_DepthFloat32`." [S6]
   - **objectMask:** `kCVPixelFormatType_OneComponent8`, the same width and height as `image`. RealityKit ignores pixels where the mask is 0 unless `isObjectMaskingEnabled` is false. [S7]
   - **isObjectMaskingEnabled:**
     - With true and no masks supplied, RealityKit tries an automatic mask, and falls back to the full image if that fails.
     - With true and masks supplied, it uses the supplied masks.
     - With false, it never masks. [S8]
   - **gravity:** "indicates the orientation of the camera… RealityKit uses this gravity vector to improve landmark matching". A world-gravity vector is wrong once the object moves in the hand, so clearing it, as `HandheldKit/Samples.swift:30` already does, is correct. **[inference from the definition]** [S9]
   - **Configuration** has `sampleOrdering`, `featureSensitivity`, `isObjectMaskingEnabled`, `ignoreBoundingBox`, `customDetailSpecification`, `checkpointDirectory` and `meshPrimitive`. [S10]
   - **Moving or flipping the object between shots is explicitly allowed.** Apple: "You can move the object between shots in order to photograph all sides", and "Standing the object on different sides while photographing it on a turntable captures the entire object". Images need "70% overlap or more. Anything less than 50%… may fail". Also: "keep your camera settings as consistent as possible… shutter speed, or ISO", "fills as much of the camera's frame as possible", "masking out objects in the background", and avoid thin, reflective, transparent or textureless objects. [S11]
3. **AVFoundation with builtInLiDARDepthCamera (iOS 15.4+).**
   - It is "two cameras, one LiDAR and one YUV… synchronizes and perspective-corrects this data to frames that the YUV camera produces… field of view and aspect ratio always match." [S12]
   - Apple's sample demonstrates **both** a synchronized video-plus-depth streaming mode and a photo-with-depth mode. [S13]
   - Photo depth requires `AVCapturePhotoOutput.isDepthDataDeliveryEnabled = true` before `startRunning`. Changing it while the session runs freezes the preview. [S14]
   - **Manual exposure:** `setExposureModeCustom(duration:iso:)` throws if values are out of range. The range is set by the active format's `minExposureDuration`/`maxExposureDuration` and ISO limits [S15, S16].
     - Crucially, with `AVCapturePhotoOutput` the default `photoQualityPrioritization = .balanced` "allows photo capture to temporarily override the capture device's exposure duration and ISO… To ensure that the system honors the device exposure duration and ISO… you must [set] photo quality prioritization to `.speed`." [S15]
   - **Auto exposure with a cap:** `activeMaxExposureDuration` caps the duration auto-exposure may pick. It must lie within the format's min/max and resets whenever `activeFormat` or `sessionPreset` changes. [S17]
   - The numeric shutter limits for the iPhone 17 Pro LiDAR formats are not published. Read `activeFormat.minExposureDuration`, `maxExposureDuration`, `minISO` and `maxISO` on the device and log them.
4. **ARKit.**
   - `sceneDepth` gives LiDAR depth per frame through world tracking [S18].
   - World tracking estimates the *device* pose relative to the world. A held object that moves relative to the world gets no object-relative pose, so ARKit camera transforms are useless for object reconstruction and would corrupt gravity and pose priors. **[inference]** I could not extract a quoted "static scene" sentence from Apple's world-tracking page in budget.
   - `ARObjectScanningConfiguration` is "for use only in development scenarios" and produces reference objects, not meshes [S19].
   - Verdict: don't use ARKit for in-hand capture. AVFoundation is the right layer.
5. **Vision, for removing the hand.**
   - `VNGenerateForegroundInstanceMaskRequest` (iOS 17 / macOS 14) produces instance masks of salient objects; a held object and the hand are often merged into one instance. [S20]
   - `VNGeneratePersonInstanceMaskRequest` (iOS 17 / macOS 14) produces per-person masks [S21].
   - `VNGeneratePersonSegmentationRequest` (iOS 15 / macOS 12) produces a person matte [S22].
   - `VNDetectHumanHandPoseRequest` (iOS 14 / macOS 11) produces hand joints [S23].
   - Apple has no dedicated hand-segmentation request.
   - The existing `HandheldKit/ObjectMasker.swift:47-49` already combines foreground instance, hand pose and person segmentation.

---

## 3. Recommended pipeline

**Mode placement.** Leave the walk-around ObjectCaptureSession flow alone.
- v1: in-hand is a **separate mode**, "Hold It", for small objects (roughly 3–15 cm) that can't sit still or whose bottom matters.
- Offer it as an optional follow-up at the end of a walk-around ("Get the underside"). The handheld set then reconstructs on the Mac as its own sample set, and any merge happens later at the mesh level.
- Do not mix ObjectCaptureSession images, which carry world gravity and pose metadata, with gravity-free handheld images in one PhotogrammetrySession until a controlled experiment shows it works. **[inference: untested]**

**Capture: stills, not video.**
- `AVCapturePhotoOutput` on `builtInLiDARDepthCamera`, with `isDepthDataDeliveryEnabled = true` before `startRunning`, `embedsDepthDataInPhoto = true` and `isDepthDataFiltered = false`. Keep the lossless Float32 sidecar from the current codec.
- This is the path proven on the device in 485defc7. Video frames are smaller and AE-driven; stills give full resolution.
- Fire automatically at about 2–3 photos/s while the user turns the object.

**Exposure policy.**
- Meter with continuous auto-exposure until the image is stable. Then call `setExposureModeCustom(duration: T, iso: ISO_metered × (T_metered / T))`.
- T = 1/500 s by default, with a floor of 1/250 s. Clamp T and ISO to the format limits.
- Set `photoQualityPrioritization = .speed` so the camera honors those values [S15].
- Lock white balance. Keep focus continuous: held distance varies more than depth of field allows. **[inference]**
- **The light budget, stated honestly.** In 485defc7 the owner's room metered 1/40 s at ISO 1000.
  - Holding the same brightness at 1/500 s needs about ISO 12,500; at 1/250 s, about ISO 6,250.
  - That is about 2.5–3.5 stops more light than the owner's room, or far more ISO than gives clean images.
  - The policy therefore has two tiers:
    1. **Preferred:** T = 1/500 s (floor 1/250 s), with ISO allowed up to the format's measured `maxISO`. Accept the sensor noise: photogrammetry tolerates noise much better than blur. **[inference]**
    2. **Fallback, when even maxISO can't reach 1/250 s:** use T = 1/125 s and shoot short bursts of 3–4 stills per angular step. Keep only the sharpest frame in each angular bin, scored by variance-of-Laplacian inside the object mask. Reject bins whose best frame is under a sharpness threshold calibrated on the device.
  - Show "More light will give a sharper scan" as a nudge, not a block. Block only when even the fallback can't produce sharp frames. Never say "move slowly".
- Log the format limits and the per-shot exposure.

**Framing gate.** Use the LiDAR depth plus the mask to require the object to fill at least about 15% of the frame, at a distance that still returns valid depth. The minimum valid LiDAR range is not published, so measure it on the device.

**Masking (object minus hand).**
1. Foreground instance mask, choosing the instance under the hand-pose centroid.
2. Subtract the union of the person instance mask (iOS 17+) and person segmentation.
3. Dilate the subtraction around hand-pose joints.
4. **Depth gate:** keep pixels within the object's depth band (median depth of the seed region ± the object's extent). This removes the background and most of the forearm.
5. Reject any frame whose mask is empty, under 3% of the frame, or more than 2× different in area from its neighbors. Ask for re-coverage instead of sending it.
6. Mask on the device as a live check, and recompute masks on the Mac at full resolution.

**Coverage guidance without flipping.**
- Use grips instead of flips. Three passes:
  1. Hold it by the top and bottom; turn it a full circle.
  2. Change grip so your fingers sit on the sides; turn it again.
  3. Tilt it toward the phone ("show me the top"), then away ("show me the bottom") while turning.
- Every surface the fingers covered in one grip is visible in another.
- Show progress with a ring per pass, filled by estimated rotation. Estimate rotation from optical flow or feature tracks inside the object mask between consecutive stills; that is an engineering estimate, not an Apple API. **[inference]**
- Enforce overlap: a new still only when estimated rotation since the last one is roughly 8–12°, which keeps adjacent overlap above Apple's 70% [S11]. Warn if a step exceeds about 20°.
- Target 60–120 stills.

**Depth for metric scale.**
- Supply `depthDataMap` (DepthFloat32) and the calibration on every sample [S6]. Keep `gravity = nil`.
- After reconstruction, check scale independently: median masked depth × intrinsics gives the object's apparent size, to compare against the mesh bounding box. Flag a mismatch over 3%.

**Mac reconstruction.** `PhotogrammetrySample` with:
- `image`,
- `depthDataMap`,
- `objectMask` (OneComponent8, same size),
- `gravity = nil`,
- `isObjectMaskingEnabled = true`,
- `sampleOrdering = .sequential`,
- `featureSensitivity = .high` for low-texture objects,
- `ignoreBoundingBox` as needed.

That is mostly what `tools/mac-reconstruct` already does, except `.high` sensitivity. Also: persist the helper's stdout and stderr per job, and surface the per-sample errors PhotogrammetrySession reports.

**Failure states, each with a fix shown to the user:**

| Failure | Message / action |
|---|---|
| Camera not streaming, or exposure/ISO 0 | "Camera didn't start." Retry, and keep the diagnostics. |
| No depth on a frame | Block. |
| Too dark for 1/250 s within ISO cap | "Needs more light." |
| Object too small or too far | "Bring it closer." |
| Mask lost or hand covering the object | "Hold it by the edges." |
| Coverage gap | "Show me the bottom." |
| Reflective or transparent object | Warn before capture. Apple advises against these; suggest matte spray or powder [S11]. |
| Mac -15/processError | Show the real cause from the transcript, keep the photos, offer "Add more photos". |

---

## 4. Pass/fail test (real device)

- **Objects.** Use measured dimensions, not nominal ones, for the ground truth.
  - (A) A matte, textured, Bambu-printed calibration part with CAD dimensions; 3DBenchy is a good choice, with an underside that needs coverage. Caliper-measure the actual print as ground truth.
  - (B, optional) One matte, textured commercial object whose dimensions come from a cited manufacturer spec sheet; choose it when running the test and record the citation. Measure it with calipers too. Don't use shiny objects, such as aluminum cans, as a pass/fail case: §2 and §3 say to avoid reflective surfaces, so they would fail for reflectivity, not because of the pipeline. Treat one only as a deliberately hard secondary case.
- **Procedure.**
  - In-hand mode only: three grip passes indoors in normal light, then the Mac reconstruction at full detail.
  - Measure the mesh with the existing model-measuring tool (`tools/mac-reconstruct`, KAN-208). Use its oriented bounding box if it computes one; I did not verify that. Otherwise align the mesh by PCA before measuring the bounding box. Add one feature dimension per object, such as the Benchy chimney bore.
- **Pass requires all of:**
  1. Every saved still has nonzero exposure, ISO and depth, and shutter ≤ 1/250 s.
  2. The mask holds the object in at least 95% of frames, with no hand geometry in the mesh: the bounding box exceeds the true size by at most the tolerance.
  3. Each bounding-box axis is within **±1.0 mm or ±1.5%, whichever is larger**, of caliper truth. The feature dimension is within ±1.0 mm.
  4. The bottom is closed: no hole larger than 5 mm in the underside (inspect the mesh, or check manifoldness in scan-repair).
  5. Repeatability: two independent scans agree within 1%.
- **Report.** Any fail reports which gate failed, plus the transcript.

---

## Sources
- [S1] beginNewScanPassAfterFlip() — https://developer.apple.com/documentation/realitykit/objectcapturesession/beginnewscanpassafterflip()
- [S2] WWDC24 "Discover area mode for Object Capture" — https://developer.apple.com/videos/play/wwdc2024/10107/
- [S3] iOS & iPadOS 26 Release Notes (Object Capture low-texture item, via search summary) — https://developer.apple.com/go/?id=ios-26-rn ; WWDC23 Object Capture — https://developer.apple.com/videos/play/wwdc2023/10191/
- [S4] WWDC26 "Build next-generation experiences with visionOS 27" — https://developer.apple.com/videos/play/wwdc2026/287/ ; WWDC26 "Explore enhancements to visionOS object tracking" — https://developer.apple.com/videos/play/wwdc2026/283/
- [S5] PhotogrammetrySample — https://developer.apple.com/documentation/realitykit/photogrammetrysample
- [S6] depthDataMap — https://developer.apple.com/documentation/realitykit/photogrammetrysample/depthdatamap
- [S7] objectMask — https://developer.apple.com/documentation/realitykit/photogrammetrysample/objectmask
- [S8] isObjectMaskingEnabled — https://developer.apple.com/documentation/realitykit/photogrammetrysession/configuration-swift.struct/isobjectmaskingenabled
- [S9] gravity — https://developer.apple.com/documentation/realitykit/photogrammetrysample/gravity
- [S10] PhotogrammetrySession.Configuration — https://developer.apple.com/documentation/realitykit/photogrammetrysession/configuration-swift.struct
- [S11] Capturing photographs for RealityKit Object Capture — https://developer.apple.com/documentation/realitykit/capturing-photographs-for-realitykit-object-capture
- [S12] builtInLiDARDepthCamera — https://developer.apple.com/documentation/avfoundation/avcapturedevice/devicetype-swift.struct/builtinlidardepthcamera
- [S13] Capturing depth using the LiDAR camera — https://developer.apple.com/documentation/avfoundation/capturing-depth-using-the-lidar-camera
- [S14] AVCapturePhotoOutput.isDepthDataDeliveryEnabled — https://developer.apple.com/documentation/avfoundation/avcapturephotooutput/isdepthdatadeliveryenabled
- [S15] setExposureModeCustom(duration:iso:completionHandler:) — https://developer.apple.com/documentation/avfoundation/avcapturedevice/setexposuremodecustom(duration:iso:completionhandler:)
- [S16] Format.minExposureDuration / maxExposureDuration — https://developer.apple.com/documentation/avfoundation/avcapturedevice/format/minexposureduration
- [S17] activeMaxExposureDuration — https://developer.apple.com/documentation/avfoundation/avcapturedevice/activemaxexposureduration
- [S18] ARConfiguration.FrameSemantics.sceneDepth — https://developer.apple.com/documentation/arkit/arconfiguration/framesemantics-swift.struct/scenedepth
- [S19] ARObjectScanningConfiguration — https://developer.apple.com/documentation/arkit/arobjectscanningconfiguration
- [S20] VNGenerateForegroundInstanceMaskRequest — https://developer.apple.com/documentation/vision/vngenerateforegroundinstancemaskrequest
- [S21] VNGeneratePersonInstanceMaskRequest — https://developer.apple.com/documentation/vision/vngeneratepersoninstancemaskrequest
- [S22] VNGeneratePersonSegmentationRequest — https://developer.apple.com/documentation/vision/vngeneratepersonsegmentationrequest
- [S23] VNDetectHumanHandPoseRequest — https://developer.apple.com/documentation/vision/vndetecthumanhandposerequest
- Scanning objects using Object Capture (GuidedCapture sample; requires iOS 18+, LiDAR, A14+) — https://developer.apple.com/documentation/realitykit/scanning-objects-using-object-capture

Not verified within budget: the iOS 27 / macOS 27 RealityKit release notes body; a quoted ARKit "static environment" sentence; numeric LiDAR-format exposure and ISO limits and minimum depth range on the iPhone 17 Pro Max (read them on the device).
