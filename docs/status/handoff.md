# Handoff: Counterpart

The one handoff. Update this file in place when you stop; never add a numbered or dated copy, a prompt file,
or a "continuation" section on top. Git history has every older version.

Last verified: **2026-11-03, 14:30 Mountain**, against GitHub, the Mac, the installed apps and the printer.
Status of each of David's asks: [`asks.md`](asks.md). Hands-on review list: [`app-review-2026-11-02.md`](app-review-2026-11-02.md).
What to build: [`../design/overhaul/PRD.md`](../design/overhaul/PRD.md), journey in [`../design/journey.md`](../design/journey.md).

## David's rules

- **Acceptance is a person pressing real buttons in the real Counterpart app** (Mac or iPhone) driving the real
  printer, judged by the printer's own reports. Unit tests, scripts, direct MCP calls, the control socket, ssh and
  Studio/Handy are engineering checks only. Never stop, pause or resume the printer outside Counterpart's UI to
  make a test pass. Never restart FULU/Colima or repair state to manufacture a result.
- **The printer MCPs are the backend.** A button is one MCP tool call. A bug in bambu-printer-mcp is a bug in the
  app and is fixed once, in the MCP. No extra layers, parallel backends or copies of MCP state.
- **Anything that applies to both MCPs goes into both** (bambu-printer-mcp and mcp-3D-printer-server).
- **Don't invent rules or "improvements".** Change what was asked. When he has decided, don't re-ask.
  (Example: removing the FULU control's 5-second hold made him furious; it stays.)
- **Just works:** auto-detect, dropdowns, smart-filled `.env`; advanced users can still edit files.
- **Watch the app yourself** (accessibility dump, `events.ndjson`, `object.json`, `control-trace.log`). Never make him
  screenshot the app. Don't end a turn while something you started is in flight. Short, correct status lines.
- Printing guitar picks is authorized; after he clears the plate it is clear. Don't print the Crochet potato.
- No user memories (AGENTS.md). Push after every feature. Clean up worktrees, branches, venvs and build bloat you made.
- iOS/macOS 27.x, Liquid Glass; read current Apple docs. Use Apple's frameworks; don't hand-roll what Apple ships.

## Installed right now

| What | Version | From |
|---|---|---|
| Mac app `/Applications/Counterpart.app` | **202611031427** | `feat/pause-at-layer` @ `acce6e1` (contains all of #295) |
| iPhone "Davica3" (`00008150-001A488C3642401C`) | **202611022325** | old: has none of #294/#295 or pause-at-layer |
| bambu-printer-mcp (what Counterpart runs) | 1.1.46 install + dist from `feat/one-printer-control-route` @ `fdca5a1` | `~/Library/Application Support/Scan to Make/printers/bambu-1.1.46/lib/node_modules/bambu-printer-mcp/dist` |
| mcp-3D-printer-server | `~/mcp-3D-printer-server` detached at `175944e` (`feat/bambu-complete`), built in place | runs from its own folder and `.env` |
| bambu-printer-mcp config | `~/bambu-printer-mcp/.env` (the ssh forced command `cd`s there): `BAMBU_DEFAULT_CONNECTION_MODE=bambu_network`, `…_TYPE=lan` | Counterpart's own environment never crosses the ssh hop |
| FULU runtime | Colima profile `bambu-fulu`, image `bpm-fulu-e2e:runtime`, plug-in **02.05.02.58** | launcher `~/Library/Application Support/Scan to Make/printers/fulu-authenticated-lan.sh` (in neither repo) |
| P1S | `01P00C4B2500106`, 192.168.68.148, firmware 01.10.00.00, cloud-bound, not LAN-only/Developer mode | AMS A1 black PLA, A2 yellow PLA, A3 PETG |

Every deployment, companion restart and rollback is logged in
`~/scan-to-make-work/claude-route-20261102/deployment-boundary.txt`; app and MCP rollbacks are in the same folder.

## Works on the real devices (verified)

- **Print from the Mac app over the local network (FULU):** Triangle picks printed start to finish from the Print
  button at 13:24, 13:50 and 14:11 today (bambu-printer-mcp, Connection: Local network).
- **Pause before a layer** (magnets, nuts): print sheet → Pause → "Before layer N of T" → Print. The MCP's
  `pause_at_layers` has the slicer CLI write the printer's own pause (`M400 U1`) via `--load-custom-gcodes`; at 14:18
  the P1S paused itself before layer 3. Pauses saved in a Studio/Orca project 3MF are kept (the CLI drops them on its
  own). Resume on the **printer's screen** works; see the open item for Resume from the app.
- **A refused control is shown and kept:** the app shows the printer's refusal ("refused Pause over the local network
  (error 0502400A)"); since `acce6e1` it is also written to the project's activity and `companion.log`.
- Settings → Printers: Connection picker (Local network / Bambu Cloud, written to the MCP's `.env`, #294 merged),
  Add Printer…, both MCPs downloadable, per-printer Printer MCP choice (#295, installed, not merged).
- Earlier device acceptance (rename, search, Help, Project Settings, Live Activity test delivery through the Sandbox
  relay, published-model import) is recorded per row in `asks.md`.

## Open, in order

1. **Remote Pause/Resume/Stop are refused by the printer.** Every Pause and Stop sent today reached the P1S and got
   the signed reply `err_code 84033546` (0x0502400A), over LAN and over Bambu Cloud. Tried and ruled out: flag 1,
   32-bit sequence ids, the cloud route, FULU's client identity headers (`X-BBL-Client-*`, now sent; changed nothing).
   Remaining leads, untested: (a) FULU's runtime uses Bambu's plug-in **02.05.02.58** while Bambu Studio on this Mac
   uses **02.08.02.61**, so a newer plug-in in the bridge; (b) LAN-only + Developer mode on the printer (David's call,
   disconnects Bambu Cloud/Handy). Bambu Studio itself pauses and resumes this printer fine.
2. **Resume from the app after a pause: fixed in code, not yet re-tested.** Until `fdca5a1`, bambu-printer-mcp's
   pre-resume check refused any non-zero `print_error`, and a paused P1S reports `0x03008013` ("paused by the user"),
   so Resume never reached the printer (David pressed it on both apps at 14:19). Now excused only while the printer
   reports `PAUSE`. Next: a pick with a pause, Resume in the app. It may then hit item 1's refusal; the reason will show
   in the activity. For tonight's magnet print, resume on the printer.
3. **Merge the open Counterpart PRs**, in this order, each through the merge flow below:
   - **#295** `feat/add-printer` (head `fef3ef1`): installed and in use. Includes print failures as events
     (review item 23), Print Again reuses its slice, the review fixes (cached G-code format, preset contents and
     `.env` in the slice cache key, JPEG camera replies, manual port, stale Check result).
   - **`feat/pause-at-layer`** (stacked on #295, head `acce6e1`, pushed, **no PR yet**): pause rows in the Mac print
     sheet, `pauseBeforeLayers` → `pause_at_layers`, `capabilities.layerPauses`, refused controls kept.
   - **#292** `feat/new-design-without-scan`: a copy request with nothing scanned runs as a new design (Fusion).
   - **#293** `feat/keep-multicolour-model`: keeps a pass's 3MF. **Don't install alone:** a designed 3MF would print
     without an AMS mapping; it needs the MCP to pick the nearest loaded tray per part colour (both MCPs; mcp-3D has
     no 3MF tool). This is ask 41, the "Vivi" pick.
   - **#297** `docs/site-mcp-backend`: site says the MCPs are the backend and links their docs sites.
4. **MCP branches, PRs not opened, releases held by David** (merging to main publishes to npm):
   - bambu-printer-mcp `feat/one-printer-control-route` (`fdca5a1`, 20 commits over 1.1.51 main): route ownership,
     FULU cloud session, refusal reporting, prompt removal, `counterpart_print_route`, `pause_at_layers`, Resume fix,
     client headers. Before a PR: strip the `Co-Authored-By` trailers on `c03a9bb`, `f4433b6`, `84aa077`, `7146550`
     (that repo forbids AI attribution), CHANGELOG, code-review gate. Open PRs there: #95 camera stream, #96 Fusion
     document binding, **#97 Studio 2.9 bare-`M` temperature marker (not in the deployed build)**.
   - mcp-3D-printer-server `feat/bambu-complete` (`175944e`): AMS, Pause/Resume/Stop, FULU route,
     `counterpart_print_route`, bambu-printer-mcp's safety modules. **Missing here, must be ported:** `pause_at_layers`,
     the Resume pause-notice fix, refusal reporting. Open PRs: #49 camera stream, #50 Studio 2.9.
5. **Phone parity.** The phone build is a day old. Needed: a new build with #294/#295; Printer MCP and Connection
   pickers in Settings → Printers (`PrintersView.swift`) with phone HTTPS routes (existing PRINT/SETTINGS scope,
   capability flag, `docs/protocols/objects-api.md`); the Pause section in the phone print sheet. Build: Release,
   `STM_ENTITLEMENTS_SUFFIX=+CloudKit`, `/usr/bin/lockf -k ~/.stm-ios.lock`, install with `devicectl`, confirm by screenshot.
6. **Connection choice per printer from every viable route** (David: "whether i want to print through fulu or bambu
   over lan or bambu cloud, or whatever other viable options exist"). Both MCPs' `counterpart_print_route` know only
   `lan`/`cloud`. Agreed plan: the MCP reports `options: [{id,label,available,reason?}]` (direct LAN, FULU LAN, Bambu
   Cloud via FULU, Bambu Connect, X2D native; availability from configuration only) and accepts any id; same contract
   in both MCPs; companion refuses a change while that printer prints (409). The Mac picker is still gated to
   bambu-printer-mcp (`SettingsViews.swift:379`); show it for any MCP with `counterpart_print_route`. New PR off main.
7. **Bambu Cloud printing is refused:** `net.start_print` -3120, HTTP 403 "internal blocking", every time. Untested
   comparison: a cloud print from Bambu Studio itself. Also show it in plain words instead of the raw plug-in text.
8. **FULU through mcp-3D-printer-server crashes:** `create_directory …/.config/mcp-3d-printer-server/bambu-network/log`,
   because the launcher mounts only `~/.config/bambu-printer-mcp/bambu-network`. Fix in Complete Settings: carry the
   source MCP's session folder (`BAMBU_NETWORK_CONFIG_DIR`, or ask `bambu_network_bridge_status` for `configDir`).
   Then check two bridge containers sharing one login don't log each other out. Unexplained: at 12:52 `printers.route`
   for the mcp-3D printer returned `cloud` while its `.env` says `lan`.
9. **Live Activities.** The two orange "0%" items in the Mac menu bar are the iPhone's print Live Activities, mirrored
   by macOS. The relay ends an activity only on `print.done`/`failed`/`cancelled` (`EventRelayPolicy.swift:208`), not on
   `print.not-started`; retrying a project may also orphan its earlier activity (not verified). Separately, on Nov 2 a
   real print's Lock Screen activity stayed at 0% "Waiting for an update" while the app advanced. Not diagnosed.
10. **Workarounds left from the old route bug:** `print.ts:434` auto-clears HMS `0500_0500_0001_0007` before printing,
    `PrintingView.swift:167` special-cases the same code, and `printer-handoff.json` `selection.connectionMode` still
    exists in the config schema. `mcp-client.ts:237` resets timeouts on progress but never forwards the progress.
11. **Review list items still open** (`app-review-2026-11-02.md`): 5 (0.6 mm shown as 1 mm), 6 ("0 g"), 10 (spool
    names "A1 · PLA PLA Basic PLA #000000", seen today), 11, 12 ("Your printer MCP's preset", seen today), 14–17
    (phone finished-print screen), 19/19a (accessibility presses), 22 (the "I checked the printer" toggle), 24, 25, 28.
    Items 1–4 and 5a belong with #293/ask 41.
12. **Phone stopped connecting once** (12:16–12:33): the Mac left the phone's TCP handshakes on 9077 in SYN_RCVD
    while other hosts connected; a companion restart cleared it. Not root-caused. NordVPN Threat Protection (a network
    content filter) is active on the Mac.
13. **Long-standing asks** (details per row in `asks.md`): scan quality (walk-around models have an incomplete rear;
    in-hand is off), camera/Face ID after scanning, real-print notifications and Watch delivery, same-account
    enrollment, AI provider routing (saved choice is not used by model jobs), Mac memory (348 MB open vs the 150 MB
    menu-bar target), "Vivi" multi-colour (ask 41).
14. **Caliper card** (`KAN-209-caliper`, unmerged; evidence `~/scan-to-make-work/caliper/`): rename to Counterpart,
    docs QR → `https://counterpart.dtmont.com/`, put each vernier digit under its own line, then print the two-colour
    3MF. `tools/caliper/LICENSE` had an uncommitted GPL-3 → Apache-2.0 switch. The no-AMS variant can now use
    `pause_at_layers`.
15. **Starting a file already on the printer's SD card** without reslicing: offered to David, not built.

## Stale work to decide on or clean up

- Old Counterpart PRs from Nov 1, 207–219 commits behind main: **#175, #177, #178** edit React Native screens that no
  longer exist (superseded by the native app); **#166** printer setup with Keychain (David rejected Keychain; #295
  replaced it; reuse its SSDP and docs only); **#174** (cleanup uses the saved AI choice, which is still open as
  provider routing), **#179** (newest Codex), **#180** (judge tool) touch live files and need a rebase or a close. Ask
  David before closing.
- Mac worktrees of `~/scan-to-make`: `~/stm-wt/KAN-206`, `KAN-214-bed`, nine `KAN-217-*`, `KAN-224b`, `phone-deploy`,
  `phone-works`, three detached `~/scan-to-make-verify/*`, and the Codex worktrees `~/.codex/worktrees/counterpart-*`.
  Remove each after checking it has nothing unpushed. Logs in `~/stm-wt/*.log` are bloat.
- Stash `codex WIP: print-state-delivery` in `~/scan-to-make`: superseded by #295's `print.not-started`.

## Decisions already made (don't re-ask)

- No bed or plate check anywhere; no ordinary "needs a yes before printing" prompt (removed in both MCPs, deployed;
  hardware-error clears and unverifiable resumes still ask).
- mcp-3D-printer-server slices Bambu printers with Bambu Studio by default (FULU's OrcaSlicer CLI v1.0.0 segfaults).
- Printer settings live in each MCP's `.env`; Counterpart edits them, it never keeps its own copy.
- The 5-second hold on FULU controls stays.
- Printing picks is authorized; the Sandbox APNs key and relay are provisioned (`counterpart-relay-sandbox`).

## Done or superseded (verified; don't redo)

- MCP owns the print route (#291), Connection setting (#294), print failures reach the phone (#295), "Stop sent"
  while the printer ignored it (the app now shows the printer's refusal), Stop over plain MQTT (route fixed; the printer
  now refuses all remote controls instead, item 1), the dead React Native bridges (gone from main), the Nov 1 phone
  redesign complaints (native SwiftUI app; tracked per row in `asks.md`), APNs Sandbox provisioning, Codex's Stop
  connection threading (superseded by #291), the "needs a yes before printing" prompt (review item 26).

## How to work here

- **Merge flow:** local gate `/usr/local/bin/python3 scripts/ci_local.py --changed-only --base origin/main` (hosted
  Actions have no runner: every hosted check fails with 0 steps, also on main); comment `@codex review`; wait for
  Codex (Cursor is slow) on the exact head; fix findings; `python3 scripts/branch_check.py --merge <branch>` must print
  SAFE (read it, don't chain it); squash-merge. Delete branches only after GitHub shows MERGED.
- **Attribution:** Counterpart commits end with the Co-Authored-By line from the session; the two MCP repos allow no
  AI attribution at all and want "@codex review" in commit messages.
- **Mac build:** commit first, then `bash apps/mac/scripts/prepare-payload.sh` (archives git HEAD; without it the build
  reuses an old companion), then xcodebuild Release with `CURRENT_PROJECT_VERSION=<yyyymmddhhmm>`
  `STM_ENTITLEMENTS_SUFFIX=+CloudKit -allowProvisioningUpdates`, derived data `~/scan-to-make-work/dd/codex-mac`, under
  `/usr/bin/lockf -k ~/.stm-ios.lock`. Over ssh, codesign fails (`errSecInternalComponent`): run the build as a one-off
  LaunchAgent in `gui/$(id -u)` (`launchctl bootstrap`). Grep the built payload for your change. Install: close open
  sheets, quit, back up, `ditto` to `/Applications`, `launchctl kickstart -k gui/$(id -u)/com.scantomake.mac.companion`,
  open, log it in `deployment-boundary.txt`. Restart the companion only while the printer is idle or not dispatching.
- **MCP deploy:** copy the built `dist` files into the live install path in the table above (back up first), then
  restart the companion. The Mac has no GitHub credentials: push from a Linux box (`git fetch <mac worktree>` then push).
- **Drive the Mac app over ssh:** System Events accessibility works (`osascript`); screenshots and synthetic clicks don't.
  Target the project window by name (a Settings window may be window 1), press buttons with `AXPress`, move in the
  sidebar with arrow keys. Many SwiftUI buttons have no accessible name: find them by size, and confirm each press by a
  visible change. David may be clicking at the same time.
- **Phone:** `xcrun devicectl device capture screenshot --device 00008150-001A488C3642401C --destination <png>`;
  `devicectl device process launch` to launch. T3 device tools don't list it.
- **Files:** events `~/Library/Application Support/Scan to Make/events.ndjson`; projects `…/capture/objects/<id>/object.json`;
  printers `…/printers/profiles.json`; FULU control trace `~/.config/bambu-printer-mcp/bambu-network/control-trace.log`;
  companion control socket `…/auth/control.sock` (read-only diagnosis only; never stand in for the app).
- **Linux boxes** agents-136/171/173 run the ubuntu CI jobs; `ssh agents-136 stm-ci <ref>` tests a pushed commit.
  `~/scan-to-make` main auto-fast-forwards every 2 minutes on every machine.
- **zsh on the Mac:** don't `echo =====`; quote globs like `--include='*.ts'`.
- **Second opinions:** Codex `gpt-6-astra` through the CLI inside ChatGPT.app
  (`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex exec -s read-only …`).

## Evidence folders (on the Mac, `~/scan-to-make-work/`)

`claude-route-20261102/` (deployment log, rollbacks, `.env` backups), `codex-handoff-20261103/` (CI logs for #295),
`codex-stop-continuation-20261102/` (FULU source excerpts), `codex-live-delivery-20261102/` and
`codex-sandbox-relay-20261102/` (APNs relay), `codex-deploy-20261102/` (install and preservation receipts),
`caliper/`, camera incident facts in [`camera-incident-2026-11-02.md`](camera-incident-2026-11-02.md), capture audit in
[`capture-reconstruction-audit-2026-11-02.md`](capture-reconstruction-audit-2026-11-02.md).
