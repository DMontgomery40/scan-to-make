#!/usr/bin/env bash
# One trunk: nothing installs from a non-main SHA (David, 2026-11-04: "we need to make sure
# regressions and overwrites dont happen again").
#
#   scripts/trunk_guard.sh "<what is being built>"
#
# Exit 0 and print HEAD's full SHA when this checkout is clean and HEAD is already on origin/main.
# Otherwise refuse (exit 1) and say why. Every Mac, iPhone, Linux and Android build/install script
# calls this first.
#
# Local debugging only: STM_TRUNK_OVERRIDE="<why>" lets the build go ahead, prints a warning and
# appends one line to $STM_TRUNK_OVERRIDE_LOG (default ~/.local/state/counterpart/trunk-overrides.log).
# Never install an override build for David or publish one.
set -euo pipefail
purpose=${1:?usage: trunk_guard.sh "<what is being built>"}
repo=${STM_TRUNK_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
main=${STM_TRUNK_MAIN:-origin/main}

refuse() {
  local why=$1
  if [ -n "${STM_TRUNK_OVERRIDE:-}" ]; then
    local log=${STM_TRUNK_OVERRIDE_LOG:-$HOME/.local/state/counterpart/trunk-overrides.log}
    mkdir -p "$(dirname "$log")"
    printf '%s\thost=%s\tpurpose=%s\thead=%s\tbranch=%s\trefused=%s\treason=%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname -s 2>/dev/null || hostname)" "$purpose" "${head:-none}" \
      "${branch:-none}" "$why" "$STM_TRUNK_OVERRIDE" >> "$log"
    echo "trunk_guard: OVERRIDE for local debugging only ($purpose): $why" >&2
    echo "trunk_guard: logged to $log. Do not install this build for David or publish it." >&2
    echo "${head:-unknown}"
    exit 0
  fi
  echo "trunk_guard: refusing to build $purpose: $why" >&2
  echo "trunk_guard: merge to main by PR, check out main (or a commit on it) with a clean tree, then build." >&2
  echo "trunk_guard: local debugging only: STM_TRUNK_OVERRIDE=\"<why>\" (logged; never install it for David)." >&2
  exit 1
}

git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || refuse "$repo is not a git checkout"
head=$(git -C "$repo" rev-parse HEAD)
branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD)

dirty=$(git -C "$repo" status --porcelain --untracked-files=normal | head -5)
[ -z "$dirty" ] || refuse "the tree has uncommitted or untracked files: $(echo "$dirty" | tr '\n' ' ')"

# A stale origin/main only makes this stricter: main is never rewritten, so anything already on
# an older main is still on the current one.
if [ "$main" = origin/main ] && [ -z "${STM_TRUNK_NO_FETCH:-}" ]; then
  git -C "$repo" fetch -q origin main 2>/dev/null || echo "trunk_guard: could not fetch origin/main; checking against the local copy" >&2
fi
git -C "$repo" rev-parse -q --verify "$main^{commit}" >/dev/null || refuse "$main does not exist here"
git -C "$repo" merge-base --is-ancestor "$head" "$main" ||
  refuse "HEAD ${head:0:12} ($branch) is not on $main"

echo "trunk_guard: $purpose from ${head:0:12}, on $main, clean tree" >&2
echo "$head"
