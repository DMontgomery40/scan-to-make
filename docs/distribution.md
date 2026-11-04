# External TestFlight release

The release is an iPhone IPA **and a usable Mac installation**. TestFlight does not
install the companion, its independent cleanup workers, or the printer MCPs.
The iPhone identifiers remain `com.scantomake`, `com.scantomake.notifications`, and
`com.scantomake.widgets`; the Mac remains `com.scantomake.mac`, team `X7F5F9LR24`.

## Current prerequisites

The read-only audit on 2026-11-03 found only an Apple Development signing identity
and development provisioning profiles on this Mac. Xcode has a saved Apple account,
but active distribution access and an App Store Connect record were not verified.
No ASC API key was found in the standard local locations. Cached Personal Team
metadata is not proof of current membership status. Check the live account before
creating another app record or asking for credentials.

There is no published GitHub release for this app and the public site still says
it is unavailable to download. Before inviting testers, publish a notarized Mac
artifact and exact setup instructions that a fresh Mac can follow. Verify that
installation independently of David's existing setup:

- [Mac distribution inventory](../apps/mac/DISTRIBUTION.md) excludes cleanup workers
  from the app payload. Supply a supported independent installation path for them.
- The app's Download MCP action installs npm's latest version. Local feature-branch
  fixes are not delivered by that action. The two MCP npm releases remain held;
  do not merge/publish them to solve this implicitly. Identify and test the exact
  beta-compatible backend installation before claiming print controls work for
  new testers.
- The legacy macOS installer and Docker image pin older MCP versions. They do not
  reproduce the currently accepted feature-branch installation.

Physical capture, post-capture camera/Face ID, phone printer controls, real-print
notifications and Watch delivery still need the acceptance recorded in
[asks](status/asks.md). A successful archive does not close those checks.

## Production services

Deploy and inspect the complete CloudKit schema in
`iCloud.com.scantomake.counterpart`: `CounterpartEvent`, `CounterpartProject`,
`CounterpartCommand`, `CounterpartMac`, and `CounterpartDevice`, with every field in
[the CloudKit contract](protocols/cloudkit.md). `CounterpartEvent.type` must be
Queryable. Deployment copies schema, not development records. Both clients must
use Production for same-account discovery, events and commands to meet.

The production Live Activity relay must authenticate to `api.push.apple.com` using
a production-compatible APNs key and topic `com.scantomake.push-type.liveactivity`.
Sandbox acceptance does not establish production readiness; see
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

The script applies `App+CloudKitProduction.entitlements`, pins production push and
CloudKit, validates the signed app, notarizes/staples it, checks Gatekeeper and
creates the ZIP/appcast. It does not upload them. The profile setting applies only
to the app target, not AgentKit. Verify a downloaded copy on a clean Mac, including
the Local Network permission prompt, companion startup, cleanup workers, printer
MCP discovery, update path and same-account phone pairing before sharing the link.

## Beta information and public link

Suggested Beta App Description:

> Counterpart connects your iPhone and Mac to scan real objects, improve their
> models, and print through your own printer MCP. This beta requires iOS 27,
> an Apple silicon Mac running macOS 27, and the Counterpart Mac companion.
> LiDAR scanning requires compatible hardware. Model creation and editing use
> your own Claude Code setup.

Suggested What to Test:

> Install the linked Mac companion and follow its beta setup instructions. Pair
> the phone and Mac, open a project and scan an object. Check every side of the
> model and check that the camera works after capture. Try printer selection,
> print estimates, pause/resume confirmation and completion updates. Report
> unexpected connection messages, duplicate alerts, stuck Live Activities or
> missing model surfaces through TestFlight. Include the phone model, app build,
> Mac companion version and printer MCP version.

Before submission, supply the actual companion/setup URLs, intended feedback
email, and App Review contact details (including an international-format phone
number). Do not infer release contacts from the Xcode login. Help is
`https://counterpart.dtmont.com/help`; privacy is `/help#privacy`. Review the live
copy for accuracy, especially which AI worker actually receives project inputs.
Explain the required Mac, Claude login and printer setup to review, and provide
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
