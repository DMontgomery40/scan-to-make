# Handoff: how to pick up Counterpart work

## Project Settings follow-up — 2026-11-02

`feat/project-settings` is separate from release PR #259. Both clients use one native grouped Form from
CounterpartKit, with thin transport/file adapters. Preferences save immediately in the companion;
`projectPreferences` gates the entry point. No settings control starts printing or a design pass.
Print sheets consume saved defaults and send explicit Standard/one-copy overrides. Duplicate copies
current model/render/editable-design files into an independent ready project and preserves credit/defaults;
source jobs, outcome and pending messages stay out of the copy. Original-file exports validate recorded
membership and canonical containment, including symlink regressions. Mac copy no longer promises
independent iPhone notification switches.

Validation before publishing: 122 CounterpartKit tests, 43 ControlKit tests, 43 Mac model/relay tests;
unsigned Mac and iOS Simulator apps build. Node 22 affected companion checks: 123 passed. Node 24 full
companion suite: 628 passed, 9 intentionally skipped. Linux tests used the existing shared USD Python
environment; no live projects, printers or notification deliveries were mutated. Read-only review found
and verified fixes for muted Live Activity alerts, hidden saved multiple-copy counts on one-copy printers,
and file-export symlink containment. Native settings interaction and physical delivery remain device
acceptance work for the integration owner.

