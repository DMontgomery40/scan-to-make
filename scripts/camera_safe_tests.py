#!/usr/bin/env python3
"""Disable XCTest video recording, refusing unknown or non-UI test manifests.

Run after build-for-testing and before test-without-building. Supports both
top-level test targets and version 2 TestConfigurations/TestTargets manifests.
"""
import argparse
from pathlib import Path
import plistlib
import sys


def targets(value):
    if isinstance(value, dict):
        if isinstance(value.get('TestBundlePath'), str):
            yield value
        else:
            for child in value.values():
                yield from targets(child)
    elif isinstance(value, list):
        for child in value:
            yield from targets(child)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    args = parser.parse_args()
    try:
        manifest = plistlib.loads(args.manifest.read_bytes())
        found = list(targets(manifest))
        ui_count = sum(target.get('IsUITestBundle') is True for target in found)
        if not found or not ui_count:
            raise ValueError('no recognized UI test targets; recording settings were not applied')
        for target in found:
            target['PreferredScreenCaptureFormat'] = 'screenshots'
        args.manifest.write_bytes(plistlib.dumps(manifest))
        verified = list(targets(plistlib.loads(args.manifest.read_bytes())))
        if len(verified) != len(found) or any(target.get('PreferredScreenCaptureFormat') != 'screenshots' for target in verified):
            raise ValueError('recording settings failed verification')
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        print('REFUSED: ' + str(error), file=sys.stderr)
        return 1
    print(f'Video recording disabled and verified for {len(found)} test targets; {ui_count} UI target(s).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
