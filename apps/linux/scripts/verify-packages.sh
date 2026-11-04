#!/usr/bin/env bash
# Engineering checks of the actual packaged bytes; never starts a companion or printer.
set -euo pipefail
app=$(cd "$(dirname "$0")/.." && pwd)
[[ $# == 2 ]] || { echo 'Usage: verify-packages.sh PACKAGE.deb PACKAGE.AppImage' >&2; exit 1; }
deb=$(realpath "$1")
appimage=$(realpath "$2")
mkdir -p "$app/src-tauri/build-tmp"
work=$(mktemp -d "$app/src-tauri/build-tmp/verify.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir "$work/deb" "$work/appimage"
dpkg-deb --extract "$deb" "$work/deb"
(cd "$work/appimage" && "$appimage" --appimage-extract > "$work/extract.log")
for root in "$work/deb/usr/lib/Counterpart" "$work/appimage/squashfs-root/usr/lib/Counterpart"; do
  [[ -x "$root/host/counterpart-host" && -s "$root/BUILD-ID" ]]
  "$root/Payload/node/bin/node" "$app/scripts/check-bundled-runtime.mjs" "$root"
  PATH="$root/Payload/node/bin:$PATH" "$root/Payload/node/bin/npm" --version
  PATH="$root/Payload/node/bin:$PATH" "$root/Payload/node/bin/npx" --version
done
sha256sum "$deb" "$appimage"
