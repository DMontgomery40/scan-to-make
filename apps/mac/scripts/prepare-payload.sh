#!/bin/bash
set -euo pipefail
[ "$(uname -sm)" = 'Darwin arm64' ] || { echo 'Prepare the payload on Apple Silicon macOS.' >&2; exit 1; }
mac=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$mac/../.." && pwd)
# The handheld-scan model builder (KAN-210): a Swift tool, built here and placed at Payload/bin, where the
# companion looks for it (services/companion/src/objects/reconstruct.ts).
swift build -c release --package-path "$repo/tools/mac-reconstruct" --product mac-reconstruct
python3 "$mac/scripts/prepare-payload.py"
mkdir -p "$mac/Payload/bin"
cp "$repo/tools/mac-reconstruct/.build/release/mac-reconstruct" "$mac/Payload/bin/mac-reconstruct"
