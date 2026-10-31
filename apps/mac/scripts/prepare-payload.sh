#!/bin/bash
set -euo pipefail
[ "$(uname -sm)" = 'Darwin arm64' ] || { echo 'Prepare the payload on Apple Silicon macOS.' >&2; exit 1; }
mac=$(cd "$(dirname "$0")/.." && pwd)
exec python3 "$mac/scripts/prepare-payload.py"
