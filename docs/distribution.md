# External TestFlight release

The release is an iPhone IPA **and a usable Mac installation**. TestFlight does not
install the companion, its independent cleanup workers, or the printer MCPs.
The iPhone identifiers remain `com.scantomake`, `com.scantomake.notifications`, and
`com.scantomake.widgets`; the Mac remains `com.scantomake.mac`, team `X7F5F9LR24`.

## Current prerequisites

App Store Connect now contains **Counterpart 3D**, Apple ID **6830483457**, bundle
`com.scantomake`, with **Full Access** saved and rechecked. David chose external
testers through a public link. Xcode's signed-in account successfully cloud-signed,
exported and uploaded **2.0 (2)** on 2026-11-03 at 23:19 Mountain. The app and both
extensions passed signature, version and Production entitlement checks. Source:
`c438efa`; artifact: `~/scan-to-make-work/testflight-2.0-2/`. Apple accepted the
upload and finished processing. Build 1 was removed from review; build 2 was submitted
at 23:32 and now shows **Waiting for Review** for the external
`Counterpart Public Beta` group. Automatic tester notifications are off. The public link is **https://testflight.apple.com/join/S4tExVzp**, open to anyone.
Apple displays: “Testers cannot join public link until this group has an approved build.”
No tester email invitations were sent. The Mac release and beta setup page are published;
Apple review notes now include the live download/setup link and starter details.
The internal prerequisite group `Counterpart Team` exists. Beta description and
David's supplied review/feedback contacts are saved in App Store Connect.

**Latest upload:** **2.0 (3)**, source `4a894769`, uploaded successfully on Nov 4 at
16:16:47Z. It passed app/extension distribution signature and Production entitlement
checks. Apple reports processing; group assignment and Beta App Review submission for
build 3 are not yet verified. Build 2’s Waiting for Review status above is the last
observed group state. Archive, IPA, hashes and upload log: `~/scan-to-make-work/testflight-2.0-3/`.
No physical phone installation or production relay change was made.

Xcode used cloud-managed Apple Distribution signing for the iPhone. A Developer ID
Application certificate and matching Production profile are installed for the Mac.
The current [Mac beta release](https://github.com/DMontgomery40/scan-to-make/releases/tag/v2.0-beta.3)
is **0.1.0 (202611040120)**, source `e7d5f6d` (#298), published Nov 4.
It retrieves FDM guidance from the selected MCP and forwards structured slicer feedback
to API design workers. Both published MCPs supply the required prompts.

The archive/export passed distribution signature and Production entitlement checks;
embedded Node/Python start and all five changed runtime modules match the prepared payload.
Notarization submission `6fa11899-18fc-4671-91c1-388f50ccb7dd` was **Accepted**;
the ticket is stapled and Gatekeeper accepts the app. Artifacts and compact receipts:
`~/scan-to-make-work/mac-beta-export-202611040120/`. The Keychain notary profile is
`Counterpart-Production`; the private Sparkle update key is also in Keychain.

ZIP SHA-256: `88557aa0bd97bc696c3bc3beceef2c21f78c2338b3fe4c3a3eca11334a95288e`.
The setup page and signed Sparkle feed point to this release. The prior Mac beta remains
available as v2.0-beta.2; no app was installed over David's working development app.
A downloaded-file check is not fresh-install acceptance. Verify installation
independently of David's existing setup:

- [Mac distribution inventory](../apps/mac/DISTRIBUTION.md) excludes cleanup workers
  from the app payload. The [independent source installer](../deploy/companion/README.md#independent-workers-for-the-signed-counterpart-mac-app)
  now qualifies and attaches them without another service or global installs.
  It requires an existing Python 3.12 and Blender 5.0.1; include these prerequisites
  and the exact release source commit in beta setup instructions.
- The app's Download/Update MCP actions install npm's latest version independently
  of the iPhone or Mac release. David authorized both combined MCP releases after
  checks on Nov 4; the previous release hold is superseded. The FDM/MCP thread owns
  the actual app's MCP Update/acceptance. Published versions reported by that owner on Nov 4
  are bambu-printer-mcp **1.1.54** and mcp-3d-printer-server **1.2.28**, including slicer support arguments.
  The actual Mac app successfully installed npm Bambu **1.1.54** through Settings → Printers → Update
  at 13:37Z. The unused generic MCP checkout remains 1.2.26. Do not hand-copy local feature builds.
  Accept print controls using visible Counterpart controls with the published packages users receive.
- The installed development Mac build **202611040900** includes #298 guidance, the orientation/support
  bridge and updater fixes. Final main **127721fa**, including #293 multi-colour 3MF/AMS mapping,
  is integrated into the release branch at **167b5770**, alongside Android/Linux and reconstruction.
  This source integration is not a new public artifact or physical-print acceptance.
- The hand-copied version-label obstacle is resolved by the newer npm release. The updater now authorizes
  the selected package's postinstall and verifies it before swapping; bundled Node permits third-party
  native modules under Hardened Runtime. `--loglevel=notice` also preserves the verification banner
  when the user's npm configuration is silent. The next public Mac build must carry all these fixes.
- The legacy macOS installer and Docker image pin older MCP versions. They do not
  reproduce the currently accepted feature-branch installation.

Physical capture, post-capture camera/Face ID, phone printer controls, real-print
notifications and Watch delivery still need the acceptance recorded in
[asks](status/asks.md). A successful archive does not close those checks.

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

> Scan real objects with your iPhone, refine their 3D models, and send them to
> your printer with Counterpart.
>
> Counterpart works with your own printer tools: bambu-printer-mcp or
> mcp-3D-printer-server. Bring your own AI connection—use your Claude Code or Codex
> login, an API key, or an OpenAI-compatible endpoint such as OpenRouter or a
> local model server.
>
> The beta requires an iPhone running iOS 27 and the Counterpart companion on an
> Apple silicon Mac running macOS 27. LiDAR scanning requires a compatible iPhone.
> Linux desktop support and OpenCode integration are coming soon. Connect to your
> computer locally or remotely over Tailscale.
>
> Setup and updates: https://counterpart.dtmont.com/help

David's release direction is Linux desktop support soon and provider choice,
not a permanent Mac/Claude Code requirement. Do not claim Linux is shipped or
promise a public 24-hour deadline before acceptance. Saved provider routing is integrated for project jobs, cleanup and helper text;
Off is enforced. Claude/Codex fixture MCP and image checks passed. Real app-level
modeling acceptance, OpenCode integration and API cleanup capability coverage remain.
API cleanup retains harness requirements; custom cleanup endpoints need Responses support. Linux must account for the Apple-only
reconstruction and CloudKit pieces, alongside its UI, companion and Tailscale path.


Suggested What to Test:

> Install the linked Mac companion and follow its beta setup instructions. Pair
> the phone and Mac, open a project and scan an object. Check every side of the
> model and check that the camera works after capture. Try printer selection,
> print estimates, pause/resume confirmation and completion updates. Report
> unexpected connection messages, duplicate alerts, stuck Live Activities or
> missing model surfaces through TestFlight. Include the phone model, app build,
> Mac companion version and printer MCP version.

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
