# Handoff: Counterpart

One screen, updated in place; git history keeps the rest. This is the only handoff: no dated copies or prompt files. What is built and accepted lives in the [working PRD](../design/overhaul/PRD.md) (§0, §8.0).

**How the owner works (David, Nov 6–8).** An item ends only as *done and verified on David's real install* (with evidence: SHA, log line, AX read, camera frame) or *blocked on one small thing only David can do*, named exactly. Green CI is not verification. Find facts yourself (code, logs, `object.json`, MQTT, camera); never ask David what you can read. Never end a turn "waiting"; re-drive agents that do. After every merge, `git pull` on agents-173, agents-136, agents-171 and the Mac.

## Update Nov 9: stopped and stabilized (Muse lead session)

David, Nov 9: "just, clean up, stabilize and stop. it worked with the potato crochet thing. so it works." He also named why held orbits are not a neutral ask: a rare myositis makes bending down and holding his arms up excruciating. Design consequence: minimize held-orbit time; the rig and an app-paced shutter are accessibility, not garnish. Scanning itself is proven (crochet potato Oct 31; Leatherman Nov 4 placed 23/23). The Nov 8–9 subjects (matte-black thin letters, translucent unicorn) are Apple's documented hard cases.

What the Nov 9 baseline established (full receipts: `~/scan-to-make-work/baseline-2026-11-09/` on the Mac):

