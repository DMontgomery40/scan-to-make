#!/usr/bin/env bash
# Bundle the core probes with Metro (same transforms as the app), compile with
# the app's hermesc, and run them on a Hermes VM. Set HERMES to a `hermes` CLI
# built from the tag matching node_modules/hermes-compiler.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${HERMES:?Set HERMES to the hermes CLI binary}"
case "$(uname -s)" in
  Darwin) HERMESC=node_modules/hermes-compiler/hermesc/osx-bin/hermesc ;;
  *) HERMESC=node_modules/hermes-compiler/hermesc/linux64-bin/hermesc ;;
esac
OUT=build/hermes-probes
mkdir -p "$OUT"

npx react-native bundle --platform android --dev false --minify false \
  --entry-file scripts/hermes-probes.ts --bundle-output "$OUT/probes.js" >/dev/null
"$HERMESC" -emit-binary -O -w -out "$OUT/probes.hbc" "$OUT/probes.js"
"$HERMES" "$OUT/probes.hbc" | tee "$OUT/result.json"
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const failed = r.probes.filter(p => !p.passed);
  if (r.engine !== "hermes" || failed.length || r.probes.length === 0) process.exit(1);
' "$OUT/result.json"
