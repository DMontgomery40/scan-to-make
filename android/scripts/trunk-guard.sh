#!/bin/bash
# Gradle runs this before any assemble/bundle/install task (app/build.gradle.kts): an APK or bundle
# that could reach a device comes only from a clean commit on origin/main. Unit tests and lint don't.
set -euo pipefail
exec "$(dirname "$0")/../../scripts/trunk_guard.sh" "${1:-the Android app}"
