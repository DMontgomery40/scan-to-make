# Scan to Make: mobile shell (UI-001)

React Native 0.87 (TypeScript, Hermes, New Architecture) shell for the D004 capture/preview spike. This is a scaffold: capture and preview screens are stubs, and the spike harness measures a headless AR session.

## Layout

| Path | What it is |
| --- | --- |
| `App.tsx`, `src/screens/` | Home, capture (stub), preview (stub), spike harness |
| `src/capture/captureSource.ts` | `CaptureSource` interface: native module wrapper plus a labelled mock |
| `src/spike/d004.ts` | D004 pass-criteria scoring; pure TypeScript |
| `src/spike/runtimeProbes.ts` | Core probes for the "runs unchanged on Hermes" criterion |
| `src/contracts/placeholder.ts` | **Placeholder**, to be replaced by `packages/contracts` (CORE-001) |
| `modules/scan-capture/` | Local autolinked TurboModule: ARKit (Swift + ObjC++) and ARCore (Kotlin) |

## Checks (Linux or macOS)

```sh
npm install
npm run typecheck
npm run lint
npm test
```

## D004 device run (needs the Mac and real phones)

```sh
npm install
cd ios && bundle install && bundle exec pod install && cd ..
npm run ios -- --mode Release --device     # or: npm run android -- --mode release
```

Use a Release build, because Debug JS makes UI-thread numbers meaningless. On the phone, open **Capture spike (D004)** and tap **Start 2-minute run**. Keep the app in the foreground and pan slowly over a cup holder. The run auto-stops after 5 s of warm-up plus 120 s of scoring. Tap **Share report (JSON)** and post the JSON in #build-room.

Each report carries the thresholds it was scored with and the raw 1-second samples, so it can be re-scored if the team changes the interpretation.

| Criterion | How it is scored now |
| --- | --- |
| Holds 30 fps for 2 min | Native frames are pooled into 5-s windows after warm-up. Every window must reach 29.5 fps (30 minus a quantisation tolerance). |
| No thermal throttling | The thermal state must never exceed iOS `fair` (Android `light`). Android `moderate` and above count as throttling. |
| Preview stays anchored | Not yet known: needs the native AR preview view and an observer check |
| TS core on Hermes | Every probe in `CORE_PROBES` passes on Hermes. Add contracts/geometry probes when they land. |

Mock sources (simulator, emulator without ARCore, tests) always score "Not yet known".

## Known gaps

- No camera preview is rendered yet. ARKit runs headless, and ARCore runs on an offscreen GL context. Frame rate and thermal numbers are only representative once the AR preview view and the real capture workload are in. Depth is enabled where supported; mesh reconstruction is enabled on LiDAR iPhones.
- iOS has not been built here; the Swift/ObjC++ module still needs a Mac build.
- The repo has no workspace root yet. When `packages/contracts` lands, Metro needs `watchFolders` (or a workspace) to import it.
