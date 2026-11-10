# Handoff: Counterpart

One screen, updated in place; git history keeps the rest. This is the only handoff: no dated copies or prompt files. What is built and accepted is in the [working PRD](../design/overhaul/PRD.md) (§0, §8.0); how to gate, build and install is in [operations](../operations.md); machines, paths, ports and state folders are in the [infrastructure map](../infrastructure.md).

**How the owner works (David, Nov 6–9).** An item ends only as *done and verified on David's real install* (with evidence: SHA, log line, AX read, camera frame) or *blocked on one small thing only David can do*, named exactly. Green CI is not verification. Find facts yourself (code, logs, `object.json`, MQTT, camera); never ask David what you can read. Never end a turn "waiting"; re-drive agents that do. A rare myositis makes bending and holding his arms up excruciating: ask for one short, well-briefed scan, never repeated experiments. Rules and notes in this repo can be stale: when one contradicts what David said later or what the code does, fix the note in the same PR.

## Now (2026-11-10, 01:45Z)

**Lead:** Claude Fable 5.2, in the Mac mini's T3 environment (thread "Take Over Scan-to-Make Delivery"), since Nov 9 21:36Z.

| Where | Installed |
|---|---|
| Mac app | **202611100126** from main `df78ccde` (the Nov 9 train, #437). Receipt `~/scan-to-make-work/mac-202611100126/`; rollback `Counterpart-202611092127.app` in the same folder. |
| iPhone Davica3 | **202611092127** from `81eca38b` (#427). The train is **not** on it: the phone has been unreachable from the Mac since Nov 9 21:41Z. `~/scan-to-make-work/iphone-202611100126/` holds a ready `run.sh` and `job.plist`. |
| iPad Air | Nov 5 build. An install of 202611100126 was refused Nov 10 01:38Z because the iPad was locked (`~/scan-to-make-work/ipad-202611100126/`). |
| Mac MCP copies | bambu-printer-mcp 1.1.77, mcp-3d-printer-server 1.2.58 (npm has newer; Update is David's press). |
| Android, Linux (agents-136) | Nov 5 builds. Stale. |
| Public | Mac beta 6 and TestFlight 2.0 (4), both from `30e3afdd` (Nov 6). |

Printer: P1S, LAN Only + Developer Mode. David starts every print.

**On main since #427** (all in the Mac build above): worker rules composed per pass, with "recognise the object and regularise manufactured features" (#430); a scan that stood on something comes out with a closed bottom (#434); design passes stop honestly at a limit (10 min without activity, 120 tool calls, 2 h) and the next request resumes the worker's session (#436); the Nov 8 home and print UX stack (#431–#433); Live Activity relay on by default, Counterpart identity and milestone alerts (#435, #411, #412). The train's gate, review and their receipts: `~/scan-to-make-work/train-2026-11-09/`.

## Waiting on David

1. **Phone and iPad:** plug in or wake the iPhone and unlock the iPad, then say so; both installs are one command each.
2. **One scan to accept #427**, then the new pieces in the same sitting. Bike-oil bottle → **Make something that fits this** → describe a holder → leave **Look up** → Send. It passes when the question after the scan is the obvious next step, the Mac asks him to confirm product, size and source before designing, the result honors 65 × 28 × 145 mm with the clearance stated, it does not design a bottle, and the project's picture is the real bottle. Then: ask for a touch-up of the bottle scan (cap ribs regular, label smooth, each inference listed as assumed); fold and unfold the Duo or resize the iPad with a project open; tap a print notification on the iPad.
3. **"Publish them"** for the MCP repos (merging publishes to npm; he confirmed on Nov 9 that he has not said it yet): bambu-printer-mcp #132 (1.1.80) → #129 (1.1.81) → #131 (1.1.82), and mcp-3D-printer-server #91 (1.2.61, its Node 18 job fails) → #87 (1.2.62) → #90 (1.2.63). #404, #410 and #413 here wait on them.
4. **His word on the layout exceptions** stated as fact in PRD §6.1 (AGENTS.md wants his quote): Mac and Linux have no offline-Mac banner or Mac download link; Mac and Linux have no Printing screen (the Mac's inspector asks "Did it fit?"); Linux posts no notifications, so no buttons or banners; Android has no iCloud route; Live Activity relay, identity and milestone rows for Android and Linux. Fold continuity on Mac, Android and Linux is claimed as "existing single selection" and is unverified.
5. **Delete the cleanup staging** when he is sure: `/Volumes/Spillover/stm-cleanup-2026-11-09/` (about 60 GB; a hook blocks recursive deletes for agents on the Mac).

## In flight

| Work | Who | Lands as |
|---|---|---|
| The code engine in the MCP: `cad_status`, `cad_setup`, `cad_run`, `cad_check_fit` and a `cad_design` prompt in bambu-printer-mcp (build123d plus numpy, scipy, trimesh, manifold3d, scikit-image, Pillow, shapely; confined; optional, with a README note on what it is and how to leave it out) | GPT-6.1 Sol (thread "Prototype: code-CAD…") | PR in bambu-printer-mcp for David to merge; receipts `~/scan-to-make-work/cad-engine-mcp-2026-11-09/` |

## Open, in order

1. Read the MCP PR when it reports; then the same family in mcp-3D-printer-server.
2. **One engine in the app** (David, Nov 9: "consolidating it down to one would be huge"). After the MCP is published and installed through Update: the companion chooses the code engine for fit designs and for scan cleanup, hands the worker the MCP's `cad_design` prompt, keeps the script and parameters as the project's source, and the Fusion and Blender setup, repair, lock and launch code leaves the app (PRD §8.0 order: publish, install, then delete). Evidence: `~/scan-to-make-work/cad-engine-prototype-2026-11-09/report.md` (holder exact to calipers + clearance, +1 mm as one parameter, the unicorn Blender never finished) and `~/scan-to-make-work/mesh-cleanup-prototype-2026-11-09/report.md` (DAD letters rebuilt, bottle label smooth and cap ribs regular, potato kept). Blender's own Python module was tested and rejected (exact Python 3.13, GPL-3.0, not needed).
3. After "publish them": #413 then #410 as one train; #404 needs its dispatch truth rewritten on the MCPs' `printOutcome` field first (triage: `~/scan-to-make-work/branch-triage-2026-11-09/triage.md`).
4. Split the gate's iPhone and iPad UI job onto two simulators (it is 22 minutes of every gate), and give the gate's Android job a warm Gradle cache (Maven rate-limited two cold runs on Nov 10; agents-173 ran them).
5. The two iPad resize UI tests skipped in #431 need a unit-testable navigation state (selection and route live in `ProjectsRoot`'s `@State`).
6. The backlog below.
7. A new TestFlight build and Mac beta from main: the public builds predate the scan fix.
8. Later (David, Nov 9): try a small geometry kernel written from scratch (distance fields, watertight by construction, no 640 MB environment) against the same holder and unicorn cases, once the code engine has shipped.

## Decided on Nov 9 (change them if they prove wrong)

- **The train** (operations.md): finished branches land together the day they finish, with one review and one gate. David: "I was presumably NEVER using the app with all fixes included."
- **Cleanup deletes.** David: "you can rm -rf if you really need or dump things that you aren't sure about in /volumes/spillover". Spillover is for data and archives; nothing is built or executed from it.
- **The lead sits on the Mac**, gives delegates worktrees, reads their threads while they work and steers them; at most about three heavy delegates on the Mac at once.
- **Regularising a scan is allowed when it is labelled** `assumed` or `estimated`; a touch-up still runs only when the person asks (PRD §5.3).
- **Live Activity milestones with several devices:** Live Activity alerts only when every paired device has an activity for the print, otherwise CloudKit for all; if some devices fail, no fallback (a missed progress alert beats a duplicate).
- **Agent memory** for this project (`~/.claude/projects/-Users-davidmontgomery-fleet-scan-to-make/memory/`, Oct 30–Nov 1) is stale in places. Nothing here depends on it.

## Backlog

1. **Printing from Counterpart on the P1S.** Rig plate 4 printed through Counterpart on Nov 7 (bambu-printer-mcp 1.1.77), the first success after the upload fixes; an 18 MB upload probe passed Nov 8 (`~/scan-to-make-work/mac-202611080746/probe/`). A large print from Counterpart is still unproven.
   - Next: David prints the remaining rig plate (5, Lifting Parts) from Counterpart; watch it and own any failure.
   - Wrong state: plates 0–3 were printed from Studio/Handy, but Counterpart shows 0 and 1 "Check print result" and 2 "failed". "Printed elsewhere" must be recordable on every layout (#404).
   - Wrong label: a send refused before anything was sent (Nov 6, no fresh MQTT report) was recorded as uncertain. Never-sent must read "not started"; map the code the MCP returns for that refusal.
2. **Install current main on the iPad, Android and Linux** and run the Mac's read-only checks: build number, MCP versions, `printers.mcps` answers both MCPs within 5 s, a real `objects.estimate`. Plate picker, per-plate filaments, Update and phone Add printer have only run in simulators.
3. **Boundary leftovers** (AGENTS.md "The app staples onto the MCPs"):
   - the shared ControlKit form encoding still branches on `"bambu"` and `BAMBU_MODEL`; make it generic from `counterpart_setup_fields` (#413);
   - move title, designer and licence into `list_3mf_plates` in both MCPs, publish, install, then delete `inspectModelFile`'s remaining 3MF parsing (PRD §8.0 item 9);
   - port bambu 1.1.69's M624 skip-object mask exemption to mcp-3D.
4. **FULU drain** (bambu 1.1.79, mcp-3D 1.2.60) changes pause/resume/stop and was checked only against mocked hosts: check it on the P1S the next time David pauses, resumes or stops a print from Counterpart.
5. **OctoPrint follow-ups** (built #386, #389; checked only against Docker virtual printers): the MCP reports its normalized endpoint so one printer typed two ways lists once; Bonjour TXT `path`; layer progress, Cancelobject, Spoolman and thumbnails are researched and not built.
6. **Studio-audit leftovers:** the external-spool mapping needs a camera-checked print David starts; AMS Lite trays 24–27 wait for A2L support; plate-filament edge cases are listed in bambu-printer-mcp#121 and mcp-3D#81.
7. The rest of the PRD's not-accepted list (§0).

**Other owners:** bambu-printer-mcp #128 (X1C native route), #133 and #134 (A1 stopped-job recovery).

Never-landed work is kept as tags: `git ls-remote --tags origin 'archive/*'` (PRD §18). Don't delete them. Evidence and receipts: `~/scan-to-make-work/` on the Mac. Releases: [`../distribution.md`](../distribution.md).
