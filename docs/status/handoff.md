# Handoff: Counterpart

One screen, updated in place. No dated copies or prompt files; git history keeps the rest. What is built and accepted lives in the [working PRD](../design/overhaul/PRD.md) (§0 and each section's status line).

**Owner:** the single Counterpart agent thread started 2026-11-04, which owns main, releases, installs, docs and cleanup. One trunk: `main` (AGENTS.md).

## Installed builds

| Where | Build | Source (on main) |
|---|---|---|
| Mac `/Applications/Counterpart.app` | 202611041137 | `c5762972` · rollback: build 900 at `~/scan-to-make-work/mac-legacy-colour-202611041137/Counterpart.previous` |
| iPhone Davica3 `00008150-001A488C3642401C` | 2.0 (202611041132), Release, development signing | `38003639` |
| Public Mac beta (Sparkle, notarized) | v2.0-beta.4 · 202611040930 | `fbd1a69b` |
| TestFlight | 2.0 (3) uploaded Nov 4; 2.0 (2) was last seen Waiting for Review in Counterpart Public Beta | `4a894769` |
| bambu-printer-mcp | npm 1.1.54, installed through Settings → Printers → Update | npm |
| mcp-3D-printer-server | hand-built dist from `feat/bambu-complete@56d8fb9` (source branch at `afcf378`) | **not npm**, open item 2 |
| Android | debug APK only, never run on a device or emulator | `~/scan-to-make-work/final-main-167b5770/artifacts/` |
| Linux | `.deb` + AppImage, on agents-136 (Xvfb :93, XFCE) only | same folder |

Printer: P1S `01P00C4B2500106`, LAN Only + Developer Mode, AMS A1 black PLA, A2 yellow PLA, A3 PETG. FULU runs in Colima profile `bambu-fulu`; never restart it.

## Open, in order

1. Bambu Cloud print route: gate and merge bambu-printer-mcp #102 and mcp-3D-printer-server #56 (merging publishes to npm). Then David accepts in the app with Connection = Bambu Cloud.
2. mcp-3D-printer-server parity (`pause_at_layers`, Resume notice, refusal reporting) onto npm, installed through the app's Update.
3. Phone Settings shows "Connected now" while reachability is unknown (`SettingsView.swift`).
4. A change request stalls silently: `completion-intent.ts` turns errors and timeouts into `unknown` and logs nothing.
5. FULU through mcp-3D crashes on its config-dir mount.
6. Android on a real device or emulator; Linux pairing and printing.
7. The rest of the PRD's not-accepted list (§0).

Waiting on David: every physical print (he starts them; "do not reprint anything on your own EVER"), and on-device acceptance of anything marked Built.

## Pointers

- How to build, install, gate and drive the apps: [`../operations.md`](../operations.md). Release procedure: [`../distribution.md`](../distribution.md).
- Camera/LiDAR blackout from a Continuity display: [`camera-incident-2026-11-02.md`](camera-incident-2026-11-02.md). Capture audit: [`capture-reconstruction-audit-2026-11-02.md`](capture-reconstruction-audit-2026-11-02.md).
- Never-landed work: `git ls-remote --tags origin 'archive/2026-11-04/*'` (83 tags; PRD §18). Don't delete them.
- Evidence and receipts: `~/scan-to-make-work/` on the Mac.
