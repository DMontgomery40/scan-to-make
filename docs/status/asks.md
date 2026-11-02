# David's asks: status

Every request David has made for Counterpart, checked on 2026-11-02 around 06:15 MT.
PR #259 (`feat/integrated-recovery`) contains the current repair batch; it is not installed yet.
The running Mac still uses `/Applications/Scan to Make.app`; Davica3 is locked.
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
| 1 | Printing works from the app (stove strips) | many | **partially verified**: installed bambu-printer-mcp is 1.1.51 (the install folder still says 1.1.46). Re-slicing the original stove model removes the former floating-cantilever warning. The real Mac Print Again sheet shows P1S/PLA, 109 g and 3 h 20 min. PR #259 fixes slicer orientation when `laid_flat` is false. No new physical print dispatched; the original print stopped with the toolhead-cover fault | He presses Print in the app and the part prints |
| 2 | Stop/cancel from the app actually stops the printer | 1 | **installed, unverified stop**: actual configured MCP 1.1.51 advertises cancel; QoS 1 implementation confirmed. No running print was stopped during this audit | Stop in the app stops the printer |
| 3 | Done / Works status | 7 | **on device, both** (#240; Mac at `91734f0`, phone at `c2eb1e0`) | Marks the mic mount Done on both |
| 4 | Rename projects | 2 | **branch #259**: editable titles on both clients; capability gated; generated titles cannot overwrite a rename | Taps the name and renames, on both |
| 5 | Project settings (printer, colours, quality, copies, engine, notifications, files, duplicate, archive/delete) | 2 | **in progress, separate follow-up**: unified settings, saved print defaults, Duplicate and per-project engine/notifications are missing; work started from the accepted PRD | Each setting works on both |
| 6 | Claude names projects | 1 | on device (failed captures still unnamed) | Every project has a real name |
| 7 | Scanning works at all | many | **not accepted on device**: walk-around backup contains 117 images and a completed USDZ; fresh production reconstruction and geometry audit in progress. In-hand remains off; Apple-only reconstruction baseline under investigation | A walk-around scan becomes a model; then in-hand |
| 8 | Scanner must not brick the phone camera / Face ID | 1 | **branch #259; device acceptance pending**: capture lifecycle checks pass; pairing camera failures are visible and explicitly retryable. No evidence establishes a hardware fault or proves the recurring camera/Face ID issue resolved | Camera and Face ID fine after scanning |
| 9 | One app, named Counterpart, one icon; old "Scan to Make" builds gone | 2 | **branch #259**: signed Counterpart.app builds, including its renamed embedded agent. Five obsolete hidden app bundles removed; installed app name migration pending | Only "Counterpart" in Applications/Spotlight |
| 10 | Real apps look like the mockups | 2 | **not done**: final installed-screen comparison still needed; conversation layout in #259 | Side-by-side with his real projects matches |
| 11 | Home grid: equal, inset, spaced cards, nothing overlapping | 2 | installed (#243, `a50fcef`); not yet confirmed on his screen | Two equal columns, 16 pt margins, 12 pt gutter |
| 12 | Home title isn't "Counterpart" | 1 | on device (`1925de5`) | — |
| 13 | No fake controls (mic button etc.) | 1 | on device (`1925de5`) | — |
| 14 | Search matches notes and every field | 1 | **branch #259**: shared search includes meaningful project text, notes and fields, excluding internal IDs and paths | Searching a follow-up word finds the project |
| 15 | State is right: "working" while a pass runs, never "Ready to print" mid-change | 2 | **branch #259**: ordered reads reject stale responses; mutations take tickets before sending. Empty idle drafts no longer claim an active transfer | A follow-up shows Working until done, on both |
| 16 | Phone never says "Mac isn't answering" when it is | 1 | **installed from prior work; long-run acceptance pending**: no new one-hour connectivity claim | Stays connected on Home for an hour |
| 17 | Mac and phone allow the same actions (Ask for changes) | 1 | **branch #259**: both clients queue changes during work/printing; uncertain sends pause for Retry/Discard | Same actions available on both |
| 18 | Conversation as message bubbles, photos with their message | 1 | **branch #259**: chronological native bubbles; new photos belong to their actual message. Historical unknown ownership is not invented | Bubbles on both |
| 19 | "DONE / it works" message doesn't start a design pass | 1 | **branch #259**: success reports, including photos, mark Done without a design pass; uncertain classification saves the message; Undo supported | Message marks Done instead |
| 20 | Notifications (ready, question, halfway with camera frame, done, failed) | 3 | **branch #259**: phone CloudKit consumer and frame extension now exist and sign. Actual notification/frame delivery and schema acceptance pending. Saved opt-outs preserved; individual phone/type controls explicitly unsupported | Halfway notification with frame on his phone and Watch |
| 21 | Lock Screen / Live Activity print progress | 1 | **branch #259**: local Lock Screen/Dynamic Island extension and token registration now exist and sign. Remote APNs relay absent; APNs key configuration is prepared in the signed-in developer portal; key registration and relay provisioning remain | Live Activity on his Lock Screen |
| 22 | Printer camera efficient (Scrypted-like) | 1 | **in progress, separate follow-up**: published MCP exposes snapshots only. One real frame: 98,571 bytes, 1280×720, 3.313 s. Unnecessary metadata/background polling identified; full streaming budgets not yet met | Budgets met on his P1S |
| 23 | Getting ready vs printing; printer's own failure text + Print Again | 1 | **on Mac, observed**: original printer failure text and Print Again sheet checked in the real installed app | Shows "Getting ready · …" then real failure text |
| 24 | Print a published model (link → designer's file, credit) | 2 | merged (76d2cf3); not verified on device | Paste a MakerWorld link and it prints that file |
| 25 | Claude unconstrained on the user's Mac (web, images, browser downloads) | 1 | merged in #219 path; not verified | Link flow downloads via his browser |
| 26 | Fusion as a design engine | 2 | **setup verified**: Fusion is installed/running, its add-in responds, configured MCP reports connected, and Mac Settings says Fusion is set up. No real Fusion design pass verified | Set up works; one real pass uses Fusion |
| 27 | Update both MCPs from either app | 2 | **branch #259**: parked updater backend integrated with both clients; print/design/cleanup reservations prevent replacing an MCP in use. Actual app-driven update pending | Update button updates the MCP from the phone and the Mac |
| 28 | Every Mac setting on the phone | 1 | **branch #259**: shared Mac settings UI/contracts present. Secret credentials remain Mac-only. Phone-to-Mac observed round-trip pending | Changes a Mac setting from the phone |
| 29 | Phone connects automatically on the same Apple Account | 1 | **branch #259**: missing phone consumer and pinned enrollment implemented. Signed builds pass; real same-account enrollment pending | Fresh install connects with no code |
| 30 | Help / docs / website | 2 | **site live; app links branch #259**: `/help` returns 200 and is now the target for both apps | counterpart.dtmont.com/help.html loads; Settings → Help opens it |
| 31 | No bed/plate checks anywhere | 3 | done (app + both MCPs) | — |
| 32 | Blender only while a pass runs | 1 | **live cleanup done; automatic fix branch #259**: confirmed app-owned idle Blender PID82771 closed under its shared lock. User Fusion preserved. New lifecycle closes only owned helpers after queued passes and cleanup | No Blender between jobs |
| 33 | CPU/RAM/GPU efficient | 2 | **idle measurement only**: installed app ~107 MiB, companion group ~118 MiB, printer MCP ~64 MiB; each sampled at 0.0% CPU. Full PRD performance acceptance pending | Meets PRD §9.6 budgets |
| 34 | Don't fill the disk with garbage | 1 | **ongoing**: obsolete app bundles and owned build caches removed; integrated source branches retired. User projects/captures and unrelated dirty work retained | Disk stays flat across builds |
| 35 | Credit authors (scan rig, published models) | 1 | in help page; app credit merged for published models | Credits shown in app |
| 36 | Scan rig (Kass 3D) in the app | 1 | **branch #259**: Mac Help opens the credited Kass 3D rig page; phone About already carries the credit | Help → Print the scan rig opens the MakerWorld page |
| 37 | Use the Linux boxes for non-Apple work | 2 | done (#224, #226, stm-ci) | — |
| 38 | Versioning discipline, no overlapping writers | 1 | done (branch_check.py) | — |
| 39 | Real-world testing of the user experience | 1 | ongoing | Each fix tested on his devices |
| 40 | Second opinions (advisor, Codex) | 2 | **ongoing**: competing Claude executors stopped; tool-disabled Claude advice, independent integration review and GitHub reviews used | — |

## Current evidence and outstanding device checks

The combined workflow run at `7c6e09e1` passed the complete phone UI suite, Mac build, capture
lifecycle, packaging, contracts, printer handoff, pipeline and license jobs. Its two companion
fixture failures are corrected; both Node 22/24 companion workflows pass at `4d7c7b3f`.
Later review fixes pass 119 shared tests, 10 simulator AppTests, 25 Mac ObjectsModel tests and the
full native capture suite. Signed integration builds are being refreshed after those fixes.
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
