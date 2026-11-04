# Counterpart for Android

A native Android companion for Counterpart (Kotlin, Jetpack Compose, minSdk 26 / Android 8.0, target 35). It does what
the iPhone app does, against the **same, unchanged Mac app**: it pairs with the Mac by its QR code (or nearby on the
same Wi-Fi), sends it what you want made (a description, photos, a MakerWorld/Printables link, a scan), follows the
work and the print, pauses and stops prints, and shows notifications ("Ready to print", "Did it fit?").

Status: **first version, compiled and unit-tested, not yet run against a real Mac or on a real phone.** See
"What's verified" below before relying on it.

## Build

You need JDK 17 and the Android SDK (platform 35, build-tools 35). Android Studio has both; or the command line
tools from <https://developer.android.com/studio#command-tools>.

```sh
cd android
echo "sdk.dir=$HOME/Android/Sdk" > local.properties   # wherever your SDK is (Android Studio writes this for you)
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest    # unit tests (they read fixtures from ../packages, so run them inside this repo)
./gradlew lintDebug
```

Or open the `android/` folder in Android Studio and press Run.

## Install the APK

- **With a cable:** turn on Developer options and USB debugging on the phone, then `adb install -r app-debug.apk`.
- **Without a cable:** copy `app-debug.apk` to the phone (Drive, e-mail, USB), open it, and allow "Install unknown
  apps" for the app you opened it from when Android asks.

The debug APK is signed with the standard Android debug key, so it installs anywhere but can't go on Google Play.
For Play you need a release build signed with your own upload key (`./gradlew bundleRelease` plus a `signingConfig`).

## Pair with your Mac

1. On the Mac, open Counterpart → Add a phone. It shows a QR code (a `scantomake://pair?…` link).
2. On the phone, open Counterpart → Continue → point the camera at the code. Or tap **Look on This Wi-Fi** to pair
   nearby (both screens show the same 6-digit code; click Allow on the Mac), or paste the link.
3. Phone and Mac must be on the same Wi-Fi (or both on Tailscale). Turn off a VPN or "Private DNS" if pairing can't
   reach the Mac.

## What's in it

| Folder (`app/src/main/java/com/scantomake/counterpart/`) | What |
|---|---|
| `pairing/` | Pairing links v1/v2 and the old JSON invitation, the pairing record, address rules, pinning (certificate or public key), nearby pairing (Bonjour + 6-digit code), pairing/check/refresh |
| `net/` | OkHttp transport with exactly the iPhone app's pinning: pinned host and port, no redirects, size limits |
| `api/` | The phone API (`/v1/objects`, printing, camera, settings, events), the data model, status words, uploads |
| `app/` | Application object, app state, Keystore-encrypted storage, notifications, background event checks |
| `ui/` | Compose screens: Welcome, Find your Mac, Home, New, Project, Print, Printing, Printers, Settings |
| `scan/` | Scanning: ARCore capture (Depth API where the phone has it), timed-photo fallback |

## How it talks to the Mac (same protocol as iOS)

Everything in `pairing/`, `net/` and `api/` is a port of `packages/CounterpartKit` (Swift), file by file. The wire is
documented in `docs/protocols/objects-api.md` and `docs/protocols/events.md`. In short: HTTPS to the companion the Mac
app runs (self-signed, so **pinned**: v2 links pin the SHA-256 of the certificate's SubjectPublicKeyInfo, v1 the whole
certificate; Tailscale `*.ts.net` uses normal trust), `Authorization: Bearer <token>` + `X-Scan-Device: <deviceId>`
on every request, a 30-day credential the app renews when under 20 days are left, and `GET /v1/events` long polls.

## Scanning (first version) and what the Mac receives

