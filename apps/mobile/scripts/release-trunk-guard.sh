#!/bin/bash
# Build phase of the TrunkGuard aggregate target, which the iPhone app depends on: a signed Release
# build (what gets installed on a phone or archived for TestFlight) comes only from a clean commit on
# origin/main. Debug, simulator tests and CI's unsigned Release build skip it before touching git.
set -euo pipefail
[ "${CONFIGURATION:-}" = Release ] && [ "${CODE_SIGNING_ALLOWED:-YES}" = YES ] || exit 0
"$SRCROOT/../../../scripts/trunk_guard.sh" 'a signed Release iPhone app' >/dev/null
