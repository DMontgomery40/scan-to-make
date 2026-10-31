# Scan to Make: mobile app

React Native 0.87 (TypeScript, Hermes, New Architecture) app for iPhone and iPad. You create a project for an object, scan it with guided LiDAR Object Capture, send the scan to your companion for conversion and cleanup, review the results against the object's real size, and attach close-up photos of details. Android builds, but capture is unavailable there.

## Layout

| Path | What it is |
| --- | --- |
| `App.tsx`, `src/screens/` | Home, projects, project captures, scan results, close-ups, companion and About screens |
| `src/ui/` | Shared screen shell, controls and theme; safe-area and adaptive layout (see [docs/platform-readiness.md](docs/platform-readiness.md)) |
| `src/project/savedProjects.ts` | Portable saved projects on the native storage module |
| `src/capture/` | Retained captures, companion project sync and native Object Capture handoff |
| `src/stills/`, `src/processing/` | Detail-still and scan-processing clients |
| `src/companion/pairing.ts` | Companion pairing client |
| `modules/object-capture/` | Guided Object Capture engine, embedded from Apple's sample |
| `modules/local-project-storage/` | Native storage, pairing, capture, stills and processing bridges |

## Checks (Linux or macOS)

```sh
npm install        # postinstall also runs `npm ci` and builds ../../packages/contracts
npm run typecheck
npm run lint
npm test
```

`@scan-to-make/contracts` is linked with a `file:` dependency. Metro watches `packages/contracts` and resolves Babel helpers from this app's `node_modules`. Jest maps the package to its built `dist/`. Babel adds `@babel/plugin-transform-export-namespace-from` for zod 4's ESM build.

## iOS build

The app requires **iOS 27** and runs on iPhone and iPad. Object Capture needs a device with LiDAR. Use a current Ruby (verified with Ruby 3.2.9 and Bundler 2.7.1), Node 22.11 or newer, and full Xcode. If `xcode-select -p` points to CommandLineTools, set `DEVELOPER_DIR` to your Xcode installation, for example `/Applications/Xcode.app/Contents/Developer`.

```sh
npm ci
bundle install
cd ios && bundle exec pod install && cd ..
npm run ios -- --mode Release --device
```

Release bundles JavaScript, so it does not need Metro running.

The app target signs automatically as `com.scantomake` with team `X7F5F9LR24`. To sign with your own Apple account, set your team and a bundle ID you own on the ScanToMake target (Signing & Capabilities in Xcode). Passing `PRODUCT_BUNDLE_IDENTIFIER` to `xcodebuild` also renames the Pods resource bundles, so set it on the target instead.

## Android local build and persistence check

Use an already provisioned Android SDK and JDK 17 (the React Native Gradle
plugin requests a Java 17 toolchain). The repository does not pin a JDK 21
runtime. The current scaffold requests
SDK platform 37, Build Tools 37.0.0 and NDK 27.1.12297006. Set `ANDROID_HOME` to
that SDK directory; keep local SDK paths and license state outside Git. The
Gradle wrapper pins Gradle 9.4.1. SDK installation and license acceptance are
separate environment setup, not something the build instructions automate.

From this directory, after installing dependencies:

```sh
cd android
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
```

Use the ABI matching the selected emulator (`arm64-v8a` on an Apple Silicon
emulator, or `x86_64` for an x86 emulator). The APK is
`android/app/build/outputs/apk/release/app-release.apk`, relative to this mobile
app directory. This local Release variant bundles JavaScript and uses the
repository's development signing key; it is not a production distribution.

With an explicitly selected, already running emulator, install the APK and
launch `com.scantomake/.MainActivity`. Record the emulator serial, Android API
and ABI with the build head and APK hash. In the app, create a synthetic project with a
distinctive name. Force-stop `com.scantomake`, launch it again, and check that the
project is still listed. Do not clear app data or uninstall between restarts.
This proves local project retention; it does not prove capture.

Android capture, companion pairing and mesh viewing are unavailable.

## Known gaps

- Physical-device capture, conversion and cleanup over a live private tailnet have not yet been recorded end to end.
- Local projects are device-local and unencrypted; uninstalling the app removes them. No cloud sync, account, backup or cross-device recovery is implemented.
- Sending a cleaned mesh to bambu-printer-mcp or mcp-3D-printer-server is not built. Scan results can share the repaired STL.

## Consumer flow

Home → **Your projects**. Name a new project (**What are you scanning?**) and the app opens its **Project captures**. **Scan object** starts guided Object Capture; a USDZ from Files can be imported instead. After the companion converts a capture, **See scan results** runs the companion's cleanup and measurement, compares the result with the object's real size, and can open or share the repaired mesh. **Add close-up photos** attaches detail stills to that capture.

Projects saved by earlier app versions keep their stored data and open into their captures.

## Local saved projects

`src/project/savedProjects.ts` adapts `@scan-to-make/contracts/saved-project` to the standalone `modules/local-project-storage` native module. A new project stores its name; fit data written by earlier app versions is kept unchanged.

