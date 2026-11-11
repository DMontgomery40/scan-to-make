# Now: everything running, everything owed, who has it

The lead's live list. It is updated every time the lead is woken, for any reason, and before the lead ends a turn. [`board.md`](board.md) holds every item and its history; this page holds only what is in motion or owed next, so nothing waits unseen. If a line here is more than an hour old, it is stale: check the thing itself.

**Last checked: 2026-11-11 06:00Z** (lead: thread "Take Over Project Recovery Lead").

## Running

| What | Who (model) | Started | Budget ends | Last seen doing | If it finishes: next |
|---|---|---|---|---|---|
| The build David gets: main + #568 (CAD workers on Fable high) + #564 (AR for parts, one AR control) + #565 (Make something else from this scan), as `train/2026-11-11a` | D: GPT-6.1 Sol xhigh, conductor | 05:58Z | 07:28Z; milestone 06:33Z (all three merged, compiling, pushed) | just started | review (Muse) → gate + bad-link gate → `branch_check` READ, not chained → merge → install Mac, iPhone, iPad → verify on his phone (the Leatherman page, AR on a part, the trace) |
| The Mac's picture framing (X105) | D: Gemini 4 Carbon, branch `feat/picture-framing` | 04:38Z | extended to 06:23Z | 05:38Z: first version pushed (view from the shape, 82% fit, contact shadow) after the lead's nudge | review → next train |
| Kernel lab round 6: real limits, flexure primitives, the three compliant builds | D: GPT-6.1 Sol xhigh, agents-136 | 04:52Z | 07:52Z | 05:16Z: limits by duty pushed; told to size the clip from the physics checks to at least 50 N on a bag, and given the third plate's readings | three 3MFs → added and printed THROUGH THE APP (X118) |
| Physics lab round 5 | D: Opus 5.5 xhigh, agents-173 (left running: started before David's rule that CAD work is Fable high) | 04:52Z | 07:52Z | 05:44Z: the clip question settled against real clips (the published C-clip: 55 to 58 N on a finger in PLA; engine, a 2D solve and the study agree); printed-screw check; 3 GB ceiling enforced | its report; the next physics round is Fable high |

## Finished, waiting on the lead (nobody is working on these)

| What | State | Next step, and when |
|---|---|---|
| #527 the fifth train | **Merged 05:55Z, main `6acb3cd7`.** Bad-link gate: 0 blank frames, iPhone and iPad, slow / refusing / away. The lead chained the merge onto `branch_check`, which printed NOT SAFE on one boundary flag at p=0.30 (`CompanionClient.swift:48`, the app reading its own companion's refusal body: not backend knowledge; the same check had passed all 57 chunks minutes earlier). Read after the fact; the merge stands; never chained again | Not installed by itself (X115). #509 still shows open on GitHub: check whether its branch has commits the train did not carry |
| #556 the on-device library (X110) | Built; 2 of 16 away pages still "not available" (plate pictures of unopened projects); 4 pages uncaptured; one unit test to recheck after rebase | Back to a delegate after #527 merges: fill plate pictures, rebase, finish the proof, review |
| Versions ledger and migration (X114, design slice 1) | Design done: `~/scan-to-make-work/things-and-versions-2026-11-11/DESIGN.md`; main now has #527 | Start next (GPT-6.1 Sol xhigh), on main, once the conductor's merge milestone is in so it branches from the same files |
| #527's leftovers (review parts 3 to 5) | Listed on the board (X115) | Next train: Home's question buttons and Printing's Did it fit while the Mac is away; the queued change visible and discardable; the stage jumping as content loads; one-main-action gaps; the number pad's 1 s fallback |
| Size card records guesses as measured (X103); look up a named product first (X108) | Not started | Delegate after the versions slice starts; owner of the card is the state-machines session |
| MCP prompts: flexing, toughness, lookups, printed screws, fit-by-function (X113) | Not started; the compliant study landed 04:50Z (`docs/research/compliant-mechanisms-proven.md` in the kernel repo, `4df39d7`) | Next free delegate slot: one release in both MCP repos (Muse Wonder Full drafts the prompt text; Sol reviews) |
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
| Printing the published bag clip, and every other real use of the app by the lead (X118) | The Codex computer-use MCP will not start a session (`bootstrapTimedOut` for every app, seven tries, also after its helper was restarted). It is hosted by the ChatGPT app on the Mac. Nothing is printing; the bed is clear | 05:45Z |

## Rules for this page

- Every delegate started gets a row in "Running" in the same turn, with its budget's end time.
- At each wake the lead opens every running row's actual output (the thread, the files, the log), not its last message, and writes what it saw and when.
- A row past its budget is read and either extended with a reason or stopped; it is never left.
- A finished delegate's leftovers move to "Finished, waiting on the lead" the turn its report is read, with a next step and a when.
