# Handoff: Counterpart

One screen, updated in place. No dated copies or prompt files; git history keeps the rest. What is built and accepted lives in the [working PRD](../design/overhaul/PRD.md) (§0, §8.0 and each section's status line).

**Owner:** the single Counterpart agent thread started 2026-11-04, which owns main, releases, installs, docs and cleanup. One trunk: `main` (AGENTS.md). The app staples onto the MCPs (AGENTS.md, PRD §8.0).

## Installed builds

| Where | Build | Source |
|---|---|---|
| Mac `/Applications/Counterpart.app` | 202611042143 (Nov 4 21:47Z) | main `1339c1e7`, before #313 and #314; the next Mac build carries them. Rollback: 202611041137 at `~/scan-to-make-work/mac-202611042143/Counterpart.previous`. |
| iPhone Davica3 `00008150-001A488C3642401C` | 2.0 (202611041132), Release, development signing | `38003639` |
| Public Mac beta (Sparkle, notarized) | v2.0-beta.4 · 202611040930 | `fbd1a69b` |
| TestFlight | 2.0 (3) uploaded Nov 4; 2.0 (2) last seen Waiting for Review in Counterpart Public Beta | `4a894769` |
| bambu-printer-mcp | npm 1.1.57, installed through Settings → Printers → Update (Nov 4 21:55Z) | npm |
| mcp-3D-printer-server | your git checkout `~/mcp-3D-printer-server` on `feat/bambu-complete` (dist from `56d8fb9`). npm has 1.2.31. No printer uses it, so the app offers no Update or Download for it: "installed through the app" is pending for mcp-3D only. | git |
| Android | debug APK only, never run on a device or emulator | `~/scan-to-make-work/final-main-167b5770/artifacts/` |
| Linux | `.deb` + AppImage, on agents-136 (Xvfb :93, XFCE) only | same folder |

Printer: P1S `01P00C4B2500106`, LAN Only + Developer Mode, AMS A1 black PLA, A2 yellow PLA, A3 PETG. FULU runs in Colima profile `bambu-fulu`; never restart it.

## Open, in order

1. **Moving backend code to the MCPs (PRD §8.0).** Items 1 (quality/strength, #313) and 2 (refusal codes, #314) are done. Next is item 3, the slicer branching (`isBambuSlicing`, which slicers take supports and copies). Then items 4–12 in order, one at a time; each extends both MCPs, publishes, installs through the app's Update, and only then deletes the app code.
2. Bambu Cloud print route: the fix is in the installed 1.1.57. **David** prints with Connection = Bambu Cloud.
3. FULU through mcp-3D crashes on its config-dir mount (item 12 moves the FULU launcher into bambu-printer-mcp).
4. A change request stalls silently in `completion-intent.ts`: fixed and gated on `fix/completion-check-visible`, waiting behind the migration.
5. Android on a real device or emulator; Linux pairing and printing.
6. The rest of the PRD's not-accepted list (§0).

**Waiting on David:** every physical print; he starts them ("do not reprint anything on your own EVER"). Next is the Bambu Cloud print (item 2). The phone's "Connected" in Settings was seen on device Nov 4 (old item 4.3, done).

**Infrastructure:** the Jev boundary check runs through OpenRouter because TypeSafe direct has no credits (HTTP 402). Adding TypeSafe credits is the only open infrastructure item, and nothing waits on it. One existing test, `capture-response-drain`, fails intermittently (Node 22, once).

## Pointers

- How to build, install, gate and drive the apps: [`../operations.md`](../operations.md). Release procedure: [`../distribution.md`](../distribution.md). The MCP names the app uses: [`../protocols/mcp-contract.md`](../protocols/mcp-contract.md).
- Camera/LiDAR blackout from a Continuity display: [`camera-incident-2026-11-02.md`](camera-incident-2026-11-02.md). Capture audit: [`capture-reconstruction-audit-2026-11-02.md`](capture-reconstruction-audit-2026-11-02.md).
- Never-landed work: `git ls-remote --tags origin 'archive/2026-11-04/*'` (83 tags; PRD §18). Don't delete them.
- Evidence and receipts: `~/scan-to-make-work/` on the Mac.
