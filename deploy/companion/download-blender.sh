#!/usr/bin/env bash
set -euo pipefail
# Same version and Linux SHA-256 as .github/workflows/scan-repair.yml.
destination=${1:?Usage: download-blender.sh destination}
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) artifact=blender-5.0.1-linux-x64.tar.xz; digest=8019580ee1b7262e505f4196a00237ccf743c88d205b38d34201510676e60b09 ;;
  Darwin/arm64) artifact=blender-5.0.1-macos-arm64.dmg; digest=102a81ddee5346c96339c6a529069a2d52df05f330eb9bfd431c8dd79fb4afb6 ;;
  *) echo 'No official Blender 5.0.1 download for this OS/architecture.' >&2; exit 1 ;;
esac
tmp=$(mktemp -d)
mounted=0
cleanup() {
  if [ "$mounted" = 1 ]; then hdiutil detach "$tmp/mount" -quiet || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
base=https://download.blender.org/release/Blender5.0
curl --fail --location --retry 3 "$base/blender-5.0.1.sha256" -o "$tmp/checksums"
published=$(awk -v file="$artifact" '$2 == file {print $1}' "$tmp/checksums")
[ "$published" = "$digest" ] || { echo 'Blender published checksum differs from pin' >&2; exit 1; }
curl --fail --location --retry 3 "$base/$artifact" -o "$tmp/$artifact"
if command -v sha256sum >/dev/null; then actual=$(sha256sum "$tmp/$artifact"); else actual=$(shasum -a 256 "$tmp/$artifact"); fi
[ "${actual%% *}" = "$digest" ] || { echo 'Blender archive checksum mismatch' >&2; exit 1; }
mkdir -p "$destination"
case "$artifact" in
  *.tar.xz) tar -xf "$tmp/$artifact" -C "$destination" --strip-components=1 ;;
  *.dmg)
    hdiutil attach "$tmp/$artifact" -mountpoint "$tmp/mount" -nobrowse -quiet
    mounted=1
    ditto "$tmp/mount/Blender.app" "$destination/Blender.app"
    ;;
esac
