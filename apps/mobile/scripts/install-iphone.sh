#!/bin/bash
# Build the iPhone app (Release configuration, development signing) from a clean commit on
# origin/main and install it on a USB-connected iPhone without uninstalling (projects and pairing stay).
#
#   apps/mobile/scripts/install-iphone.sh            # David's iPhone, build number = UTC yyyymmddhhmm
#   STM_IPHONE_DEVICE=<udid> BUILD_NUMBER=<n> RELEASE_DIR=/abs/out apps/mobile/scripts/install-iphone.sh
#
# Receipts (source.json, build.log, install.json) go to RELEASE_DIR, outside the checkout.
# It does not launch the app. A connected Continuity display can black out camera/LiDAR frames:
# see docs/status/camera-incident-2026-11-02.md.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
head=$("$repo/scripts/trunk_guard.sh" 'the iPhone install')
[ "$(uname -s)" = Darwin ] || { echo 'Build the iPhone app on a Mac.' >&2; exit 1; }
device=${STM_IPHONE_DEVICE:-00008150-001A488C3642401C}
build=${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}
out=${RELEASE_DIR:-$HOME/scan-to-make-work/iphone-$build}
case "$out" in /*) ;; *) echo 'RELEASE_DIR must be absolute.' >&2; exit 1 ;; esac
case "$out/" in "$repo/"*) echo 'RELEASE_DIR must be outside the source checkout.' >&2; exit 1 ;; esac
[ ! -e "$out/DerivedData" ] || { echo "Choose a fresh RELEASE_DIR: $out already has a build." >&2; exit 1; }
mkdir -p "$out"
printf '{"commit":"%s","build":"%s","device":"%s","builtAt":"%s","override":"%s"}\n' \
  "$head" "$build" "$device" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${STM_TRUNK_OVERRIDE:-}" > "$out/source.json"
# One iOS job at a time on the Mac (scripts/README.md).
/usr/bin/lockf -k "$HOME/.stm-ios.lock" xcodebuild -project "$repo/apps/mobile/ios/ScanToMake.xcodeproj" \
  -scheme ScanToMake -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath "$out/DerivedData" CURRENT_PROJECT_VERSION="$build" CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM=X7F5F9LR24 -allowProvisioningUpdates build > "$out/build.log" 2>&1 ||
  { tail -40 "$out/build.log" >&2; exit 1; }
app="$out/DerivedData/Build/Products/Release-iphoneos/ScanToMake.app"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Info.plist")" = "$build" ] ||
  { echo "Built app is not build $build." >&2; exit 1; }
xcrun devicectl device install app --device "$device" "$app" --timeout 120 \
  --json-output "$out/install.json" --log-output "$out/install.log"
echo "Installed build $build from ${head:0:12} on $device. Receipts: $out"
