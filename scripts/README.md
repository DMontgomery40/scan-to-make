# Local workflow checks

Run from a committed repository checkout. Uncommitted tracked changes and untracked files must be committed or moved out first, for both checks and reviews. The runner reads `.github/workflows/*.yml`, expands each job's matrix, and executes its `run` commands in order. Results and full command logs go to a private temporary directory; `summary.md` is ready to paste into the PR and ticket.

```sh
scripts/ci-local.sh companion
scripts/ci-local.sh all --changed-only
scripts/ci-local.sh all --changed-only --base origin/main --dry-run
scripts/ci-local.sh mac-cleanup --mac-host mac
```

Selectors accept the workflow filename stem, filename, or display name. `--changed-only` uses committed `base...HEAD` changes (including both sides of renames) and ordered path filters from the pull-request trigger. `all` runs every selected job, including the Node 22 and 24 variants. An empty selection is reported as such; it is not a test pass. `--output /absolute/path` selects an evidence directory outside the repository. Reusing a nonempty directory creates a fresh `run-*` child, preserving earlier results; the command prints the new summary path.

Local setup:

- Python 3 with PyYAML loads the YAML. If unavailable, the shell entry point creates a parser venv under the user cache with the pinned `requirements-ci-local.txt` dependency.
- `actions/setup-node` selects and verifies the requested major. Set `CI_LOCAL_NODE_22` and `CI_LOCAL_NODE_24` to installed executable paths when the requested major is not on PATH. Homebrew `node@22` and `node@24` are also recognized.
- `actions/setup-python` creates a fresh job venv using `python3.12` on PATH (or `CI_LOCAL_PYTHON_3_12`). Workflow pip commands run unchanged inside it.
- `actions/cache` uses a local cache keyed by the workflow's complete key; a cold cache runs the original checksum-verifying download command. Entries are marked complete only after a successful job. `CI_LOCAL_CACHE` overrides its location.
- `actions/checkout` uses the current committed source. Linux commands run in that checkout, so run only one local gate there at a time. macOS jobs receive a `git archive HEAD` snapshot and run over SSH as a temporary launchd job in the logged-in user's `gui/<uid>` domain. They create no Terminal windows and require no GitHub credentials. Their command logs and result are copied back; temporary dependencies and build outputs remain on the Mac at the reported evidence path.

Run steps retain their workflow environment, working directory, Bash `-e -o pipefail`, deadlines, and failure/always conditions. `$GITHUB_ENV` and `$GITHUB_PATH` updates carry to subsequent steps. Commands that install host dependencies run as written, including `sudo apt-get`; provision those permissions on the CI host. This is a runner for the repository's workflow features, not a general Actions emulator. Unsupported actions, expressions, shells or job features fail explicitly. It does not emulate GitHub runner images or provide secrets. The summary records the actual locally selected runtime versions.

# Local reviews

```sh
scripts/ci-local.sh review --author codex \
  --prompt-dir "$HOME/.config/scan-to-make/review-prompts"
```

The private directory must contain `codex-review-rubric.md` and `cursor-bugbot-review.md`, from the harness source map recorded in its `SOURCES.txt`. On another host copy that private directory first, or set `CI_LOCAL_REVIEW_PROMPTS`. Prompt texts and review transcripts stay outside Git.

The first review uses native `codex review --base origin/main`, which supplies its stock rubric. The second supplies the stored Cursor prompt verbatim plus the diff to Muse Wonder Full at xhigh; for a Muse author it uses Codex in read-only mode instead. `--author` is required so the second review comes from another lab. CLI authentication must already be configured. Review processes run locally and synchronously; they do not push or request GitHub reviews. Read both logs and resolve actionable findings: successful process exit means the review completed, not that it found no bugs.


## The Mac's build lane: `lane.py`

Every `xcodebuild` and every simulator session on the Mac (boot to shutdown) runs in one of two slots
(docs/operations.md, "Printing beats gating"):

