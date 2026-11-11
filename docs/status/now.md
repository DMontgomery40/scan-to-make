# Now: everything running, everything owed, who has it

The lead's live list. It is updated every time the lead is woken, for any reason, and before the lead ends a turn. [`board.md`](board.md) holds every item and its history; this page holds only what is in motion or owed next, so nothing waits unseen. If a line here is more than an hour old, it is stale: check the thing itself.

**Last checked: 2026-11-11 04:35Z** (lead: thread "Take Over Project Recovery Lead").

## Running

| What | Who (model) | Started | Budget ends | Last seen doing | If it finishes: next |
|---|---|---|---|---|---|
| Bad-link check on the fifth train (#527): every project page, iPhone then iPad, slow / refusing / away | Lead, `scripts/ux_gate.py`, output `~/scan-to-make-work/gate-train-g/` | 04:10Z | about 05:30Z (six lane holds) | 04:30Z: iPhone slow done, iPhone refusing in its hold | exit 0 → `branch_check --merge` → merge #527. Any blank frame → fix first |
| "Make something else from this scan" on every layout (X115) | D: Opus 5.5 high, branch `feat/make-from-scan` | 04:22Z | 06:22Z; milestone 05:22Z (companion route + iPhone/iPad action pushed) | just started | review (Muse) → on top of #527 → this is the build David's devices get |
| AR for designed parts, one AR control (X116) | D: Opus 5.5 high, branch `fix/ar-parts` | 04:33Z | 05:48Z | just started | review → same build as the line above |
| Proven compliant mechanisms study, with a car phone holder held by flexure (X112) | D: Gemini 4 Carbon | 03:10Z | extended to about 04:45Z | 04:30Z: metrology results and figures written; no study file yet | kernel lab round 6 builds the clip, the pliers and the holder |
| Third test plate "Kernel test plate" (`58fd46d9`) | David's P1S | sent 02:02Z | about 04:35Z | 04:30Z: layer 195 of 310, no problem | bed needs clearing; next on the bed is the published torture test (X111) |

## Finished, waiting on the lead (nobody is working on these)

| What | State | Next step, and when |
|---|---|---|
| #527 the fifth train | Gate green at `8a8e97dd`; five review parts, the last says merge | Merge when the bad-link check passes. NOT installed on David's devices by itself (X115) |
| #556 the on-device library (X110) | Built; 2 of 16 away pages still "not available" (plate pictures of unopened projects); 4 pages uncaptured; one unit test to recheck after rebase | Back to a delegate after #527 merges: fill plate pictures, rebase, finish the proof, review |
| Versions ledger and migration (X114, design slice 1) | Design done: `~/scan-to-make-work/things-and-versions-2026-11-11/DESIGN.md` | Start a delegate when #527 is on main (same files) |
| #527's leftovers (review parts 3 to 5) | Listed on the board (X115) | Next train: Home's question buttons and Printing's Did it fit while the Mac is away; the queued change visible and discardable; the stage jumping as content loads; one-main-action gaps; the number pad's 1 s fallback |
| Size card records guesses as measured (X103); look up a named product first (X108) | Not started | Delegate after the versions slice starts; owner of the card is the state-machines session |
| MCP prompts: flexing, toughness, lookups, printed screws, fit-by-function (X113) | Not started | After the compliant study lands: one release in both MCP repos |
| Kernel lab round 6; physics lab round 5 | No round running | Start when the compliant study lands: published limits and his readings (X111), physics handoffs, the three builds |
| Three failures on the smallest iPhone (a finished scan's Send, a search result's reason, a stopped scan on Home) | Not diagnosed; the gate does not run that device | Check against main in a lane hold after the bad-link check |
| Handoff page | Last rewritten 22:05Z Nov 10 | Rewrite when #527 merges |

## Waiting on David (small, named)

| What | Why |
|---|---|
| Add the model file to the project "One published all-in-one printer test…" from MakerWorld | MakerWorld blocks automated downloads; it is the one published test that replaces more coupon plates (X111) |
| Optional: did any bending arm on the second plate stay bent or whiten | Decides how far the strain limit rises for parts that must keep gripping |
| Optional: count the notches on the tight ring from the first plate | He said three; the design says one |

## Rules for this page

- Every delegate started gets a row in "Running" in the same turn, with its budget's end time.
- At each wake the lead opens every running row's actual output (the thread, the files, the log), not its last message, and writes what it saw and when.
- A row past its budget is read and either extended with a reason or stopped; it is never left.
- A finished delegate's leftovers move to "Finished, waiting on the lead" the turn its report is read, with a next step and a when.
