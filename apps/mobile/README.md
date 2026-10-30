# Scan to Make: mobile shell (UI-001)

React Native 0.87 (TypeScript, Hermes, New Architecture) app with an isolated D004 capture/preview harness. The consumer UI supports a general project brief and an explicitly selected cup-holder measurement study. Saved projects support guided Object Capture on supported iOS hardware and USDZ import through the companion. General custom generation and printing are not implemented; the separate developer harness provides a same-session visible ARKit probe on iOS and offscreen ARCore sampling on Android.

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
- Saved projects support guided object capture on supported iOS hardware. The separate measured-example screen accepts manual sizes; scans do not automatically supply fit measurements.
- The design dimensions (support height, wall, clearance) are seeded from the contracts fixture until FIT-001 supplies template defaults.
- Local projects are device-local and unencrypted; uninstalling the app removes them. No cloud sync, account, import/export backup or cross-device recovery is implemented.

## Consumer flow

Home starts with a general project idea: object, surroundings/constraints, and the addition to make. The brief remains editable across navigation and can be shared as text. Save draft preserves incomplete text locally. Review also saves before continuing. The brief alone does not establish scan data, generated geometry or verified fit. Empty or whitespace-only fields block review. Incomplete drafts reopen in the editor.

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

Generation posts the complete immutable saved fit to the paired companion. The
legacy fresh-Simulator path uses `127.0.0.1:9077`. The iOS
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

The generation bridge, mesh and STL share are currently iOS-only. Companion
pairing below adds private authenticated HTTPS transport; actual physical-phone
and tailnet connectivity remain separately qualified. Android still supports local project storage;
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

## Companion pairing (iOS)

Open **Connect your companion** on Home or **Companion connection** from the
current drawer editor. The connection screen overlays the editor, preserving
unsaved entries. It offers existing-Tailscale and first-time setup guidance;
opening the official guide is explicit. The app does not install Tailscale,
sign in, approve devices, grant network access or configure Serve/Funnel.

Enter the exact private HTTPS `*.ts.net` origin and one-time code, or paste the
companion's invitation JSON (`version`, `baseUrl`, `code`, `expiresAt`). This is
pasted QR **payload** support, not camera QR scanning. Invitations expire after
five minutes. The native module exchanges the code, validates the response and
stores the origin-bound credential in iOS Keychain with
`kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and synchronization disabled.
The token never enters JavaScript, project storage, reports or application logs.
The native module returns only connection metadata. Pairing survives ordinary
app termination; its 30-day expiry requires a new invitation. Keychain behavior
after uninstall/restore is OS-controlled, so use Disconnect before removing the
app when the credential should be erased.

Health and generation requests read the exact stored origin and send both
Bearer authentication and X-Scan-Device. URLs cannot contain userinfo, paths,
queries, fragments or custom ports. Normal HTTPS certificate validation remains
enabled; redirects are refused and credentials never follow artifact URLs.
Native bounded receive limits still apply before JSON parsing. Re-pairing or
disconnecting cancels active generation; a changed credential also rejects a
late response. Rejected/revoked credentials never fall back to anonymous HTTP.
Network, certificate, denial, expiry and secure-storage errors have distinct
recovery guidance. Disconnect erases this device's Keychain item; host-side
revocation remains a separate companion-operator action. Neither changes a
project draft or grants printer access. Android pairing remains unavailable.

### Isolated Simulator fixture

After building `services/project` and `services/companion`, run from repo root:

```sh
node apps/mobile/scripts/pairing-fixture/server.mjs
```

The fixture binds only `127.0.0.1:9078`, forwards to a real isolated authenticated
generation server, and uses a synthetic allowlisted identity. Its printed path
points to a private temporary directory containing the invitation and test mode;
credentials are never printed. Paste `invitation.json` into the app. `SIGUSR1`
creates a fresh invitation; `SIGUSR2` revokes the fixture's devices. Set the
private `mode` file to `offline`, `redirect`, `forbidden` or `ok` to exercise
recovery. Stop the fixture after testing and remove its private directory.

Only Simulator builds accept the fixed HTTP fixture origin. They also accept
`https://127.0.0.1:9079` for an isolated untrusted-certificate failure test;
certificate validation is never bypassed. These origins are rejected in device
builds. The legacy same-Mac unauthenticated generation path on port9077 remains
available only in Simulator before any explicit companion selection/disconnect;
after selection it cannot be used as a fallback. Local fixture evidence is not
physical-phone/Tailscale/HTTPS success evidence.

