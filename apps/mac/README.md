# Counterpart for Mac

A normal Mac app for macOS 27 with a menu bar extra (PRD `docs/design/overhaul/PRD.md` §7). It is built from
SwiftUI scenes only:

- `Window` "Counterpart" (`main`): the sidebar groups projects as Now, Needs you, Ready and Printed, then the
  printers with their ready dots, and a footer with the phone and the AI. The detail is the project's model in
  RealityKit, full height on the dark stage (orbit and zoom with the system camera controls), with the state in a
  glass capsule, the size, one glass card for what the Mac needs or is doing, and a glass bar with **Ask for
  changes…** (it takes dropped photos when the companion has `objectsCreate`) and **Print…**. The toolbar has
  Open in Blender, Open in Slicer, Show in Finder, New Project and the Inspector (Request, Activity, Print).
- `Window` "Add a Phone" (`pairing`): the pairing QR; on first run, once a phone connects, it becomes setup (the
  AI choice).
- `Settings`, and `MenuBarExtra(.window)` for the popover.

There is a Dock icon by default; Settings → General → Show in Dock hides it (the activation policy is set once
at launch and when that setting changes). Opened by hand, the app shows its window, or the pairing code until a
phone is paired and set up; launched at login it stays in the menu bar. Quit reads "Quit Counterpart (your phone
stops getting updates)", because delivery to the phone runs in this app (PRD §8.8).

Every word about a project comes from `ControlKit/ObjectWords.swift` (PRD §4), which prefers the companion's own
`status` line when it serves one; `packages/CounterpartKit` replaces it when that lands. Features the running
companion lacks (its `status.get` capability flags) show a sentence saying so instead of failing.

**Delivery (PRD §8.8).** `EventRelay` long-polls the companion's `events.wait` (25 s) from a cursor kept in
UserDefaults. Each event becomes a Mac notification per Settings → General (defaults from PRD §9.1's Mac column;
progress off), a `CounterpartEvent` record and a `CounterpartProject` upsert in the user's private CloudKit database
(docs/protocols/cloudkit.md), and, when Settings → Advanced turns the relay on, a Live Activity push through
`counterpart.dtmont.com/relay/v1` (services/relay/docs.md). After a restart, events older than ten minutes are
synced but not shown, except `print.done`, `print.failed`, `pass.ready` and `pass.ask` that still stand, once each.
The relay also runs the phone's `CounterpartCommand` records through the existing control methods (fresh by the
server's clock, ten minutes at most), and keeps the Mac from idle sleep while a pass or a print runs.

CloudKit needs the iCloud entitlement: build with `STM_ENTITLEMENTS_SUFFIX=+CloudKit` (and
`STM_APS_ENVIRONMENT=production` for a Developer ID build). A build without it never touches CloudKit, and Settings →
Advanced says so.

The window reads `objects.list` over the control socket while it is on screen: every 3 s while something is
working or printing and every 15 s otherwise. Renders, photos and the model are read from each project's
`directory`.

The companion turns objects on only when it knows the user's own `claude` CLI. When
serving, `agent.mjs` passes `SCAN_TO_MAKE_CLAUDE_PATH`. An explicit absolute path in
`companion.env` wins. Otherwise it takes the login shell's `command -v claude`, then
`~/.local/bin/claude`, `~/.claude/local/claude`, `/opt/homebrew/bin/claude` and
`/usr/local/bin/claude`. If none is found it sets nothing. The printer config is
inherited as is.

The app uses `getifaddrs` to detect active LAN IPv4 addresses, skipping loopback
and link-local addresses, and collects the `.local` hostname and Tailscale IPv4
addresses. `NWPathMonitor` refreshes the snapshot when the network changes. A
fresh installation prefers the primary network interface, then physical LAN
interfaces before virtual bridges. Setup selects an RFC1918 address accepted by
the companion, while discovery retains other addresses. It reuses the existing
certificate generator and `init-lan` CLI. Existing certificates are never rotated
on an address change. This remains the current v1, single-address pairing
contract; multi-address invitations and certificate renewal are separate follow-ups.

## Build and test

`ScanToMake.xcodeproj` is checked in. `project.yml` is its XcodeGen source.

Design QA (Debug builds only): `--design-fixtures <assets>` runs the real app on screen with the mockup's projects
(`docs/design/overhaul/mockup-app`), reading the uncommitted mockup assets from `<assets>`, without registering,
pairing or probing the network. `--design-select 1…6`, `--design-tab request|activity|print` and
`--design-screen main|popover|settings` choose what shows; `--design-snapshot <folder>` writes a PNG of each of the
app's own windows (through ScreenCaptureKit's `currentProcess`, which needs no Screen Recording grant) for the
side-by-side comparison with `docs/design/overhaul/screens/mac-*.jpg`. Build a design run with
`STM_VARIANT=.design STM_USE_LEGACY_COMPANION=NO` so it never shares the installed app's identity.
Without fixtures, `--design-project <id> [--design-screen print]` opens one real project (and its print sheet, which
asks the real printer for an estimate and never prints) for the same snapshot against the running companion.
`--design-legacy` adds three pairings from before stable identity to the fixtures' Phones and iPads.