The iOS and Android adapters use platform SQLite, one complete UTF-8 BLOB per project, parameterized statements and a write transaction. Exact-byte comparison and replacement occur under SQLite locking across connections/processes using the same database. There is no JS-only get/set race or memory fallback. FULL synchronous commits precede successful resolution. Normal process termination/relaunch is verified on iOS Simulator; power-loss durability on physical devices is not claimed. Writes bypassing SQLite, filesystem corruption and external file replacement are outside the concurrency guarantee.

The library loads before editing, reports corrupt/future entries individually, and preserves their bytes. A failed create keeps the typed name. Storage errors may have uncertain outcomes; check the project list before retrying.

Verification: `npm run typecheck`, `npm run lint`, `npm test -- --runInBand`, and on macOS `python3 scripts/native-storage-tests/test.py`. The native test compiles the production iOS storage methods with a minimal React promise bridge stub; it exercises separate native processes and eight competing writers against an isolated temporary SQLite database. It is host-native evidence, distinct from the app's simulator restart walkthrough. Android compilation requires an installed Android SDK and is not established by the iOS checks.

## Companion pairing (iOS)

Open **Connect your companion** on Home or **Connect companion** from a
project's captures. The connection screen overlays the current screen. It offers existing-Tailscale and first-time setup guidance;
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

Health and capture requests read the exact stored origin and send both
Bearer authentication and X-Scan-Device. URLs cannot contain userinfo, paths,
queries, fragments or custom ports. Normal HTTPS certificate validation remains
enabled; redirects are refused and credentials never follow artifact URLs.
Native bounded receive limits still apply before JSON parsing. Re-pairing or
disconnecting cancels an active request; a changed credential also rejects a
late response. Rejected/revoked credentials never fall back to anonymous HTTP.
Network, certificate, denial, expiry and secure-storage errors have distinct
recovery guidance. Disconnect erases this device's Keychain item; host-side
revocation remains a separate companion-operator action. Neither changes a
saved project. Android pairing remains unavailable.

### Isolated Simulator fixture

After building `services/project` and `services/companion`, run from repo root:

```sh
node apps/mobile/scripts/pairing-fixture/server.mjs
```

The fixture binds only `127.0.0.1:9078`, forwards to a real isolated authenticated
companion server, and uses a synthetic allowlisted identity. Its printed path
points to a private temporary directory containing the invitation and test mode;
credentials are never printed. Paste `invitation.json` into the app. `SIGUSR1`
creates a fresh invitation; `SIGUSR2` revokes the fixture's devices. Set the
private `mode` file to `offline`, `redirect`, `forbidden` or `ok` to exercise
recovery. Stop the fixture after testing and remove its private directory.

Only Simulator builds accept the fixed HTTP fixture origin. They also accept
`https://127.0.0.1:9079` for an isolated untrusted-certificate failure test;
certificate validation is never bypassed. These origins are rejected in device
builds. Local fixture evidence is not
physical-phone/Tailscale/HTTPS success evidence.

Checks: `npm run typecheck`, `npm run lint`, `npm test -- --runInBand`, and
`python3 scripts/native-pairing-tests/test.py` on macOS. Native seam tests compile
production validation/metadata/disconnect code with a Keychain API double;
actual secure persistence requires the Simulator restart walkthrough. No tokens
or invitations should be included in screenshots, test output or public reports.

### Retained project captures on iOS

Open **Your projects → Open scans**. Connect with a capture-scoped
companion invitation, synchronize the saved project, then choose a USDZ file
(up to 32 MiB) from Files. Import retains the original, converted OBJ and
conversion report. Reopen verifies the current project revision and retained
bundle before review. **Review converted mesh** renders the verified OBJ with
native camera controls. Quick Look opens the original USDZ where the platform
supports it; Simulator may display file metadata only. Export uses the native
share sheet and exact verified bytes, without converting formats.

Full portable SavedProject 0.2 snapshots are synchronized, including any
legacy fit data, unchanged. Companion acknowledgments and capture handles live separately in
Application Support/CaptureSync, namespaced by companion origin and project.
A replacement pairing at the same origin keeps those handles; every request
is pinned to the exact current pairing. Credentials remain in Keychain and
never cross into JavaScript. Local edits made during a request are preserved.
Conflicts stop synchronization and leave the local project available to review.
Editing a project makes prior captures unavailable for current-version use;
historical bytes remain retained. Captures do not establish dimensional accuracy, completeness or physical fit.

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

### Native scan from a saved project

On iOS, **Project captures → Scan object** starts the existing guided Object
Capture flow. Scanning does not require pairing. After reconstruction, **Add to
this project** explicitly imports the verified USDZ through the existing capture
importer and reopens its retained record. **Keep for later** leaves a local draft;
Project captures lists these drafts after an app relaunch. Files import remains
available on supported iOS versions when the hardware cannot run Object Capture.

The whole iOS app requires **iOS 27**, including Files-import users. Every target
device runs iOS 27, and the capture engine uses Object Capture APIs that iOS 26
lacks (`ObjectCaptureSession.isAutoCaptureEnabled`).

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
