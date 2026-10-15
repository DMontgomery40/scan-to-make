#!/bin/sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="${TMPDIR:-/tmp}/capture-watchdog-checks"
swiftc -swift-version 5 \
  "$here/../../GuidedCaptureSample/GuidedCaptureSample/CaptureWatchdog.swift" \
  "$here/main.swift" -o "$out"
"$out"
