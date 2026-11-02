# David's asks: status

Every request David has made for Counterpart, checked on 2026-11-02 at about 04:10 MT (10:10Z) against
main (`9cb3300`), the Mac app installed at `91734f0`, and the iPhone build `c2eb1e0` on Davica3.

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
| 1 | Printing works from the app (stove strips) | many | **broken: the print stopped**. He pressed Print in the app at 08:49Z; the stove strips (`2f0a0229`) printed upside down (fin on the bed) and stopped at 09:57Z, layer 44 of 52. The printer said: "The front cover of the toolhead fell off." Upside down because of `lay_flat`, which picked a face not on the hull (with printer-handoff's `orient: !laidFlat`). Fixing: KAN-223's slicer gate in printer-handoff, and `lay_flat` + `slicer_result` PRs in both MCPs, published only on his yes | He presses Print in the app and the part prints |
| 2 | Stop/cancel from the app actually stops the printer | 1 | **fixed in bambu-printer-mcp 1.1.50** (Studio's stop at QoS 1); KAN-220 deploying it to the Mac now; not yet tried on his printer | Stop in the app stops the printer |
| 3 | Done / Works status | 7 | **on device, both** (#240; Mac at `91734f0`, phone at `c2eb1e0`) | Marks the mic mount Done on both |
| 4 | Rename projects | 2 | not started | Taps the name and renames, on both |
| 5 | Project settings (printer, colours, quality, copies, engine, notifications, files, duplicate, archive/delete) | 2 | status + hide only | Each setting works on both |
| 6 | Claude names projects | 1 | on device (failed captures still unnamed) | Every project has a real name |
| 7 | Scanning works at all | many | **broken**: Scan in hand is turned off (#246); it never produced a model. Walk-around unverified; KAN-217 traces it end to end in the reboot acceptance run | A walk-around scan becomes a model; then in-hand |
| 8 | Scanner must not brick the phone camera / Face ID | 1 | **installed, acceptance not run**: it broke again after #231 (Scan in hand's LiDAR session kept running after the app was swiped away). #246 (`c2eb1e0`) on Davica3 since 09:23Z; reboot acceptance waits on David, KAN-217 recording the syslog | Camera and Face ID fine after scanning |
| 9 | One app, named Counterpart, one icon; old "Scan to Make" builds gone | 2 | Mac app still `/Applications/Scan to Make.app`; old builds show in Spotlight | Only "Counterpart" in Applications/Spotlight |
| 10 | Real apps look like the mockups | 2 | not done | Side-by-side with his real projects matches |
| 11 | Home grid: equal, inset, spaced cards, nothing overlapping | 2 | installed (#243, `a50fcef`); not yet confirmed on his screen | Two equal columns, 16 pt margins, 12 pt gutter |
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
| 23 | Getting ready vs printing; printer's own failure text + Print Again | 1 | installed on the Mac (#237, `91734f0`); not yet confirmed on his screen | Shows "Getting ready · …" then real failure text |
| 24 | Print a published model (link → designer's file, credit) | 2 | merged (76d2cf3); not verified on device | Paste a MakerWorld link and it prints that file |
| 25 | Claude unconstrained on the user's Mac (web, images, browser downloads) | 1 | merged in #219 path; not verified | Link flow downloads via his browser |
| 26 | Fusion as a design engine | 2 | Set Up installed on the Mac (#244, #245); not yet confirmed working there; no real pass yet | Set up works; one real pass uses Fusion |
| 27 | Update both MCPs from either app | 2 | Mac merged; PR 6 waiting | Update button updates the MCP from the phone and the Mac |
| 28 | Every Mac setting on the phone | 1 | merged (#218); not verified on device | Changes a Mac setting from the phone |
| 29 | Phone connects automatically on the same Apple Account | 1 | Mac side merged; phone entitlement pending | Fresh install connects with no code |
| 30 | Help / docs / website | 2 | **site live** at https://counterpart.dtmont.com (deployed 2026-11-02, checked from agents-136: `/` 200, `/help.html` → `/help` 200 "Counterpart Help"); in-app Help link not yet built | counterpart.dtmont.com/help.html loads; Settings → Help opens it |
| 31 | No bed/plate checks anywhere | 3 | done (app + both MCPs) | — |
| 32 | Blender only while a pass runs | 1 | spec; a stale Blender from a dev worktree still runs | No Blender between jobs |
| 33 | CPU/RAM/GPU efficient | 2 | Mac memory 1.4 GB → 82 MB with #247 (`91734f0`, installed); CPU not re-measured | Meets PRD §9.6 budgets |
| 34 | Don't fill the disk with garbage | 1 | cleanup done; CI temp cleanup added | Disk stays flat across builds |
| 35 | Credit authors (scan rig, published models) | 1 | in help page; app credit merged for published models | Credits shown in app |
| 36 | Scan rig (Kass 3D) in the app | 1 | spec only | Help → Print the scan rig opens the MakerWorld page |
| 37 | Use the Linux boxes for non-Apple work | 2 | done (#224, #226, stm-ci) | — |
| 38 | Versioning discipline, no overlapping writers | 1 | done (branch_check.py) | — |
| 39 | Real-world testing of the user experience | 1 | ongoing | Each fix tested on his devices |
| 40 | Second opinions (advisor, Codex) | 2 | ongoing | — |

## By 9:00 MT today (lead's commitment, 2026-11-02), as of 03:50 MT

- **#1 printing from the app:** the app sent a print, but the strips printed upside down and stopped at layer 44 of 52 ("The front cover of the toolhead fell off."). The fix is in progress: KAN-223's slicer gate in `services/printer-handoff`, and `lay_flat` + `slicer_result` PRs in both MCP repos, unmerged until he says publish.
- **#2 Stop:** fixed in bambu-printer-mcp 1.1.50 on npm; KAN-220 is deploying it to the Mac now. The GitHub tag and Release for 1.1.50 (and mcp-3D-printer-server 1.2.24) wait on his yes.
- **#8 camera:** #246 is on Davica3; the reboot acceptance waits on David.
- **#11 the Home grid:** #243 installed on Davica3; he hasn't confirmed it yet.
- **#26 Fusion:** Set Up (#244, #245) is installed on the Mac. Still needs him to install Autodesk Fusion, open a design and press Set Up.
- **#30 the website:** live.
- **#23** (getting ready, failure text, Print Again): installed on the Mac at `91734f0`.

Not by 9:00 MT:
- **#7 scanning:** KAN-217 traces a walk-around scan through to a model on the Mac in the acceptance run. In-hand stays off until it moves onto Apple's capture.
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
