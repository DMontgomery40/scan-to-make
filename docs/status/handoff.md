# Handoff: Counterpart

One screen, updated in place; git history keeps the rest. This is the only handoff: no dated copies or prompt files. What is built and accepted is in the [working PRD](../design/overhaul/PRD.md) (§0, §8.0); how to gate, build and install is in [operations](../operations.md); machines, paths, ports and state folders are in the [infrastructure map](../infrastructure.md).

**How the owner works (David, Nov 6–9).** An item ends only as *done and verified on David's real install* (with evidence: SHA, log line, AX read, camera frame) or *blocked on one small thing only David can do*, named exactly. Green CI is not verification. Find facts yourself (code, logs, `object.json`, MQTT, camera); never ask David what you can read. Never end a turn "waiting"; re-drive agents that do. A rare myositis makes bending and holding his arms up excruciating: ask for one short, well-briefed scan, never repeated experiments. Rules and notes in this repo can be stale: when one contradicts what David said later or what the code does, fix the note in the same PR.

## Now (2026-11-09, evening)

**Lead:** Claude Fable 5.2, in the Mac mini's T3 environment (thread "Take Over Scan-to-Make Delivery"), since Nov 9 21:36Z. Previous lead: Muse Wonder Full on agents-136 (#420, #427, #428).

| Where | Installed |
|---|---|
| Mac app, iPhone Davica3 | **202611092127** from main `81eca38b` (#427). Receipts `~/scan-to-make-work/mac-202611092127/`, `iphone-202611092127/`. Rollback: `mac-202611091612/Counterpart-202611091612.app`. |
| Mac MCP copies | bambu-printer-mcp 1.1.77, mcp-3d-printer-server 1.2.58 (npm has newer; Update is David's press). The P1S profile runs Counterpart's mcp-3D copy through `overrides.json`. |
| iPad Air, Android, Linux (agents-136) | Nov 5 builds. Stale. |
| Public | Mac beta 6 and TestFlight 2.0 (4), both from `30e3afdd` (Nov 6). Site from `6692b4a2` (deployed by hand). |

Printer: P1S, LAN Only + Developer Mode. David starts every print.

**Scanning works.** #420 (one capture, app-paced shutter, stopped scans findable) is proven on David's phone: bike-oil bottle 77/77 photos placed, within +0.6–3.4 % of calipers; DAD sign 89/94. What is left is on the Mac side and in the worker (below). The Nov 8–9 investigation, its baselines and why each setting is what it is: `~/scan-to-make-work/baseline-2026-11-09/report.md` and `git show db43f9d0:docs/status/handoff.md`.

## Waiting on David

1. **One scan to accept #427.** Bike-oil bottle (rig or table) → **Make something that fits this** → describe a holder → leave **Look up** → Send. It passes when: the question after the scan is the obvious next step; sending is visible without hunting; the Mac asks him to confirm the product, size and source before it designs anything; the result honors 65 × 28 × 145 mm with the clearance stated; it does not design a bottle; the project's picture is the real bottle.
2. **Merge authority in the MCP repos** (merging publishes to npm): bambu-printer-mcp #132 (1.1.80) → #129 (1.1.81) → #131 (1.1.82), and mcp-3D-printer-server #91 (1.2.61) → #87 (1.2.62) → #90 (1.2.63). #404 here waits on #129 and #87.
3. **Delete the cleanup staging** when he is sure: `/Volumes/Spillover/stm-cleanup-2026-11-09/` (a hook blocks recursive deletes for agents on the Mac, so everything was moved there instead).

## In flight (delegates of this lead, started Nov 9 ~22:00Z)

| Work | Who | Lands as |
|---|---|---|
| Closed bottom after support removal: reconstruct inside Apple's own `Request.Geometry` bounds so the support is never built; cap the cut only if that fails | Opus 5.5 | PR, receipts `~/scan-to-make-work/support-bounds-2026-11-09/` |
| Worker rules composed per pass kind, plus a rule to recognise the object and regularise manufactured features, each inference reported under the existing `assumed` tag | Opus 5.5 | PR |
| Design passes: a limit stop is not "cancelled", the limit follows progress instead of a 900 s wall clock, and the next pass resumes the worker's session | GPT-6.1 Sol | PR |
| Prototype, nothing merges: a code-CAD worker (build123d, headless) against the Blender and Fusion bridges for "make something that fits". bambu-printer-mcp's own `docs/prd/scan-to-print-PRD.md` §5.1 chose build123d for this on Oct 30 and the app never used it | GPT-6.1 Sol | `~/scan-to-make-work/cad-engine-prototype-2026-11-09/report.md` |
| Verdict per unmerged branch: land, rework or archive | Muse Wonder Full | `~/scan-to-make-work/branch-triage-2026-11-09/triage.md` |

## Open, in order

1. Merge the three PRs above after the lead reads each diff; install; ask David for the proofs they need in the same sitting as his #427 scan.
2. Decide the design engine from the prototype's report. If code-CAD wins it lands as a tool family in both MCPs (PRD §8.0), then the companion's engine choice.
3. Land or archive every Nov 7–8 branch per the triage: #404 print-truth, #410 MCP Update rows, #411 Live Activity identity, #412 relay default and milestone alerts, #413 generic setup form, `fix/after-the-print`, `fix/fold-and-sidebar`, `fix/first-run-and-offline`, `diag/mac-reconstruct-settings`. Target: no remote branch without an open, moving PR.
4. Reconnect the Fusion add-in before any pass that expects Fusion (project 176821af fell back to Blender and timed out twice).
5. The backlog below.
6. A new TestFlight build and Mac beta from main once 1–3 are in: the public builds predate the scan fix.

## Decided by this lead on Nov 9 (change them if they prove wrong)

- **Cleanup deletes.** David, Nov 9: "you can rm -rf if you really need or dump things that you aren't sure about in /volumes/spillover". The Nov 8 trash-only rule filled the disk and is gone from operations.md. Cleared that day: 21 stale simulators and the iOS 26 runtime, 39 GB of photogrammetry temp, lanes c–h, merged local branches, stale worktrees, old rollback apps and build folders.
- **The lead sits on the Mac** and gives delegates worktrees; lanes a and b remain only for delegates started from a linked machine.
- **Regularising a scan is allowed when it is labelled.** The result schema's `assumed` and `estimated` tags are the label; a touch-up still runs only when the person asks (PRD §5.3).
- **Agent memory** for this project (`~/.claude/projects/-Users-davidmontgomery-fleet-scan-to-make/memory/`, files from Oct 30–Nov 1) is stale in places (React Native, KAN branches, a PR loop no one runs). Nothing here depends on it.

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
