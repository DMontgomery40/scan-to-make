# Handoff: Counterpart

The one handoff. Update this file in place when you stop; never add a numbered or dated copy, a prompt file,
or a "continuation" section on top. Git history has every older version.

Last device verification: **2026-11-03, 20:27 Mountain**. **Resume, Pause and Stop now work from the Mac
Counterpart UI through FULU**, confirmed by the P1S's correlated replies and observed state changes.
At that verification the printer was cloud-bound with Developer Mode off. David enabled LAN Only and Developer
Mode on Nov 4; see the current route receipt below. The test pick was stopped and the app showed Ready.
Those receipts used hand-copied, unpublished MCP code; they do not establish acceptance of the released backend.
Repeat acceptance through the app after its Update action installs the published npm package.
Status of each of David's asks: [`asks.md`](asks.md). Hands-on review list: [`app-review-2026-11-02.md`](app-review-2026-11-02.md).
What to build: [`../design/overhaul/PRD.md`](../design/overhaul/PRD.md), journey in [`../design/journey.md`](../design/journey.md).

## David's rules

- **Acceptance is a person pressing real buttons in the real Counterpart app** (Mac or iPhone) driving the real
  printer, judged by the printer's own reports. Unit tests, scripts, direct MCP calls, the control socket, ssh and
  Studio/Handy are engineering checks only. Never stop, pause or resume the printer outside Counterpart's UI to
  make a test pass. Never restart FULU/Colima or repair state to manufacture a result.
  Use the same published MCP packages users receive through Download/Update; hand-copied feature builds do not
  count as release acceptance. Design acceptance likewise starts with New project / Ask for changes in the app.
- **The printer MCPs are the backend.** A button is one MCP tool call. A bug in bambu-printer-mcp is a bug in the
  app and is fixed once, in the MCP. No extra layers, parallel backends or copies of MCP state.
  Download/Update follows npm latest independently of App Store/TestFlight releases. David explicitly authorized
  merging and publishing the combined MCP fixes after checks on Nov 4; earlier release holds are superseded.
