#!/bin/bash
# Prepare the Linux Counterpart resource directory from committed source (git HEAD):
#
#   OUT_DIR/BUILD-ID                 commit and runtime identity (setup installs one copy per id)
#   OUT_DIR/host/counterpart-host    setup, user service and credential-resolving model worker
#   OUT_DIR/Payload/node/            official Node 24 (npm kept: Download/Update installs printer MCPs)
#   OUT_DIR/Payload/source/          compiled companion, shared contracts and starters
#   OUT_DIR/SYMLINKS                 relative links a package must preserve (checked by the helper)
#
# The source whitelist is apps/mac/distribution.json's sourcePaths (minus the Apple-only
# mac-reconstruct), so GPL cleanup workers can never enter. Printer MCPs are not bundled:
# the app installs npm's latest through Settings → Printers.
#
# Usage: tools/linux-host/prepare-payload.sh OUT_DIR   (run on Linux; needs git, curl, tar, xz, cargo)
set -euo pipefail
"$(dirname "$0")/../../scripts/trunk_guard.sh" 'the Linux host payload' >/dev/null
[ "$(uname -s)" = Linux ] || { echo 'Prepare the Linux payload on Linux.' >&2; exit 1; }
[ $# -eq 1 ] || { echo 'Usage: prepare-payload.sh OUT_DIR' >&2; exit 1; }
out=$1
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
if [ -e "$out" ] && [ -n "$(ls -A "$out" 2>/dev/null)" ]; then echo "OUT_DIR must be absent or empty: $out" >&2; exit 1; fi
repo=$(cd "$(dirname "$0")/../.." && pwd)

node_version=24.22.2
case "$(uname -m)" in
  x86_64) node_arch=x64; node_sha=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75 ;;
  aarch64) node_arch=arm64; node_sha=eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# Scratch space beside OUT_DIR (same filesystem, owned by the caller), never a shared /tmp quota.
mkdir -p "$(dirname "$out")"
work=$(mktemp -d "$(dirname "$out")/.counterpart-payload.XXXXXX")
trap 'rm -rf "$work"' EXIT
stage="$work/out"
payload="$stage/Payload"
mkdir -p "$payload/node" "$payload/source" "$stage/host"

commit=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" archive --output="$work/source.tar" HEAD

# Official Node, checked against nodejs.org's published SHA-256 before extraction.
archive="$work/node-v$node_version-linux-$node_arch.tar.xz"
curl --fail --location --retry 3 --silent --show-error -o "$archive" "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-$node_arch.tar.xz"
echo "$node_sha  $archive" | sha256sum --check --quiet
tar -xJf "$archive" --strip-components=1 -C "$payload/node"
node="$payload/node/bin/node"
rm -rf "$payload/node/include" "$payload/node/share" "$payload/node/lib/node_modules/corepack" "$payload/node/bin/corepack"

manifest() { tar -xOf "$work/source.tar" apps/mac/distribution.json | "$node" -e "$1"; }
mapfile -t source_paths < <(manifest 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s).sourcePaths)if(p!=="tools/mac-reconstruct")console.log(p)})')
mapfile -t npm_packages < <(manifest 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s).npmPackages)console.log(p)})')
tar -xf "$work/source.tar" -C "$payload/source" "${source_paths[@]}"

# The helper from the same committed snapshot, with its locked dependencies.
mkdir -p "$work/host-src"
tar -xf "$work/source.tar" -C "$work/host-src" tools/linux-host packages/contracts/fixtures
CARGO_TARGET_DIR="$work/cargo-target" cargo build --release --locked --manifest-path "$work/host-src/tools/linux-host/Cargo.toml"
install -m 0755 "$work/cargo-target/release/counterpart-host" "$stage/host/counterpart-host"

export PATH="$payload/node/bin:$PATH" npm_config_cache="$work/npm-cache" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
for package in "${npm_packages[@]}"; do npm ci --ignore-scripts --prefix "$payload/source/$package"; done
npm run build --prefix "$payload/source/services/companion"
for package in "${npm_packages[@]}"; do npm prune --omit=dev --ignore-scripts --prefix "$payload/source/$package"; done
find "$payload/source" -name '*.tsbuildinfo' -delete

# Never bundled: either printer MCP, or the independently distributed GPL cleanup workers.
forbidden=$(find "$stage" \( -name 'bambu-printer-mcp' -o -name 'mcp-3d-printer-server' -o -name 'mcp-3D-printer-server' \
  -o -path '*/tools/scan-repair' -o -path '*/tools/scan-correct' -o -path '*/tools/ai-tweak-judge' -o -path '*/tools/mac-reconstruct' \) -print)
[ -z "$forbidden" ] || { echo "Payload contains excluded components:" >&2; echo "$forbidden" >&2; exit 1; }
for required in "$payload/source/services/companion/dist/server-cli.js" "$payload/source/services/companion/dist/ai-tweak-cli.js" \
  "$payload/source/services/companion/dist/remote-auth-cli.js" "$payload/source/services/companion/dist/lan-addresses.js" \
  "$payload/source/deploy/companion/generate-lan-tls.py" "$payload/source/packages/CounterpartKit/Sources/CounterpartKit/Resources/Starters/catalog.json" \
  "$payload/node/bin/npm" "$payload/node/lib/node_modules/npm/bin/npm-cli.js"; do
  [ -e "$required" ] || { echo "Payload is missing $required" >&2; exit 1; }
done
"$node" -e 'import(process.argv[1]).then(m=>{if(typeof m.discoverAddresses!=="function")process.exit(1)})' "$payload/source/services/companion/dist/lan-addresses.js"

# The reconstruction runtime closure (tools/linux-reconstruct/packaging/build-linux-payload.sh),
# when the packager provides it: copied whole, with its BUILD-ID preserved for the receipt.
reconstruction_identity=none
if [ -n "${RECONSTRUCTION_PAYLOAD:-}" ]; then
  [ -x "$RECONSTRUCTION_PAYLOAD/bin/linux-reconstruct" ] && [ -f "$RECONSTRUCTION_PAYLOAD/BUILD-ID" ] \
    || { echo "RECONSTRUCTION_PAYLOAD is not a built reconstruction payload: $RECONSTRUCTION_PAYLOAD" >&2; exit 1; }
  cp -a "$RECONSTRUCTION_PAYLOAD" "$payload/reconstruction"
  env -i HOME="$work" "$payload/reconstruction/bin/linux-reconstruct" check --mode samples >/dev/null \
    || { echo 'Packaged reconstruction runtime does not run relocated' >&2; exit 1; }
  echo "Reconstruction: $(cat "$payload/reconstruction/BUILD-ID")"
  reconstruction_identity=$(sha256sum "$payload/reconstruction/manifest.json" | cut -c1-12)
fi

printf 'g%s-node%s-%s-r%s\n' "${commit:0:12}" "$node_version" "$node_arch" "$reconstruction_identity" > "$stage/BUILD-ID"
chmod -R go-w "$stage"
# These links must survive packaging: the workspace packages and npm (Settings → Printers → Download/Update).
find "$stage" -type l -not -path '*/node_modules/.bin/*' -printf '%P -> %l\n' | sort > "$stage/SYMLINKS"
rmdir "$out" 2>/dev/null || true
mv "$stage" "$out"
echo "Prepared $(cat "$out/BUILD-ID") in $out ($(du -sh "$out" | cut -f1))"
