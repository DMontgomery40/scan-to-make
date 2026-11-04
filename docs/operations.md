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
- No user or agent memories (AGENTS.md). Push after every feature. Clean up the worktrees, branches, caches and containers you create. iOS/macOS 27, Liquid Glass; read current Apple docs and use Apple's frameworks.

## Changing code: one trunk

- `main` is the only trunk. Branch from main, open a PR to main, and merge it once the gate passes. Feature branches never ship.
- **Gate:** `CI_LOCAL_LINUX_HOSTS=agents-171 /usr/local/bin/python3 scripts/ci_local.py all --changed-only --base origin/main` on the Mac (Ubuntu jobs go to agents-171; never agents-173). Hosted Actions have no runner. Then `python3 scripts/branch_check.py --merge <branch>` must print SAFE (read it, don't chain it). Use one gate at a time per checkout.
- **Builds refuse non-main or dirty source** (`scripts/trunk_guard.sh`; the list is in [`../scripts/README.md`](../scripts/README.md)). `STM_TRUNK_OVERRIDE="<why>"` is logged and for local debugging only; never install that build for David.
- **Attribution:** Counterpart commits carry the authoring model's `Co-Authored-By` line. Both MCP repos prohibit AI attribution and have their own review conventions; read each AGENTS.md. In the MCP repos merging publishes to npm.
- `~/scan-to-make` on each machine tracks main and fast-forwards every 2 minutes. `ssh agents-136 stm-ci <ref>` tests a pushed commit on Linux.

## Building and installing

- **Mac:** from a clean main checkout, `bash apps/mac/scripts/prepare-payload.sh` (it archives HEAD; a Release build refuses a payload from another commit), then
  `xcodebuild -project apps/mac/ScanToMake.xcodeproj -scheme ScanToMake -configuration Release -destination 'generic/platform=macOS' -derivedDataPath <out> CURRENT_PROJECT_VERSION=<yyyymmddhhmm> STM_ENTITLEMENTS_SUFFIX=+CloudKit -allowProvisioningUpdates build` under `/usr/bin/lockf -k ~/.stm-ios.lock`. Over ssh, codesign fails (`errSecInternalComponent`): run the build as a one-off LaunchAgent in `gui/$(id -u)`. Grep the built payload for your change. Install: check the app is idle, close open sheets, quit, back up the old app, `ditto` to `/Applications`, `launchctl kickstart -k gui/$(id -u)/com.scantomake.mac.companion`, open, and log it in a receipt folder. Developer ID releases: `apps/mac/scripts/release.sh` ([`distribution.md`](distribution.md)).
- **iPhone:** `apps/mobile/scripts/install-iphone.sh` (Release, development signing, USB install without uninstalling; receipts outside the checkout). TestFlight: `apps/mobile/scripts/prepare-testflight.sh`.
- **Printer MCPs:** publish the reviewed package, then use Counterpart's own Download/Update while idle and verify the app runs that version. Never hand-copy `dist`.
- **Linux:** `apps/linux/scripts/bundle.sh` on Ubuntu 26.04 x86_64. **Android:** `./gradlew assembleDebug` in `android/` (agents-173 has the SDK).

## Driving the apps

- **Mac over ssh:** System Events accessibility works (`osascript`); screenshots and synthetic clicks don't. Target the project window by name (a Settings window may be window 1), press buttons with `AXPress`, move in the sidebar with arrow keys. Many SwiftUI buttons have no accessible name: find them by size, and confirm each press by a visible change. David may be clicking at the same time.
- **Phone:** `xcrun devicectl device capture screenshot --device 00008150-001A488C3642401C --destination <png>`; `devicectl device process launch` to launch.
- **Files:** events `~/Library/Application Support/Scan to Make/events.ndjson`; projects `…/capture/objects/<id>/object.json`; printers `…/printers/profiles.json`; FULU control trace `~/.config/bambu-printer-mcp/bambu-network/control-trace.log`; companion control socket `…/auth/control.sock` (read-only diagnosis; never stand in for the app).
- **zsh on the Mac:** don't `echo =====`; quote globs like `--include='*.ts'`.
- **Second opinions:** Codex through the CLI inside ChatGPT.app (`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex exec -s read-only …`).

Evidence and receipts live in `~/scan-to-make-work/` on the Mac.
