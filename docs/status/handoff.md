# Handoff: Counterpart

Updated in place; git history keeps the rest. This is the only handoff: no dated copies or prompt files. What is built and accepted is in the [working PRD](../design/overhaul/PRD.md) (§0, §8.0); how to gate, build and install is in [operations](../operations.md); machines, paths, ports and state folders are in the [infrastructure map](../infrastructure.md). Every open item, its owner and its next step is in [`board.md`](board.md): read it after this page. Anything David says, and anything a report leaves undone, gets a row there in the same turn.

**How the owner works (David, Nov 6–10).** An item ends only as *done and verified on David's real install* (with evidence: SHA, log line, AX read, camera frame) or *blocked on one small thing only David can do*, named exactly. Green CI is not verification. Find facts yourself (code, logs, `object.json`, MQTT, camera); never ask David what you can read. Never end a turn "waiting"; re-drive agents that do. Scanning by hand is physically hard for him. He cannot leave his iPhone unlocked. Never take his screen and never press controls in his installed app: read and drive through the companion's control socket. Rules and notes in this repo can be stale: when one contradicts what David said later or what the code does, fix the note in the same PR.

**What is running and owed this hour is in [`now.md`](now.md), which the lead updates at every wake. Read it first.**

## Now (2026-11-11, 08:46Z): a new lead

The new lead is Claude Opus 5.5 (high) in a T3 thread on agents-173, since 08:40Z. The council's synthesis reached David at 08:41Z in the removed lead's thread. #570's three gate failures are fixed on the train (`203d13e0`) and the gate is running again; [`now.md`](now.md) has the live state.

## Before that (2026-11-11, 08:35Z): the lead was removed

David removed the lead (thread "Take Over Project Recovery Lead", Claude Fable 5.2) at 08:33Z on Nov 11, after the phone holder for his 2016 Forester came out worse on every round. His words: "THAT IS THE WORST FUCKING DESIGN, FROM A PRACTICAL, DESIGN, AND PURE PHYSICS STANDPOINT, I HAE EVER SEEN IN MY LIFE FOR A PHONE HOLDER INA CAR"; "THERE IS SOMEHTING FUNDAMENTALLY WRONT WITH THE ENGINE"; "I'M ABOUT TOT FUCKING ROLL BAKC 50 COMMITS UNLESS YOU CAN ROOT OUT HOW THE FUCKKKKKKKKKKKK THIS GOT SOOOOOO FUCKING BAD". The live list is [`now.md`](now.md); every item is in [`board.md`](board.md) (last rows X121 to X126). Nothing was rolled back or deleted from any repo by the removed lead.

### What the removed lead got wrong (so the next one does not repeat it)

