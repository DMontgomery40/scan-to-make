# External TestFlight release

The release is an iPhone IPA **and a usable Mac installation**. TestFlight does not
install the companion, its independent cleanup workers, or the printer MCPs.
The iPhone identifiers remain `com.scantomake`, `com.scantomake.notifications`, and
`com.scantomake.widgets`; the Mac remains `com.scantomake.mac`, team `X7F5F9LR24`.

## Current release — checked November 7, 2026

- **App Store Connect:** Counterpart 3D, Apple ID **6830483457**, bundle `com.scantomake`.
  The internal group is Counterpart Team; the external group is **Counterpart Public Beta**.
  Beta description and David’s supplied private review/feedback contacts were saved earlier.
- **Latest uploaded iPhone/iPad build: 2.0 (4)**, clean main `30e3afdd`, uploaded
  November 6 at 19:50Z. Archive/export/upload receipts are in
  `~/scan-to-make-work/testflight-2.0-4/`. Build 2 was last observed Waiting for Review;
  that is not evidence that build 4 is assigned, approved or available. Recheck the live
  build’s processing/compliance state, external group assignment and review status before submission.
- **Public link:** https://testflight.apple.com/join/S4tExVzp, configured open to anyone.
  The link is usable only when its group has an approved build available for testing.
  Automatic tester notifications were off at the last verified group check. No email invitations are needed.
