#!/bin/sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
directory="$(mktemp -d "${TMPDIR:-/tmp}/capture-watchdog.XXXXXX")"
trap 'rm -rf "$directory"' EXIT HUP INT TERM
out="$directory/checks"
swiftc -swift-version 5 \
  "$here/../../GuidedCaptureSample/GuidedCaptureSample/CaptureWatchdog.swift" \
  "$here/main.swift" -o "$out"
"$out"
