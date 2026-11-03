# Handoff: how to pick up Counterpart work

## Continuation — 2026-11-03, about 02:10 Mountain (Claude, second session of the night)

**Result: the P1S refuses controls from FULU's plug-in over both routes.** Through the real Mac app on the
real printer (firmware 01.10.00.00, cloud-bound, not LAN-only/Developer mode):
- Pause over **Bambu Cloud** (01:59 Mountain, 08:59Z): cloud session up, printer connected, first send -2
  (CONNECT_FAILED, certificate still installing), retry after `device_cert_installed` accepted (code 0), then the
  printer's signed reply `{"command":"pause",...,"err_code":84033546}` (0x0502400A) — the same refusal it gives
  over the local network. The app showed "The printer didn't pause: … refused Pause over Bambu Cloud" and the
  printer kept printing. So the earlier theory "cloud is how Studio controls this printer, so cloud will work"
  is false for this client.
- **Cloud printing is refused too:** three Print presses on the cloud route failed with -3120
  (`BAMBU_NETWORK_ERR_PRINT_SP_POST_TASK_FAILED`): both uploads reached 100%, then Bambu Cloud answered the
  create-task request with HTTP 403 "internal blocking". status.bambulab.com showed no incident. Sending the
  `ams_mapping_info` Bambu Studio sends did not change it.
- Common factor: FULU's runtime (and FULU's current source) loads Bambu's network plug-in **02.05.02.58**;
  Bambu Studio on this Mac is **02.08.02.61**. Leading explanation: Bambu's printer/cloud reject that client.
  Not proven. The one test that would separate "this client" from "this account/printer" is a cloud print from
  Bambu Studio itself; not run (it puts a print on the bed outside Counterpart).
- **Printing over the local network works** (01:46 Triangle pick, 6 copies, started from the app, finished).

