#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
image=${1:-scan-to-make-companion:local}
files=(.env.sentinel services/companion/node_modules/SENTINEL packaging-sentinel.usdz deploy/companion/tls/KEY-SENTINEL.pem)
# Never replace a developer's existing file; cleanup trashes only our probes.
for file in "${files[@]}"; do
  [ ! -e "$file" ] || { echo "Sentinel already exists: $file" >&2; exit 1; }
done
tmp=$(mktemp -d)
probe="stm-context-smoke-$(date +%s)-$$"
cleanup() {
  if docker container inspect "$probe" >/dev/null 2>&1; then
    docker stop --timeout 5 "$probe" >/dev/null
    printf 'Retained stopped smoke container: %s\n' "$probe"
  fi
  local item cleanup_trash_dir=""
  for item in "${files[@]}" "$tmp"; do
    [ -e "$item" ] || continue
    if command -v trash >/dev/null; then
      trash "$item"
    elif command -v gio >/dev/null && gio trash -- "$item" 2>/dev/null; then
      :
    else
      if [ -z "$cleanup_trash_dir" ]; then
        mkdir -p "$HOME/.local/share/Trash/files"
        cleanup_trash_dir=$(mktemp -d "$HOME/.local/share/Trash/files/stm-context-XXXXXXXX")
      fi
      mv -- "$item" "$cleanup_trash_dir/"
    fi
  done
}
trap cleanup EXIT
mkdir -p services/companion/node_modules deploy/companion/tls
for file in "${files[@]}"; do printf 'synthetic build-context sentinel\n' > "$file"; done
# Same Dockerfile and same context as the real build: export before COPY/install
# steps could mask ignore failures (e.g. npm ci deletes existing node_modules).
docker build --platform linux/amd64 -f deploy/companion/Dockerfile \
  --target context-audit --output "type=local,dest=$tmp/context" .
test -f "$tmp/context/services/companion/package.json" # positive control
test -f "$tmp/context/packages/CounterpartKit/Sources/CounterpartKit/Resources/Starters/vernier.png"
for file in "${files[@]}"; do test ! -e "$tmp/context/$file"; done
echo 'Dockerfile-specific ignore excluded all four sentinels from build context'
docker build --platform linux/amd64 -t "$image" -f deploy/companion/Dockerfile .
docker run --name "$probe" -i --entrypoint node "$image" --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import {existsSync, readdirSync} from 'node:fs';
import {starterProject, STARTER_ASSETS} from '/app/services/companion/dist/starters/catalog.js';
import {join} from 'node:path';
const forbidden = new Set(['.env.sentinel', 'SENTINEL', 'packaging-sentinel.usdz', 'KEY-SENTINEL.pem']);
assert.ok(existsSync('/app/services/companion/dist/server-cli.js'));
for (const id of ['scan-platform', 'long-vernier-caliper']) assert.equal(starterProject(id).id, id);
assert.ok(existsSync(join(STARTER_ASSETS, 'catalog.json')));
for (const root of ['/app', '/opt', '/data']) {
  for (const entry of readdirSync(root, {recursive: true, withFileTypes: true})) {
    assert.ok(!forbidden.has(entry.name), `Sentinel leaked into image: ${entry.name}`);
  }
}
for (const name of forbidden) assert.ok(!existsSync(`/${name}`));
console.log('Image contains no env, node_modules, capture or TLS-key sentinel');
JS