```
python3 scripts/lane.py --label "<who>: <what>" -- xcodebuild build ...       # one slot
python3 scripts/lane.py --exclusive --label "<who>: start print" -- <command> # both slots
python3 scripts/lane.py --status                                              # holders, waiters, ages
```

- **Two slots.** Slot 1 is `~/.stm-ios.lock`, slot 2 is `~/.stm-ios-2.lock` (flock(2) locks on the open files).
  A normal caller takes whichever is free. `--exclusive` takes both: the gate's iPhone/iPad UI test job and
  anything that starts a print. Anything still calling `/usr/bin/lockf -k ~/.stm-ios.lock` holds slot 1, so it
  still excludes one slot and blocks an exclusive caller; switch it to `lane.py` so it queues and shows up.
- **Arrival order.** Each caller takes a numbered ticket in `~/.stm-lane/queue` and waits until it is the
  oldest live ticket; only then does it take slots. So callers of the same kind go in arrival order, and normal
  callers that arrive after a waiting exclusive one wait behind it instead of overtaking it.
- **Who holds it.** Each holder records its label, pid, slots, start time and `--max-minutes` (default 10) in
  `~/.stm-lane/holders` (an exclusive caller records its first slot while it waits for the second). `--status` (or `--status --json`) prints them with their ages, flags a hold past its
  `--max-minutes` as overdue (it does not kill it), and lists the waiters in order. A slot held with no record
  is shown as held by a process outside the lane.
- **Stale state blocks nobody.** The kernel locks are the truth. A ticket or record counts only while its owner
  keeps it flock'ed and its pid is alive, so a caller killed even with SIGKILL drops out of the queue and
  `--status`. If `lane.py` itself is killed, its command keeps running outside the lane (as with `lockf`).
- **Nested calls.** The command runs with `STM_LANE_HELD=<holder pid>`; a `lane.py` call inside it (an install
  script run from a gate job) runs straight away instead of waiting behind its own holder.
- **Exit code** is the command's; a command killed by a signal gives 128 + the signal number. `--output FILE`
  sends the command's output to a file while the lane's messages stay on the terminal.
- `ci_local.py` holds a slot for every `macos`/`xcode-` job, whether started on the Mac or sent from a Linux box
  (`mobile/app`, the UI job, holds both), and its wait message prints `--status`. `ci_local.py --ios-lock
  <command>` is the same as `lane.py -- <command>`.
- Agents: queue a hold as a background command so its exit wakes you, and never end a turn while it is queued or
  running. Tests use temporary slots (`STM_LANE_SLOT1`, `STM_LANE_SLOT2`, `STM_LANE_DIR`, `STM_LANE_POLL`).

## One trunk: `trunk_guard.sh`

David, 2026-11-04: "we need to make sure regressions and overwrites dont happen again".

Nothing installs from a non-main SHA. Every build or install script calls `scripts/trunk_guard.sh` first and
refuses when the tree is dirty (untracked files included) or HEAD is not on `origin/main`:

- Mac: `apps/mac/scripts/prepare-payload.sh`, `release.sh`, and the app's `embed.sh` build phase for every
  Release build (which also refuses a Payload prepared from another commit);
- iPhone: `apps/mobile/scripts/install-iphone.sh` (USB install), `prepare-testflight.sh`, and the app's
  `TrunkGuard` aggregate target for every signed Release build (`release-trunk-guard.sh`), so a raw
  `xcodebuild -configuration Release` refuses too;
- Linux: `apps/linux/scripts/bundle.sh`, `tools/linux-host/prepare-payload.sh`,
  `tools/linux-reconstruct/packaging/build-linux-payload.sh`;
- Android: Gradle's `assemble*`, `bundle*` and `install*` tasks (unit tests and lint are not guarded).

Debug builds, tests and the CI workflows are not guarded. For local debugging only,
`STM_TRUNK_OVERRIDE="<why>"` lets a build through, warns, and logs the head, branch and reason to
`~/.local/state/counterpart/trunk-overrides.log`. Never install an override build for David or publish one.

