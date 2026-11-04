#!/usr/bin/env python3
"""Inspect the signed deliverable, not its source entitlements or Release configuration."""
import argparse
import pathlib
import plistlib
import subprocess
import sys

TEAM = 'X7F5F9LR24'
CONTAINER = 'iCloud.com.scantomake.counterpart'


def validate_metadata(info, entitlements, *, platform, expected_build,
                      identifier=None, push=True, cloudkit=True):
    issues = []
    expected = identifier or ('com.scantomake.mac' if platform == 'mac' else 'com.scantomake')
    if info.get('CFBundleIdentifier') != expected:
        issues.append(f'CFBundleIdentifier must be {expected}')
    if str(info.get('CFBundleVersion')) != expected_build:
        issues.append(f'CFBundleVersion must be {expected_build}')
    if entitlements.get('com.apple.developer.team-identifier') != TEAM:
        issues.append(f'com.apple.developer.team-identifier must be {TEAM}')
    for key in ('get-task-allow', 'com.apple.security.get-task-allow'):
        if entitlements.get(key):
            issues.append(f'{key} must not be enabled')
    if cloudkit:
        for key, value in [('com.apple.developer.icloud-container-identifiers', CONTAINER),
                           ('com.apple.developer.icloud-services', 'CloudKit')]:
            if value not in entitlements.get(key, []):
                issues.append(f'{key} must include {value}')
        key = 'com.apple.developer.icloud-container-environment'
        if entitlements.get(key) != 'Production':
            issues.append(f'{key} must be Production')
    if push:
        key = 'com.apple.developer.aps-environment' if platform == 'mac' else 'aps-environment'
        if entitlements.get(key) != 'production':
            issues.append(f'{key} must be production')
    return issues


def inspect_bundle(bundle, platform):
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(bundle)], check=True)
    signed = subprocess.run(['/usr/bin/codesign', '-d', '--entitlements', ':-', str(bundle)],
                            check=True, capture_output=True)
    # Certificate authorities are printed only at verbosity 2 or higher.
    identity = subprocess.run(['/usr/bin/codesign', '-dvv', str(bundle)], check=True, capture_output=True)
    authorities = identity.stderr.decode()
    allowed = ('Developer ID Application:',) if platform == 'mac' else ('Apple Distribution:', 'iPhone Distribution:')
    if not any('Authority=' + prefix in authorities for prefix in allowed):
        raise ValueError(f'{bundle.name}: signature must use a {"Developer ID" if platform == "mac" else "distribution"} certificate')
    path = bundle / ('Contents/Info.plist' if platform == 'mac' else 'Info.plist')
    return plistlib.loads(path.read_bytes()), plistlib.loads(signed.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=pathlib.Path)
    parser.add_argument('--platform', choices=['ios', 'mac'], required=True)
    parser.add_argument('--build', required=True)
    args = parser.parse_args()
    info, entitlements = inspect_bundle(args.app, args.platform)
    issues = validate_metadata(info, entitlements, platform=args.platform, expected_build=args.build)
    if args.platform == 'ios':
        for name, identifier, cloudkit in [
            ('CounterpartNotificationService', 'com.scantomake.notifications', True),
            ('CounterpartWidgets', 'com.scantomake.widgets', False),
        ]:
            child_info, child_entitlements = inspect_bundle(args.app / 'PlugIns' / (name + '.appex'), 'ios')
            issues += [name + ': ' + issue for issue in validate_metadata(
                child_info, child_entitlements, platform='ios', expected_build=args.build,
                identifier=identifier, push=False, cloudkit=cloudkit)]
            if child_info.get('CFBundleShortVersionString') != info.get('CFBundleShortVersionString'):
                issues.append(name + ': marketing version differs from the app')
    if issues:
        raise ValueError('\n'.join(issues))
    print(f'Verified distribution signatures and production services: {args.app.name} build {args.build}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, plistlib.InvalidFileException) as error:
        print(f'REFUSED: {error}', file=sys.stderr)
        sys.exit(1)