The words for a project come from `packages/CounterpartKit` (`ProjectWords`, shared with the phone); the Mac adds only
its sidebar sections, capsule and actions (`ControlKit/Sources/ControlKit/ObjectWords.swift`).

**Running a build from DerivedData next to the installed app.** The companion is an `SMAppService` agent whose
program launchd resolves from the bundle identifier `com.scantomake.mac`. After a copy of the app outside
/Applications has run (a DerivedData build, a moved-aside old app), launchd can keep resolving the agent to that copy:
`launchctl kickstart -k gui/$UID/com.scantomake.mac.companion` restarts it from there, `lsregister -u` on the copy
doesn't change that, and moving the copy away leaves the agent failing with `EX_CONFIG` (78). The order that works:

```sh
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSR" -u "<the other copy>.app"
"$LSR" -f "/Applications/Scan to Make.app"
open "/Applications/Scan to Make.app"          # first: the installed app launches
launchctl kickstart -k "gui/$(id -u)/com.scantomake.mac.companion"
lsof -p "$(launchctl print "gui/$(id -u)/com.scantomake.mac.companion" | awk '/^\tpid =/{print $3}')" | grep 'txt.*MacOS'
```

The last line should name `/Applications/Scan to Make.app`.

```sh
swift test --package-path apps/mac
xcodebuild -project apps/mac/ScanToMake.xcodeproj -scheme ScanToMake \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO test
bash apps/mac/scripts/prepare-payload.sh
xcodebuild -project apps/mac/ScanToMake.xcodeproj -scheme ScanToMake \
  -configuration Debug -derivedDataPath apps/mac/build \
  CODE_SIGN_IDENTITY='Apple Development' build
```

Payload preparation reads `distribution.json`, verifies pinned Node 24,
python-build-standalone and the two approved Python wheels with SHA-256, and builds
committed companion sources using npm lockfiles. It precompiles bytecode before signing, including
all optimization levels used by isolated Python workers. Node receives the
Hardened Runtime `allow-jit` entitlement; native Python libraries are signed too.
This shell does not install printer tools or reimplement cleanup/slicing/printing.

`SOURCE_ARCHIVE` may supply a committed archive on a machine without GitHub
credentials. Include `packages/contracts`, `services/project`,
`services/printer-handoff`, `services/companion`, `tools/capture-mesh-convert`,
`tools/capture-pipeline`, `tools/capture-fit-eval`,
`tools/mac-reconstruct`,
`deploy/companion/generate-lan-tls.py`, and
`deploy/companion/healthcheck.mjs`. These LAN helpers must be present in the source
revision. Supplied archives are filtered to the manifest's exact paths. CI builds the shell without downloading runtimes; a runnable fresh
installation requires Payload. Signing needs access to the development keychain.

## Distribution licences and optional workers

`distribution.json` declares runtime versions, source URLs, download checksums
and checksummed upstream licence texts. `THIRD_PARTY_NOTICES.md` and `Licenses/`
ship in `Contents/Resources`. The repository audit checks those declarations,
the pinned Sparkle revision and every production npm dependency. Packaging also
checks the actual wheel set, tool directories and pruned npm packages before
signing. See [distribution details](DISTRIBUTION.md).

Fresh app-owned installations provide pairing and capture conversion. The GPL
cleanup workers and the `pillow-heif` binary wheel are not bundled or downloaded.
Cleanup requires an independently installed worker setup. Migration retains the
existing worker Python, repair/correction and Blender paths; it does not remove
the old release containing those workers. Explicit paths in `companion.env`
override migrated paths. Blender remains an unmodified external CLI process,
consistent with PRD L06; the app never downloads or links Blender.

## Existing installations and isolation

If the legacy companion plist exists, the app uses that installation's own
launcher and `pair-capture-and-printer-handoff` CLI. Its state directory is resolved
from the launcher, including custom `STM_INSTALL_ROOT` installations; the retired
plist preserves that location after migration. Opening the app does **not** stop the existing
service or migrate it. Pairing stdout is held only in memory, stderr is discarded,
and CoreImage renders `qrPayload`. The existing CLI also owns a short-lived
loopback pairing page; closing the app view does not revoke the invitation or
that page. Both expire under the existing auth contract.

The in-memory cache is checked with the selected release's
`RemoteAuthStore.isPairingActive` before reuse. The QR crosses a private stdin
pipe; the helper returns only a boolean. Consumed codes are already removed by
exchange, and expired codes are pruned atomically by the next mint. The app never
supersedes a still-active code just because another presentation opens. The
bundled companion includes the auth-store v2 migration from the same source
snapshot as the app; it still emits the supported v1 pairing payload.

For isolated registration testing, build with `STM_VARIANT=.agenttest` and
`STM_USE_LEGACY_COMPANION=NO`. This uses bundle/agent identity
`com.scantomake.mac.agenttest` / `com.scantomake.mac.agenttest.companion`, separate
`~/Library/Application Support/Scan to Make.agenttest`, and port 19077. Default
builds use `com.scantomake.mac`, the existing `Scan to Make` state directory and
port 9077. A `.test` build with the default legacy setting can show an invitation
from an existing live service without changing that service.