- Our GuidedCapture fork vs Apple's current sample (same 2024 zip, SHA-256 `aeed6e76…5305`): 9 files differ + 3 added (watchdog, per-event evaluation writes, freeform path). Capture cadence on David's phone is at parity with Apple's unmodified sample (~27 shots/min both, Phase B). Low light is refuted as the regression cause; the watchdog never fired in any recorded run.
- The disappearing unicorn was ours: only runs with a phone USDZ were ever listed or sendable (`MacConnection.swift`). The 24-of-59 send was the old-Mac capability fallback staying sticky per project.
- Mac rebuild on identical photos: stock HelloPhotogrammetry never placed more than `mac-reconstruct`. Settings matrix: `.high` feature sensitivity causes `processError` (6/6 on Apple's 33 unicorn photos); honoring the embedded box clips letters; ignoring it causes stray sheets (incl. 2581854b's 79 mm off-plane head spike, verified from six sides — earlier "clean" calls used front/top only and were wrong for the app's models).
- PR #420 is the scan fix (freeform-only, app-paced shutter with auto-capture fallback, Done coverage gate, stopped scans findable, support cut) plus round-3 commits `352c07b9` (evaluation writes throttled), `6a89a579` (stopped scans never deleted), `7ee707fd`+`1f1afee1` (rebuild retries once at normal sensitivity). Gated Nov 9 (ci_local 10/10, 80 PASS; branch_check SAFE) and squash-merged 16:08Z as `38997183`; Mac + iPhone installed from that main as 202611091612. One hosted check is red for a UI-test-runner crash before any test ran (same step passed locally); the local gate is the merge gate per operations.md.
- Apple's unmodified GuidedCaptureSample is installed on Davica3 (not launched by agents); David ran it Nov 9 — it produced no phone model on the unicorn.
- Mac disk filled to 192 MiB free (65 GB of agent build bloat accumulated in `~/.Trash` — trashing was per rule, leaving it there was not — plus ~49 GB of gate simulators). David emptied the Trash; 59 GB free at last check. Gate simulators remain (David's call; `simctl delete` is forbidden). Every future delegate brief must include df before/after and its own cleanup list.
- Prompt-only project 176821af ("Articulated unicorn"): classified `fit`, Fusion bridge reported not connected (Fusion open, add-in disconnected), silently fell back to Blender, hit the 900 s worker timeout with no checkpoint or model. The live Blender scene is empty; nothing recoverable. Nobody cancelled it — "cancelled" is how the timeout kill is recorded.

Proof scans Nov 9 evening on 202611091612 (receipts `baseline-2026-11-09/proof/`): the app-paced shutter drove both captures (`isAutoCaptureEnabled=false`, zero fallbacks; DAD 94 shots/131 s, bike oil 77/95 s, both two heights). DAD (e9b21ab1): 89/94 placed; left D whole with open counter, A's upper counter filled, right D a loose ribbon — stock HelloPhotogrammetry on the same photos shows the same letter damage, so that loss is in Apple's reconstruction of black-on-black. SupportCut removed the turntable but left the sign's bottom open (1,081 open edges) — follow-up bug. Bike-oil bottle (0ddbecb5): 77/77 placed; 65.4–66.1 × 28.3–29.4 × 149.9 mm vs David's calipers 65 × 28 × 145 (+0.6–1.7 %, +1–5 %, +3.4 %); closed, no plate. No touch-up ran on it (scan-as-is): cap ribs absent (0.6–0.8 mm ripple), label print raised ~0.5 mm as relief. The touch-up prompt itself has no semantic-regularisation rule (identify object/parts, symmetry, repeated manufactured features) — David flagged this Nov 9. Disk leak found: `$TMPDIR/com.apple.coreoc.Photogrammetry` holds 121 sessions / 39 GB since Oct 31 (Apple working data, never cleaned); free space 24 GiB at last check.

Owner now: unassigned (David to name). Open scan list, in order: close the SupportCut open-bottom on flat-based scans; decide a semantic-regularisation rule for touch-up (and whether scan-as-is should stay untouched); clean the photogrammetry temp leak; reconnect the Fusion add-in/bridge before any Fusion-expected design pass (176821af timed out a second time at 900 s in Blender); decide gate-simulator deletion.

Post-scan flow (David, Nov 9 evening; choices confirmed in-thread): after a scan, New now asks **Copy this object / Make something that fits this / Just save this scan** — a scan no longer implies a copy, scan files upload while choosing, and a fit chooses its exact-size source (**Look up** the maker's published size and confirm it, **I measured** in mm, or **Use scan**, plus a caliper photo). The companion worker must confirm a looked-up size in an Ask before fit-critical geometry; an unsent draft can change fit↔copy over PATCH. A finished scan still only on the phone offers an enabled **Send to your Mac**, and project thumbnails are the real object first (photo/scan frame, render fallback) on iPhone, iPad, Mac, Android and Linux. Built in the agents-136 working tree on `fe403e36` (36 files, uncommitted at handoff): companion build + `objects-http`/`touchup-invocation` 63/63, Linux `domain.test.ts` 26/26 + build, Android `ClientTests`+`HomeLayoutTests` green. **Not yet**: Swift compile/UI tests (no Swift on agents-136), `ci_local`, PR/install, or a real-phone scan through the new question — that is the next gate, on the Mac, followed by David scanning one object as a fit (the bike-oil bottle is the ready-made case: calipers 65 × 28 × 145 mm).

## Installed now

| Where | What |
|---|---|
| Mac app | **202611091612** from main `38997183` (#420 merged Nov 9 16:08Z after local gate 10/10 + branch_check SAFE; installed Nov 9 ~16:16Z while the P1S read ready). Payload verified against the checkout (hashes match; `findMacReconstruct()`/`macScanToStl()` resolve with the new `--feature` retry); companion restarted on the new payload; MCP copies and printer settings unchanged; Counterpart never frontmost (180 samples). `objects.estimate` not run. Receipt: `~/scan-to-make-work/mac-202611091612/`. Rollback: 202611081952 at `~/scan-to-make-work/mac-202611081952/Counterpart-202611081952.app`. |
| Mac MCP copies | bambu-printer-mcp **1.1.77**, mcp-3d-printer-server **1.2.58**, unchanged by the Nov 8 install (bambu 1.1.79 and mcp-3D 1.2.60 are published). The P1S's mcp-3D profile runs Counterpart's copy: `printers.mcps` on Nov 8 reads "Bambu Lab P1S uses Counterpart’s copy (1.2.58)", because `overrides.json` points it there; `profiles.json` still names the `~/mcp-3D-printer-server` checkout (1.2.25). |
| iPhone Davica3 | **202611091612** from main `38997183` (#420; installed Nov 9 ~16:16Z without uninstalling, app not launched by the installer). Freeform capture is now the only capture — no `-STMFreeformCapture` flag exists. Awaiting David's proof scans (DAD sign + unicorn). Receipt: `~/scan-to-make-work/iphone-202611091612/`. |
| iPad Air | Nov 5 build `a13cef78`. None of the Nov 6–8 fixes are on it. |
| Android, Linux (agents-136) | Nov 5 builds with Nov 5 MCP copies. Stale. |
| Public | beta 6 (GitHub pre-release, from `30e3afdd`). Site live from `6692b4a2` (`wrangler deploy` by hand; it does not deploy on merge). |
| TestFlight | **2.0 (4) Approved** Nov 7, from main `30e3afdd`; assigned to **Counterpart Public Beta**, automatic tester notification selected. [Public link](https://testflight.apple.com/join/S4tExVzp) enabled, no configured tester limit/criteria, **Feedback On**, 0 testers at verification. Product description and What to Test saved: camera+LiDAR scans and automatic touch-up, spoken ideas, known-part dimension lookup, conversational edits, and printer reports with matching diagnostics ZIPs. In-hand is Labs/unavailable; AR is nonblocking. IPA distribution signatures/Production entitlements revalidated (`745dcca8…05bd`). No fresh external-tester install or production push delivery claimed. Details: [distribution](../distribution.md). |

Printer: P1S, LAN Only + Developer Mode; AMS A1 black PLA (nearly empty), A2 yellow PLA, A3 PETG, A4 Blue Gray PLA. FULU runs in Colima `bambu-fulu`; never restart it.

## Next lead: start here — scanning is broken (top priority)

David, Nov 8–9: two real scans in a row were a disaster and a third (a pink unicorn) disappeared. "Why isn't this just use all Apple libraries and features in the correct way?" Thousands of apps scan objects every day with Apple's Object Capture; ours fails on the same hardware. "This used to work": a real iPhone scan produced a model on Nov 4 (Leatherman Wave+, PRD §0). Treat this as a regression in *our* code around Apple's frameworks, not a research problem. Don't invent pipelines.

**What happened (evidence on the Mac, read it first):**
- Nov 8, DAD sign (matte-black letters on a wooden base): `~/scan-to-make-work/rig-scan-2026-11-08/` (`pipeline.md`, `geometry.md`, frames). 8 minutes of Apple's guided capture, 59 shots, only 24 sent plus the phone's `.reduced` 4k-vertex preview; the Mac rebuilt nothing; Apple's auto box clipped both D's; "More Light Recommended" on every frame in a lit room.
- Nov 9, DAD rescan on main `d5213867` (Mac 202611081952, iPhone 202611090252): `~/scan-to-make-work/rescan-2026-11-09/notes.md` + renders. 28 photos, all from one height; Apple placed 15; the Mac rebuild (`ignoreBoundingBox`, Apple masking) kept half the support plate as a shell and melted the letters. The first try (project 2aafcf64, freeform, 12 photos, "ready") was deleted on the phone.
- Nov 9, pink unicorn: `~/scan-to-make-work/unicorn-2026-11-09/` (copies of the phone's `Documents/NativeCaptures/<run>/`). David orbited it **three times**; auto-capture took **9 photos**; the run was in **Area mode** because the quick-scan launch flag had dropped; the stopped capture is kept only on the phone and nothing in the app shows it.

**Where to look:** our capture is a fork of Apple's `GuidedCaptureSample` (imported Oct 14, `bcaa077c`), now `apps/mobile/modules/object-capture/GuidedCaptureSample/` with 12 files changed (+868/−242): a `CaptureWatchdog` that stops captures (`c2eb1e0a`, KAN-217, Nov 2), LiDAR camera format changes (`8a5b1c1a`, Nov 1), `e92eed43`/`bdb0e048` capture/send changes, and the freeform switch in `d5213867`. The phone→Mac path is `apps/mobile/ios/ScanToMake/Platform/MacConnection.swift` and `NativeCaptureCoordinator.swift`; the Mac rebuild is `services/companion/src/objects/reconstruct.ts` → `tools/mac-reconstruct`.

**Do, in order:**
1. **Baseline with Apple's own, unmodified code** on David's iPhone and Mac, same objects (DAD sign, unicorn): Apple's sample "Scanning objects using Object Capture" (iOS) and Apple's photogrammetry on the Mac (the sample command-line app or Reality Composer Pro) with defaults, from the full image folder. Record shot counts, Apple's feedback, and the model. If Apple's code works where ours fails, the bug is in our changes.
2. **Diff our fork against Apple's sample** and against the Nov 4 run (its captures and settings are in `~/scan-to-make-work/touchup/m1/phone/`). Remove or fix every change that makes ours behave differently: why auto-capture fires 9 times in three orbits, why a run starts in Area mode, why stopped captures vanish, why the watchdog stops runs.
3. **Then** the Mac rebuild: Apple's `PhotogrammetrySession` on every image, the way Apple documents it. Fix the support-surface and clipping problems with Apple's own options (`Request.Geometry` bounds, object masking) before writing any geometry code.
4. Prove each fix on David's phone with a real scan, judged by the model: whole letters, open counters, dimensions vs calipers.

**In flight:** PR #420 (`fix/scan-round2`, agent thread on the Mac lane `stm-lane-h`): quick scan as the only capture (no flag, no Area/Object toggle, one "Scan it" tile), an app-driven shutter about every 5° with Apple's `requestImageCapture`, Done only after enough photos from two heights, stopped scans shown with Send/Scan again, and a support-surface cut. Not reviewed. Re-check it against step 1–2 before merging: if Apple's stock flow works, the smallest fix may be removing our changes, not adding these.

**Hard rules from David for this work:** use Apple's frameworks the documented way and read current Apple docs (iOS/macOS 27); the scan rig is an optional accessory — nothing in capture or rebuild may assume it; one capture, no modes, no box for the person to drag; the app, not the person, is responsible for taking enough photos; a capture must never disappear.

## Open, in order

0. **Other open PRs from Nov 8–9** (each has review findings in its thread): #404 print-truth (blocked: needs the MCPs' "was it sent" field, bambu #129 → 1.1.81 and mcp-3D #87 → 1.2.62, then the fail-closed fixes), #410 MCP Update rows (fixes pushed for review), #411 Live Activity identity (then a second PR: relay on by default and milestones as Live Activity alerts — David's decisions), UX branches `fix/after-the-print`, `fix/fold-and-sidebar`, `fix/first-run-and-offline` (pushed, never gated), MCP test-temp cleanup mcp-3D #91 (1.2.61) and bambu #132 (1.1.80) with changes requested. MCP version order: bambu #132 1.1.80 → #129 1.1.81 → #131 1.1.82; mcp-3D #91 1.2.61 → #87 1.2.62 → #90 1.2.63.
1. **Printing from Counterpart on the P1S.**
   - Status: the scan rig (`7f1a9e33`) plate 4 printed through Counterpart Nov 7 07:30–10:25Z on bambu-printer-mcp 1.1.77. That is the first success after the upload fixes (1.1.74: 64 KiB writes; 1.1.77: 120 s print-upload stall limit plus progress). Plate 2 (18.4 MB) stalled at 72% on 1.1.76. Nov 8 10:12Z upload probe on the installed 1.1.77 path (`ftpUpload` → `uploadBytes`): 18,362,734 bytes to `/counterpart-probe` went through in 112 s at 160 KiB/s, longest write pause 0.8 s (at 94%), end of data → `226` 0.78 s; size matched, then `DELE`/`RMD` (receipt `~/scan-to-make-work/mac-202611080746/probe/`). One idle run, FTP leg only: the Nov 6 mid-file pause did not recur, so the 120 s stall limit was not exercised. A real large print from Counterpart is still unproven.
   - Next: David prints the remaining rig plate (5, Lifting Parts) from Counterpart; watch it and own any failure.
   - Wrong state: plates 0, 1, 2 and 3 were printed from Studio/Handy, but Counterpart shows 0 and 1 "Check print result" and 2 "failed". Make "printed elsewhere" recordable so the strip reads true, on every layout.
   - Wrong label: the Nov 6 morning failure (no fresh MQTT report, refused before anything was sent) was recorded as uncertain. Anything never sent must read "not started" (same class as #385). Check the code the MCP returns for that refusal and map it.
2. **Install current main on the Mac**, then the read-only checks:
   - done Nov 8: 202611080746 from `76127f6b`, every check recorded in the Mac app row.
3. **Install current main on David's iPhone, iPad, Android and Linux** and run the same read-only checks as the Mac: build number, MCP versions, `printers.mcps` answers both MCPs within 5 s, a real `objects.estimate`. Plate picker, per-plate filaments, Update and phone Add printer have only run in simulators.
4. **Boundary leftovers** (AGENTS.md "The app staples onto the MCPs"):
   - the shared ControlKit form encoding (Mac Add Printer sheet and phones) still branches on `"bambu"` and `BAMBU_MODEL`; make it generic from `counterpart_setup_fields` (#392 merged over it with `--boundary-reviewed`);
   - move title, designer and licence into `list_3mf_plates` in both MCPs, publish, install, then delete `inspectModelFile`'s remaining 3MF parsing (PRD §8.0 item 9);
   - port bambu 1.1.69's M624 skip-object mask exemption to mcp-3D.
5. **Flaky tests:** fixed at the cause in #403 (capture drain, local-control incomplete frame, published file arrival), bambu-printer-mcp 1.1.79 (#130: remote-slicer deadline, FULU final reply drain) and mcp-3D-printer-server 1.2.60 (#89: FULU drain). Each failed first, then passed 200/200 loaded runs.
   - Open: the FULU drain changes pause/resume/stop on the printer and was checked only against mocked hosts. Check it on the P1S the next time David pauses, resumes or stops a print from Counterpart.
   - Open: the hosted iPhone simulator launch timeout (the Mac's own gate is authoritative).
6. **OctoPrint follow-ups** (built: #386 approve, #389 web address; checked only against Docker virtual printers):
   - (a) the MCP reports its normalized endpoint in counterpart/1, so one printer typed two ways lists once;
   - (b) Bonjour TXT `path`;
   - (c) layer progress, Cancelobject, Spoolman and thumbnails, researched and not built.
7. **Studio-audit leftovers:**
   - the external-spool mapping needs a camera-checked print David starts;
   - AMS Lite trays 24–27 wait for A2L support;
   - plate-filament edge cases (paint on modifiers, filament 0, all three feature filaments overriding, layer ranges) are listed in bambu-printer-mcp#121 and mcp-3D#81.
8. The rest of the PRD's not-accepted list (§0).

**Other owners:** bambu-printer-mcp#128 (X1C native route) belongs to someone else.

**Waiting on David:** every physical print; he starts them.

## Pointers

- Build, install, gate, deploy: [`../operations.md`](../operations.md). Releases: [`../distribution.md`](../distribution.md). MCP names the app uses: [`../protocols/mcp-contract.md`](../protocols/mcp-contract.md).
- Evidence and receipts: `~/scan-to-make-work/` on the Mac.
- Never-landed work: `git ls-remote --tags origin 'archive/2026-11-04/*'` (PRD §18). Don't delete them.
