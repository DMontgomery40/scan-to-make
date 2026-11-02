# David's asks: status

Every request David has made for Counterpart, checked on 2026-11-02 at about 01:15 MT against main
(`d621a66`), the Mac app installed at `85597ba`, and the iPhone build `1925de5` on Davica3.

**Done means David can do it on his own device.** "Merged" isn't done. Status values:
- **on device**: David can use it now;
- **merged**: on main, but not on his device;
- **branch**: a PR or branch exists;
- **not started**.

The owner is whoever the lead assigns. Repeats count how often the ask came up again.

| # | Ask | Repeats | Status | Done when |
|---|---|---|---|---|
| 1 | Printing works from the app (stove strips) | many | **broken**: our print command differed from Bambu Studio in 6 fields; KAN-215 fixing | He presses Print in the app and the part prints |
| 2 | Stop/cancel from the app actually stops the printer | 1 | **broken** | Stop in the app stops the printer |
| 3 | Done / Works status | 7 | **on device, both** (Mac and phone at `4d78f6f`) | Marks the mic mount Done on both |
| 4 | Rename projects | 2 | not started | Taps the name and renames, on both |
| 5 | Project settings (printer, colours, quality, copies, engine, notifications, files, duplicate, archive/delete) | 2 | status + hide only | Each setting works on both |
| 6 | Claude names projects | 1 | on device (failed captures still unnamed) | Every project has a real name |
| 7 | Scanning works at all | many | **broken**: in-hand uses a custom recorder + custom Mac pipeline, never produced a model; walk-around unverified | A walk-around scan becomes a model; then in-hand |
| 8 | Scanner must not brick the phone camera / Face ID | 1 | on device (#231) | Camera and Face ID fine after scanning |
| 9 | One app, named Counterpart, one icon; old "Scan to Make" builds gone | 2 | Mac app still `/Applications/Scan to Make.app`; old builds show in Spotlight | Only "Counterpart" in Applications/Spotlight |
| 10 | Real apps look like the mockups | 2 | not done | Side-by-side with his real projects matches |
| 11 | Home grid: equal, inset, spaced cards, nothing overlapping | 2 | **broken on device** (cards overlap) | Two equal columns, 16 pt margins, 12 pt gutter |
| 12 | Home title isn't "Counterpart" | 1 | on device (`1925de5`) | — |
| 13 | No fake controls (mic button etc.) | 1 | on device (`1925de5`) | — |
| 14 | Search matches notes and every field | 1 | not started | Searching a follow-up word finds the project |
| 15 | State is right: "working" while a pass runs, never "Ready to print" mid-change | 2 | not started (KAN-217 queued) | A follow-up shows Working until done, on both |
| 16 | Phone never says "Mac isn't answering" when it is | 1 | on device (`1925de5`) | Stays connected on Home for an hour |
| 17 | Mac and phone allow the same actions (Ask for changes) | 1 | not started | Same actions available on both |
| 18 | Conversation as message bubbles, photos with their message | 1 | spec only (#236) | Bubbles on both |
| 19 | "DONE / it works" message doesn't start a design pass | 1 | spec only (#236) | Message marks Done instead |
| 20 | Notifications (ready, question, halfway with camera frame, done, failed) | 3 | Mac merged; phone needs CloudKit entitlement; relay not deployed | Halfway notification with frame on his phone and Watch |
| 21 | Lock Screen / Live Activity print progress | 1 | relay not deployed (needs his APNs key) | Live Activity on his Lock Screen |
| 22 | Printer camera efficient (Scrypted-like) | 1 | spec + contract (#235, MCP #91/#45) | Budgets met on his P1S |
| 23 | Getting ready vs printing; printer's own failure text + Print Again | 1 | branch #237 | Shows "Getting ready · …" then real failure text |
| 24 | Print a published model (link → designer's file, credit) | 2 | merged (76d2cf3); not verified on device | Paste a MakerWorld link and it prints that file |
| 25 | Claude unconstrained on the user's Mac (web, images, browser downloads) | 1 | merged in #219 path; not verified | Link flow downloads via his browser |
| 26 | Fusion as a design engine | 2 | not started (KAN-220) | Set up works; one real pass uses Fusion |
| 27 | Update both MCPs from either app | 2 | Mac merged; PR 6 waiting | Update button updates the MCP from the phone and the Mac |
| 28 | Every Mac setting on the phone | 1 | merged (#218); not verified on device | Changes a Mac setting from the phone |
| 29 | Phone connects automatically on the same Apple Account | 1 | Mac side merged; phone entitlement pending | Fresh install connects with no code |
| 30 | Help / docs / website | 2 | help page merged (#232); site not deployed (needs his `wrangler login`); no in-app Help link | counterpart.dtmont.com/help.html loads; Settings → Help opens it |
| 31 | No bed/plate checks anywhere | 3 | done (app + both MCPs) | — |
| 32 | Blender only while a pass runs | 1 | spec; a stale Blender from a dev worktree still runs | No Blender between jobs |
| 33 | CPU/RAM/GPU efficient | 2 | Mac still 15–19% CPU, 1.6–1.9 GB idle on a project | Meets PRD §9.6 budgets |
| 34 | Don't fill the disk with garbage | 1 | cleanup done; CI temp cleanup added | Disk stays flat across builds |
| 35 | Credit authors (scan rig, published models) | 1 | in help page; app credit merged for published models | Credits shown in app |
| 36 | Scan rig (Kass 3D) in the app | 1 | spec only | Help → Print the scan rig opens the MakerWorld page |
| 37 | Use the Linux boxes for non-Apple work | 2 | done (#224, #226, stm-ci) | — |
| 38 | Versioning discipline, no overlapping writers | 1 | done (branch_check.py) | — |
| 39 | Real-world testing of the user experience | 1 | ongoing | Each fix tested on his devices |
| 40 | Second opinions (advisor, Codex) | 2 | ongoing | — |

## By 9:00 MT today (lead's commitment, 2026-11-02)

Will land on his devices by 9:00 MT, if the three blockers below are cleared:
- **#1 printing from the app** and **#2 Stop**: KAN-215 matches Bambu Studio's print command. Blocked on his "yes, publish it" for the MCP release.
- **#11 the Home grid**: KAN-217, first thing.
- **#26 Fusion**: KAN-220 ships Set up. Blocked on him installing Autodesk Fusion and opening a design, then pressing Set up.
- **#30 the website**: the lead deploys it. Blocked on him running `wrangler login`.
- **#23** (getting ready, failure text, Print Again): merged as #237, ships with the next Mac deploy.

Not by 9:00 MT:
- **#7 scanning:** first a walk-around scan diagnosed and fixed, then in-hand moved onto Apple's capture. The walk-around fix may land today. In-hand won't by 9.
- The rest of the rows. Each stays in this table until it's on his device.

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
