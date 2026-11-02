# Settings (phone and Mac)

PRD §5.9: every setting the Mac has is also on the phone, and both show the same value. The companion stores them and is the single source of truth. The phone reads and writes them over the pairing (`GET`/`PATCH /v1/settings`), and the Mac app over the control socket (`settings.get`/`settings.set`, same shapes). After every change the companion emits `settings.changed`, so the other app applies it at once.

`CounterpartKit` mirrors this document as `SettingsSchema`: the keys, types, defaults and labels below, so both apps render one list from one definition. The wire schema is `CompanionSettingsSchema` / `SettingsPatchSchema` in `@scan-to-make/contracts/counterpart`. **Status:** KAN-214 PR 6b. Until then `GET /v1/settings` returns only `{settings: {milestones}}` (PR 2).

Compatibility: ignore unknown keys, and treat an unknown notification type as "on" for the phone and "off" for the Mac. A key a client doesn't know is kept by the companion; a `PATCH` changes only the keys it names.

## Routes and methods

| Phone (HTTPS) | Scope | Mac (control socket) | Body | Reply |
|---|---|---|---|---|
| `GET /v1/settings` | READ | `settings.get {}` | | `{settings: Settings}` |
| `PATCH /v1/settings` | SETTINGS | `settings.set SettingsPatch` | `SettingsPatch` (below) | `{settings: Settings}` |
| `POST /v1/settings/ai/test` | SETTINGS | `modelAccess.check {revision}` (existing) | `{revision}` | `{check: ModelAccessCheck}`; read its progress from `settings.ai.check` |
| `POST /v1/settings/fusion/setup` | SETTINGS | `fusion.setup {}` | `{}` | `{fusion: FusionStatus}` with `state: "setting-up"` |
| `GET /v1/devices` | READ | `devices.list {}` (existing) | | `{devices: Device[]}` |
| `DELETE /v1/devices/<deviceId>` | SETTINGS | `devices.remove {deviceId}` (existing) | | `{removed: true}`; 404 for an unknown device. The calling phone may remove itself. |

READ is `projects:read` and SETTINGS is `projects:write`, as in [objects-api.md](objects-api.md). A value outside its type is 400 `invalid-request` naming the key. Something only the Mac can do (below) is 409 with the sentence to show.

## `Settings`

```jsonc
{
  "milestones": "50",
  "notifications": {
    "mac": {"pass.ready": true, "print.milestone": false /* …every type below */},
    "devices": {"<deviceId>": {"pass.ready": true /* … */}}
  },
  "general": {"openAtLogin": true, "showInDock": true, "keepAwake": true},
  "ai": {"revision": "<uuid>", "choice": {"kind": "claude-code"}, "check": {"id": "…", "revision": "…", "state": "connected"}},
  "fusion": {"state": "connected", "message": "Fusion is connected."}
}
```

### Keys

