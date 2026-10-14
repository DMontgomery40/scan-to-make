# Scan to Make: mobile shell (UI-001)

React Native 0.87 (TypeScript, Hermes, New Architecture) app with an isolated D004 capture/preview harness. The consumer UI supports a general project brief and an explicitly selected cup-holder measurement study. Custom capture/generation and printing are not implemented; the separate developer harness measures a headless AR session.

## Layout

| Path | What it is |
| --- | --- |
| `App.tsx`, `src/screens/` | Home, project brief/editor/review, measured example, design study, About and developer harness |
| `src/project/projectBrief.ts` | Template-independent object, surroundings and intended-addition brief; saved locally through the portable saved-project contract and shareable through the native share sheet |
| `src/capture/captureSource.ts` | `CaptureSource` interface: native module wrapper plus a labelled mock |
| `src/spike/d004.ts` | D004 pass-criteria scoring; pure TypeScript |
| `src/spike/runtimeProbes.ts` | Core probes for the "runs unchanged on Hermes" criterion |
| `src/fit/fitDraft.ts` | Builds contract `FitSpecPatch`es (measurements, cup-width edits) from the screen state; never applies them |
| `src/project/fitSpecStore.ts` | Legacy in-memory fit store retained for isolated tests; consumer persistence uses `savedProjects.ts` |
| `src/spike/contractsProbe.ts` | Contract consumer check (tapered-holder fixture, revisions, holder-insert protection) |
| `modules/scan-capture/` | Local autolinked TurboModule: ARKit (Swift + ObjC++) and ARCore (Kotlin) |

## Checks (Linux or macOS)

```sh
npm install        # postinstall also runs `npm ci` and builds ../../packages/contracts
npm run typecheck
npm run lint
npm test
HERMES=/path/to/hermes npm run hermes:probes   # core probes on a Hermes VM (not a device)
```

`@scan-to-make/contracts` is linked with a `file:` dependency. Metro watches `packages/contracts` and resolves Babel helpers from this app's `node_modules`. Jest maps the package to its built `dist/`. Babel adds `@babel/plugin-transform-export-namespace-from` for zod 4's ESM build.

`hermes:probes` needs a `hermes` CLI built from the tag matching `node_modules/hermes-compiler`. For RN 0.87.1 that is `hermes-v250829098.0.17`.

## D004 device run (needs the Mac and real phones)

Use a current Ruby (the local build was verified with Ruby 3.2.9 and Bundler
2.7.1), Node 22.11 or newer, and full Xcode. If `xcode-select -p` points to
CommandLineTools, set `DEVELOPER_DIR` to your Xcode installation for the commands
below, for example `/Applications/Xcode.app/Contents/Developer`.

```sh
npm ci
bundle install
cd ios && bundle exec pod install && cd ..
npm run ios -- --mode Release --device     # or: npm run android -- --mode release
```

For a simulator check, open `ios/ScanToMake.xcworkspace`, select the
`ScanToMake` scheme and a simulator, and build the Release configuration.
Release bundles JavaScript, so it does not need Metro running. The native
Swift/Objective-C++ module and Home → measured example → four manual measurements → design study flow
were verified on an iPhone 17 Pro simulator with Xcode 27.0. AR is unavailable
there; this verifies compilation and interaction, not capture or physical fit.

Use a Release build, because Debug JS makes UI-thread numbers meaningless. On the phone, open **About Scan to Make → Open spike harness** and tap **Start 2-minute run**. Keep the app in the foreground with the preview visible. On iOS, map a real surface, center it in the preview and tap to place the known orange 10 mm sphere. Only existing-plane geometry is accepted; no estimated surface fallback is used. Scored time starts at successful probe placement. Keep the probe visible while moving around it. The run auto-stops after 5 s of warm-up plus 120 s of scoring (one sample of completion slack). Tap **Share report (JSON)** and post the JSON in #build-room.

Each report carries the thresholds it was scored with and the raw 1-second samples, so it can be re-scored if the team changes the interpretation.

