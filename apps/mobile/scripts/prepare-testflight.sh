#!/bin/bash
# Archive, export and inspect a production IPA locally. Does not upload or install it.
set -euo pipefail
"$(dirname "$0")/../../../scripts/trunk_guard.sh" 'the TestFlight IPA' >/dev/null
: "${BUILD_NUMBER:?Set an unused App Store Connect build number}"
: "${RELEASE_DIR:?Set an absolute output directory outside the source checkout}"
case "$RELEASE_DIR" in /*) ;; *) echo 'RELEASE_DIR must be absolute.' >&2; exit 1 ;; esac
[[ "$BUILD_NUMBER" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || { echo 'BUILD_NUMBER must have one to three numeric components.' >&2; exit 1; }
repo=$(cd "$(dirname "$0")/../../.." && pwd)
case "$RELEASE_DIR/" in "$repo/"*) echo 'RELEASE_DIR must be outside the source checkout.' >&2; exit 1 ;; esac
[ ! -e "$RELEASE_DIR/Counterpart.xcarchive" ] && [ ! -e "$RELEASE_DIR/export" ] || {
  echo 'Choose a fresh RELEASE_DIR; an archive or export already exists.' >&2; exit 1;
}
mkdir -p "$RELEASE_DIR"
python3 - "$RELEASE_DIR/ExportOptions.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'wb') as output:
    plistlib.dump({
        'method': 'app-store-connect', 'destination': 'export', 'signingStyle': 'automatic',
        'teamID': 'X7F5F9LR24', 'iCloudContainerEnvironment': 'Production',
        'manageAppVersionAndBuildNumber': False, 'testFlightInternalTestingOnly': False,
        'uploadSymbols': True,
    }, output)
PY
# Each xcodebuild holds one build-lane slot on the Mac (scripts/README.md, "The Mac's build lane").
lane=("python3" "$repo/scripts/lane.py")
"${lane[@]}" --label "prepare-testflight: archive build $BUILD_NUMBER" -- xcodebuild archive -project "$repo/apps/mobile/ios/ScanToMake.xcodeproj" \
  -scheme ScanToMake -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$RELEASE_DIR/Counterpart.xcarchive" -derivedDataPath "$RELEASE_DIR/DerivedData" \
  DEVELOPMENT_TEAM=X7F5F9LR24 CURRENT_PROJECT_VERSION="$BUILD_NUMBER" -allowProvisioningUpdates
# Apple's rsync must find its matching peer, not Homebrew's incompatible rsync.
"${lane[@]}" --label "prepare-testflight: export build $BUILD_NUMBER" -- \
  /usr/bin/env PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/xcodebuild -exportArchive -archivePath "$RELEASE_DIR/Counterpart.xcarchive" \
  -exportOptionsPlist "$RELEASE_DIR/ExportOptions.plist" -exportPath "$RELEASE_DIR/export" \
  -allowProvisioningUpdates
shopt -s nullglob
ipas=("$RELEASE_DIR"/export/*.ipa)
[ "${#ipas[@]}" -eq 1 ] || { echo 'Expected exactly one exported IPA.' >&2; exit 1; }
inspection=$(mktemp -d "$RELEASE_DIR/inspect.XXXXXX")
trap 'rm -rf "$inspection"' EXIT
/usr/bin/ditto -x -k "${ipas[0]}" "$inspection"
python3 "$repo/scripts/verify_apple_distribution.py" "$inspection/Payload/ScanToMake.app" \
  --platform ios --build "$BUILD_NUMBER"
echo "Verified IPA: ${ipas[0]} (not uploaded; production service delivery still requires device acceptance)"
