#!/bin/bash
set -euo pipefail
[ "$(uname -sm)" = 'Darwin arm64' ] || { echo 'Prepare the payload on Apple Silicon macOS.' >&2; exit 1; }
mac=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$mac/../.." && pwd)
# The preparer builds mac-reconstruct from the same extracted source archive as
# the companion and audits the complete payload, including the binary.
python3 "$mac/scripts/prepare-payload.py"