1. **Showed David a design whose own report listed a failing check.** Round 7b's holder had no swivel ("faces the cabin square-on, not the driver") and a tape margin of 0.85 in heat with half its foot touching. The lead had the same doubt reading it and relayed it anyway (X126).
2. **Wrote briefs that removed what a model already knows.** Round 7's brief forbade opening earlier designs, which lost the swivel. Round 7b's brief froze the hold "because it was right" and named the mounting face. Round 7c's first brief told the lab it could design a base that "does not rely on tape", against David's request and against what VHB tape is (corrected by a steer at 08:30Z).
3. **Passed lookup questions to David** (a photo of his dash, a wallet thickness) and asked him three times to drag a file into the app (X123, X126). Never again: operations.md, "Never ask the person what is published".
4. **Used Claude Haiku for three control subagents.** Nothing told the lead to; operations.md names the delegates' models and Haiku is not among them. David: "WHAT FUCKING THING TOLD YOU TO USE HAIKIU". Do not use Haiku or Sonnet for anything.
5. **Wrote times into the board ahead of the clock** twice more (corrected in #579). Read `date -u` before writing a time.
6. **Earlier in the night:** scripted a print through the control socket instead of the app (X118); merged #527 by chaining past a NOT SAFE (operations.md); said his phone was "asleep" four times.

### The open question David asked, and the evidence so far

"ASK THE WHOLE T3 COUNCIL WHY THE FUCK THIS CATASTROPHE FUCKING HAPPNEED AND WHAT ALLOWED IT TO HAPPEN AND HOW IT WILL NEVER FUKCING HAPPEN AGAIN AND IT'S NOT FUCKING REVIEW AND LINT RULTES THERE IS SOMEHTING FUNDAMENTALLY WRONT WITH THE ENGINE."

Everything is in `~/scan-to-make-work/council-holder-2026-11-11/` on the Mac:
- `BRIEF.md`: the question as put to the council (Claude Opus 5.5, Muse Wonder 1.0, GPT-6.1 Sol, each high, read-only on the kernel's reading copy `~/scan-to-make-work/kernel-first-print-2026-11-10/counterpart-kernel`).
- `muse-wonder-1.0.md`: **done, 2/10 as a design engine.** The engine verifies descriptions the designing agent writes; it does not design. Its requirement vocabulary (`src/facts.ts:58-71`) can say "does not break" and "does not fall out" and nothing about facing the driver, reach, or the mount's moment. Round 7b's delivered record (`prints/2026-11-11-compliant-r7b/holder.record.json`) has no supports, no loads, no held object and print-frame gravity; its one requirement is the arm's strain, through a gate the designer fed (`physics/src/beam/kernel-compliant.ts:42`). An adhesive support is turned into a fixed face (`physics/src/record.ts:169`). The tape arithmetic was a hand formula outside the gate system (`src/r7bholder.ts:21-28`). A better solver would not have helped. Top changes: a mandatory, computed assembly (object, use-frame gravity and jolts, real interface models; an unmodelled interface blocks "ready"); a purpose layer compiled into evaluated requirements; delete the designer-fed gate.
- `claude-opus-5-5.md`, `gpt-6.1-sol.md`: **still being written at 08:35Z** (threads "Council (Claude Opus 5.5)…" and "Council (GPT-6.1 Sol)…", children of the removed lead's thread; both were steered at 08:32Z to explain the control result below and given 10 more minutes). Their final messages go to the removed lead's thread: read the files.
- `CONTROL-no-engine.md`: at David's word ("ASK ANY FUCKING MODEL OR EVEN SUBAGENT"), three fresh subagents were given only his request, no tools. Each, in 17 to 82 seconds, produced a proper taped pad (about 70 x 50 mm, or a tall pad on the centre-stack trim), a locking ball swivel, an edge grip with the wallet clear, the hard smooth face instead of the grained dash top, ASA, and named the tape's torque as what sizes the base. The engine's rounds produced no swivel and a 30 mm strip. **The system subtracted knowledge the model already had.** That is the finding the council's remaining answers must explain, and the thing to tell David first. (One of the three was Haiku: see item 4 above; Opus and Fable gave the same answer.)

Not done: the synthesis of the three answers for David; any change to the engine. Do not start another design round or show David another holder before that synthesis.

### Running at 08:35Z (nobody is watching these now)

| What | Where | State | What to do |
|---|---|---|---|
| Full gate on `train/2026-11-11a` (#570, head `85477a1a`) | The Mac, started 07:50Z from worktree `~/.t3/worktrees/scan-to-make/t3-943bf5a8-2d55ae730dbf2f3e`; log `~/scan-to-make-work/train-2026-11-11a/gate/gate.log` (ends with a `gate exit N` line) | **FAILED, `gate exit 1`, 08:36Z** (the background wrapper said exit 0: it lies). Logs kept in `~/scan-to-make-work/train-2026-11-11a/gate/ci-local-summary/` (`summary.md` first). Four jobs failed, three causes: (1) **Android does not compile its tests**: `android/app/src/test/java/com/scantomake/counterpart/HomeLayoutTests.kt:30:33` "Unresolved reference 'assertDoesNotExist'" (the conductor never ran Android). (2) **Companion, Node 22 and 24**: `services/companion/tests/remote-auth.test.mjs:327` expects the capabilities list without the new `makeFromScan` entry. (3) **iPad**: `LayoutParityUITests.testWithTheMacAwayNothingFailsAfterATapOnTheProjectPagePrintingAndHome` exceeded its 2 minute allowance (a hang or a slow away path; 49 others ran, none failed), so the phone job ended "TEST EXECUTE FAILED". Everything else passed (Mac build, CounterpartKit, Linux, contracts, e2e, licence). The lane is free | **#570 must not merge as it is.** Fix the three on the train branch (1 and 2 are a missing import or helper and a stale expectation; 3 needs a look at why the away page took over 2 minutes on the iPad: do not just raise the allowance), run the gate again, read its `gate exit` line. Then `python3 scripts/ux_gate.py <folder>` (exit 0 = no blank frame), merge main's docs into the train again, `scripts/branch_check.py --merge train/2026-11-11a` READ before any merge, `gh pr merge --merge`, install Mac, iPhone, iPad from a clone at the merged SHA, then run `ARModelTests` on his real iPhone (Muse's one blocking finding: designed-part AR has never opened anywhere; `~/scan-to-make-work/train-2026-11-11a/review-570.md`) |
| Council, Opus and Sol | T3 threads on the Mac | writing | Read their files; settle the threads |
| Kernel round 7c (Fable high): the holder on a swivel with a proper taped pad | agents-136, thread "Kernel lab round 7c (Fable)…", started 08:21Z, 70 min | steered 08:30Z: tape is the mount; calibrate the tape arithmetic against a bought adhesive mount | It is the same engine the council is judging. Read its statics section; decide with David's answer to the council whether its output is shown at all. Do not print it unseen |
| `train/2026-11-11b` = train 11a + #582 (open a model file with Counterpart on the Mac) | worktree `~/.t3/worktrees/scan-to-make/t3-2075634b-d12ea7e6df6eaf03` ; **pushed as PR #587** at about 08:35Z; its Mac `ObjectsModelTests` run is queued in the lane behind the gate (2-hour timeout); thread "A person can open a model file in Counterpart…" (Opus 5.5 medium) says it will post the counts | pushed, tests not yet run | Read the test counts when the lane frees (that thread ends its turn while waiting: check the lane and its log yourself). After #570 merges: gate (Mac-only), `branch_check` READ, merge, install the Mac. That build is what lets a file get into the app without a drag (X122). David will not drag a file: do not ask |

### Installed and published

- Mac `/Applications/Counterpart.app`, iPhone and iPad: build `202611102149` (main `d922973f`, #539). Nothing newer is installed. Main is `006dc487` (#527 merged at `6acb3cd7`, then docs).
- MCPs, published and verified tonight (npm, fresh `npx` start, tag, release, changelog page) and updated in the Mac app through Settings → Printers: **bambu-printer-mcp 1.1.87**, **mcp-3d-printer-server 1.2.69**. What changed, all prompt text: `fdm_design` gained compliant-first, fit by function, printed fasteners, ease of use checked like the hold (1.1.86 / 1.2.67), a corrected pocket-corner rule (1.2.68), and "Find out before you design, and before you ask": when and how to research, for any model with web tools, in a few minutes (1.1.87 / 1.2.69). New prompts `fdm_fit` and `fdm_flexures` are served but the app does not read them yet (it reads `fdm_design`, `fdm_slicing`, `cad_design`: `services/companion/src/touchup/invocation.ts`). If David rolls these back, they are five squash merges in each MCP repo since 1.1.85 / 1.2.66.
- Kernel repo (private, `DMontgomery40/counterpart-kernel`, lab on agents-136 `~/kernel-lab`): head `de2661e`. Rounds 7 and 7b are in `prints/2026-11-11-compliant-r7/` and `-r7b/` with their reports; research in `docs/research/` (the Forester dash file carries a note that its "bezel cheek" does not exist on the base car).

### David's printer and files

- Bed clear since 06:45Z; PETG loaded about 06:55Z (slot not read). Nothing has printed since the published bag clip (X119: "a damn very cipply clip", then "not a very usable clip, at all, not fun to use").
- `~/Downloads/bag-clip-squeeze.3mf` and `~/Downloads/one-piece-pliers.3mf` are round 7's other two builds, unprinted, unjudged. The round 7 and 7b holder files were moved from Downloads to `~/.Trash` (the originals are in the kernel repo).
- The Mac app is on an empty New Project page. A delegate's test left Finder frontmost with a Downloads window and replaced David's clipboard at about 07:10Z.
- The Codex computer-use MCP still returns `bootstrapTimedOut` from T3 sessions (cause unknown). What works: accessibility presses through `osascript` (no keystrokes, no pointer, no activation); scripts in the removed lead's scratchpad (`ax.js`, `upd.js`) show the pattern.

### Owed, in order, after the council synthesis

1. Tell David what the council found and what the control shows, and what changes in the engine (his decision whether to roll back; the list of what landed tonight is above and in `git log`).
2. #570: finish the gate, merge, install, verify on his phone (the Leatherman page must show "Make something else from this scan" and one AR chip: it does in the simulator, `~/scan-to-make-work/train-2026-11-11a/leatherman-page.png`).
3. `train/2026-11-11b` (#582) so a model file can be opened in the Mac app; then X124 (the same on iPhone, iPad, Android).
4. The app reads which prompts a design pass needs from the MCPs (`counterpart/1`), so `fdm_fit` and `fdm_flexures` reach the worker with no prompt names in the app.
5. X125 (the next-train findings from #570's review, and #571's failing rendering test), X114 slice 1 (the versions ledger), #556, X103, X108, the eleven as-a-user frictions (X119), the three smallest-iPhone failures.
6. Housekeeping: 19 worktrees are listed by `git worktree list`; merged ones (`train/2026-11-10e`, `fix/train-e-ipad`, `t3/a4911877-train`, and after #570 merges `fix/ar-parts`, `feat/make-from-scan`, `fix/stage-stays-dark`, `worker-fable`) can go, with their branches and PRs #564, #565, #568, #573 closed as landed in #570. `rm -rf` is blocked by a hook: move folders to `~/.Trash`. Delete remote branches with `gh api -X DELETE repos/DMontgomery40/scan-to-make/git/refs/heads/<branch>`.

## Before that (2026-11-10, 22:05Z; superseded where the section above differs)


The lead is the session in thread "Take Over Project Recovery Lead" (Claude Fable 5.2) since 20:07Z Nov 10. The lead before it was removed by David (19:55Z: "nothing shows up I have no earthly idea what you're printing this is such a shit show"); its process is stopped and its thread settled.

### Installed

| Where | Installed |
|---|---|
| Mac | **202611102149** from main `d922973f` (#539), since 21:53Z Nov 10. Receipts `~/scan-to-make-work/mac-202611102149/` (`NOTES.txt`); rollback `Counterpart-202611101556.app` in that folder. MCP copies: bambu-printer-mcp 1.1.85, mcp-3d-printer-server 1.2.66. |
| iPhone Davica3, iPad Air | Still **202611101556** from `9896c8f3`. The new build is compiled and waiting: `bash ~/scan-to-make-work/iphone-202611102149/install-when-reachable.sh` and the same under `ipad-202611102149/`. The lead's session runs a watcher that installs when a device becomes reachable; if that session is gone, run them by hand. |
| Android, Linux (agents-136) | Nov 5 builds. Stale. |
| Public | Mac beta 6 and TestFlight 2.0 (4), both from `30e3afdd` (Nov 6). |

**David's phone is always on his LAN and often not on his Wi-Fi** (his words, board X100): it reaches the Mac through WireGuard on his router from any connection, cellular included, so the app's link can be slow at any time. Apple's device tools (`devicectl`, installs, reading the app's files) need the phone on the house Wi-Fi itself or on a cable; when they say `unavailable`, say that. Never write that the phone is asleep or locked.

### What is true about the empty stage (board X85, X92, X96, X97)

- The Mac and its companion are not the cause: at load average 430 the installed companion served both parts' models to a pinned client in 6 to 34 ms (`~/scan-to-make-work/x85-cause-2026-11-10/REPORT.md`).
- In David's own screenshots the phone was on 5G through his tunnel; the phone mount's model arrived in the end and draws; the old build shows nothing while a file travels and never retries.
- The proven defect was the design: a one-shot, unsupervised chain (download → mesh → poster) with several ways to end in nothing. #539 replaces it: the Mac's picture at once on every layout, one stage picture with three states, deadlines and recovery on the model chain, and a trace.
- **Not yet verified on his phone.** After the phone has the build: copy `Library/Caches/media-trace.ndjson` from the app's container (`xcrun devicectl device copy from …`), read the phone's requests in `~/Library/Application Support/Scan to Make/logs/companion.log` (one `phone.http` line each, with milliseconds), and say which step each project reaches. Until then nothing here is "done".

### In motion and owed, in order

1. **The phone and iPad install**, then the verification above (board I19).
2. **The fifth train, #527**, rebuilt on the new main: #509, #510, #513, #519, #523, #531, with the iPad number-pad defect fixed (X86, owner: the "First look fixes…" delegate, told to wait for the lead) and the conflicts each owner must take (the state-machines session for #513, #532, #533: it has acknowledged and is waiting to be told which). `feat/model-file-pictures` landed inside #539; its tag is `archive/2026-11-10/model-file-pictures`.
3. **For that train or the one after**: #539's leftovers (X101); the size card that records guesses as measured (X103, the reason the phone mount cannot fit his cased phone, X102); the second test plate's project (X98); the picture framing rule (X105); the kind of link in the trace and what the phone fetches by itself on a metered link (X97, X100); #530, the screenshot tool's slow, refusing and away conditions, into the gate (X76).
4. **The kernel and physics labs** (K1, K4): no round is running. Three Gemini 4 Carbon reviews are in (`~/scan-to-make-work/gemini-carbon-2026-11-10/`, rows X104, X106): the third plate is held until coupons K and L are checked; the physics engine's "it holds" answers are not to be trusted yet. Start the next rounds only after item 1.
5. The 13 coupons of the second plate are on David's bed (sent 18:29Z); his readings are owed to the kernel lab (key: `prints/2026-11-10-second-plate/KEY.md` in the private kernel repo). Start no print until his phone shows him what it is.

### How this lead works (David, Nov 10 20:07Z; operations.md has the detail)

- Delegates are Opus 5.5 (medium by default, high or xhigh for harder work), GPT-6.1 Sol at xhigh, Muse Wonder Full for reviews, Gemini 4 Carbon for spatial reviews. Not Sonnet. Every brief names its files, its budget and its cleanup.
- No AI attribution on commits or PR bodies.
- Every delegate thread is settled when its result has been read; worktrees and branches go when their PR merges; disk is checked on all four machines after each train (Nov 10 22:00Z: the Mac 138 GiB free, agents-136 104 GB, agents-173 148 GB, agents-171 154 GB).
- A Bash hook (`dcg`) on the Mac refuses recursive deletes and any `git push` whose text contains ` -f` (a branch name ending in `-f` trips it): delete remote branches with `gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/<branch>`, and move folders to the Trash or to `/Volumes/Spillover/stm-cleanup-<date>/`.
- Threads still open on purpose: "Find Implicit State Machines" (a second Fable session with #513, #519, #523, #532, #533), "First look fixes…" (#509, #531, `fix/train-e-ipad`), "Look at the real app…" (#530).

Open PRs here: #527 (the fifth train, to be rebuilt) and its pieces #509, #510, #513, #519, #523, #531; #530, #532, #533; old and unreviewed against today's main #404, #410, #413. In the MCP repos: bambu-printer-mcp #138 and mcp-3D-printer-server #94 (fit-by-function guidance, drafts), bambu-printer-mcp #128 (not this project's).

**How work lands** (operations.md): finished branches go on a train, with one review, one gate (`scripts/ci_local.py` and `scripts/branch_check.py --merge` printing SAFE), a merge commit, and an install the same day from a clone pinned at the merged SHA. The Mac has two build slots and one simulator session at a time (`scripts/lane.py`; every hold that boots a simulator is `--exclusive`).

Never-landed work is kept as tags: `git ls-remote --tags origin 'archive/*'`. Evidence and receipts: `~/scan-to-make-work/` on the Mac. Releases: [`../distribution.md`](../distribution.md).


## Train 2026-11-11a conductor handoff (Nov 11)

PR #570, branch `train/2026-11-11a`: retains #568, #564, #565 and #573. #571 was merged then its implementation removed under the lead’s explicit fallback: after the dark-stage join, 40/41 renderer tests passed; the vertical black thin part was unreadable. Shape-aware framing/contact shadows need a separate fix/review.

Whole iPhone run: 114 passed / 0 failed / 2 iPad-only skips; iPad Air 11-inch landscape: 48 passed / 0 failed / 1 phone-only skip. Real-data capture then found unstarted scan demand being skipped on activation. Reproduced red, fixed in the store; all 29 unit + 2 focused iPhone UI tests and 2 iPad UI tests passed after that final fix. CounterpartKit 293, Mac model 55, Linux units 52, retained renderer 37 passed; companion 452 passed with 4 Blender-dependent skips. Prepared Linux frontend build and release renderer compiled.

Evidence: `~/scan-to-make-work/train-2026-11-11a/` (`RESOLUTIONS.md`, `VERIFICATION.md`, `DISCOVERY.txt`, test logs/results). `leatherman-page.png` was visually inspected: one AR chip, new action immediately below gallery labels, full title, no overlap. Capture uses a copy only. The full gate, branch_check, main merge and install remain the lead’s. Physical-device AR remains unverified; Android tests not run locally.
