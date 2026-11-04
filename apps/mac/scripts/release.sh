#!/bin/bash
# Run only after Developer ID membership/certificates are available.
set -euo pipefail
: "${DEVELOPER_ID_APPLICATION:?Set Developer ID Application identity}"
: "${NOTARY_PROFILE:?Set the notarytool Keychain profile name}"
: "${SPARKLE_PUBLIC_KEY:?Set the Ed25519 public key (private key stays in Keychain)}"
: "${SPARKLE_FEED_URL:?Set the HTTPS appcast URL}"
: "${SPARKLE_BIN:?Set Sparkle distribution bin directory}"
: "${RELEASE_DOWNLOAD_URL:?Set the HTTPS release asset directory}"
: "${BUILD_NUMBER:?Set an increasing bundle version}"
: "${MAC_PROVISIONING_PROFILE:?Set the Developer ID CloudKit provisioning profile name or UUID}"
mac=$(cd "$(dirname "$0")/.." && pwd)
[ -x "$mac/Payload/node/bin/node" ] || { echo 'Run prepare-payload.sh first.' >&2; exit 1; }
case "$SPARKLE_FEED_URL" in https://*) ;; *) exit 1 ;; esac
out="${RELEASE_DIR:-$mac/build/release-$BUILD_NUMBER}"
derived="${DERIVED_DATA_PATH:-$out/derived}"
archive="$out/Counterpart.xcarchive"
[ ! -e "$archive" ] || { echo "Archive already exists: $archive" >&2; exit 1; }
mkdir -p "$out"
xcodebuild -project "$mac/ScanToMake.xcodeproj" -scheme ScanToMake -configuration Release -derivedDataPath "$derived" -archivePath "$archive" CODE_SIGN_STYLE=Manual CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO OTHER_CODE_SIGN_FLAGS=--timestamp CODE_SIGN_IDENTITY="$DEVELOPER_ID_APPLICATION" STM_MAC_PROVISIONING_PROFILE="$MAC_PROVISIONING_PROFILE" STM_ENTITLEMENTS_SUFFIX=+CloudKitProduction STM_APS_ENVIRONMENT=production CURRENT_PROJECT_VERSION="$BUILD_NUMBER" SPARKLE_FEED_URL="$SPARKLE_FEED_URL" SPARKLE_PUBLIC_KEY="$SPARKLE_PUBLIC_KEY" archive
# Export signs Sparkle's nested updater/XPC helpers as well as the containing app.
# Use Apple's rsync peer during export, even when Homebrew is earlier on PATH.
python3 - "$out/ExportOptions.plist" "$MAC_PROVISIONING_PROFILE" "$DEVELOPER_ID_APPLICATION" <<'PYEXPORT'
import plistlib, sys
path, profile, identity = sys.argv[1:]
with open(path, 'wb') as handle:
    plistlib.dump({
        'method': 'developer-id', 'destination': 'export', 'teamID': 'X7F5F9LR24',
        'signingStyle': 'manual', 'signingCertificate': identity,
        'provisioningProfiles': {'com.scantomake.mac': profile},
        'iCloudContainerEnvironment': 'Production',
    }, handle)
PYEXPORT
PATH=/usr/bin:/bin:/usr/sbin:/sbin xcodebuild -exportArchive -archivePath "$archive" -exportPath "$out/export" -exportOptionsPlist "$out/ExportOptions.plist"
app="$out/export/Counterpart.app"
codesign --verify --deep --strict "$app"
python3 "$mac/../../scripts/verify_apple_distribution.py" "$app" --platform mac --build "$BUILD_NUMBER"
ditto -c -k --keepParent "$app" "$out/notarization.zip"
xcrun notarytool submit "$out/notarization.zip" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app"
mkdir -p "$out/feed"
ditto -c -k --keepParent "$app" "$out/feed/ScanToMake-$BUILD_NUMBER.zip"
"$SPARKLE_BIN/generate_appcast" --download-url-prefix "${RELEASE_DOWNLOAD_URL%/}/" "$out/feed"
"$SPARKLE_BIN/sign_update" "$out/feed/appcast.xml"
echo "Release artifacts: $out/feed (not uploaded)"
