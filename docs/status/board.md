# Board: everything open on Counterpart

The one list of open work. [`handoff.md`](handoff.md) is the one-screen summary and points here; this file holds every item.

**Rules for whoever leads** (David, Nov 9: "it's kind of shocking to see the lack of discipline and tracking and crack-sealing so things don't fall through cracks ... not to mention the ideas that pop up along the way"):
- Anything David says that is a defect, a wish or an idea gets a row here in the same turn it is said, in his words, before any work starts on it.
- Anything a delegate, a review or another session reports as "not done", "follow-up", "unverified" or "noted" gets a row in the same turn the report is read. A report is not finished being read until its leftovers are here.
- A row leaves only as **done** (with the PR and what proved it), or **dropped** (with who said so). Nothing is deleted quietly.
- Every row has an owner. "Lead" is an owner; "nobody" is not: an unowned row is listed under "No owner yet" and the lead clears that section before ending a working session.
- Update this file in the same PR as the change that moves a row, and at every merge.

Owners: **Lead** = the lead session (Claude Fable 5.2, Mac, thread "Take Over Scan-to-Make Delivery"). **SM** = the state-machines session (Claude Fable 5.2, thread "Find Implicit State Machines"), which builds and hands PRs to the lead. **D:** a delegate of the lead, named by its T3 thread title. **David** = only he can do it.

Last reconciled: 2026-11-10 07:05Z, main `8ee2a829`, by the lead.

## Right now

- **A print is running**: "Wall holder for three" (`30a2a33c`), started from Counterpart 06:49Z, about 2 h 10 m, 410 layers, ends about 09:05Z. Printing beats gating: one simulator or build at a time under `~/.stm-ios.lock`, and the lead checks the print's reports at every wake and owns any failure.
- **Installed**: Mac, iPhone and iPad all on **202611100531** from main `8ee2a829`. MCP copies bambu-printer-mcp 1.1.77, mcp-3d-printer-server 1.2.58. Android and Linux (agents-136) on Nov 5 builds.

## Waiting on David