Install the signed app in `/Applications` or `~/Applications` before agent
registration. The app refuses registration elsewhere. The maintenance entry
point `"Scan to Make.app/Contents/MacOS/Scan to Make" --install-agent` provisions
and registers without opening a pairing window. Launch it in the login session
for real registration/privacy verification. This also provides an explicit
migration entry point once the existing service is idle.

## Agent lifecycle and migration

Fresh installs configure and start the bundled companion automatically. Production
app launches register `SMAppService.mainApp` for login. The companion is an
`SMAppService.agent` whose plist lives in `Contents/Library/LaunchAgents` and whose
BundleProgram points to the app executable. That executable remains alive as the signed supervisor of bundled Node
in agent mode. Quitting the app leaves the companion running.

Migration is explicit because the current companion has no reliable cross-project
busy/idle API. Coordinate an idle window, then use `--install-agent`:

1. Preserve `~/Library/Application Support/Scan to Make`, especially `auth`, `tls`,
   `capture`, `companion.env` and old releases. Existing phones pin the certificate.
2. Save old dependency locations (not credentials) in `app-migration.json`.
3. Register behind an activation marker. Pending background-item approval leaves
   the old service running. Retry after approval in System Settings → Login Items.
4. After approval, preflight the old listener with the old release's code (new
   auth code must not upgrade a store while the old server is running). Stop the
   legacy launch job, snapshot auth, activate the new agent, and run the existing
   `deploy/companion/healthcheck.mjs` against the configured listener with its
   certificate. This is liveness, not authenticated end-to-end acceptance.
5. Only after success, rename the old plist to `.plist.pre-app` so it will not
   return at login. On failure, independently attempt deactivation, unregistration
   and restoration, surfacing a rollback error if any fails. If activation upgraded
   the auth schema, restore the exact pre-activation bytes after stopping the new
   agent and before restarting the old release. Retain pre-existing auth backups;
   remove only a matching backup created by the failed upgrade so retry works.
   A failed readiness
   retry never unregisters an already-active app agent.

Manual recovery: unregister/stop the app agent **first** (removing the marker
alone does not stop its running server), remove `app-agent-enabled`, restore
`.plist.pre-app` to `.plist`, then bootstrap the legacy plist in the login user's
GUI domain. Do not delete auth/TLS or rerun `init-lan`. Server diagnostics append
to the existing private `logs/companion*.log`; pairing output never goes there.

Local Network acceptance requires a real login-session launch and a LAN operation,
with a prompt naming **Scan to Make**, and deny/allow checks. SSH-started tools
are exempt and cannot establish this. See [Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).

The foreground app makes one bounded SSDP discovery attempt per launch after a
LAN is available. Login/background launch does not consume that attempt. The
system owns the permission decision; the app never stores an inferred grant.
The user must answer the system's Local Network alert. The app stays running
even when access is denied; it does not use a short-lived permission helper.

The app-owned agent pins `SCAN_TO_MAKE_PRINTER_NODE` to its signed bundled Node,
overriding retained environment values. Printer MCP sessions substitute this
runtime for absolute Node commands and npm Node-script entry points, and put its
directory first in the child's PATH. Arguments, cwd and printer credentials stay
unchanged in memory; `printer-handoff.json` is not rewritten. Native helpers keep
their own entry point. Node has a stable `<app bundle ID>.node` signing identifier.

After an approved redeploy and the user's Allow, call local `printer.check` with
`{"start":true}`, then poll without `start` until complete. This calls Bambu's
`get_printer_status` and `camera_snapshot` from the actual companion process tree,
without printing. Preserve the redacted status/camera hash receipt alongside the
usual auth, TLS pin, capture and paired-client preservation checks. Signed build
and unit tests alone do not prove Local Network attribution or live reachability.

## Updates and distribution

Sparkle 2 is linked. Development builds leave `SUFeedURL` and `SUPublicEDKey` unset.
For release, Sparkle's `generate_keys` stores the Ed25519 private key in Keychain;
set its public key as `SPARKLE_PUBLIC_KEY` and the HTTPS appcast location as
`SPARKLE_FEED_URL`. No private key belongs in Git. See [Sparkle setup](https://sparkle-project.org/documentation/)
and [publishing](https://sparkle-project.org/documentation/publishing/).

`scripts/release.sh` requires Developer ID, an increasing build number, a Keychain
notary profile, the public key/feed URL and Sparkle tools. It builds with Hardened
Runtime, verifies signatures, notarizes/staples, and creates an EdDSA-signed
appcast and ZIP without uploading. Run it when Developer Program membership and
Developer ID signing are available. Development builds never attempt notarization.

Configured release builds start Sparkle checks only when the app agent is not
enabled and no legacy installation remains. Downloads are not automatic. This
conservative gate avoids replacing the running companion; the later local-control
busy/idle contract can allow updates while the agent is idle. Development builds
do not start Sparkle. Feed publication, notarization and upgrade acceptance remain
release validation steps.
