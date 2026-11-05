# Handoff: Counterpart

One screen, updated in place. No dated copies or prompt files; git history keeps the rest. What is built and accepted lives in the [working PRD](../design/overhaul/PRD.md) (§0, §8.0 and each section's status line).

**Owner:** one Counterpart agent thread owns main, releases, installs, docs and cleanup. The owner thread started 2026-11-04 answered `thread_not_found` on Nov 5; since then the "Audit Changes and Prevent Regressions" thread owns it. One trunk: `main` (AGENTS.md). The app staples onto the MCPs (AGENTS.md, PRD §8.0).

## Installed builds

| Where | Build | Source |
|---|---|---|
| Mac `/Applications/Counterpart.app` | 202611051513 (Nov 5 15:17Z) | main `6a6d4dde`, with #321 (what will print) and #326 (a sidebar search says how many projects it hides, and sits in the sidebar). Rollback: 202611050844 at `~/scan-to-make-work/mac-202611051513/Counterpart.previous`. |
| iPhone Davica3 `00008150-001A488C3642401C` | 2.0 (202611050845), Release, development signing, installed Nov 5 | `0c967a58` (#321) |
| Public Mac beta (Sparkle, notarized) | v2.0-beta.4 · 202611040930 | `fbd1a69b` |
| TestFlight | 2.0 (3) uploaded Nov 4; 2.0 (2) last seen Waiting for Review in Counterpart Public Beta | `4a894769` |
| bambu-printer-mcp | npm 1.1.61, installed through Settings → Printers → Update on the Mac (Nov 5 08:56Z) and Linux: draws "What will print" (`include_preview`) | npm |
| mcp-3D-printer-server | your git checkout `~/mcp-3D-printer-server` on `feat/bambu-complete` (dist from `56d8fb9`). npm has 1.2.33. No printer uses it, so the Mac offers no Update or Download for it: "installed through the app" is pending for the Mac's mcp-3D only. npm has 1.2.34, installed through Update on Linux. | git |
| Android | debug APK built from clean main `1b66d937` Nov 5; not installed. T3 emulator launch and its diagnostic retry failed: this process cannot use `/dev/kvm` | `~/scan-to-make-work/android-linux-20261105/` on the Mac |
| Linux agents-136 (Xvfb :93, XFCE) | `.deb` from main `27295626` (#321, #324), with reconstruction 1.2.0, installed Nov 5 08:51Z. The companion runs it (`g27295626afdd…`). bambu-printer-mcp 1.1.61 and mcp-3d-printer-server 1.2.34 were installed through Settings → Printers → Update; no printer is added there. | same folder; AppImage too |

Printer: P1S `01P00C4B2500106`, LAN Only + Developer Mode, AMS A1 black PLA, A2 yellow PLA, A3 PETG. FULU runs in Colima profile `bambu-fulu`; never restart it.

## Open, in order

1. **Moving backend code to the MCPs (PRD §8.0).** Items 1–3 are done (quality/strength #313, refusal codes #314, slicing capability #316). Next is item 4: delete the counterpart/1 fallback and the `backend === 'bambu-printer-mcp'` special cases. Then items 5–12 in order, one at a time; each extends both MCPs, publishes, installs through the app's Update, and only then deletes the app code.
2. **What will print** (David, Nov 5): Print sends exactly the sliced file whose MCP-drawn pictures the sheet showed. Built and installed everywhere (#321, #324; bambu-printer-mcp 1.1.61, mcp-3D 1.2.34). Seen in the Mac app on the caliper card (PRD §0). Open: a print from the sheet, the iPhone sheet on device, Android and Linux in an app. mcp-3D's changelog correction (branch `docs/changelog-m620`) goes out with its next release.
3. Bambu Cloud print route: the fix is in the installed 1.1.59. **David** prints with Connection = Bambu Cloud.
4. FULU through mcp-3D crashes on its config-dir mount (item 12 moves the FULU launcher into bambu-printer-mcp).
5. Completion-check failures now log and return a visible explanation, retaining the message without starting a pass #327. Installed-app verification remains open.
6. Android/Linux engineering check Nov 5: Android `assembleDebug` passed on clean main `1b66d937`, but T3 emulator `Counterpart_API35_Test` and the prescribed diagnostic retry failed with `/dev/kvm` permission denied; no Android UI or pairing checked. Linux agents-136 (`27295626`, Xvfb :93): opened existing local caliper `1b7a26a2` and its Print sheet through AT-SPI, inspected screenshot: “What will print” → “Nothing to show yet”, no configured printer, Print disabled. No print pressed. This is not Mac project `1f1c5515`: Linux has no Mac-pairing client; it uses its own companion’s local Unix socket. Mac pairing and MCP-picture verification remain open. Screenshot and APK: `~/scan-to-make-work/android-linux-20261105/` on Mac. Restored Linux to Settings → Printers, its initial screen. No app changes or reinstall.
7. **A search must never hide projects silently.** Mac fixed and seen live in 202611051513 (#326). Android, iPhone/iPad and Linux now keep search above the filtered list and show the match count with Show All. Mobile searches reveal matching archived projects. Linux counts within the selected Projects/In progress/Archive view. The unsupported Mac toolbar comment is corrected. Android unit tests/lint and Linux tests/build pass; the iPhone/iPad target builds and Mac ObjectsModelTests pass (32 tests). Search UI regression passes on iPhone and iPad simulators: zero/partial matches, clearing and hittability after scrolling. Parent owns final installs; Android/Linux agent owns emulator acceptance. Installed-app verification remains open.
8. The rest of the PRD's not-accepted list (§0).

**Waiting on David:** every physical print; he starts them ("do not reprint anything on your own EVER"). Next: redo the caliper card (`1f1c5515`) in the app and print it (copy of a designer's 3MF, fixed and installed Nov 5, PRD §0), and the Bambu Cloud print (item 3). The phone's "Connected" in Settings was seen on device Nov 4 (old item 4.3, done).

**Infrastructure:** the Jev boundary check runs through OpenRouter because TypeSafe direct has no credits (HTTP 402). Adding TypeSafe credits is the only open infrastructure item, and nothing waits on it. Two existing tests fail intermittently under load: `capture-response-drain` (Node 22 and 24) and `local-control.test.mjs` 'incomplete frame' (Node 24, Nov 5, during 7 parallel agents' gates; 6 of 6 passes alone at `5b1a34e6`).

## Pointers

- How to build, install, gate and drive the apps: [`../operations.md`](../operations.md). Release procedure: [`../distribution.md`](../distribution.md). The MCP names the app uses: [`../protocols/mcp-contract.md`](../protocols/mcp-contract.md).
- Camera/LiDAR blackout from a Continuity display: [`camera-incident-2026-11-02.md`](camera-incident-2026-11-02.md). Capture audit: [`capture-reconstruction-audit-2026-11-02.md`](capture-reconstruction-audit-2026-11-02.md).
- Never-landed work: `git ls-remote --tags origin 'archive/2026-11-04/*'` (83 tags; PRD §18). Don't delete them.
- Evidence and receipts: `~/scan-to-make-work/` on the Mac.
