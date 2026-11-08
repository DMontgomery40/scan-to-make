# Quick sweep: one pass around the object, no box, no mode

Date: 2026-11-08. **Design only; nothing here is built.** It replaces the walk-around and rig capture once Stage 2 (§12) is accepted on David's iPhone. In-hand capture ([inhand-capture.md](inhand-capture.md), PRD §11) is a different problem (the object moves) and stays in Labs.

David, Nov 8, after his first real scan:

> "you shouldn't have to spin it around for 8 fucking minutes. apple can take one partly blurry picture and erase an object or pull it out instantly… one quick video around with that thing, should be instant good to go combined with the other stuff"

> "the box around the thing it forces you to make is damn near impossible to use, users shouldn't have to do that. i also had to switch area and object mode a bunch of times… no user will know which one to do. it should USE SAM and common sense to figure out which object is obviously important"

> "look at the spatial vision function that it uses for apple vision pro too, don't rely on it, but think about it for sure. don't get too sidetracked with that."

How to read the markers:
- **[A#]** is an Apple API or document, listed with its URL and availability in §14. Each availability was read from Apple's documentation JSON on Nov 8.
- **[inference]** is my reasoning, not something Apple documents.
- **[measure]** must be measured on David's iPhone before anything depends on it.
- **[estimate]** is a planning number to be replaced by a measurement.

---

## 0. The design in one screen

- **One capture.** The object stays still and the phone moves round it, by hand or on the rig. The capture is the same either way, so there is nothing to choose. There is no box, no Area/Object switch, no segments and no flip.
- **The person's whole job.** Point at the object, press Record, walk once round it (20–30 s; the cap is 60 s). The ring fills, recording stops by itself, and a grey model with its dimensions is on screen at once. The Mac's finished model replaces it about 2–4 minutes later.
- **The phone runs ARKit world tracking, not Apple's guided Object Capture session.** Every frame then comes with LiDAR depth, a metric camera pose and the table plane [A1–A6]. With those, the phone:
  - finds the object: whatever rests on the surface, in the middle, nearest;
  - measures coverage from where the phone has been, not from guesses;
  - takes sharp stills at 1/250 s or faster [A7–A10];
  - lets the Mac check the scale three independent ways.
- **The object outline comes from Vision's promptable segmentation**, `GenerateIterativeSegmentationRequest` (iOS/macOS 27; Apple's SAM-like model) [A15]. It is prompted with the object's 3D box projected into each photo, so it never has to guess. Promptable segmentation is the same kind of model as the subject-lifting one David was describing [A17].
- **The Mac rebuilds from every keyframe** with `PhotogrammetrySession`, using custom samples: image, LiDAR depth, object mask and gravity [A11–A14]. It then aligns Apple's estimated camera poses to ARKit's [A13]. That one alignment does three things:
  - proves the scale;
  - stands the model upright;
  - trims anything outside the object's box, and closes the bottom with the table plane.
- **The bottom is the table.** For something that stands on a surface, the face it stands on is flat, and it is the face that goes on the print bed. An optional 10-second "Add the bottom" pass handles objects whose base isn't flat. It is offered, never required.
- **Single-image 3D (spatial scenes, Depth Pro, SHARP) is not in the pipeline.** Spatial scenes are visionOS-only [A20], SHARP's weights are research-only [S5], and none of them can see a back or bottom. Depth Pro is kept as an optional Mac-side patch for LiDAR holes (§8).

---

## 1. What went wrong on Nov 8, and what replaces it

| What David hit | Cause (code or Apple docs) | In this design |
|---|---|---|
| 8 minutes of scanning | Apple's object mode guides three segments with flips between them (WWDC23 10191 [S1]; our `GuidedCaptureSample` follows it). | One sweep. Recording stops when the coverage dome is full (§4.3). The bottom comes from the table (§8). |
| The box was "damn near impossible" | `startDetecting()` "returns `false`… if no horizontal plane is detected along the ray originating at the center of the screen" [A19], and then the person has to drag the box. | There is no box. The phone builds it from the LiDAR points resting on the surface (§5). |
| Switching between Area and Object mode | Two Apple modes, and the person has to choose (WWDC24 10107 [S2]). | One capture. On the rig and by hand it is the same thing (§6.2). |
| "More Light Recommended" all the time in a well-lit room | `ObjectCaptureSession.Feedback.environmentLowLight`: "Auto-capture still proceeds but reconstruction quality may suffer" [A18]. The session picks its own exposure (59 shots at 1/60 s). | We set the shutter and let ISO rise (§4.2). Light advice appears at most once, after capture, and only if the frames really were too dark to be sharp. |
| The Mac rebuilt nothing | `MacConnection.sendCapture` sends `ProjectUploader.spread(names, count: 24)` plus the phone's `.reduced` USDZ (`apps/mobile/ios/ScanToMake/Platform/MacConnection.swift:206-220`). | Every keyframe goes, with its depth, pose and gravity, plus the object box (§4.4). The open fix/mac-reconstruction PR is the stopgap for the current scanner. |

---

## 2. Decisions

1. **Object still, phone moves.** This holds by hand and on the Kass 3D rig (PRD §11.1), so it is one capture with one screen. If the object itself turns in a hand, that is in-hand capture: Labs, unchanged.
2. **ARKit owns the camera.** I compared the three options:
   - **`ObjectCaptureSession`** hides its exposure, its cadence and its object detection. Its documented flow is box, then segments.
   - **AVFoundation** with `builtInLiDARDepthCamera` (what `HandheldDepthRecorder` uses) has full exposure control and 768×576 depth, but **no camera pose**. Without a pose the phone can't find the object in 3D, can't measure coverage around it, and can't check scale.
   - **ARKit world tracking** gives a metric pose, intrinsics, LiDAR depth with confidence, and planes on every frame [A1–A6]. It also gives full-resolution stills that carry the same pose and depth [A7], and it exposes the camera device for exposure control [A8].

   **Cost:** ARKit's depth map is smaller (256×192 on shipping LiDAR iPhones; Apple's pages don't state a size, so read it at runtime **[measure]**). That is plenty for scale, masks and coverage. Detail comes from the photos.
3. **One button.** Record starts the capture and coverage stops it. There is no onboarding carousel and no Start page.
4. **The Mac rebuilds from every keyframe.** It uses `PhotogrammetrySession` with our masks. LiDAR and the ARKit poses are its check (scale, up direction, trim, bottom plane), and its fallback when photogrammetry fails (§7.4).
5. **The table is the bottom.** A bottom pass is optional (§8).
6. **Single-image models are not used in v1.** At most they are an optional Mac-side hint after Stage 3 (§8).

---

## 3. Pipeline

