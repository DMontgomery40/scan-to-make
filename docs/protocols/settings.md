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
with `scope: "model-jobs"`. The same persisted choice controls project designs, corrections,
published-model retrieval, title/completion helpers and capture cleanup. Each admitted job
captures its selection before waiting or preparing inputs; changes affect subsequent jobs.
`none` refuses new project model jobs and leaves deterministic capture repair available.
Phone changes use the same ModelAccessService as Mac settings. Credentials remain in Keychain.

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


### Model execution boundary

`modelAccess.json` is authoritative for new work, including phone changes. The signed
`--model-worker project <private-request-file>` helper resolves API credentials in Keychain.
It receives metadata on stdin; credentials never appear in arguments, request files or
companion environment. MCP children start through a private-file trampoline with an explicit, minimal
environment and their printer configuration; printer secrets also stay out of arguments. Native CLI environments exclude inherited API keys. Codex gets a private
HOME/config, a temporary copy of its login, and only the pass MCP. Refreshed login tokens
use the existing compare-and-swap writeback before the temporary home is removed.

Claude Code retains the existing isolated worker. Codex uses native `exec` with MCP and
image tools. Project API jobs use Anthropic Messages or OpenAI Chat Completions (including
compatible endpoints) with actual MCP tool/result turns and image content. Unsupported
models fail with capability guidance; they never fall back to Claude. Provider errors,
progress and final summaries are redacted. Published sites needing a signed-in browser
may require the person to add the original file when using a provider without Claude's
Chrome integration. Title and completion helpers use the same selected provider, with
MCP/browser/file tools disabled and short deadlines.

Capture cleanup keeps the existing sealed ai-tweak pipeline: Claude/Anthropic through
Claude Code, Codex/OpenAI/compatible Responses endpoints through Codex. It snapshots the
choice at queue admission. Compatible servers must support Responses for this capture
pipeline and Chat Completions for project jobs, with tools and images in both. A failed
AI cleanup keeps the captured scan and records the fallback; it never substitutes Claude.

For legacy installations with no preferences file and an explicitly configured Claude
path, initialization writes a Claude choice. Existing saved `none` is always preserved:
older records cannot distinguish default None from an intentional Off. Such installations
must choose a provider once; silently overriding Off is forbidden.

OpenCode is not yet a supported choice. Its installed `run --help` and current native MCP
configuration were inspected. Remaining work is a sealed login/config adapter, stream and
structured-result normalization, auth refresh/cancellation qualification, and matching
Swift/protocol choices; no unqualified runner is advertised as working.