## JS test runner: `test-with-temp-guard.mjs`

The `test` scripts of `services/companion`, `services/printer-handoff`, `services/project` and
`packages/contracts` run their suites through it. It gives the suite a private `TMPDIR` and fails
if anything is left in it afterwards, so a test that creates a temp folder without removing it
fails instead of filling `/tmp` (2026-11-08: ~61,000 leftover test folders filled a 9 GB tmpfs).
In companion tests, helpers without a test context create temp folders through
`tests/support/temp.mjs`, which removes them when the test file finishes.

## Before every merge: `branch_check.py`

David, 2026-11-01: "make sure ... no one is writing on top of each other and in worktrees that have already been changed by a sibling session next door and all of sudden nothing agrees."

```
python3 scripts/branch_check.py                # every live branch: behind main, files it changes, conflicts
python3 scripts/branch_check.py --merge KAN-x  # exit 0 only if KAN-x is current with main and conflicts with nothing active
```

When two active branches conflict, the one that lands first passes `--lands-first "<who agreed, and that the other rebases>"`; the conflict is then printed as a warning with that reason. It excuses nothing else (behind main, conflicts with main, the boundary check). A train uses it for the branches still being built on top of what it carries.

`--merge` also runs `scripts/boundary_check.py` (PRD §8.0). It sends each added chunk of app code (not tests, docs or fixtures) to the configured Jev checker with one question: does it put printer, slicer, firmware, filament-system, Blender or Fusion knowledge into the app? A flagged chunk, or a checker that can't answer, makes the gate NOT SAFE. Move that code to the MCPs, or pass `--boundary-reviewed "<why it belongs in the app>"`, which is printed with the result. Jev's answer is a review signal, not proof. It uses David's Jev provider chain: TypeSafe, then Jev through OpenRouter when TypeSafe answers 401/402/403. Keys come from `TYPESAFE_API_KEY`/`OPENROUTER_API_KEY`, `~/.config/jev/env` or `~/.env`. The 0.3 threshold was calibrated on 14 real hunks; the calibration is noted in the script. The MCP names app code uses are pinned separately by `services/companion/tests/mcp-contract.test.mjs` against `docs/protocols/mcp-contract.md`.

It uses git's real three-way merge, so squash-merged work counts as merged. If it says NOT SAFE: rebase on main, or agree the merge order with the other branch's owner (the later one rebases), re-run the tests at the new head (`stm-ci` / `ci_local.py`), push, and check again. Delete a branch or worktree only after GitHub shows the PR as merged.

## Looking at the app: `ux_screens.py`

```
python3 scripts/ux_screens.py ~/scan-to-make-work/ux-<date>/screens --work ~/scan-to-make-work/ux-<date>/work
python3 scripts/ux_screens.py <out> --work <scratch> --devices iphone --screens home,project-wall-holder
python3 scripts/ux_screens.py <out> --work <scratch> --prepare-only   # copy, start and check the companion; no simulator
python3 scripts/ux_screens.py <out> --work <scratch> --devices ipad --project 30a2a33c-75f9-4519-aaeb-f53affeffb61
```

Screenshots of every iPhone and iPad screen, on every Apple layout, filled with a copy of this Mac's real projects, and an `index.md` listing each image's screen, state, device and data source. How it isolates the copy and what it fakes: [`../docs/operations.md`](../docs/operations.md), "Looking at the app". Each simulator run takes the whole lane by re-running itself through `lane.py --exclusive`, capped by `--max-minutes`, and resumes where the last hold stopped. `scripts/ux_screens/companion.mjs` is the companion it starts. The app reads three Debug-only launch arguments for it: `-CounterpartPairingRecord`, `-CounterpartOpen` with `-CounterpartSection`, and `-CounterpartNewScan`. Not covered yet: the Mac app, Android, Linux.
