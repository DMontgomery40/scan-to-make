# Shared settings

`GET /v1/settings` and local `settings.get` return `{settings: ...}`. HTTP PATCH and
local `settings.set` accept partial changes. Reads require `projects:read`; HTTP writes
require `projects:write`. The local socket uses its existing app authorization.

Implemented sections:

- `milestones`: `off`, `50`, `25-50-75`, or `every-10`.
- `notifications.mac`: event-type → boolean overrides for Mac notifications.
- `notifications.devices`: device ID → event-type → boolean saved phone preferences.
- `general`: optional `openAtLogin`, `showInDock`, and `keepAwake` booleans.

The companion serializes load/merge/validate/write, deep-merges nested partial patches,
retains explicit false values and unknown top-level stored sections, and emits
`settings.changed` after a successful save. Invalid saved preferences are not replaced
with defaults. An old milestones-only client can continue reading and writing milestones.

Empty notification maps mean the documented defaults in `SettingsSchema`, not all off.
General starts empty: the Mac supplies its actual current login, Dock and awake choices
before the phone offers those controls. The Mac then applies changes made on either
client. Existing Mac overrides migrate on the first supported read. Older phone keys
`CounterpartNotify.*` migrate into its device map without turning an already saved false
into true; the legacy Live Activity choice is retained as `live-activity`.

## Delivery limits

Mac per-event switches control the existing Mac notification relay. Phone per-device/type
switches remain unavailable: CloudKit query subscriptions are shared by the Apple Account,
and this build cannot selectively suppress their delivery to one device. Persisting a
phone opt-out does **not** filter an already existing shared push. The UI states that limit
and directs users to system notification settings for that device.

The phone enables existing visible subscriptions, including `ev-ready`, only after a
supported settings response and with no saved local or device-map opt-outs. Missing older
fields or a saved opt-out never delete shared subscriptions or enable new visible ones;
existing shared alerts retain their configuration. Silent project reconciliation remains
available. No APNs credentials, entitlements or relay targeting change in this patch.

Apple documents subscriptions as per-user in [QA1917](https://developer.apple.com/library/archive/qa/qa1917/_index.html).
Apple's [notification-filtering entitlement](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.developer.usernotifications.filtering)
requires permission before an extension may silence delivered pushes. This app does not
have that entitlement. The implementation conclusion is therefore specific to the current
architecture: deleting an account subscription is not a safe per-device preference, and
ordinary extension enrichment cannot be presented as per-device suppression. Sources checked
2026-11-02; actual delivery also depends on system permission and container configuration.

For login launch, an explicit existing preference takes priority over the initial system
snapshot, while a saved companion opt-out stays off. A registered service awaiting approval
keeps its requested state; unknown status does not request registration. Apple's
[Service Management status documentation](https://developer.apple.com/documentation/servicemanagement/smappservice/status-swift.enum)
distinguishes registration from permission. Counterpart reports required system approval
without changing that permission.

## AI and Fusion runtime bridge

`ai` projects the existing ModelAccessService revision, choice metadata and check result,
with `scope: "connection-test"`. This saves/tests a connection only. Current ObjectService
cleanup, design and correction jobs still use their configured Claude Code executable;
ModelAccessService.run is not wired into those jobs. Choosing None does not disable them.
The phone names this section AI connection test and explains the scope. Provider routing
for actual model jobs remains separate unfinished work; no Codex worker is introduced here.
Keychain references and credentials stay on the Mac. A standalone AI PATCH requires
`ai.expectedRevision` and accepts only `none`, `claude-code` or `codex-cli`; other sections
cannot share that PATCH. Stale revisions return conflict. `POST /v1/settings/ai/test`
accepts `{revision}` and uses the same app worker as the Mac's Test button. API and endpoint
choices remain configurable only on the Mac; their nonsensitive metadata can be displayed.

`fusion` is ephemeral Mac-reported installation/running state, not a saved assertion that
a connection still works. Passive settings refresh never launches an MCP or Fusion and
never reads a design. The last explicit setup result is labeled as such. Reports expire
after 90 seconds; an absent Mac reports unavailable.

`POST /v1/settings/fusion/setup` requires projects:write and a recent installed-Fusion report.
It creates one pending request and emits settings.changed. The signed Mac claims it through
local `fusion.claimSetup {claimantId}` (one immutable UUID per app coordinator), runs the existing FusionSetup installer/check asynchronously,
and completes through local `fusion.setupDone` with that exact request ID. A transient
socket failure retains the result for retry; an explicit stale conflict clears it without
rerunning the installer. Passive reports emit settings.changed only when their public
state/message changes, never for heartbeat timestamps alone. The callback
sends controlled words, not arbitrary diagnostic text. A lost claim response can be replayed by that same claimant; another app instance cannot
take an active claim. The coordinator guards prevent replay from reinstalling;
a request expires after ten minutes and old completions cannot settle a newer request.
A companion restart discards pending requests. Restarting only the Mac app creates a new
claimant; it cannot take over active work and must wait for the ten-minute expiry, then
accept a new explicit setup request. No lease or automatic takeover is introduced. Neither HTTP nor a phone can report or
complete GUI work. Manual and phone setup share the existing Mac install operation guard.

The phone shows Set Up Again for an installed but unchecked setup, and preserves the exact
failure message when setup needs attention. Transport/unit tests do not establish live
provider login, live Fusion setup, or native phone acceptance.