| Criterion | How it is scored now |
| --- | --- |
| Holds 30 fps for 2 min | Native frames are pooled into 5-s windows after warm-up. Every window must reach 29.5 fps (30 minus a quantisation tolerance). |
| No thermal throttling | The thermal state must never exceed iOS `fair` (Android `light`). Android `moderate` and above count as throttling. |
| Preview stays anchored | Complete visible native run with the same retained surface-attached probe, normal tracking and explicit observer confirmation. Numeric drift is separate. |
| TS core on Hermes | Every probe in `CORE_PROBES` passes on Hermes. This includes the contracts consumer check; geometry probes come with FIT-001. |

Mock sources (simulator, emulator without ARCore, tests) always score "Not yet known".

## Known gaps

- The iOS developer harness has a same-session visible ARKit preview and known anchor probe; physical-device performance and stability remain unqualified. Android ARCore still runs on an offscreen GL context and cannot satisfy the visible-preview report gates. Depth and mesh are configured only where supported, with observed workload reported separately.
- Native capture start/stop is available in the developer spike harness only;
  the consumer capture screen currently checks support and accepts manual sizes.
- The design dimensions (support height, wall, clearance) are seeded from the contracts fixture until FIT-001 supplies template defaults.
- Local projects are device-local and unencrypted; uninstalling the app removes them. No cloud sync, account, import/export backup or cross-device recovery is implemented.

## Consumer flow

Home starts with a general project idea: object, surroundings/constraints, and the addition to make. The brief remains editable across navigation and can be shared as text. Save draft preserves incomplete text locally. Review also saves before continuing. No scan data, generated geometry or verified fit is claimed. Empty or whitespace-only fields block review. Incomplete drafts reopen in the editor.

The cup-holder example is a separate, explicitly selected measurement study. It preserves all four contract measurements, tool uncertainty and expected-revision edits. Its proportional sketch is input evidence, not a printable part. Measurement summaries can be shared; no print action is exposed.


## Local saved projects

`src/project/savedProjects.ts` adapts `@scan-to-make/contracts/saved-project` to the standalone `modules/local-project-storage` native module. General briefs have no fit attached. Measured examples create separate unique project IDs and preserve all four dimensions and their provenance. All fit edits use protected expected-revision patches; saved-project and fit revisions remain separate.

The iOS and Android adapters use platform SQLite, one complete UTF-8 BLOB per project, parameterized statements and a write transaction. Exact-byte comparison and replacement occur under SQLite locking across connections/processes using the same database. There is no JS-only get/set race or memory fallback. FULL synchronous commits precede successful resolution. Normal process termination/relaunch is verified on iOS Simulator; power-loss durability on physical devices is not claimed. Writes bypassing SQLite, filesystem corruption and external file replacement are outside the concurrency guarantee.

The library loads before editing, reports corrupt/future entries individually, and preserves their bytes. Failed or stale saves retain the draft and offer saving a separate copy. Opening another brief with unsaved changes requires an explicit discard. Storage errors may have uncertain outcomes; inspect the saved version before retrying. The new namespace is independent of the Node service store and does not migrate it.

Verification: `npm run typecheck`, `npm run lint`, `npm test -- --runInBand`, and on macOS `python3 scripts/native-storage-tests/test.py`. The native test compiles the production iOS storage methods with a minimal React promise bridge stub; it exercises separate native processes and eight competing writers against an isolated temporary SQLite database. It is host-native evidence, distinct from the app's simulator restart walkthrough. Android compilation requires an installed Android SDK and is not established by the iOS checks.

## Native drawer design preview

**Explore drawer organizer** opens a clearly labelled synthetic design study. A
saved general brief can also attach this study without replacing its text. The
reference cavity sizes are not scans or physical measurements. Saving the first
study persists the validated entries once; subsequent expected-revision fit
patches invalidate prior preview and acceptance when they change the fit.

For the iOS Simulator, start the local worker from the repository root:

```sh
npm ci --prefix services/project
npm ci --prefix services/companion
npm run generate:serve --prefix services/companion
```

