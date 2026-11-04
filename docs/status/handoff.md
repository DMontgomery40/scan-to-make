# Handoff: Counterpart

The one handoff. Update this file in place when you stop; never add a numbered or dated copy, a prompt file,
or a "continuation" section on top. Git history has every older version.

Last device verification: **2026-11-03, 20:27 Mountain**. **Resume, Pause and Stop now work from the Mac
Counterpart UI through FULU**, confirmed by the P1S's correlated replies and observed state changes.
The printer remains cloud-bound, Developer Mode off. The test pick is stopped; the app shows the printer Ready.
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
| Mac app `/Applications/Counterpart.app` | **202611032022** | main @ `2f7f43e` (Resume confirmation deadlock fix; source audit found #295/pause-at-layer absent from this main build, contrary to the older handoff) |
| iPhone "Davica3" (`00008150-001A488C3642401C`) | **202611022325** | old: has none of #294/#295 or pause-at-layer |
| bambu-printer-mcp (what Counterpart runs) | 1.1.46 install + dist from `feat/one-printer-control-route` @ `587461b` (active since 20:17) (a built `native/bambu-native-print` from `exp/native-plugin-controls` sits beside it, unused for a P1S) | `~/Library/Application Support/Scan to Make/printers/bambu-1.1.46/lib/node_modules/bambu-printer-mcp/dist` |
| mcp-3D-printer-server | live dist from `56d8fb9`; source `feat/bambu-complete` now `afcf378` (new layer-pause parity not deployed) | runs from its own folder and `.env` |
| bambu-printer-mcp config | `~/bambu-printer-mcp/.env` (the ssh forced command `cd`s there): `BAMBU_DEFAULT_CONNECTION_MODE=bambu_network`, `…_TYPE=lan` | Counterpart's own environment never crosses the ssh hop |
| FULU runtime | Colima profile `bambu-fulu`, image `bpm-fulu-e2e:runtime`, plug-in **02.05.02.58** | launcher `~/Library/Application Support/Scan to Make/printers/fulu-authenticated-lan.sh` (in neither repo) |
| P1S | `01P00C4B2500106`, 192.168.68.148, firmware 01.10.00.00, cloud-bound, not LAN-only/Developer mode | AMS A1 black PLA, A2 yellow PLA, A3 PETG |

Earlier deployments are logged in `~/scan-to-make-work/claude-route-20261102/deployment-boundary.txt`.
This evening's deployment and redacted acceptance receipts are in
`~/scan-to-make-work/codex-fulu-controls-20261103/`. The experimental 02.08 runtime was rolled back;
the active launcher again uses the original 02.05.02.58 image. Temporary plug-ins, credential copies,
remote native probes and the SSH tunnel were removed after verification.

## Works on the real devices (verified)

- **Resume → Pause → Stop from the Mac UI (20:25–20:27):** Triangle pick was paused before layer 2.
  After a companion restart to deploy the fix, Resume's confirmation was answered in Counterpart.
  P1S replied `resume/20001: success` at 20:25:19, and the app showed Printing. Pause replied
  `pause/20003: success` at 20:26:05, then the app showed Paused at 88%. Stop → Stop Printing replied
  `stop/20005: success` at 20:26:50; the app showed “The printer stopped” and the printer Ready.
  No Studio/Handy control, direct script control, Developer Mode change or printer restart was used.
  This verifies bambu-printer-mcp over local FULU; phone, cloud transport and mcp-3D hardware acceptance remain open.
- **Print from the Mac app over the local network (FULU):** Triangle picks printed start to finish from the Print
  button at 13:24, 13:50 and 14:11 today (bambu-printer-mcp, Connection: Local network).
- **Pause before a layer** (magnets, nuts): print sheet → Pause → "Before layer N of T" → Print. The MCP's
  `pause_at_layers` has the slicer CLI write the printer's own pause (`M400 U1`) via `--load-custom-gcodes`; at 14:18
  the P1S paused itself before layer 3. Pauses saved in a Studio/Orca project 3MF are kept (the CLI drops them on its
  own). Resume now also works from the Mac app, as verified above.
- **A refused control is shown and kept:** the app shows the printer's refusal ("refused Pause over the local network
  (error 0502400A)"); since `acce6e1` it is also written to the project's activity and `companion.log`.
- Settings → Printers: Connection picker (Local network / Bambu Cloud, written to the MCP's `.env`, #294 merged),
  Add Printer…, both MCPs downloadable, per-printer Printer MCP choice (#295, installed, not merged).
- Earlier device acceptance (rename, search, Help, Project Settings, Live Activity test delivery through the Sandbox
  relay, published-model import) is recorded per row in `asks.md`.

## Open, in order

0. **External TestFlight, in progress.** App Store listing is **Counterpart 3D** (icon remains
   Counterpart), ID **6830483457**, bundle `com.scantomake`, **Full Access** verified. User chose
   a public link for external testers. Source `c438efa` was cloud-signed, exported, validated and
   uploaded as **2.0 (2)** at 23:19 Mountain. Build 1 was removed from review and build 2
   submitted at 23:32; it is **Waiting for Review**. Build 2 includes starters and multi-plate UI. Internal group
   `Counterpart Team` exists; description and user-supplied review/feedback contacts are saved.
   External group **Counterpart Public Beta** has build 2.0 (2), submitted for Beta App Review (build 1 remains unsubmitted).
   Automatic tester notifications are off; zero testers, no email invitations. Public link created
   **https://testflight.apple.com/join/S4tExVzp**, Open to Anyone. Apple says testers cannot join
   until an approved build is in the group. No public announcement sent. App record currently
   lists iOS and macOS drafts; do not remove the Mac platform without understanding that choice.
   Release branch `feat/testflight-readiness` is pushed through `db8e87b` (no PR yet).
   `docs/distribution.md` contains the release procedure and remaining production prerequisites.
   - **Starter projects and multi-plate printing implemented on the release branch:** welcome/Home and
     the empty Mac workspace offer the scan platform, Counterpart caliper card and long vernier
     with depth gauge. The card ships fresh generated model files, branding, QR and preview.
     MakerWorld starters include credits/instructions and original-file import, not redistributed
     geometry (PRD §15). No personal project history is copied. All imported plates stay in one
     project with selection, per-plate print/reprint and persisted completion. Multiple original
     files can be imported together for the long caliper/depth gauge. Active/uncertain prints
     lock selection; stale print sheets cannot dispatch a different selected plate. Tests cover
     a synthetic six-plate project; actual rig-original import and physical prints remain open.
     New first-launch/plate-selection simulator UI tests pass (2); shared Swift 168, focused
     companion review checks 75 and caliper checks 13 pass; both native builds pass.
   - **Latest direction:** Linux computer support coming soon, including Tailscale; bring-your-own-AI
     includes Claude Code, Codex, OpenCode and OpenAI-compatible APIs (OpenRouter/local models).
     The saved beta copy identifies Codex/API/endpoint settings as existing options; project routing
     is integrated at `c438efa`; OpenCode is planned. User explicitly requested a subagent
     to fix provider routing while parent finishes TestFlight; describe supported choices directly
     in the listing and complete wiring before sharing the link. No public
     24-hour promise. Saved provider routing now drives model jobs and Off is enforced. `db8e87b` corrects
     the helper to use independently installed cleanup tools, not a nonexistent bundled judge.
     Live delegated Claude/Codex fixture MCP/image checks passed; real app modeling acceptance
     and OpenCode remain. API cleanup retains CLI/Responses requirements; see provider report.
   - **Phone connectivity fix is implemented:** unknown shows Checking, failed requests mark
     unreachable, successful poll recovery reloads; bounded JSON metadata requests preserve long
     downloads. David explicitly says his phone is connected. A developer-tool tunnel being
     unavailable is not evidence of app failure. No fresh phone build installed this session.
   - **Production services remain:** CloudKit Console is signed in; the complete schema was deployed and verified in Production at 23:23. Added missing
     `CounterpartCommand` and `CounterpartProject.openAsk`; `CounterpartEvent.type` is Queryable.
     Source schema: `docs/protocols/cloudkit-schema.ckdb`. No user records were changed. The production relay
     probe returned HTTP 405, not a valid relay/APNs receipt. Do not point the installed development
     phone/Mac at production yet. Developer ID Application certificate is now issued/imported; matching profile and notarization
     remain in progress. No notarized Mac companion/download exists yet; independent
     worker installer is implemented and qualified but fresh-install activation remains unaccepted.
   - **Latest implementation evidence:** `testflight-ci-c438efa` passed Node 22/24,
     each 790 companion and 55 contract tests. Final cleanup-path changes pass two
     compiled-helper tests, two tool-resolution tests and the full licence workflow.
     `testflight-ci-db8e87b` passed Node 22 (792); Node 24 exposed a printer-test race:
     its second pause matched the first pause's old message. `78e6750` waits for a
     new event; all 29 printing tests then pass. Full final rerun remains in progress.
     Mac 147 + one skip, shared 168 and two new simulator UI tests pass. The packaged
     companion was rebuilt and audited; Docker starter/context smoke passes.
   - **Earlier evidence:** `~/scan-to-make-work/testflight-2.0-1/` holds archive/IPA; official Linux CI at
     `~/scan-to-make-work/testflight-ci-b734344/` passes Node 22/24 (each 55 contracts + 767 companion,
     one macOS-only skip). Shared 164; iOS app 16; print UI 15 across corrected reruns; Mac 147 +
     one skip before final format/#292 integration. Independent review found no substantive issues.
     `ab455a6` fixes export PATH (Homebrew rsync incompatibility) and codesign certificate verbosity;
     real IPA validation passes, eight release-script tests pass on Linux. These are engineering
     checks, not device acceptance. Old inactive codex-integration build caches were removed;
     logs/results remain. Linux CI scratch checkout/venvs removed; shared caches retained.
1. **Remote Pause/Resume/Stop: accepted on Mac through local FULU.** Root cause was the MCP's
   `String(20_000 + Date.now() % 1_000_000)` IDs. On this P1S 01.10, signed controls must use string IDs
   in Studio's **20000–29999** window. Read-only probes accepted signature verification at 20000, 20001,
   25001 and 29999; 19999, 30000, 30001 and 324005 returned 84033546. Numeric IDs also failed.
   All 23 historical rejected controls verified cryptographically against the plug-in's public certificate:
   “bad signature” was misleading. Certificate presence, cloud login, CPU emulation and plug-in version
   were not the differentiator. Original Linux 02.05.02.58 and updated 02.08.02.54 both showed the same boundary.
   **Fix:** a shared, wrapping string counter across LAN/cloud sends and retries in both MCPs. The 5-second
   delivery hold, correlated replies and safety/resume checks remain. Refusal text and connection descriptions
   no longer claim that only Studio/Handy or Developer Mode can work.
   **Pushed:** bambu-printer-mcp `587461b` (1024 pass, 0 fail, 4 skipped); mcp-3D-printer-server `56d8fb9`
   (654 pass, 0 fail, 1 skipped). Both site builds pass. Local Standards/Spec reviews completed; changelog and
   test-assertion findings corrected. No npm release or merge of these MCP feature branches was made.
   **Still to accept:** phone controls, Bambu Cloud controls and mcp-3D-printer-server on hardware.
   Developer Mode is an alternative, not a prerequisite. David's objection to the prior stopping premise was right.
2a. **Resume after a companion restart: accepted on the Mac.** The existing persisted inspected-job record
   survived the 20:17 deployment restart while the pick was paused. Resume later passed the existing checks,
   asked its unverifiable-file question and succeeded through Counterpart. No state record was fabricated.
2. **Mac Resume confirmation deadlock: fixed, installed and accepted.** The original Resume request holds
   `ObjectsModel.working` while the MCP asks a question. The form and its submit method previously used that
   same busy flag and could never answer. `2f7f43e` separates ordinary operations from confirmation submissions;
   other operations still see their union, and duplicate answers are blocked independently. Required fields,
   question identity and expiration checks remain. Buttons say Resume/Cancel Resume for a paused print.
   The regression failed before the fix; all 31 ObjectsModel tests pass after it. Signed Release build and
   codesign verification pass; build 202611032022 is installed. A fresh Resume request's checkbox remained
   enabled while the control waited, and its answer led to the successful printer command above.
   The printer still returns FTPS 550 for this plug-in-uploaded file, so the existing confirmation is expected.
   Phone parity for the waiting/confirmation flow is not yet checked.
3. **Merge the open Counterpart PRs**, in this order, each through the merge flow below:
   - **#295 and `feat/pause-at-layer`** are integrated into the release branch at `e44d467`.
     **#292** is integrated at `b734344`. Not merged to main or freshly deployed to David's devices.
   - **#293** `feat/keep-multicolour-model`: keeps a pass's 3MF. **Don't install alone:** a designed 3MF would print
     without an AMS mapping; it needs the MCP to pick the nearest loaded tray per part colour (both MCPs; mcp-3D has
     no 3MF tool). This is ask 41, the "Vivi" pick.
   - **#297** `docs/site-mcp-backend`: site says the MCPs are the backend and links their docs sites.
4. **MCP branches, PRs not opened, releases held by David** (merging to main publishes to npm):
   - bambu-printer-mcp `feat/one-printer-control-route` (`c0c988b`, 21 commits over 1.1.51 main; + persistent resume records): route ownership,
     FULU cloud session, refusal reporting, prompt removal, `counterpart_print_route`, `pause_at_layers`, Resume fix,
     client headers. Before a PR: strip the `Co-Authored-By` trailers on `c03a9bb`, `f4433b6`, `84aa077`, `7146550`
     (that repo forbids AI attribution), CHANGELOG, code-review gate. Open PRs there: #95 camera stream, #96 Fusion
     document binding, **#97 Studio 2.9 bare-`M` temperature marker (not in the deployed build)**.
   - mcp-3D-printer-server `feat/bambu-complete` is pushed at **`afcf378`**: existing control fixes
     plus layer-pause parity, preserved project pauses, exact-layer placement verification and
     refusal of already sliced files missing requested pauses. The packed tarball now includes
     `control-reply.js`. Linux: 663 pass / 6 optional skips; packed stdio/HTTP/SSE and site pass.
     Logs: `~/scan-to-make-work/testflight-generic-parity/`. Local dist/live install not rebuilt.
     No PR or npm release. Preserve unrelated untracked .env backup, private models and scratch.
5. **Phone parity implemented on the release branch:** Settings → Printers exposes MCP and
   route selection through authorized routes and per-physical-printer reservations; phone print
   sheet has layer pauses and Resume-specific confirmation. Finished print removes live controls,
   camera polling and remaining-time claims; small size/weight values no longer round to zero.
   `b845a54` contains these changes; physical acceptance remains. No new build installed on Davica3.
6. **Connection choice per printer from every viable route** (David: "whether i want to print through fulu or bambu
   over lan or bambu cloud, or whatever other viable options exist"). Both MCPs' `counterpart_print_route` know only
   `lan`/`cloud`. Agreed plan: the MCP reports `options: [{id,label,available,reason?}]` (direct LAN, FULU LAN, Bambu
   Cloud via FULU, Bambu Connect, X2D native; availability from configuration only) and accepts any id; same contract
   in both MCPs; companion refuses a change while that printer prints (409). The Mac picker is still gated to
   bambu-printer-mcp (`SettingsViews.swift:379`); show it for any MCP with `counterpart_print_route`. New PR off main.
7. **Bambu Cloud printing is refused:** `net.start_print` -3120, HTTP 403 "internal blocking", every time. Untested
   comparison: a cloud print from Bambu Studio itself. Also show it in plain words instead of the raw plug-in text.
8. **FULU setup carryover implemented** in `b845a54`: copy `BAMBU_NETWORK_CONFIG_DIR`
   from source MCP configuration, or read-only bridge status for an already copied route; preserve
   explicit target configuration. Focused 21 checks pass. Actual second-MCP setup still unaccepted.
9. **Duplicate alerts and Live Activity recovery implemented** in `7292111`: CloudKit owns
   discrete alerts, ActivityKit pause/end are silent; started subscription is made silent in place.
   Recovery keeps bounded persisted events, ends `print.not-started`, respects terminal precedence,
   recovers late tokens and retires older activities. No fresh phone/Watch or production delivery receipt.
10. **Workarounds left from the old route bug:** `print.ts:434` auto-clears HMS `0500_0500_0001_0007` before printing,
    `PrintingView.swift:167` special-cases the same code, and `printer-handoff.json` `selection.connectionMode` still
    exists in the config schema. `mcp-client.ts:237` resets timeouts on progress but never forwards the progress.
11. **Review list:** 5/6 and 14–17 have release-branch fixes/tests, still need device acceptance.
    Items still open (`app-review-2026-11-02.md`): 10 (spool
    names "A1 · PLA PLA Basic PLA #000000", seen today), 11, 12 ("Your printer MCP's preset", seen today), 19/19a (accessibility presses), 22 (the "I checked the printer" toggle), 24, 25, 28.
    Items 1–4 and 5a belong with #293/ask 41.
12. **Phone stopped connecting once** (12:16–12:33): the Mac left the phone's TCP handshakes on 9077 in SYN_RCVD
    while other hosts connected; a companion restart cleared it. Not root-caused. NordVPN Threat Protection (a network
    content filter) is active on the Mac.
13. **Long-standing asks** (details per row in `asks.md`): scan quality (walk-around models have an incomplete rear;
    in-hand is off), camera/Face ID after scanning, real-print notifications and Watch delivery, same-account
    enrollment, AI provider app-level acceptance (saved choice is now routed), Mac memory (348 MB open vs the 150 MB
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
- **Attribution:** Counterpart commits use `Co-Authored-By: Codex <noreply@openai.com>`; both MCP repos prohibit AI attribution. Bambu requires its review convention; generic MCP forbids unsolicited `@codex review`. Read each current AGENTS.md.
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
