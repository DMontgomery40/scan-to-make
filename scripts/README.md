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


## One iOS job at a time on the Mac

Every `macos`/`xcode-` job, whether started on the Mac or sent from a Linux box, holds `~/.stm-ios.lock` (flock) for its whole run; a second one waits and prints who holds it. Wrap any other xcodebuild or simulator run the same way:

```
python3 scripts/ci_local.py --ios-lock xcodebuild test ...
/usr/bin/lockf -k ~/.stm-ios.lock xcodebuild test ...   # same lock
```