```
iPhone · about 30 s                                         Mac · about 2–4 min
────────────────────────────────────────                    ───────────────────────────────────────────
ARKit world tracking (gravity-aligned, Y up)
 ├ capturedImage (preview, sharpness)       [A3]
 ├ sceneDepth + confidenceMap               [A1, A2]
 ├ camera transform, intrinsics, tracking   [A4]
 ├ horizontal planes                        [A5]
 └ exposure ≤ 1/250 s via the configurable
   capture device; white balance locked     [A8–A10]
CoreMotion: rotationRate, gravity at 100 Hz [A21]
            │
FIND THE OBJECT (first ~1 s; no box, no mode)
LiDAR points − support plane → 3D clusters
score: centre of view × near × resting on the plane × size
            │ clear winner → lock      │ near tie → "Tap the one to scan" (one tap)
            ▼
OBJECT BOX (world, gravity-aligned)  ──project──▶ live outline
            │                                     (Vision promptable segmentation, .fast) [A15]
SWEEP (Record): the coverage dome fills from poses
keyframe = new view ≥ 6° · predicted blur ≤ 1 px · object ≥ 15% of frame
            │ captureHighResolutionFrame (pose, depth attached) [A7]
            │ Stage 1 also keeps the sharpest 60 Hz frame per bin, for an A/B test
            ▼
KEYFRAME: NNNN.heic + NNNN.depth (Float32 + confidence)
          + one line of capture-sweep.json (pose, intrinsics, gravity, exposure, blur)
          + capture-camera.json v1 (the Android/Linux format: centres, intrinsics, objectAnchor)
            │
            ├──▶ at Done: instant preview = the object's accumulated LiDAR points, with dimensions [S3]
            │
            └──upload (Stage 1: at Done · Stage 3: during the sweep)──▶ MASKS: ObjectMasker, fixed-object mode
                                                                        box prompt from pose + box,
                                                                        depth band, plane cut [A15]
                                                                              ▼
                                                                        PhotogrammetrySession(custom samples)
                                                                        image · depthDataMap · objectMask ·
                                                                        gravity · EXIF focal length [A11–A13]
                                                                        requests: .poses, .bounds, .modelFile(.full)
                                                                              ▼
                                                                        ALIGN: similarity fit of ARKit camera centres
                                                                        ↔ .poses translations [A13]
                                                                        → scale check · up axis · box trim · plane
                                                                              ▼
                                                        ┌─ pass ──▶ close the bottom at the plane (scan-repair)
                                                        │           → touch-up → printer MCP (unchanged)
                                                        └─ fail ──▶ LiDAR depth fusion (TSDF) gives the shape,
                                                                    and the project says so (§7.4)
```

---

## 4. Capture on the iPhone

### 4.1 Session

- `ARWorldTrackingConfiguration` with:
  - `frameSemantics = [.sceneDepth, .smoothedSceneDepth]`, after checking `supportsFrameSemantics` [A1];
  - `planeDetection = [.horizontal]` [A5];
  - `worldAlignment = .gravity` (the default), so world Y is up [A6];
  - `videoFormat = recommendedVideoFormatForHighResolutionFrameCapturing` [A7]. Apple: "For the highest resolution captured image, choose a non-binned `videoFormat`".
