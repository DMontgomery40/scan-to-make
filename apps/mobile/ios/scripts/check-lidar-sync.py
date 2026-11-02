#!/usr/bin/env python3
"""Device check for the LiDAR camera (KAN-217 P0), run after the functional acceptance on the phone.

The acceptance is functional first. After a reboot, open and close the walk-around scan, then swipe the
app away mid-scan, then finish a scan. After each, the Camera app must show live video and Face ID must
unlock. (Scan in Hand, whose LiDAR session caused the P0, is gone.)
This script reads the device syslog captured across those steps and fails on the camera daemon's
failure markers: another client's capture graph failing to build with -12681 or -12684 ("Fig assert",
"error ... building graph", "Tearing down graph to recover", "translated error"), as Face ID's did.
  - Outside Counterpart's sessions (each start to its captureSession_StopRunning), any such failure
    fails the check.
  - While a Counterpart session runs it holds the camera, so another client (Face ID) being refused
    then, within a second of "Device ... is use by ... clientApplicationID: com.scantomake", is expected
    and skipped. Counterpart's own graph failing, or a failure without that line, still fails.

Reported as supporting evidence only, because a working phone logs them too (Davica3, 22:42:34, the
Camera app starting normally): "SetExternalSyncFrameRateRational ... 0/1", "Cannot change the external
pulse rate from the MSG after stream has started", and "Error setting ExternalSyncFrameRateRational: -12684".

Usage: check-lidar-sync.py <syslog file>
Exit 0: no failure markers. Exit 1: failure markers. Exit 2: the log has no Counterpart LiDAR session,
so a check of the wrong log can't pass.
"""
import re
import sys

START = re.compile(r"ScanToMake\{AVFCapture\}.*(addInput:.*Back LiDAR Depth Camera|startRunning)")
STUCK = re.compile(r"Cannot change the external pulse rate from the MSG after stream has started")
ASSERT = re.compile(r"cameracaptured(?=.*(Fig assert|building graph|Tearing down graph to recover|translated error))(?=.*-1268[14])")
SYNC = re.compile(r"SetExternalSyncFrameRateRational.*\b0/1\b")
STOP = re.compile(r"captureSession_StopRunning:.*\[com\.scantomake\]")
RUNNING = re.compile(r"captureSession_startRunningInternal:.*\[com\.scantomake\]|ScanToMake\{AVFCapture\}.*-\[AVCaptureSession startRunning\]")
IN_USE = re.compile(r"Device \S+ is use by .*clientApplicationID: com\.scantomake\b")
CLIENT = re.compile(r"\[\d+\]\[([\w.-]+)\]>")
TIME = re.compile(r"\b(\d\d):(\d\d):(\d\d(?:\.\d+)?)\b")
NEAR_SECONDS = 1.0


def seconds(line: str):
    match = TIME.search(line)
    return int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3]) if match else None


def main(path: str) -> int:
    with open(path, encoding="utf-8", errors="replace") as log:
        lines = log.read().splitlines()
    start = next((i for i, line in enumerate(lines) if START.search(line)), None)
    if start is None:
        print("No Counterpart LiDAR capture session in this log: open the walk-around scan while it records.")
        return 2
    after = lines[start:]
    # Whether a Counterpart session holds the camera at each line: from each start to its stop.
    holding, ours = [], False
    for line in after:
        if RUNNING.search(line) or START.search(line):
            ours = True
        holding.append(ours)
        if STOP.search(line):
            ours = False

    refusals = [t for t in (seconds(line) for line in after if IN_USE.search(line)) if t is not None]

    def client(i: int):
        """The capture client a cameracaptured line is about: its own tag, else the nearest tagged line beside it."""
        for j in [i] + [k for d in range(1, 6) for k in (i + d, i - d)]:
            if 0 <= j < len(after) and (match := CLIENT.search(after[j])):
                return match[1]
        return None

    def refused_while_ours(i: int) -> bool:
        """Another client's graph refused while Counterpart's session holds the camera, beside our "in use"."""
        if not holding[i] or client(i) in (None, "com.scantomake"):
            return False
        at = seconds(after[i])
        return at is not None and any(abs(at - t) <= NEAR_SECONDS for t in refusals)

    failures = [line for i, line in enumerate(after) if ASSERT.search(line) and not refused_while_ours(i)]
    sync = sum(1 for line in after if SYNC.search(line))
    stuck = sum(1 for line in after if STUCK.search(line))
    print(f"Supporting evidence after Counterpart's session: {sync} 'SetExternalSyncFrameRateRational ... 0/1', "
          f"{stuck} 'Cannot change the external pulse rate'.")
    if failures:
        print(f"FAIL: {len(failures)} camera failure markers after Counterpart's LiDAR session:")
        for line in failures[:20]:
            print("  " + line[:300])
        return 1
    print(f"PASS: no camera failure markers in {len(after)} lines after Counterpart's LiDAR session.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
