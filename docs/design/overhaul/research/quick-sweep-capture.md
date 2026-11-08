# Quick sweep: one pass around the object, no box, no mode

Date: 2026-11-08. Revised the same day after two reviews (Muse: API and repo truth; Argon: spatial). **Design only; nothing here is built.** It covers the walk-around and the rig. In-hand capture ([inhand-capture.md](inhand-capture.md), PRD §11) is a different problem (the object moves) and stays in Labs.

David, Nov 8, after his first real scan:

> "you shouldn't have to spin it around for 8 fucking minutes. apple can take one partly blurry picture and erase an object or pull it out instantly… one quick video around with that thing, should be instant good to go combined with the other stuff"

> "the box around the thing it forces you to make is damn near impossible to use, users shouldn't have to do that. i also had to switch area and object mode a bunch of times… no user will know which one to do. it should USE SAM and common sense to figure out which object is obviously important"

> "look at the spatial vision function that it uses for apple vision pro too, don't rely on it, but think about it for sure. don't get too sidetracked with that."

And: "something like this exists already that we're not using."

How to read the markers:
- **[A#]**: an Apple API or document, listed with URL and availability in §14. Every availability was read from Apple's documentation JSON on Nov 8.
- **[inference]**: reasoning, not something Apple documents.
- **[measure]**: must be measured on David's iPhone, Mac or rig before anything depends on it.
- **[estimate]**: a planning number, to be replaced by a measurement.
- **New (proposed)**: a rule that isn't in the PRD yet and needs David's OK.

---

## 0. Recommendation in one screen

**Recommended: Option A, Apple's own `ObjectCaptureSession` in freeform.**
- Record calls `startCapturing()` straight from `.ready`. That is Apple's documented path for "freeform scanning where the user skips the bounding box selection" [A19]. No box, no `startDetecting()`.
- No Area/Object choice, no segments, no flip.
- Two loops: low (~15°), then high (~45°).
- Every image goes to the Mac.
- The Mac loads each of Apple's HEICs with `PhotogrammetrySample(init(contentsOf:))`. That keeps Apple's get-only per-image data: camera `transform`, `intrinsics`, `calibrationData`, depth, depth confidence and gravity [A12, A12c]. Our object masks are added on top.

Why A first:
- **It keeps what custom samples lose.** `PhotogrammetrySample.camera`, `boundingBox`, `depthConfidenceMap`, `sessionID` and `scanPassID` are get-only. Only HEICs written by `ObjectCaptureSession` populate them [A12c].
- **Most of it already exists.** Our sample already starts freeform with `session.startCapturing()` (`GuidedCaptureSample/Views/BottomOverlayButtons.swift:116-117`) and already sets `isOverCaptureEnabled = true` (`AppDataModel.swift:419`).
- **It is cheaper.** Stage 1a of A is mostly configuration, upload and Mac work: about 1–2 weeks against 4–6 for B **[estimate]**.

What A can't do:
- **Exposure is Apple's.** On Nov 8 it shot 59 frames at 1/60 s, and no API changes that.
- **Tracking pauses stop capture.** When ARKit tracking isn't normal, "many of the Object Capture algorithms… pause" [A19b]. A rig with a backdrop that moves with the arm may trigger that.
- **The fallback is designed but not built.** Option B, an ARKit sweep with its own exposure and keyframes (§4), is built only if A fails a named, measured gate on the DAD sign (§2.3).

**Time target, revised: about 40 s, at most 60 s.** A single loop puts the camera centres on a flat circle, which says nothing about the top or the underside of overhangs (Argon S1). Two loops of roughly 15–20 s each is the honest minimum.

---

## 1. What went wrong on Nov 8

| What David hit | Cause | In this design |
|---|---|---|
| 8 minutes | Object mode guides three segments with flips (WWDC23 10191 [S1]); our sample follows it. | Freeform, two loops, finished by our coverage ring calling `finish()` [A19]. |
| The box was "damn near impossible" | `startDetecting()` "returns `false`… if no horizontal plane is detected along the ray originating at the center of the screen", then the person drags the box [A19]. | Freeform never calls `startDetecting()`. `hideObjectReticle(true)` hides the reticle [A23]. |
| Switching Area and Object | Our sample offers both (`AppDataModel.captureMode`, `TopOverlayButtons.swift:128-132`). | Area (freeform) is the only path. Object mode and its onboarding states leave the flow. |
| "More Light Recommended" constantly | Our sample prints `environmentLowLight` (`FeedbackMessages.swift`). Apple's own doc says "Auto-capture still proceeds" [A18]. | Not shown. Light advice, if any, comes once after capture, from measured sharpness (§3.3). |
| The Mac rebuilt nothing | `MacConnection.sendCapture` sends `ProjectUploader.spread(names, count: 24)` plus the phone's `.reduced` USDZ (`MacConnection.swift:206-220`). | Every image goes, with a manifest that marks it as an Object Capture set (§3.4). |

- **Untested so far:** David did try Area mode on Nov 8, but the Mac only ever got 24 photos, so we don't know whether an area-mode capture rebuilds well on its own. Stage 1a answers exactly that.
- **Related work:** the Mac rebuild from every image is in progress on branch `fix/mac-reconstruction` (not filed yet). Stage 1a builds on it.

---

## 2. The two options compared

### 2.1 What each one is

- **A: Apple freeform capture.**
  - `ObjectCaptureSession` with `start(imagesDirectory:configuration:)`, then `startCapturing()` from `.ready` [A19].
  - Apple shows the camera in `ObjectCaptureView(session:cameraFeedOverlay:)`. Our ring lives in that overlay [A23].
  - Apple auto-captures (`isAutoCaptureEnabled`, iOS 18). We can add shots with `requestImageCapture()` when `canRequestImageCapture` [A19c].
  - The Mac rebuilds from Apple's HEICs.
- **B: our own ARKit sweep (§4).**
  - `ARWorldTrackingConfiguration` with LiDAR `sceneDepth`, our exposure, our keyframes and our sidecars.
  - The Mac rebuilds from custom `PhotogrammetrySample`s, which can't carry camera poses [A12c]. RealityKit estimates its own.

### 2.2 Side by side on the DAD sign

The DAD sign: matte black letters on a wooden base, lime backdrop, by hand and on the Kass 3D rig. The counters of A and D are through-holes.

| | A: Apple freeform | B: ARKit sweep |
|---|---|---|
| **Person does** | Record, two loops, done (auto) | Same |
| **Capture time** | ~40 s, cap 60 s. Apple's freeform shot rate is unknown **[measure]**. | ~40 s, cap 60 s |
| **Per-image pose and intrinsics in the rebuild** | **Yes**: Apple's `camera.transform`, `intrinsics` and `calibrationData`, get-only, in the HEIC [A12c] | **No**: there is no settable pose field [A12]. RealityKit estimates poses; ours are used only around it (the fit and the masks). |
| **Depth in the rebuild** | Apple's own, registered by Apple, with `depthConfidenceMap` [A12c] | ARKit `sceneDepth`. Its registration to a 4K frame or still is **unproven** (Muse S5), so it stays out of samples until a measured gate passes (§4.6). |
| **Gravity** | Apple's, in the HEIC | CoreMotion, sensor frame, A/B tested |
| **Exposure control** | **None.** Apple's choice (1/60 s on Nov 8). Apple's `movingTooFast` means capture "may be paused to ensure quality" [A18b]. | **Yes**: shutter priority (iOS 27) or an auto-exposure cap, between 1/250 and 1/125 s (§4.2) |
| **Rig with a backdrop that moves with the arm** | **Risk.** If tracking isn't normal, Apple shows its coaching overlay and its algorithms pause [A19b], so there are fewer or no images. | Keeps recording. ARKit yaw is checked against the gyro, with an orbit-pose fallback and chroma or depth masks (§4.4). |
| **Matte black letters** | The photos carry the shape; LiDAR confidence is low on black [A2]. Masks are 2D-first (§3.6), so the letters are kept. | Same, plus a shorter shutter. ISO noise on the black faces is higher. |
| **Wood base** | Textured: good landmarks | Same |
| **Lime backdrop** | Chroma key for masks (§3.6) | Same |
| **A and D through-holes** | Kept only if the masks show background through them (A2). Apple's automatic masking (A1) may fill them **[measure]**. | Same, from our masks |
| **Build cost [estimate]** | Phone 2–3 days, companion 1, Mac 3–5 on top of `fix/mac-reconstruction`, gate 2 | Phone recorder and exposure 8–11 days, upload contract and validators 2–3, Mac 5–7, rig drift 2–3, iOS masker port 3–5 |
| **Biggest unknown** | Whether Apple's 1/60 s frames give sharp letter edges; whether Apple pauses on the rig | Whether ARKit 4K carries `sceneDepth`; the still rate; exposure behaviour inside ARKit |

### 2.3 Escalation gates: when A is not enough

These are measured in Stage 1a on the DAD sign: 2 scans by hand, 3 on the rig. If any gate fails because of capture (not the Mac), build B for the case that failed.

- **G1: sharpness.**
  - Passes when the size criteria of PRD §11 hold: every axis within ±1.0 mm or ±1.5%, and the feature dimension.
  - If a miss is traced to blur, it fails. "Traced to blur" means more than 15% of images fall below the sharpness line inside the mask. The line is the variance of the Laplacian, set on rig frames **[measure]**.
- **G2: rig tracking.**
  - Passes when, on the rig, `cameraTracking` is `.normal` for at least 90% of capture time and each loop yields at least 30 images.
  - If it fails, B covers the rig, or the backdrop is fixed so it no longer moves with the arm.
- **G3: time.**
  - Passes when Done → model on the Mac takes at most 4 min.
  - If it fails because of capture or upload, B helps. If the Mac itself is the bottleneck, B can't.
- **G4: shutter rule.** PRD §11.1 says rig exposure "follows §11: 1/250 s or faster", and A cannot promise that.
  - If G1 passes at Apple's shutter, propose to David that §11.1 judge sharpness by outcome (G1) instead of by shutter **(new, proposed)**.
  - If he keeps the shutter rule, that alone means B.

---

## 3. Option A in detail (recommended)

### 3.1 Capture

- **Start:**
  - `ObjectCaptureSession()` and `start(imagesDirectory:configuration:)`.
  - `isOverCaptureEnabled = true`, so capture continues past `maximumNumberOfInputImages` "when the images are intended to be transferred to macOS" [A19c]. `checkpointDirectory` is unchanged.
- **Record** calls `startCapturing()` from `.ready` [A19]. Before that, `ObjectCaptureView(...).hideObjectReticle(true)` [A23].
- **Session settings:**
  - `isAutoCaptureEnabled = true` [A19c].
  - `shouldPlayHaptics = false` (iOS 18) [A19c]. PRD §10 allows only "success when a result is ready and the app is open, and a warning on a plate alert".
  - No on-device reconstruction. The Mac rebuilds, so the phone's `.reduced` USDZ is redundant, and skipping it saves phone time and heat.
- **Finish:** `finish()` [A19], called by the coverage ring (§3.2) or by pressing Record again.
- **Removed from the flow:**
  - the Area/Object switch and `captureMode` (Area is the only path);
  - the onboarding state machine's orbit and flip states (`AppDataModel.determineCurrentOnboardingState`);
  - the tutorial video;
  - the `FeedbackMessages` strings for `environmentLowLight` and `environmentTooDark`.
- **Kept feedback:** `movingTooFast` and `outOfFieldOfView`, as single short hints, because they explain a pause [A18b].

### 3.2 Coverage without Apple's pose

`ObjectCaptureSession` publishes no camera pose during capture [A19c], so the ring is filled from **CoreMotion** [A21]. That is why A needs a second motion stream (Muse S16).
- **Attitude source:** device-motion attitude in `.xArbitraryZVertical` [A21], giving yaw about gravity and pitch.
- **Why yaw works:** when the phone circles an object while pointing at it, its heading turns a full 360°, by hand or on the rig **[inference: geometry]**.
- **The ring:** two bands by camera pitch, low (looking down 0–30°) and high (30–60°), each with 36 sectors of 10°.
  - A sector fills when `numberOfShotsTakenUpdates` reports a new shot while the phone's yaw is in that sector [A19c].
  - If a sector stays empty, `canRequestImageCapture` is true and the gyro is quiet (|ω| < 3°/s), the app calls `requestImageCapture()` [A19c].
- **Auto-finish:** both bands have at least 32 of 36 sectors, or 60 s pass and the gaps show. These are starting numbers **[measure on the DAD sign]**.
- **Drift:** yaw in this frame drifts slowly, a few degrees per minute **[inference]**. That is acceptable over 60 s, and is why sectors are 10° wide.

### 3.3 Exposure

**Not controllable in A.**
- `ObjectCaptureSession` exposes no camera device. `ObjectCaptureSession.Configuration` has only `checkpointDirectory` and `isOverCaptureEnabled` [A19c].
- Changing ARKit's `configurableCaptureDeviceForPrimaryCamera` while Apple's session runs is undocumented, so we won't.

What we do instead:
- Log `ExposureTime` and `ISOSpeedRatings` from each HEIC's EXIF.
- Measure sharpness inside the mask on the Mac, and report both in the receipt.
- Light advice appears once, after Done, only when more than 20% of images fall under the sharpness line: "More light would make it sharper".

This is A's real weakness. G1 and G4 (§2.3) decide whether it matters for the DAD sign.

### 3.4 What goes to the Mac (upload contract)

| Item | Today | A needs |
|---|---|---|
| Images | `sendCapture` sends 24 spread photos as `photo` kind (`MacConnection.swift:206-220`). | Every `Images/IMG_NNNN.HEIC` (`CaptureFolderManager.swift:122-123`) as `capture` kind, renamed `NNNN.heic` on upload. The bytes are unchanged. `parseCaptureManifest` accepts only `^[0-9]{4}\.(heic\|jpe?g\|png)$` (`service.ts:135-148`). |
| Manifest | `{version: 1, images, depthRequired, cameraMetadataRequired?, scaleQualificationRequired?}`. Unknown keys are dropped, not carried into the digest (`service.ts:135-158`). | Add `source: "object-capture"`: parsed, bound into `captureDigest`, and used to route. Without it the companion treats the set as handheld and runs `samples`, which clears gravity (`Samples.swift:30`). That is wrong for a still object. |
| Depth | The `capture-depth` route accepts only `NNNN.depth.plist` bplists (`http.ts`). | **None.** Apple's HEIC embeds depth and confidence. |
| Scan USDZ | Required by `sendCapture`. | Not sent; the Mac rebuilds. |
| Uploader | `ProjectUploader` actor: sequential, in memory, skips what the Mac has (`Uploads.swift:27-80`), on `URLSessionConfiguration.ephemeral` (`Transport.swift:75`). PRD §5.2 says background `URLSession`; the code doesn't use one. | Unchanged in Stage 1a. A send cut short resumes by skipping files already sent. A background session is a separate item (§12, Stage 3). |

- **Data [estimate; measure]:** 40–80 images × ~3–5 MB (12 MP HEIC with depth and metadata) = 120–400 MB.
- **Upload target in Stage 1a:** at most 60 s after Done, using the sequential uploader measured on David's network. This replaces the earlier "≤ 15 s", which contradicted its own data table (Muse S13).

### 3.5 Mac reconstruction

Stage 1a runs three variants on the same DAD captures and keeps the best.

- **A1: folder.**
  - `PhotogrammetrySession(input: <folder URL>)` [A11b], the existing `mac-reconstruct <folder>` path, with `isObjectMaskingEnabled = true`.
  - In freeform there is no box, so RealityKit "attempts to automatically create a mask… reverts to… the entire image" [A14].
  - Zero new code.
- **A2: Apple samples plus our masks.**
  - Each HEIC is loaded with `PhotogrammetrySample(contentsOf:)` (iOS 18 / macOS 15), which "populates as many data fields as can be found… HEIC images captured with ObjectCaptureSession will contain more advanced data fields" [A12c].
  - Then `objectMask` is set; it is the one settable field we add [A12]. `gravity` is **kept**.
  - Whether `PhotogrammetrySession` uses the `camera` data of samples passed this way isn't documented **[measure]**: compare the A1 and A2 `.poses` against `sample.camera.transform`.
- **A3:** A2 without masks, as the control.
- **Configuration:**
  - `sampleOrdering = .sequential` [A14].
  - `featureSensitivity = .normal`, switched to `.high` **automatically** (Argon S4) when the median luma inside the masks is below 60/255, or more than 30% of the `depthConfidenceMap` pixels inside the masks are low. Otherwise `.high` is a retry, used when more than 25% of samples are skipped [A14].
- **Requests:** `.poses`, `.bounds` and `.modelFile(url:detail: .full)` in one `process(requests:)` call [A13].

### 3.6 Finding the object on the Mac ("SAM and common sense")

No box. This builds A2's masks from Apple's per-image camera and depth.

1. **Where the person was pointing.**
   - Take the least-squares point nearest to every image's optical axis (`camera.transform`) [A12c] **[inference: geometry]**.
   - By hand or on the rig, every loop converges on the object.
2. **Up.**
   - Up is −gravity from each sample's `gravity` [A12], never the camera-centre SVD.
   - A one-height loop is a flat circle, and `linux-reconstruct`'s fit gate (`scale.py:23,193-196`, second/first eigenvalue ratio ≥ 0.02) passes a flat circle (Argon S1).
3. **Support surface.**
   - The **highest** local horizontal surface under the convergence point: depth points whose normal is within 10° of up, within 15 cm.
   - On the rig, that is the platform, not the desk (Argon S3).
4. **Silhouettes first, depth second (Argon S3).**
   - Per image, `GenerateIterativeSegmentationRequest(seedPoint:)` at the projected convergence point, `qualityLevel = .accurate` [A15].
   - On the rig, a **lime chroma key** is subtracted.
   - Depth trims the mask only where `depthConfidenceMap` is high. Matte black letters return low confidence [A2], so a LiDAR-tight box would keep only the wooden base, and the trim would decapitate the letters.
5. **Extent and height from mask rays.**
   - Carve a coarse visual hull (4 mm voxels) from the silhouettes and the camera poses. That gives the object's 3D box, including letters LiDAR missed.
   - Reject candidates that **span the backdrop**: they touch the frame edge in more than 50% of images, or lie on a vertical plane behind the convergence point.
6. **Two candidates within 2× of each other** (a mug beside the sign):
   - Stage 1a takes the convergence one and records the runner-up in the receipt.
   - Stage 2 asks once, through the existing **needs-you Ask card** (PRD §5.4: "its picture with the region highlighted"). It shows both outlines and "Which one?"; one tap.
7. **Objects not on a surface** (hanging, clamped):
   - Masks still come from convergence and silhouettes.
   - There is no plane cap; the bottom is reported as open.

Cost and platform (Muse S11):
- **Today:** `ObjectMasker` runs three Vision requests per image (hand pose, foreground instance, person segmentation) plus several promptable performs: hand seeds, box, sometimes a point (`ObjectMasker.swift:46-140`).
- **Fixed-object masking:** a **rewrite of its seeding**. `GrayImage`, components and I/O are kept.
  - Per image: one promptable perform, one chroma pass and the hull projection, about 0.2–0.5 s **[estimate; measure]**.
- **Platform:** `HandheldKit` is macOS-only (`Package.swift`: `.macOS(.v15)`). That is fine for A, which masks only on the Mac.

### 3.7 Scale, up, trim, bottom

**Scale is checked, not corrected (Muse S9).**
- The check is a robust similarity fit (Umeyama with a trimmed refit, using `linux-reconstruct`'s gates) between the `.poses` translations and the `sample.camera.transform` centres. Both come from Apple.
- `camera.transform` maps into "the world coordinate space tagged by sessionID" [A12c]. ARKit's world is metric **[inference]**.
- It passes when |s − 1| ≤ 1% **and** the hull extents agree within 1.5%.
- Otherwise the project says "Size couldn't be confirmed" and asks for one measurement through the existing `capture-measurement` flow. Scale is never corrected silently.
- `PhotogrammetrySession.Pose` semantics beyond "a 6DOF pose relative to the estimated coordinate system" [A13] are not documented: camera-to-world or world-to-camera, and units relative to the model file. They are listed as unknowns (§11).

**Up and trim:** rotate so −gravity points down (+Z up), and cut anything outside the hull box plus 1 cm.

**Bottom (Argon S5):**
- Fit the cut plane to the **mesh's own lowest open boundary in model space**: a plane through the lowest boundary loop's vertices, constrained to within 2° of level.
- Don't map a capture-time support plane into the model. A 1–2° tilt there slices 1.6–3 mm off one side.
- `scan-repair` gets a "cut at plane and cap" operation that caps **only closed intersection loops**.

**Through-holes are never filled.** A hole is real when any image's mask shows background through it, as with the counters of A and D.

---

## 4. Option B: our ARKit sweep (escalation design)

Kept and corrected, so it can be built quickly if a §2.3 gate fails.

### 4.1 Frames

- **Session:** `ARWorldTrackingConfiguration` with:
  - `frameSemantics = [.sceneDepth]`, after checking `supportsFrameSemantics` [A1];
  - `planeDetection = [.horizontal]` [A5];
  - `worldAlignment = .gravity` [A6].
- **Primary frames are 4K video (Argon S6):** `videoFormat = recommendedVideoFormatFor4KResolution` (iOS 16; nil if unsupported) [A7b]. WWDC22 gives "3840x2160 pixels at 30 frames per second" [S4]. Whether `sceneDepth` is delivered with the 4K format is **[measure]**.
- **Stills are secondary.** `captureHighResolutionFrame` allows one request in flight [A7], about 2.5–4 Hz per Argon **[measure]**. They are used only to top up bins.

### 4.2 Exposure (Muse S10, Argon S6)

- **The device.** `ARConfiguration.configurableCaptureDeviceForPrimaryCamera` (iOS 16).
  - Apple says it lets you "alter the appearance of a frame's captured image" and "is nil on devices that aren't equiped with an ultra-wide camera" [A8].
  - That exposure is among the things you can change comes from WWDC22 ("exposure or white balance") [S4], not from that page.
- **Locking.** Every change sits inside `lockForConfiguration()` / `unlockForConfiguration()`. Without the lock it throws `NSGenericException` [A9].
- **Shutter priority (iOS 27).**
  - Check: `activeFormat.supportsExposureModeCustom(lensAperture: AVCaptureDevice.autoLensAperture, duration: AVCaptureDevice.currentExposureDuration, iso: AVCaptureDevice.autoISO)`.
  - Then: `setExposureModeCustom(lensAperture: AVCaptureDevice.autoLensAperture, duration: CMTime(value: 1, timescale: T), iso: AVCaptureDevice.autoISO)` [A9].
  - `autoISO` and `autoLensAperture` are iOS 27 [A9].
- **Fallback:** continuous auto-exposure with `activeMaxExposureDuration = 1/T` (iOS 12) [A10].
- **Corrected reading of Apple's sentence.** Apple: "The applied exposure duration of streaming frames are limited to `activeMaxExposureDuration` when either lensAperture or ISO is set to 'Auto', but the full exposure duration may be applied during still capture" [A9]. So stills may get **the full duration we set**. It does not mean a longer automatic exposure.
- **Re-apply** after every `session.run(_:options:)`, after an interruption ends, and after any format change.
  - `activeMaxExposureDuration` resets when `activeFormat` changes (inhand-capture.md [S17]).
  - Whether ARKit's re-run resets the device is **[measure]**.
- **T:**
  - Start at 1/250 s.
  - Allow down to **1/125 s** whenever predicted blur is ≤ 1 px. 1/250 s indoors can underexpose ARKit's visual-inertial tracking (Argon S6).
  - Never write `activeVideoMin/MaxFrameDuration` (the KAN-217 P0 note in `HandheldDepthRecorder.swift`).
- **Check:** read `ARFrame.exifData` per frame [A3b].

### 4.3 Keyframes and the blur formula

**Blur, without counting rotation twice (Argon S6).** For each projected box corner X, in camera coordinates (metres):
- Ẋ = −ω × X − v
  - ω is the **gyro** rotation rate [A21], the only rotation source.
  - v is the camera's linear velocity from ARKit position differences, rotated into the camera frame. It is translation only.
- Image velocity: u̇ = (f / Z) · (Ẋ − (Ẋ_z / Z) · X)_{x,y}
- blur_px = t_exp · max over corners of ‖u̇‖. Keep the frame if blur_px ≤ 1.

**Coverage:** the same two bands as A, by view direction from the object centre. A frame becomes a keyframe when all of these hold:
- it is at least 6° from every keyframe;
- it is sharp (variance of the Laplacian inside the projected box);
- the box fills at least 15% of the frame.

**Depth:** the `sceneDepth` map, with invalid or low-confidence pixels set to **NaN, not 0** (Argon S7).

**Gravity:** from CoreMotion, in the **sensor (image) frame**, A/B tested (Argon S7).

### 4.4 Rig drift (Argon S2)

- **The check:** for every 10° of gyro yaw, compare ARKit's Δyaw about gravity with CoreMotion's. A difference of more than 3° over a loop means ARKit is drifting, for example because a backdrop that moves with the arm fills the view.
- **The fallback:**
  - **Orbit pose.** The rig rotates about a vertical axis at a fixed radius. The radius comes from the LiDAR distance to the object, yaw from the gyro, and elevation from the clamp pitch. Box projection and coverage use this pose.
  - **Masks:** lime chroma key ∩ the nearest depth cluster.
  - Those frames are marked `tracking: limited`, and the Mac relies on photogrammetry's own poses for them.

### 4.5 Object finding live (B only)

- The same rules as §3.6: convergence, highest support surface, 2D-first silhouettes, hull height, backdrop rejection.
- It runs on the phone, which needs `ObjectMasker`'s Vision logic ported to iOS. `HandheldKit` is macOS-only today; the port is scoped in B's plan.
- **Live outline:** `GenerateIterativeSegmentationRequest` with `.fast` (iOS 27) [A15]. Its speed on iPhone is **[measure]**.
- **Only objects resting on a surface can lock live.** Anything else is outlined from convergence only (Muse S15).

### 4.6 Reconstruction and the gates B adds

**Depth stays out of samples until proven (Muse S5).**
- ARKit `sceneDepth` is registered to `capturedImage` at video resolution. Its registration to a 4K frame or high-resolution still is unproven.
- **The gate:** reproject depth edges onto image edges on a printed checkerboard, with error ≤ 1 depth pixel **[measure]**.
- Until it passes, `depthDataMap` is not set, and B's similarity fit **corrects** scale. That uses `linux-reconstruct`'s gates plus LiDAR extents within 1.5%, falling back to the `capture-measurement` question.

**Upload contract (Muse S1, S2).** B needs:
- a manifest `source: "sweep"`;
- depth sidecars, either encoded as `NNNN.depth.plist` bplists to reuse the `capture-depth` route (`http.ts`: name `^[0-9]{4}\.depth\.plist$`, bytes start `bplist00`), or a new route;
- `capture-camera.json` v1 with HEIC images. **Both validators read only JPEG and PNG** (`schemas.py:68-91`, `capture-camera.ts:13-34`), so they need an ISO-BMFF `ispe` reader, or B sends JPEG.
- The earlier "unchanged" was wrong.

**TSDF fallback, demoted (Argon S4).**
- iPhone LiDAR emits about 576 physical points, 15–20 mm apart at 40 cm, so fused depth can't meet ±1 mm.
- It is used only to report "rough shape from LiDAR, fine detail missing" when photogrammetry fails outright.
- It **never** patches holes the masks prove are real, such as the counters of A and D.

---

## 5. The sides nobody filmed: bottom and back

| Option | Verdict |
|---|---|
| **Bottom = the surface it stands on** (default) | A cap fitted to the mesh's lowest boundary (§3.7). Right for anything that stands stably, and that face goes on the bed. |
| **"Add the bottom"** (optional, about 10 s): turn it over, one more short loop. Apple: "Standing the object on different sides… captures the entire object" [S6]. | Stage 3. Offered only when under 60% of the hull's footprint touches the surface **[inference]**. Never required. |
| **The back** | Covered by the two loops. A gap shows on the ring, and the project says "Back not seen". Never guessed. |
| **Spatial scenes** (`ImagePresentationComponent.Spatial3DImage`) | **visionOS 26 only** [A20]. The iOS Photos feature has no developer API [S7]. It is view synthesis from the visible side, with no back. **No.** |
| **visionOS 27 object scan → Gaussian splat** (WWDC26 287) | visionOS 27. No iOS/macOS availability or API is named [S8], and splats aren't printable meshes. **No**; recheck if it reaches macOS. |
| **ARKit reference objects, iOS 27** (`trackingObjects`) [A22], [S9] | Tracking, not reconstruction. **No.** |
| **Depth Pro** (Apple research) | One image → metric depth of visible surfaces [S10]. Code and weights are under Apple's sample-code-style licence, which **likely fails `tools/licence-audit`** for shipping (Muse S16). **Research only**: a later Mac-side experiment for LiDAR holes on dark surfaces, never in the product unless the audit passes. |
| **SHARP** (Apple research) | Weights are research-only (`LICENSE_MODEL`) [S5], and it doesn't see the back. **No.** |

These were considered, as David asked, and nothing in the design relies on them.

---

## 6. What the person sees and hears (Option A)

PRD §10 governs:
- Liquid Glass controls on the near-black camera stage.
- **Haptics:** only "success when a result is ready and the app is open, and a warning on a plate alert". We add none, and `shouldPlayHaptics = false` turns Apple's off.
- **Motion:** "Reduce Motion is honoured".

| Moment | Screen | VoiceOver / non-visual |
|---|---|---|
| Open | New → **Scan it**. Apple's camera view, no reticle. First use only, one line: "Go round it twice: low, then high." | The line is read. Record is labelled "Record scan". |
| Record | Two thin rings in the overlay (low and high), 36 sectors each, and a small chip: "Recording". | "Recording. Go round it, low first." |
| Loops | Sectors fill as shots land. An empty sector pulses, or shows a static outline under Reduce Motion. | Each quarter of each ring is announced ("Low ring, half done"). Gaps are announced once per loop. |
| Hints | At most one at a time, three words at most, only while true: "Too fast" (Apple's `movingTooFast`), "Keep it in view" (`outOfFieldOfView`), "Now go higher" (low ring full). Never "move slowly" (PRD §11). | Announced. |
| Done | Both rings full → `finish()`. Apple's `ObjectCapturePointCloudView` shows the captured point cloud to turn [A23b]. **Use scan** is prominent. Dimensions arrive later from the Mac's `.bounds`. | "Scan finished. Sending to your Mac." |
| After | Back to New with the scan attached; the project reads "Your Mac is building it". | — |

- **The rig is not a mode:** it uses the same screen. Clamp low for the low ring, then high for the high ring; the ring shows which one is missing.
- **No longer asked:** the PRD §11.1 question "Using the scan rig?", and Area vs Object.

---

## 7. Every layout (AGENTS.md "Every layout"; Muse S6)

| Layout | Capture | Result notes ("Bottom closed from the surface", "Size checked", gaps) | Test |
|---|---|---|---|
| iPhone (compact) | Yes | Yes | `LayoutParityUITests` (iPhone) |
| iPad, regular width | **In scope** on LiDAR iPads (iPad Pro): the same capture screen in landscape and portrait. LiDAR-less iPads (David's iPad Air) keep PRD §5.2's disabled "Needs an iPhone or iPad with LiDAR". | Yes | `LayoutParityUITests` (iPad) |
| iPhone Duo | No LiDAR: disabled tile (already in PRD §6) | Yes | — |
| Mac | No camera scan (existing §6.1 exception) | Yes | `ObjectsModelTests` |
| Linux | No camera scan (existing §6.1 exception) | Yes | `domain.test.ts` |
| Android | Its ARCore scan stays as is. Adopting the freeform-style finding needs either an ARCore port or a §6.1 exception in David's words. **Open decision for David**; not invented here. | Yes | `HomeLayoutTests` |

The PRD §6.1 row is added in the Stage 2 PR, which lands the user-facing change.

---

## 8. Pass criteria (DAD sign)

Ground truth: calipers on the day. Width, height and depth, plus feature dimensions: a letter's height or stroke, and the width of the A or D counter.

**Existing (PRD §11, §11.1):**
1. Every image has nonzero ISO and depth. *A can't promise PRD §11's "1/250 s or faster"; see G4.*
2. No foreign geometry: table, rig platform, backdrop or hand.
3. Every axis is within **±1.0 mm or ±1.5% of the calipers, whichever is larger**, and the feature dimension within ±1.0 mm.
4. The underside is closed, with no hole larger than 5 mm, **except real through-holes**: the A and D counters stay open.
5. Two scans agree within 1%. Three rig scans agree within 0.5% on every axis.

**New (proposed; need David's OK):**

6. **Time:** each capture at most 60 s (two loops); Done → model on the Mac at most 4 min.
7. **No box, no mode:** zero questions with the sign alone, and at most one tap with a second object beside it. *The tap is Stage 2, so Stage 1a can't pass this item; it records the runner-up instead.*
8. **Scale check:** |s − 1| ≤ 1% and hull extents within 1.5% (§3.7).
9. **No light nag during capture.**
10. **Through-holes preserved:** the A and D counters are open in the mesh.

Stage 1a is judged on items 1–6 and 8–10. Item 7 waits for Stage 2.

---

## 9. Phone and Mac gates beyond geometry (Muse S13)

- **Thermal:** `ProcessInfo.thermalState` stays at or below `.fair` through capture and upload **[measure]**.
- **Memory:** no jetsam during capture with over-capture on. Peak memory is logged and judged against today's walk-around **[measure]**.
- **Battery:** at most 3% per scan, capture plus upload **[estimate; measure]**.
- **Privacy strings:**
  - `NSCameraUsageDescription` and `NSLocalNetworkUsageDescription` exist (`Info.plist:61-63`).
  - CoreMotion device motion (`CMMotionManager`) should need no usage string **[inference]**: `NSMotionUsageDescription` is for motion-activity and fitness data. Confirm on the first TestFlight build.
  - No location.
- **Mac:**
  - Peak reconstruction memory and wall time go in the receipt.
  - Reconstruction is the user's work, not a gate. The operations.md rule "Printing beats gating" governs builds and gates only.

---

## 10. Reuse or replace

| Piece | With A (recommended) |
|---|---|
| `apps/mobile/modules/object-capture` (`ObjectCaptureSession`) | **Kept, simplified:** freeform only, our overlay, haptics off, no on-device rebuild. |
| `sendCapture` (24 photos + `.reduced` USDZ) | **Replaced** by every image plus a manifest (§3.4). |
| `HandheldDepthRecorder.swift` / `HandheldCapture.swift` | Unchanged (in-hand Labs). B would reuse the write path and lifecycle rules. |
| `ObjectMasker.swift` | Seeding rewritten for fixed objects (§3.6); helpers kept. Mac only. |
| `mac-reconstruct` | Folder mode (A1) exists. Add an `object-capture` mode (A2/A3): `contentsOf:` samples with gravity kept, masks, the `.poses` check, trim and a receipt. Built on `fix/mac-reconstruction`. |
| `turntable-synth`, `tools/mac-reconstruct/scripts/handheld-gate.sh` | Extend with a synthetic two-height orbit round a fixed model with through-holes, plus a backdrop that moves with the arm (§12, Stage 1b). |
| `linux-reconstruct` | Unchanged for A, since Apple HEICs need Apple's rebuild. Its `scale.py` gates are reused for the check. |
| `scan-repair` | Add "cut at plane, cap closed loops only". |
| Labs switch | **There is none**; there is only `HandheldCapture.offered = false` (`HandheldCapture.swift:47`). Stage 1a uses a launch argument, as `-STMHandheldPreview` does. A user-visible Labs switch, if wanted, is a Stage 2 item on every layout. |

---

## 11. Risks and unknowns

| Risk | Effect | Mitigation |
|---|---|---|
| Apple's 1/60 s frames blur the letter edges | Feature dimension misses | Gate G1; Apple's `movingTooFast` pause; manual shots only when the gyro is quiet; B if G1 fails |
| Apple pauses on the rig (backdrop moves with the arm) | Few or no rig images | Gate G2; a fixed backdrop; B for the rig |
| `PhotogrammetrySession` ignores `camera` on `contentsOf:` samples | A2 has no pose advantage over B | Measure the A1 vs A2 `.poses`; A1 is the fallback |
| Apple's automatic masking (A1) fills the A and D counters or keeps the platform | Wrong geometry | A2 masks; criterion 10 |
| CoreMotion yaw drifts | Sectors fill in the wrong place | 10° sectors; 60 s cap; drift check against Apple's `.poses` on the Mac |
| The sequential, ephemeral uploader stalls or is backgrounded | The upload restarts | It resumes by skipping files already sent; a background session in Stage 3 |
| The Vision model downloads on first use (`ObjectMasker.needsDownload`) | The first rebuild stalls | Download at Mac install time |

**Not documented:**
- whether `PhotogrammetrySession` uses `PhotogrammetrySample.camera` from `init(contentsOf:)` samples (the fields are get-only and "populated… from ObjectCaptureSession" HEICs [A12c]);
- `PhotogrammetrySession.Pose` semantics: direction, and units relative to the model file [A13];
- the frame of `PhotogrammetrySample.gravity` [A12];
- whether ARKit's 4K format delivers `sceneDepth` (B).

**To measure on device:**
- Apple's freeform shot rate, image size and HEIC size on iPhone 17 Pro;
- whether Apple's session pauses on the rig;
- for B: the still rate, exposure behaviour inside ARKit, and the depth registration gate.

**iOS/macOS 27 additions to Object Capture: none found.**
- I listed the members of `PhotogrammetrySession`, `PhotogrammetrySample`, `PhotogrammetrySession.Configuration`, `ObjectCaptureSession`, `ARFrame`, `ARConfiguration` and `ARWorldTrackingConfiguration` from Apple's documentation JSON.
- The 26/27 ones are:
  - `PhotogrammetrySample.orientation` (26, get-only);
  - `ARFrame.metadataObjects` (27);
  - `ARFrame.displayTransform(viewRotationAngle:viewportSize:)` (27);
  - `ARWorldTrackingConfiguration.trackingObjects` (27);
  - `PhotogrammetrySession.Pose.intrinsics` (26) [A13].
- Apple's RealityKit updates page renders client-side and wasn't read.

---

## 12. Staged plan

**Stage 0: none needed.** Stage 1a *is* the measurement of Apple's freeform capture.

**Stage 1a: Option A, judged on the DAD sign.** It sits behind a launch argument, because there is no Labs switch (§10).
- **Phone:**
  - Freeform only: `startCapturing()` from `.ready`, `hideObjectReticle(true)`.
  - No Area/Object switch; no orbit, flip or onboarding states.
  - `shouldPlayHaptics = false`; light feedback hidden; no on-device rebuild.
  - The CoreMotion two-band ring, quiet-gyro `requestImageCapture()` and auto `finish()`.
  - VoiceOver announcements.
  - Send every image as `capture` `NNNN.heic` with manifest `source: "object-capture"`.
- **Companion:**
  - Parse and bind `source` in `parseCaptureManifest` and `captureDigest`.
  - Route `object-capture` to the new mode.
  - Keep the helper's stdout and stderr.
- **Mac (on top of `fix/mac-reconstruction`):**
  - Modes A1, A2 and A3, with gravity kept for Object Capture images.
  - Automatic `.high`.
  - The `.poses` scale check.
  - The trim, the boundary-fitted bottom cap and the receipt (exposure, sharpness, tracking, timings).
- **Tests:** companion manifest tests, and the capture → start → rebuild path with a stored DAD capture.
- **Acceptance:** David scans the DAD sign twice by hand and three times on the rig. §8 items 1–6 and 8–10 must hold, and gates G1–G4 are recorded.
- **Decision:**
  - A passes → Stage 2.
  - G1, G2 or G4 fails → build B for that case (B1–B3 below).

**Stage 1b: object finding and the gate.**
- Convergence, highest surface, 2D-first silhouettes with the lime chroma key, hull height, backdrop rejection.
- A synthetic gate in `turntable-synth`:
  - a two-height orbit round a fixed reference model with through-holes;
  - a lime backdrop, including one that moves with the arm;
  - a second, distractor object.
- It passes when mask IoU ≥ 0.9, every axis is within ±1 mm, the through-holes stay open and the bottom is capped.

**Stage 2: the experience, on every layout.**
- The ring and hints in Liquid Glass, with Reduce Motion and VoiceOver.
- The "Which one?" Ask card (PRD §5.4).
- New shows one **Scan it**; rig mode and the Walk/In hand/Rig switch go.
- The iPad regular-width capture layout.
- The PRD §6.1 row and parity tests (§7).
- A user-visible Labs switch only if David wants one.

**Stage 3: faster.**
- Upload during capture, with a background session if the uploader moves to one.
- The optional "Add the bottom".

**If B is needed:**
- **B1:** the ARKit recorder (4K frames, exposure, the blur formula); the upload contract (depth bplists or a route, HEIC validators); the Mac `sweep` mode with the depth registration gate.
- **B2:** the rig drift check and the orbit-pose fallback.
- **B3:** the iOS port of the live outline.

**Stage 4:** remove the Object-mode code and `sendCapture`'s 24-photo path, after ten accepted scans across at least three objects.

---

## 13. PRD changes when built (not before)

- **§5.2 New:** one **Scan it** tile. The rig card stays as advice ("Best quality: a scan rig" + the Kass 3D link).
- **§5.3 Capture:** freeform, two loops. Remove the Walk / In hand / Rig switch.
- **§11.1:**
  - remove "asks once ('Using the scan rig?')";
  - two clamp heights;
  - G4's outcome-based sharpness, if David agrees;
  - the new §8 items, if David agrees.
- **§6.1:** the row from §7.
- **§0:** the Scanning status line.

---

## 14. Sources

Apple APIs. Availability was read from `https://developer.apple.com/tutorials/data/documentation/<path>.json` on 2026-11-08; the human-readable URL is cited.

| # | API | Availability | URL |
|---|---|---|---|
| A1 | `ARFrame.sceneDepth`, `smoothedSceneDepth`, `FrameSemantics.sceneDepth`, `supportsFrameSemantics(_:)` | iOS 14.0 | https://developer.apple.com/documentation/arkit/arframe/scenedepth · https://developer.apple.com/documentation/arkit/arconfiguration/supportsframesemantics(_:) |
| A2 | `ARDepthData.confidenceMap` ("highly reflective, or that have high light absorption") | iOS 14.0 | https://developer.apple.com/documentation/arkit/ardepthdata/confidencemap |
| A3b | `ARFrame.exifData` | iOS 16.0 | https://developer.apple.com/documentation/arkit/arframe/exifdata |
| A5 | `ARWorldTrackingConfiguration.planeDetection` | iOS 11.0 | https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration/planedetection-swift.property |
| A6 | `ARConfiguration.worldAlignment` | iOS 11.0 | https://developer.apple.com/documentation/arkit/arconfiguration/worldalignment-swift.property |
| A7 | `ARSession.captureHighResolutionFrame(completion:)` ("may fail if a previous request… hasn't completed yet") | iOS 16.0 | https://developer.apple.com/documentation/arkit/arsession/capturehighresolutionframe(completion:) |
| A7b | `ARConfiguration.recommendedVideoFormatFor4KResolution` | iOS 16.0 | https://developer.apple.com/documentation/arkit/arconfiguration/recommendedvideoformatfor4kresolution |
| A8 | `ARConfiguration.configurableCaptureDeviceForPrimaryCamera` | iOS 16.0 | https://developer.apple.com/documentation/arkit/arconfiguration/configurablecapturedeviceforprimarycamera |
| A9 | `AVCaptureDevice.setExposureModeCustom(lensAperture:duration:iso:completionHandler:)`, `Format.supportsExposureModeCustom(lensAperture:duration:iso:)`, `AVCaptureDevice.autoISO`, `autoLensAperture`; `currentExposureDuration` | **iOS 27.0** (`currentExposureDuration`: iOS 8.0) | https://developer.apple.com/documentation/avfoundation/avcapturedevice/setexposuremodecustom(lensaperture:duration:iso:completionhandler:) · https://developer.apple.com/documentation/avfoundation/avcapturedevice/format/supportsexposuremodecustom(lensaperture:duration:iso:) · https://developer.apple.com/documentation/avfoundation/avcapturedevice/autoiso · https://developer.apple.com/documentation/avfoundation/avcapturedevice/autolensaperture |
| A10 | `AVCaptureDevice.activeMaxExposureDuration` | iOS 12.0 | https://developer.apple.com/documentation/avfoundation/avcapturedevice/activemaxexposureduration |
| A11 | `PhotogrammetrySession.init(input:configuration:)` with a sequence of samples | iOS 17.0, macOS 12.0 | https://developer.apple.com/documentation/realitykit/photogrammetrysession/init(input:configuration:)-7glmh |
| A11b | `PhotogrammetrySession.init(input:configuration:)` with a folder URL | iOS 17.0, macOS 12.0 | https://developer.apple.com/documentation/realitykit/photogrammetrysession/init(input:configuration:) |
| A12 | `PhotogrammetrySample`: settable `image`, `depthDataMap`, `objectMask`, `gravity`, `metadata` | iOS 17.0, macOS 12.0 | https://developer.apple.com/documentation/realitykit/photogrammetrysample |
| A12c | `PhotogrammetrySample.init(contentsOf:)` and the **get-only** `camera` (`PhotogrammetrySample.Camera`: `transform`, `intrinsics`, `calibrationData`), `boundingBox`, `depthConfidenceMap`, `captureTime`, `sessionID`, `scanPassID`; `orientation` (get-only) | iOS 18.0, macOS 15.0 (`orientation`: 26.0) | https://developer.apple.com/documentation/realitykit/photogrammetrysample/init(contentsof:) · https://developer.apple.com/documentation/realitykit/photogrammetrysample/camera-swift.property · https://developer.apple.com/documentation/realitykit/photogrammetrysample/camera-swift.struct/transform · https://developer.apple.com/documentation/realitykit/photogrammetrysample/depthconfidencemap · https://developer.apple.com/documentation/realitykit/photogrammetrysample/sessionid · https://developer.apple.com/documentation/realitykit/photogrammetrysample/orientation |
| A13 | `PhotogrammetrySession.Request.poses`, `.bounds`, `.modelFile`; `Poses.posesBySample`; `Pose` ("A 6DOF pose relative to the estimated coordinate system"); `Pose.intrinsics` | poses macOS 14.0; bounds, modelFile macOS 12.0; intrinsics macOS 26.0 | https://developer.apple.com/documentation/realitykit/photogrammetrysession/request/poses · https://developer.apple.com/documentation/realitykit/photogrammetrysession/pose · https://developer.apple.com/documentation/realitykit/photogrammetrysession/pose/intrinsics |
| A14 | `PhotogrammetrySession.Configuration`: `sampleOrdering`, `isObjectMaskingEnabled`, `featureSensitivity` | macOS 12.0 | https://developer.apple.com/documentation/realitykit/photogrammetrysession/configuration-swift.struct · https://developer.apple.com/documentation/realitykit/photogrammetrysession/configuration-swift.struct/isobjectmaskingenabled |
| A15 | Vision `GenerateIterativeSegmentationRequest` (`init(seedPoint:)`, `init(seedBox:)`, `addIncludedPoint(_:)`, `qualityLevel` `.fast`/`.balanced`/`.accurate`) | **iOS/macOS 27.0** | https://developer.apple.com/documentation/vision/generateiterativesegmentationrequest |
| A17 | Subject lifting in apps (WWDC23) | — | https://developer.apple.com/videos/play/wwdc2023/10176/ |
| A18 | `ObjectCaptureSession.Feedback.environmentLowLight` ("Auto-capture still proceeds") | iOS 17.0 | https://developer.apple.com/documentation/realitykit/objectcapturesession/feedback-swift.enum/environmentlowlight |
| A18b | `ObjectCaptureSession.Feedback.movingTooFast` ("capturing may be paused to ensure quality"), `outOfFieldOfView` | iOS 17.0 | https://developer.apple.com/documentation/realitykit/objectcapturesession/feedback-swift.enum/movingtoofast |
| A19 | `ObjectCaptureSession.startCapturing()` ("freeform scanning where the user skips the bounding box selection… from `.ready` directly into `.capturing`"), `startDetecting()`, `finish()`, `start(imagesDirectory:configuration:)` | iOS 17.0 | https://developer.apple.com/documentation/realitykit/objectcapturesession/startcapturing() · https://developer.apple.com/documentation/realitykit/objectcapturesession/startdetecting() · https://developer.apple.com/documentation/realitykit/objectcapturesession |
| A19b | `ObjectCaptureSession.cameraTracking` ("loss of ARKit tracking will cause many of the Object Capture algorithms to pause") | iOS 17.0 | https://developer.apple.com/documentation/realitykit/objectcapturesession/cameratracking |
| A19c | `ObjectCaptureSession.isAutoCaptureEnabled`, `shouldPlayHaptics` (iOS 18.0); `requestImageCapture()`, `canRequestImageCapture`, `numberOfShotsTakenUpdates`, `maximumNumberOfInputImages`; `Configuration.isOverCaptureEnabled`, `checkpointDirectory` (iOS 17.0) | iOS 17.0 / 18.0 | https://developer.apple.com/documentation/realitykit/objectcapturesession/isautocaptureenabled · https://developer.apple.com/documentation/realitykit/objectcapturesession/shouldplayhaptics · https://developer.apple.com/documentation/realitykit/objectcapturesession/requestimagecapture() · https://developer.apple.com/documentation/realitykit/objectcapturesession/configuration-swift.struct/isovercaptureenabled |
| A20 | `ImagePresentationComponent.Spatial3DImage` | **visionOS 26.0 only** | https://developer.apple.com/documentation/realitykit/imagepresentationcomponent/spatial3dimage |
| A21 | `CMMotionManager.startDeviceMotionUpdates(using:to:withHandler:)`; `CMDeviceMotion.rotationRate`, `gravity` | iOS 5.0 / 4.0 | https://developer.apple.com/documentation/coremotion/cmmotionmanager · https://developer.apple.com/documentation/coremotion/cmdevicemotion/gravity |
| A22 | `ARWorldTrackingConfiguration.trackingObjects` | iOS 27.0 | https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration/trackingobjects |
| A23 | `ObjectCaptureView(session:cameraFeedOverlay:)` (iOS 17.0); `hideObjectReticle(_:)` (iOS 18.0) | iOS 17.0 / 18.0 | https://developer.apple.com/documentation/realitykit/objectcaptureview/init(session:camerafeedoverlay:) · https://developer.apple.com/documentation/realitykit/objectcaptureview/hideobjectreticle(_:) |
| A23b | `ObjectCapturePointCloudView(session:)` | iOS 17.0 | https://developer.apple.com/documentation/realitykit/objectcapturepointcloudview |

Other sources:
- [S1] WWDC23 "Meet Object Capture for iOS": https://developer.apple.com/videos/play/wwdc2023/10191/
- [S2] WWDC24 "Discover area mode for Object Capture": https://developer.apple.com/videos/play/wwdc2024/10107/
- [S4] WWDC22 "Discover ARKit 6": access to the capture device for "exposure or white balance"; 12 MP high-resolution frames on iPhone 13; 4K at 3840×2160 and 30 fps. https://developer.apple.com/videos/play/wwdc2022/10126/
- [S5] SHARP (Apple, ICLR 2026): https://arxiv.org/abs/2512.10685 · https://github.com/apple/ml-sharp (`LICENSE_MODEL`: research use)
- [S6] "Capturing photographs for RealityKit Object Capture": https://developer.apple.com/documentation/realitykit/capturing-photographs-for-realitykit-object-capture
- [S7] Apple Developer Forums, "Spatial Scene API for iOS Apps": https://developer.apple.com/forums/thread/787237
- [S8] WWDC26 "Build next-generation experiences with visionOS 27": https://developer.apple.com/videos/play/wwdc2026/287/
- [S9] WWDC26 "Explore enhancements to visionOS object tracking": https://developer.apple.com/videos/play/wwdc2026/283/
- [S10] Depth Pro: https://github.com/apple/ml-depth-pro ("The model weights are released under the LICENSE terms")

Repository sources:
- `apps/mobile/modules/object-capture/GuidedCaptureSample/GuidedCaptureSample/`:
  - `AppDataModel.swift:143,418-421,450-452,678-696`
  - `Views/BottomOverlayButtons.swift:110-121`
  - `FeedbackMessages.swift`
  - `CaptureFolderManager.swift:122-123`
- `apps/mobile/ios/ScanToMake/Platform/MacConnection.swift:206-220`
- `packages/CounterpartKit/Sources/CounterpartKit/Companion/Uploads.swift:27-80`, `Transport.swift:75`
- `services/companion/src/objects/service.ts:135-158`, `http.ts` (`capture`, `capture-depth`, `start`)
- `services/companion/src/objects/capture-camera.ts:13-34`, `tools/linux-reconstruct/schemas.py:68-91`, `scale.py:23,193-196`
- `tools/mac-reconstruct/Package.swift`, `Sources/HandheldKit/{ObjectMasker,Samples}.swift`
- `apps/mobile/ios/ScanToMake/Objects/HandheldCapture.swift:47`, `Info.plist:61-63`
- PRD §5.2, §5.3, §5.4, §6.1, §10, §11, §11.1
- [capture audit, Nov 2](../../../status/capture-reconstruction-audit-2026-11-02.md)
- [inhand-capture.md](inhand-capture.md)