Checks: `npm run typecheck`, `npm run lint`, `npm test -- --runInBand`, and
`python3 scripts/native-pairing-tests/test.py` on macOS. Native seam tests compile
production validation/metadata/disconnect code with a Keychain API double;
actual secure persistence requires the Simulator restart walkthrough. No tokens
or invitations should be included in screenshots, test output or public reports.

### Retained project captures on iOS

Open **Your saved projects → Project captures**. Connect with a capture-scoped
companion invitation, synchronize the saved project, then choose a USDZ file
(up to 32 MiB) from Files. Import retains the original, converted OBJ and
conversion report. Reopen verifies the current project revision and retained
bundle before review. **Review converted mesh** renders the verified OBJ with
native camera controls. Quick Look opens the original USDZ where the platform
supports it; Simulator may display file metadata only. Export uses the native
share sheet and exact verified bytes, without converting formats.

Full portable SavedProject 0.2 snapshots preserve fit, preview and acceptance
metadata. Companion acknowledgments and capture handles live separately in
Application Support/CaptureSync, namespaced by companion origin and project.
A replacement pairing at the same origin keeps those handles; every request
is pinned to the exact current pairing. Credentials remain in Keychain and
never cross into JavaScript. Local edits made during a request are preserved.
Conflicts stop synchronization and leave the local project available to review.
Editing a project makes prior captures unavailable for current-version use;
historical bytes remain retained. Captures do not accept a printable design or
establish dimensional accuracy, completeness or physical fit.

Only explicit busy responses to GET are retried (three attempts, bounded
backoff). Import POST is never retried automatically. Before POST, an
unconfirmed-import marker is flushed to local storage. A lost response leaves
that marker across restarts; an explicit confirmation permits a separate import
and explains that the earlier capture may exist. No server-side listing or
idempotency recovery is currently promised. Capture permissions denied or
revoked require an appropriate new invitation through **Connect companion**.

For isolated Simulator execution, build the companion and its dependencies,
then run the existing pairing fixture with `SCAN_CAPTURE_FIXTURE=1` and
`SCAN_TO_MAKE_CAPTURE_PYTHON` pointing to a Python 3.12 environment containing
usd-core 26.8. It creates private temporary projects/captures and explicitly
scoped fixture invitations. Use the ordinary UI to pair and import a public or
synthetic USDZ; terminate and relaunch the app, reopen the capture, review its
mesh, then Save to Files and independently compare SHA-256 and byte length.
The app's Documents folder is available in Files; credentials, project storage,
private capture cache and synchronization metadata are not in that folder.
This proves the simulator workflow only, not private-network deployment or fit.

### Native capture download fault checks

On an Apple Silicon Mac with full Xcode, an already booted iOS Simulator,
compiled companion dependencies and the converter's Python environment:

```sh
SCAN_TO_MAKE_CAPTURE_PYTHON=/path/to/python-with-usd-core \
  python3 apps/mobile/scripts/native-capture-fault-tests/test.py \
  --simulator BOOTED_SIMULATOR_UUID --evidence /tmp/capture-fault-evidence
```

Run from the repository root with port 9078 free. The harness creates a
separate disposable Simulator app, pairs through the real fixture route,
synchronizes a synthetic project and converts a synthetic two-layer USDZ.
It compiles the unchanged production `RetainedCaptureBridge.mm` into a UIKit
host. React dispatch and pairing-record storage are test seams; URLSession,
byte verification, cache writes and SceneKit presentation run natively.
This check does not establish Keychain persistence, physical capture accuracy
or private-network deployment.

Five cases exercise wrong hash, wrong content type, corrupted body, oversized
chunked body, and cancellation after receiving partial bytes. Each must reject,
leave no verified cache, refuse presentation, then successfully retry on the
same bridge and present the verified mesh. Only explicit 429 responses to the
idempotent retry GET may be retried. Imports are never retried automatically.
The native run has a 60-second bound; compilation and setup also have timeouts.
Receipts contain hashes and outcomes, never credentials. The harness removes
its app, temporary credentials and fixture after the run, preserving other apps.

