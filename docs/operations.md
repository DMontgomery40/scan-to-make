# Operating Counterpart

How to change, gate, build, install and drive Counterpart. What is built and accepted is in the [working PRD](design/overhaul/PRD.md); who owns what and what's installed is in [`status/handoff.md`](status/handoff.md).

## David's rules

- **Acceptance is David pressing real buttons in the real installed app** (Mac or iPhone) driving the real printer, judged by the printer's own reports. Unit tests, scripts, direct MCP calls, the control socket, ssh and Studio/Handy are engineering checks only. Never stop, pause or resume the printer outside Counterpart's UI to make a test pass. Never restart FULU/Colima or repair state to manufacture a result. Use the published MCP packages users receive through Download/Update; hand-copied builds don't count as release acceptance.
- **No autonomous prints or reprints.** David, Nov 4: "do not reprint anything on your own EVER." David starts every physical print. "Plate clear" is only a status.
- **The printer MCPs are the backend.** A button is one MCP tool call. A bug in an MCP is fixed once, in the MCP, and in both MCPs (bambu-printer-mcp and mcp-3D-printer-server) when it applies to both. No parallel backends or copies of MCP state. Download/Update follows npm latest, independently of app releases.
- **Don't invent rules or "improvements".** Change what was asked; when he has decided, don't re-ask. (Removing the FULU control's 5-second hold made him furious; it stays.)
- **Just works:** auto-detect, dropdowns, smart-filled `.env`; advanced users can still edit files.
- **Watch the app yourself** (accessibility dump, `events.ndjson`, `object.json`, `control-trace.log`); never make him screenshot it. Don't end a turn while something you started is in flight.
- **Device Hub, mirroring and devicectl are allowed.** David: "i didn't mean never use device hub again, i meant be careful and aware of it's issues borking the camera". A connected Continuity display blacks out camera/LiDAR frames: [`status/camera-incident-2026-11-02.md`](status/camera-incident-2026-11-02.md).
- **Before replacing the Mac app or restarting the companion,** check through the app that nothing is printing or working, and keep a rollback.
- **Never take David's screen.** David, Nov 6: "use t3 connect not ssh, why am i seeing teminal pop up and stealing my cursor". No Terminal windows, `.command` files, `osascript ... activate`, or anything that brings an app forward; open apps with `open -g`. Never press a Counterpart control that opens a window or sheet (Print, Print Again…, Settings, Update, Move…) for checks or screenshots: read state through AX, the companion socket and project files, and capture only windows already on screen. Mac work that needs the Mac's own permissions runs in the Mac's T3 environment or as a headless gui/501 LaunchAgent.
- **Printing beats gating.** One simulator gate at a time under `~/.stm-ios.lock`, never while a print is starting; shut down your simulators after. (Nov 6: parallel agent gates pushed the Mac to load 300 and broke a print start.)
- **Core actions need end-to-end tests.** A change to Print, Update, Move, plate selection, Add printer or Send ships with a test that presses the control and checks the companion call and the visible result, on every layout it touches. After every Mac install, check read-only that Settings → Printers lists every MCP within seconds and a real `objects.estimate` answers.
- **Read Bambu Studio's source, don't guess** (`~/refs/BambuStudio`, v02.08.02.61, on the Mac and agents-136). Cite file:line for 3MF, CLI, G-code or AMS behaviour. Studio is AGPL-3.0 and the MCPs GPL-2.0: reimplement behaviour, never paste code.
- No user or agent memories (AGENTS.md). Push after every feature. Clean up the worktrees, branches, caches and containers you create. iOS/macOS 27, Liquid Glass; read current Apple docs and use Apple's frameworks.

## Changing code: one trunk

- `main` is the only trunk. Branch from main, open a PR to main, and merge it once the gate passes. Feature branches never ship.
- **Gate:** `CI_LOCAL_LINUX_HOSTS=agents-171 /usr/local/bin/python3 scripts/ci_local.py all --changed-only --base origin/main` on the Mac (Ubuntu jobs go to agents-171; never agents-173). Hosted Actions have no runner. Then `python3 scripts/branch_check.py --merge <branch>` must print SAFE (read it, don't chain it). It includes the Jev boundary check (PRD §8.0). Use one gate at a time per checkout.
- **Builds refuse non-main or dirty source** (`scripts/trunk_guard.sh`; the list is in [`../scripts/README.md`](../scripts/README.md)). `STM_TRUNK_OVERRIDE="<why>"` is logged and for local debugging only; never install that build for David.
- **Attribution:** Counterpart commits carry the authoring model's `Co-Authored-By` line. Both MCP repos prohibit AI attribution and have their own review conventions; read each AGENTS.md. In the MCP repos merging publishes to npm.
- `~/scan-to-make` on each machine tracks main and fast-forwards every 2 minutes. `ssh agents-136 stm-ci <ref>` tests a pushed commit on Linux.

## Building and installing

- **Mac:** from a clean main checkout, `bash apps/mac/scripts/prepare-payload.sh` (it archives HEAD; a Release build refuses a payload from another commit), then
  `xcodebuild -project apps/mac/ScanToMake.xcodeproj -scheme ScanToMake -configuration Release -destination 'generic/platform=macOS' -derivedDataPath <out> CURRENT_PROJECT_VERSION=<yyyymmddhhmm> STM_ENTITLEMENTS_SUFFIX=+CloudKit -allowProvisioningUpdates build` under `/usr/bin/lockf -k ~/.stm-ios.lock`. Over ssh, codesign fails (`errSecInternalComponent`): run the build as a one-off LaunchAgent in `gui/$(id -u)`. Grep the built payload for your change. Install: check the app is idle, close open sheets, quit, back up the old app, `ditto` to `/Applications`, `launchctl kickstart -k gui/$(id -u)/com.scantomake.mac.companion`, open, and log it in a receipt folder. Developer ID releases: `apps/mac/scripts/release.sh` ([`distribution.md`](distribution.md)).
- **iPhone:** `apps/mobile/scripts/install-iphone.sh` (Release, development signing, USB install without uninstalling; receipts outside the checkout). TestFlight: `apps/mobile/scripts/prepare-testflight.sh`.
- **Printer MCPs:** publish the reviewed package, then use Counterpart's own Download/Update while idle and verify the app runs that version. Never hand-copy `dist`.
- **Mac disk during gates:** each ci_local run leaves a 0.7–1.8 GB `stm-ci-local-*` folder in `$TMPDIR`, and Time Machine's local snapshots keep deleted files until thinned. The LaunchAgent `com.scantomake.gate-temp-cleanup` (`~/scan-to-make-work/maintenance/gate-temp-cleanup.sh`, every 30 min) deletes idle gate folders older than 90 min and thins snapshots under 20 GiB free. By hand: `tmutil thinlocalsnapshots / 40000000000 4`.
- **Site:** a Cloudflare Worker; it does not deploy on merge. From a clean main checkout on the Mac (it has the wrangler login): `npx wrangler@4 deploy --config site/wrangler.jsonc`, then check the live URL.
- **Linux:** `apps/linux/scripts/bundle.sh` on Ubuntu 26.04 x86_64. **Android:** `./gradlew assembleDebug` in `android/` (agents-173 has the SDK).

## Driving the apps

- **Mac:** read the app through accessibility (AX) without activating it; a Settings window may be window 1. Don't press controls or send keys in David's app (see David's rules); acceptance presses are David's. Many SwiftUI buttons have no accessible name: find them by size.
- **Phone:** `xcrun devicectl device capture screenshot --device 00008150-001A488C3642401C --destination <png>`; `devicectl device process launch` to launch.
- **Files:** events `~/Library/Application Support/Scan to Make/events.ndjson`; projects `…/capture/objects/<id>/object.json`; printers `…/printers/profiles.json`; FULU control trace `~/.config/bambu-printer-mcp/bambu-network/control-trace.log`; companion control socket `…/auth/control.sock` (read-only diagnosis; never stand in for the app).
- **zsh on the Mac:** don't `echo =====`; quote globs like `--include='*.ts'`.
- **Second opinions:** Codex through the CLI inside ChatGPT.app (`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex exec -s read-only …`).

Evidence and receipts live in `~/scan-to-make-work/` on the Mac.
