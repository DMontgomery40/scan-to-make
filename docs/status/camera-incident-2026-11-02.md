# Camera incident on Davica3, 2026-11-01 to 2026-11-02

Facts from the device syslog, the photos on the phone and the installed bundles. Times are MST. Where a line
is quoted, it is the device's own log. Nothing here is a theory about the cause; what is still unknown is
listed at the end.

Logs, all on David's Mac:
- `~/scan-to-make-work/kan217/accept/acc-*.log`: the full syslog, filtered to our app, the camera daemon
  (`cameracaptured`), Face ID, the Camera app and Object Capture. From 02:36 on 2026-11-02.
- `/private/tmp/claude-501/-Users-davidmontgomery-scan-to-make/316a92b5-d190-4997-8b90-7a6bcace1a6b/scratchpad/devlogs/`:
  `ab-test.log` (21:58–22:13 on 2026-11-01) and `kan217-camera-excerpt.log` (22:40–22:42).
- `~/scan-to-make-work/kan217/scan-p0/app.log`: our app's lines only, 01:49–02:08 on 2026-11-02. There is no
  camera-daemon log for 22:46 to 03:40.

## Timeline

**2026-11-01, 22:10.** Scan in hand (`HandheldDepthRecorder`, the `.builtInLiDARDepthCamera` device: wide
camera plus LiDAR) set frame durations on the LiDAR device. Its session started at 22:10:01.617 and
started only "BackSparseTimeOfFlight Camera" and "Back Camera". Then:
- 22:10:01.806: `SetExternalSyncFrameRateRational - Set the external pulse from the MSG to 0/1`.
- 22:10:05.788: Face ID's session fails with `-12681` while ours holds the camera.
- From 22:10:17: 15 lines `The continuity display is connected. Will start blackening frames.` for Back,
  BackSuperWide, BackTelephoto and the LiDAR stream.
- On the Mac at the same time (its unified log): `xcodebuild` and `CoreSimulatorService` were active
  (22:09:50 to 22:10:18 and on), and `ContinuityCaptureAgent` listed Davica3 as a wired (USB) device
  (22:09:51, 22:10:01, 22:10:12). The coordinator's reading: the blackening came during a Simulator UI
  test run with screen recording, while the Mac held Davica3 as a wired Continuity Camera.
- After a reboot, at 22:42:31, the Camera app worked (`kan217-camera-excerpt.log`).
- Fix: #231 (`8a5b1c1`) stopped setting frame durations.

**2026-11-02, 02:07.** From our app's log only:
- 02:07:03.599: Scan in hand's `AVCaptureSession startRunning` on the Back LiDAR Depth Camera. No
  `stopRunning` follows.
- 02:07:43.314: the app's scene is invalidated (swiped away).
- 02:07:57.72: a walk-around `ObjectCaptureSession` starts; from 02:07:58.844, `No depth map is available in
  ARFrame!` ×173 until it is cancelled at 02:08:04.
- Photos taken afterwards with the Camera app, read with ImageIO:

  | Photo | Taken | Lens | Exposure | ISO | BrightnessValue | Mean pixel (R, G, B) |
  |---|---|---|---|---|---|---|
  | IMG_2125 | 02:08:16 | back triple camera 2.22mm f/2.2 (ultra-wide) | 1/40 s | 1000 | −0.057 | 0, 92.6, 9.4 |
  | IMG_2126 | 02:11:09 | same | 1/40 s | 1000 | −0.093 | 0, 92.9, 9.3 |
  | IMG_2127 | 02:11:12 | same | 1/40 s | 1000 | −0.099 | 0, 92.0, 9.5 |

  Flat green with R = 0 is what all-zero YUV planes convert to. Exposure and ISO are set, so auto-exposure
  ran on those frames.
- Fix: #246 (`c2eb1e0`) hid Scan in hand and stops any capture when the app leaves the screen. Release
  `c2eb1e0` was installed on Davica3 at 02:23.

**03:39.** David restarted the phone. The syslog reconnected at 03:40:48.
- 03:40:52 and 03:42:43: Face ID sessions log `SetExternalSyncFrameRateRational … 0/1` and
  `Fig assert: "( storage && ! storage->invalid )"` with nothing of ours running.
- 03:44:01: iOS launched the Camera app in the background: `dasd` "Building closure for 'com.apple.camera'",
  `RBSLaunchRequest … "DAS DYLD3 Closure Generation"`, then SpringBoard "Bootstrapping app<com.apple.camera>
  with intent background". It never started a capture session.

**03:46–03:48: an automated test of ours.** A launchd job ran `xcodebuild test` on Davica3
(`DeviceCameraAcceptanceUITests/test1CancelThenCamera`, main `34fa520` plus the test file):
- 03:46:52: installed a Debug build of ScanToMake and `ScanToMakeUITests-Runner`, replacing Release
  `c2eb1e0`.
- 03:47:05: XCTest's diagnostic screen recording started. The runner logs two new displays:
  `AirPlay[3-3]; mode: "1328x2880 60Hz"` (03:47:05.171) and `AirPlay[4-3]; mode: "1885x4096 30Hz"`
  (03:47:05.768). The runner reads `DisableDiagnosticScreenRecordings`, which was not set.
