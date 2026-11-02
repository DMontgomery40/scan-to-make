# Handoff: how to pick up Counterpart work

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

- **The lead** is a Claude Desktop session named `scan-to-make-0d` (reach it with SendMessage). It
  owns integration and the builder seats:
  - **KAN-214:** companion, `services/`, `packages/`;
  - **KAN-217:** iPhone app;
  - **KAN-220:** Mac app;
  - **KAN-215:** bambu-printer-mcp.
- Ask the lead what to own. Don't write into another seat's worktree or branch.
- **Codex sessions** also work on these repos; their uncommitted changes sit in the MCP repos' main
  checkouts and in `~/.codex/worktrees/`. Don't touch those; use your own worktree.

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

- Symptom: black viewfinder; stills came out solid green, then black. Restarting the phone clears it.
- The first camera bug (fixed in `8a5b1c1`, #231) was hand-set frame durations on the LiDAR device.
  That set the LiDAR sync pulse ("MSG") to 0/1 and wedged the camera system until reboot. It came
  back after that fix; #246 then turned Scan in hand off and ended capture when the app leaves the
  screen.
- To diagnose, capture a syslog after a reboot with
  `~/Library/Python/3.12/bin/pymobiledevice3 syslog live`, reproduce, and look for:
  - our `captureSession_StartRunning` / `StopRunning`;
  - `SetExternalSyncFrameRateRational`;
  - `Cannot change the external pulse rate`;
  - `-12684`;
  - `-12681` after our last stop. Face ID errors (`-12681`) *while our session runs* are normal.
- Check script: `apps/mobile/ios/scripts/check-lidar-sync.py`.
- Acceptance on Davica3: reboot, open and close the scanner, then the Camera app and Face ID work.
- **UI tests and the camera** (`docs/status/camera-incident-2026-11-02.md`): XCTest's screen recording makes
  the phone blacken every camera frame (`The continuity display is connected. Will start blackening
  frames.`). Turn it off (`DisableDiagnosticScreenRecordings`) for any UI test run on the phone, and grep the
  device log for `blackening` before trusting any frame.

### Scanning (row 7)

- Walk-around uses Apple's `ObjectCaptureSession`. Whether it reaches a finished model end to end
  is unverified.
- In-hand has never produced a model. It uses a hand-rolled `AVCaptureSession` RGB+LiDAR recorder
  (`HandheldCapture.swift`, `HandheldDepthRecorder.swift`) and a custom Mac pipeline
  (`tools/mac-reconstruct samples`, Vision hand masks in `HandheldKit/ObjectMasker.swift`).
- **Order:** prove a walk-around scan becomes a model on his Mac first, then move in-hand onto
  Apple's `PhotogrammetrySession` with `isObjectMaskingEnabled` (Codex's opinion is in `asks.md`).
- His failed in-hand project `485defc7` vanished from disk: not in the Trash, the events log or
  backups. Unresolved.

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
