#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
image=${1:-scan-to-make-companion:local}
files=(.env.sentinel services/companion/node_modules/SENTINEL packaging-sentinel.usdz)
# Never replace a developer's existing file; cleanup removes only our probes.
for file in "${files[@]}"; do
  [ ! -e "$file" ] || { echo "Sentinel already exists: $file" >&2; exit 1; }
done
tmp=$(mktemp -d)
cleanup() { rm -f "${files[@]}"; rm -rf "$tmp"; }
trap cleanup EXIT
mkdir -p services/companion/node_modules
for file in "${files[@]}"; do printf 'synthetic build-context sentinel\n' > "$file"; done
# Same Dockerfile and same context as the real build: export before COPY/install
# steps could mask ignore failures (e.g. npm ci deletes existing node_modules).
docker build --platform linux/amd64 -f deploy/companion/Dockerfile \
  --target context-audit --output "type=local,dest=$tmp/context" .
test -f "$tmp/context/services/companion/package.json" # positive control
for file in "${files[@]}"; do test ! -e "$tmp/context/$file"; done
echo 'Dockerfile-specific ignore excluded all three sentinels from build context'
docker build --platform linux/amd64 -t "$image" -f deploy/companion/Dockerfile .
docker run --rm -i --entrypoint node "$image" --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import {existsSync, readdirSync} from 'node:fs';
const forbidden = new Set(['.env.sentinel', 'SENTINEL', 'packaging-sentinel.usdz']);
assert.ok(existsSync('/app/services/companion/dist/server-cli.js'));
for (const root of ['/app', '/opt', '/data']) {
  for (const entry of readdirSync(root, {recursive: true, withFileTypes: true})) {
    assert.ok(!forbidden.has(entry.name), `Sentinel leaked into image: ${entry.name}`);
  }
}
for (const name of forbidden) assert.ok(!existsSync(`/${name}`));
console.log('Image contains no env, node_modules or capture sentinel');
JS
