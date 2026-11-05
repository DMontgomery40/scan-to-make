# Handoff: Counterpart

One screen, updated in place. No dated copies or prompt files; git history keeps the rest. What is built and accepted lives in the [working PRD](../design/overhaul/PRD.md) (§0, §8.0 and each section's status line).

**Owner:** the single Counterpart agent thread started 2026-11-04, which owns main, releases, installs, docs and cleanup. One trunk: `main` (AGENTS.md). The app staples onto the MCPs (AGENTS.md, PRD §8.0).

## Installed builds

| Where | Build | Source |
|---|---|---|
| Mac `/Applications/Counterpart.app` | 202611050844 (Nov 5 08:47Z) | main `0c967a58`, with #318, #320 and #321 (what will print). Rollback: 202611050554 at `~/scan-to-make-work/mac-202611050844/Counterpart.previous`. |
| iPhone Davica3 `00008150-001A488C3642401C` | 2.0 (202611050845), Release, development signing, installed Nov 5 | `0c967a58` (#321) |
| Public Mac beta (Sparkle, notarized) | v2.0-beta.4 · 202611040930 | `fbd1a69b` |
| TestFlight | 2.0 (3) uploaded Nov 4; 2.0 (2) last seen Waiting for Review in Counterpart Public Beta | `4a894769` |
| bambu-printer-mcp | npm 1.1.61, installed through Settings → Printers → Update on the Mac (Nov 5 08:56Z) and Linux: draws "What will print" (`include_preview`) | npm |
| mcp-3D-printer-server | your git checkout `~/mcp-3D-printer-server` on `feat/bambu-complete` (dist from `56d8fb9`). npm has 1.2.33. No printer uses it, so the Mac offers no Update or Download for it: "installed through the app" is pending for the Mac's mcp-3D only. npm has 1.2.34, installed through Update on Linux. | git |
| Android | debug APK from main `27295626` (with #324, what will print), never run on a device or emulator | `~/scan-to-make-work/main-builds-20261105/` on the Mac |
| Linux agents-136 (Xvfb :93, XFCE) | `.deb` from main `27295626` (#321, #324), with reconstruction 1.2.0, installed Nov 5 08:51Z. The companion runs it (`g27295626afdd…`). bambu-printer-mcp 1.1.61 and mcp-3d-printer-server 1.2.34 were installed through Settings → Printers → Update; no printer is added there. | same folder; AppImage too |

Printer: P1S `01P00C4B2500106`, LAN Only + Developer Mode, AMS A1 black PLA, A2 yellow PLA, A3 PETG. FULU runs in Colima profile `bambu-fulu`; never restart it.

## Open, in order

1. **Moving backend code to the MCPs (PRD §8.0).** Items 1–3 are done (quality/strength #313, refusal codes #314, slicing capability #316). Next is item 4: delete the counterpart/1 fallback and the `backend === 'bambu-printer-mcp'` special cases. Then items 5–12 in order, one at a time; each extends both MCPs, publishes, installs through the app's Update, and only then deletes the app code.
2. **What will print** (David, Nov 5): Print sends exactly the sliced file whose MCP-drawn pictures the sheet showed. Built and installed everywhere (#321, #324; bambu-printer-mcp 1.1.61, mcp-3D 1.2.34). Seen in the Mac app on the caliper card (PRD §0). Open: a print from the sheet, the iPhone sheet on device, Android and Linux in an app. mcp-3D's changelog correction (branch `docs/changelog-m620`) goes out with its next release.
3. Bambu Cloud print route: the fix is in the installed 1.1.59. **David** prints with Connection = Bambu Cloud.
4. FULU through mcp-3D crashes on its config-dir mount (item 12 moves the FULU launcher into bambu-printer-mcp).
5. A change request stalls silently in `completion-intent.ts`: fixed and gated on `fix/completion-check-visible`, waiting behind the migration.
6. Android on a real device or emulator; Linux pairing and printing.
7. The rest of the PRD's not-accepted list (§0).

**Waiting on David:** every physical print; he starts them ("do not reprint anything on your own EVER"). Next: redo the caliper card (`1f1c5515`) in the app and print it (copy of a designer's 3MF, fixed and installed Nov 5, PRD §0), and the Bambu Cloud print (item 3). The phone's "Connected" in Settings was seen on device Nov 4 (old item 4.3, done).

**Infrastructure:** the Jev boundary check runs through OpenRouter because TypeSafe direct has no credits (HTTP 402). Adding TypeSafe credits is the only open infrastructure item, and nothing waits on it. One existing test, `capture-response-drain`, fails intermittently (once on Node 22, once on Node 24).

## Pointers

- How to build, install, gate and drive the apps: [`../operations.md`](../operations.md). Release procedure: [`../distribution.md`](../distribution.md). The MCP names the app uses: [`../protocols/mcp-contract.md`](../protocols/mcp-contract.md).
- Camera/LiDAR blackout from a Continuity display: [`camera-incident-2026-11-02.md`](camera-incident-2026-11-02.md). Capture audit: [`capture-reconstruction-audit-2026-11-02.md`](capture-reconstruction-audit-2026-11-02.md).
- Never-landed work: `git ls-remote --tags origin 'archive/2026-11-04/*'` (83 tags; PRD §18). Don't delete them.
- Evidence and receipts: `~/scan-to-make-work/` on the Mac.
