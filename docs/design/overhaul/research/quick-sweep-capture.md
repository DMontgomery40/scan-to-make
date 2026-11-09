# Quick scan: Apple's Object Capture, used the documented way

Date: 2026-11-08. This is the third revision, written to David's direction. Updated 2026-11-09 with David's two decisions: the shutter rule (§4) and Android (§3.5). **It is a design only; nothing here is built.** It covers the walk-around and the rig. In-hand capture ([inhand-capture.md](inhand-capture.md), PRD §11) stays in Labs.

David, Nov 8:

> "I don't understand why we have to hand roll or add one single thing custom… Why isn't this just use all Apple libraries and features in the correct way?"

> "you shouldn't have to spin it around for 8 fucking minutes… the box around the thing it forces you to make is damn near impossible to use… i also had to switch area and object mode a bunch of times… no user will know which one to do."

**The design.** Capture on the iPhone uses Apple's `ObjectCaptureSession` and its view. Reconstruction on the Mac uses Apple's `PhotogrammetrySession` on the images folder. There is **no custom capture, segmentation, depth fusion or sidecar**. What our code still does is plumbing:
- choosing Apple's start call;
- removing our sample app's mode switch;
- sending every image;
- running Apple's rebuild with three settings.

Everything custom from the earlier revisions is in the **Appendix**. Each item there is tied to the specific measured failure of an Apple-only run that would justify it.

