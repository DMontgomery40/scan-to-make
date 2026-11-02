# Counterpart for iPhone and iPad

A pure Swift and SwiftUI app (PRD §3, `docs/design/overhaul/PRD.md`): no React Native, Metro or `node_modules`. It runs on iOS and iPadOS 27 (iPhone, iPad and iPhone Duo). It pairs with the Counterpart companion on your Mac, sends it what you want made (a description, photos, a walk-around LiDAR scan or an in-hand scan), and follows the work and the print.

The bundle id stays `com.scantomake` and the Keychain items stay the ones every earlier build used (service `org.scantomake.companion.v1`, accounts `current` and `installation`), so an installed app upgrades in place and keeps its pairing.

## Layout

| Path | What it is |
| --- | --- |
| `ios/project.yml` | The XcodeGen spec. `ios/ScanToMake.xcodeproj` is generated from it and committed. |
| `ios/ScanToMake/App/` | The `@main` app, `AppModel` (pairing state, links, the notification-routing entry point) |
| `ios/ScanToMake/Pairing/` | Find your Mac: the QR scanner (VisionKit `DataScannerViewController`), the nearby-Mac card, pairing links |
| `ios/ScanToMake/Platform/` | `MacConnection` (projects, photos, scans and printing over CounterpartKit) and the photo picker and camera |
| `ios/ScanToMake/Objects/` | `HandheldCapture.swift`: finds a Scan in hand capture an earlier build saved on the phone, so it can still be sent. The phone no longer records one; the walk-around scan, with its flip, is the scan. |
| `modules/object-capture/` | The walk-around Object Capture module: Apple's sample, unchanged, plus its entry and exit (`ios/`). It builds as the `GuidedObjectCapture` framework. |
| `../../packages/CounterpartKit/` | Shared Swift code: the domain model, the status words, the formatters, pairing and the companion client |

## Build and test

Requires Xcode 27.2 and an iOS 27 simulator (never iOS 26).

```sh
# CounterpartKit (macOS)
swift test --package-path packages/CounterpartKit

# The app: regenerate the project after editing project.yml
xcodegen generate --spec apps/mobile/ios/project.yml
xcodebuild test -project apps/mobile/ios/ScanToMake.xcodeproj -scheme ScanToMake \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro,OS=27.2' CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual
```

Ad hoc signing (`CODE_SIGN_IDENTITY=-`) gives a Simulator build its Keychain entitlement; without it pairing can't be stored. `.github/workflows/mobile.yml` runs the same checks, plus an unsigned device Release build that must contain no React Native.

Device builds sign with team `X7F5F9LR24` (automatic signing). Over SSH the login keychain is locked, so run `xcodebuild` from a `launchctl bootstrap gui/<uid>` job.

## Pairing on the Simulator

The Simulator has no camera for the QR scanner. Pair from a link instead: `xcrun simctl openurl <sim> "scantomake://pair?…"` (the companion's `pairing.create` control method, or `remote-auth-cli.js pair-capture-and-printer-handoff`, gives one). Nearby pairing works on the Simulator when the companion runs with `SCAN_TO_MAKE_LAN_ALL_ADDRESSES=1 SCAN_TO_MAKE_NEARBY_PAIRING=1`.
