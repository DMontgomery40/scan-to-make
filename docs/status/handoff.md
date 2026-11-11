# Handoff: Counterpart

Updated in place; git history keeps the rest. This is the only handoff: no dated copies or prompt files. What is built and accepted is in the [working PRD](../design/overhaul/PRD.md) (§0, §8.0); how to gate, build and install is in [operations](../operations.md); machines, paths, ports and state folders are in the [infrastructure map](../infrastructure.md). Every open item, its owner and its next step is in [`board.md`](board.md): read it after this page. Anything David says, and anything a report leaves undone, gets a row there in the same turn.

**How the owner works (David, Nov 6–10).** An item ends only as *done and verified on David's real install* (with evidence: SHA, log line, AX read, camera frame) or *blocked on one small thing only David can do*, named exactly. Green CI is not verification. Find facts yourself (code, logs, `object.json`, MQTT, camera); never ask David what you can read. Never end a turn "waiting"; re-drive agents that do. Scanning by hand is physically hard for him. He cannot leave his iPhone unlocked. Never take his screen and never press controls in his installed app: read and drive through the companion's control socket. Rules and notes in this repo can be stale: when one contradicts what David said later or what the code does, fix the note in the same PR.

**What is running and owed this hour is in [`now.md`](now.md), which the lead updates at every wake. Read it first.**

## Now (2026-11-10, 22:05Z)

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
