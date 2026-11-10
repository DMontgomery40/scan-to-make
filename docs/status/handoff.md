# Handoff: Counterpart

Updated in place; git history keeps the rest. This is the only handoff: no dated copies or prompt files. What is built and accepted is in the [working PRD](../design/overhaul/PRD.md) (§0, §8.0); how to gate, build and install is in [operations](../operations.md); machines, paths, ports and state folders are in the [infrastructure map](../infrastructure.md). Every open item, its owner and its next step is in [`board.md`](board.md): read it after this page. Anything David says, and anything a report leaves undone, gets a row there in the same turn.

**How the owner works (David, Nov 6–10).** An item ends only as *done and verified on David's real install* (with evidence: SHA, log line, AX read, camera frame) or *blocked on one small thing only David can do*, named exactly. Green CI is not verification. Find facts yourself (code, logs, `object.json`, MQTT, camera); never ask David what you can read. Never end a turn "waiting"; re-drive agents that do. Scanning by hand is physically hard for him. He cannot leave his iPhone unlocked. Never take his screen and never press controls in his installed app: read and drive through the companion's control socket. Rules and notes in this repo can be stale: when one contradicts what David said later or what the code does, fix the note in the same PR.

## Now (2026-11-10, 20:00Z): a new lead takes over

David, 19:55Z, replacing the lead: "It's the earbuds the phone holder and literally everything you've made including what's printing now nothing shows up I have no earthly idea what you're printing this is such a shit show. Write a handoff prompt to a new lead with fresh context window. Please be very detailed and have it actually clean up after its agents and settle threads in t3 code when they're done."

### The one thing that matters first

**On David's iPhone, projects open to an empty stage.** He has reported it three times today (16:45Z the scans; 19:40Z "Forester phone mount"; 19:55Z "literally everything"). What is established:

