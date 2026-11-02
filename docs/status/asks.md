# David's asks: status

Every request David has made for Counterpart, updated after the 2026-11-02 release installation.
PRs #259–#263 and #265 are merged. Counterpart on the Mac has signed build
`202611020921` from `f1d2dde6`; Davica3 has `202611020904` from `c5ba0d8e`.
The phone remains locked. Physical installation and UI acceptance are separate.
Code/build evidence and observed device behavior are distinguished below.

How to pick up this work, and the diagnosis notes behind the P0 rows: [`handoff.md`](handoff.md).

**Done means David can do it on his own device.** "Merged" isn't done. Status values:
- **on device**: installed on his device and checked there;
- **installed**: on his device, but nobody has confirmed it on his screen yet;
- **merged**: on main, but not on his device;
- **branch**: a PR or branch exists;
- **not started**.

The owner is whoever the lead assigns. Repeats count how often the ask came up again.

| # | Ask | Repeats | Status | Done when |
|---|---|---|---|---|
| 1 | Printing works from the app (stove strips) | many | **partially verified**: reviewed local bambu-printer-mcp 1.1.52 from PR #95 (`16787aa`) is installed; configured SSH reports P1S Ready. Public npm remains 1.1.51, with no publication. Re-slicing the original stove model removes the former floating-cantilever warning. The real Mac Print Again sheet shows P1S/PLA, 109 g and 3 h 20 min. PR #259 fixes slicer orientation when `laid_flat` is false. Installed Mac acceptance found a two-copy failure: Bambu Studio rejects `--slice 0 --repetitions 2`. Fine/one-copy succeeds (4 h 48 min, 104 g); the upstream flag fix and truthful multi-plate handling are underway. No new physical print dispatched; the original print stopped with the toolhead-cover fault | He presses Print in the app and the part prints |
| 2 | Stop/cancel from the app actually stops the printer | 1 | **installed, unverified stop**: cancel capability and QoS 1 implementation were confirmed in the 1.1.51 audit; reviewed local 1.1.52 is now installed. No running print was stopped during this audit | Stop in the app stops the printer |
| 3 | Done / Works status | 7 | **on device, both** (#240; Mac at `91734f0`, phone at `c2eb1e0`) | Marks the mic mount Done on both |
| 4 | Rename projects | 2 | **installed #259; acceptance partial**: Mac rename saved and restored on the real stove project; phone implemented but locked; generated titles cannot overwrite a rename | Taps the name and renames, on both |
| 5 | Project settings (printer, colours, quality, copies, engine, notifications, files, duplicate, archive/delete) | 2 | **installed; Mac acceptance partial, [PR #260](https://github.com/DMontgomery40/scan-to-make/pull/260)**: unified native Project Settings on both; saved printer/colour/quality/strength/copies, next-pass engine, print alerts, original-file export and independent Duplicate implemented and tested. The installed Mac independently duplicates the model, renames the copy, saves Fine/two-copy defaults and carries them into Print. This exposed the two-copy slicer defect in row 1. Original project files/settings are unchanged. Phone UI acceptance remains locked; two isolated simulator checks passed | Each setting works on both |
| 6 | Claude names projects | 1 | on device (failed captures still unnamed) | Every project has a real name |
| 7 | Scanning works at all | many | **not accepted on device**: recorded walk-around phone and Mac models both have an incomplete rear; Apple-only in-hand replay reconstructs the hand instead of the object. Valid STL/topology checks pass but quality fails; in-hand remains off | A walk-around scan becomes a model; then in-hand |
| 8 | Scanner must not brick the phone camera / Face ID | 1 | **installed #259; device acceptance pending**: capture lifecycle checks pass; pairing camera failures are visible and explicitly retryable. No evidence establishes a hardware fault or proves the recurring camera/Face ID issue resolved | Camera and Face ID fine after scanning |
| 9 | One app, named Counterpart, one icon; old "Scan to Make" builds gone | 2 | **installed #259; acceptance partial**: Counterpart.app and its renamed embedded agent are installed/running; old installed app moved to rollback storage. Five obsolete hidden bundles removed; Launch Services now registers the new app; the rollback bundle no longer has an app extension | Only "Counterpart" in Applications/Spotlight |
| 10 | Real apps look like the mockups | 2 | **not done**: final installed-screen comparison still needed; conversation layout in #259 | Side-by-side with his real projects matches |
| 11 | Home grid: equal, inset, spaced cards, nothing overlapping | 2 | installed (#243, `a50fcef`); not yet confirmed on his screen | Two equal columns, 16 pt margins, 12 pt gutter |
| 12 | Home title isn't "Counterpart" | 1 | on device (`1925de5`) | — |
| 13 | No fake controls (mic button etc.) | 1 | on device (`1925de5`) | — |
| 14 | Search matches notes and every field | 1 | **installed #259; acceptance partial**: installed Mac search finds the stove project by the follow-up phrase “25 inches”; shared search excludes internal IDs and paths; phone locked | Searching a follow-up word finds the project |
| 15 | State is right: "working" while a pass runs, never "Ready to print" mid-change | 2 | **installed #259; acceptance partial**: ordered reads reject stale responses; mutations take tickets before sending. Empty idle drafts no longer claim an active transfer | A follow-up shows Working until done, on both |
| 16 | Phone never says "Mac isn't answering" when it is | 1 | **installed from prior work; long-run acceptance pending**: no new one-hour connectivity claim | Stays connected on Home for an hour |
| 17 | Mac and phone allow the same actions (Ask for changes) | 1 | **installed #259; acceptance partial**: both clients queue changes during work/printing; uncertain sends pause for Retry/Discard | Same actions available on both |
| 18 | Conversation as message bubbles, photos with their message | 1 | **installed #259; acceptance partial**: chronological native bubbles; new photos belong to their actual message. Historical unknown ownership is not invented | Bubbles on both |
| 19 | "DONE / it works" message doesn't start a design pass | 1 | **installed #259; acceptance partial**: success reports, including photos, mark Done without a design pass; uncertain classification saves the message; Undo supported | Message marks Done instead |
| 20 | Notifications (ready, question, halfway with camera frame, done, failed) | 3 | **installed #259; acceptance partial**: phone CloudKit consumer and frame extension now exist and sign. Actual notification/frame delivery and schema acceptance pending. Saved opt-outs preserved; individual phone/type controls explicitly unsupported | Halfway notification with frame on his phone and Watch |
| 21 | Lock Screen / Live Activity print progress | 1 | **installed #259; acceptance partial**: local Lock Screen/Dynamic Island extension and token registration now exist and sign. Remote APNs relay absent; APNs key configuration is prepared in the signed-in developer portal; key registration and relay provisioning remain | Live Activity on his Lock Screen |
| 22 | Printer camera efficient (Scrypted-like) | 1 | **installed #262; sustained acceptance pending**: native streaming prerequisite is installed as reviewed local Bambu MCP 1.1.52 (`16787aa`); public npm stays 1.1.51. App streaming PR #262 is installed in build `202611020904` and later. Earlier snapshot: 98,571 bytes, 1280×720, 3.313 s; sustained budgets on the installed app remain unverified | Budgets met on his P1S |
| 23 | Getting ready vs printing; printer's own failure text + Print Again | 1 | **on Mac, observed**: original printer failure text and Print Again sheet checked in the real installed app | Shows "Getting ready · …" then real failure text |
| 24 | Print a published model (link → designer's file, credit) | 2 | merged (76d2cf3); not verified on device | Paste a MakerWorld link and it prints that file |
| 25 | Claude unconstrained on the user's Mac (web, images, browser downloads) | 1 | merged in #219 path; not verified | Link flow downloads via his browser |
| 26 | Fusion as a design engine | 2 | **setup verified**: Fusion is installed/running, its add-in responds, configured MCP reports connected, and Mac Settings says Fusion is set up. No real Fusion design pass verified | Set up works; one real pass uses Fusion |
| 27 | Update both MCPs from either app | 2 | **installed #259; acceptance partial**: parked updater backend integrated with both clients; print/design/cleanup reservations prevent replacing an MCP in use. Actual app-driven update pending | Update button updates the MCP from the phone and the Mac |
| 28 | Every Mac setting on the phone | 1 | **installed #259; acceptance partial**: shared Mac settings UI/contracts present. Secret credentials remain Mac-only. Phone-to-Mac observed round-trip pending | Changes a Mac setting from the phone |
| 29 | Phone connects automatically on the same Apple Account | 1 | **installed #259; acceptance partial**: missing phone consumer and pinned enrollment implemented. Signed builds pass; real same-account enrollment pending | Fresh install connects with no code |
| 30 | Help / docs / website | 2 | **on Mac, observed; phone installed**: Help opened the live Counterpart Help page from the installed Mac menu; phone UI remains locked | counterpart.dtmont.com/help.html loads; Settings → Help opens it |
| 31 | No bed/plate checks anywhere | 3 | done (app + both MCPs) | — |
| 32 | Blender only while a pass runs | 1 | **installed #259/#265; owned-helper lifecycle observed**: isolated cleanup closed its owned helper and released port 9876. An outdated Blender add-on and delayed duplicate activation caused inspection failures; the official add-on was updated with backup/preferences preserved, and installed #265 avoids reactivation. Material/solid inspection calls pass. A fresh full cleanup rerun is underway | No Blender between jobs |
| 33 | CPU/RAM/GPU efficient | 2 | **installed Mac sample**: physical footprint app 100 MB / companion 70 MB; five idle CPU samples app average 1.08% (peak 5.2%), companion 0%. Phone Instruments and sustained performance acceptance pending | Meets PRD §9.6 budgets |
| 34 | Don't fill the disk with garbage | 1 | **ongoing**: obsolete app bundles and owned build caches removed, including another ~2.5 GB of unused DerivedData after installation; integrated source branches retired. User projects/captures and unrelated dirty work retained | Disk stays flat across builds |
| 35 | Credit authors (scan rig, published models) | 1 | in help page; app credit merged for published models | Credits shown in app |
| 36 | Scan rig (Kass 3D) in the app | 1 | **installed #259; acceptance partial**: Mac Help opens the credited Kass 3D rig page; phone About already carries the credit | Help → Print the scan rig opens the MakerWorld page |
| 37 | Use the Linux boxes for non-Apple work | 2 | done (#224, #226, stm-ci) | — |
| 38 | Versioning discipline, no overlapping writers | 1 | done (branch_check.py) | — |
| 39 | Real-world testing of the user experience | 1 | ongoing | Each fix tested on his devices |
| 40 | Second opinions (advisor, Codex) | 2 | **ongoing**: competing Claude executors stopped; tool-disabled Claude advice, independent integration review and GitHub reviews used | — |

## Current evidence and outstanding device checks

The combined workflow run at `7c6e09e1` passed the complete phone UI suite, Mac build, capture
lifecycle, packaging, contracts, printer handoff, pipeline and license jobs. Its two companion
fixture failures are corrected; both Node 22/24 companion workflows pass at `4d7c7b3f`.
Later review fixes pass 119 shared tests, 10 simulator AppTests, 25 Mac ObjectsModel tests and the
full native capture suite. Signed integration builds pass and are installed. Both Node 22/24 companion workflows also pass the final updater deadline fix at `3b8ea525`.
Hosted Actions cannot start because of the account billing restriction; no required checks are configured.

No new physical print, stop test, camera/Face ID acceptance, phone/Watch push receipt or fresh
same-account enrollment has been claimed. Davica3 reports `passcodeRequired: true`; an unlock
request is pending. The APNs relay requires credentials and deployment. These do not prevent
continued implementation and Mac acceptance work.

## Scanning diagnosis (row 7)

- The walk-around scan uses Apple's `ObjectCaptureSession` on the phone.
- In-hand uses a hand-rolled `AVCaptureSession` RGB+LiDAR recorder (`HandheldCapture.swift`, `HandheldDepthRecorder.swift`). On the Mac it then goes through a custom pipeline: `tools/mac-reconstruct samples`, with Vision hand masks from `HandheldKit/ObjectMasker.swift`.

**Second opinion from Codex (gpt-6-astra, high, read-only):**
- Keep Apple's reconstruction. `PhotogrammetrySession` with `isObjectMaskingEnabled` explicitly supports turning the object between photos.
- First try a baseline: run `samples … --no-masks`, which keeps Apple's own masking.
- For production, capture sharp, overlapping still photos with depth and "turn, pause, capture" guidance, then drop the custom recorder and masker.

Defects Codex found in the code:
- 24 frames at 10 fps qualifies about 2.4 s of near-identical views.
- `ObjectMasker` clips beyond the nearest depth + 20 cm, so a nearer hand erases the object.
- `ObjectMasker` subtracts the hands before choosing the object.
- `reconstruct.ts` throws away the reconstruction's stderr, which hides the real error.