- **Anything that applies to both MCPs goes into both** (bambu-printer-mcp and mcp-3D-printer-server).
- **Don't invent rules or "improvements".** Change what was asked. When he has decided, don't re-ask.
  (Example: removing the FULU control's 5-second hold made him furious; it stays.)
- **Just works:** auto-detect, dropdowns, smart-filled `.env`; advanced users can still edit files.
- **Watch the app yourself** (accessibility dump, `events.ndjson`, `object.json`, `control-trace.log`). Never make him
  screenshot the app. Don't end a turn while something you started is in flight. Short, correct status lines.
- **No autonomous prints or reprints.** David, Nov 4: "do not reprint anything on your own EVER."
  This supersedes the earlier guitar-pick acceptance permission. David initiates physical prints; app acceptance
  uses the actual installed app's visible controls. Leave the current AirPods hanger print running as he instructed.
- **Orientation/support incident (Nov 4):** the AirPods hanger was reported printing upright with supports off
  although its design planned side-down printing. The orientation/support-plan fix is owned by thread
  `56a66f4e-49b6-49ee-b167-550b55157819`, targeting main as #303 after #302; #293's AMS work follows it.
  Release owner integrates it with #298/provider guidance. David's updated scope supersedes the earlier plan:
  drop `lay_flat`, pass every STL to the slicer with `orient: true`, preserve 3MF placement, and pass the
  designer's structured support on/off/type directly to `slice_stl`. Include support args in slice-cache
  identity; use the existing unsupported-settings refusal. No stored rotation, hash-bound plan, receipt
  checks, missing-plan Ask or walls/infill minimum Asks. Counterpart is a bridge to the slicer.
  The source fix is installed in build 202611040900; design/print acceptance remains open.
  Mac UI, companion restarts, installs and MCP Update remain held until the release owner hands control back.
- No user memories (AGENTS.md). Push after every feature. Clean up worktrees, branches, venvs and build bloat you made.
- iOS/macOS 27.x, Liquid Glass; read current Apple docs. Use Apple's frameworks; don't hand-roll what Apple ships.

## Installed right now

Build **202611041137** (source `c5762972`) is installed and checked through the actual Mac UI after David’s colour pick finished. All ten project files, printer configuration, settings and authentication hashes are unchanged. Guitar pick Printed; P1S Ready; Claude selected. This adds #306’s legacy-colour print choice and shared iPhone AMS types. Immediate rollback is build 900 at `~/scan-to-make-work/mac-legacy-colour-202611041137/Counterpart.previous`; signed app and before/after receipts are beside it.

| What | Version | From |
|---|---|---|
| Mac app `/Applications/Counterpart.app` | **202611041137** | release @ `c5762972`: #306 legacy colour-choice integration, iPhone shared AMS models and all prior release work. Signed entitlements match previous development app exactly; installed idle after the pick finished and checked through actual UI Nov 4 18:48Z. Node native-module and packaged reconstruction checks pass. |
| iPhone "Davica3" (`00008150-001A488C3642401C`) | **2.0 (202611041132), Release configuration / development signing** | Source `38003639`, includes iPhone per-part AMS controls from `5864c561`. Installed Nov 4 through USB without uninstall or fixture launch arguments; exact build verified on device. Signed entitlements equal previous 1045; Sandbox APNs/CloudKit preserved. Signed app and receipts: `~/scan-to-make-work/phone-ams-202611041132/`. |
| bambu-printer-mcp (what Counterpart runs) | **Published npm 1.1.54**, installed through actual Settings → Printers → Update Nov 4 13:37Z; replaces hand-copied `587461b`. UI says Updated to 1.1.54, P1S Ready. | `~/Library/Application Support/Scan to Make/printers/bambu-1.1.46/lib/node_modules/bambu-printer-mcp/dist` |
| mcp-3D-printer-server | live dist from `56d8fb9`; source `feat/bambu-complete` now `afcf378` (new layer-pause parity not deployed) | runs from its own folder and `.env` |
| bambu-printer-mcp config | `~/bambu-printer-mcp/.env` (the ssh forced command `cd`s there): `BAMBU_DEFAULT_CONNECTION_MODE=bambu_network`, `…_TYPE=lan` | Counterpart's own environment never crosses the ssh hop |
| FULU runtime | Colima profile `bambu-fulu`, image `bpm-fulu-e2e:runtime`, plug-in **02.05.02.58** | launcher `~/Library/Application Support/Scan to Make/printers/fulu-authenticated-lan.sh` (in neither repo) |
| P1S | `01P00C4B2500106`, 192.168.68.148, firmware last recorded 01.10.00.00; David enabled **LAN Only + Developer Mode Nov 4** | AMS A1 black PLA, A2 yellow PLA, A3 PETG; current app route/credentials acceptance coordinated with MCP owner, no access code in repository |

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
   submitted at 23:32; last observed **Waiting for Review**. Build 2 includes starters and multi-plate UI. Internal group
   `Counterpart Team` exists; description and user-supplied review/feedback contacts are saved.
   External group **Counterpart Public Beta** has build 2.0 (2), submitted for Beta App Review (build 1 remains unsubmitted).
   Automatic tester notifications are off; zero testers, no email invitations. Public link created
   **https://testflight.apple.com/join/S4tExVzp**, Open to Anyone. Apple says testers cannot join
   until an approved build is in the group. Review notes now include the live Mac download/setup link and starter details.
   No tester email invitations sent. App record currently
   lists iOS and macOS drafts; do not remove the Mac platform without understanding that choice.
   Release branch is `feat/testflight-readiness` (no PR yet); public Mac release source is `fbd1a69b`; iPhone build 3 source is `4a894769`.
   `docs/distribution.md` contains the release procedure and remaining production prerequisites.
   **Latest upload:** **2.0 (3)** from `4a894769` passed distribution checks and uploaded
   successfully Nov 4 16:16:47Z; Apple reports processing. Receipt/archive/IPA/logs:
   `~/scan-to-make-work/testflight-2.0-3/`. Build 3 group assignment and external review
   submission remain unverified; build 2 above is the last observed group state. No phone install.
   **Matching public Mac update:** v2.0-beta.4, build **202611040930**, source `fbd1a69b`,
   signed for Production, notarized (submission `1f95f6b5-a85d-44b8-94a1-8aaf8b67d43e`
   Accepted), stapled and Gatekeeper-accepted. Download/setup page and signed Sparkle feed
   updated. Receipt/archive/ZIP: `~/scan-to-make-work/mac-beta-export-202611040930/`.
   It includes final main and both MCP updater/native-module fixes. Development build 900
   stays installed; no Production relay or phone changes. Fresh-install acceptance remains open.
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
   - **Production services provisioned:** complete CloudKit schema deployed and verified at 23:23,
     including `CounterpartCommand`, `CounterpartProject.openAsk` and Queryable `CounterpartEvent.type`.
     No records changed. Production `counterpart-relay` now serves `/relay/*`; its APNs probe returned
     `410 token_inactive / BadDeviceToken`, proving authentication, not phone delivery. Production key
     is topic-scoped to `com.scantomake`. Sandbox and installed development relay settings are unchanged.
   - **Mac beta published:** **0.1.0 (202611040930)**, source `fbd1a69b`, includes final main
     through #293 and the release integrations. Developer ID + Production CloudKit/APNs export
     verified, including both Node entitlements; Node/Python and USD qualifier start; eight checked
     runtime modules match. Notarization **1f95f6b5-a85d-44b8-94a1-8aaf8b67d43e** Accepted,
     stapled and Gatekeeper-accepted. [Release](https://github.com/DMontgomery40/scan-to-make/releases/tag/v2.0-beta.4)
     and [setup](https://counterpart.dtmont.com/beta.html) identify this build. Published ZIP SHA-256:
     `4447c3b7e3eede94b87a24dd53ce9511aad9d89b48d96a294693da47e2a8e627`, checked by downloading
     the release bytes. Live setup page and signed appcast match committed bytes. Cloudflare deployment
     `3b957cde-8773-4266-9f06-6a75bb45302d`. Receipts: `~/scan-to-make-work/mac-beta-export-202611040930/`.
     Notary profile `Counterpart-Production` and private Sparkle key stay in Keychain.
     The previous v2.0-beta.3 download remains available. Temporary payload and Xcode caches
     removed; retain the final archive/ZIP and compact receipts. Independent worker installer
     is qualified; fresh-install and real design/print acceptance remain open.
     No production app was installed over David's working development app. Production relay
     settings must change only when both installed clients move to Production. The actual
     Kass six-plate original was not downloaded by the browser attempt; its import remains open.
   - **FDM integration checks:** #298 merged after clean Codex review on `3971ada` and SAFE
     merge gate. Node 22/24 companion workflows pass (793 + one skip; 55 contracts each).
     Handoff workflows pass on unchanged handoff source. The API regression first reproduced
     missing structured slicer warnings on endpoint/OpenAI/Anthropic and passes after the fix.
     These are engineering receipts, not actual app acceptance. `~/scan-to-make-work/fdm-release-checks/`.
   - **Final implementation evidence:** official Linux workflow `testflight-ci-6124fb3` passes
     Node 22 and 24, each **792 companion + 55 contracts**, zero failures and one Mac-only skip.
     `78e6750` fixes the test race where a second pause matched the first pause's old event.
     Mac 147 + one skip, shared Swift 168 and two new simulator UI tests pass. Final cleanup
     paths pass two compiled-helper tests, two tool-resolution tests and the full licence workflow.
     Packaged companion rebuilt/audited; Docker starter/context smoke passes. Eight distribution
     validation tests pass on Linux. These checks do not establish physical-device acceptance.
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
4. **Both combined MCP releases published Nov 4; actual app Update/acceptance in progress.**
   The [FDM/MCP thread](t3-thread://v2/11412686-e469-46d5-8f3a-5aaa68539c60/0df403d6-0993-4ddb-8d4a-4f20d2ca9186)
   owns both integrations, merges, npm publication and Counterpart's visible MCP Update/acceptance while idle.
   Do not start a competing release or copy `dist` into the installed app.
   - **Coordination with the Linux orchestrator:** [Continue Previous Scan App Work](t3-thread://v2/9ac19334-ae37-45a2-b26d-c20726031d9e/5bc59bdb-bd02-43c6-8736-a7cff96259d3)
     owns main integration of #295/pause-at-layer/#292/#297 and remaining relay/progress fixes, MCP annotation
     follow-ups, phone picker/pause deployment, and `/v1/mcp`. This release thread retains Android/Linux,
     TestFlight/reconstruction and its release/status/distribution files. Leave their branches and live deployments
     alone; record and coordinate any proposed Mac deployment or companion restart here first.
     **Combined integration through main `a72b6d4`:** reconciled #295/#299 final changes, #292/#297,
     #302 and #303 with provider routing, Linux discovery, reconstruction, plate selection and notification
     deduplication. One FDM guidance block remains. `--allow-scripts` and main's no-printer safeguards both remain.
     Combined checks: contracts 58, handoff 116 (5 skipped), companion 824 (1 skipped), site 4 pages, Swift
     suites and unsigned Mac build passed. Removed an auto-merged duplicate PrinterSetupViews Xcode entry.
     This is source/build evidence; installed Mac remains unchanged until the recorded deployment boundary.
     **Remote MCP integration:** main `290d71fb` (#300, final head `ee3d008`) is also reconciled on release.
     Catalog/session setup now serves `/v1/mcp` with or without objects, while keeping release's provider-worker
     routing, no Claude-only requirement, Linux placeholder handling and print-gate reservations. Retained
     `source_f3d` confinement and plain support arguments. The signed `202611040557` artifact predates #300;
     this source integration does not change it or the installed app.
     **Phone controls integration:** main `9acca30b` (#301) reconciled with release plates/reconstruction.
     Uses main's final connection/MCP cards and stable pause rows (maximum 16), retaining selected-plate label,
     estimate identity and `expectedPlate`. One route handler supports main's PUT and existing Android POST
     aliases; both changes require PRINT+SETTINGS. POST MCP replies retain the refreshed catalog. Both
     `printerChoices` and legacy `printerSettings` capabilities remain, as do print-gate reservations and the
     bounded 20-second live printer check. Renamed the earlier Swift catalog-returning helper to
     `choosePrinterMcpWithCatalog` to avoid conflicting with main's id-returning method.
     Checks: companion build, 86 affected Node checks, 172 shared Swift checks and unsigned iOS Release build
     pass. Logs in `~/scan-to-make-work/phone-301-integration/`. No phone installation/UI acceptance.
     **Final main integration:** `127721fa` merged at `167b5770`; final AMS/3MF behavior, reconstruction,
     starters, provider workers and multi-plate selection coexist. The new mapped-colour Mac print path
     sends `expectedPlate` too. Combined gate on `167b5770`: 16/18 jobs pass. Licence audit found the
     two new tool folders: `3b24efcf` supplies host's declared MIT notice and records the first-party
     reconstruction wrapper under the existing pending-root-licence policy (KAN-105); both licence jobs
     then pass. Third-party runtime notices/source remain separately required. Phone UI run: 35/37 pass;
     two selectors predated the editable pause row and Live Activity label. `ab08acaf` corrects those;
     both targeted simulator UI checks and the previously skipped unsigned iPhone Release build pass.
     All application source is unchanged after `167b5770`. Branch gate reports SAFE.
     Receipts: `~/scan-to-make-work/final-main-167b5770/{gate,licence-followup,mobile-followup}`.
     Build 900 actual Mac UI receipt: `~/scan-to-make-work/combined-mac-202611040900/`; config/settings/auth
     hashes unchanged, same nine project IDs, Ready P1S, selected Codex, model render. This does not
     establish physical colour printing, fresh capture or Android/Linux pairing acceptance.
     Six completed Android/Linux task branch refs were retired after proving every head is an ancestor
     of the pushed release; exact SHAs retained in `final-main-167b5770/retired-branches.json`.
     Engineering checks: companion build and 125 focused remote/auth/updater/session/printer checks pass.
     Broader handoff/HTTP/control/provider run: 212 pass, 5 skip, one unchanged Mac worker-environment
     assertion fails because the child receives `__CF_USER_TEXT_ENCODING` (secret-leak assertion passes).
     The same model-access suite passes 17/17 on Linux Node 24.22.2. Logs retained under
     `~/scan-to-make-work/main-integration-mac/remote-mcp-*.log`; no remote-client/UI acceptance is claimed.
     Reconciliation details:
     - #295 final head `f17b72f`: preserve MCP updater `#perform` handling when all printers are removed
       (`#held`, `NO_PRINTERS`, caught fire-and-forget) and both regressions; preserve setup `#runs()` settings-folder
       ownership and its regression in objects-printers.
     - #299 final head `6d95d38`: retain PrintSheet `maxPauses` 16, unique/sorted `pauseBeforeLayers`, exclude
       pauses from saved defaults (`48f22a5`), and final control refusals/deadlines (`c4c904f`, `3c0a192`).
     - Queue receipt: main `f610034` includes #292 (`0c6125b`, head `7fbd3f2`, gate 7/7) and #297
       (`f610034`, head `f9466b4`). Preserve main's optional Claude Code/Blender/Fusion setup items alongside
       the MCP documentation links. #302 is now merged: main `d9cd9eef783e607f56b3afde366741de70067197`,
       head `697775f`, gate 11/11 and Codex clean. Remaining order: #303 orientation → #293 → #300 → #301.
       #293 Muse stopped mid-edit on quota at 12:41Z; merge owner plans to resume after 14:12Z unless David
       explicitly chooses another provider. No provider switch authorized by this release thread.
     - #302 removes `selection.connectionMode` from the handoff schema (legacy configs load with that key
       dropped) and removes HMS 0007 auto-clear. Keep both removals when reconciling release code; its current
       print.ts still has the auto-clear workaround. Do not restore it from this branch during conflict resolution.
     - #303 orientation/supports initial head `bebaa791`: replace #298's invocation sentence about lay_flat
       and discarded orientation with slicer auto-orientation/direct support forwarding (including off).
       Its `supports` schema block follows `ask`. Preserve release's provider `worker` hook when reconciling
       touchup/mcp-client/bound-fusion. Integrate from the merge owner's final main after #302. The
       "multi-colour 3MF lies the way it prints" rule belongs in #293, not #303, because main does not yet
       support that multi-colour path. This order supersedes earlier #293-before-orientation notes.
       Known limitation reported by orientation owner: Studio `orient:true` refused the stove gap filler
       with "empty layer" (KAN-223). Surface Studio's refusal; do not silently restore lay_flat or keep-pose.
       David's selected auto-orient behavior remains unchanged unless he chooses otherwise.
     - Known conflicts: PrintSheet, local-control protocol/services, objects/printers, and add/add printing/discovery.
       Also reconcile profiles/setup/server-cli, print/slice-cache, updater/printer checks and help/index.html.
     - Preserve release-only reconstruction handlers/review state and contracts, Linux Avahi/bootstrap-printer
       behavior, provider routing and starter/multi-plate work. #293 overlaps service/http/store/local-control;
       #292/#302/#301 overlap service, #292/#301 http, and #301 local-control-services. Inspect each final diff.
     Nov 4: David explicitly requested fixing live connection settings and sending the failed AirPods/Stove
     prompts. Owner yielded Mac UI and held deployments/Update. Parent found Developer Mode already selected,
     fresh saved-config MCP handshake works but live Blender Check Again fails; restarting Counterpart through
     its own Quit menu before retrying via UI. Quit did not restart the companion; after confirming no active
     jobs, parent restarted only `com.scantomake.mac.companion` via launchctl. Settings then offered Update Add-on;
     clicked it, closed Blender's untouched startup scene normally, and Check Again reported Blender set up.
     AirPods 25 mm + FDM request and Stove FDM request were resent through the actual Send buttons at
     1793790273706 / 1793790324011; both showed Working, AirPods had real Blender tool activity.
     **Deployment completed after fresh idle verification:** parent observed AirPods **Couldn't finish /
     The printer stopped**, no pending confirmation, no Working/Printing projects, and P1S **Ready** in Settings.
     Installed the already-signed `202611040557` (`4d6838f0`, includes #303 and updater fix, predates #300), retaining
     a rollback at the time; superseded by the corrected deployment below.
     Quit through the app, replaced `/Applications/Counterpart.app`, restarted only its companion (PID 83387),
     and verified retained projects and printer state through UI. All nine project IDs, settings, printer config,
     companion environment and credentials are retained; only the instance-lock owner receipt changed.
     Settings shows P1S Ready, Local network / Developer Mode selected, and Update 1.1.52 → 1.1.54.
     Explicit **SETTLED** UI handoff sent directly to MCP owner for Update; parent did not click it.
     Phone, printer operations and public appcast stayed untouched. Deployment receipts are beside the build.
     **Update attempt 13:18:53Z failed and rolled back:** owner used visible Update. The new npm flags worked:
     postinstall ran and applied the compatibility patch. Fresh MCP startup then failed loading sharp because
     bundled hardened Node has only allow-jit, and sharp's native addon has a different/no Team ID. Version
     1.1.52 remains live; no staging leftovers or print. UI returned to parent. Packaging corrected in `86467621`;
     retained isolated repro at `~/scan-to-make-work/sharp-library-validation-repro/`. No retry until rebuilt.
     Node-only packaging fix adds `com.apple.security.cs.disable-library-validation` alongside allow-jit;
     the distribution verifier now checks the signed Node's actual entitlements. Parent reproduced failure
     under the installed Node, then re-signed an isolated copy with the new entitlements: all four sharp
     loads passed and fresh npm 1.1.54 initialized. No printer commands. Receipts in
     `~/scan-to-make-work/node-native-signing/`. Rebuild/runtime notarization and real UI Update passed below.
     **Corrected build installed and UI verified:** signed development Mac `202611040628`, source `86467621` (also #300/#301),
     finished exit 0 and passed deep/strict signature verification. Its actual embedded Node passes all four
     sharp loads and fresh npm 1.1.54 initialize. Corrected standalone Developer ID Node notarization
     `89b595ea-1d8f-47f5-9641-a062fa6f1f6a` was Accepted; this is not a notarization claim for the development app.
     Parent freshly observed no active projects/pending confirmations and P1S Ready, quit through the app,
     installed the prepared bundle and restarted the companion. Actual UI again showed all nine retained
     projects and P1S Ready with Developer Mode selected. Auth, settings, companion environment and printer
     config hashes are unchanged; only the instance-lock owner changed. Receipts and immediate 557 rollback:
     `~/scan-to-make-work/native-node-mac-202611040628/`. Explicit SETTLED sent directly to MCP owner at
     13:36Z for the visible Update retry; other agents retain UI/deploy holds. No printer operations.
     **Published MCP Update accepted in actual app:** MCP owner freshly checked idle and pressed Update at
     13:37:01Z. Events: `mcp.update.started` 13:37:01.935Z → `mcp.update.done` 13:37:05.843Z,
     “Your printers use it now.” Version **1.1.54** is now live, matching npm latest (#101 / `e1fbc69`).
     UI shows “Updated to 1.1.54” and P1S Ready. New MCP PID 30636 replaced 89891; no staging leftovers.
     This closes both updater blockers through the installed app. Mac UI returned to release owner.
     Unused mcp-3D checkout remains 1.2.26, not updated; latest published is 1.2.28. No prints.
     MCP owner cleans its repro kit; parent keeps logs, new signed artifact and immediate 557 rollback,
     and removed superseded app/rollback and owned build caches. Orientation/FDM/physical print acceptance
     remains open for David's app-driven use; no automatic reprint.
     **Earlier hold, Nov 4 13:05Z:** visible Mac UI showed AirPods **Getting the print ready**, with a floating-
     cantilever warning, unchecked **Print anyway**, **Cancel Print**, and disabled **Print**. P1S shows Ready,
     but the pending print question means deployment is not idle. Parent left the decision untouched and
     notified both owners directly: no install, restart or MCP Update until David resolves it and idle is
     verified again. Combined source `4d6838f0`, signed development build `202611040557`, finished with exit 0;
     deep/strict codesign verification passed and CloudKit/APNs development entitlements match the installed
     app. Packaged runtime includes the updater script permission/lifecycle check, no-printer safeguard, FDM
     guidance and auto-orient/support forwarding. Build log/exit and payload-check receipts are in
     `~/scan-to-make-work/combined-mac-202611040557/`; superseded artifact and old rollback cleaned after
     corrected build verification. The immediate 557 rollback is retained in the newer namespace.
     Completed Linux integration snapshot (205 MB) was removed; its log is retained as
     `~/scan-to-make-work/main-integration-mac/linux-check.log` alongside the Mac check log.
     **Earlier settled handoff:** both passes were done/Ready; a fresh saved-object scan showed no touching-up or
     printing projects. AirPods monitor records ended/cancelled at 2026-11-04T11:34:23.486Z. Parent sent literal
     "settled" directly to MCP owner and merge owner. MCP owner checked the actual app idle at 12:14Z
     (P1S Ready; no Working/Printing), clicked nothing, and returned Mac UI to this release owner because
     the updater is blocked by npm's install-script policy. Revised order agreed directly with both owners:
     release owner packages/installs the combined Mac build with the updater fix first; then explicitly
     hands UI to MCP owner for Update. Other agents' UI/restarts remain held. No autonomous print/reprint.
     The recovery itself made no app replacement, config-file edit or printer start.
     At that earlier recovery the installed app predated #298; sending the FDM request did not prove new MCP
     prompt consumption. Current 628 includes the guidance; a new app-driven design remains to be accepted.
     Their incoming "releases held" note predates the authorized publications below; the publication receipts and
     revoked hold were sent back directly. The orchestrator must coordinate installed MCP Update with the FDM/MCP
     owner above, so two threads never replace the same live backend.
   - bambu-printer-mcp [#99](https://github.com/DMontgomery40/bambu-printer-mcp/pull/99),
     merged as `ff32e5e`: control route (including camera/Fusion fixes), Studio 2.9, FDM prompts and X2D route selection.
     npm **1.1.52** published at 08:06:24Z (Publish Package run `41796513132`); registry latest independently
     verified. Release/tag v1.1.52 and MCPB asset published; #95–#98 closed as released.
   - mcp-3D-printer-server [#52](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/52),
     merged as `a08c794`: controls/layer pauses, camera, selected 3MF plate parity, Studio 2.9 and FDM prompts.
     npm **1.2.26** published at 08:04:34Z (Publish Package run `41796478364`); registry latest independently
     verified. Release/tag v1.2.26 published; #49–#51 closed as released.
   - Both published packages advertise all four FDM prompts. That startup check is engineering evidence only;
     Bambu Update succeeded through the installed app at 13:37Z; physical-control acceptance remains open.
   - This TestFlight thread owns handoff/distribution/site/appcast, app packaging and Counterpart
     [#298](https://github.com/DMontgomery40/scan-to-make/pull/298), merged as `e7d5f6d` and shipped
     in Mac build 202611040120. MCP-only releases need no new iPhone build.
     Its status-doc edits were removed by the MCP owner and reconciled here. Do not replace the installed app
     during that thread's MCP update/acceptance; coordinate the later Mac upgrade explicitly.
   - **Resolved updater obstacles:** the previous hand-copied Bambu build reported 1.1.52. Newer releases exposed Update,
     but the earlier update failed at 11:34:59Z: Homebrew npm 11.20.0 skipped Bambu's required postinstall
     under allowScripts, and Counterpart retained the old copy. Latest published versions reported by MCP
     owner are Bambu **1.1.54** (`e1fbc69`) and generic **1.2.28** (`381ff87`), including support arguments.
     Parent's companion fix authorizes only the selected package with `--allow-scripts=<pkg>` on global
     Download/Update, enables foreground scripts and verifies any declared postinstall banner before swap.
     **Main backport merged:** #304 squash `f9ecff62537e1f0d0cd2813b302ee4b9c31a3398`, head `b0926e2`,
     carries the complete global install-script policy/verification and Node native-addon entitlement.
     Owner reports package/e2e/licence/Mac build passed at `e179aef`; Node 22/24 companion passed at
     `b0926e2`, whose only additional edits were updater source/tests. branch_check SAFE; Codex no major
     issues. Release `31353f57` already matches the runtime behavior; final main `127721fa` is integrated with #293, with follow-up gate receipts recorded above.
     `verify_apple_distribution.py` is absent on main, so its signed-Node check remains release-only until
     distribution tooling is integrated. No live deployment is needed for the backport.
     Review follow-up (#304 `b0926e2`): both global installs now also force `--loglevel=notice`, so a
     user's silent npm setting cannot suppress the lifecycle banner and falsely reject completed setup.
     Release build and all 32 updater checks pass; real Homebrew npm with `npm_config_loglevel=silent`
     hides the banner without the flag and shows it with the flag (setup runs in both cases). Engineering
     receipts: `~/scan-to-make-work/main-integration-mac/npm-notice-*`. This follow-up is source-only;
     installed 628 lacks it, but its actual Update succeeded with David's existing npm settings.
     Checkout `npm ci` is unchanged. Focused Linux companion build and updater checks pass (30/30);
     build 202611040628 now includes this and the Node native-addon signing fix. Actual UI Update to
     published Bambu 1.1.54 succeeded at 13:37Z; see the deployment receipt above.
     Earlier integrated source `07241c503` passed official agents-136 CI: contracts 58, printer-handoff
     108 (5 skipped), companion 811 (1 skipped), and all six Python suites; this is engineering evidence.
     MCP owner checked Settings: Developer Mode was already selected; saved credentials returned a fresh
     status at 10:37:36Z on Nov 4. No route change was needed; actual released control acceptance remains open.
     No metadata or project state was changed by this release thread. The 05:49 project has an
     uncertain print record; the updater checks app `state === printing`, print gate and live
     printer state. Resolve through the app, never manufacture an idle state in object.json.
   - **Android and Linux ownership agreed directly with the MCP thread (Nov 4): this TestFlight thread owns both.**
     David downloaded `~/Downloads/counterpart-android-debug.apk`, `counterpart-android-source.zip` and
     `counterpart-android-app.bundle`. They are three artifacts of the Android app, not starter models.
     The bundle verifies against this repository: `android-app` @ `549873a`, prerequisite `4ce8dac`.
     Preserve the originals. Integrate Android source, retain pairing/TLS pinning, and support the same companion
     protocol on Mac and Linux desktop. No other Linux desktop/server API owner is known to the MCP thread.
     The downloaded README says compiled/unit-tested only, never accepted on a device or real companion.
     HTTPS/Tailscale and events are portable; Android photo reconstruction currently calls Apple's
     `tools/mac-reconstruct`, so a Linux reconstruction path and desktop shell still need implementation/acceptance.
     Renaming Mac labels alone does not deliver Linux support. Follow actual app UI acceptance for both hosts.
     Android's four downloaded commits are integrated and pushed at `0e43a2e`. `40cc1d9` adds
     the shared starter catalog/images, multiple original-file import, plate selection/completion/reprint UI
     and `expectedPlate` dispatch protection. Linux build, 28 existing contract/client tests and lint pass on
     `agents-173`; one imported test assumed exactly two destination fixtures and now verifies decoded IDs.
     This is engineering evidence only: no Android UI or Linux desktop acceptance yet.
     Android SDK 22.0 (platform/build-tools 35) and JDK17 are on agents-173, not the space-constrained Mac.
     Build source/logs: `/home/david/scan-to-make-work/android-linux-build`; SDK: `/home/david/Android/Sdk`.
     Android terminal-print handling now stops camera polling, removes live controls/remaining-time claims,
     closes an open Stop dialog and labels retained camera images as historical. Late active reports cannot
     override terminal project/monitor evidence. Shared terminal-state vectors, assembleDebug and lintDebug pass;
     log `source/print-state-final.log` on agents-173. No Android UI acceptance (T3 emulator startup remains blocked).
     User requested Theo's TStack workflow. `/council` is installed under `~/.codex/skills/council`;
     Council reviews are complete: Opus recommended GTK/Rust, Muse Tauri/TypeScript, Sol Electron/TypeScript.
     Parent chose Tauri 2/React/Three.js with a narrow native socket bridge, Secret Service model worker and
     systemd user service. This was not a unanimous council decision. Implementation and ownership are in
     `docs/superpowers/plans/2026-11-04-android-linux.md`; separate delegates own `apps/linux` and `tools/linux-host`.
     Android now also implements copies and layer pauses, gates choices by printer capabilities, preserves sliced
     originals, and retains slice/selection refusals in the print sheet (`4ad579e`, pushed).
     Printer settings now call the existing HTTPS connection/MCP selection/update routes and show the MCP's
     own choices, refusal reasons and update events. The client updater scope was corrected to `projects:write`.
     User-facing host wording supports either desktop. Provider/device settings, installation, queued corrections,
     3D viewing and long-print background delivery still need work. Visible UI acceptance remains pending.
     T3 on agents-173 discovers `Counterpart_API35_Test`, but `device_open` exits code 1 before it comes online.
     Read-only diagnosis found that running T3 and Device Hub processes lack the newly granted `kvm` group (991).
     Do not bypass the Device panel or restart this environment while the Linux host delegate is using it.
     Reconstruction dependencies are installed separately on agents-171 in
     `/home/david/scan-to-make-work/linux-reconstruct`: COLMAP 3.12.6 (requires explicit `libposelib` package)
     and official OpenMVS 2.4.0 Ubuntu binaries, verified against release SHA-256
     `7104ae1ddd6ca38fbca9e0e4a70b20af59e21e0b497eb7181c864fbf38ca8d00`.
     Reconstruction tool source is integrated below; real-capture geometry/scale acceptance remains open.
     **Linux integration:** host `linux-host-runtime` @ `b304ec1` and desktop `linux-tauri-desktop`
     @ `25f5e17` are merged into this branch (`6d8864d`, `fd73fae`). Host state is deliberately
     `~/.local/share/counterpart` so the isolated model worker and service agree; the socket is private under
     `/run/user/<uid>/counterpart`. AppImage resources are retained by BUILD-ID so the service survives closing it.
     The installed .deb and AppImage used payload `ga41b298a488d-node24.22.2-x64`: actual Repair setup,
     connected Home, all three starters, caliper creation, native original-file import, plate selection,
     STL orbit/zoom and published generic MCP Download were exercised. No print, provider or phone pairing
     acceptance. Evidence is `apps/linux/receipts/{implementation.md,verification.txt}`; artifacts are on
     agents-136 at `~/scan-to-make-work/linux-desktop/artifacts/`. Software-rendered XFCE :93 is not physical
     desktop/GPU acceptance. Packaging materializes all npm directory links and supplies relocatable npm/npx.
     The initial missing-module and relative-Node setup errors are fixed in that installed build.
     Parent implemented the first-run phantom Bambu destination fix at `40bdf46`: retain the generated config for
     Download/Update, hide it from printer choices only while unchanged and empty. No custom SSH route is hidden.
     **Installed upgrade recovery verified:** `linux-runtime-recovery` @ `9eac0e4e` is integrated. The installed
     .deb and AppImage payload `g29f4e21f1c23-node24.22.2-x64` passed visible Repair setup: the old service PID
     changed, the applied BUILD-ID matched, projects/identity/printer tools were retained, and a second Repair
     kept the same PID. Settings no longer showed the phantom printer. Native plate selection and STL orbit/zoom
     worked; AppImage closure left its copied companion alive. Final .deb Repair restored the /usr service.
     Artifacts/receipts: agents-136 `~/scan-to-make-work/linux-recovery/{artifacts,receipts}/` and
     `apps/linux/receipts/{implementation.md,verification.txt}`. No print, pairing or credentials were exercised.
     Parent review tightened the restart guard to include `printing` (which includes preparation/dispatch),
     and to refuse malformed/unknown object states. This follow-up is not in those installed packages and has
     no active-job UI acceptance yet. Rebuild before claiming that guard works in the installed app.
     Host engineering evidence: 33 real-process checks; official CI passed at `2f6b7df` (not the final integrated
     head), focused Avahi checks passed at `b304ec1`. Integrated official CI at `40bdf46` passed contracts
     55/55, printer-handoff 108/113 (5 skipped), companion 801/802 (1 skipped), and all six Python tool suites.
     Log: agents-136 `/var/tmp/stm-ci-40bdf460e-3106419.log`. This does not verify the next rebuilt app. Desktop checks: 8 frontend, 12 Rust, 2 packaging checks;
     both extracted formats passed 60 export imports and five dependency checks. These are not app acceptance.
     Host-owned disposable account `stm-hosttest`, test packages and build cache were removed. Remaining owned
     scratch on agents-173 was retained when the cleanup guard rejected recursive deletion; do not bypass it.
     Linux capture conversion still needs Python/Pillow/usd-core distribution. Pairing defaults match the Mac;
     nearby discovery, Tailscale pairing, provider/modeling and actual printer controls remain open.
     **Reconstruction:** tool + companion integration `a641b7e` merged at `31f950b`. The exact camera v1
     upload verifies photo hashes/dimensions; a private cached reconstruction stops for region confirmation and,
     when needed, a measurement. HTTP/local-control answers bind the current review/hash; generic Ask/Best Guess
     cannot approve it. Preview routes expose only the current review. No real capture/UI acceptance yet.
     **Mac qualification integrated:** `90ac9164` is merged. `scaleQualificationRequired` in the capture
     manifest/completion forces Apple reconstruction followed by the shared region/measurement qualifier;
     iPhone captures without the flag use their existing path. ARCore metadata alone cannot qualify Apple
     geometry. Public review schemas stay unchanged. Parent made Apple raw-cache publication atomic and
     removed a project-read fallback that could silently clear the qualification flag.
     `reconstructionReviewV1` is currently tool-presence-based; runtime packaging/smoke verification is still
     required. Android `029b00fb` and Linux review UI `19af6236` are now integrated. Android binds saved JPEG
     metadata to its bytes, uploads camera metadata before its qualification-required manifest, retains originals,
     and renders region/crop/measurement review. Linux renders the same review and reads only its current preview
     through the native bounded file bridge. Both hide generic Ask while review is pending.
     Parent review fixed Android's last-frame submission/Done race and clears prior frames on Start Again;
     it also prevents restarting plain-photo capture while saves are pending. Linux measurement axes no longer
     claim world directions for an arbitrarily oriented reconstruction, and crop helpers dispose their GPU
     geometry/materials when replaced. Parent's merged-source Android build/lint and 47 tests passed on
     agents-173; Linux frontend build and 12 tests passed on agents-136. Android APK and receipts retained at
     agents-173 `~/scan-to-make-work/review-integration/artifacts/`; APK SHA-256
     `5279470750fb944ff390f1fbf3f43cddb0f9e3666586bf52ab668a34454edf3b`. No app/device installation by parent.
     Android delegate reported build/lint and 47 checks passing; Linux reported frontend 12, Rust 13 and packaging
     10 passing. Linux's installed `g0d2eb8b2d82f-node24.22.2-x64` passed native Repair and retained-project/3D
     checks; it predates the final runtime packaging. No reconstruction-review UI acceptance was demonstrated:
     the desktop imports models/photos/scan files, while handheld captures enter via authenticated phone upload.
     Android device remains unavailable after the recorded T3 emulator failure; no bypass attempted. Real phone
     capture, region/scale interaction, pairing and resulting geometry remain unaccepted on both hosts.
     Reconstruction owner proceeds with actual runtime packaging, not only the design manifest. Mac's existing
     CPython/Pillow/usd-core closure can serve qualification; Linux needs the executable reconstruction closure.
     Correct the draft dependency manifest against actual binary/source archives and existing licence inventory
     (it labels usd-core Apache-only, while the audited Mac wheel has a composite licence).
     **Runtime packaging integrated:** Muse resumed on the requested provider after its quota reset,
     merged release `9ecf47a8`, and pushed `a5346427ae18f27cded8975467f273aad833ff44`; release fast-forwarded
     to it. The old `cd0af5c8` completion did not close the review findings and was not accepted as final.
     New implementation pins .deb versions and SHA-256, rejects non-baseline libraries resolved outside
     the payload, imports Gf/Usd/UsdGeom/UsdUtils/Vt, passes probe environment, drains bounded stderr,
     and keys readiness on packaged BUILD-ID. Mac retains its existing pinned Python/USD runtime.
     Retained Linux runtime: agents-171 `~/scan-to-make-work/linux-reconstruct/final-payload`,
     BUILD-ID `reconstruction-1.2.0-ga5346427ae18-linux-x64`; manifest SHA-256
     `2039ce4bce49247d9e09ac0f3d5fd5c3eb36c8c87d6e7010383d5b5b377cc5c5`.
     Packaged synthetic samples/measurement and camera-scale paths, invalid metadata and cancellation
     passed per delegate receipts; this remains engineering evidence, not real capture or app acceptance.
     Parent `6151553e` writes Mac payload BUILD-ID from its actual source archive plus runtime manifest,
     runs packaged qualify readiness, and includes the Linux reconstruction manifest digest in host
     BUILD-ID so an embedded runtime replacement causes an upgrade. `52534ee3` updates the Mac payload
     audit to validate the identity file; 15 audit checks pass. Companion build and 29 affected checks pass.
     Mac payload preparation at `52534ee3` passed, including bundled USD module readiness and the payload
     licence audit. Payload BUILD-ID `mac-e72769e5abe0b2aa6da3f75206e2dfbf2d03c44eb24e21cc9722ba4d53f54f79`.
     Initial Linux packaging exposed dangling GCC copyright links and an unused Qt development-selector link.
     Parent `eb767494` pins gcc-16-base to retain its shared notices, rejects missing package copyright files
     and any dangling distro link, and removes only the unused qt-default selector. Rebuilt runtime
     `reconstruction-1.2.0-geb7674946d04-linux-x64` passed all 66 .deb hashes, strict closure and relocated check.
     **Both Linux packages built and extracted-runtime verification passed:** app/host source `eb767494`,
     host BUILD-ID `geb7674946d04-node24.22.2-x64-r4c6014f501e9`. AppImage initially failed because
     linuxdeploy could not locate the wheel-private TBB dependency; packaging-only `28db39e8` supplies
     bundled library paths to its scanner. Final artifact bytes, not the pre-bundle tree, passed 64 exports,
     5 internal dependencies, npm/npx 11.19.1, reconstruction identity and samples readiness (USD modules,
     COLMAP and all three OpenMVS tools) under env -i. Validator is committed in `3bda30f2`.
     **Refreshed final-main packages:** app/host source `167b5770`, BUILD-ID
     `g167b5770a75d-node24.22.2-x64-r4c6014f501e9`, preserving the verified `eb767494` reconstruction runtime.
     Both actual extracted package formats again pass the runtime/import/npm/reconstruction checks.
     Current deliverables on the Mac: `~/scan-to-make-work/final-main-167b5770/artifacts/`:
     - `Counterpart_0.1.0_amd64.deb`: SHA-256 `5ccd136b05a5131b787484ab7913e89862b4ddb068cab2484ca2304f0684e290`.
     - `Counterpart_0.1.0_amd64.AppImage`: SHA-256 `85833200104092cb5fcafa9c5aecbab2b51ac3802f87570df160ce408cde2d80`.
     - `Counterpart-debug.apk`: source `3b24efcf`, SHA-256 `5279470750fb944ff390f1fbf3f43cddb0f9e3666586bf52ab668a34454edf3b`;
       Android 47 checks, build and lint pass. Debug-signed; no Android device acceptance.
     Remote logs: agents-136 `~/scan-to-make-work/final-release-167b5770/` and agents-173
     `~/scan-to-make-work/final-android-3b24efcf/`. Owned Rust/frontend/Gradle caches removed, artifacts retained.
     Earlier pre-final-main artifacts: agents-136 `~/scan-to-make-work/reconstruction-release-6151553/artifacts/`:
     - `Counterpart_0.1.0_amd64.deb`, SHA-256 `f80433771942eaf2e634501e63865b61385c70405826b86387720130fa33c36b`.
     - `Counterpart_0.1.0_amd64.AppImage`, SHA-256 `40a16ad1da3a18feea4be139c6a05eda9970231feb6d3349109fb321cb810ac7`.
     Full receipt `verify-final-packages.log` and build logs remain beside artifacts; generated Rust/frontend
     caches, duplicate resources and extracted verification trees were removed. New reconstruction runtime
     retained for reuse; Muse's agents-171 artifact untouched. Mac generated payload removed after its receipt.
     Nothing installed or restarted. Genuine phone-capture region/scale UI, Android/device pairing and
     physical desktop acceptance remain open; package checks are engineering evidence only.
     #293 is now integrated from final main `127721fa`. No further Muse implementation requested; retained artifacts stay.
     Synthetic geometry retained a support disc until explicit region choice; one OpenMVS run crashed then
     succeeded on retry. Neither result establishes real capture quality or automatic print readiness.

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
7. **Bambu Cloud printing is refused:** `net.start_print` -3120 (`PRINT_SP_POST_TASK_FAILED`), HTTP 403 "internal blocking",
   every time. **Nov 4 finding:** Bambu Studio never sends this printer through `start_print` first. For a cloud-bound printer
   with an IP, access code and SD card it sends `start_local_print_with_record` (LAN upload, task recorded in the account),
   and `start_print` is its fallback (`BambuStudio/src/slic3r/GUI/Jobs/PrintJob.cpp:812-846`). So a Studio cloud print
   is not a like-for-like comparison. **Fix, PRs open, not merged or installed:** bambu-printer-mcp
   [#102](https://github.com/DMontgomery40/bambu-printer-mcp/pull/102) (1.1.55) and mcp-3D-printer-server
   [#56](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/56) (1.2.29). With no method given, a cloud print
   sends with record in the cloud session, then `start_print` only after a `-2010`…`-2140` failure (before the print command).
   Full suites pass (1036/0/11 and 713/0/6). **Still to do:** accept on the P1S from the Mac app with Connection = Bambu Cloud.
   With record also POSTs a cloud task (`-2120` if refused), so it may still get the 403. Two other reported causes:
   request content ([OrcaSlicer #13277](https://github.com/OrcaSlicer/OrcaSlicer/issues/13277): Studio worked where
   Orca was refused) and a VPN's malware/tracker filter (NordVPN Threat Protection is on). On Nov 4 the Mac's MCP `.env`
   is `BAMBU_DEFAULT_CONNECTION_MODE=lan_mqtt_ftps`, `…_TYPE=lan`.
7a. **A change request can stall silently:** the Vivi pick's "Design again with the new prompts" (10:27, 10:32, 10:33
   Nov 4) took `service.ts:972-976` ("couldn't tell whether it marks Done") three times, so no pass ran.
   `completion-intent.ts` turns every `claude -p` error or 20 s timeout into `unknown` and logs nothing. Over ssh the CLI
   says "Not logged in", but that is the locked keychain (the credential item was refreshed 06:19 Nov 4), so the
   companion's real error is still unknown.
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
    **Nov 4 camera recurrence, origin identified:** current phone build 202611041045 initially showed a
    live Object Capture preview at 10:45:43 Mountain (17:45:43Z), then went black. At 10:46:02.432,
    the Mac's **Xcode Device Hub** PID 60487 started CoreDeviceScreenSharing session
    `284E2BCE-BBAA-488A-AF2E-26849445EC71`; the phone's matching session was followed at
    10:46:02.804 by cameracaptured explicitly reporting “The continuity display is connected. Will
    start blackening frames” for the rear camera, LiDAR and ultra-wide streams. Executable verified:
    `/Applications/Xcode.app/Contents/Applications/DeviceHub.app/Contents/MacOS/DeviceHub`.
    This is not T3's Device panel or the iPhone Mirroring app. Native Mac UI showed Davica3 selected.
    Release owner quit that viewer through **Quit and Keep Simulators Running**, verified its exit,
    and read-only display info now lists only the phone LCD (no Wireless display). David then confirmed
    **both Apple Camera lenses work**. No camera source fix is claimed: capture files are unchanged
    from `f03580e` to `a26be565`. **Camera lifecycle acceptance PASSED on build 202611041045:**
    David operated Counterpart → New Project → Scan it, left the preview open for 30 seconds, tapped
    Close, then checked Apple Camera front and rear. His result: “Preview stays live; both cameras work
    afterward.” USB-only `viewer-off-live.log` / `viewer-off-camera-excerpt.log` recorded camera processing
    with zero continuity-display blackening events. Owned logger is stopped. This accepts preview/cancel
    and camera recovery with the viewer off. Theo/T3 workflow warning filed per its Ideas policy:
    https://github.com/pingdotgg/t3code/discussions/31054 (Xcode-origin evidence, no claim T3 opened it).
    **Real scan received Nov 4:** David completed capture and sent it from the phone. Object
    `ba9346cd-e650-4e78-8cce-5ba7207b8122` contains the 2,106,941-byte original `scan/scan.usdz`
    and 23 photos. Actual Mac UI shows Your scan → Fixing the scan. First Codex pass at 18:05Z failed
    with “Codex did not return a valid project result”; this is an open provider acceptance failure,
    not a capture/upload failure. The subsequent Claude pass started 18:07:07Z and reached Blender,
    identifying the object as a Leatherman Wave+. **Claude cleanup completed 18:18:06Z** (about 11 min).
    Actual installed Mac UI opened the result, now titled **Leatherman Wave+ replica**, Ready to print,
    and rendered `current/model.stl` at 102.6 × 36.0 × 20.6 mm. This confirms the user-operated
    capture → transfer → cleanup → displayed model flow. Geometry/scale acceptance remains open:
    the pass assumed a flat unphotographed underside and straight lower sidewalls, retaining scan scale.
    No print was initiated. Codex's initial invalid-result failure remains unresolved.
    No printer action, companion restart or provider-setting change was performed by the release owner.
    **iPhone AMS parity installed (Nov 4):** #293 originally added per-colour controls only to Mac.
    Muse child `428fc779-7752-4874-8a67-8dedf20b7615` implemented iOS/shared-client parity at
    `5864c561`, merged into release as `38003639`. Signed Release **202611041132** built under
    the Apple lock, installed over 1045, and verified with read-only device app info. No uninstall,
    fixture launch, screen viewer or print. Body/letters rows use the existing mapping API and send
    exact spools/model version in estimate and Print; plate/pause/copies and #306 question UI preserved.
    Engineering: child CounterpartKit 174, ControlKit 52, Mac and phone compiles passed; parent signed
    Release build passed with exact prior entitlements. **iPhone controls accepted by David:** he
    confirmed the body/letters selections work and started the print himself. Saved dispatch has
    AMS mapping `[0, 1]`; final physical colour result still pending. Fresh pick has current/model.3mf
    and separate body/letters filament records.
    Source branch and clean worktree removed after integration; owned parent DerivedData removed,
    signed app/logs/receipts retained in `~/scan-to-make-work/phone-ams-202611041132/`.
    David reports a physical print completed with WRONG AMS colours and the plate is now clear.
    Merge owner `5bc59bdb` has been asked to coordinate the existing AMS/MCP owners on that print's
    backend receipts (last observed project Guitar pick `a2bfa85a-9700-495d-a86c-d4c6d521502e`).
    Root cause established by that owner: pre-#293 design retained only the merged STL; its two colour
    3MFs stayed in old pass output under noncanonical names, with no current filaments/model.3mf.
    The actual slice/dispatch was one black body/tray 0, so no MCP mapping bug is established. Owner
    merged #306 as `5d4429b0`: producing-pass-bound legacy colour-loss explanation and explicit
    remake/one-colour choice; no automatic adoption of ambiguous outputs. Release integrated main
    as `c5762972`, preserving starter/plate/provider and reconstruction work. Signed Mac build
    **202611041137** succeeded with matching installed app entitlements, both Node entitlements and
    packaged reconstruction qualification checked. Official `stm-ci c5762972` passed all suites
    (58 contracts, 125 printer-handoff plus 5 skips, 886 companion plus 1 skip, and Python tools).
    These are engineering checks. **Installed after the pick completed**, at 18:48Z; actual Mac UI
    shows Guitar pick Printed and P1S Ready, with all ten project files/settings/auth unchanged. Receipt/build:
    `~/scan-to-make-work/mac-legacy-colour-202611041137/`.
    **User-started colour print active:** bundle `e592f12e-e5a0-4821-9f56-2cdacb8d6f5e`, dispatched
    18:34:41Z, uses current/model.3mf and AMS mapping `[0, 1]`; actual Mac UI at 18:40Z shows
    Printing and P1S Busy. It finished before the 18:48Z deployment: actual UI Printed/P1S Ready.
    Parent initiated neither design nor print. iPhone menu/selection acceptance is confirmed by David;
    physical colour result remains open. No reprint. David also reports another Device Hub use;
    read-only check at 11:15 MST found no Xcode DeviceHub process or events in its previous 8 minutes.
    David clarified this was an iOS lock-screen/Settings notice saying the device was viewed through
    Device Hub, not an observed agent tool call or reopened Mac window. USB read-only display info
    after that notice still lists LCD only. Retained phone logs spanning 11:01:55–11:16:51 MST contain
    no dtremotedisplayd/CoreDeviceScreenSharing/blackening event in that interval. A delayed earlier-session
    notice is plausible, not proven; no new viewer or responsible agent established. Evidence retained in
    `camera-recurrence-20261104/ios-notice-*` and `displays-after-ios-notice.json`.
    **David's clarification supersedes the blanket “never” instruction:** Device Hub, mirroring,
    recording, T3 device tools and devicectl are not banned. Be aware of which viewers and connections
    are attached while camera/scanning work runs: a continuity display can blacken camera/LiDAR frames.
    Account for that interference before diagnosing an app bug; use viewer-free physical operation and
    USB logs when isolating capture behavior. Earlier persistent-black-camera incidents include an
    unknown cause; this session does not explain every incident. Coordinate shared phone use with the
    current acceptance owner. Correction relayed to the merge/phone owner and iOS implementation child
    for onward delivery to their recipients. No permanent prohibition belongs in AGENTS.md or memory.
    Private logs and retained archives (not committed):
    `~/scan-to-make-work/camera-recurrence-20261104/`, especially `mac-coredevice-trigger.log`,
    `blackout-trigger-all.log`, `current-repro-retained.logarchive`, and `displays-after-devicehub-quit.json`.
14. **Caliper card** (`KAN-209-caliper`, unmerged; evidence `~/scan-to-make-work/caliper/`): rename to Counterpart,
    docs QR → `https://counterpart.dtmont.com/`, put each vernier digit under its own line, then print the two-colour
    3MF. `tools/caliper/LICENSE` had an uncommitted GPL-3 → Apache-2.0 switch. The no-AMS variant can now use
    `pause_at_layers`.
15. **Starting a file already on the printer's SD card** without reslicing: offered to David, not built.
16. **The whole MCP toolset, remotely, through the companion: `/v1/mcp`** (from David's Claude Duet chat, Nov 3).
    The goal is that a remote Claude session (or any MCP client) can use *everything* both MCPs do, through the
    companion's existing front door, not a second one.
    - **Built, not deployed (Nov 4, branch `feat/remote-mcp`):** design in
      [`../design/remote-mcp.md`](../design/remote-mcp.md); pairing and connecting in
      [`../tailscale-setup.md`](../tailscale-setup.md#remote-mcp-clients-v1mcp). It covers:
      - `/v1/mcp` (`current`) and `/v1/mcp/<destinationId>` on each destination's shared session;
      - scopes `mcp:read|design|control|print|raw`, with `pair-mcp` to grant them;
      - path confinement to `<bundle store>/remote/<deviceId>/`;
      - remote questions tagged with the device, cancelled at once until a screen shows them.

      Loopback tests: `services/companion/tests/remote-mcp.test.mjs`.
    - **Blocks real use:** on Nov 4 the Mac had **no Tailscale** and the companion was LAN-only (its certificate names
      only `192.168.68.123`). A cloud session has no path in until David picks one: Serve mode, a subnet route, or a
      certificate that names the tailnet address. Open questions are listed at the end of the design doc.
    - **What exists, read it first:** the companion already sits behind **Tailscale Serve** with per-phone pairing
      and revocation (`docs/tailscale-setup.md`); NET-001 (team vote, Oct 14) ruled out **Funnel**. So "Funnel in
      front of each MCP's HTTP mode" is the wrong answer here, and so is a separate WireGuard/wstunnel path for the
      app itself. `remote-auth-cli.ts pair-printer-handoff` mints a token scoped to printing and health.
    - **The gap:** `/v1` reaches about a dozen MCP tools out of 54 in bambu-printer-mcp and 42 in
      mcp-3D-printer-server. Pause, resume, stop, temperatures, fans, lights, speed, AMS and drying, files, skip
      objects, clearing HMS errors, and the MCPs' own prompts and resources are not reachable remotely.
    - **Design:** one Streamable HTTP endpoint, `/v1/mcp`, behind the same Serve, allowed login and pairing, passing
      both MCPs through as they are. Reuse `PrinterSessionPool`, `remote-auth`, the MCP SDK and mcp-proxy's pattern.
      New parts only: per-device **scopes** (read, control, print, design; raw RPC off by default), file paths confined
      to the bundle store, and print confirmations still routed to David's phone, so a remote session can't approve
      its own print.
    - **Step 1, in both MCPs:** scopes key off each tool's `readOnlyHint` / `destructiveHint` annotations, and both
      MCPs annotate only a few tools today. Annotate every tool in both.
    - **For a cloud Claude session (Duet) to reach it:** that environment's network allowlist refused Tailscale's
      control and relay hosts. With those hosts allowed and an **ephemeral** auth key in the environment settings
      (never in chat), the session runs `tailscaled` in userspace, joins the tailnet like a device, pairs with a scoped
      token, and uses `/v1/mcp`. Other users without Tailscale would need a connector route later (OAuth pairing code,
      optional hosted relay); not started.

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
- FDM design guidance lives in both MCPs as `fdm_design`, `fdm_multicolor`, `fdm_assembly`, `fdm_after_slice`
  prompts and a resource. Counterpart fetches `fdm_design` for design and copy passes; the guidance is maintained
  in the MCPs, not duplicated in the app. Developer notes: `docs/design/fdm-prompt-pack/` in #298.
  The combined MCPs and #298 Mac payload are published; actual app acceptance remains next.
  Acceptance means New project / Ask for changes through Counterpart, with the published MCP providing guidance.
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
- **MCP deploy:** publish the reviewed package, then use Counterpart's own Download/Update controls while idle.
  Verify the app runs that published version and accept through its visible controls. Do not hand-copy `dist`.
  The Mac has no GitHub credentials: push from a Linux box (`git fetch <mac worktree>` then push).
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