Markers:
- **[A#]** is an Apple source, listed with its URL and availability under Sources. Availability was read from Apple's documentation JSON on Nov 8.
- **[inference]** is reasoning that Apple does not document.
- **[measure]** must be measured on David's iPhone, Mac or rig.
- **New (proposed)** marks a rule that is not in the PRD and needs David's OK.
- **David's decision (Nov 8/9)** marks a rule David has decided. It goes into the PRD with the change that ships it.

---

## 1. What the Nov 8 capture tells us

These are from Argon's geometry review of the Nov 8 capture, and from the code.

| Finding | What it means |
|---|---|
| **Tracking held.** 70–75% of each frame was the stationary room at the edges, even with the backdrop moving with the camera. | Apple's tracking is not the problem. Keep the room visible at the frame edges. |
| **Apple's auto box clipped both D's by about 23 mm.** It fitted the textured script and cut the letters off. | The box is not just hard to use; it removed geometry. Freeform has no box (§2). Images that already carry a box can be rebuilt with `ignoreBoundingBox = true` [A9]. |
| **The matte-black letters gave almost no points.** | Featureless matte black. Neither Apple nor anyone else's photogrammetry can recover what has no texture. It is fixed by light, background and coating, not by code (§5). |
| **"More Light Recommended" was true for the object.** The dark object drove exposure to 1/60 s at ISO up to 2500, in a well-lit room. | Apple's `environmentLowLight` [A6] was right about the object. The fix is more light on the object (§5), not hiding the message. |
| **The lime backdrop is seen through the letter holes and moves with the camera.** | Through the counters of A and D, the background is static relative to the camera and plain. It adds no features and can confuse masking. Use a stationary, textured background instead (§5). |
| **8 minutes** | Our sample runs Apple's object-centric flow: box, then three segments with flips (WWDC23 10191 [S1]). |
| **The Mac rebuilt nothing** | `MacConnection.sendCapture` sends only `ProjectUploader.spread(names, count: 24)` plus the phone's `.reduced` USDZ (`MacConnection.swift:206-220`). The Mac never rebuilt from the images. |

---

## 2. Apple's API facts this design depends on (verified)

1. **Skipping the box is Apple's "freeform" scanning, which WWDC24 calls area mode.**
   - `startCapturing()`: "In freeform scanning where the user skips the bounding box selection, this call moves the session state from `.ready` directly into `.capturing`" [A2].
   - WWDC24: "Simply skip the call to startDetecting and proceed directly to startCapturing… For area mode, there is no new call or configuration to set" [S2].
   - `hideObjectReticle(_:)` hides the selection reticle in `.ready` [A11].
   - **There is no third "object mode without a box" in the API.** What makes our scan object-focused is the **Mac** setting `isObjectMaskingEnabled = true`. Our sample's area mode sets it to `false` (`AppDataModel.swift:450-452`).
2. **Scan passes and the capture dial exist only with the box.**
   - `beginNewScanPass()` and `beginNewScanPassAfterFlip()`: "only valid in object-centric scanning" [A3].
   - `userCompletedScanPass` turns true after "a full circular scan pass around the bounding box" [A3]. Without a box there is no dial event **[inference from that wording]**.
   - So in freeform, "segments" don't exist, and Finish is ours to offer.
3. **Finish any time; pause while something covers the view.**
   - `finish()` works in `.capturing`, then the session goes `.finishing` → `.completed` [A2]. Apple sets no minimum shot count. Our sample uses 10 (`AppDataModel.minNumImages`, line 92).
   - `pause()`: "Call this when object capture view is not visible, such as when a help screen is shown". `resume()`: "Call this method… after pause() is called to show another view temporarily" [A2b].
   - Our sample pauses and resumes by hand around any sheet that covers the view (`AppDataModel.setShowOverlaySheets`, lines 263-275: "the session doesn't pause. We need to pause/resume the session by hand").
   - The sample calls `finish()` from its paused review sheet (`OnboardingButtonView.swift:72`). `isPaused` is a separate property from `state` [A2b], so `state` stays `.capturing` while paused **[inference]**.
4. **Over-capture is for the Mac.** `isOverCaptureEnabled` lets capture continue past `maximumNumberOfInputImages`, "meant for use when the images are intended to be transferred to macOS" [A4]. WWDC23: the extra shots "are stored in the Images folder" [S1].
5. **The checkpoint does not help the Mac.**
   - `PhotogrammetrySession.Configuration.checkpointDirectory`: "For macOS reconstruction… Reconstruction starts from scratch, and does not resume from previous checkpoints. For iOS reconstruction, if you pass the same checkpointDirectory used by an ObjectCaptureSession… [it] tries to use the saved checkpoint" [A8].
   - The capture-side `checkpointDirectory` "may be used to speed up on-device reconstruction" [A5].
   - WWDC23's "provide the same checkpoint directory… to speed up the reconstruction" is about that on-device rebuild [S1].
   - **So the checkpoint stays on the phone** and is not sent. That narrows what the lead asked for, and it is Apple's own statement.
6. **The Mac uses the depth inside Apple's images.** WWDC23: "Mac reconstruction also utilizes the LiDAR data we save in our images" [S1]. The images also carry Apple's per-image camera data [A7].
7. **Masking on the Mac.** With `isObjectMaskingEnabled = true` and no supplied masks, "RealityKit attempts to automatically create a mask… If it's unable… reverts to… the entire image" [A9].
8. **`ignoreBoundingBox`** (macOS 15) "ignores any bounding box information embedded in the input images and instead returns all possible geometry". Apple's note: "to recover the entire scene geometry as well as ignore the box, `isObjectMaskingEnabled` should also be set to false". We want the object, not the scene, so `isObjectMaskingEnabled` stays `true` [A9].
9. **`featureSensitivity = .high`** is "a slower, more sensitive algorithm to detect landmarks", for low contrast or detail [A9].
10. **Exposure is Apple's.**
    - `ObjectCaptureSession.Configuration` has only `checkpointDirectory` and `isOverCaptureEnabled` [A5].
    - The session exposes no camera device, so the app cannot set the shutter. Nov 8: 1/60 s.
    - Apple pauses capture on `movingTooFast` "to ensure quality" [A6].
11. **Haptics:** `shouldPlayHaptics` (iOS 18) turns Apple's haptics off [A4]. PRD §10 allows only "success when a result is ready… and a warning on a plate alert".
12. **Review before finishing:** `ObjectCapturePointCloudView` "allows the user to review the captured 3D model before finishing the capture" [A12].

---

## 3. The design

### 3.1 iPhone: Apple's session, one mode, no box

1. `ObjectCaptureSession()`, then `start(imagesDirectory:configuration:)` [A1], with:
   - `isOverCaptureEnabled = true`, already set at `AppDataModel.swift:419` [A4];
   - `checkpointDirectory` as today [A5].
2. `ObjectCaptureView(session:)` with `hideObjectReticle(true)` [A11].
3. **Record** calls `startCapturing()` from `.ready` [A2]. Never `startDetecting()`. **There is no box at any point.**
4. `shouldPlayHaptics = false` [A4]. `isAutoCaptureEnabled` stays at Apple's default (on) [A4].
5. **One card, one line:** "Go round it twice: low, then high. Keep the room in view." On the rig: "Clamp low, swing round; clamp high, swing again." This follows Apple's guide, "taking photographs from different angles at different heights" [S6], and the reviewers' two-heights finding: one height leaves the camera centres on a flat circle.
6. **Done → pause → review → Use scan or Keep scanning.**
   - Done appears once `numberOfShotsTaken` ≥ 10 [A4]. It stays available after one pass; there are no segments to complete.
   - **Done** calls `pause()` first [A2b]. The review sheet covers the capture view, and Apple says to pause "when object capture view is not visible" (§2.3).
   - The sheet then shows `ObjectCapturePointCloudView(session:)` [A12].
   - **Use scan** (prominent) calls `finish()` [A2], as the sample does from its paused review sheet.
   - **Keep scanning** closes the sheet and calls `resume()` [A2b]. Capture continues into the same `Images` folder, and Done can be pressed again later.
7. **Apple's feedback is shown as Apple sends it**, one line at a time [A6]:
   - `movingTooFast` ("may be paused to ensure quality");
   - `environmentLowLight` / `environmentTooDark`, with the remedy in the words: "More light on the object" (§1: it was true).
   - **Not used:** `outOfFieldOfView`. Apple defines it as "The bounding box of the object is not in the field of view", so in freeform it may never arrive. Stage 1 logs whether it does **[measure]**.
8. **No on-device reconstruction.** The Mac rebuilds at `.full`. WWDC23: "we support only the reduced detail level on iOS" [S1].

**Removed from our UI:** the Area/Object switch (`AppDataModel.captureMode`, `TopOverlayButtons.swift:128-132`), the box step, the orbit and flip onboarding states, and the tutorial video. These were our sample app's choices, not Apple's requirements.

### 3.2 Upload contract (honest)

| Item | Today | Apple-only needs |
|---|---|---|
| Images | 24 spread photos as `photo` kind (`MacConnection.swift:206-220`) | **Every** image in the session's `Images/` folder, as `capture` kind, with the bytes unchanged so Apple's metadata, depth and camera data travel with them. See "Image names" below. |
| Manifest | `{version: 1, images, depthRequired, …}`; unknown keys are dropped (`service.ts:135-158`) | **Exactly:** `{"version": 1, "images": ["0001.heic", …], "depthRequired": false, "source": "object-capture"}`, with `cameraMetadataRequired` and `scaleQualificationRequired` **absent**. See "Why this manifest" below. |
| Checkpoint | Not sent | **Not sent.** The Mac starts from scratch (§2.5) [A8]. If a later measurement shows otherwise, it needs a new folder route, and none exists. |
| Depth | `capture-depth` route for `NNNN.depth.plist` | **None.** It is inside Apple's HEIC. |
| Scan USDZ | Required by `sendCapture` | **Not sent.** No on-device rebuild. |
| Uploader | `ProjectUploader`: sequential, in memory, skips what the Mac has (`Uploads.swift:27-80`), on `URLSessionConfiguration.ephemeral` (`Transport.swift:75`). PRD §5.2 says a background session; the code doesn't use one. | Unchanged. A cut-short send resumes by skipping files already sent. |

**Image names.**
- Apple's session names the files in `Images/`, and Apple doesn't document the pattern.
- **Measured (Nov 8): seconds since the session started**, zero-padded, such as `00032.467183875.HEIC`.
  - The Nov 2 backup on the Mac (`~/scan-to-make-work/davica3-counterpart-backup-20261102-0401/Documents/NativeCaptures/*/Images`) has 157 images in 20 sessions, and every one has this shape. Nothing else is in any `Images` folder.
  - The Nov 8 rig scan's 24 photos on the Mac (`00041.732011084.HEIC` … `00422.451878250.HEIC`) have it too.
  - Our sample's `IMG_` constant (`CaptureFolderManager.swift:122-123`) is never used.
- **Name rule: number in capture order.** The names sort in capture order, so the phone sends the n-th as `NNNN.heic` (`0001.heic`, `0002.heic`…), with the extension lower-cased and the bytes unchanged (`ProjectUploader.captureFrames`).
  - Capture time stays in each HEIC.
  - The result matches `parseCaptureManifest`'s `^[0-9]{4}\.(heic\|jpe?g\|png)$`, which stays as strict as before.
  - Stripping a non-digit prefix would leave `00032.467183875.heic`, which fails that rule.
- **Otherwise the send fails loudly:** a file in `Images/` that isn't a HEIC, JPEG or PNG stops the send. The phone keeps the capture and says "This scan has a file Counterpart can't send (<name>). Scan it again." It never guesses or skips a file.

**Why this manifest.**
- `#start` compares the uploaded depth files against `expectedDepth`, which is one `NNNN.depth.plist` per image when `depthRequired` is true (`service.ts:1211-1213`). `false` keeps start from waiting for depth files Apple never writes; the depth is inside the HEIC.
- `cameraMetadataRequired` would make start wait for a `capture-camera.json` (`service.ts:1214-1215`).
- `scaleQualificationRequired` is Android's "qualify before accepting" flag.
- `source` must be parsed and bound into `captureDigest`. Today an unmarked capture goes to `mac-reconstruct samples`, with our masks and cleared gravity (`reconstruct.ts:116`, `Samples.swift:30`). That is wrong for Apple images.

- **Data [estimate; measure]:** 40–100 images × about 3–5 MB = 120–500 MB.
- **Target:** upload done within 60 s of Done on David's network **[measure]**.

### 3.3 Mac: Apple's rebuild on the folder

`PhotogrammetrySession(input: <Images folder URL>, configuration:)` [A10]:
- `isObjectMaskingEnabled = true` [A9];
- `featureSensitivity = .high` [A9];
- one request: `.modelFile(url:detail: .full)` [A10].

This is the existing folder mode of `mac-reconstruct` (`mac-reconstruct <images-folder> <output.usdz> full`, `main.swift`). It changes from `featureSensitivity = .normal` to `.high`.

**Keep Apple's default (unordered) sample ordering, not `.sequential`.** Measured Nov 8 on copies of the 24 rig-scan photos, with `.high`, Apple's masks and the box kept:
- `.sequential` placed 7, 5 and 7 of 24 photos in three runs. That left a backdrop sheet (3,902 points) or part of the sign (14,844 and 10,824 faces).
- Unordered placed 9 of 24 in four runs, giving 28,672–29,279 faces and a box within 1.3 mm between runs.
- Apple says the ordering "has no impact on the quality", but these frames are spread picks, not adjacent shots.
- Receipts: `~/scan-to-make-work/mac-reconstruction-2026-11-08/`.

- **The companion** runs that mode for `source: "object-capture"`, keeps stdout and stderr (as `reconstruct.ts` already does for `samples`), and hands the USDZ to the existing touch-up and printer MCP path unchanged.
- **Mac time:** about 60–90 s for 100–120 12 MP HEICs at `.full`. Measured Nov 2 on the Mac (117 → 74.3 s; 120 → 63.4 s, [audit](../../../status/capture-reconstruction-audit-2026-11-02.md)). `.high` is slower **[measure]**.
- **Images that carry a box** (Nov 8 and earlier object-mode captures): rebuild with `ignoreBoundingBox = true`, masking still on [A9].
  - **Stage 0 answer (Nov 8, the 24 photos that reached the Mac): both D's come back.**
    - Two runs gave 24,128 and 23,475 points, with 11 of 24 photos placed.
    - The full line "A son's first hero, a daughter's first love." reads.
    - With the box kept, the last "D" is cut off.
  - The costs:
    - Apple's masks keep the green backdrop between the letters;
    - a scrap of the rig's platform stays under the base;
    - the back stays open from 24 frames.

### 3.4 What the person sees (PRD §10)

| Moment | Screen | VoiceOver |
|---|---|---|
| Open | New → **Scan it**. Apple's camera view with no reticle, and one card line (§3.1 item 5). | The card is read. Record is labelled "Record scan". |
| Capturing | Apple's own capture view and feedback. Shot count, and Done after 10 shots. | Apple's feedback is announced as it changes. |
| Review | Done pauses the session [A2b], then shows `ObjectCapturePointCloudView` [A12]. **Use scan** (prominent) calls `finish()`. **Keep scanning** calls `resume()` and goes back to capturing. | "Scan paused. Use scan, or keep scanning." |
| After | Back to New with the scan attached. The project reads "Your Mac is building it". | — |

- **No haptics** (`shouldPlayHaptics = false`).
- **Reduce Motion** is honoured by our card.
- **The rig uses the same screen and the same flow.** It is not a mode, so the PRD §11.1 question "Using the scan rig?" goes.

### 3.5 Every layout (AGENTS.md)

| Layout | Capture | Result | Test |
|---|---|---|---|
| iPhone (compact) | Yes | Yes | `LayoutParityUITests` (iPhone) |
| iPad, regular width | **In scope** on LiDAR iPads (iPad Pro). Apple's view adapts; our card and Done are checked in landscape and portrait. LiDAR-less iPads (David's iPad Air) keep PRD §5.2's disabled tile. | Yes | `LayoutParityUITests` (iPad) |
| iPhone Duo | No LiDAR: disabled tile (PRD §6) | Yes | — |
| Mac | No camera scan (existing §6.1 exception) | Yes | `ObjectsModelTests` |
| Linux | No camera scan (existing §6.1 exception). A Linux companion can't rebuild Apple HEICs: `linux-reconstruct` reads JPEG and PNG only. See the **Stage 2 gate** below the table. | Yes | `domain.test.ts`, plus the companion refusal test |
| Android | **Exception for now** (David's decision, Nov 8/9): no no-box scan in this TestFlight cycle. Android keeps its current ARCore scan until the iPhone path is proven. | Unchanged: Android's existing scan results | `HomeLayoutTests` (unchanged) |

**Stage 2 gate: an iPhone paired with a Linux companion.**
- The Linux companion refuses `start` for `source: "object-capture"` with a plain sentence: "Scans from iPhone are rebuilt on a Mac. Pair this iPhone with a Mac to use Scan it."
- The phone shows that sentence on the project's failed card and keeps the images, so the scan can be sent again once a Mac is paired.
- A companion test covers the refusal.
- Until this gate passes, Stage 1 runs only against the Mac companion.

**Proposed PRD §6.1 row.** It lands in the PR that ships the user-facing change, using §6.1's own columns:

| Feature | iPhone (compact) | iPad, regular width | Mac | Android | Linux |
|---|---|---|---|---|---|
| Scan it: Apple Object Capture, no box, no mode; every image rebuilt on the Mac (§5.3, §11.1) | New → **Scan it**: Apple freeform capture, two heights, Done after one pass, point-cloud review | The same on LiDAR iPads (iPad Pro); iPads without LiDAR show the disabled tile (§5.2) | No camera scan; rebuilds the phone's images with `PhotogrammetrySession` | **Exception for now: Android keeps its current scan until the iPhone path is proven** (David, Nov 8/9) | No camera scan |

---

## 4. Stage 1: measurable, on the DAD sign

**Stage 0 (optional; Mac only; no phone change).** If the Nov 8 run's full `Images` folder is still on the iPhone (`NativeCaptures/<run>/Images`), copy it to the Mac. Rebuild with §3.3 plus `ignoreBoundingBox = true`. This tests the Mac half alone: are both D's back, and what does matte black give?

**Stage 1 build.** It sits behind a launch argument, because there is no Labs switch; only `HandheldCapture.offered` exists (`HandheldCapture.swift:47`).
- **Phone:** §3.1 and §3.2.
- **Companion:** `source` in the manifest and digest; route to folder mode; keep output.
- **Mac:** `.high`.
- **Tests:** companion manifest tests, and the capture → start → rebuild path with a stored DAD capture.

**Calibration capture, before any Stage 1 run.** This pre-registers criterion 10's sharpness line.
- Put the DAD sign on the rig under each run's lighting condition. Using the Stage 1 build, stop the arm at 12 positions (every 30°) and hold it still until Apple takes a shot at each.
- **Line = 0.6 × the lowest calibration value**, measured as the variance of the Laplacian on the sign's region.
- The value goes into the Stage 1 plan file and into every run's receipt **before** the runs start.
- It is kept apart from the run images and is never recomputed from the frames it judges.

**Stage 1 runs.** Each run is two scans by hand plus three on the rig, done twice:

| Run | Conditions |
|---|---|
| **1-as-is** | Today's room, the lime backdrop that moves with the camera, no coating |
| **1-mitigated** | §5 mitigations: diffuse light on the object; a stationary, textured background instead of the moving lime one; matte textured coat on the black letters if David accepts it |

**Criteria.** Ground truth is calipers on the day: width, height and depth, plus a letter's height and the width of the A and D counters.

| # | Criterion | Source |
|---|---|---|
| 1 | No box shown and no mode chosen; only Record and Done pressed | New (proposed) |
| 2 | Capture ≤ 60 s by hand, and ≤ 90 s on the rig including re-clamping | New (proposed) |
| 3 | Every image reaches the Mac: the count on the Mac = `numberOfShotsTaken` | New (proposed) |
| 4 | Done → USDZ on the Mac ≤ 4 min (upload ≤ 60 s) | New (proposed) |
| 5 | **Both D's whole**: the length is within tolerance of calipers (the Nov 8 failure) | New (proposed) |
| 6 | Every axis within **±1.0 mm or ±1.5%**, whichever is larger; the feature dimension within ±1.0 mm | PRD §11; part of David's decision (below) |
| 7 | A and D counters open; no backdrop or platform geometry | PRD §11 (no foreign geometry) + new (holes) |
| 8 | Underside closed, apart from real holes | PRD §11 |
| 9 | Repeatability: 2 hand scans within 1%, 3 rig scans within 0.5% | PRD §11, §11.1; part of David's decision (below) |
| 10 | **Sharpness:** at most 15% of images fall below the sharpness line on the sign's region, measured as the variance of the Laplacian. The line is **pre-registered** from the separate calibration capture above. It is never derived from the frames it judges; its value is **[measure]**. Each image's EXIF exposure time and ISO are recorded as evidence. This is an engineering check run on the Mac, not part of the product. | David's decision (below) |

**The shutter rule: David's decision (Nov 8/9).**
- **What changes.** For Apple's capture path, the fixed "1/250 s or faster" rule is replaced. The scan must pass the measured checks instead:
  - sharpness (criterion 10);
  - caliper dimensions within ±1.0 mm or ±1.5% (criterion 6);
  - repeat scans that agree (criterion 9).
- **Why.** Apple picks the exposure (§2.10). Nov 8 was 1/60 s.
- **What doesn't change.** In-hand capture (PRD §11) is not Apple's capture path and keeps its own rule.

**Reading the results:**
- **1-as-is passes:** ship the Apple-only path (Stage 2).
- **Only 1-mitigated passes:** ship Apple-only, with the §5 advice in the help text and in the light feedback line.
- **Both fail:** pick the Appendix item that answers the specific failing criterion. Nothing else.

**Stage 2.** The user-facing change on every layout (§3.5): New shows one **Scan it**, the Walk/In hand/Rig switch goes, the PRD sections in §7 are updated, the parity tests run, and the Linux-companion gate (§3.5) passes.

**Stage 3.** Remove the object-centric code paths and `sendCapture`'s 24-photo path after ten accepted scans across at least three objects.

---

## 5. What Apple-only can't fix, and the non-code fixes

**Featureless matte black.**
- Photogrammetry needs visible texture. Matte black shows none, and it absorbs LiDAR: Nov 8 had almost no points on the letters (§1).
- WWDC23 says Apple supports "low-texture objects by leveraging the LiDAR Scanner" [S1]. That doesn't help a surface that returns no LiDAR either.
- No Apple setting, and no custom pipeline in the Appendix, can invent surface detail that was never captured.
- The fixes are physical:

| Mitigation | Apple's words | Notes |
|---|---|---|
| **Diffuse light on the object** | "Use diffused lighting if possible" [S6]; WWDC23: "We recommend using diffuse lights" [S1] | It lifts the dark object out of 1/60 s / ISO 2500 (§1), so frames are sharper and less noisy. Use two soft lights or bright daylight; no hard shadows. |
| **A stationary, textured background** instead of a lime one that moves with the camera | WWDC23: "For mostly textureless objects… put them against a textured background where they can stand out" [S1] | A static background seen through the A and D counters agrees with the room. Keep the room visible at the frame edges, which is what held tracking on Nov 8. |
| **A matte textured coat** on featureless parts | "You can draw or paint on the surface of an object to add color or texture" [S6] | Use a removable scanning spray, a light powder, or pencil or tape marks where acceptable. Only on the user's say-so. It adds microns, or about 0.1 mm for tape. |
| **Fill the frame; get closer** | "fills as much of the camera's frame as possible without excluding or cutting off any part" [S6] | Apple's `objectTooFar` feedback applies only with a box. In freeform this is advice in the help text. |

**Shiny, transparent or thin objects** fail for every photogrammetry. That is Apple's own guidance ([S6]), said plainly in help.

---

## 6. Honest limits of Apple-only

- **No shutter control** (§2.10). By David's decision, this path is judged by measured sharpness, dimensions and repeatability, not by a fixed 1/250 s (§4).
- **No coverage dial in freeform** (§2.2). The person relies on the one-line card and Apple's point-cloud review.
- **The bottom.** Where the object sat on a surface, Apple's masked model has whatever RealityKit infers there. The existing touch-up and printer flow handles it as it does today; criterion 8 measures it.
- **Unknowns [measure]:**
  - Apple's freeform shot rate, HEIC size and the image file names (§3.2) on iPhone 17 Pro;
  - `.high` time on the Mac;
  - whether Apple's automatic masking keeps the A and D counters open with a static textured background.

---

## 7. PRD changes when shipped (not before)

- **§5.2:** one **Scan it** tile. The rig card stays as advice, with the Kass 3D link.
- **§5.3:** Apple freeform capture, two heights, Done after one pass, Mac rebuild. Remove the Walk / In hand / Rig switch.
- **§11.1:**
  - remove "asks once ('Using the scan rig?')";
  - two clamp heights;
  - **the shutter rule (David's decision, Nov 8/9).** Replace "Exposure follows §11: 1/250 s or faster" with:

    > Apple's capture path sets its own exposure. Instead of a fixed shutter, a scan passes the measured checks: sharpness (at most 15% of images below a sharpness line pre-registered from a separate calibration capture), caliper dimensions within ±1.0 mm or ±1.5%, whichever is larger, and repeat scans that agree (two within 1%; three rig scans within 0.5% on every axis). David, Nov 8/9.

    In §11.1's pass criteria, "The same as §11" becomes "The same as §11, except the shutter item, which the measured checks above replace".
- **§6.1:** the row from §3.5, including David's Android exception: "Exception for now: Android keeps its current scan until the iPhone path is proven."
- **§0:** the Scanning status line.

---

## Appendix: custom work, only if a measured Apple-only run fails

None of these is in the plan. Each answers one specific failure of Stage 1 runs **after** the §5 mitigations. They come from the earlier revisions and the reviews (Muse, Argon), and are kept so the work isn't redone if it is ever needed.

| # | Custom item | Only if this fails | What it would do | Cost [estimate] |
|---|---|---|---|---|
| C1 | **Our object masks:** `ObjectMasker` rewritten for still objects (2D-first silhouettes with `GenerateIterativeSegmentationRequest`, iOS/macOS 27 [A13]; convergence of camera axes; highest support surface; rejecting anything that spans the backdrop). Applied by loading Apple's HEICs with `PhotogrammetrySample(contentsOf:)`, which keeps Apple's get-only `camera` and `depthConfidenceMap` [A7], and setting `objectMask` | Criterion 7: Apple's automatic masking fills the A and D counters, or keeps the backdrop or platform | Hands RealityKit our masks instead of its automatic ones | Mac 3–5 days; the `ObjectMasker` seeding is a rewrite; macOS-only `HandheldKit` is fine |
| C2 | **Bottom cut and cap:** fit the cut plane to the mesh's own lowest open boundary (not a mapped capture plane; a 1–2° tilt slices 1.6–3 mm), cap only closed loops, never fill real holes | Criterion 8: underside not closed | A deterministic `scan-repair` operation | 2 days |
| C3 | **Scale check:** a similarity fit of `.poses` [A10] against Apple's `camera.transform` centres [A7], using `linux-reconstruct`'s gates, with up taken from gravity (a flat-circle loop passes the eigenvalue gate at `scale.py:23,193-196`) | Criterion 6 misses by a scale factor while the shape is right | Flags the scale and asks for one measurement (`capture-measurement`); never corrects it silently | 2 days |
| C4 | **Our own ARKit capture with shutter control:** 4K frames (`recommendedVideoFormatFor4KResolution`); shutter priority via `configurableCaptureDeviceForPrimaryCamera` (iOS 16) and `setExposureModeCustom(lensAperture: AVCaptureDevice.autoLensAperture, duration:, iso: AVCaptureDevice.autoISO)` (iOS 27) inside `lockForConfiguration()`, re-applied after every `run`; 1/250–1/125 s; blur = t_exp·max‖u̇‖ with rotation only from the gyro; depth NaN when invalid and kept out of samples until a registration gate passes | Criterion 6 or 10 fails **from blur** in 1-mitigated: more than 15% of images under the sharpness line. The fixed 1/250 s rule no longer triggers this; David replaced it with the measured checks (§4). | Sharp frames at a chosen shutter. It loses Apple's per-image camera data [A7], so RealityKit estimates poses itself | 4–6 weeks, including the upload contract (a depth bplist or new route, and HEIC support in the `capture-camera` validators at `schemas.py:68-91` / `capture-camera.ts:13-34`) |
| C5 | **Rig drift fallback:** compare ARKit Δyaw with CoreMotion; orbit-pose model; lime chroma ∩ depth masks | Only with C4, and only if rig tracking fails. Nov 8 tracking **held** (§1), so this is unlikely | Keeps a rig capture usable when the view is mostly a backdrop that moves with the camera | 2–3 days |
| C6 | **CoreMotion coverage ring** (yaw and pitch bands) with `requestImageCapture()` for gaps [A4] | People stop at one height despite the card: Mac poses show one elevation band | Shows which height is missing | 2–3 days |
| — | **LiDAR depth fusion (TSDF)** | **Rejected.** iPhone LiDAR has about 576 physical points, 15–20 mm apart at 40 cm, and matte black returns almost none (§1). It cannot meet ±1 mm, and must never patch the real A and D holes. | — | — |
| — | **Single-image 3D** | **Rejected.** Spatial scenes (`ImagePresentationComponent.Spatial3DImage`) are visionOS 26 only [A14], and the iOS Photos feature has no API [S7]. SHARP's weights are research-only [S5]. Depth Pro's licence likely fails `tools/licence-audit` [S10]. None of them sees a back or a bottom. | — | — |

---

## Sources

Apple. Availability is read from `https://developer.apple.com/tutorials/data/documentation/<path>.json` on 2026-11-08.

| # | API or page | Availability | URL |
|---|---|---|---|
| A1 | `ObjectCaptureSession`, `start(imagesDirectory:configuration:)` | iOS 17.0 | https://developer.apple.com/documentation/realitykit/objectcapturesession |
| A2 | `startCapturing()` ("freeform scanning where the user skips the bounding box selection… from `.ready` directly into `.capturing`"); `startDetecting()`; `finish()` ("ignores this method call if the current state is any value other than `.capturing`") | iOS 17.0 | https://developer.apple.com/documentation/realitykit/objectcapturesession/startcapturing() · https://developer.apple.com/documentation/realitykit/objectcapturesession/startdetecting() · https://developer.apple.com/documentation/realitykit/objectcapturesession/finish() |
| A2b | `pause()` ("Call this when object capture view is not visible, such as when a help screen is shown"), `resume()` ("after pause() is called to show another view temporarily"), `isPaused` | iOS 17.0 | https://developer.apple.com/documentation/realitykit/objectcapturesession/pause() · https://developer.apple.com/documentation/realitykit/objectcapturesession/resume() · https://developer.apple.com/documentation/realitykit/objectcapturesession/ispaused |
| A3 | `beginNewScanPass()`, `beginNewScanPassAfterFlip()` ("only valid in object-centric scanning"); `userCompletedScanPass` ("a full circular scan pass around the bounding box") | iOS 17.0 | https://developer.apple.com/documentation/realitykit/objectcapturesession/beginnewscanpass() · https://developer.apple.com/documentation/realitykit/objectcapturesession/usercompletedscanpass |
| A4 | `Configuration.isOverCaptureEnabled`; `isAutoCaptureEnabled`, `shouldPlayHaptics` (iOS 18.0); `numberOfShotsTaken`, `maximumNumberOfInputImages`, `requestImageCapture()` | iOS 17.0 / 18.0 | https://developer.apple.com/documentation/realitykit/objectcapturesession/configuration-swift.struct/isovercaptureenabled · https://developer.apple.com/documentation/realitykit/objectcapturesession/shouldplayhaptics · https://developer.apple.com/documentation/realitykit/objectcapturesession/isautocaptureenabled |
| A5 | `ObjectCaptureSession.Configuration` (only `checkpointDirectory` and `isOverCaptureEnabled`); capture `checkpointDirectory` ("speed up on-device reconstruction") | iOS 17.0 | https://developer.apple.com/documentation/realitykit/objectcapturesession/configuration-swift.struct · https://developer.apple.com/documentation/realitykit/objectcapturesession/configuration-swift.struct/checkpointdirectory |
| A6 | `ObjectCaptureSession.Feedback`: `environmentLowLight` ("Auto-capture still proceeds"), `environmentTooDark`, `movingTooFast` ("may be paused to ensure quality"), `outOfFieldOfView` ("The bounding box of the object is not in the field of view"), `objectTooFar` | iOS 17.0 | https://developer.apple.com/documentation/realitykit/objectcapturesession/feedback-swift.enum |
| A7 | `PhotogrammetrySample.init(contentsOf:)`; get-only `camera` (`transform`, `intrinsics`, `calibrationData`), `boundingBox`, `depthConfidenceMap`, `sessionID`, `scanPassID` | iOS 18.0, macOS 15.0 | https://developer.apple.com/documentation/realitykit/photogrammetrysample/init(contentsof:) · https://developer.apple.com/documentation/realitykit/photogrammetrysample/camera-swift.property |
| A8 | `PhotogrammetrySession.Configuration.checkpointDirectory` ("For macOS reconstruction… starts from scratch, and does not resume from previous checkpoints") | macOS 14.0 | https://developer.apple.com/documentation/realitykit/photogrammetrysession/configuration-swift.struct/checkpointdirectory |
| A9 | `isObjectMaskingEnabled`; `featureSensitivity` / `.high`; `ignoreBoundingBox` (macOS 15.0) | macOS 12.0 / 15.0 | https://developer.apple.com/documentation/realitykit/photogrammetrysession/configuration-swift.struct/isobjectmaskingenabled · https://developer.apple.com/documentation/realitykit/photogrammetrysession/configuration-swift.struct/featuresensitivity-swift.property · https://developer.apple.com/documentation/realitykit/photogrammetrysession/configuration-swift.struct/ignoreboundingbox |
| A10 | `PhotogrammetrySession.init(input:configuration:)` with a folder; `Request.modelFile(url:detail:geometry:)`; `Request.poses` | macOS 12.0 (poses 14.0) | https://developer.apple.com/documentation/realitykit/photogrammetrysession/init(input:configuration:) · https://developer.apple.com/documentation/realitykit/photogrammetrysession/request/modelfile(url:detail:geometry:) |
| A11 | `ObjectCaptureView(session:)`, `hideObjectReticle(_:)` (iOS 18.0) | iOS 17.0 / 18.0 | https://developer.apple.com/documentation/realitykit/objectcaptureview/hideobjectreticle(_:) |
| A12 | `ObjectCapturePointCloudView(session:)` ("review the captured 3D model before finishing the capture") | iOS 17.0 | https://developer.apple.com/documentation/realitykit/objectcapturepointcloudview |
| A13 | Vision `GenerateIterativeSegmentationRequest` (Appendix C1 only) | iOS/macOS 27.0 | https://developer.apple.com/documentation/vision/generateiterativesegmentationrequest |
| A14 | `ImagePresentationComponent.Spatial3DImage` (Appendix, rejected) | visionOS 26.0 only | https://developer.apple.com/documentation/realitykit/imagepresentationcomponent/spatial3dimage |

Other sources:
- **[S1] WWDC23 "Meet Object Capture for iOS".** The extra shots "are stored in the Images folder"; "we support only the reduced detail level on iOS"; "Mac reconstruction also utilizes the LiDAR data we save in our images"; "We now support the reconstruction of low-texture objects by leveraging the LiDAR Scanner"; "put them against a textured background"; "diffuse lights". https://developer.apple.com/videos/play/wwdc2023/10191/
- **[S2] WWDC24 "Discover area mode for Object Capture".** "Simply skip the call to startDetecting and proceed directly to startCapturing… there is no new call or configuration to set"; `hideObjectReticle`. https://developer.apple.com/videos/play/wwdc2024/10107/
- [S5] SHARP: https://github.com/apple/ml-sharp (`LICENSE_MODEL`: research use)
- **[S6] "Capturing photographs for RealityKit Object Capture".** "different angles at different heights", "70% overlap", "Use diffused lighting", "draw or paint on the surface", "fills as much of the camera's frame". https://developer.apple.com/documentation/realitykit/capturing-photographs-for-realitykit-object-capture
- [S7] Apple Developer Forums, "Spatial Scene API for iOS Apps": https://developer.apple.com/forums/thread/787237
- [S10] Depth Pro: https://github.com/apple/ml-depth-pro

Repository:
- `apps/mobile/modules/object-capture/GuidedCaptureSample/GuidedCaptureSample/`: `AppDataModel.swift:92,143,263-275,418-421,450-452`, `Views/BottomOverlayButtons.swift:110-121`, `Views/OnboardingButtonView.swift:72`, `Views/TopOverlayButtons.swift:128-132`, `CaptureFolderManager.swift:122-123`.
- `apps/mobile/ios/ScanToMake/Platform/MacConnection.swift:206-220`.
- `packages/CounterpartKit/Sources/CounterpartKit/Companion/Uploads.swift:27-80`, `Transport.swift:75`.
- `services/companion/src/objects/service.ts:135-158,1209-1215`, `reconstruct.ts:116`.
- `tools/mac-reconstruct/Sources/mac-reconstruct/main.swift`, `Sources/HandheldKit/Samples.swift:30`.
- `apps/mobile/ios/ScanToMake/Objects/HandheldCapture.swift:47`.
- PRD §5.2, §5.3, §6.1, §10, §11, §11.1.
- [Nov 2 capture audit](../../../status/capture-reconstruction-audit-2026-11-02.md).
