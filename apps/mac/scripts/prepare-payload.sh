#!/bin/bash
set -euo pipefail
mac=$(cd "$(dirname "$0")/.." && pwd)
# One trunk: the payload (and so the installed app) comes only from a clean commit on origin/main.
head=$("$mac/../../scripts/trunk_guard.sh" 'the Mac payload')
if [ -n "${SOURCE_ARCHIVE:-}" ] && [ -z "${STM_TRUNK_OVERRIDE:-}" ]; then
  echo 'SOURCE_ARCHIVE is not provably from origin/main; build from a main checkout (or set STM_TRUNK_OVERRIDE for local debugging).' >&2
  exit 1
fi
[ "$(uname -sm)" = 'Darwin arm64' ] || { echo 'Prepare the payload on Apple Silicon macOS.' >&2; exit 1; }
repo=$(cd "$mac/../.." && pwd)
# The preparer builds mac-reconstruct from the same extracted source archive as
# the companion and audits the complete payload, including the binary.
python3 "$mac/scripts/prepare-payload.py"
# embed.sh compares this with HEAD, so a Release build can't ship another commit's companion.
mkdir -p "$mac/build"
echo "$head" > "$mac/build/payload-source"
