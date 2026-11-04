#!/usr/bin/env bash
set -euo pipefail
[[ $(uname -s) == Linux ]] || { echo 'Build Linux packages on Linux.' >&2; exit 1; }
app=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$app/../.." && pwd)
"$app/scripts/prepare-frontend.sh"
[[ -x "$root/tools/linux-host/prepare-payload.sh" ]] || { echo 'Integrate Task 2: tools/linux-host/prepare-payload.sh is missing.' >&2; exit 1; }
stage=$(mktemp -d "$app/src-tauri/resources-build.XXXXXX")
trap 'rm -rf "$stage"' EXIT
mkdir -p "$app/src-tauri/build-tmp"
TMPDIR="$app/src-tauri/build-tmp" "$root/tools/linux-host/prepare-payload.sh" "$stage"
# Only generated app resources are replaced; user projects and MCP installs are elsewhere.
rm -rf "$app/src-tauri/resources"
mv "$stage" "$app/src-tauri/resources"
[[ -x "$app/src-tauri/resources/host/counterpart-host" && -d "$app/src-tauri/resources/Payload" ]] || { echo 'The prepared host/Payload layout is incomplete.' >&2; exit 1; }
rm -rf "$app/src-tauri/bundle-resources"
python3 "$app/scripts/materialize-resources.py" "$app/src-tauri/resources" "$app/src-tauri/bundle-resources"
"$app/src-tauri/bundle-resources/Payload/node/bin/node" "$app/scripts/check-bundled-runtime.mjs" "$app/src-tauri/bundle-resources"
PATH="$app/src-tauri/bundle-resources/Payload/node/bin:$PATH" "$app/src-tauri/bundle-resources/Payload/node/bin/npm" --version
python3 -m unittest discover -s "$app/tests" -p "test_*.py"
cd "$app"
npm ci
npm test
TMPDIR="$app/src-tauri/build-tmp" npm run tauri build -- --config src-tauri/tauri.bundle.conf.json
"$app/scripts/verify-packages.sh" "$app"/src-tauri/target/release/bundle/deb/*.deb "$app"/src-tauri/target/release/bundle/appimage/*.AppImage
