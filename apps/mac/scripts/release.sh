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
mac=$(cd "$(dirname "$0")/.." && pwd)
[ -x "$mac/Payload/node/bin/node" ] || { echo 'Run prepare-payload.sh first.' >&2; exit 1; }
case "$SPARKLE_FEED_URL" in https://*) ;; *) exit 1 ;; esac
out="$mac/build/release-$BUILD_NUMBER"
mkdir -p "$out"
xcodebuild -project "$mac/ScanToMake.xcodeproj" -scheme ScanToMake -configuration Release -derivedDataPath "$out/derived" CODE_SIGN_STYLE=Manual OTHER_CODE_SIGN_FLAGS=--timestamp CODE_SIGN_IDENTITY="$DEVELOPER_ID_APPLICATION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" SPARKLE_FEED_URL="$SPARKLE_FEED_URL" SPARKLE_PUBLIC_KEY="$SPARKLE_PUBLIC_KEY" build
app="$out/derived/Build/Products/Release/Scan to Make.app"
codesign --verify --deep --strict "$app"
ditto -c -k --keepParent "$app" "$out/notarization.zip"
xcrun notarytool submit "$out/notarization.zip" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$app"
xcrun stapler validate "$app"
mkdir -p "$out/feed"
ditto -c -k --keepParent "$app" "$out/feed/ScanToMake-$BUILD_NUMBER.zip"
"$SPARKLE_BIN/generate_appcast" --download-url-prefix "$RELEASE_DOWNLOAD_URL" "$out/feed"
echo "Release artifacts: $out/feed (not uploaded)"