| Key | Type | Default | Label | Section | Who applies it |
|---|---|---|---|---|---|
| `milestones` | `"off"` \| `"50"` \| `"25-50-75"` \| `"every-10"` | `"50"` | Progress updates | Notifications | the companion (which `print.milestone` events it emits) |
| `notifications.mac.<type>` | boolean | the Mac column below | the type's label | Notifications, "On this Mac" | the Mac app's `EventRelay` |
| `notifications.devices.<deviceId>.<type>` | boolean | `true` | the type's label | Notifications, "On this iPhone" | that phone (the companion only stores it) |
| `general.openAtLogin` | boolean | `true` | Open at login | General | the Mac app (`SMAppService.mainApp`; today's `openAtLoginOff` default is the inverse) |
| `general.showInDock` | boolean | `true` | Show in Dock | General | the Mac app (activation policy) |
| `general.keepAwake` | boolean | `true` | Keep the Mac awake while working | General | the Mac app (`EventRelay`'s `AwakeKeeper` while a pass or print runs) |
| `ai` | read-mostly, below | `{kind: "none"}` | AI | AI | the companion (model access) |
| `fusion` | read-only, below | | Design with Fusion | Design with Fusion | the companion and the Mac app |

The milestone choices' labels: `off` "Off", `50` "Halfway", `25-50-75` "Every quarter", `every-10` "Every 10%".

### Notification types

One switch per type, in this order. `phone` is the default for every phone; `mac` is the Mac default (PRD §8.8, §9.1).

| Type | Label | phone | mac |
|---|---|---|---|
| `pass.ready` | Ready to print | on | on |
| `pass.ask` | Needs a photo or an answer | on | on |
| `pass.failed` | Couldn't finish the model | on | on |
| `print.confirm` | Printer needs a yes | on | on |
| `print.started` | Print started | on | off |
| `print.first-layer` | First layer down | on | off |
| `print.milestone` | Progress updates | on | off |
| `print.paused` | Print paused | on | on |
| `print.done` | Print done | on | on |
| `print.failed` | Print failed | on | on |
| `print.not-started` | Print didn't start | on | on |
| `print.cancelled` | Print stopped | on | off |
| `print.unreachable` | Lost contact with the printer | on | off |
| `print.sent` | Sent to a printer Counterpart can't follow | on | off |
| `mcp.update.done` | Printer software updated | on | off |
| `mcp.update.failed` | Printer software update failed | on | on |

`plate.blocked` has no switch: it is not emitted (ac44431). The companion returns every type with its current value, filling in defaults, so a client never has to know the defaults to render the switches. `devices` lists only paired devices; removing a device drops its switches.

### `ai`

`{revision, choice, check?}`: the existing model-access record ([local-control.md](local-control.md) `modelAccess.*`).

- `choice` is `{kind: "none"}`, `{kind: "claude-code"}`, `{kind: "codex-cli"}`, `{kind: "api", provider: "anthropic"|"openai", model, keychainRef}` or `{kind: "endpoint", url, model, keychainRef?}`.
- Labels: `none` "Off", `claude-code` "Claude Code (your login)", `codex-cli` "Codex (your login)", `api` "API key", `endpoint` "Your own endpoint".
- `check` is the latest Test: `state` `checking`, `connected`, `failed` or `skipped`, with `outcome` when not connected. `outcome: "needs-gui-session"` means the sign-in has to finish on the Mac: the phone shows "Finish signing in on *Mac name*", and the Mac app opens the sign-in window itself when it sees that check.
- **Changing it:** `PATCH {ai: {expectedRevision, choice}}`. A stale `expectedRevision` is 409 ("AI was changed on another device. Look again."). From the phone, only `none`, `claude-code` and `codex-cli` can be chosen; `api` and `endpoint` need a key in the Mac's Keychain, so they are 409 "Choose this on *Mac name*: it needs the key in the Mac's Keychain." After a change, run Test.

### `fusion`

`{state, message, version?}` (read-only), from the printer MCP's `fusion_mcp_status` (PRD §8.9):

| `state` | Meaning | `message` (show as is) |
|---|---|---|
| `not-set-up` | the add-in or the `FUSION_MCP_*` variables are missing | "Not set up. Set Up installs the Fusion add-in." |
| `not-running` | set up, Fusion isn't open | "Set up. Fusion opens when a design needs it." |
| `connected` | the bridge answers | "Fusion is connected." |
| `setting-up` | Set Up is running on the Mac | "Setting up Fusion on *Mac name*…" |
| `unavailable` | the printer MCP has no Fusion bridge | "Update the printer MCP to design with Fusion." |

Set Up runs on the Mac (it installs an add-in and a LaunchAgent): `POST /v1/settings/fusion/setup` marks `setting-up` and emits `settings.changed` with `keys: ["fusion"]` and `action: "fusion.setup"`; the Mac app performs it and reports back with `fusion.setupDone {ok, message?}`.

## `SettingsPatch`

Any subset, deep-merged:

```jsonc
{
  "milestones": "25-50-75",
  "notifications": {"mac": {"print.milestone": true}, "devices": {"<deviceId>": {"print.started": false}}},
  "general": {"keepAwake": false},
  "ai": {"expectedRevision": "<uuid>", "choice": {"kind": "codex-cli"}}
}
```

- A phone may change `notifications.devices` only for its own `deviceId` (`X-Scan-Device`), plus `notifications.mac`; another device's id is 403.
- Unknown notification types are kept (a newer app's switch survives an older app's write); unknown top-level keys are 400.

## `settings.changed`

A passive event without `projectId` (events.md): `data: {keys: ["general.keepAwake", …], by: "mac" | "<deviceId>", action?: "fusion.setup"}`. `notify` is `none`. Read the new values with `settings.get` / `GET /v1/settings`. It is behind the same flag as the other events without a project until both apps decode them (see events.md).

## `Device` (`GET /v1/devices`)

`{deviceId, deviceName, scopes, pairedAt, lastRefreshedAt, expiresAt, pairedVia, model?, lastSeenAt?, legacy?, current?}`, the same as `devices.list`. `current: true` marks the calling phone. `legacy: true` marks a pairing from before stable install identity (the "Older pairings" section, [local-control.md](local-control.md) "Legacy devices"). **Remove All** in Older pairings is one `DELETE` per legacy device.
