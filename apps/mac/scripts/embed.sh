#!/bin/bash
set -euo pipefail
contents="$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH"
mkdir -p "$contents/Library/LaunchAgents" "$contents/Resources"
# Payload preparation is explicit, so normal CI builds need no runtime downloads.
if [ -d "$SRCROOT/Payload" ]; then
  "$SRCROOT/Payload/python/bin/python3" "$SRCROOT/../../tools/licence-audit/mac_distribution.py" --repo-root "$SRCROOT/../.." --payload "$SRCROOT/Payload"
  # Do not retain removed workers from a previous build of this destination.
  rm -rf "$contents/Resources/Payload"
  ditto "$SRCROOT/Payload" "$contents/Resources/Payload"
fi
cp "$SRCROOT/Resources/agent.mjs" "$SRCROOT/Resources/pairing-active.mjs" "$contents/Resources/"
cmp "$SRCROOT/Licenses/Sparkle.txt" "$BUILD_DIR/../../SourcePackages/checkouts/Sparkle/LICENSE"
cp "$SRCROOT/THIRD_PARTY_NOTICES.md" "$SRCROOT/distribution.json" "$contents/Resources/"
ditto "$SRCROOT/Licenses" "$contents/Resources/Licenses"
/usr/bin/python3 - "$contents" "${STM_VARIANT:-}" "$EXECUTABLE_NAME" <<'PY'
import plistlib,sys
from pathlib import Path
contents,variant,exe=sys.argv[1:]
label='com.scantomake.mac'+variant+'.companion'
with (Path(contents)/'Library/LaunchAgents'/f'{label}.plist').open('wb') as f:
    plistlib.dump({'Label':label,'BundleProgram':'Contents/MacOS/'+exe,'ProgramArguments':[exe,'--companion-agent'], 'AssociatedBundleIdentifiers':['com.scantomake.mac'+variant], 'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':15,'Umask':63}, f)
PY
if [ "${CODE_SIGNING_ALLOWED:-NO}" = YES ] && [ -d "$contents/Resources/Payload" ]; then
  python3 "$SRCROOT/scripts/sign-runtime.py" "$contents/Resources/Payload" "$EXPANDED_CODE_SIGN_IDENTITY" "$SRCROOT/Config/Node.entitlements" "$PRODUCT_BUNDLE_IDENTIFIER"
fi
