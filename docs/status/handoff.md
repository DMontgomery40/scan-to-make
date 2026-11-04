# Handoff: Counterpart

The one handoff. Update this file in place when you stop; never add a numbered or dated copy, a prompt file,
or a "continuation" section on top. Git history has every older version.

Last device verification: **2026-11-03, 20:27 Mountain**. **Resume, Pause and Stop now work from the Mac
Counterpart UI through FULU**, confirmed by the P1S's correlated replies and observed state changes.
The printer remains cloud-bound, Developer Mode off. The test pick is stopped; the app shows the printer Ready.
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
   until an approved build is in the group. Review notes now include the live Mac download/setup link and starter details.
   No tester email invitations sent. App record currently
   lists iOS and macOS drafts; do not remove the Mac platform without understanding that choice.
   Release branch is `feat/testflight-readiness` (no PR yet); release source is `e7d5f6d`.
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
   - **Production services provisioned:** complete CloudKit schema deployed and verified at 23:23,
     including `CounterpartCommand`, `CounterpartProject.openAsk` and Queryable `CounterpartEvent.type`.
     No records changed. Production `counterpart-relay` now serves `/relay/*`; its APNs probe returned
     `410 token_inactive / BadDeviceToken`, proving authentication, not phone delivery. Production key
     is topic-scoped to `com.scantomake`. Sandbox and installed development relay settings are unchanged.
   - **Mac beta published:** build **0.1.0 (202611040120)**, source `e7d5f6d` (#298), contains
     MCP FDM guidance and the structured-result fix for API workers. Developer ID + Production
     CloudKit/APNs export verified; Node/Python start; all five changed runtime modules match.
     Notarization **6fa11899-18fc-4671-91c1-388f50ccb7dd** was **Accepted**, stapled and
     accepted by Gatekeeper. [Release](https://github.com/DMontgomery40/scan-to-make/releases/tag/v2.0-beta.3)
     and [setup](https://counterpart.dtmont.com/beta.html) identify this build. ZIP SHA-256:
     `88557aa0bd97bc696c3bc3beceef2c21f78c2338b3fe4c3a3eca11334a95288e`.
     Artifacts/receipts: `~/scan-to-make-work/mac-beta-export-202611040120/`.
     Notary profile `Counterpart-Production` and private Sparkle key stay in Keychain.
     The previous v2.0-beta.2 download remains available. Temporary payload and Xcode caches
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
     installed app Update/visible-control acceptance remains with the MCP owner.
   - This TestFlight thread owns handoff/distribution/site/appcast, app packaging and Counterpart
     [#298](https://github.com/DMontgomery40/scan-to-make/pull/298), merged as `e7d5f6d` and shipped
     in Mac build 202611040120. MCP-only releases need no new iPhone build.
     Its status-doc edits were removed by the MCP owner and reconciled here. Do not replace the installed app
     during that thread's MCP update/acceptance; coordinate the later Mac upgrade explicitly.
   - **Installed updater obstacle:** the hand-copied Bambu build already reports 1.1.52, so the
     version-only comparison hides Update for genuine npm 1.1.52. MCP owner presented metadata
     relabel / new npm version / updater change options to David; his choice is pending.
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
     No Linux reconstruction source integration or geometry/scale acceptance yet.
     Linux host delegate hit Claude's rate limit, with a clean `linux-host-runtime` branch at `d640c07`
     (`5d38205` helper, `76e17b2` companion portability, `d640c07` payload script), worktree
     `~/.t3/worktrees/scan-to-make/t3-6dc7974b`. David used his banked Claude reset; the same Opus delegate
     resumed implementation. Muse Wonder Full 1.0 is separately researching reconstruction and metric-scale design.
     Its agents-173 payload build compiled the Rust release helper but failed npm extraction with errno -122
     in `/tmp` (tmpfs/quota). The UI delegate's independent agents-136 build succeeded: 210 MB, BUILD-ID
     `gd640c07bd9a3-node24.22.2-x64`, at `~/scan-to-make-work/linux-desktop/app/src-tauri/resources`.
     Log: `~/scan-to-make-work/linux-desktop/receipts/payload-build.log`; Tauri release linked, packaging and
     visible setup/starter checks continue. This is not host acceptance. Further builds use an owned `TMPDIR`
     under `/home`. Failed-build source/log: `~/scan-to-make-work/linux-host/{repo,prepare.log}` on agents-173.
     The first .deb and AppImage built, and the UI owner installed the .deb and clicked Set up this computer.
     Setup failed with "Counterpart could not list this computer's network addresses". Parent reproduced the
     underlying read-only import failure: installed Node cannot find `@scan-to-make/contracts`; all three
     companion workspace links exist in prepared resources but `node_modules/@scan-to-make` is absent from
     the installed package. UI owner reports this fixed in BOTH rebuilt .deb and AppImage by materializing npm
     directory links and providing relocatable npm/npx launchers; extracted packages pass 60 export imports and
     five internal dependency checks. After reinstall, the actual setup button passed address discovery and created
     the service. The next blocker is host-generated `printer-handoff.json` with relative `process.command='node'`,
     rejected by the absolute-path schema (`config.js:80`, retained `companion-error.log`). Sent to the host owner
     to fix source and coordinate a rebuilt helper/UI retry. No hand-edited installed configuration or connected-app acceptance.
     The delegate created disposable account `stm-hosttest` (UID 1001) with lingering enabled for pending
     runtime checks; remove only after its owned checks and service cleanup. No real host acceptance yet.
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
