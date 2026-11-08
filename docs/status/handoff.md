# Handoff: Counterpart

One screen, updated in place; git history keeps the rest. This is the only handoff: no dated copies or prompt files. What is built and accepted lives in the [working PRD](../design/overhaul/PRD.md) (§0, §8.0).

**How the owner works (David, Nov 6–8).** An item ends only as *done and verified on David's real install* (with evidence: SHA, log line, AX read, camera frame) or *blocked on one small thing only David can do*, named exactly. Green CI is not verification. Find facts yourself (code, logs, `object.json`, MQTT, camera); never ask David what you can read. Never end a turn "waiting"; re-drive agents that do. After every merge, `git pull` on agents-173, agents-136, agents-171 and the Mac.

## Installed now

| Where | What |
|---|---|
| Mac app | **202611080746** from main `76127f6b` (#409), installed Nov 8 10:09Z while the printer was idle. Read-only checks pass: `printers.mcps` answered both MCPs in 0.06 s; `objects.estimate` for `7f1a9e33` plate index 2 answered in 32 s (13 h 1 min, 464.74 g); Counterpart never frontmost (225 samples). Settings rows not checked: no Settings window was open. Receipt: `~/scan-to-make-work/mac-202611080746/verification-results.txt`. Rollback: 202611062313 at `~/scan-to-make-work/mac-202611062313/Counterpart-202611062313.app`. |
| Mac MCP copies | bambu-printer-mcp **1.1.77**, mcp-3d-printer-server **1.2.58**, unchanged by the Nov 8 install (bambu 1.1.79 and mcp-3D 1.2.60 are published). The P1S's mcp-3D profile runs Counterpart's copy: `printers.mcps` on Nov 8 reads "Bambu Lab P1S uses Counterpart’s copy (1.2.58)", because `overrides.json` points it there; `profiles.json` still names the `~/mcp-3D-printer-server` checkout (1.2.25). |
| iPhone Davica3, iPad Air | Nov 5 builds (iPhone `0c967a58`, iPad `a13cef78`). None of the Nov 6–7 fixes are on them. |
| Android, Linux (agents-136) | Nov 5 builds with Nov 5 MCP copies. Stale. |
| Public | beta 6 (GitHub pre-release, from `30e3afdd`). Site live from `6692b4a2` (`wrangler deploy` by hand; it does not deploy on merge). |
| TestFlight | **2.0 (4) Approved** Nov 7, from main `30e3afdd`; assigned to **Counterpart Public Beta**, automatic tester notification selected. [Public link](https://testflight.apple.com/join/S4tExVzp) enabled, no configured tester limit/criteria, **Feedback On**, 0 testers at verification. Product description and What to Test saved: camera+LiDAR scans and automatic touch-up, spoken ideas, known-part dimension lookup, conversational edits, and printer reports with matching diagnostics ZIPs. In-hand is Labs/unavailable; AR is nonblocking. IPA distribution signatures/Production entitlements revalidated (`745dcca8…05bd`). No fresh external-tester install or production push delivery claimed. Details: [distribution](../distribution.md). |

Printer: P1S, LAN Only + Developer Mode; AMS A1 black PLA (nearly empty), A2 yellow PLA, A3 PETG, A4 Blue Gray PLA. FULU runs in Colima `bambu-fulu`; never restart it.

## Open, in order

1. **Printing from Counterpart on the P1S.**
   - Status: the scan rig (`7f1a9e33`) plate 4 printed through Counterpart Nov 7 07:30–10:25Z on bambu-printer-mcp 1.1.77. That is the first success after the upload fixes (1.1.74: 64 KiB writes; 1.1.77: 120 s print-upload stall limit plus progress). Plate 2 (18.4 MB) stalled at 72% on 1.1.76. Nov 8 10:12Z upload probe on the installed 1.1.77 path (`ftpUpload` → `uploadBytes`): 18,362,734 bytes to `/counterpart-probe` went through in 112 s at 160 KiB/s, longest write pause 0.8 s (at 94%), end of data → `226` 0.78 s; size matched, then `DELE`/`RMD` (receipt `~/scan-to-make-work/mac-202611080746/probe/`). One idle run, FTP leg only: the Nov 6 mid-file pause did not recur, so the 120 s stall limit was not exercised. A real large print from Counterpart is still unproven.
   - Next: David prints the remaining rig plate (5, Lifting Parts) from Counterpart; watch it and own any failure.
   - Wrong state: plates 0, 1, 2 and 3 were printed from Studio/Handy, but Counterpart shows 0 and 1 "Check print result" and 2 "failed". Make "printed elsewhere" recordable so the strip reads true, on every layout.
   - Wrong label: the Nov 6 morning failure (no fresh MQTT report, refused before anything was sent) was recorded as uncertain. Anything never sent must read "not started" (same class as #385). Both MCPs must report structured dispatch truth; the app must not match their error codes or wording.
   - Review checkpoint (Nov 8, lane-a): [Counterpart #404](https://github.com/DMontgomery40/scan-to-make/pull/404) adds **I printed this elsewhere** on every layout. Review found its missing-timestamp inference unsafe; that inference and the monitor-only label are removed, with legacy records and refusal codes retaining main's display and printer check. Both structured-result producers are ready for lead review: [bambu #129](https://github.com/DMontgomery40/bambu-printer-mcp/pull/129) (prepared 1.1.80) and [mcp-3D #87](https://github.com/DMontgomery40/mcp-3D-printer-server/pull/87) (prepared 1.2.61). Their current-head CI is green and both remain unmerged. Lead review/publication comes first; then the companion must consume and persist `printOutcome`, test both directions, and rerun the full gate. Printed-elsewhere interaction checks and Apple API/Duo evidence remain in the PR. No real project data changed and no app installed. Evidence and Trash receipts: `~/scan-to-make-work/print-truth-20261108/`.
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