Generation posts the complete immutable saved fit to `127.0.0.1:9077`. The iOS
bridge limits both declared and streamed response size before JSON reaches JS,
refuses redirects, and supports cancellation and a 40-second resource deadline.
The portable verifier checks source equality, canonical base64, byte length and
SHA-256 using CommonCrypto. The current saved record must still match before the
receipt attaches; no Node project store or revision reset is involved.

Verified STL bytes live under Application Support in a content-addressed cache.
Writes flush a private temporary file, publish it atomically, then flush the
directory. Every reopen, render, acceptance and export boundary checks the actual
length and SHA-256 again. Explicit regeneration can replace a damaged entry only
with newly verified bytes of the same digest, preserving the damaged inode under
a separate diagnostic name. This cache is local to the app, has no automatic
cleanup, and does not claim physical-device power-loss testing or protection from
external filesystem writers. Uninstall removes it with local projects.

SceneKit displays vertices from the returned binary STL (up to 500,000 triangles),
with drag rotation and pinch zoom. It does not manufacture a procedural substitute.
The UI requires a loaded verified mesh before explicit design acceptance. Export
rechecks the current accepted binding and passes a file URL containing the exact
verified bytes to the native share sheet; it does not export the scene or text.
Missing/damaged files block review/export, and stale or failed writes retain the
saved record. Design acceptance is neither physical-fit evidence nor print
permission. No printer action exists in this flow.

The generation bridge, mesh and STL share are currently iOS-only. The fixed
loopback endpoint is a same-Mac Simulator prototype, not real-device pairing,
hosted transport or authentication. Android still supports local project storage;
its generated-preview action reports unavailable. ASCII STL rendering, cache
management and real-device transport are separate work.


## Visible iOS capture probe

The developer harness mounts an `ARSCNView` without starting a session or
requesting camera access. Explicit Start creates one `ARSession`, shared by the
preview, delivered-frame counters, depth and mesh configuration. Stop, preview
removal, interruption or leaving the foreground pauses it. A new run creates a
new session/run identity, clears the probe and resets observations.

A tap places retained known preview geometry (an orange sphere, 10 mm diameter)
on an existing-plane-geometry center raycast. This is a runtime stability probe,
not a scan asset or generated fitted part. Its original anchor transform and
sampled camera transforms are raw pose evidence, never a drift measurement.
No frames/images or captured reference assets are retained or persisted.

Report schema `scan-to-make.d004-spike-report.v1` keeps configuration separate
from observation: `depthEnabled`/`meshEnabled` describe configuration, while raw
windows record observed depth frames and mesh anchor counts. Delivered AR frames,
unique-frame render callbacks, visible-preview state, probe geometry identity,
anchor ID/attachment, in-frustum probe renders and tracking are recorded with
one run ID. Preparation windows have zero scored time; the report retains their
session-relative time. The preview must be at least 95% visible. Reports preserve
raw one-second windows and distinguish delivered mean FPS from rendered mean FPS.

Native capture/thermal qualification requires matching visible/rendered evidence
throughout scored windows. Qualitative anchoring additionally requires the same
real-surface probe retained and rendered in view with normal tracking for the
full scored run, followed by an explicit observer choice. Mock, headless, hidden,
unattached, unrendered or unobserved runs cannot qualify. A recorded negative
observation fails qualitative stability. Unmeasured numeric drift remains
inconclusive; an optional nonnegative measured maximum and external method are
scored separately against the recorded 5 mm reference, outside the qualitative
D004 overall verdict. Neither result establishes mechanical fit.

Source tests cover evidence gates, explicit observation/reset, background and
interruption cleanup. Release Simulator proves compilation, unsupported fallback,
mock report behavior and Hermes execution only. Real camera preview, raycast
placement, retained-content rendering, two-minute native performance, thermal
behavior and physical stability require a separately authorized real-device run.
No signing changes, access grants, pairing, cloud or printer operations are
provided by this milestone.