- Installed everywhere: build **202611101556** from main `9896c8f3` (the fourth Nov 10 train). It introduced the gallery (#451) that draws a project's stage only as a 3D model the phone must first download; a failed or slow download is swallowed (`try?`) and nothing is drawn.
- Scans: explained and fixed in #525 (on the fifth train, **not installed**): one scan is 192 MB against a 64 MB limit; downloads belonged to the page; nothing was shown while waiting.
- **Parts made by the code engine: not explained.** "Earbud case replacement" (`52f0b309`) and "Forester phone mount" (`53a48b5e`) are the first designs the code engine (build123d, `engine: "code"`) made that he opened on the phone. On the Mac each is whole: a sound binary STL (the Forester's is 167 KB, 3,344 triangles, outward winding, not centred on the origin, header "STL Exported by Open CASCADE Technology"), seven renders, and a correct picture drawn by the Mac. The phone was on the local network and the companion logged no refusal. His screenshot shows a dark stage with a faint oval, the size chip, and no "Explore in 3D" or AR button. Whether the model never arrives or arrives and is not drawn is unknown. A delegate is reproducing it on a simulator from `9896c8f3` (board X85).
- The two test plates the old lead printed (`e4d404f2`, `a7564dd2`) are 3MF files with several objects and have **no picture at all**, cut-off titles, and nothing on their pages saying what each piece is. That is why he does not know what is printing. `a7564dd2` ("Second test plate…") is printing now: 13 small coupons for the geometry kernel, sent 18:29Z, about 1 h 41 min; what each coupon is for is in `prints/2026-11-10-second-plate/KEY.md` of the private repo `DMontgomery40/counterpart-kernel`.

Until his phone shows his projects, nothing else is progress. Verify on his real phone, not a simulator: the app's cache can be listed read-only with `xcrun devicectl device info files --device <udid> --domain-type appDataContainer --domain-identifier com.scantomake --subdirectory Library/Caches --recurse` when the phone is awake, and the companion's log is `~/Library/Application Support/Scan to Make/logs/companion-error.log`.

### Installed

| Where | Installed |
|---|---|
| Mac, iPhone Davica3, iPad Air | **202611101556** from main `9896c8f3` (#443, #456, #487, #499). Receipts `~/scan-to-make-work/{mac,iphone,ipad}-202611101556/`. Mac rollback: `Counterpart-202611101110.app` in the Mac receipt folder. |
| Mac MCP copies | bambu-printer-mcp 1.1.85, mcp-3d-printer-server 1.2.65 (1.2.66 is published; automatic updates are on). The code design engine is set up and is what new designs use. |
| Android, Linux (agents-136) | Nov 5 builds. Stale. |
| Public | Mac beta 6 and TestFlight 2.0 (4), both from `30e3afdd` (Nov 6). |

Printer: P1S, LAN Only + Developer Mode. Nobody watches a print once it has started. The lead may start one print per bed clearing after David says the bed is clear (AGENTS.md); **do not start another until his phone shows him what it is.**

### The fifth train: built, reviewed, not merged

PR #527, `train/2026-11-10e`, head `c54fc3bc` (checkout `~/fleet/stm-lane-b`). It carries: #520 the camera-cancel crash (the phone app dies when a camera view goes away as its stream starts; it hits ordinary project pages), #525 the scan stage is never blank, #509, #510, #513 one main action per page, #519, #523, #524 generated titles for model files, #531 no address in a printer's name, and small fixes by the old lead. Two review parts (`~/scan-to-make-work/train-2026-11-10/review-527-part1.md`, `-part2.md`); blockers fixed.

Gate at the head before the last two test-only commits (`a626bea2`): companion 1,169 of 1,170 on Node 22 and 24, Android, Linux, scripts and the Mac job green; iPhone 79 of 79. **The iPad job has failed three times** on `LayoutParityUITests.testSendOnAFitMissingItsMeasurementGoesToTheFields` (40 of 41 at `13f083ea`): it passes alone and fails as about the thirtieth test; the best explanation is that an earlier test's ⌘N leaves the simulator in hardware-keyboard mode and something then covers the "Enter at least one measurement" line, which would be a real defect for iPad keyboard users. The gate now keeps a failed run's result bundle (`…/02-mobile-app/temp/results/ipad.xcresult`); a rerun at `c54fc3bc` was in progress at handoff (log `~/scan-to-make-work/train-2026-11-10/gate-train-e-c54fc3bc-mobile.log`).

The train has been held for five hours while the fixes David needs sat uninstalled. **Decide first whether to cut a small train** from main with only what his phone needs (#520, #525 and its two review fixes, the cause of X85 once known, model-file pictures and titles) and land the rest after.

### What went wrong under the old lead (so it is not repeated)

- A screen that shows nothing while it waits or after a refusal passed every gate, because every test and capture talks to a companion on loopback. The rule is now in operations.md ("Waiting, failed and empty are screens too") and a tool for it is draft PR #530; neither has yet stopped anything.
- Too much ran at once: up to five delegates on the Mac, two labs on Linux, a second Fable session, three trains' worth of branches. Simulator runs drove the Mac's load to 150–600 while David used his app on it. Keep to about three, one simulator at a time.
- Test prints went into David's own app with no name, picture or explanation.
- Agents were not cleaned up after: about 60 finished threads are still unsettled, 17 worktrees exist, the Mac has **42 GiB free** (it had 200 this morning), `~/scan-to-make-work` is 44 GB, CoreSimulator 41 GB, and leftover simulators exist (`xcrun simctl list devices`).
- Side work (a geometry kernel and a physics engine, on Linux machines) took the lead's attention while the app David uses every day was broken.

### Clean up (owed; do it as work finishes, not at the end)

- **Threads:** settle each delegate's thread when its result is read (`t3_thread_organize`, `action: "settle"`). `t3_thread_list` with `settled: false` shows what is left: finished reviews and installs from this session are settled; subagent threads of delegates, the research readers, and older sessions' threads are not.
- **Worktrees and branches:** `git -C ~/fleet/scan-to-make worktree list`; remove every worktree whose PR has merged or closed and delete its branch; `scripts/branch_check.py` lists branches behind main. `~/fleet/stm-lane-a` (docs PRs) and `~/fleet/stm-lane-b` (train assembly) are separate clones the lead uses: keep or remove them deliberately.
- **Disk:** a hook blocks recursive deletes on the Mac, so build output is moved to `/Volumes/Spillover/stm-scratch/` (data only; never built or run from) and David deletes the staging folders (board W3). DerivedData, gate temp folders under `/private/var/folders/…/T/stm-ci-local-*`, and simulators a run created are the agent's to remove.
- **Simulators:** `xcrun simctl delete <udid>` for every `mobile-ci-*`, `stm-ux-*` and capture simulator not in use.

### Still running at handoff (read each, then finish, cancel or settle it)

| What | Where | State |
|---|---|---|
| Reproducing the empty part stage (X85); owner of #525 and `feat/model-file-pictures` | Mac, thread "The project's picture…" | Running; a compile hold queued in the lane |
| #509/#531's owner; next job `fix/printer-name-snapshots` | Mac, thread "First look fixes…" | Idle, waiting for the train to merge |
| Screenshot tool: #530 conditions and blank check | Mac, thread "Look at the real app…" | Proof runs pending |
| State-machines session (a second Fable session, not a delegate): #513, #519, #523, #524, #532 the stop hint, #533 the phone's bar | Mac, thread "Find Implicit State Machines" | Standing by for the train |
| Kernel lab, round 4 | agents-136 | Finishing its report |
| Physics lab, round 3 continued, 3 GB memory limit | agents-173 | Running until about 21:45Z |

Open PRs here: #527 (the train) and its pieces #509, #510, #513, #519, #520, #523, #524, #525, #531; for the next train #530, #532, #533 and branch `feat/model-file-pictures`; old and unreviewed against today's main #404, #410, #413. In the MCP repos: bambu-printer-mcp #138 and mcp-3D-printer-server #94 (fit-by-function guidance, drafts), bambu-printer-mcp #128 (not this project's).

**How work lands** (operations.md): finished branches go on a train, with one review, one gate (`scripts/ci_local.py` and `scripts/branch_check.py --merge` printing SAFE), a merge commit, and an install the same day from a clone pinned at the merged SHA. The Mac has two build slots and one simulator session at a time (`scripts/lane.py`; every hold that boots a simulator is `--exclusive`).

Never-landed work is kept as tags: `git ls-remote --tags origin 'archive/*'`. Evidence and receipts: `~/scan-to-make-work/` on the Mac. Releases: [`../distribution.md`](../distribution.md).