Android phones have no LiDAR and no Object Capture, so the phone can't make the `scan.usdz` the iPhone makes. Instead
it records a **walk-around set of photos** and sends them the way the iPhone sends its in-hand scan: as capture frames
(`POST /v1/objects/<id>/capture?name=0001.jpg`), then `POST …/start` with no capture manifest. The Mac then rebuilds
the model from the photos itself (`tools/mac-reconstruct`, Apple's photogrammetry, which accepts JPEG) and touches it
up as usual. No Mac change was needed.

- With **ARCore** (Google Play Services for AR) the camera's motion tracking decides when you've moved far enough for
  the next frame (every 4 cm or 10°), a ring shows which sides you've covered, and where the phone supports the
  **Depth API** (depth from motion) it tells you whether you're too near or too far. Frames are the sharpest CPU image
  the camera offers.
- Without ARCore the camera takes a photo every 1.5 s while you walk around.
- Depth is **not** sent to the Mac: the Mac only takes depth as lossless `NNNN.depth.plist` files paired with
  `NNNN.heic` frames (an AVFoundation format, from the iPhone's LiDAR). Sending ARCore depth would need a Mac change.
- Needs at least 20 frames; 40–80 all the way around (and a second, higher lap) is better. Rebuilding from photos
  needs macOS 27 on the Mac (the Mac says so if it can't).

Most jobs don't need a scan at all: describe the part ("a clip for my Shure SM7B onto a 25 mm pole"); the Mac looks
up published sizes, and photos with the printable calipers in them show the rest.

## Notifications

The iPhone app gets notifications through CloudKit, which the Mac writes; Android has no CloudKit. So the phone reads
the Mac's own event log (`GET /v1/events`) and shows the Mac's words:

- while the app is open, a long poll keeps every screen current (no banners, like iOS);
- while a print or a design runs and you leave the app, a small foreground service ("Following your Mac") keeps the
  long poll going, so halfway / done / paused arrive within seconds, and shows the running project's line;
- otherwise a background check every 15 minutes (Android's minimum).

All of this needs the phone to reach the Mac (same Wi-Fi or Tailscale). Away from both, notifications arrive when
it can reach the Mac again. A push relay (Firebase Cloud Messaging from the Mac or `services/relay`) would fix that,
but needs a Mac-side change and an FCM project; not done.

## What's verified, and what isn't

Verified here (a Linux machine, no phone, no Mac):

- `./gradlew assembleDebug` builds; `lintDebug` reports no errors (warnings are newer-library-version notices).
- 28 unit tests pass, including **all 324 pairing-link vectors** from `packages/contracts/fixtures`, the nearby-pairing
  v1 vector, the certificate/public-key pins of the CounterpartKit fixtures (checked against Java's own certificate
  parser too), pairing/check/refresh flows, scopes, refusals, uploads, the print body, and every sample in
  `counterpart-v1.json` and `objects.json`.
- The protocol code was ported line by line from CounterpartKit.

Not verified (needs a real phone and the Mac):

- Pairing over real TLS with the Mac's certificate; nearby pairing (Android NSD resolving `_scantomake._tcp`).
- Any end-to-end flow: making a project, uploads, printing, pause/stop, camera, notifications.
- ARCore scanning, and whether the Mac's photogrammetry rebuilds good models from Android frames.
- Screens on real devices (layout, dark theme, insets), the QR scanner, photo picker and camera.

## Not done yet (compared with the iPhone app)

- No 3D model viewer: the project shows the Mac's renders (PNG), not a turnable model.
- No live camera stream: Printing shows a camera snapshot every 3 s (the snapshot route every companion has).
- Printer MCP updates, Blender/Fusion setup, AI model settings and the device list are Mac-only here.
- No widgets or Live-Activity equivalent beyond the ongoing "Following your Mac" notification.
- No iCloud pairing (Android can't read the owner's iCloud); QR, link and nearby pairing only.
- Queued changes while the Mac is working (iOS `CorrectionQueue`) aren't kept; send the change after the pass ends.
- Not localised; English only, like the iPhone app.

## Notes for maintainers (and Claude)

- **Protocol first.** When the Mac or CounterpartKit changes the wire, change the Kotlin port the same way and keep the
  names alike (`PairingLink.kt` ↔ `PairingLink.swift`, `CompanionClient.kt` ↔ `CompanionClient.swift`, …).
- **Shared fixtures.** Tests read `packages/contracts/fixtures/*` and `packages/CounterpartKit/Tests/.../Fixtures/*`
  straight from the repo (`Support.kt` `repoRoot`). Add a vector there and all three implementations must agree.
- **Security rules that must not loosen:** pins are checked on every TLS handshake on the exact host and port; the
  address, pin and address list come from the invitation, never the Mac's reply; redirects are never followed; the
  token never leaves `PairingStore`/the request headers; the pairing record is encrypted with a Keystore key and kept
  out of backups.
- Words shown to people come from the Mac (`status.text`, event titles) or from `ProjectWords`, as on iOS.
- Bundle id is `com.scantomake`, like the iPhone app's.
- Library versions are from late 2024 (AGP 8.7, Kotlin 2.0, Compose BOM 2024.12); lint lists newer ones. Updating is
  safe but wasn't done here.