Fault controls require `SCAN_NATIVE_FAULTS=1`; the fixture writes a random
control key in its private directory. Its test-only mode endpoint requires
that key. Artifact corruption happens only after the real authenticated route
returns 200. This opt-in control is confined to the loopback fixture.

### Prepared-file native foundation

`PreparedFilesClient` validates an inspected job's complete structured record and
digest, current project/revision and accepted design identity. Its input is an
already acknowledged portable snapshot and a job handle. Local edits or a pairing
change during GET prevent export. Only explicit 429 responses to GET retry, at
most three attempts. The client never creates a preparation request.

`PreparedFileBridge` accepts only exact prepared-job collection/metadata/download GET routes,
current ETags and 3MF/G-code artifact identities. It keeps credentials native,
refuses redirects, bounds streams, verifies headers/hash/length and exports exact
verified bytes into Documents as `Imported-sliced-<sha256>.<extension>`.
Capture routes and their existing bridge are unchanged. Native pairing accepts
known explicit capability sets, including prepared-only invitations, without
adding generation permission. Run CocoaPods installation when rebuilding the app
so its existing native-source glob includes the new bridge.

From repository root, after building companion dependencies:

```sh
python3 apps/mobile/scripts/native-prepared-file-tests/test.py \
  --simulator BOOTED_SIMULATOR_UUID --evidence /tmp/native-prepared-evidence
```

The separate disposable Simulator host compiles the production pairing and
prepared-file bridges. It uses real scoped pairing and Simulator Keychain,
checks GET/download route restrictions, exits, relaunches, reopens and exports
both supported media types. The Python harness independently compares exported
bytes with retained server bytes. Runtime is bounded and the test disconnects,
removes its app and deletes fixture credentials. React dispatch is a harness
seam; this is native foundation proof, not an integrated consumer screen.

The fixture uses synthetic bytes and a protocol inspector, not genuine sliced
geometry. Its settings digest hashes an actual synthetic settings JSON file;
it does not prove slicer provenance, derivation from the accepted design, physical
compatibility or print authorization. The client never creates a preparation
request or dispatch intent. Native structured validation can also consume the
actual fixture responses during Jest:

```sh
cd apps/mobile
NATIVE_PREPARED_CONTRACT=/tmp/native-prepared-evidence/fixture-contract.json \
  npm test -- --runInBand __tests__/preparedFiles.test.ts
```

### Inspected files browser

Accepted saved projects expose **Inspected files** in **Your projects**. Refresh
synchronizes the exact portable project snapshot, then discovers handles under
its current ETag/revision. Pages contain at most 20 handles; empty pages may
still continue. The browser bounds retained handles at 1,000 and treats listing
as discovery, not verified file content. Selecting a handle performs a fresh
verified GET and matches its complete job/digest/artifact/model/plate before
showing file inspection or enabling exact-byte export. Save file writes into
the app’s Documents folder, accessible in Files.

A stale cursor removes old handles and offers Refresh. Refresh replaces pages.
Opening connection settings, leaving the foreground or leaving the screen
invalidates its selection and pending results. Local project and pairing changes
are checked again before listing, reviewing and exporting. Imported-file copy does not claim derivation from the accepted design. A verified
optional production record identifies companion slicing, the exact accepted STL,
retained exported-settings bytes, manifest and slicer identity. Its canonical job
digest includes these fields. The client bounds and validates every reference and
requires the settings digest to match the selected settings. Settings identity is
not calibration or physical-fit proof. There is no preparation or dispatch UI.

Discovery explicitly sends `productionVersion=1`. Older companions remain usable:
only an explicit first-page HTTP 400 `invalid-request` permits one retry without
that query. Continuation pages preserve the resulting mode; refresh tries the
current capability again. Authentication, stale state, malformed success responses
and pagination failures never trigger a downgrade. Metadata and download routes
never accept the discovery query.

