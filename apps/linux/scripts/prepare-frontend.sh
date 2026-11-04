#!/usr/bin/env bash
set -euo pipefail
app=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$app/../.." && pwd)
source="$root/packages/CounterpartKit/Sources/CounterpartKit/Resources/Starters"
mkdir -p "$app/shared"
cp "$source/catalog.json" "$app/shared/catalog.json"
cp "$source/caliper/preview.png" "$app/shared/caliper.png"
cp "$source/vernier.png" "$app/shared/vernier.png"