[Apple's ActivityKit push documentation](https://developer.apple.com/documentation/ActivityKit/starting-and-updating-live-activities-with-activitykit-push-notifications)
requires an alert for push-to-start. Muted project events therefore skip remote start, while existing
activities still receive silent updates/end. This does not claim the currently undeployed relay works live.

## Integration snapshot — 2026-11-02, 06:55 MT

Codex owns `feat/integrated-recovery`, PR #259. The competing Claude executors were stopped;
Claude has subsequently been used only with tools disabled. The full 40-item backlog remains open
where device acceptance is missing; see `asks.md`.

**Installed:** `/Applications/Counterpart.app`, signed build `202611020645`, source `3b8ea525`.
Its renamed embedded companion is registered and running. Davica3 has signed phone build
`202611020630` (source `fd9be649`; the later updater change is Mac backend only). The phone remains
locked, so no camera/Face ID, Lock Screen or phone UI acceptance is claimed.

The six projects, seven pairing identities, TLS files, companion configuration, current models and
photos match before/after migration checksums. Evidence lives under
`~/scan-to-make-work/codex-deploy-20261102`. The existing local SSH printer forced command referenced
Node inside the removed `Scan to Make.app`; its runtime path was updated to `Counterpart.app`,
with the existing key/restrictions unchanged. The real P1S is Ready through MCP 1.1.51.
Installed Mac checks passed rename (then restored the original name), search by a follow-up's
“25 inches” text, and Print Again preparation with loaded PLA, 3 h 20 m and 109 g. No print was sent.
Advanced Settings now reports iCloud sync and same-account Mac discovery On. Actual phone enrollment
and notification delivery remain unchecked.

Local workflow evidence: `codex-recovery-checks-3`, `codex-companion-updater-final` (both Node 22/24
pass at `3b8ea525`), `codex-relay-checks`, signed Mac/phone build logs and native regression logs.
Hosted Actions still cannot start because of account billing; there are no required checks.
The latest review found Ask answers claiming photos reserved by queued corrections; a minimal
fix is being prepared before merge. Earlier ordering, terminal cloud state, retry attachment,
foreground activity and updater-deadline findings are fixed and their threads resolved.

The installed batch combines capture intent/error handling, rename/search/ordered reads, queued
corrections, Done classification, conversation/photo ownership, Counterpart identity, Help links,
MCP updates, owned Blender cleanup, enrollment and phone CloudKit/ActivityKit support. Full project
settings, efficient streaming and reconstruction audit are separate follow-ups. Recorded in-hand
reconstruction captured the hand, not the object; both recorded walk-around models have an incomplete
rear. Producing a valid mesh is not scan acceptance. The audit is on `feat/capture-reconstruction-audit`.

The APNs Sandbox key review page is prepared but Register has not been pressed. Confirmation to
create that credential and configure/deploy the Cloudflare relay is pending. The current signed
phone has development APNs entitlement; its relay must use the Sandbox APNs origin.

Old KAN-217 prototypes are retained as `archive/20261102-camera-recovery-prototype` and
`archive/20261102-project-state-prototype` tags. Integrated agent source branches were retired.

## Mobile cloud consumer audit — 2026-11-02

Local Live Activity follow-up: the phone now has `PrintAttributes` matching the relay JSON, a WidgetKit Lock Screen/Dynamic Island extension, foreground print activity creation, timestamped progress/end updates, and token observers. Tokens register with the authenticated companion and as a private `CounterpartDevice` snapshot. Ended-token removals survive relaunch; user-dismissed activities are not recreated; a remote/local start race keeps one activity. Pairing changes cannot send the old activity tokens to a new Mac. CloudKit project changes update existing activities during system-granted background runtime only. When updates stop, the activity becomes stale after five minutes and says it is waiting. The relay is still off/unprovisioned; independent remote start/continuous updates are not claimed.

Validation for this follow-up: CounterpartKit 104 tests passed; unsigned simulator and generic-device app + both extensions built. Tests cover the relay's Date epoch and keys, terminal project state overriding an old printer report, foreground/dismissal rules, token registration/removal payloads and invalid token rejection. Root reviewed token/pairing lifecycle. Physical Lock Screen display and remote delivery remain acceptance checks for the integration owner. Development APNs tokens require `APNS_ORIGIN=https://api.sandbox.push.apple.com` at the relay; the default Worker origin is production.

The phone now discovers `CounterpartMac` records on the same Apple Account and enrolls through the pinned `/v1/pair/icloud` contract. One Mac connects automatically; multiple Macs require a choice; code pairing remains available without opening the camera during discovery. The companion enrollment backend is a separate integration dependency (reviewed original `ba08c9b2`).

Added CloudKit alert subscriptions, launch/tap routing, and a notification service extension that fetches event text and camera-frame assets. This is code/build coverage, **not observed delivery**. The device and extension still need valid CloudKit provisioning; `CounterpartEvent.type` must be Queryable in the development schema. Production schema deployment remains separate. Unsigned simulator/fixture runs do not access CloudKit.

CloudKit query alerts are shared across a user's devices. An existing false phone preference pauses shared alerts; unknown preferences never create subscriptions. Temporary Mac unreachability leaves established subscriptions unchanged. Saved preferences are preserved, and unsupported individual phone toggles are disabled with an explanation. Correct extension suppression requires Apple's restricted `com.apple.developer.usernotifications.filtering` approval, or a different delivery path. The system notification switch and Mac milestone frequency remain usable. Background command actions, offline mirrored-project screens, and per-device filtering are not complete.

Validation: CounterpartKit 101 tests passed (enrollment pin, expiry, stable identity, fallback, no working-pair replacement; subscription category coverage and opt-out safety). Unsigned generic device and simulator app/notification-extension builds succeeded. These checks do not prove actual iCloud enrollment, alert delivery to phone/Watch, or model scan quality.

Live Activity code was absent, rather than merely waiting on deployment. The relay Worker is not present in the configured Cloudflare account, and no local APNs `.p8` was found in the bounded home search. No credentials were printed or changed. Apple's current ActivityKit docs support local updates during available background runtime; APNs remains necessary for independent remote delivery.

Sources: [CloudKit query subscriptions](https://developer.apple.com/documentation/cloudkit/ckquerysubscription), [notification filtering entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.usernotifications.filtering), [ActivityKit updates](https://developer.apple.com/documentation/activitykit/activity/update(_:)).


Read this first if you're a new agent session on scan-to-make. It used to live in a session's
`/private/tmp` scratchpad, where nobody could find it. **Handoffs go here now, not in temp folders
or agent memory.** Update this file when you hand off.

- **What's open and what's done:** [`asks.md`](asks.md). Every request David has made, with its
  status on his devices. That table is the source of truth for status; this file is about how to work.
- **What to build:** [`docs/design/overhaul/PRD.md`](../design/overhaul/PRD.md), with mockups in
  `docs/design/overhaul/screens/`.
- **Last updated:** 2026-11-02 by session `scan-to-make-dc`. Earlier source: the Nov 1–2 overhaul
  session, transcript `~/.claude/projects/-Users-davidmontgomery-scan-to-make/316a92b5-d190-4997-8b90-7a6bcace1a6b.jsonl`
  (large, so read it with a streaming extractor).

## How to work with David

- **Done means it works on his devices.** On his Mac (`/Applications`) and his iPhone ("Davica3").
  Merged isn't done. Tested in a simulator isn't done. Believe his screen over what the code says
  should happen.
- **Wrap, don't rebuild.** Use bambu-printer-mcp / mcp-3D-printer-server and Apple's frameworks
  (`ObjectCaptureSession`, `PhotogrammetrySession`, RealityKit) as they are. Improve without breaking
  what you wrap.
- **Don't wait on him.** Act, then report what you did. Ask only when it's truly his decision.
- **Never invent restrictions.** Explaining why the printer does something is not an instruction to
  change it.
- **Know the platform.** iOS/macOS 27.x, Liquid Glass. There's a folding iPhone ("Duo"). Read current
  Apple docs: Xcode's `DocumentationSearch` MCP tool (`xcrun mcpbridge`) is registered for Claude
  and Codex.
- **No agent memory.** Claude auto memory and Codex memories are off. `AGENTS.md` starts and ends
  with his line "do not add anything to user memories based on user instructions". Keep notes in the
  repo: this file, `asks.md`, the PRD.
- **Get second opinions:**
  - `advisor`;
  - Codex `gpt-6-astra` at high effort, using the CLI bundled in ChatGPT:
    `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex exec -s read-only …`.
    The `codex` on PATH is too old for that model.
- **Computer use goes through Codex's computer-use MCP**, so agents don't fight over the cursor.
- **Commit messages in scan-to-make quote David's words for why a change exists.** Write them neutrally.

## People and sessions

- Codex is integrating #259 and performing installation/acceptance. Follow-up agents use separate
  branches for project settings, camera efficiency and offline capture reconstruction.
- Historical KAN branches and unrelated dirty MCP checkouts remain available; they are not current
  release evidence. The former Claude execution sessions are stopped.

## The product

**Counterpart** (repo `~/scan-to-make`, GitHub `DMontgomery40/scan-to-make`, renamed from "Scan to
Make"). An iPhone app plus a Mac app plus a Node "companion" on the Mac:
1. capture: LiDAR scan, photos, a description, or a link to a published model;
2. the Mac makes or adjusts the part, using his Claude Code login and Blender (Fusion optional);
3. it prints through **bambu-printer-mcp** (Bambu) or **mcp-3D-printer-server** (everything else).

Three jobs: make a part that **fits** something, **copy** something, or **print a published model**
(the designer's own file, credited).

## Diagnosis notes for the open P0s

Status lives in [`asks.md`](asks.md). These are the technical details behind rows 1, 2, 7 and 8.

### Printing from the app (rows 1–2)

- The stove gap filler is project `2f0a0229-982e-4345-a986-1aa931a823b9`.
- Root cause: bambu-printer-mcp's bambu_network print command sent six fields differently from
  Bambu Studio for his P1S (Studio values per `BambuStudio.conf` `C12` and `SelectMachine.cpp`):

  | Field | Studio | MCP sent |
  |---|---|---|
  | `auto_bed_leveling` | 1 | 0 |
  | `task_flow_cali` | false | true |
  | `auto_flow_cali` | 2 | 0 |
  | `task_vibration_cali` | false | true |
  | `task_layer_inspect` | true | false |
  | `auto_offset_cali` | 2 | 0 |

- The failure was HMS `0300_0D00_0002_0001`, "Heatbed homing abnormal", during auto bed leveling.
  His prints from Studio worked. The cause was our command, not his printer.
- KAN-215 fixes it: match Studio exactly, make `cancel_print` really stop the printer (it reported
  "Stop sent" while the printer kept going), and add the P1S HMS table.
- **Done = he presses Print in the app and the part prints.** No control-socket or MCP side doors.
  Never answer the printer's confirmation on his behalf to make a test pass.
- Also queued (KAN-214): read the nozzle type and plate from the printer instead of the guessed
  `printer-handoff.json` selection (`textured_plate`, `hardened_steel`), and stop using an X1C
  process profile on the P1S.

### The phone camera (row 8)

State at 2026-11-02 04:35 MT: **the camera works with Counterpart installed and running.** Facts are in
[`camera-incident-2026-11-02.md`](camera-incident-2026-11-02.md); this is what to do next.

- **Symptoms David saw:** a black viewfinder, then stills that came out flat green (R=0, G≈93, B≈9:
  zero-filled frames, with auto-exposure running at 1/40 s ISO 1000), then black stills with no
  exposure data at all (exposure 0, ISO 0). Every lens was affected, and it survived reboots.
- **Cause 1, found and removed:** Xcode's DeviceHub (`/Applications/Xcode.app/Contents/Applications/DeviceHub.app`,
  the Devices window's live device view) held an AVConference link to Davica3 from at least Nov 1 20:36 and
  reconnected after every reboot. While it's connected iOS blackens every camera frame
  (`setBlackenFramesForContinuityDisplayConnected`). Quit at 04:19 with David's approval; the next photo
  (IMG_2133) was real.
- **Cause 2, the same mechanism:** XCTest's automatic screen recording did the same during the 03:47 test run.
- **Not explained:** the green photos (Nov 2, 02:08–02:11; no camera-daemon logs survive for that window),
  and David's report that the problem started about two weeks ago. Xcode's Devices window and iPhone Mirroring
  were first used heavily on Oct 14 (knowledgeC), but the unified log only goes back to Nov 1 20:49.
- **Matching public report:** Apple Community thread 256189919, iPhone 17 Pro Max on iOS 26.1+, with a blank
  camera on front and back, fixed by a restart, recurring every few days. Reported fixes are toggling
  Settings → Camera → "Lock Screen Swipe to Open Camera" plus a restart; Apple Diagnostics found sensor faults
  for some; one person did a restore as a new phone. iOS 27.2 also tightened CoreMedia camera access
  (CVE-2026-86990); no side effects have been reported.
- **Acceptance that passed** (04:29–04:32, Debug build-for-testing of main `ae2da73` plus the test
  `apps/mobile/ios/ScanToMakeUITests/DeviceCameraAcceptanceUITests.swift`, run by
  `~/scan-to-make-work/kan217/lead-run-all.sh`). After each step the test takes a Camera photo, pulls it over
  AFC, and checks it with `photostat.swift`:
  - step 0, app idle: IMG_2135, 1/40 s, mean RGB 164/133/105;
  - step 1, walk-around 15 s then Stop: IMG_2136, real image;
  - step 2, walk-around then Home and kill: real image.

  Object Capture went from running to ready. "No depth map" appears only in the first ~5 s, until the LiDAR's
  first frame.
- **In progress (KAN-217):** handle camera interruptions in every capture path. Restart once, then show
  "Camera unavailable", never a black view. Use `isMultitaskingCameraAccessEnabled` with the Multitasking
  Camera Access capability where our own `AVCaptureSession` allows it.
- **Seeing the phone without asking David:** `xcrun devicectl device capture screenshot`, the iPhone
  Mirroring window (which can be captured while a session is connected), photos over
  `pymobiledevice3 afc`, and the live log with `pymobiledevice3 syslog live`.
- The old LiDAR sync-pulse bug (fixed in `8a5b1c1`, #231) and its log markers (`SetExternalSyncFrameRateRational`,
  `-12684`) still apply when hand-setting device formats. Face ID logs MSG 0/1 and `targetFNumber` asserts on
  healthy boots too, so neither is a diagnosis by itself.

### Scanning (row 7)

Nov 2 capture audit (`feat/capture-recovery`; device acceptance still required):
- A later stopped attempt hid an older ready scan in `finishedScan` and `localScan`; both now select
  a ready capture for the project. `scan` now honors **Keep for later** instead of returning that run
  as an immediate-send request. Terminal capture failures reach the capture screen's error display.
- The pairing QR scanner now surfaces VisionKit startup and interruption failures, with **Try Camera
  Again** creating a fresh controller. Dismissed/background scanners cannot deliver a stale failure.
  No camera entitlement was added, and no automatic phone restart is suggested.
- Host capture checks exercise production lifecycle, selection and QR methods against controlled
  platform boundaries. These checks do not establish physical camera health or an end-to-end upload.
- The backed-up native capture `ce42012e-ed16-4f6f-9268-5c9f9ac7bb8b` completed on **Oct 31, 05:48Z**
  (iPhone18,2, iOS 27.2): 117 images, three passes/two flips, a 7,088,924-byte USDZ matching its
  manifest SHA-256. It logged `stitchingIncomplete`; completeness/fit remain unverified. This is older
  phone reconstruction evidence, not proof that the current app sends it to the Mac successfully.

- **Walk-around** is Apple's `ObjectCaptureSession` with the GuidedCapture sample's view. On Davica3 it reaches
  "ready" with LiDAR depth. The flip pass (`beginNewScanPassAfterFlip()`) is already in the sample flow.
  Upload → companion → model on the Mac is being proven with David's real capture from the phone backup
  (`~/scan-to-make-work/davica3-counterpart-backup-20261102-0401/Documents/NativeCaptures/`).
- **In-hand is off** (`HandheldCapture.offered = false`). A stills test with `PhotogrammetrySession` failed:
  Apple's masking kept the hand; a Vision person mask removed the held object along with the hand.
  Don't rebuild custom segmentation; use the flip pass instead.
- Project `485defc7` is an in-hand capture that stayed on the phone. It's in the backup above, under
  `HandheldCaptures/`. It was never deleted.

## Infrastructure

- **One iOS build or test on the Mac at a time** (#224). Every macos/xcode job in
  `scripts/ci_local.py` holds `~/.stm-ios.lock`. Wrap anything else with
  `python3 scripts/ci_local.py --ios-lock <cmd>` or `/usr/bin/lockf -k ~/.stm-ios.lock <cmd>`.
- **Linux boxes** `agents-136`, `agents-173`, `agents-171` (SSH aliases work from the Mac):
  - `ci_local.py` sends ubuntu jobs to them in parallel and skips dead hosts (#226);
  - `ssh agents-136 stm-ci <branch|sha>` tests an exact pushed commit in a throwaway worktree;
  - toolchains in `~/.cache/stm-ci`, paths in `~/.config/scan-to-make/ci-local.env`;
  - no iOS Simulator or Xcode on Linux.
- **Auto-sync of main:** cron on the boxes and the LaunchAgent `com.dmontgomery.stm-sync` on the Mac
  fast-forward `~/scan-to-make` main every 2 minutes. Fast-forward only.
- **The merge gate** (#227, #228): `python3 scripts/branch_check.py --merge <branch>` before every
  merge. Delete branches and worktrees only after GitHub shows MERGED.
- **Mac deploy:** `~/scan-to-make-work/kan220-tools/deploy-release.sh <ref>` (Release, `+CloudKit`,
  receipts).
- **Phone install**, Davica3 UDID `00008150-001A488C3642401C`:
  ```
  python3 scripts/ci_local.py --ios-lock xcodebuild -project apps/mobile/ios/ScanToMake.xcodeproj \
    -scheme ScanToMake -configuration Release -destination 'generic/platform=iOS' \
    -derivedDataPath <dd> -allowProvisioningUpdates build
  xcrun devicectl device install app --device 00008150-001A488C3642401C <dd>/Build/Products/Release-iphoneos/ScanToMake.app
  ```
- **Companion control socket:** `~/Library/Application Support/Scan to Make/auth/control.sock`.
  Newline-delimited JSON, `{v:1,id,method,params}`; methods in
  `services/companion/src/local-control-protocol.ts`. Read-only use for diagnosis is fine. **Never use
  it to stand in for the app** in a test of the app.
- **Events:** `~/Library/Application Support/Scan to Make/events.ndjson`.
- **Projects:** `~/Library/Application Support/Scan to Make/capture/objects/<id>/object.json`.
- **Website:** `site/`, deployed with `cd site && npx wrangler@4 deploy`. Check it from agents-136;
  the Mac's resolver gives wrong answers for `counterpart.dtmont.com`. The Live Activity relay
  (`services/relay`) needs his APNs `.p8` secrets (see its README).

## The printer MCP repos

- `~/bambu-printer-mcp` (npm `bambu-printer-mcp`) and `~/mcp-3D-printer-server`.
- **Their AGENTS.md rules:**
  - no AI attribution anywhere in git or GitHub: no Co-Authored-By, no "Generated with", no session
    links;
  - every merge to main is an npm patch release: CHANGELOG, `npm version patch`, tag, GitHub Release,
    verified npm and Pages.
- **Planned camera stream:** contract in `docs/CAMERA-STREAM.md` in both repos and PRD §8.6.1. One
  camera connection per printer, only while someone watches; change-only frames. A parked, unbuilt
  local commit `3bf7f90` is in `~/stm-wt/bambu-camstream`. It resumes after the KAN-215 release.

## Mistakes earlier sessions made

- Reported intended behaviour from the code as what happened on his screen.
- Started a print through the control socket and answered the confirmation itself, which proved
  nothing about the app.
- Told him to service his printer when the cause was our command.
- Wrote memory files that then steered behaviour. Memory is now off.
- Deleted a branch before the merge went through, which closed a PR.
- Specced Home with a large "Counterpart" title, which read like a part name (fixed in #233).
- Added an over-broad "we only slice and send" rule that would have blocked legitimate settings like
  temperature. Removed.
- Left the handoff in a `/private/tmp` scratchpad instead of the repo.