For an isolated ordinary-app navigation fixture, start the existing loopback
fixture with `SCAN_PREPARED_FIXTURE=1 SCAN_PREPARED_FIXTURE_COUNT=21` after building
the companion. The optional count is bounded to 2–50 and defaults to two. Seed only
a disposable Simulator app's saved-project store with the fixture's exact
`prepared.json` snapshot, pair through the normal invitation screen, and navigate
Your projects → Inspected files. Verify first/second pages, refresh, per-file
inspection, process restart and exported bytes against `prepared/<jobId>/printable.bin`.
Moving one fixture job directory outside `prepared` between pages exercises
cursor-stale recovery. Keep credentials and runtime evidence outside Git.
The native bridge harness also exercises two actual collection pages and strict
query rejection on both process runs.

To replay a retained operator-produced bundle alongside the synthetic imported
files, set `SCAN_PRODUCED_FIXTURE_DIR` to a private directory containing `job.json`,
`source.stl`, `settings.json`, `production.json` and `printable.bin`. The fixture
checks the accepted source identity and reopens the exact bundle through the real
store; it does not rerun slicing or inspection. The native harness accepts the same
directory with `--produced-fixture /private/retained-job`, exercises compatible
collection pagination, reopens every file after process restart and independently
compares exports. Keep those artifacts and credentials outside Git. This replay
proves native consumption of retained evidence, not physical fit or print safety.

### Native scan from a saved project

On iOS, **Project captures → Scan object** starts the existing guided Object
Capture flow. Scanning does not require pairing. After reconstruction, **Add to
this project** explicitly imports the verified USDZ through the existing capture
importer and reopens its retained record. **Keep for later** leaves a local draft;
Project captures lists these drafts after an app relaunch. Files import remains
available on supported iOS versions when the hardware cannot run Object Capture.

The whole iOS app currently requires **iOS 18 or later**, including Files-import
users. This is a pre-release compatibility decision to reuse the sample's
`hideObjectReticle` and `showShotLocations` affordances. Basic Object Capture and
cancellation alone do not require iOS 18. Revisit the whole-app minimum before a
public release; iOS 15–17 are currently excluded.

A native owner retains capture and reconstruction sessions independently of the
React bridge and presentation. Closing, backgrounding, or bridge invalidation
requests cancellation once. New scans remain blocked until a terminal SDK event;
a ten-second diagnostic reports a pending stop without forcing release. Terminal
state is not proof that the physical camera is available to another application.
The standalone sample keeps its original entrypoint and remains separately
buildable. The app compiles its shared engine once, copies the existing tutorial
videos/localization, and generates an asset catalog excluding only the standalone
sample AppIcon to avoid colliding with the app's icon.

Private drafts live in `Documents/NativeCaptures/<UUID>/`: original images,
checkpoints, reconstruction output, diagnostics, and an atomic manifest. The
manifest retains the originating project, exact revision/snapshot, pairing
context (or no pairing), outcome, and completed model identity. JavaScript receives
an opaque run ID and descriptor, not filesystem paths or photographs. A narrow
native adoption method opens every mutable directory without following symlinks,
verifies the ready manifest and fixed USDZ output, and copies verified bytes into
the existing cache. Import remains limited to 32 MiB; larger models stay local.
No original capture files are deleted by stopping, keeping, or importing a scan.

A changed project or pairing refuses the original handoff. **Choose destination**
requires explicit confirmation of the current project version/connection. The
importer rechecks that selected destination across asynchronous work and retains
its existing ETag, identity, and ambiguous-POST safeguards. There is no automatic
upload, destination rebinding, or retry of an uncertain import. Local app storage
is not an encrypted backup; Files access and uninstall behavior are unchanged.
Capturing, conversion, and reopening do not establish dimensional accuracy,
surface completeness, or physical fit.

Focused verification (all generated evidence and fixtures should remain private):

```sh
python3 scripts/native-object-capture-tests/test.py --evidence /private/output/native-lifecycle
python3 scripts/native-capture-fault-tests/test.py --adoption-only \
  --simulator OWNED_SIMULATOR_UUID --evidence /private/output/native-adoption
```

The lifecycle harness compiles production owner/store code and extracts unchanged
model lifecycle method bodies against controllable SDK streams. The adoption
harness compiles the production Objective-C bridge inside a disposable Simulator
app. Neither establishes physical camera behavior. Native capture on a physical
device, actual reconstruction, import/reopen, and camera recovery require a
separate attended acceptance run.
