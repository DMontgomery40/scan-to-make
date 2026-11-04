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
# linuxdeploy scans resource ELFs without Python's wheel-loading context.
# Make the already bundled private libraries visible during packaging only.
reconstruction="$app/src-tauri/bundle-resources/Payload/reconstruction"
if [[ -d "$reconstruction" ]]; then
  library_paths="$reconstruction/lib:$reconstruction/colmap-root/usr/lib/x86_64-linux-gnu:$reconstruction/python/lib"
  for wheel_libs in "$reconstruction"/python/lib/python*/site-packages/*.libs; do
    [[ ! -d "$wheel_libs" ]] || library_paths="$library_paths:$wheel_libs"
  done
  export LD_LIBRARY_PATH="$library_paths${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
TMPDIR="$app/src-tauri/build-tmp" npm run tauri build -- --config src-tauri/tauri.bundle.conf.json
"$app/scripts/verify-packages.sh" "$app"/src-tauri/target/release/bundle/deb/*.deb "$app"/src-tauri/target/release/bundle/appimage/*.AppImage
