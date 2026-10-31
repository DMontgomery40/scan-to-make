# M2b: Phone App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace every screen of the iPhone app with the spec §5 experience on top of the M2a `/v1/objects` API:
- the objects list;
- start something (instructions, then Scan or Photos);
- the object page (state, renders, size, Print, corrections, close-up ask, plate check).

The QR pairing (`FindYourMacScreen` and its native modules) and the native Object Capture module stay as they are.

**Architecture:**
- **New native bridge** `ObjectsBridge.mm` in `modules/local-project-storage/ios/`. It does pinned HTTPS to `/v1/objects/**`, copying `StillsProcessingBridge`'s request/pinning pattern: `STMReadPairing`, `STMPairingBaseURL`, `STMPinnedTrust`, `STMSamePairing`, `STMTransportError`.
  - It also sends a finished Object Capture run's USDZ and photos straight from `Documents/NativeCaptures/<runID>/` (`Models/model-mobile.usdz` and `Images/*.HEIC`), so no file paths reach JS.
  - It downloads renders to the cache and returns file URIs.
- **JS:** `src/objects/` (client and model) plus three new screens. `App.tsx` routes only `objects | start | object`, with pairing as the overlay it already is.

**Tech Stack:** React Native (existing shell), Objective-C bridge, jest, T3 device tools (`agent-device`) on the iOS 27 simulator, David's iPhone for the real run.

**Spec:** `docs/superpowers/specs/2026-10-31-app-rebuild-design.md` §5.1–5.5, §8.

## Global Constraints

- **Paths:** only `/v1/objects`, `/v1/objects/<uuid>` and `/v1/objects/<uuid>/(scan|photos?name=…|start|corrections|closeup|print|plate|model.stl|renders/<name>.png)`. Everything else is refused in native code.
- **Scopes:** reads `projects:read`, writes `captures:import`, print `printer-handoff:use`.
- **Photos from a scan:** up to 24, evenly spread from first to last. HEIC as captured; the Mac converts.
- **Copy:** plain words, the states listed in spec §5.1, and no "companion", "MCP" or "job" anywhere in UI copy. Size is shown as "W × D × H mm".
- **Layouts:** Duo folded and iPhone are one column. Open Duo and iPad are list plus page side by side. Devices without LiDAR hide Scan and say scanning needs a LiDAR device.
- **Polling:** while an object is `touching-up` or `printing`, poll `GET /v1/objects/<id>` every 3 s, and only while the screen is visible. Notifications are a later step.
- Delete the old screens and their clients and tests once the new ones work: RetainedCaptures, ScanResults, Print, CloseUps, ProjectsHome, Settings flows, Compare versions.

## Review Focus

1. **Pairing lost or certificate changed:** the bridge rejects with `pairing-required` or `certificate-changed`, and the app shows Find your Mac, not a raw error.
2. **A scan run with no photos, or a missing USDZ:** the upload reports which one is missing. It never starts a touch-up with no inputs.
3. **The app is backgrounded mid-upload:** the upload is resumable by object id. On return, the phone re-sends whatever the object lacks, comparing photo names, then calls start.
4. **Two taps on Print or Send:** one request only.
5. **The Mac is asleep or unreachable:** each screen shows one sentence and Try again.

---

### Task 1: Native `ObjectsBridge`
**Files:** create `modules/local-project-storage/ios/ObjectsBridge.mm` and register it like the other bridges; JS wrapper `src/objects/native.ts`.
**Produces** (JS):
- `ObjectsBridge.call({method: 'GET'|'POST'|'PUT', path, json?})` → `{status, body}`;
- `ObjectsBridge.sendCapture({objectId, runID, maxPhotos})` → `{photosSent, scanSent}`;
- `ObjectsBridge.download({objectId, name})` → `{uri}`.

**Tests:** extend `scripts/native-stills-processing-tests` (its Python harness with `scripts/pairing-fixture/server.mjs`) with objects-route cases:
- allowlist accept and reject;
- a pin mismatch gives `certificate-changed`;
- `sendCapture` with a fixture capture folder sends `scan` and N photos, then `start`;
- `download` returns a cached file whose bytes match.

### Task 2: JS client and view model
**Files:** `src/objects/client.ts`, `src/objects/model.ts`. Tests: `__tests__/objectsModel.test.ts`.
**Produces:**
- `objectsClient` with `list`, `get`, `create(instructions)`, `sendCapture`, `start`, `correct`, `closeupBestGuess`, `print`, `plateClear` and `renderUri`;
- `describe(object)` → `{title, status line, primary action}`. It maps every state, plate case and failure to spec §5 copy.

**Tests:** every state gets its line; `needs-closeup` shows the question; `plate.item` shows "Looks like there's a … on your plate"; `plate.noCamera` shows "Check the plate is clear"; a failure shows its reason with Try again; the size format.

### Task 3: Screens
**Files:** `src/screens/ObjectsScreen.tsx`, `src/screens/StartScreen.tsx`, `src/screens/ObjectScreen.tsx`; `App.tsx` routes. Tests: `__tests__/screens.test.tsx` (render with a fake client).
- **Objects:** a list of cards (render image, title, status line), one Scan or New button, and the Mac pill (existing pairing status).
- **Start:** an instructions box ("What do you want to make?", optional), then **Scan** (opens the existing native capture) or **Use photos** (system picker), or **Make it** (instructions only). After capture: create the object, `sendCapture`, start, and go to the object page.
- **Object:**
  - the state line;
  - the renders (swipeable) and the size;
  - **Print**;
  - the corrections box;
  - the close-up ask with Open camera / Attach photos / Make your best guess;
  - the plate photo with "It's actually clear".

### Task 4: Delete the old UI, and run it
- Remove the old screens, clients and their tests; `npm test`, `tsc` and lint stay green.
- Build and install on the iOS 27 simulator with T3's device tools, and drive Start → Make it (instructions only) → object page end to end against the live companion on the Mac. Screenshots.
- Then install on David's phone and do a real scan.