- **Matching Mac beta 6:** clean main `30e3afdd`, Developer ID signed, notarized and stapled,
  [published with Android and Linux](https://github.com/DMontgomery40/scan-to-make/releases/tag/v2.0-beta.6).
  The setup page is https://counterpart.dtmont.com/beta.html and the signed Sparkle feed is live.
  The Mac ZIP is `Counterpart-202611061933.zip`, SHA-256
  `403666f93f9bf41e9eabe028015ba89fe80147c69350993eeb2d074c6db137c2`.
  Notarization `fc7218ce-1f91-49f4-a1a9-058b0c6ae35f` was Accepted.
  Receipts: `~/scan-to-make-work/mac-beta-export-202611061933/` and `release-v2.0-beta.6/`.
- **Printer software:** Download/Update installs npm’s latest independently of the app release.
  Add the printer in the computer app first when using this matching release pair; adding a printer
  from the phone landed later on main (#392). Printer behavior belongs in the MCPs.
- **Cleanup workers:** independent of the signed Mac payload; follow the cleanup tools guide on
  the beta setup page. Printing an existing STL/3MF does not require AI, Blender or scan cleanup.

**Beta scope, David November 7:** get more people testing their own printers and sending logs.
Other printer models are the purpose of the beta, not an acceptance prerequisite. In-hand scanning
is **Labs** and remains unavailable in this build (`HandheldCapture.offered = false`); this release
work does not enable the old recorder. AR is optional and does not block the public beta.
Walk-around scan quality, production notification delivery and other open device checks stay
recorded in the working PRD rather than being presented as accepted.

The existing distribution scripts validate the app and both extensions’ signatures, matching
versions, Production entitlements and absence of debug entitlements. Keep using clean main;
never archive a feature branch or a dirty checkout. This preparation does not replace David’s
installed apps, restart his companion, or start a physical print.

## Production services

The complete CloudKit schema was deployed and verified in Production on Nov 3 at
23:23. The development export was missing `CounterpartCommand` and
`CounterpartProject.openAsk`; both were added before deployment. The exact schema
is retained in [cloudkit-schema.ckdb](protocols/cloudkit-schema.ckdb). All five
record types are present and `CounterpartEvent.type` is Queryable. No records
were changed. Container:
`iCloud.com.scantomake.counterpart`: `CounterpartEvent`, `CounterpartProject`,
`CounterpartCommand`, `CounterpartMac`, and `CounterpartDevice`, with every field in
[the CloudKit contract](protocols/cloudkit.md). `CounterpartEvent.type` must be
Queryable. Deployment copies schema, not development records. Both clients must
use Production for same-account discovery, events and commands to meet.

The production Live Activity relay is deployed at `https://counterpart.dtmont.com/relay/v1`.
Its Production key is scoped to `com.scantomake`. The deployed random-token probe
returned `410 token_inactive` with `BadDeviceToken`, verifying APNs authentication
and connectivity for `com.scantomake.push-type.liveactivity`. The docs site remains
healthy; Sandbox deployment and installed development settings are unchanged.
Actual delivery to a TestFlight phone is still unverified; see
[relay setup](../services/relay/README.md).

**Check the Mac's saved relay settings after upgrading the phone.** David's current
Mac has a saved Sandbox relay URL. A TestFlight phone has production push tokens;
in Mac Settings → Advanced, use the verified production address
`https://counterpart.dtmont.com/relay/v1` and enable Live Activity relay. A fresh
Mac defaults to that address but the relay is off. Do not send production tokens
to Sandbox or development tokens to Production: the relay can deny a rejected
token for 30 days. Do not switch a working development installation early merely
to prepare a release. Validate real start/update/end delivery after the phone and
Mac have both been moved to the production environment.

## iPhone archive and local export

Use a fresh absolute output directory outside the checkout and an unused ASC build
number for version 2.0. The helper permits automatic provisioning updates; running
it may create/fetch signing assets through the signed-in Xcode account. It does
not upload, submit for review, or install on a device.

```sh
BUILD_NUMBER=42 RELEASE_DIR="$HOME/scan-to-make-work/release-42" \
  bash apps/mobile/scripts/prepare-testflight.sh
```

The helper archives Release, exports with `method=app-store-connect`, explicitly
sets CloudKit Production and `testFlightInternalTestingOnly=false`, and preserves
the chosen build number. It verifies the exported app and both extensions, their
distribution signatures, version agreement, production entitlements and absence
of debug entitlements. These checks inspect the signed output, not source plists.
They do not prove production schema or push delivery.

Upload the verified IPA through Xcode Organizer, Transporter, or authenticated
`xcrun altool`. The local `altool --help` documents `--validate-app`,
`--upload-package`, `--list-providers`, `--list-apps`, and `--build-status`.
Use the existing account or a configured keychain/API authentication path; do not
print private keys, passwords, or tokens. Do not use the Sandbox APNs key as an
App Store Connect API key. Wait for processing and inspect warnings/compliance.

## Mac artifact

Prepare `apps/mac/Payload` from the exact release source using its existing
`scripts/prepare-payload.sh` process. `apps/mac/scripts/release.sh` requires:

- `DEVELOPER_ID_APPLICATION`: installed Developer ID Application identity.
- `MAC_PROVISIONING_PROFILE`: matching Developer ID CloudKit profile name or UUID.
- `NOTARY_PROFILE`: configured notarytool Keychain profile.
- `BUILD_NUMBER`, `SPARKLE_PUBLIC_KEY`, `SPARKLE_FEED_URL`, `SPARKLE_BIN`, and
  `RELEASE_DOWNLOAD_URL`: reviewed release/update configuration.

```sh
bash apps/mac/scripts/release.sh
```

The script archives and exports with Xcode, disables base debug-entitlement injection, applies
`App+CloudKitProduction.entitlements`, pins production push and
CloudKit, validates the signed app, notarizes/staples it, checks Gatekeeper and
creates the ZIP/appcast. It does not upload them. The profile setting applies only
to the app target, not AgentKit. Verify a downloaded copy on a clean Mac, including
the Local Network permission prompt, companion startup, cleanup workers, printer
MCP discovery, update path and same-account phone pairing before sharing the link.

## Beta information and public link

Suggested Beta App Description:

> Counterpart connects your iPhone or iPad to your Mac and your 3D printer. Import
> an STL or 3MF, check what will print, and send it to your printer. You can also
> scan real objects with LiDAR, describe a part, or ask for changes.
>
> We’re testing printer setup and printing across more hardware. Counterpart uses
> bambu-printer-mcp or mcp-3D-printer-server; install or update them from Settings
> → Printers on your computer. You don’t need scanning or an AI connection to test printing.
>
> iPhone and iPad require iOS/iPadOS 27 and the Counterpart companion on an Apple
> silicon Mac with macOS 27. LiDAR capture needs compatible hardware. Mac, Android
> and Linux beta downloads and setup: https://counterpart.dtmont.com/beta.html
>
> Design and AI cleanup use your chosen provider and account. In-hand scanning is
> Labs work and is unavailable in this build. AR preview is optional and still
> being fixed. Walk-around scans can have missing or inaccurate surfaces.

Suggested What to Test:

> 1. Install the matching Mac companion from https://counterpart.dtmont.com/beta.html.
>    In the Mac’s Settings → Printers, install/update the printer software and add your printer.
> 2. Pair your iPhone or iPad. Import an STL/3MF or choose a starter project. Check
>    connection status, the estimate and the What will print pictures.
> 3. Start a small print when you’re ready. Test progress, Pause, Resume, Stop and
>    the finished result. Tell us which steps worked, too.
> 4. For a failure, send a screenshot through TestFlight with the steps, expected
>    result, actual result, approximate time and project name. Include phone and
>    computer OS/app versions, printer model/firmware, slicer, connection method,
>    and the printer software version from Settings → Printers.
> 5. On the Mac, Settings → Advanced → Export Diagnostics… saves a local ZIP.
>    Email it to the beta feedback address shown in TestFlight, with the same time
>    and project name. Review it before sharing; never send access codes or API keys.
>
> In-hand scanning is Labs work and unavailable in this build. AR is optional.
> Neither is needed to test your printer. Reporting guide:
> https://counterpart.dtmont.com/help.html#report

Review notes addition:

> This beta focuses on pairing, printer setup and printing with testers’ own hardware.
> The companion download, prerequisites and cleanup-worker instructions are at
> https://counterpart.dtmont.com/beta.html. Existing STL/3MF printing does not require
> an AI account or scanning. In-hand capture is unavailable; AR preview is optional.

Before submission, supply the actual companion/setup URLs and complete review
instructions. David supplied feedback/review email and phone on November 3; those
are saved in App Store Connect. Do not copy private review contact details into
public setup documentation. Help is
`https://counterpart.dtmont.com/help`; privacy is `/help#privacy`. Review the live
copy for accuracy, especially which AI worker actually receives project inputs.
Explain the companion, user-selected AI connection and printer setup to review, and provide
usable review resources for this hardware-dependent workflow.

In App Store Connect, use the existing app record for `com.scantomake` if present.
Create an internal group before the external group; add the processed build,
enter beta/review information and submit Beta App Review. After approval, open
the external group's Testers tab and Create Public Link. Use device/OS criteria
consistent with the build. Record the actual link and status; uploaded, processing,
in review and available to external testers are different outcomes.

## Checks without signing or uploading

```sh
bash -n apps/mac/scripts/release.sh apps/mobile/scripts/prepare-testflight.sh
python3 -m unittest discover -s scripts/tests -v
node site/check.mjs
```

## Apple references checked 2026-11-03

- [Current SDK acceptance and release notes](https://developer.apple.com/help/app-store-connect/release-notes/)
- [Uploading builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
- [External groups, review and public links](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/)
- [Required beta information](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information/)
- [APS environment from the signed provisioning profile](https://developer.apple.com/documentation/bundleresources/entitlements/aps-environment)
- [Deploying CloudKit schema](https://developer.apple.com/documentation/cloudkit/deploying-an-icloud-container-s-schema)
- [Developer ID capabilities](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [Notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Review access and app completeness](https://developer.apple.com/app-store/review/guidelines/#app-completeness)

Release update configuration: public key `Q4iK0moZS/pqxA5lrVvBbESdU218oW49rKlNGTd0z8A=`,
feed `https://counterpart.dtmont.com/appcast.xml`. The signed feed is published and its live bytes were verified.

Apple’s [common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
documents `CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO` for a custom distribution build.

## Android signing and recovery

The permanent Android update identity was created Nov 5, 2026. **Never regenerate
or replace it for an update.** The app ID is `com.scantomake`; key alias
`counterpart`, RSA 4096, JKS. On David's Mac:

- Keystore: `~/Library/Application Support/Counterpart-release/android-release.jks`
  (directory mode 700, file mode 600).
- Login Keychain service: `Counterpart Android release`; accounts
  `store-password`, `key-password`, and `backup-passphrase`.
- The same three values have synchronizable data-protection Keychain copies for
  iCloud Keychain recovery, access group `X7F5F9LR24.com.counterpart.release-key`.
  Synchronizable items require a provisioned, signed helper in the logged-in GUI
  session. The local login copies require Keychain access approval; an SSH
  `security find-generic-password` attempt was denied (exit 36). Use the signed
  GUI helper for unattended signing; never treat an empty password as success.
- Encrypted backup:
  `~/Library/Mobile Documents/com~apple~CloudDocs/Counterpart-release/android-release.jks.enc`.
  Encryption: OpenSSL AES-256-CBC, salted, PBKDF2, 600000 iterations. Local
  decrypt-and-compare passed. Upload to iCloud and recovery on a second Mac have
  not been independently verified. A later iCloud read returned “Resource deadlock
  avoided” while the Mac disk was full, and replacing the cloud file was refused.
  A second encrypted copy is `android-release-new.jks.enc` in the same cloud folder;
  its local source is `android-release.jks.enc` beside the keystore and passed
  recovery again. Ensure iCloud Drive and iCloud Keychain sync finish and verify
  recovery on another Mac before relying on this as an off-machine backup.

Recovery on a replacement Mac: sign in to the same iCloud account and enable
Drive and Keychain. Download the encrypted backup. Retrieve `backup-passphrase`
from the synchronizable item using a helper signed by team `X7F5F9LR24` with
that access group authorized by its provisioning profile; do not create new
passwords if an item is missing. The current helper uses the existing Counterpart
Mac development profile, in a separate `ReleaseKey.app` under the release folder.
Its source is `release-key.swift` beside the keystore; a source and entitlement
copy are also beside the encrypted backup in iCloud Drive. The helper only reads
existing secrets. Run `ReleaseKey.app/Contents/MacOS/release-key recover
<encrypted-backup> <new-staging-file>` in a `gui/501` LaunchAgent on the current
Mac. On a replacement Mac, compile that source, embed a current Counterpart Mac
provisioning profile, and sign the helper with that profile’s team and authorized
access group. Recovered certificate SHA-256 must be
`15e9d0b6004a834e58129a4b615ee29e5a96c2c3225768cbe1a97aa56862c649`.
With the recovered passphrase in `COUNTERPART_BACKUP_PASSWORD` (never in a command
argument or log), decrypt to a new private staging file:

```sh
umask 077
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in android-release.jks.enc -out recovered-android-release.jks \
  -pass env:COUNTERPART_BACKUP_PASSWORD
```

Recover the store/key passwords from their synchronizable items into the login
Keychain. Check the recovered key's certificate fingerprint against the published
APK (`apksigner verify --print-certs`) before moving it into the permanent path.
Keep the encrypted backup and its Keychain passphrase together in the recovery
inventory, never in Git. Lost credentials mean recovery, not a new identity.

Gradle accepts the following names as user Gradle properties or environment
variables: `COUNTERPART_ANDROID_KEYSTORE` (absolute path),
`COUNTERPART_ANDROID_STORE_PASSWORD`, `COUNTERPART_ANDROID_KEY_ALIAS`, and
`COUNTERPART_ANDROID_KEY_PASSWORD`. Supply all four or none; none deliberately
produces an unsigned release for subsequent `apksigner sign`. Never put these in
repository properties or shell tracing. Increment `COUNTERPART_ANDROID_VERSION_CODE`
for each update (the first public APK is code 1). From a clean commit on
`origin/main`, run `./gradlew --no-daemon assembleRelease` in `android/`, then
`apksigner verify --verbose --print-certs` on the final APK. The signed GUI helper
also supports `sign-apk <apksigner.jar> <unsigned.apk> <signed.apk>`, supplying
Keychain passwords directly to the signing subprocess environment. Android requires
Android 8 / API 26 and a Counterpart Mac or Linux companion; phone pairing,
capture and printing still need device acceptance.

## Linux prerelease packages

Build on Ubuntu 26.04 x86_64 (agents-136), from clean `origin/main`, using
`apps/linux/scripts/bundle.sh`. Use a separate checkout from concurrent Android
builds: temporary Linux payload files correctly trip Android's clean-tree guard.
Publish the verified `.deb` and `.AppImage` with SHA-256 checksums and exact source
revision. Linux runs its own companion; it does not pair to the Mac desktop.
It needs a printer MCP and a slicer (Bambu Studio), configured through
Settings → Printers. Engineering build/package checks are not end-to-end device
or printer acceptance.