**Update ~11:15 Mountain.** #294 merged (`6109c1c`). PR #295 `feat/add-printer` (head `ac5e38b`, local CI 13/13):
both MCPs listed and downloadable, **Add Printer…** (found MCP folders run in place, SSDP, Bonjour; dropdown form; Check;
`printers/profiles.json` + per-printer `.env`), per-printer **Printer MCP** choice, **Complete Settings** smart fill.
Accepted in the real app (build 202611031100): found `~/mcp-3D-printer-server`, switched the P1S to it, filled
`BAMBU_MODEL='p1s'` into its `.env`, estimate 8 min · 1 g through it. Not yet printed through it.
- mcp-3D-printer-server (Mac checkout `~/mcp-3D-printer-server`, now **detached at `1602be2`** = branch
  `integrate/counterpart`, pushed): `5e6f70e` Bambu printers default to Bambu Studio (David chose this: FULU
  OrcaSlicer-bambulab v1.0.0's CLI segfaults on every slice, FULU #56/#57 unreleased), `a23a286` relative TEMP_DIR
  resolved, `1602be2` ordinary prompt + bed check removed (also on `fix/no-ordinary-confirmation-v2` `cf373d7`).
  Its local `main` was 38 commits behind origin (1.2.17 vs 1.2.25): fast-forwarded. `.env` is back to David's
  original plus `BAMBU_MODEL='p1s'` (added by Complete Settings).
- In progress (delegate, David chose "Make it complete"): `feat/bambu-complete` in worktree
  `~/mcp-3D-wt-bambu`: Bambu AMS inventory + tray choice, Pause/Resume/Stop, FULU authenticated route and
  `counterpart_print_route`, ported from bambu-printer-mcp. Needed before a print through mcp-3D on this P1S
  (plain MQTT prints are refused without Developer mode; it prints from the external spool without AMS).
- Installed FULU OrcaSlicer-bambulab v1.0.0 (official universal DMG, sha256 71947959…) at /Applications/OrcaSlicer.app.
- bambu-printer-mcp PR: origin/main is still 1.1.51 (#94); the branch carries 1.1.52 (already on npm) and the
  WIP commit `7146550`. A PR needs a clean rebase, CHANGELOG, the code-review gate and attribution stripped
  (4 commits have Co-Authored-By); merging publishes to npm (held). Not opened.

**Changed in bambu-printer-mcp** (`feat/one-printer-control-route`, pushed at `94d995a`; built and tested in the
worktree `agents-136:/tmp/bpm-cloudctl`, branch `integrate/control-route`). Full `npm test` 1004 pass / 0 fail / 10 skip:
- `57c980a`: FULU PrintParams carry Bambu Studio's `ams_mapping_info`; safety-dispatch stubs the cloud session
  (e7d442a had broken 10 bridge tests).
- `8703eb5` (delegate): the ordinary print/heating/verified-resume prompt and `BAMBU_REQUIRE_CONFIRMATION` are gone
  (David, Nov 3, repeatedly: "useless friction, Bambu does those checks on its own"). Hardware-error clears and
  unverified resumes still ask.
- `815551c`: a cloud control retries on -2/-4 after reinstalling the certificate.
- `2ce5acd`: docs/FULU.md: CA bundle for a containerized host; the -3010/-3120/0x0502400A rows.
- `94d995a`: `counterpart_print_route` reads/changes the route in the running server and its `.env`.
- Before any PR: squash away the `7146550` Co-Authored-By (the MCP repo forbids AI attribution).

**mcp-3D-printer-server:** has the same ordinary prompt (`PRINT_REQUIRE_CONFIRMATION`/`BAMBU_REQUIRE_CONFIRMATION`)
plus a FINISH bed-clearance prompt (PRD §5.6: no bed check). A delegate is removing both on
`fix/no-ordinary-confirmation` in the Mac checkout `~/mcp-3D-printer-server` (not pushed yet).

**Counterpart:** PR #294 `feat/printer-route-setting`: Settings → Printers "Connection: Local network / Bambu Cloud"
through the MCP's `counterpart_print_route`; the leftover `selection.connectionMode` copy is ignored and was removed
from David's `printer-handoff.json`. Accepted in the real Mac app (build 202611030245): Cloud and back, each written to
`~/bambu-printer-mcp/.env`. Local CI 9/9 at `3b97086` after the review fixes; hosted Actions have no runner (also on main).
In progress (delegate, branch `feat/add-printer` stacked on #294): both MCPs downloadable from Settings, **Add printer…**
with auto-detection (configured MCP folders such as `~/mcp-3D-printer-server`, Bambu SSDP, Bonjour), Check before save,
and a per-printer MCP choice. Payload trap: after any companion commit run `apps/mac/scripts/prepare-payload.sh`
before building the app, and grep the built payload for the change.

**Installed on the test Mac** (rollbacks in `~/scan-to-make-work/claude-route-20261102/`, every step in
`deployment-boundary.txt`):
- Mac app 202611030245 (Counterpart `0cdb625`); rollback `Counterpart-202611030005.app.rollback`.
- MCP dist from `94d995a` (`index.js`, `bambu-network-bridge.js`, `printers/bambu.js`, `counterpart/route.js`) plus
  `ams-mapping.js` and `safety/print-file.js` from 57c980a; rollbacks `bambu-rollback-e7d442a/`, `bambu-rollback-pre-integrate/`.
- `~/bambu-printer-mcp/.env`: `BAMBU_REQUIRE_CONFIRMATION=0` (backup `bambu-mcp.env.before-noconfirm`); route on
  **lan** (cloud prints are refused).
- Stopped an orphaned FULU container (bd9bff281b33).

**Open for David:** LAN-only + Developer mode is the only untested printer-side option for Stop/Pause/Resume; or a
Bambu Studio cloud print as the comparison for -3120. Review items 22–28 are in `app-review-2026-11-02.md`.

## Continuation — 2026-11-02, about 23:15 Mountain (Claude took over from Codex)

**Architecture finding:** bambu-printer-mcp is Counterpart's printer backend; a bug there is a bug in the
app, fixed once in the MCP. The MCP printed over `BAMBU_DEFAULT_CONNECTION_MODE` but `cancel_print`,
`pause_print` and `resume_print` ignored it. A FULU print got plain-MQTT Stop/Pause, which protected
firmware rejects (HMS 0500_0500_0001_0007, Bambu's own "update Studio or Handy" text). Counterpart had
compensated with its own route copy: `selection.connectionMode` threaded into every print_3mf, a tool-schema
guard, and #290's Stop threading.

**Changed:**
- bambu-printer-mcp `feat/one-printer-control-route` @ `c03a9bb` (on top of Codex's `4243272` and `b1ac31a`). One
  `resolveConnection` for print_3mf and every control; Pause/Resume use the authenticated FULU LAN session like
  Stop; adds and documents `BAMBU_DEFAULT_CONNECTION_TYPE`. Full suite 994 pass, 0 fail, 4 skip. Pushed, no PR, not
  released. FULU's own host manifest lists `set_on_message_fn` as implemented (b1ac31a's callback).
- Counterpart PR #291 `feat/mcp-owns-print-route`. Prints and controls carry no route; removes the
  schema guard and #290's threading. Full companion workflow passed on Node 22 and 24 at `be3e20c7`.
- The MCP's real config is `~/bambu-printer-mcp/.env`: the ssh forced command `cd`s there and dotenv loads it.
  Environment set by Counterpart never crosses the ssh hop. Added `BAMBU_DEFAULT_CONNECTION_MODE=bambu_network` and
  `BAMBU_DEFAULT_CONNECTION_TYPE=lan` there; other settings unchanged. Private backup in the evidence folder.

**Installed at about 23:07 (disclosed deployment, printer idle):** Mac build `202611030005` from `be3e20c7`; MCP
1.1.52 plus the `c03a9bb` dist/src files. Counterpart was quit and relaunched; the companion was restarted twice, once for
the app and once after the `.env` change. FULU and Colima untouched. Preservation receipt unchanged (6 projects, 7
pairings). Rollbacks: `~/scan-to-make-work/claude-route-20261102/` (`Counterpart-202611022325.app.rollback`,
`bambu-rollback/`, `bambu-mcp.env.before`).

**Not accepted:** Stop/Pause through the real app UI on a real print has not been run since this install.
Whether the FULU `-4` was the route, the certificate readiness, or something else is unknown until then.

**Still in the map, not yet changed:** `print.ts` auto-clears HMS 0007 (a workaround for the route bug), `PrintingView`
hardcodes the same code, and `mcp-client.ts` resets timeouts on progress but drops it. `counterpart.ts` re-maps
`get_printer_status`, and `print.ts` orchestrates lay flat/slice/inspect around print_3mf, which also slices. Print state
lives in object.json, the event feed, CloudKit and Live Activity tokens. `selection.connectionMode` still exists for the HMS
check and Bambu Connect detection; it should come from the MCP. Codex's unfinished terminal-event branch is preserved as
`git stash` "codex WIP: print-state-delivery" and `codex-stop-continuation-20261102/codex-print-state-delivery-wip.patch`.

## CRITICAL continuation — 2026-11-02, about 22:17 Mountain

This section supersedes optimistic acceptance statements below. David requested a handoff;
implementation and deployment stopped. **No Stop fix or new phone error UI is installed.**

### Non-negotiable testing boundary

David repeatedly required actual UI testing: phone taps or Mac computer use → Counterpart →
its existing MCP → printer. The agent violated the intent by first trying standalone MCP
printing and later restarting the dedicated FULU runtime outside Counterpart to recover
connectivity. The subsequent UI print therefore depended on manual intervention and **does
not establish a self-sufficient product**. Do not repeat this or call it accepted.

No direct control helper/MCP/SSH/Studio printer dispatch or stop as an app test. No hidden
runtime restart, process kill, configuration repair, state injection or simulated completion
while testing. Read-only logs and source diagnosis are allowed; unit tests are supporting
engineering checks, never app acceptance. Software fixes still need an explicit, recorded
build/deployment boundary; do not disguise a runtime repair as deploying a fix. Do not ask
again for already-granted print permission or a manual bed check. David explicitly wants
**this print stopped by hitting Stop in Counterpart after fixing the app**. He withdrew his
idea of stopping it manually. Do not stop it by another route.

### Actual failures at handoff

- Mic mount print `88ebb9f5-1811-448f-aacd-c989ee7c5c9c` was still running. Actual Mac UI read
  approximately 49%, 22 minutes remaining. Recheck: it may finish before continuation.
  Project `7f157a66-90a1-4c16-97ef-b97e06cb3c77`; printer job
  `checked-cd44095c-b6f7-4a00-adfb-054a94658c22-clean_flat_sliced`.
- David's Stop attempt failed. Phone and persisted printer reports showed HMS
  `0500_0500_0001_0007`, MQTT command verification failed. Print used authenticated FULU;
  the installed P1S Stop route used ordinary MQTT. Stop remains broken.
- The Mac also showed repeated “Pause sent.” entries at 22:12–22:13 while still printing.
  The agent did not initiate those Pause actions. Do not invent their actor or call them
  successful. The pending patch covers Stop only; Pause/Resume remain unaudited/unfixed.
- David reports the real Lock Screen activity still says **Mic mount, 0%, “Waiting for an
  update”**, while app/printer progress advances. Real-print Live Activity state synchronization
  FAILS. Prior labeled start/update/end test success does not establish real-print delivery.
  Cause of this current discrepancy is not diagnosed; do not assume it is the prior token bug.
- Failed FULU attempts left the phone on “Getting the print ready” until reopening the project.
  The event log has preparation/confirmation entries but no terminal failure event for those
  attempts. The companion saves failed state without emitting that transition. Not fixed yet.
- Firmware text told the user to update Studio/Handy despite using Counterpart/FULU. A pending
  phone UI change puts the raw vendor text in Printer details, but **copy is not the primary
  problem** and must not replace fixing control/result/state flow.

### Architecture request — do not narrow this to copy or another guard

David explicitly challenged the overall iOS/Mac → companion → MCP architecture. MCP servers
already wrap the machinery; Counterpart should be UI and connective tissue, passing existing
MCP requests, elicitation, stdout/structured results and progress. Do not add policy layers,
parallel printer backends, fallback paths or duplicated printer logic to cover lost information.
Audit actual ownership and data flow. Do not assert “three backends” as a finding without
inspection. Concrete audit leads: `services/printer-handoff/src/print.ts` contains a Bambu HMS
special-case/clear sequence; `mcp-client.ts` callTool enables resetTimeoutOnProgress without
forwarding an onprogress callback; Stop dropped the already-saved connection selection;
pre-dispatch failure state is not emitted to the phone's event feed. These are leads, not a
completed architecture audit. Keep the Stop fix and state-management failures active.

### Source state; preserve uncommitted work

Counterpart primary checkout: `/Users/davidmontgomery/.codex/worktrees/counterpart-integration/scan-to-make`.
Branch `feat/counterpart-print-control-flow`, HEAD `d713e6409e874efc5aa0d892b5c9959176f65c4c`.
PR #289 merged there (Mac displayed-spool fix). Three pending implementation files are dirty:
- `services/companion/src/objects/service.ts`: Stop reads saved handoff bundle selection and
  forwards `connection_mode` / `connection_type` to the MCP; refuses to silently drop the FULU
  choice if an old MCP cannot receive it. Existing app/MCP command path remains.
- `services/companion/tests/objects-printing.test.mjs`: regression proves Stop retains the print's
  original connection after later settings changes.
- `apps/mobile/ios/ScanToMake/Screens/PrintingView.swift`: rejected-control card explains that the
  print is still running; original HMS text moves under Printer details.
This handoff/status update is also uncommitted. No new Counterpart PR yet.

Bambu checkout `/Users/davidmontgomery/stm-wt/bambu-fusion-document-binding`, now branch
`feat/counterpart-authenticated-stop`, clean at local-only commit
`42432727c39c21613d5e62b55e68242c6b78efb9`, based on installed `ed9aba3`.
Adds Stop's explicit connection fields, authenticated LAN stop through existing FULU session,
and tests preserving direct/default/native routes. Bridge failure is an error; no unsigned
fallback or automatic Stop replay. Cloud FULU Stop is explicitly unsupported. Public releases
are held; this commit is not pushed, not installed and has no PR. Earlier candidate `1330914`
incorrectly equated “bridge configured” with “selected route”; independent reviews caught it.
Do NOT revive that approach. Both read-only reviewers found no further substantive issues in
4243272 plus the companion interface patch. This is source review, not acceptance.

### Validation and installed versions

- MCP final full suite: **987 pass, 0 fail, 4 skip** (991 tests). Source/compiled dist synchronized.
- Companion focused objects-printing suite: **22 pass**. The new regression failed before fix
  because Stop received `{}` instead of the saved FULU/LAN choice.
- Full companion suite: **718 pass, 14 fail, 10 skip** (742 tests). NOT GREEN. Logs show old
  Xcode Python rejecting `-P`, missing `pxr`, Blender repair assertions and a worker-environment
  assertion involving `__CF_USER_TEXT_ENCODING`. Do not label all failures pre-existing or
  environmental without reproducing under the documented workflow environment.
- Xcode MCP BuildProject successfully built the changed phone project for Davica3 in Debug.
  **Not installed.** Build log saved with the evidence below.
- Installed Mac is still `202611022145`, with older reviewed 1355 companion runtime.
  Installed phone is still `202611022125`. Installed Bambu is still 1.1.52 / `ed9aba3`.
- PR #289 exact-head Codex/Cursor review clear, real review wait elapsed, branch guard SAFE,
  manually merged. Postmerge verification after >3 minutes: runs 41582299174/41582299260 have
  zero executed steps and billing/spending annotations. Hosted CI did not pass.

### Tools and live state

Use the available Build iOS Apps plugin and Xcode MCP tools where they support the task;
inspect capabilities instead of defaulting to shell-only development. Build iOS Apps defaults
were empty; its currently exposed workflows are simulator-oriented. Xcode's run destination
list DOES show Davica3 active/eligible, and BuildProject succeeded. Both standalone and
workspace DeviceInteractionStart calls nevertheless returned only simulators as eligible.
That is a tool capability mismatch, not proof the phone is absent. Do not boot a simulator as
physical acceptance or send David into a settings loop. Actual phone UI is reachable through
Xcode Device Hub using computer use; actual Mac UI through `/Applications/Counterpart.app`.
No device interaction session was successfully created. Xcode GetConsoleOutput had no active
launch session. Use fresh inventory/handles and screenshots; David operates devices concurrently.

Build lock was released; test/build commands finished. No deployment, repair, hardware command
or new implementation was started for the handoff. Review agents finished, read-only. Existing
user/system processes remain untouched. Reinstalled development node_modules remain in the
relevant Counterpart packages and Bambu checkout; clean owned bloat only after use.

Evidence and source snapshots: `/Users/davidmontgomery/scan-to-make-work/codex-stop-handoff-20261102`.
Includes final logs, both source diffs, live-print receipt, Xcode build log and the pasteable prompt.
Earlier evidence remains in `codex-app-print-20261102`, `codex-live-delivery-20261102`, and
`codex-deploy-20261102`. Preserve original projects, photos, pairings, TLS, Fusion documents,
private APNs key, and app rollback copies. All 40 asks remain in scope. Read the older sections
for APNs provisioning, prior acceptance, identifiers and preservation details, but this section
supersedes their current acceptance claims.

---


## Sandbox Live Activity acceptance — 2026-11-02, 21:25 Mountain

The fresh session read Apple Developer signed in, inspected an empty Keys list, registered
`Counterpart Live Activities Development` with **Sandbox / one topic `com.scantomake`**,
and downloaded the private key. The private file is outside Git under
`~/.config/counterpart/apns/sandbox/` (directory 0700, file 0600). All three encrypted secrets
are present on `counterpart-relay-sandbox`; every secret/deploy command used `--env sandbox`.
Deployed version: `84657bc4-9aa1-48c8-8b42-dd3071143ca6`. The random-token probe returned
`410 token_inactive / BadDeviceToken`, verifying the authenticated APNs path, not delivery.

**Actual phone delivery:** a clearly labeled `Counterpart delivery test`, with no physical
printer command or live project mutation, appeared on Davica3. David confirmed it. Device
Hub subsequently showed the Lock Screen at 10%, then 70% after a relay update, then 100% /
Print finished after a relay end. Each relay call returned 200 with an APNs ID. David dismissed
the completed test card. This verifies start/update/end delivery for the test, not a real print,
Watch receipt, or unattended background token registration.

**Foreground recovery repaired and accepted on Davica3:** the initial activity update token did not
reach the companion or Mac CloudKit cache, even after David opened Counterpart and its Check
Connection stayed green. Restarting only the phone app immediately registered that existing
activity's token; only then were update/end possible. The phone patch reconciles the
system's activities and current tokens whenever the app becomes active, before network waits.
Signed build `202611022125` passed all 14 native AppTests and is installed. A new foreground
test registered its token in 1.5 seconds and visibly reached 70%. A second test started while
the phone was locked: no update token appeared until Counterpart returned to the foreground,
then it registered without restarting (PID 2966 before and after). The six original projects,
seven pairings, TLS and connection configuration match the pre-install preservation receipt.
It does not change Keychain accessibility. Cold locked-phone registration remains a separate
acceptance case; do not label that fixed by foreground recovery.

Mac Advanced settings now persist the verified base URL:
`https://counterpart-relay-sandbox.betkalshi-dtmont.workers.dev/relay/v1`.
The relay toggle was already on. The address field requires Return to save; its initial
Tab-away edit did not persist, and the subsequent Return/save was verified via UserDefaults.
At this relay check Mac was build `202611021355`; phone was `202611022125` (see the later Mac 2145 installation below). Both devices are actually
on 27.2. Davica3 is connected by USB. iPhone Mirroring stayed off; Device Hub screen viewing
was used only for notification checks and must be stopped before camera acceptance.

**Browser correction:** enabled browser access and signed-in Apple Developer were real in the
prior session. Its “disabled in Work settings” error was an integration mismatch. This session
initially worked, then hit `browser.user is unavailable` during Save and even read-only calls.
One tool-kernel reset recovered the same prepared page; registration/download then succeeded.
Do not send David through the old settings/sign-in loop or ask again for provisioning approval.

Evidence: `~/scan-to-make-work/codex-live-delivery-20261102` contains nonsecret relay response
receipts, key-registration and phone Lock Screen screenshots, Mac settings evidence, and a
six-original-project/seven-pairing preservation receipt. Private token/key values never enter
Git, screenshots, PRs or response receipts. All 40 asks remain in scope; physical print/Stop,
fresh camera/Face ID/scan quality, Watch delivery and the memory target are still open.

**Print authorization and current result:** David explicitly authorized the small cube print and
said not to ask for approval or a manual bed check again. That supersedes older “no print
approval” notes. A 10 mm private Fusion cube was sliced for black PLA / P1S / 0.4 mm hardened
steel. The first stock-nozzle slice was rejected before dispatch; matching the reported nozzle
resolved that mismatch. The configured FULU bridge then failed its LAN connection before
sending a print. A direct LAN attempt was explicitly rejected with HMS
`0500-0500-0001-0007` / MQTT command verification failed; nothing printed. Do not retry that
unauthenticated route or change printer security settings. Investigate the authenticated bridge.
These direct MCP diagnostics do not count as Counterpart's app-driven print acceptance. David explicitly
corrected this mistake: ALL further print initiation must use Counterpart’s actual UI → MCP
flow. No direct-control scripts, standalone MCP dispatch, Studio fallback or substitute path.
The Mac app’s actual Print Another → black A1 flow then failed with `color_mismatch`, asking
for preset green `#00AE42`. The sheet converted the displayed suggested tray to `{auto:true}`
instead of the selected AMS slot; that Mac UI bug is fixed in installed signed Mac build `202611022145`.
David then retried from the actual phone app at 21:41:53 Mountain. Its bundle
`ec190bb2-f7f4-4458-b454-be575ced51e2` correctly selects black PLA / AMS slot 0 and reaches
the FULU connection failure at 21:42:11, before any print command. The phone stayed on
“Getting the print ready” until Back → reopen showed the failure. This is a separate stale
phone-state defect. The persisted event feed contains preparation/confirmation events for both failed attempts but no terminal event; the failure path saves the object without emitting an event, while the connected phone relies on that feed. Read current logs/UI before acting; David may be testing concurrently.
A bounded transport diagnostic found Mac TCP to the printer’s MQTT port succeeds while
the configured FULU container’s connection was refused. Both Colima and Counterpart already
had Local Network permission enabled. Restarting only the dedicated `bambu-fulu` runtime
restored its connection; Docker’s default context and printer security settings were preserved.
No alternate print route is allowed.

**Actual UI retry at 21:51–21:53 Mountain:** installed Mac 2145 → Mic mount → Print Again →
black A1 → Print → existing slicer/MCP confirmations. The app now shows “The printer started
it”, Busy, Pause/Stop, and “Waiting for heatbed to reach target temperature”. Print ID
`88ebb9f5-1811-448f-aacd-c989ee7c5c9c`; its saved colour is `{amsSlot:0}`. This establishes
app-driven dispatch and live preparation, not a finished part or Stop acceptance. Do not
restart the companion or FULU while that job is active. Phone is also build 2125; the Mac’s
companion runtime is the unchanged, previously reviewed installed 1355 runtime because this
change only alters the native Mac sheet. Signed build and 142 native tests pass (one existing
Keychain skip). Original model/photo, seven-pairing and connection receipts match after install.
Evidence: `~/scan-to-make-work/codex-app-print-20261102`; immediate Mac 1355 rollback is there.
The earlier 1227 rollback remains retained. PR #288 merged as `a544feec`; postmerge hosted
checks again have zero steps and billing annotations. PR #289 contains the Mac spool fix.
Only the temporary local MCP process used the documented `BAMBU_REQUIRE_CONFIRMATION=0`;
the configured SSH restrictions and persistent environment were not changed.

## Relay provisioning update — 2026-11-02, 20:29 Mountain

David explicitly authorized registering the prepared Sandbox APNs key, storing it as an
encrypted Cloudflare secret and deploying the relay. Do not ask for that approval again.
The product name is **Counterpart**; existing `com.scantomake` backend identifiers stay intact.

Sandbox Worker `counterpart-relay-sandbox` is deployed at
`https://counterpart-relay-sandbox.betkalshi-dtmont.workers.dev/relay/v1` with APNs origin
`https://api.sandbox.push.apple.com`. Version: `c7225f78-10dc-4097-8684-ca0a7cd861f0`.
It has separate Durable Object storage and no production route. Its random-token probe
returns `503 not_configured`, as expected with no secrets. This is deployment evidence,
not APNs authentication or phone delivery. Mac relay settings have not been switched.

Apple expired the saved sign-in when Register was clicked in the previous session; that
session observed no successful registration or download. David then showed browser access
enabled and Apple Developer signed in in Codex. The old tool nevertheless reported
“Local browser use is disabled in Work settings”; this was an unresolved tool/session mismatch,
not evidence that David had disabled browser access or failed to sign in. The fresh session
read the signed-in Apple account and empty Keys list successfully. See the newer delivery
update above for completed registration. Do not ask for the existing provisioning approval again.

Local relay validation: 96 tests pass, production and Sandbox bundles validate, and loopback
start/JWT/headers/rate-limit/check smoke tests pass. Mirroring is not running. Camera, Face ID,
physical printing and actual phone/Watch push acceptance remain open; all 40 asks remain in scope.

## Latest acceptance update — 2026-11-02, 14:10 Mountain

Both apps now have signed build `202611021355`. Main is `4c7af6a5` (#285), with the entire
source tree identical to reviewed/tested `184a7d4d`. The Mac runtime was rebuilt from that
source, not reused from #272. Build 1345 was withheld after review found lost Fusion claims;
it was never installed and its staging app was removed. Installed 1355 includes #281–#285:
deleted-project recovery, real phone device routes, persisted settings, preview-cache lifecycle,
and the phone AI-connection/Fusion bridge. No public MCP release; Bambu `ed9aba3` / Fusion
`86a3016` remain installed. No physical print or stop was dispatched.

**Observed in the installed apps:** phone General keep-awake off changed the actual Mac Settings
switch; restored on and verified both sides. Current phone (13CE) is outside older pairings and
has no Remove control; no pairing was removed. Phone shows truthful AI connection-test scope
and Fusion's installed/running-but-unchecked state; Set Up Again was not clicked. Model jobs
still use Claude independently of that saved connection choice. Alternate-provider routing and
global AI-off behavior remain unimplemented.

Phone search for “25 inches” finds the stove from conversation text, and Settings → Guide opens
live Help (observed on 1121 before replacement). Phone 1355 again produces the real mic-mount
44 min / 18 g / 272-layer estimate with P1S Ready and AMS choices; sheet canceled. A disposable
published import shows designer/licence/plate preview on the phone. Deleting that project while
its detail was open shows Project unavailable; Back to Projects returns to all six originals.
The temporary ID was `6999d41b-da65-48df-b4b0-05d085def42b`; it is removed. Installation and final
acceptance receipts preserve all six original current models/photos, seven pairing identities,
TLS and connection configuration. Original keep-awake value is restored. Mirroring is closed.

**Notifications:** #283 fixes missing persistence and deletion of shared subscriptions when
legacy settings were absent. Phone 1355 now reports iCloud alerts include every event type.
Real Ready event `c3e3dbce-fc0f-480b-8583-8cd28783575d` was saved to CloudKit. This is not a phone/
Watch delivery receipt. Mirroring can route alerts to the Mac, and an installed Mac counterpart
can suppress mirrored iPhone alerts ([Apple](https://support.apple.com/en-us/120684)); the lack
of a banner inside the mirrored screen alone is inconclusive. Separate device/type filtering
remains disabled and unsupported. Both signed apps use development APNs and the same CloudKit
container; neither has an explicit CloudKit environment entitlement. The Sandbox key portal
confirmation remains pending; no key registered and no deployed APNs relay verified.

**Memory remains open:** 1355 measured 347.9 MB open, 348.9 MB after closing the main window,
peak 590.9 MB, after potato → mic mount → Explore → idle. This is worse than the earlier 1227
sample (306/307 MB). Cache eviction is installed but does not establish the 150 MB menu-bar
target. Phone Instruments remains unverified. Full geometry and transparent previews remain.

Final checks: Node 22/24 workflows each 740 passed + one skip; Mac 142 passed + one existing
Keychain skip; shared Swift 153 passed; both signed Release builds pass. Final actual review
threads clear and branch guard SAFE before merge. Three-minute postmerge verification confirms
hosted Actions still execute zero steps because of billing, not a tested source failure.
Evidence remains under `~/scan-to-make-work/codex-deploy-20261102` (`*1355*` screenshots, source,
signing, installation and preservation receipts), `phone-ai-fusion-184a7d4d`, and
`codex-notification-settings-20261102`. Original Fusion documents and scan inputs are preserved.
All 40 asks stay in scope; physical print/stop, fresh scan/camera/Face ID, actual phone/Watch push,
APNs provisioning, fresh same-account enrollment, provider routing and the memory target remain
unaccepted. Older snapshots below are historical and superseded here.

## Previous acceptance update — 2026-11-02, 12:50 Mountain

All 40 asks remain in scope. Main is `d2b612f8` (#279). Mac has signed build `202611021227`;
phone has `202611021121`. Mac companion payload source `8c4160e2` is unchanged and identical to
merged #272 (`a13c5735`). Phone installation
retained app data. Actual phone Home, model, settings and print estimates are observed; physical camera/Face ID acceptance remains open. Mac installation
and the temporary published-model test preserve six original projects/current models/photos,
seven pairing identities, TLS and configuration exactly (`codex-deploy-20261102` receipts).

**Observed on Mac:** the mic mount shows as a transparent, framed model; Explore in 3D starts
interaction and returns to a still after idle. Printer sidebar opens Printers settings while
preserving selected project. Fresh MakerWorld caliper profile 218979 imports from the browser-
downloaded original as Ready, with designer/licence/link/plate preview and unchanged SHA-256
`e08c4d77bc6bafd708e3fee653c7880732384f955622c2d7fbd93ce1f88af7bf`. The native Print sheet
estimates 1 h 39 m / 40 g / 0.20 mm / 15% infill and preserves original filament assignments.
It was canceled without dispatch. Only temporary project `7ded7e6e-65a5-4d6e-8531-283cd90c34d8`
was removed after receipts; the six originals remain. This is not automatic browser-worker or
physical print acceptance. Screenshots/receipt: `mac-1121-publisher-*` in the deployment folder.

**New Project overflow is fixed and installed:** #278 makes the existing form scroll. On Mac 1215,
the full MakerWorld preview at 1320 × 820 scrolls to visible Cancel/Get This Model actions; temporary
draft canceled. Evidence: `mac-1215-new-project-scroll.png`. Model memory is improved by installed #279: exact geometry uses a packed native mesh buffer and a one-model cache. The actual installed potato → mic mount → Explore → idle scenario drops from 510 MB to **306 MB** (peak 564 MB), passing the open-window 350 MB target. Companion is 63 MB (peak 109 MB). Closing the window still retains **307 MB**, above the 150 MB menu-bar target; cache/window lifecycle diagnosis continues. Evidence: `mac-1227-*-footprint.txt`, idle CPU captures and `codex-model-memory-20261102`. Phone Instruments remains unverified.

**Observed on phone 1121:** notification onboarding completed and OS Allow was accepted. Connected Home shows Mac mini / one printer ready and equal inset cards. Mic mount shows the full gold model; its actual Print Another sheet estimates 44 min / 18 g / 272 layers with P1S Ready and AMS choices. It was canceled without dispatch. A disposable duplicate verifies native Rename saves back to the Mac, and Project Settings saves Fine/two-copy defaults that produce a real 1 h 49 m / 37 g / 452-layer estimate in the phone Print sheet. Sheet canceled; only test copy `3caaa187-2858-4935-a1a8-378f1f130d6a` removed. `after-phone-controls.json` equals the prior six-project/seven-pairing preservation receipt. Original project preferences were not changed. Mirroring is closed. Actual notification delivery, camera/Face ID and full mockup parity are still separate checks.

**Fusion is now installed and privately exercised through the real app worker.** Reviewed local
Bambu 1.1.52 is `ed9aba3`; upstream CLI/add-in is `86a3016`, durable runtime at
`~/Library/Application Support/Scan to Make/fusion/runtime-86a3016`. Only the two existing Fusion
command/args lines in `~/bambu-printer-mcp/.env` changed. SSH command/key/config restrictions,
Fusion manifest and port plist hashes remain unchanged. Configured SSH returns visible ping
text with document binding; the fabricated empty structured result that hid tool text is fixed.
Public Bambu #95/#96 and generic #49 remain unmerged/unpublished.

The actual worker produced a 10 × 10 × 10 mm cube with editable `edge = 10 mm`, exported 12-triangle
STL plus F3D/parameters, reopened the native archive and closed both owned documents. All four
pre-existing document identities/flags and the original active stove's six-body geometry match.
The 75-second worker used 20 tool calls; it was a private acceptance model, not a live user
project or print. `codex-fusion-acceptance-20261102` retains `private-production-result.json`,
`private-production-root-geometry.json`, `native-import-result.json`, `runtime-switch-receipt.json`,
`final-local-integration.md`, model/CAD outputs, add-in originals and immediate package/env rollback.

#271 removes physical camera use from ordinary iOS model views by explicitly selecting virtual
camera mode. #277 rejects pre-dispatch/out-of-order printer reports: the real stove's cached
FINISH at 17:52:41.810 UTC preceded dispatch at 17:52:44.110 yet previously marked it Done.
Both fixes are installed; no new physical print/stop or hardware diagnosis is claimed.

Cleanup quality remains unaccepted. The overview candidate improved the rounded rear; ray
measurements show the alleged broad underside depression was actually overall convex. A later
normal correction hit the 900-second cap and correctly remained Failed with a checkpoint. Its
reduced geometry changed shape and was not imported into live projects. No further paid cleanup
run is planned; inputs and user models remain preserved.

Signed phone 1121 has `aps-environment=development` despite Release configuration. Relay code
and loopback tests exist, but deployed APNs delivery is not verified. Pending portal key is Sandbox;
the relay default is Production, so provisioning must match the signed entitlement. No key was
registered. Mac bookkeeping has 18 saved events and one cloud push-to-start token, which establishes
prior CloudKit exchange, not phone 1121/Watch delivery. README's Release/environment claim is corrected.

Cleanup reclaimed 3.62 GiB net allocated space from verified merged trees/caches earlier; another
169.7 MB local and 399.4 MB remote dependency data plus the obsolete 568.4 MiB 0946 app rollback
were retired. Receipts/models/backups remain. Obsolete 0958/1121 app rollbacks and the older Bambu `16787aa` rollback were also retired; immediate app 1215 and pre-Fusion Bambu rollback remain. Active memory work and unmerged/user-owned branches are retained. Launch Services cleanup is being rechecked after the final build.

Hosted scan-to-make Actions still fail before execution due account billing, including #272's
post-merge Mac job 125483599839. Exact Node 22/24 workflows and signed native builds passed.
Bambu ed9 hosted build/test/native-macos genuinely passed. Physical print/stop, fresh scan quality,
phone/Watch notification delivery, APNs provisioning and same-account enrollment remain open.
Older snapshots below are historical and superseded by this section.

## Current acceptance snapshot — 2026-11-02, 10:19 Mountain

Mac build `202611020958` from `cdaf2685` is installed; phone build `202611020946` from
`af324c7e` is installed but locked. These include capped-cleanup Retry (#264), Blender
setup/repair (#267), and the Mac/backend multiple-copy explanation (#268). Local Bambu MCP
1.1.52 now matches draft PR #95 at `d6c1d953`, including the STL clone flag fix. No npm release.

The real Mac Print sheet now explains when two stove copies require two separate plates and
disables Print. Selecting one copy restores its Fine estimate (4 h 48 min / 104 g) and enables
Print. The sheet was canceled. The temporary acceptance project was removed; the six original
projects, seven pairing identities, configuration and source bytes remain unchanged. Settings
shows Blender is set up and opens on cleanup; the AI Test reports Connected.

Launch Services had 126 registrations for `com.scantomake.mac`, mostly old test builds.
Unregistering 125 obsolete paths leaves only `/Applications/Counterpart.app`; no files were
removed by this registry cleanup. Receipts and screenshots are in
`~/scan-to-make-work/codex-deploy-20261102`, including `launchservices-{before,after}.json`.

**Corrected cleanup diagnosis:** the original photos do show the rounded rear after the object
is turned over. The earlier worker's claim that those views were absent was wrong. The first
normal replay completed but left the flattened rear and was rejected. Merged #269 now presents
all numbered photos together, preserves individual full-size files, and explicitly compares
all sides. Its private candidate completed in 636 seconds, closed its owned Blender, and left
all original inputs/live projects unchanged. Independent matched-axis views show a substantially
improved rounded/textured rear, but the bottom depression still needs assessment. No candidate
was imported into the live projects; cleanup quality is not accepted merely because the run
or topology checks pass. #269 is not yet installed in the app.

Evidence: `codex-cleanup-overview-20261102/verification` (six matched-axis views and topology),
`codex-photo-overview-c5032fd4` (exact Node 22/24 workflow PASS),
`codex-copies-companion-e719417a` and `codex-copies-handoff-e719417a` (workflow PASS), and
`codex-copies-20261102` (real slicer outputs and installed MCP hashes), all under
`~/scan-to-make-work`. Hosted Actions remain blocked before execution by account billing.

Published-model printing was previously overstated: the earlier Mac entry point was gated by
an unadvertised capability and lacked a working backend/phone path. The active implementation
preserves publisher files/credit and original 3MF plate settings; no real publisher download is
yet verified. Fusion setup is connected, but review found active-tab routing could target a
user document. Session-owned document binding is being fixed across the upstream add-in,
Bambu bridge and companion before any real design pass. Both changes remain separate branches.

Phone unlock, physical print/stop, camera/Face ID, notification/enrollment acceptance, pending
APNs key registration, and public MCP release remain open. Older snapshots below are historical;
this section and `asks.md` supersede their installation and temporary-project state.

## Published model flow — 2026-11-02 (implementation, acceptance still open)

The parked published backend is integrated with current upload ownership, project defaults and
worker lifecycle. Both clients can start from a published link; the phone can answer file and
plate Asks. Retrieval has browser/web/file tools only, never printer dispatch or geometry tools.
Original 3MF/STL bytes are retained with SHA-256 receipts and embedded designer credit. Older
Downloads matches require confirmation. Multiple files/plates ask explicitly; a supplied file
is not replaced by the Mac's subsequent Start call. Designer plate images provide previews.

Unsliced 3MF goes unchanged to `slice_stl` with its selected one-based plate, original arrangement
and per-part filament assignments. The derived printable file is separate. Pre-sliced originals
require an exact file-inspection receipt and reject slicing overrides they cannot apply. Print
still uses the MCP's physical confirmation. Generic MCP's read-only `inspect_print_file` exposure
is a separate required follow-up; its existing internal inspection is not yet an exposed tool.
Combining separate designer 3MF files onto one plate is not proven by `arrange: true` and remains
an explicit acceptance gap. No AI reconstruction from a model page is used.

Read-only real-input evidence: `~/scan-to-make-work/codex-published-model-20261102/file-identity.json`.
The caliper in Downloads (SHA `932757ca96be8c50998be6e511a14416cfa661bc816938a1843119546cb85a30`)
has previews/settings but empty geometry and no G-code; it is correctly refused. The depth-gauge
3MF (SHA `2e0f756da398e8fe9e5cee0831d23c2dab977f0447aae0e8500e97333fac4c56`) imports into an
isolated temporary project as Ready, preserves exact original/bundle bytes, and retains designer
“3D Print Masters Hub” and “Standard Digital File License”. Its thumbnail is retained. Both source
files are unchanged. These are user-provided files; no publisher download checksum was verified.
No live project, browser session or printer was changed, and no physical print was attempted.

Fresh publisher retrieval is now separately verified: root downloaded profile 218979 through signed-in
Brave to `Vernier+Caliper+Ruler+220mm+COLOR-02.3mf` (1,687,930 bytes, SHA
`e08c4d77bc6bafd708e3fee653c7880732384f955622c2d7fbd93ce1f88af7bf`). Its isolated import is Ready,
with both OUTER and INNER caliper parts on plate 0, the original designer/licence/profile URL,
and the selected plate thumbnail. Source, stored original and handoff bundle hashes match;
source unchanged, temporary project removed. `publisher-download.{json,png}` and
`publisher-import.json` in the same evidence folder record the browser retrieval and local checks.
The earlier underscore-named caliper file is damaged; this fresh publisher file is valid.
No physical print or installed-app acceptance is implied by the isolated import.

Draft #273 review reproduced and fixed two further defects: duplicates now retain the chosen
original's receipt and plate selection, and phone downloads include the selected original path
in their cache identity. Focused published tests 11 pass; shared Swift 144 pass; full handoff
94 pass/5 skips; unsigned iPhone and Mac builds pass before these last model/transport fixes.
Node 22 full workflow passed; Node 24's unrelated printing-test teardown race is fixed in the
separate fixture branch. Final exact-head checks and native UI acceptance remain outstanding.
Generic draft #49 now also exposes file-only inspection, preserves the public print plate index,
and fixes STL copies; full 607 tests and package installation checks pass. No npm publication.

## Device acceptance and Blender follow-up — 2026-11-02, 09:24 Mountain

Mac build `202611020921` is installed from merged main `f1d2dde6` (#265); Davica3 has
`202611020904` from `c5ba0d8e` (#263). The Mac agent reports parent version 0921. Source
hash comparisons confirm the installed Blender startup/preflight matches main. Configuration,
TLS, pairing identities, existing model/photo bytes survived both installations unchanged.

Real Mac settings acceptance duplicated the stove model, renamed the temporary copy to
“Counterpart acceptance check”, and saved Fine/two-copy defaults. The print sheet correctly
consumed both values, then exposed another real defect: Bambu Studio rejects the combination
`--slice 0 --repetitions 2`. Changing only the sheet to one copy produces a real estimate of
4 h 48 min / 104 g / 0.12 mm / 15% infill. The two-copy fix is ongoing. Test copy
`bd2a5e1c-b1c9-469d-be8e-36c1411b2e68` is temporary acceptance evidence, not a new user project;
retain it until the printing diagnosis finishes, then clean it up. No print was dispatched.

The private cleanup replay reached its tool-call limit and produced a checkpoint with visible
rear defects. It was rejected, not imported into the live projects. That run also exposed a
status bug: a capped checkpoint was announced Ready. PR #264 fixes the classification and
cross-client Retry action, including an exact shared public-response fixture (pass activity is
intentionally omitted from public responses). It is not installed yet.

The configured Blender bridge could connect while its installed add-on was too old for the
inspection tools. The official add-on was validated and installed with a mandatory backup,
legacy module name and preferences preserved. Its auto-start then exposed a second bug: the
app's delayed enable call disconnected the ready bridge. Merged/installed #265 is idempotent,
checks add-on compatibility, and preserves user-owned sessions. Real material and solid
inspection calls pass; a fresh full cleanup replay started at 09:23 with hardware calls blocked.
Blender status/repair controls for both clients are being reviewed separately.

Evidence: `~/scan-to-make-work/codex-deploy-20261102` (installation receipts, screenshot of the
actual two-copy failure); `codex-blender-readiness-workflows` (Node 22/24 PASS at `2de556ef`);
`codex-capped-cleanup-5648c802` (Node 22/24 PASS); signed 0904/0921 build logs. Hosted Actions
still cannot start because account payments/spending limits block jobs. Phone unlock, physical
print/stop, scan/Face ID acceptance, APNs registration and public MCP publication remain open.

## Capture warning and reconstruction diagnostics follow-up — 2026-11-02

New walk-around captures retain Apple's `stitchingIncomplete` warning in the local draft. Capture review and the phone's Send journey say that some sides may be missing and ask for all-side inspection; the warning does not discard the model or claim scan acceptance. Existing drafts without the optional flag are unchanged. A new healthy reconstruction clears the flag.

A failed Mac photo reconstruction retains its last 64 KiB of helper stderr, with a timestamp/exit header, in `scan/.reconstruction-diagnostics/last-failure.log` inside that project's private directory (0700 directory, 0600 file). Retries replace only this one file; successful runs do not create a failure log or replace a prior timestamped failure. These diagnostics are neither served as project files nor included in public error text. Storage failure leaves the existing saved-photos error intact.

Host native lifecycle/draft/selection/retry fixtures and the companion's focused reconstruction tests cover warning persistence, healthy reset, legacy drafts, bounded private logs, retry replacement and symlink refusal. Device camera/scan-quality acceptance remains open; no saved capture or historical model was altered.

## Project Settings follow-up — 2026-11-02

PR [#260](https://github.com/DMontgomery40/scan-to-make/pull/260), `feat/project-settings`, is separate from the merged release PR #259. Both clients use one native grouped Form from
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

After rebasing onto release `2f350a8c`, independent review corrections preserve successful Save/Duplicate
completion when a newer display refresh wins, while connection resets still invalidate the reply.
Original scan labels are format-neutral and exports serve retained STL, 3MF and USDZ with correct MIME
types. Follow-up checks: 123 CounterpartKit, 44 ControlKit and 35 companion HTTP tests passed.

After stacking on camera PR #262 (`6f4f4ebc`), 133 shared Swift tests and 68 Node 22 object-service/HTTP
tests passed. The Mac model/relay suite passed 48 tests for review fixes: duplicate replies cannot
insert an identity twice, explicit fit/copy intent wins over legacy inference, and startup discovery
does not claim empty phone/printer lists before successful reads. Two fixture-only iPhone Simulator
UI tests passed: saved Fine/two-copy defaults persist and reach Print, and Duplicate opens ready.
The test simulator was isolated and deleted afterward; no live project or printer was contacted.
Final colour-default review fixes use destination-scoped history in both print sheets, the shared
settings Form, and backend Duplicate. Explicit saved defaults (including no colour) take precedence;
old tray/external-spool choices transfer only to the same recorded printer. Nine duplication scenarios
cover changed/default/legacy-alias/unknown destinations and explicit defaults without rewriting source
history. The affected Node 22 object-service/HTTP suite passes 69 tests; shared Swift passes 136,
Mac model checks pass 29, and both fixture UI checks pass again. The complete promotion-path audit
found no other production history-to-defaults consumer; ControlKit's old `init(last:)` has test callers only.
Project Settings is installed on both devices; see the current device-acceptance section for observed Mac behavior and remaining phone acceptance.

[Apple's ActivityKit push documentation](https://developer.apple.com/documentation/ActivityKit/starting-and-updating-live-activities-with-activitykit-push-notifications)
requires an alert for push-to-start. Muted project events therefore skip remote start, while existing
activities still receive silent updates/end. This does not claim the currently undeployed relay works live.

## Integration snapshot — 2026-11-02, after release installation

PR #259 (`feat/integrated-recovery`) merged as `85c88423`. The competing Claude executors were stopped;
Claude has subsequently been used only with tools disabled. The full 40-item backlog remains open
where device acceptance is missing; see `asks.md`.

**Installed:** `/Applications/Counterpart.app` and Davica3 both have signed build `202611020750`
from `b3b66b96`. The agent is running the new parent version. The phone remains locked, so no
camera/Face ID, Lock Screen or phone UI acceptance is claimed.

The six projects, seven pairing identities, TLS files, companion configuration, current models and
photos match before/after migration checksums. Evidence lives under
`~/scan-to-make-work/codex-deploy-20261102`. The existing local SSH printer forced command referenced
Node inside the removed `Scan to Make.app`; its runtime path was updated to `Counterpart.app`,
with the existing key/restrictions unchanged. The configured SSH now reports P1S Ready with reviewed
local Bambu MCP 1.1.52 from PR #95 commit `16787aa`. Public npm remains 1.1.51; nothing was published.
Projects, pairings, TLS and configuration receipts remained unchanged. This installs the native
streaming prerequisite. App streaming PR #262 merged as `6ac25742`; its combined app installation is pending.
Installed Mac checks passed rename (then restored the original name), search by a follow-up's
“25 inches” text, and Print Again preparation with P1S Ready, loaded PLA, 3 h 20 m, 109 g, 0.28 mm layers and 15% infill. The sheet was canceled; no print was sent.
Advanced Settings now reports iCloud sync and same-account Mac discovery On. Actual phone enrollment
and notification delivery remain unchecked.

Local workflow evidence: `codex-recovery-checks-3`, `codex-companion-updater-final` (both Node 22/24
pass at `3b8ea525`), `codex-relay-checks`, signed Mac/phone build logs and native regression logs.
Hosted Actions still cannot start because of account billing; there are no required checks.
The final #259 review fixed Ask answers claiming photos reserved by queued corrections; the fix is installed. Earlier ordering, terminal cloud state, retry attachment,
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


## Fusion document isolation source follow-up — 2026-11-02

Row 26 remains real-pass unverified. Source inspection found that the production pass
opened a new Fusion document but discarded its identity; later modeling and export used
whichever tab was active. The separate `feat/fusion-document-binding` work spans the
companion, Bambu bridge, and upstream Fusion add-in; the contract and preservation tests
are in `docs/design/fusion-document-binding.md`. Upstream source PR #36 has 388 passing tests
plus three subtests, Ruff and independent/Codex review clearance; Bambu PR #96 has 976 passing
tests (10 intentional skips). Private add-in replacement preserved its original manifest and
verified backups. The first bounded test rejected a cached old handler before creating a
document; original document metadata and geometry stayed unchanged. The source also covers cached-module reload during add-in startup; a path-checked private
refresh loaded new classes while preserving the old running instance for a controlled Stop.
Private acceptance still needs a confirmed handler restart and the bounded modeling test. No existing
user model was edited, saved or closed. Installed printer transport/profile/env, public npm
packages are unchanged. Mac Set Up pins the reviewed document-binding fork and ten-file hash
manifest, preventing a later setup downgrade. Row 26 remains unverified until the owned-document
and production-pass acceptance in `codex-fusion-acceptance-20261102` completes.

## Phone AI/Fusion settings bridge — 2026-11-02

The existing phone AI/Fusion sections now have real backend projections and routes. AI
is explicitly scoped to saving/testing connections; current model jobs remain on their
configured Claude Code path. It uses the same ModelAccessService revision/check worker as the Mac; remote choices are
limited to existing CLI/off modes, and Keychain references/credentials are omitted.
Fusion stays in the signed Mac app: passive reports inspect only installation/running
state, while an explicit phone setup request is claimed once and completed with its ID.
Replayed events and stale completions cannot rerun/settle another setup. Last setup results
are labeled historical; missing Mac reports and setup timeout are actionable. No live
provider configuration or Fusion installation/document operation was used for validation.

Validation: actual server/auth/socket regression suite 11 pass; native Mac Release suite
136 tests, 1 existing opt-in Keychain skip, zero failures; shared client tests 32 pass.
Unsigned phone Release build passes. Exact Node 22/24 workflow receipts are recorded outside the repository in
`scan-to-make-work/phone-ai-fusion-*`. Installed acceptance remains for the next coordinated
signed build. See `docs/protocols/settings.md` for the implemented boundaries.
