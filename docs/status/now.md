# Now: everything running, everything owed, who has it

The lead's live list. It is updated every time the lead is woken, for any reason, and before the lead ends a turn. [`board.md`](board.md) holds every item and its history; this page holds only what is in motion or owed next, so nothing waits unseen. If a line here is more than an hour old, it is stale: check the thing itself.

**Last checked: 2026-11-11 07:42Z** (lead: thread "Take Over Project Recovery Lead").

## Running

| What | Who (model) | Started | Budget ends | Last seen doing | If it finishes: next |
|---|---|---|---|---|---|
| The build David gets, `train/2026-11-11a` (#570): main + #568 (CAD workers on Fable high) + #564 (AR for parts, one AR control) + #565 (Make something else from this scan) + #571 (picture framing) + #573 (the stage stays dark) | D: GPT-6.1 Sol xhigh, conductor | 05:58Z | 07:58Z (extended 30 min at 06:30Z for #573 and its two joins) | 07:02Z: final whole iPhone and iPad suites holding the lane (18 min in), two more of its jobs queued. Earlier, 06:43Z: all merged; first full phone run iPhone 113 passed / 1 failed, iPad 47 / 1, both the AR Quick Look expectation #564 changed; CounterpartKit 293 of 293 after the merge; Mac, companion, Linux and picture checks running in both lane slots | the lead reads the AR failure and its fix → review (Muse) → gate + bad-link gate → `branch_check` READ, not chained → merge → install Mac, iPhone, iPad → on his phone: the Leatherman page offers "Make something else from this scan", one AR chip, AR on a designed part |
| The Forester's dash, mapped from published sources (X123): shape, plastic, tape, heat, best spot; the case and the phone's buttons | D: Gemini 4 Carbon high | 07:33Z | 45 min | just started; report to `~/scan-to-make-work/forester-dash-2026-11-11/REPORT.md` | the lead reads it, puts it in the kernel repo's `docs/research/`, and the holder is revised to the real spot (Fable high) |
| A person can open a model file in Counterpart (X122), #582 | D: Claude Opus 5.5 medium, `fix/open-a-model-file` | 07:13Z; back for review fixes 07:42Z | 45 min from 07:42Z | Built; Mac tests 57 of 57. Muse's review (`~/scan-to-make-work/open-a-file-2026-11-11/review-582.md`): merge after (1) a refused file is said out loud, not ignored; (2) proof that Finder offers Counterpart for a real `.3mf`; (3) the phone gap is a board row, not settled parity (X124) | the next train |

## Finished, waiting on the lead (nobody is working on these)

| What | State | Next step, and when |
|---|---|---|
| #527 the fifth train | **Merged 05:55Z, main `6acb3cd7`.** Bad-link gate: 0 blank frames, iPhone and iPad, slow / refusing / away. The lead chained the merge onto `branch_check`, which printed NOT SAFE on one boundary flag at p=0.30 (`CompanionClient.swift:48`, the app reading its own companion's refusal body: not backend knowledge; the same check had passed all 57 chunks minutes earlier). Read after the fact; the merge stands; never chained again | Not installed by itself (X115). #509 still shows open on GitHub: check whether its branch has commits the train did not carry |
| #556 the on-device library (X110) | Built; 2 of 16 away pages still "not available" (plate pictures of unopened projects); 4 pages uncaptured; one unit test to recheck after rebase | Back to a delegate after #527 merges: fill plate pictures, rebase, finish the proof, review |
| Versions ledger and migration (X114, design slice 1) | Design done: `~/scan-to-make-work/things-and-versions-2026-11-11/DESIGN.md`; main now has #527 | Start next (GPT-6.1 Sol xhigh), on main, once the conductor's merge milestone is in so it branches from the same files |
| #527's leftovers (review parts 3 to 5) | Listed on the board (X115) | Next train: Home's question buttons and Printing's Did it fit while the Mac is away; the queued change visible and discardable; the stage jumping as content loads; one-main-action gaps; the number pad's 1 s fallback |
| Size card records guesses as measured (X103); look up a named product first (X108) | Not started | Delegate after the versions slice starts; owner of the card is the state-machines session |
| Kernel round 6 (GPT-6.1 Sol) and physics round 5 (Opus) | Both done and read. Round 6's three builds are not printed (X121). Physics: the clip question settled against real clips; printed screws checked as plastic; the strength swing down from 50% to 14%, not closed | The next physics round is Fable high: the swing, hot ASA, the cam clips |
| The research instruction in both MCPs (X123): `fdm_design` says when and how to research, for any model with web tools, in a few minutes | mcp-3d-printer-server #98 merged 07:42Z (1.2.69, publishing); bambu-printer-mcp #142 (1.1.87): Codex clean, CI running, watched | Verify npm, tags, releases, pages; update both through the app |
| MCP design prompts (X113) | **Published and in the app.** bambu-printer-mcp 1.1.86 and mcp-3d-printer-server 1.2.68 (1.2.67 plus Codex's pocket-corner correction): npm, fresh `npx` start listing `fdm_fit` and `fdm_flexures`, tags, releases and changelog pages verified. Installed on the Mac at 07:25Z by pressing the app's own Update in Settings → Printers (the page then read "Installed 1.1.86" and "Installed 1.2.68"). The two Update buttons have no accessibility name (X122) | The strengthened `fdm_design` and `cad_design` reach the worker now. `fdm_fit` and `fdm_flexures` are not read by the app yet: start after the train merges (it touches `invocation.ts`, as #568 does): the MCPs say which prompts a design pass reads (`counterpart/1`), the companion reads those, and no prompt names live in the app. Then retype the Forester prompt in the app (X121, second half) |
| The round 7 phone holder (X121) | Read by the lead 07:05Z: one piece, PETG, 40 g, 67 min; the phone slides down between two sprung arms into corner cups, held by its case's edges; nothing behind it (wallet clear); push in about 7 N, lift out about 9 N, by calculation; the foot takes the tape. Not checked by anyone's hands yet; PETG is for trying and mild days, ASA for the car | **NOT printed.** 07:10Z: the lead's hands could not get the file into the Mac app without a pointer (X122); the bed is clear, the printer untouched. The file is `~/Downloads/phone-holder-forester.3mf`. Next: David drags it onto New Project once (asked 07:15Z), then the print sheet is driven by accessibility as before; or it waits for the X122 build |
| Kernel round 7, all three (Fable high; kernel repo `897af3e`, `REPORT-round7.md`, `prints/2026-11-11-compliant-r7/`) | Done and read 07:28Z, renders looked at. **Nothing printed or handled.** Bag clip: PETG, 11.5 g, 40 min, opened by pinching two ribbed tabs with about 2 kg, bites 41 to 47 N on a finger (59 N in PLA, the published clip's bite), strain at the stop 3.12% (little margin). Pliers: one piece, no pin, 35 g, 71 min, 84 N at the tips from a 35 N squeeze by lever statics only. The kernel has no topology for any of the three flexures: its gates were fed hand numbers. Files as a person would have them: `~/Downloads/bag-clip-squeeze.3mf`, `~/Downloads/one-piece-pliers.3mf`, `~/Downloads/phone-holder-forester.3mf` | Print the holder, then the clip, through the app once a file can get in (X122); his hands judge them. Next kernel round: flexure topologies for a tapered arm, an arch clip and a strip pivot, so the gates check instead of being fed |
| The published bag clip (X119) | Printed 06:14Z to about 06:35Z through the app; David, 06:45Z: "that is done and cleared and that is a damn very cipply clip". The bed is clear | David, 06:50Z: "not a very usable clip, at all, not fun to use". So it is the yardstick for bite only; the kernel's own clip must match the bite and be easy to open; the next print is the round 7 holder |
| Third test plate (J, K, L, T) | Printed; pieces in David's hands | His readings: T and L now, K if he likes, J's keys in tonight then day 1 and day 7 |
| Three failures on the smallest iPhone (a finished scan's Send, a search result's reason, a stopped scan on Home) | Not diagnosed; the gate does not run that device | Check against main in a lane hold after the bad-link check |
| Handoff page | Last rewritten 22:05Z Nov 10 | Rewrite when #527 merges |

## Waiting on David (small, named)

| What | Why |
|---|---|
| Add the model file to the project "One published all-in-one printer test…" from MakerWorld | MakerWorld blocks automated downloads; it is the one published test that replaces more coupon plates (X111) |
| Optional: did any bending arm on the second plate stay bent or whiten | Decides how far the strain limit rises for parts that must keep gripping |
| Optional: count the notches on the tight ring from the first plate | He said three; the design says one |

## Blocked

| What | On what | Since |
|---|---|---|
| The Codex computer-use MCP from T3 sessions | `bootstrapTimedOut` for the lead, for a fresh client from a plain shell, and for a Claude delegate; a Codex delegate did not have the tools at all. Cause unknown. Until it works, real use of the Mac app is driven by accessibility presses through `osascript` (no keystrokes, no pointer, no activation), which printed the bag clip at 06:14Z | 05:45Z |

## Rules for this page

- Every delegate started gets a row in "Running" in the same turn, with its budget's end time.
- At each wake the lead opens every running row's actual output (the thread, the files, the log), not its last message, and writes what it saw and when.
- A row past its budget is read and either extended with a reason or stopped; it is never left.
- A finished delegate's leftovers move to "Finished, waiting on the lead" the turn its report is read, with a next step and a when.