- 03:47:20.29: the test opened the walk-around. When its streams started, the camera daemon logged
  `The continuity display is connected. Will start blackening frames.` for BackSparseTimeOfFlight
  (03:47:21.633), BackSuperWide (.638) and Back (.646). Every frame was black, including the LiDAR's:
  `No depth map is available in ARFrame!` ×211 and `Failed generating depth: missing point cloud` ×210.
- 03:47:28.92: Stop capture; `captureSession_StopRunning` and the session's cancel came before the app
  left the screen.
- 03:47:37.77–03:47:47.4: the test opened the Camera app, took two screenshots (viewfinder mean 13.9 of
  255, near black) and closed it.
- 03:49:29: the phone went offline.

**About 03:50.** David restarted the phone; the camera was still black.
- No ScanToMake process ran after this restart; its only log lines are SpringBoard icon lookups.
- 03:54:08: the Camera app's session (pid 600). The ultra-wide (ISP channel 4) streamed at about 26.6 fps
  (`Interval frames 265, fps 26.854257`). There was no blackening line.
- 03:57:15: a photo on channel 4: `AllocateAndSendOneShotBuffers (channel 4): Sent still image buffers:
  still=0, stillycc=0, sushi=0, sashimi=0, fpc=0`, then four "Still frame received" and "Capture complete".
- That photo, IMG_2128D (03:57:15, the same ultra-wide): exposure 0, ISO 0, BrightnessValue 0, mean pixel
  0, 0, 0. No exposure metadata at all.

**04:01–04:05: recovery.**
- The app's container was backed up to `~/scan-to-make-work/davica3-counterpart-backup-20261102-0401/`
  (1.8 GB).
- Counterpart was uninstalled (the test runner was already gone).
- Six provisioning profiles were removed: com.scantomake ×3, arharness, the arharness xctrunner, and
  org.reactjs…ScanToMake.
- The phone was restarted. **The camera works** (`acc-040430.log` from 04:04:32).
- With the app installed, the camera had stayed black across two restarts.

## What was installed

The Release (`c2eb1e0`) and Debug (`34fa520`) `ScanToMake.app` have the same Info.plist. None of the
following can run or register without the app being opened:

- **Info.plist:** URL schemes `scantomake` and `counterpart`; `NSBonjourServices` `_scantomake._tcp`;
  `NSCameraUsageDescription` and `NSLocalNetworkUsageDescription` (text only); `UIFileSharingEnabled`;
  `LSSupportsOpeningDocumentsInPlace`; multiple scenes. No `UIBackgroundModes`, `NSExtension`,
  `BGTaskSchedulerPermittedIdentifiers`, `NSUserActivityTypes`, `LSApplicationQueriesSchemes`, Live
  Activity, or any capture, LockedCameraCapture or Camera Control key.
- **Entitlements** (`codesign -d --entitlements`): `application-identifier`, team id and `get-task-allow`
  only. The embedded team profile would allow iCloud and push; the app claims neither.
- **Extensions:** none. No widget, App Intents metadata, notification extension, Watch app or App Clip.
  The Debug build also carries `PlugIns/ScanToMakeTests.xctest` (the unit-test bundle, not an extension),
  `ScanToMake.debug.dylib` and `__preview.dylib`.
- **Frameworks:** one, `GuidedObjectCapture.framework` (our copy of Apple's Object Capture sample). No React
  Native, Pods or third-party camera library.
- **Camera code** runs only in the app after a tap: the walk-around (`ObjectCaptureSession`), the pairing QR
  scanner (`DataScannerViewController`), Take Photos (`UIImagePickerController`), Choose Photos
  (`PhotosPicker`). At launch the app only reads `ObjectCaptureSession.isSupported`,
  `PhotogrammetrySession.isSupported` and `ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)`.
  No code of ours ever selected the ultra-wide, triple or dual-wide camera (`git log --all -S` finds none).

The Xcode-generated `ScanToMakeUITests-Runner.app` (com.scantomake.uitests.xctrunner) declares
`UIBackgroundModes` `["continuous"]` and 49 usage descriptions; that is Xcode's template, not our project.

## Markers that are not diagnoses

Each of these appears in a session where the camera worked, so none of them shows a fault on its own:

- `Fig assert: "targetFNumber != 0"` (BWExposureAnalyticsMonitor) and `Fig assert:
  "closestDetectedObjectsInfo"`: 8,374 `targetFNumber` lines in `acc-040430.log`, with the camera working.
  An earlier report used them as the fault; that was retracted.
- `SetExternalSyncFrameRateRational - Set the external pulse from the MSG to 0/1`, `Cannot change the
  external pulse rate`, `Error setting ExternalSyncFrameRateRational: -12684` and `Fig assert: "( storage
  && ! storage->invalid )"`: Face ID and the Camera app log them on a clean boot.
- `H16ISPMetadataDictCreatorGraphNode - Channel 3/5 has invalid lens coefficients` (Face ID's infrared
  camera and the LiDAR) and `ISP_CILRequestPerChannel calls kernel`: present in the working 22:42 session.
- `No depth map is available in ARFrame!`: also logged whenever the LiDAR frames are blackened, as at 03:47.

## Still unknown

- What kept the ultra-wide sending frames without exposure data across two restarts, and why
  uninstalling the app and removing the profiles, then restarting, cleared it.
- How a Simulator UI test run on the Mac reaches the phone's camera: whether through Continuity Camera,
  the screen recording, or both.
- What the camera daemon logged at 02:07: there is no daemon log for that window.