- `sceneDepth` goes into the saved keyframe. `smoothedSceneDepth` is used only for the live display: it averages across frames, which can lag while the phone moves **[inference]**.
- CoreMotion device motion at 100 Hz [A21]:
  - `rotationRate` predicts blur;
  - `gravity` (in the device's frame) is written into each sample;
  - yaw keeps the ring filling if visual tracking drops on the rig (§6.2).
- Lifecycle rules carried over from `HandheldCapture.swift`:
  - the camera is released the moment the app leaves the foreground (the KAN-217 P0 lesson);
  - the diagnostic launch arguments stay;
  - a connected Continuity display blacks out the camera ([camera incident](../../../status/camera-incident-2026-11-02.md)).

### 4.2 Exposure: sharp frames come from the shutter

- **What we can control.** `ARConfiguration.configurableCaptureDeviceForPrimaryCamera` (iOS 16) returns the `AVCaptureDevice` behind ARKit's feed. Apple calls it a way to "alter the appearance of a frame's captured image", with a warning that extreme changes can hurt ARKit features [A8]. WWDC22 names "exposure or white balance" as examples ([S4]).
- **Order of preference:**
  1. **Shutter priority (iOS 27).** `setExposureModeCustom(lensAperture: .auto, duration: 1/250 s, iso: .auto)` [A9]. First check `activeFormat.supportsExposureModeCustom(lensAperture: autoLensAperture, duration: currentExposureDuration, iso: autoISO)`; that is Apple's own example for "shutter priority" [A9].
  2. **Otherwise,** keep continuous auto-exposure and cap it: `activeMaxExposureDuration = 1/250 s` (iOS 12; it must lie between the format's min and max exposure) [A10].
  3. After the first second, lock white balance at the gains it has settled on [A10b]. Apple asks for consistent camera settings across shots ([S6]).
- **Never** write `activeVideoMin/MaxFrameDuration` or depth frame durations. On the LiDAR camera that left every app's camera black until a reboot (`HandheldDepthRecorder.swift`, KAN-217 P0 comment). Exposure is a different control. Stage 1 still tries it first under the diagnostic harness and reads back the values it set **[measure]**.
- **Check every keyframe.** Read `ARFrame.exifData` (iOS 16: "exposure… and the date and time") [A3b]. Drop any keyframe slower than 1/200 s. For still capture, the AVFoundation docs warn: "full duration may be used during still capture" when ISO is on auto [A9]. Whether ARKit's high-resolution still obeys our cap is unknown **[measure]**.
- **The light budget, honestly [inference: arithmetic]:**
  - 1/250 s needs about 4× the ISO of 1/60 s (two stops). The Nov 8 room gave 1/60 s.
  - The Nov 1 in-hand room metered 1/40 s at ISO 1000, so 1/250 s there needs about ISO 6,250.
  - Where that passes the format's maximum ISO, allow up to 1/125 s and lean harder on the blur gate (§4.3).
  - Photogrammetry tolerates noise far better than blur (the same judgement as inhand-capture.md §3).
- **What the person sees about light:** nothing during capture. If after Done more than 20% of bins had no frame sharp enough, one line appears: "More light would make it sharper". **Use scan** stays available.
- **Why blur matters even on a smooth orbit [inference: arithmetic].**
  - When the phone circles the object and keeps it centred, the object's own image barely moves; the background moves.
  - Hand tremor doesn't cancel. At about 10°/s of shake, a 1/60 s exposure smears 0.17°. At 12 MP (f ≈ 3,000 px) that is about 9 px. At 1/250 s it is about 2 px, and below 1 px if we fire when the gyro is quiet.

### 4.3 Coverage and keyframes

- **The coverage dome.** Bins are measured around the object's centre: 36 azimuth bins (10°) × 3 elevation bands (0–25°, 25–50°, 50–75°) plus a top cap above 75°. View direction is the vector from the object centre to the camera centre.
- **Auto-finish.** These are starting numbers, tuned on the DAD sign **[measure]**:
  - one band has at least 34 of 36 bins;
  - another band has at least 12 bins;
  - the top has been seen from above 50° in at least 4 azimuth bins;
  - or 60 s have passed, and then whatever is missing shows as gaps.

  A single rising loop meets this: start low, finish high, one continuous motion.
- **Keyframe rule.** A frame becomes a keyframe when all of these hold:
  1. Its view direction is at least 6° from every keyframe already taken, or its distance to the object changed by 15% or more.
  2. **Predicted object blur is ≤ 1 px at the saved resolution.** That is the exposure time × the image speed of the projected box corners, from the ARKit pose velocity plus the gyro's `rotationRate` **[inference]**.
  3. Tracking is normal [A4].
  4. The projected box covers at least 15% of the frame, with every corner inside a 3% margin. Apple: the object should fill "as much of the camera's frame as possible without excluding or cutting off any part" ([S6]).
  5. **It is sharp.** The variance of the Laplacian of luma inside the projected box, at 480 px, is at least 0.6 × the running median for its bin.
- **Count:** 360° / 6° = 60 per loop, so a typical rising loop gives **80–120 keyframes**. At 6° steps on an object filling 15% or more of the frame, neighbours overlap far more than Apple's 70% ("Anything less than 50%… may fail") ([S6]) **[inference: geometry]**.
- **Stills vs video frames.**
  - A keyframe fires `captureHighResolutionFrame`, which returns an `ARFrame` with a "high resolution `capturedImage`" plus "pose information, anchors, and frame semantics". One request can be in flight at a time [A7].
  - That was 12 MP on iPhone 13 ([S4]); the size on iPhone 17 Pro and the sustained rate are unknown **[measure]**. At 3 or more stills/s, stills are the keyframes.
  - **Stage 1 also keeps the sharpest 60 Hz frame of each bin** (1920×1440 on recent LiDAR iPhones **[measure]** via `imageResolution` [A4]). The Mac can then rebuild both sets and we can choose with numbers.
- **Saved per keyframe:**
  - **Image:** HEIC at quality 0.9, in sensor orientation, EXIF orientation 1. `PhotogrammetrySample.orientation` (iOS/macOS 26) exists if we ever need to rotate [A12b].
  - **`NNNN.depth`:** `sceneDepth.depthMap` (Float32 metres) plus `confidenceMap` (UInt8) [A1, A2], each with its own header (width, height, format).
  - **One JSON line in `capture-sweep.json`:**
    - timestamp, image size;
    - intrinsics scaled to the saved image;
    - camera→world rotation (quaternion) and centre;
    - tracking state;
    - exposure and ISO from `exifData`;
    - CoreMotion gravity;
    - predicted blur and measured sharpness;
    - whether it is a `still` or a `video` frame.

### 4.4 What goes to the Mac, and how fast

- **Sidecars, so all three rebuilders can read the same capture:**
  - **`capture-camera.json` v1.** This is the file the Android app already writes and `linux-reconstruct` already reads, including the Umeyama camera-centre scale fit: image, sha256, size, fx/fy/cx/cy, timestampMs, tracking, centre in metres in a Y-up gravity-aligned world, plus `objectAnchor` (`tools/linux-reconstruct/schemas.py`). ARKit's world is also Y-up and gravity-aligned [A6], so the iPhone can write the same file unchanged. The anchor's `source` is `depth-centroid`, or `user-tap` after a tap.
  - **`capture-sweep.json` v1 (new).** Version 1's schema refuses unknown keys, so the extra fields live here instead: per-frame rotation, the depth file, gravity, exposure, blur and sharpness; plus `supportPlane {point, normal}`, `objectBox {center, halfExtents, yaw}` and the coverage summary.
- **Stage 1:** everything uploads at Done through the existing uploader (`ProjectUploader`, background `URLSession`), started with `captureManifest {"kind":"sweep"}`, just as `sendHandheld` does now.
- **Stage 3:** keyframes stream to the Mac during the sweep, and the Mac masks them as they arrive.

**Phone time budget**

| Step | Target |
|---|---|
| Camera open → object outlined | ≤ 1.5 s |
| Sweep | 20–30 s typical, 60 s cap |
| Optional bottom pass | ~10 s |
| Done → local preview with dimensions | ≤ 1 s |
| Upload after Done | ≤ 15 s in Stage 1, ≤ 3 s in Stage 3 |

**Data per capture [estimate; measure in Stage 1]**

| Item | Per keyframe | 100 keyframes |
|---|---|---|
| 12 MP HEIC still | ~2–4 MB | 200–400 MB |
| 1920×1440 HEIC video frame (Stage 1 A/B) | ~0.5–0.8 MB | 50–80 MB |
| Depth 256×192 Float32 + confidence UInt8 | 245,760 B raw | ~25 MB (~12 MB compressed) |
| JSON line | < 1 KB | < 0.1 MB |
| **Total** | | **~280–520 MB** (Stage 1, both sets) |

- Over home Wi-Fi to the Mac at 25–50 MB/s **[estimate]**, that is 6–20 s. Without the video set, ~230–430 MB.
- The phone keeps the existing 1 GB recording cap (`HandheldDepthRecorder.Configuration.maximumBytes`).

---

## 5. Finding the object: "SAM and common sense", with no box

The phone does what the box asked the person to do, from the same signals Apple's session uses (the plane and the centre of view) [A19], plus LiDAR clusters.

### 5.1 Locking on (first ~1 s, before Record)

1. **Unproject.** Turn depth pixels with confidence of medium or better into world points, as Apple's sample *Displaying a point cloud using scene depth* does ([S3]). Accumulate them in a 5 mm voxel hash.
2. **Support plane.** Take the horizontal plane anchor under the centre ray [A5], or else fit the largest horizontal plane below the centre point. On the rig, this is the platform.
3. **Cut.** Drop voxels within 4 mm of the plane and anything more than 1.2 m from the camera.
4. **Cluster** the rest into 3D connected components.
5. **Score** each cluster. These are starting weights **[inference; tune on device]**:

   score = exp(−θ² / 2·(12°)²) × exp(−d / 0.6 m) × rests × size

   - θ is the angle between the centre ray and the cluster's centroid; d is its distance from the camera.
   - `rests` = 1 if its lowest point is within 1 cm of the plane, else 0.3.
   - `size` = 1 between 1 cm and 60 cm, 0.2 beyond. Walls, the table edge and furniture are large and touch the frame edges.
6. **Lock** when the best score is at least 2× the second-best and stays the winner for 10 consecutive frames.
7. **Refine in 2D.**
   - Project the cluster's 3D box into the frame. Run `GenerateIterativeSegmentationRequest(seedBox:)` with `qualityLevel = .fast`, then `addIncludedPoint` at the projected centroid [A15].
   - Keep only the voxels whose projections fall inside the mask. That separates an object from something touching it.
   - Over the next frames, the box tightens to the object.
8. **Object box.** Gravity-aligned: its vertical axis is the plane normal, its footprint is oriented by PCA of the points, and it runs from the plane to the highest point, plus 1 cm. During the sweep it is fixed in the world and can only grow, with hysteresis, when new points connected to the object appear (for example, a back that is larger than the front).

### 5.2 When the app asks the person anything

- **Clear winner (the common case):** no question. The outline and a dimensions capsule ("18.2 × 6.0 × 9.5 cm") show what it understood. That is also an instant sanity check on scale.
- **Near tie** (best < 2× second, such as a mug beside the sign): both outlines glow faintly and the glass capsule says **"Tap the one to scan"**. One tap picks the cluster under the finger. That is the only question in the whole flow.
- **Nothing found** (no cluster on a surface near the centre within 3 s): no outline, and the capsule says "Point at it". Nothing is asked.
- **Never asked:** the box, the mode, the segment, "is this a rig?". The PRD §11.1 question "Using the scan rig?" goes away, because the capture is the same (§6.2).

### 5.3 Masks: live on the phone, final on the Mac

- **Phone (live).** One promptable request at `.fast` on a downscaled preview, 2–4 times a second, drawn as the outline glow [A15]. Promptable segmentation is iOS 27, so the phone has it too. Its speed on iPhone is **[measure]**; if it is too slow, the outline falls back to the projected LiDAR cluster.
- **Mac (final).** `ObjectMasker` gains a fixed-object mode for sweeps:
  - the seed box is the object box projected through the frame's pose and intrinsics;
  - the depth band is the box's own near/far range in that frame, not "nearest surface + 0.2 m";
  - pixels whose depth unprojects to within 3 mm of the support plane, or below it, are cut;
  - the promptable request runs at `.accurate`;
  - the hand logic runs only when hand pose finds a hand inside the box.

  This replaces `ObjectMasker`'s 2D guesswork (the centre prior, "continuing the last photo") with 3D consistency across every frame. It is the fix for the defect PRD §11 names ("erases the object when a hand is nearer than it").

---

## 6. Guidance: what the person sees in those 30 seconds

Liquid Glass on iOS 27 ([apple-design-2026.md](apple-design-2026.md)): a full-bleed camera, glass controls, one short line at a time, no text walls.

### 6.1 Storyboard

| Time | Screen | Feel |
|---|---|---|
| 0 s | New → **Scan it**. The camera opens full screen. On first use only, one line: "Point at it, then go once around it." | — |
| ~1 s | The object's outline glows in. A glass capsule shows its live size ("18.2 × 6.0 × 9.5 cm"). | It understood me. |
| Record | A big glass Record button, like the Camera app's video. Two thin rings appear **on the table around the object's base** (AR, anchored to the plane), low and high, made of 36 ticks each. Top right, a small chip: "1/250 s · LiDAR". | Familiar: it's a video. |
| Sweep | Each tick lights as its bin gets a keyframe. A light haptic tick every 30°. The object's own point cloud fills in on screen as you go. If you stall, the nearest empty tick pulses; there is no text. | Watching it fill is the instruction. |
| Hints | At most one at a time, three words or fewer, only while true: "Closer" (object under 15% of frame), "Hold it higher" (low ring full, high ring empty), "Keep it in view" (tracking lost for more than 2 s). Never "move slowly" (PRD §11). | Rare. |
| Done | Rings full → success haptic, recording stops by itself (or press Record again). A sheet shows the grey preview spinning, with dimensions, and **Use scan** (prominent). **Add the bottom** appears only when §8 says the base may not be flat. | Instant. |
| After | Back to New with the scan attached. The project shows "Your Mac is building it · about 2 min". | — |

### 6.2 The rig is not a mode

- On the Kass 3D rig the phone is clamped to the arm and swings round a still object. That is the same capture, the same screen and the same rings; the person swings the arm instead of walking. Clamp height picks the ring (the PRD §11.1 rings: "clamp low and level; clamp high and tilted down"), and the display shows which ring is incomplete.
- **If ARKit tracking degrades** (for example, a backdrop that moves with the arm fills the view, PRD §11.1):
  - the rings keep filling from CoreMotion yaw about gravity [A21];
  - keyframes still save on the sharpness and blur rules;
  - those frames are marked `tracking: limited`, and the Mac relies on photogrammetry's own poses for them.
- The PRD's rig criteria still apply (§9).

### 6.3 Every layout (AGENTS.md "Every layout")

- **Capture:** iPhone and LiDAR iPads (iPad Pro). Devices without LiDAR, including David's iPad Air and iPhone Duo, keep the PRD §5.2 rule: the tile is visible but disabled, "Needs an iPhone or iPad with LiDAR".
- **Results:** the scan's notes show on every layout's project page: "Bottom closed from the table", "Size checked three ways", and any gaps. That covers Mac, iPad, Android and Linux.
- **PRD §6.1:** the Mac and Linux "no scan" exceptions already exist. Android's ARCore scan already writes `capture-camera.json`, so it can adopt the same object finding later; that is out of scope here.

---

## 7. Mac reconstruction

### 7.1 Samples

`PhotogrammetrySession(input:configuration:)` with a lazy sequence of `PhotogrammetrySample` (iOS 17 / macOS 12) [A11]:

| Field | Value | Apple |
|---|---|---|
| `image` | BGRA from the HEIC | "kCVPixelFormatType_32BGRA or kCVPixelFormatType_32ARGB" [A12] |
| `depthDataMap` | ARKit `sceneDepth` as `kCVPixelFormatType_DepthFloat32`, low-confidence pixels set to 0 **[inference]** | "can help PhotogrammetrySession determine the real-world scale"; DepthFloat32 or DisparityFloat32 [A12] |
| `objectMask` | fixed-object mask (§5.3), OneComponent8, same size as the image | "same height and width as image"; 0 = ignored [A12] |
| `gravity` | CoreMotion `gravity` at the frame time (device frame, in g) | "the orientation of the camera… improve landmark matching" [A12]. The coordinate convention isn't documented **[measure: A/B with and without]**. |
| `metadata` | EXIF Make/Model, `FocalLength`, `FocalLengthIn35mmFilm` computed from ARKit intrinsics | RealityKit "can use" these keys [A12] |

- **There is no field for camera pose or intrinsics in.** `PhotogrammetrySample` has no such property [A12], so ARKit poses can't be handed to RealityKit. They are used around it instead (§7.3).
- `PhotogrammetrySession.Pose.intrinsics` (macOS 26) reports RealityKit's own estimate back out [A13]. We log it next to ARKit's.

### 7.2 Configuration and requests

- **Configuration:**
  - `sampleOrdering = .sequential`: the sweep is in walking order [A14];
  - `isObjectMaskingEnabled = true`: with masks supplied, "RealityKit uses the provided masks" [A14];
  - `featureSensitivity = .normal` first. Retry with `.high` ("an accurate 3D object even when landmarks are difficult to discern") only if more than 25% of samples are skipped or the model fails [A14].
- **One `process(requests:)` call** with `.poses`, `.bounds` and `.modelFile(url:detail: .full)` [A13]:
  - `.poses` arrives "once initial photogrammetric calculations are complete", so the scale check runs before meshing ends;
  - `.bounds` gives the size early for the project page.

### 7.3 Alignment: one fit, three checks

- **The fit.** Robust similarity fit (Umeyama with a trimmed refit; the same gates `linux-reconstruct` already uses) between ARKit camera centres and the `.poses` translations [A13]. The result is a scale *s*, rotation *R* and translation *t* from model space to ARKit's world.
- **Scale.** RealityKit's depth-informed model scale should match ARKit's metric path: |s − 1| ≤ 1%. LiDAR box extents give a third reading. If two of the three agree, that wins; if they disagree beyond 1.5%, the project says "Size couldn't be confirmed" and offers the existing measure answer (`capture-measurement`).
- **Up and trim.**
  - *R* stands the model upright: gravity-down becomes −Z on the bed, so the bottom faces down for printing.
  - Geometry outside the object box (+1 cm) is cut: stray table or rig pieces, and any background the masks let through.
- **Bottom.** The support plane goes into model space. `scan-repair` gets an explicit-plane cap operation: cut at plane + 0.3 mm and close it with a planar face.

### 7.4 Fallback: LiDAR depth fusion

- **When it runs:** photogrammetry fails, skips more than 40% of samples, or leaves a hole bigger than 5 mm inside the box. Low texture is the typical cause, such as the DAD sign's matte black letters (the case the brief names). Apple: single-colour, smooth objects "may not provide enough data" ([S6]).
- **What it does:** a TSDF over the object box at 2 mm voxels, fusing keyframe depth weighted by confidence. It uses the photogrammetry poses where those exist (fitted to metric via §7.3) and ARKit poses elsewhere. Marching cubes then gives the mesh.
- **What to expect:** shape good to about ±2–3 mm **[estimate]**. That is enough for overall shape, scale and closing holes; it is not enough for engraved detail.
- **How it's used:** the TSDF mesh fills holes in the photogrammetry mesh. If photogrammetry failed entirely, it is the model, and the project says "Rough shape from LiDAR — fine detail missing", so nobody mistakes it for a full scan.
- **Build note.** Apple has no TSDF API (ARKit's `sceneReconstruction` mesh is room-scale [A5b]), so this is ours: Swift and Metal on the Mac, about 500 lines. Reinventing it is justified because nothing Apple ships covers object-scale depth fusion.
- **Low LiDAR confidence on black.** Apple notes "less confident… for surfaces that are highly reflective, or that have high light absorption" [A2]. §8 covers the optional Depth Pro patch for that.

### 7.5 Mac time budget

| Step | Time | Basis |
|---|---|---|
| Masks, 100 frames, `.accurate`, one promptable request each | 20–50 s; 0 s after Done in Stage 3 (streamed) | **[estimate; measure]** |
| `.poses` (scale check) | first ~30–50% of the run | **[estimate]** |
| `.full` model, ~100–120 12 MP images | 60–90 s | Measured Nov 2 on the Mac: 117 HEIC → 74.3 s, 120 HEIC → 63.4 s ([audit](../../../status/capture-reconstruction-audit-2026-11-02.md)) |
| Align, trim, cap, checks | ≤ 10 s | **[estimate]** |
| TSDF fallback (when it runs) | ≤ 15 s | **[estimate]** |
| **Done → model on the Mac** | **≤ 4 min (Stage 1), ≤ 2 min (Stage 3)** | |

After that, touch-up, slicing and printing go through the existing companion and printer MCPs, unchanged (AGENTS.md: the app staples onto the MCPs).

---

## 8. The sides nobody filmed: bottom and back

| Option | What it is | Where it runs | Verdict |
|---|---|---|---|
| **Table plane cap** (default) | The face the object stands on is flat and on the plane | Ours (§7.3) | **Yes.** Right for anything that stands stably, and that face goes on the bed anyway. |
| **"Add the bottom"** (optional, about 10 s) | Turn the object over and do a short second sweep. Photogrammetry joins the two: Apple says "Standing the object on different sides… captures the entire object" ([S6]) | Ours | **Offered, never required.** Shown only when the base may not be flat: under 60% of the object's footprint touches the plane, as seen by LiDAR **[inference]**. |
| **The back** | Covered by the one loop. If the sweep stops short (object against a wall), the ring shows the gap and the project says "Back not seen" | — | Never guessed. |
| **Spatial scenes** (`ImagePresentationComponent.Spatial3DImage`) | A 3D scene generated from one 2D photo | **visionOS 26 only** [A20]. The iOS Photos feature has no developer API ([S7]). | **No.** It isn't on iOS or macOS, and it synthesizes nearby viewpoints from the visible surface; it doesn't make a closed back. |
| **visionOS 27 object scan to Gaussian splat** (WWDC26 287) | "Scan real-world objects and bring them straight into your virtual experiences" | visionOS 27; no iOS or macOS availability and no API named in the session ([S8]) | **No.** Splats aren't printable meshes. Recheck if it reaches macOS. |
| **ARKit reference objects on iOS 27** (WWDC26 283) | Tracking a known object; reference objects trained in Create ML on a Mac from a USDZ ([S9]); `ARWorldTrackingConfiguration.trackingObjects` (iOS 27) [A22] | iOS 27 | **Not reconstruction.** A later idea: re-find a scanned object to add views. |
| **Depth Pro** (Apple research) | One image → metric depth, about 0.3 s on a GPU ([S10]) | PyTorch on the Mac (MPS). Apple's licence covers the code and the weights ([S10]); a community Core ML conversion exists | **Maybe, Stage 3+, Mac only.** Fill LiDAR pixels of low confidence (matte black, absorbing) after fitting Depth Pro's scale and shift to the confident LiDAR pixels in the same frame. It sees only visible surfaces, never the bottom. Run `tools/licence-audit` before shipping it. |
| **SHARP** (Apple research) | One image → metric 3D Gaussians for nearby views ([S5]) | PyTorch | **No.** The weights are under a research-only licence (`LICENSE_MODEL`: "for the sole purpose of scientific research"), and it doesn't see the back. |

As David asked, these were considered without being relied on. The table and the one loop cover the sides; nothing in the pipeline depends on a single-image model.

---

## 9. Accuracy targets and pass criteria (DAD sign)

Ground truth: caliper measurements of the DAD sign taken the day of the test. Width, height and depth, plus one feature: a letter's height or stroke width.

From PRD §11 and §11.1, unchanged:
1. Every keyframe has a shutter of **1/250 s or faster**, nonzero ISO, and depth.
2. No foreign geometry (table, rig platform, hand). The bounding box exceeds the truth by no more than the tolerance below.
3. Every bounding-box axis is within **±1.0 mm or ±1.5% of calipers, whichever is larger**. The feature dimension is within ±1.0 mm.
4. **The underside is closed**, with no hole larger than 5 mm.
5. **Repeatability:** two hand sweeps agree within 1% on every axis. Three rig sweeps agree within 0.5%.

New in this design:

6. **Time.** Each sweep is ≤ 60 s, with a median ≤ 30 s. Done → model on the Mac is ≤ 4 min in Stage 1 and ≤ 2 min in Stage 3. Done → local preview is ≤ 1 s.
7. **No box and no mode.** Zero questions with the sign alone on a table. Exactly one tap ("Tap the one to scan") with a second object placed beside it.
8. **Scale:** the §7.3 fit is |s − 1| ≤ 1%, and LiDAR box extents agree within 1.5%.
9. **No light nag during capture.** The light line appears at most once after Done, and only under its rule (§4.2).
10. **Engineering gate, before David's test.** Extend `turntable-synth` to render a synthetic sweep: an orbiting camera with known poses round a fixed reference model on a plane. The gate passes when:
    - fixed-object masks reach IoU ≥ 0.9 against ground truth;
    - scale is within 0.5%;
    - every axis is within ±1 mm;
    - the plane cap closes the bottom.

    This is the same pattern as `tools/mac-reconstruct/scripts/handheld-gate.sh`.

---

## 10. Reuse or replace

| Piece | Verdict |
|---|---|
| `apps/mobile/modules/object-capture` (GuidedCaptureSample, `ObjectCaptureSession`) | **Stage 1:** unchanged; it is the baseline. **Stage 2:** leaves New and moves to Settings → Labs as "Apple guided scan". **Stage 4:** removed once the sweep is accepted. Its 24-photo plus `.reduced` USDZ send path (`sendCapture`) goes with it. |
| `HandheldDepthRecorder.swift` | Not the sweep's camera: ARKit owns the camera, and AVFoundation gives no pose. **Reuse its write path:** atomic commit of an image with its depth and metadata, crash recovery, the storage cap and diagnostics snapshots. It stays as the in-hand Labs recorder. |
| `HandheldCapture.swift` | Reuse its lifecycle rules (camera released on background, KAN-217) and its diagnostic launch arguments. New screen. |
| `ObjectMasker.swift` | **Reuse** with the new fixed-object seeding (§5.3). It is the same Vision request, and it now also runs on the iPhone (iOS 27) at `.fast`. |
| `mac-reconstruct` | New `sweep` subcommand, manifest-driven: masks, gravity, `.poses`, the fit, trim, plane, TSDF fallback. `samples` stays for in-hand. `model-look` and `model-compare` are unchanged and used for §9. |
| `turntable-synth`, `handheld-gate.sh` | Extend to the synthetic sweep gate (§9 item 10). |
| `linux-reconstruct` | Already reads `capture-camera.json` v1 and fits ARCore centres. The iPhone sweep writes the same file, so Linux can scale-check iPhone sweeps with COLMAP. Its "which part is the object" stop (exit 5) can take the capture-time `objectAnchor` instead of asking again. That is a follow-up in that tool, not part of this design. |
| `scan-repair` | Add an explicit-plane cap operation. |
| PRD §11.1 rig mode and "asks once" | **Superseded:** the rig and the hand are the same capture. |

---

## 11. Risks and unknowns

| Risk | Effect | Mitigation |
|---|---|---|
| `captureHighResolutionFrame` is slower than 3/s, or ignores our exposure cap on stills | Fewer or blurrier stills | Stage 1 keeps the best 60 Hz frame per bin and checks `exifData` per keyframe **[measure]** |
| Exposure changes on ARKit's camera degrade tracking, or repeat KAN-217's black camera | No capture | Exposure only, never frame durations; diagnostic harness first; read back the values set; release the camera on background |
| Custom samples carry none of the private pose data that `ObjectCaptureSession`'s HEICs embed [A12, `init(contentsOf:)`: "HEIC images captured with the ObjectCaptureSession will contain more advanced data fields"] | Possibly less robust photogrammetry than Apple's own captures | Gravity, depth, masks and sequential order; A/B against the Stage 0 baseline; TSDF fallback |
| Gravity coordinate convention for `PhotogrammetrySample` isn't documented | Wrong gravity could hurt matching | A/B with and without on the DAD sign; keep whichever passes |
| Promptable segmentation is too slow on the iPhone for a live outline | Outline lags | Fall back to the projected LiDAR cluster outline; the Mac masks are unaffected |
| The Vision model needs a download on first use (`ObjectMasker.needsDownload`) | First scan stalls | Download while on Wi-Fi the first time New opens; same on the Mac at install |
| Matte black or absorbing surfaces: weak LiDAR, few landmarks | Holes | TSDF fill; `.high` sensitivity retry; Depth Pro patch only if Stage 1 data shows it is needed |
| The rig backdrop moves with the arm, so ARKit tracking is limited | Coverage and fit gaps | CoreMotion yaw for the rings; photogrammetry poses; the fit uses tracking frames only (the `linux-reconstruct` gates) |
| Not-flat bottoms (feet, hollow base) | A wrong cap | "Add the bottom" shown by the footprint rule (§8); the cap is reported, never silent |
| Reflective or transparent objects | Fails like every photogrammetry | Apple's guidance ([S6]): say so after the fact, and suggest a matte spray |
| The Mac is busy printing or gating | Slower model | Reconstruction is the user's own work, not a gate; it runs at normal priority (operations.md) |

**Where I'm not sure an API or behaviour exists or works this way on iOS/macOS 27:**
- The resolution of ARKit's high-resolution frame on iPhone 17 Pro, and how fast calls can repeat [A7]. WWDC22 says 12 MP on iPhone 13 ([S4]).
- Whether shutter priority, `setExposureModeCustom(lensAperture:duration:iso:)` (iOS 27), is supported on ARKit's active format; check with `supportsExposureModeCustom` [A9]. `activeMaxExposureDuration` (iOS 12) is the documented fallback [A10].
- ARKit `sceneDepth` size. 256×192 is commonly reported, but no Apple page I read states it.
- `PhotogrammetrySample.gravity`'s coordinate frame, and whether RealityKit reads intrinsics from EXIF focal length for custom samples. The `metadata` page lists the keys it "can use" [A12].
- Depth smaller than the image is fine for `depthDataMap`. The docs don't say, but 768×576 depth with 4032×3024 images loaded correctly on Nov 1 (inhand-capture.md §1b).
- **iOS/macOS 27 additions to Object Capture: none found.**
  - Apple's RealityKit updates page renders client-side, so I couldn't read it.
  - Instead I listed every member of `PhotogrammetrySession`, `PhotogrammetrySample`, `PhotogrammetrySession.Configuration`, `ObjectCaptureSession`, `ARFrame`, `ARConfiguration` and `ARWorldTrackingConfiguration` from Apple's documentation JSON, and kept those introduced in 26 or 27. The only ones are `PhotogrammetrySample.orientation` (26), `ARFrame.metadataObjects` (27), `ARFrame.displayTransform(viewRotationAngle:viewportSize:)` (27) and `ARWorldTrackingConfiguration.trackingObjects` (27).
  - Separately, `PhotogrammetrySession.Pose.intrinsics` is 26 [A13].
  - Nothing replaces the box or adds a no-box object mode.

---

## 12. Staged build plan

Each stage ends with something David can see, and the first slice proves the idea on the DAD sign before any polish.

**Stage 0: baseline (optional; no code; one 60-second scan).**
- With the open fix/mac-reconstruction PR on the Mac, David scans the DAD sign once with today's walk-around in **Area** mode (no box) for at most 60 s. The Mac rebuilds from every image with `ObjectMasker` masks.
- Record the time, the dimensions against calipers, and the six-sided renders (`model-look --all-views`). This is the number the sweep has to beat.

**Stage 1: the smallest slice that proves it on the DAD sign (Labs, behind the existing Labs switch).**
- **iPhone, `SweepCapture` (new):**
  - ARKit session (§4.1) and exposure cap (§4.2);
  - automatic object lock (§5.1). On a near tie it picks the best candidate and shows its outline; the tap comes in Stage 2;
  - keyframes: stills plus the best video frame per bin (§4.3);
  - a plain 2D ring at the bottom of the screen;
  - auto-stop;
  - saving with the `HandheldDepthRecorder` write path, and upload at Done with both sidecars (§4.4).
- **Mac:** `mac-reconstruct sweep` (§7.1–7.3) with the fixed-object `ObjectMasker`; the A/B of stills vs video frames and of gravity on vs off; a receipt with the scale fit.
- **scan-repair:** the plane cap.
- **Companion:** route `kind: sweep` to `mac-reconstruct sweep` and keep stdout and stderr (as `reconstruct.ts` does now).
- **Gate:** the synthetic sweep gate (§9 item 10) passes in `ci_local`.
- **Acceptance:** David sweeps the DAD sign twice by hand and three times on the rig, and §9 items 1–8 hold.
- **Measure:** still size and rate, exposure read-back, `sceneDepth` size, phone mask speed, upload time, Mac times. Update this document's [measure] and [estimate] values from those numbers.

**Stage 2: the experience, on every layout.**
- AR rings on the table, the live outline glow, "Tap the one to scan", the instant point-cloud preview with dimensions, haptics, the three-word hints, and the one-line light advice after Done.
- New shows one **Scan it** tile (plus In hand in Labs). Rig mode and the Walk/In hand/Rig switch are gone.
- `ObjectCaptureSession` moves to Labs.
- Project-page notes on every layout (§6.3); `LayoutParityUITests`, Mac `ObjectsModelTests`, Android `HomeLayoutTests` and Linux `domain.test.ts` updated; the PRD §6.1 row updated.
- **Acceptance:** David's first real-object scans from New in the installed app.

**Stage 3: faster and sturdier.**
- Keyframes stream to the Mac during the sweep, masks are made on arrival, and Done → model ≤ 2 min.
- The TSDF fallback (§7.4) and the optional **Add the bottom** pass (§8).
- A Depth Pro spike only if Stage 1 data shows LiDAR holes on dark surfaces.

**Stage 4: clean-up.**
- After ten accepted sweeps across at least three objects, delete the GuidedCaptureSample module and `sendCapture` (archive tag per PRD §18).
- In-hand stays Labs until its own criteria pass.

---

## 13. PRD changes when this is built (not before)

- **§5.2 New.** "Show it" becomes: **Scan it** (one tile; the rig card stays as advice, "Best quality: a scan rig" with the Kass 3D link), Take photos, From Photos, and In hand in Labs.
- **§5.3 Capture.** Replace the walk-around, rig and mode-switch bullets with the sweep (§6). Remove "Walk / In hand / Rig".
- **§11.1.** The rig is the same capture. Remove "asks once ('Using the scan rig?')" and add §9's time and no-question criteria.
- **§6.1.** Add the scan-notes row for every layout.
- **§0.** Status line for Scanning.

---

## 14. Sources

Apple APIs. Availability was read from `https://developer.apple.com/tutorials/data/documentation/<path>.json` on 2026-11-08; the human-readable URL is cited.

| # | API | Availability | URL |
|---|---|---|---|
| A1 | `ARFrame.sceneDepth`, `smoothedSceneDepth`, `FrameSemantics.sceneDepth`, `supportsFrameSemantics(_:)` | iOS/iPadOS 14.0 | https://developer.apple.com/documentation/arkit/arframe/scenedepth · https://developer.apple.com/documentation/arkit/arframe/smoothedscenedepth · https://developer.apple.com/documentation/arkit/arconfiguration/framesemantics-swift.struct/scenedepth · https://developer.apple.com/documentation/arkit/arconfiguration/supportsframesemantics(_:) |
| A2 | `ARDepthData.depthMap`, `confidenceMap` ("highly reflective, or that have high light absorption") | iOS/iPadOS 14.0 | https://developer.apple.com/documentation/arkit/ardepthdata/confidencemap |
| A3 | `ARFrame.capturedImage` (full-range YCbCr) | iOS 11.0 | https://developer.apple.com/documentation/arkit/arframe/capturedimage |
| A3b | `ARFrame.exifData` | iOS/iPadOS 16.0 | https://developer.apple.com/documentation/arkit/arframe/exifdata |
| A4 | `ARCamera.transform`, `intrinsics`, `imageResolution`, `trackingState` | iOS/iPadOS 11.0 | https://developer.apple.com/documentation/arkit/arcamera/transform · https://developer.apple.com/documentation/arkit/arcamera/intrinsics · https://developer.apple.com/documentation/arkit/arcamera/imageresolution · https://developer.apple.com/documentation/arkit/arcamera |
| A5 | `ARWorldTrackingConfiguration.planeDetection` | iOS/iPadOS 11.0 | https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration/planedetection-swift.property |
| A5b | `ARWorldTrackingConfiguration.sceneReconstruction` (environment mesh) | iOS 13.4 | https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration/scenereconstruction |
| A6 | `ARConfiguration.worldAlignment` | iOS/iPadOS 11.0 | https://developer.apple.com/documentation/arkit/arconfiguration/worldalignment-swift.property |
| A7 | `ARSession.captureHighResolutionFrame(completion:)`; `recommendedVideoFormatForHighResolutionFrameCapturing` | iOS/iPadOS 16.0 | https://developer.apple.com/documentation/arkit/arsession/capturehighresolutionframe(completion:) · https://developer.apple.com/documentation/arkit/arconfiguration/recommendedvideoformatforhighresolutionframecapturing |
| A8 | `ARConfiguration.configurableCaptureDeviceForPrimaryCamera` ("nil on devices that aren't equipped with an ultra-wide camera") | iOS/iPadOS 16.0 | https://developer.apple.com/documentation/arkit/arconfiguration/configurablecapturedeviceforprimarycamera |
| A9 | `AVCaptureDevice.setExposureModeCustom(lensAperture:duration:iso:completionHandler:)`; `Format.supportsExposureModeCustom(lensAperture:duration:iso:)` (shutter priority) | iOS/iPadOS **27.0** | https://developer.apple.com/documentation/avfoundation/avcapturedevice/setexposuremodecustom(lensaperture:duration:iso:completionhandler:) · https://developer.apple.com/documentation/avfoundation/avcapturedevice/format/supportsexposuremodecustom(lensaperture:duration:iso:) |
| A10 | `AVCaptureDevice.activeMaxExposureDuration` | iOS/iPadOS 12.0 | https://developer.apple.com/documentation/avfoundation/avcapturedevice/activemaxexposureduration |
| A10b | `AVCaptureDevice.setWhiteBalanceModeLocked(with:completionHandler:)` | iOS/iPadOS 8.0 | https://developer.apple.com/documentation/avfoundation/avcapturedevice/setwhitebalancemodelocked(with:completionhandler:) |
| A11 | `PhotogrammetrySession.init(input:configuration:)` (sequence of samples) | iOS 17.0, macOS 12.0 | https://developer.apple.com/documentation/realitykit/photogrammetrysession/init(input:configuration:)-7glmh |
| A12 | `PhotogrammetrySample`: `image`, `depthDataMap`, `objectMask`, `gravity`, `metadata`; `init(contentsOf:)` | iOS 17.0, macOS 12.0 (`init(contentsOf:)`: iOS 18.0, macOS 15.0) | https://developer.apple.com/documentation/realitykit/photogrammetrysample · …/photogrammetrysample/depthdatamap · …/objectmask · …/gravity · …/metadata · …/init(contentsof:) |
| A12b | `PhotogrammetrySample.orientation` | iOS/macOS 26.0 | https://developer.apple.com/documentation/realitykit/photogrammetrysample/orientation |
| A13 | `PhotogrammetrySession.Request.poses`, `.bounds`, `.pointCloud`, `.modelFile(url:detail:geometry:)`; `Poses.posesBySample`; `Pose.rotation`/`translation`; `Pose.intrinsics` | poses: iOS 17.0 / macOS 14.0; bounds, modelFile: macOS 12.0; pointCloud: macOS 13.0; **intrinsics: iOS/macOS 26.0** | https://developer.apple.com/documentation/realitykit/photogrammetrysession/request/poses · https://developer.apple.com/documentation/realitykit/photogrammetrysession/poses/posesbysample · https://developer.apple.com/documentation/realitykit/photogrammetrysession/pose/intrinsics · https://developer.apple.com/documentation/realitykit/photogrammetrysession/request/bounds |
| A14 | `PhotogrammetrySession.Configuration`: `sampleOrdering` (`.sequential`), `isObjectMaskingEnabled`, `featureSensitivity`, `ignoreBoundingBox` | macOS 12.0 (`ignoreBoundingBox` macOS 15.0) | https://developer.apple.com/documentation/realitykit/photogrammetrysession/configuration-swift.struct · …/isobjectmaskingenabled · …/featuresensitivity-swift.property · …/ignoreboundingbox |
| A15 | Vision `GenerateIterativeSegmentationRequest`: `init(seedBox:)`, `init(seedPoint:)`, `addIncludedPoint(_:)` (limit 11 points with a box, 13 with a point), `qualityLevel` (`.fast`, `.balanced`, `.accurate`), result `PixelBufferObservation?` | iOS/iPadOS/macOS/visionOS **27.0** | https://developer.apple.com/documentation/vision/generateiterativesegmentationrequest |
| A16 | Vision `GenerateForegroundInstanceMaskRequest`, `DetectHumanHandPoseRequest` (used by `ObjectMasker`) | iOS 18.0, macOS 15.0 | https://developer.apple.com/documentation/vision/generateforegroundinstancemaskrequest · https://developer.apple.com/documentation/vision/detecthumanhandposerequest |
| A17 | Subject lifting in apps (the "pull it out instantly" feature) | WWDC23 | https://developer.apple.com/videos/play/wwdc2023/10176/ |
| A18 | `ObjectCaptureSession.Feedback.environmentLowLight` | iOS/iPadOS 17.0 | https://developer.apple.com/documentation/realitykit/objectcapturesession/feedback-swift.enum/environmentlowlight |
| A19 | `ObjectCaptureSession.startDetecting()`, `startCapturing()` (freeform skips the box), `Configuration.isOverCaptureEnabled` | iOS/iPadOS 17.0 | https://developer.apple.com/documentation/realitykit/objectcapturesession/startdetecting() · https://developer.apple.com/documentation/realitykit/objectcapturesession/startcapturing() |
| A20 | `ImagePresentationComponent.Spatial3DImage` (spatial scene from a 2D image) | **visionOS 26.0 only** | https://developer.apple.com/documentation/realitykit/imagepresentationcomponent/spatial3dimage |
| A21 | `CMMotionManager.startDeviceMotionUpdates(using:to:withHandler:)`; `CMDeviceMotion.rotationRate`, `gravity` ("expressed in the device's reference frame") | iOS 5.0 / 4.0 | https://developer.apple.com/documentation/coremotion/cmmotionmanager · https://developer.apple.com/documentation/coremotion/cmdevicemotion/gravity |
| A22 | `ARWorldTrackingConfiguration.trackingObjects` | iOS/iPadOS **27.0** | https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration/trackingobjects |

Other sources:
- [S1] WWDC23 "Meet Object Capture for iOS": https://developer.apple.com/videos/play/wwdc2023/10191/
- [S2] WWDC24 "Discover area mode for Object Capture": https://developer.apple.com/videos/play/wwdc2024/10107/
- [S3] "Displaying a point cloud using scene depth" (Apple sample): https://developer.apple.com/documentation/arkit/displaying-a-point-cloud-using-scene-depth
- [S4] WWDC22 "Discover ARKit 6". Covers 12 MP high-resolution frames on iPhone 13; access to the capture device for "exposure or white balance"; the warning that "strong overexposure might have a negative effect on the output quality of ARKit"; and the 4K mode at 3840×2160, 30 fps. https://developer.apple.com/videos/play/wwdc2022/10126/
- [S5] SHARP, "Sharp Monocular View Synthesis in Less Than a Second" (Apple, ICLR 2026): https://arxiv.org/abs/2512.10685 · code and weights https://github.com/apple/ml-sharp. Weights are under `LICENSE_MODEL`, research use only.
- [S6] "Capturing photographs for RealityKit Object Capture". Covers 70% overlap, "less than 50%… may fail", consistent settings, filling the frame, moving the object between shots, and difficult objects. https://developer.apple.com/documentation/realitykit/capturing-photographs-for-realitykit-object-capture
- [S7] Apple Developer Forums, "Spatial Scene API for iOS Apps" (visionOS-only reply): https://developer.apple.com/forums/thread/787237
- [S8] WWDC26 "Build next-generation experiences with visionOS 27" (Gaussian-splat object scanning): https://developer.apple.com/videos/play/wwdc2026/287/
- [S9] WWDC26 "Explore enhancements to visionOS object tracking" ("this year we're bringing object tracking to iOS"; Create ML on the Mac): https://developer.apple.com/videos/play/wwdc2026/283/
- [S10] Depth Pro: https://github.com/apple/ml-depth-pro. The README says "The model weights are released under the LICENSE terms". Model card: https://huggingface.co/apple/DepthPro-hf

Repository sources:
- `apps/mobile/ios/ScanToMake/Platform/MacConnection.swift:206-220` (`sendCapture`)
- `apps/mobile/ios/ScanToMake/Objects/HandheldDepthRecorder.swift` (KAN-217 frame-duration warning; write path)
- `apps/mobile/ios/ScanToMake/Objects/HandheldCapture.swift`
- `tools/mac-reconstruct/` (`ObjectMasker`, `samples`, `turntable-synth`)
- `tools/linux-reconstruct/` (`capture-camera.json` v1, the camera-centre fit)
- [capture audit, Nov 2](../../../status/capture-reconstruction-audit-2026-11-02.md)
- [inhand-capture.md](inhand-capture.md)
- PRD §5.2, §5.3, §6.1, §11, §11.1
