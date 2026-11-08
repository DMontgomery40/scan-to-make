# Handoff: Counterpart

One screen, updated in place; git history keeps the rest. This is the only handoff: no dated copies or prompt files. What is built and accepted lives in the [working PRD](../design/overhaul/PRD.md) (§0, §8.0).

**How the owner works (David, Nov 6–8).** An item ends only as *done and verified on David's real install* (with evidence: SHA, log line, AX read, camera frame) or *blocked on one small thing only David can do*, named exactly. Green CI is not verification. Find facts yourself (code, logs, `object.json`, MQTT, camera); never ask David what you can read. Never end a turn "waiting"; re-drive agents that do. After every merge, `git pull` on agents-173, agents-136, agents-171 and the Mac.

## Installed now

| Where | What |
|---|---|
| Mac app | 202611062313 from main `779559fc`. Missing #392 (phone Add printer), #396 (upload progress %) and #397. Rollback in `~/scan-to-make-work/mac-202611062313/`. |
| Mac MCP copies | bambu-printer-mcp **1.1.77**, mcp-3d-printer-server **1.2.58** (bambu 1.1.78 is published). The P1S's mcp-3D profile still runs the hand-built `~/mcp-3D-printer-server` checkout. |
| iPhone Davica3, iPad Air | Nov 5 builds (iPhone `0c967a58`, iPad `a13cef78`). None of the Nov 6–7 fixes are on them. |
| Android, Linux (agents-136) | Nov 5 builds with Nov 5 MCP copies. Stale. |
| Public | beta 6 (GitHub pre-release, from `30e3afdd`). Site live from `6692b4a2` (`wrangler deploy` by hand; it does not deploy on merge). TestFlight 2.0 (4) approved in Counterpart Public Beta (#398, open). |

Printer: P1S, LAN Only + Developer Mode; AMS A1 black PLA (nearly empty), A2 yellow PLA, A3 PETG, A4 Blue Gray PLA. FULU runs in Colima `bambu-fulu`; never restart it.

## Open, in order

1. **Printing from Counterpart on the P1S.**
   - Status: the scan rig (`7f1a9e33`) plate 4 printed through Counterpart Nov 7 07:30–10:25Z on bambu-printer-mcp 1.1.77. That is the first success after the upload fixes (1.1.74: 64 KiB writes; 1.1.77: 120 s print-upload stall limit plus progress). The large-file case is still unproven: plate 2 (18.4 MB) stalled at 72% on 1.1.76.
   - Next: when the printer is idle, upload an 18,362,734-byte scratch file to `/counterpart-probe` with the installed code path, logging the longest pause and the end-of-data → `226` gap, then delete it (raw `DELE`/`RMD`). Then David prints the remaining rig plate (5, Lifting Parts) from Counterpart; watch it and own any failure.
   - Wrong state: plates 0, 1, 2 and 3 were printed from Studio/Handy, but Counterpart shows 0 and 1 "Check print result" and 2 "failed". Make "printed elsewhere" recordable so the strip reads true, on every layout.
   - Wrong label: the Nov 6 morning failure (no fresh MQTT report, refused before anything was sent) was recorded as uncertain. Anything never sent must read "not started" (same class as #385). Check the code the MCP returns for that refusal and map it.
2. **Install current main on the Mac**, then the read-only checks:
   - the build number;
   - the MCP versions;
   - `printers.mcps` answers both MCPs within 5 s;
   - both Settings rows, if the window is open;
   - a real `objects.estimate`;
   - Counterpart never frontmost.

   Record the result in this file.
3. **Install current main on David's iPhone, iPad, Android and Linux** and run the same checks. Plate picker, per-plate filaments, Update and phone Add printer have only run in simulators.
4. **Boundary leftovers** (AGENTS.md "The app staples onto the MCPs"):
   - the shared ControlKit form encoding (Mac Add Printer sheet and phones) still branches on `"bambu"` and `BAMBU_MODEL`; make it generic from `counterpart_setup_fields` (#392 merged over it with `--boundary-reviewed`);
   - move title, designer and licence into `list_3mf_plates` in both MCPs, publish, install, then delete `inspectModelFile`'s remaining 3MF parsing (PRD §8.0 item 9);
   - port bambu 1.1.69's M624 skip-object mask exemption to mcp-3D.
5. **Flaky tests: fix the cause, no retries.**
   - `capture-response-drain`;
   - `local-control` 'incomplete frame';
   - `published.test.mjs` file arrival;
   - bambu `remote-slicer` deadline;
   - mcp-3D FULU controls;
   - the hosted iPhone simulator launch timeout (the Mac's own iPhone/iPad gate is authoritative).
6. **OctoPrint follow-ups** (built: #386 approve, #389 web address; checked only against Docker virtual printers):
   - (a) the MCP reports its normalized endpoint in counterpart/1, so one printer typed two ways lists once;
   - (b) Bonjour TXT `path`;
   - (c) layer progress, Cancelobject, Spoolman and thumbnails, researched and not built.
7. **Studio-audit leftovers:**
   - the external-spool mapping needs a camera-checked print David starts;
   - AMS Lite trays 24–27 wait for A2L support;
   - plate-filament edge cases (paint on modifiers, filament 0, all three feature filaments overriding, layer ranges) are listed in bambu-printer-mcp#121 and mcp-3D#81.
8. The rest of the PRD's not-accepted list (§0).

**Other owners:** #398 (TestFlight description and approval record) edits this file; coordinate. bambu-printer-mcp#128 (X1C native route) belongs to someone else.

**Waiting on David:** every physical print; he starts them.

## Pointers

- Build, install, gate, deploy: [`../operations.md`](../operations.md). Releases: [`../distribution.md`](../distribution.md). MCP names the app uses: [`../protocols/mcp-contract.md`](../protocols/mcp-contract.md).
- Evidence and receipts: `~/scan-to-make-work/` on the Mac.
- Never-landed work: `git ls-remote --tags origin 'archive/2026-11-04/*'` (PRD §18). Don't delete them.