| ID | What | Detail |
|---|---|---|
| W1 | Say "publish them" | Ten MCP pull requests, all green, merge in this order (each already claims its version). bambu-printer-mcp: #132 (1.1.80) → #129 (1.1.81) → #131 (1.1.82) → #136 (1.1.83, code engine) → #137 (1.1.84, slicer hang). mcp-3D-printer-server: #91 → #87 → #90 → #92 (code engine) → #93 (slicer hang), 1.2.61–1.2.65. Then Update both MCPs in Settings → Printers and press Set Up on the Design engine row. Unblocks Q1–Q4. |
| W2 | His word on layout exceptions | PRD §6.1 states these as fact; AGENTS.md wants his quote: Mac and Linux have no offline-Mac banner or Mac download link; Mac and Linux have no Printing screen (the Mac inspector asks "Did it fit?"); Linux posts no notifications; Android has no iCloud route; Live Activity relay, identity and milestone rows for Android and Linux; fold continuity on Mac, Android and Linux "existing single selection" (unverified). |
| W3 | Delete the staging folders | `/Volumes/Spillover/stm-cleanup-2026-11-09/` (about 62 GB) and `/Volumes/Spillover/stm-scratch/` (delegates' scratch, about 45 GB). A hook blocks recursive deletes for agents on the Mac. |
| W4 | Overrule or keep four lead decisions | (a) a tapped notification never replaces a New or Print sheet that is up; (b) with several devices, a progress milestone alerts on the Live Activity only when every device has one, and a missed alert on one device is not re-sent as a notification; (c) scan regularisation is allowed when labelled `assumed`; (d) the boundary check's three low-confidence flags on #439 were recorded as reviewed. |
| W5 | Fast tiers for delegates that block a landing | Opus 5.5 fast mode, GPT-6.1 Sol priority tier. Costs more; asked Nov 10, no answer. |
| W6 | Archive the stale agent memory | `~/.claude/projects/-Users-davidmontgomery-fleet-scan-to-make/memory/` (16 files, Oct 30–Nov 1; React Native, KAN branches). Not loaded by this session. |
| W7 | Questions from the parts design | Arrive with I4's proposal. |

## In flight

| ID | What | Owner | Where | Next |
|---|---|---|---|---|
| I1 | **Train 2026-11-10**: MCP update journal (#440), one way a pass ends (#441), navigation as one value (#442), the look-at-it rule in operations.md | Lead | PR #443, head `b1f08ea5`. Review done (`~/scan-to-make-work/train-2026-11-10/review-443.md`), fixes merged. | Companion and iPhone/iPad reruns running → `branch_check` → merge → install Mac, iPhone, iPad. |
| I2 | **The question's photo is unreadable; "What you sent" is a wall of 77 photos** (David, Nov 9) | D: "The question card's photo must be readable…" | No PR yet | Photo large with the region clear, a caption true for any question, a scan shown as one strip with a count; every layout; real-data before/after. |
| I3 | **Nothing looks at finished screens**: `scripts/ux_screens.sh` (every screen, real project data, iPhone, iPad, Duo, Mac if it can be rendered off screen) and a first whole-app list of what is plainly wrong | D: "Look at the real app…" | No PR yet; output `~/scan-to-make-work/ux-audit-2026-11-10/` | Tool PR + `first-look.md`. Then the lead runs the council scoring (R1) and turns every finding into rows here. |
| I4 | **A project made of parts** ("we just wanted a new lid, not the whole box again") | D: "Design proposal: a project made of parts…" | `~/scan-to-make-work/parts-design-2026-11-10/proposal.md` | Read it, bring David the model in five sentences, the first slice and the questions (W7); then slice it into rows. |
| I5 | **The project's picture**: a gallery over a list (not three fixed views); the scan stays viewable; the result wears its filament colour; a Together view with the object in every seat (fit passes record seats; a seats-only action for older projects) | D: "The project's picture…" | No PR yet | PR with real-data screenshots on every layout. |
| I6 | "Is the Mac answering?" as one value, with the Android port (M8) | SM | PR #444 `7f055345` | Next train. |
| I7 | Duo open: Printers and Settings in the edge rail (David, Nov 9) | SM | PR #445 `9202bde8`, stacked on #442 | Retarget to main after I1 lands; next train; four answers in the body. |
| I8 | The companion sends the words for how each pass ended; fixtures' wrong spellings fixed (M2 slice 1) | SM | Branch `feat/pass-ending-words`, not pushed | Open as not-ready; real-data captures once I3's tool lands. |

## Queued: owned, not started

| ID | What | Owner | Waits on |
|---|---|---|---|
| Q1 | #413 generic setup form, then #410 MCP Update rows, as one train (triage: `~/scan-to-make-work/branch-triage-2026-11-09/triage.md`) | Lead | W1 |
| Q2 | Print attempt and plates as one design: the #404 rework on the MCPs' `printOutcome`, a stalled slice during Print reads "not sent", "printed elsewhere" (M1 + rest of M2) | SM | W1 for the wire half; the in-memory half can start |
| Q3 | Kinds of "Needs you" (M4): a size question shows number fields prefilled from the scan and takes numbers back; the "Fit brief" block David never wrote becomes fields, and his request is shown as he wrote it | SM | After I8 |
| Q4 | One engine, stage 2: Blender and Fusion setup, repair, lock and launch leave the app; engine names come from the MCP | Lead | W1, David accepting the code engine on his device, and X6 |
| Q5 | Phone draft send (M7): a send from the project page never enters `store.sending`, so Home says "Draft saved" and a reopened page can send twice (by reading) | SM | One check on David's phone with his next scan |
| Q6 | A new TestFlight build and Mac beta from main (the public builds are from Nov 6 and predate the scan fix) | Lead | I1, I2, I5 landed and looked at |
| Q7 | Refresh Android and Linux installs (Nov 5 builds) | Lead | After Q6 |

## No owner yet (the lead clears this section each session)

| ID | What | Source |
|---|---|---|
| X1 | A gate-run check that the real iPad view survives a resize: needs a driver other than XCTest's `open(URL)` | #443 review F5; SM's attempt, stash "F5 attempt…" on its #442 worktree |
| X2 | Does a link (widget, Live Activity, notification) open a second iPad window in the shipped app? Info.plist allows multiple scenes and nothing says which window takes a link | SM, Nov 10 |
| X3 | #439 leftovers: the iOS Set Up fixture is not stateful; "latest final run" ties on `completed_at`; a companion stopped mid-pass does not collect that attempt's runs | `~/scan-to-make-work/train-2026-11-10/review-439.md` F5, F7, F3 |
| X4 | A designer's 3MF sent with no words still runs a pass and gets the scan-cleanup sentence | #430 report |
| X5 | The gate: split the 22-minute iPhone and iPad job onto two simulators; give the Android job a warm Gradle cache (Maven rate-limited four cold runs; agents-173 ran them instead); `clients.yml`'s Android step assumes a Linux host | Lead, Nov 10; #437 review note 7 |
| X6 | The code engine cannot write an edited 3MF project, so designer-3MF copies stay on Blender. Needed before Q4 can remove Blender | #439 report |
| X7 | Code engine unverified on real Linux (confinement written, never run), Windows, Docker, network-mounted data volumes | #136, #92 reports |
| X8 | OrcaSlicer 2.4.0-dev on this Mac crashes on every slice; a real-home Orca slice may also hang on its own crash record; the `bambu-native` helper was not checked for the same dialog hang | #137 report |
| X9 | About 15 MB of Live Activity screenshots landed in `docs/design/screenshots/live-activity/` as review evidence; move them to the evidence folder | #437 review; the lead said it would and has not |
| X10 | agents-136: two release scratch clones under `~/scan-to-make-work/` hold 81 commits on no remote and small uncommitted edits; archive-tag, then remove | agents-136 cleanup report |
| X11 | PRD §0's status table still says "checked at `4baf0cd8`, Nov 4" and carries Nov 5 install rows | Lead, Nov 9 |
| X12 | Smaller implicit state machines from the audit (`~/scan-to-make-work/state-machines-2026-11-09/state-machines.html`): four separate "can Print" rules in the print sheet (L); Mac Add Printer: changing the form does not stop a key approval (M); Mac detail pane's three flags (S); capture stop and reconstruction cancel as three Bools (M); nearby pairing code minted with no holder when the session expires during Allow (S); Android first run skips the notification-permission screen after a fresh pair (S, by reading); Android "ARCore couldn't start" set and never shown (S, by reading); Linux shell `running && !connected` means both starting and lost (S); `scan-processing.ts` has no caller in the companion: delete it with the pairing fixture's use | SM audit |
| X13 | Live Activity and milestone alerts are unproven on a locked real phone during a real print (tonight's print is the first chance: the Mac build has them, relay on by default) | #437 reports |
| X14 | The touch-up rules' "recognise and regularise" have never run in the installed app on a real scan | #430 |
| X15 | The Bambu Studio crash record the lead moved aside on Nov 10 is in `/Volumes/Spillover/stm-cleanup-2026-11-09/bambu-studio-crash-state/`; until #137 is published, a new Studio crash can bring the slice hang back | Lead, Nov 10 |
| X16 | agents-173's only Android emulator image was deleted in cleanup; the next emulator test recreates it | agents-173 cleanup report |
| X17 | Older T3 worktrees in the MCP repos that are not this session's: mcp-3D `feat-bambu-parity-pauses`, `feat-tool-annotations`; bambu `feat-control-route-pr`, `research-control-refusal` | Lead, Nov 10 |

## Carried from before Nov 9 (still open)

| ID | What | Owner |
|---|---|---|
| C1 | A large print from Counterpart is unproven; rig plate 5 (Lifting Parts) is David's to start | David starts; Lead watches |
| C2 | A send refused before anything was sent must read "not started" | SM, with Q2 |
| C3 | Move title, designer and licence into `list_3mf_plates` in both MCPs, publish, install, then delete `inspectModelFile`'s 3MF parsing (PRD §8.0 item 9); port bambu 1.1.69's M624 skip-object mask exemption to mcp-3D | No owner yet |
| C4 | The FULU drain change (pause, resume, stop) was checked only against mocked hosts: check on the P1S the next time David pauses, resumes or stops from Counterpart | Lead |
| C5 | OctoPrint follow-ups: one printer typed two ways lists once; Bonjour TXT `path`; layer progress, Cancelobject, Spoolman, thumbnails | No owner yet |
| C6 | Studio-audit leftovers: external-spool mapping needs a camera-checked print; AMS Lite trays 24–27; plate-filament edge cases (bambu-printer-mcp#121, mcp-3D#81) | No owner yet |
| C7 | The rest of the PRD's not-accepted list (§0) | Lead, after X11 |

## What David said, Nov 9–10, and where it went

| When (local) | His words, shortened | Row |
|---|---|---|
| Nov 9 | "clean up all these branches … clean up space on the mac" | Done: nine remote branches → three (all waiting on W1); 50 → 200 GiB free |
| Nov 9 | "I was presumably NEVER using the app with all fixes included … squash all the changes together … then run the review" | Done: the train (operations.md); two trains landed |
| Nov 9 | build123d: "we should include it, and the MCP … put a note in docs and the read me … that they can take it out" | Done in #136/#92 (unpublished: W1) |
| Nov 9 | "replace blender as well … get down to one core thing" | Stage 1 done (#439); Q4, X6 |
| Nov 9 | "what if these new models are good enough to literally just write it from scratch" | Idea L1 |
| Nov 9 | "This all seems weirdly slow" | X5; Mac capped at about three heavy delegates; W5 |
| Nov 9 | Use the wait tool; message other sessions; correct them as they go | Done: operations.md; in use |
| Nov 9 11:13 pm | "the area it's highlighting is almost impossible to see" | I2 |
| Nov 9 11:19 pm | "highly unnecessary to show every single one of these … images" | I2 |
| Nov 9 11:19 pm | "is there no reviewing thing that actually looks at what was just made" | I3, R1; rule in operations.md (on I1) |
| Nov 9 11:35 pm | "i am no longer allowed to see the scanned object, anywhere, ever … it just stays tan and weird forever" | I5 |
| Nov 9 | Duo open: Printers and Settings in the side edge rail | I7 |
| Nov 9 | "forget about the unicorn project" | Dropped: no unicorn projects in fixtures, captures or the open list; the "reconnect Fusion for 176821af" item is dropped with it |
| Nov 9 | "don't hardcode it to three views … we just wanted a new lid" | I5 (gallery over a list), I4 (parts) |
| Nov 9 | Together view: "a perfect idea … it's generally painfully obvious where the object should be" | I5 |
| Nov 9 | "how are you keeping track of this?? what is just getting forgotten" | This file |
| (seen by the lead in his screenshots) | A "Fit brief:" block he never wrote is shown as his request | Q3 |
| (seen by the lead) | A size question offers Camera, Photos, Best guess | Q3 |

## Reviews owed

| ID | What | When |
|---|---|---|
| R1 | Council scoring of real-data screenshots (four questions; nine or more from each reviewer) for every train that changes what a person sees | From the first train after I3 lands; I2 and I5 carry their own before/after sets meanwhile |

## Ideas for later (not committed work)

| ID | Idea | From |
|---|---|---|
| L1 | A small geometry kernel written from scratch on distance fields (watertight by construction, no 640 MB environment, could run in the MCP or on the phone), tried against the same holder and unicorn cases once the code engine has shipped | David, Nov 9 |
| L2 | The Together view shows the clearance per seat ("0.8 mm clear") from the code engine's fit check | Lead, Nov 10; David: "note that for later" |
| L3 | Jira instead of this file: the lead's Atlassian connector is not authorised in this kind of session; a markdown board in the repo is readable by every agent on every machine | David, Nov 10 |

## Done since Nov 9 (proof in each PR)

#429 docs · #430 worker rules per pass, recognise and regularise · #434 closed bottom after support removal · #437 the Nov 9 train (#436 pass limits and resume, #431–#433 home and print UX, #435 relay default, #411 and #412 Live Activity identity and milestone alerts) · #438 handoff · #439 one engine, stage 1 · MCP PRs opened and green: bambu #136, #137; mcp-3D #92, #93; #91's Node 18 failure fixed · Mac disk 50 → 200 GiB free · slicing restored on David's Mac (crash record moved aside, X15).
