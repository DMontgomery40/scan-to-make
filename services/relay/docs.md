# Relay client contract (for the Mac app's `EventRelay`)

This is the contract between Counterpart for Mac and the Live Activity relay ([PRD §8.8](../../docs/design/overhaul/PRD.md#88-delivery-mac-cloudkit-and-the-live-activity-relay), §9.4). The validator in `src/contract.ts` implements it, and the two must change together.

## Request

```
POST https://counterpart.dtmont.com/relay/v1/live-activity
Content-Type: application/json
```

- The body is at most 8 KiB.
- There is no authentication header in v1. The PRD's threat model is that only the user's own devices know a Live Activity token.
- One request sends one push.

| Field | Type | Rule |
|---|---|---|
| `token` | string | The push token as hex: `token.map { String(format: "%02x", $0) }.joined()`. Even length, 32–512 hex digits, any case. |
| `kind` | `"start"` \| `"update"` \| `"end"` | |
| `attributes` | `PrintAttributes` | **Required** for `start`. **Not allowed** otherwise. |
| `contentState` | `PrintAttributes.ContentState` | Always required. |
| `staleDate` | integer, **Unix seconds** | **Required** for `start` and `update`; PRD: `endsAt` + 10 min. Optional for `end`: leave it out, so a finished activity never shows "Checking…". Must be within 1 day before and 30 days after now. |
| `priority` | `5` \| `10` | Sent as `apns-priority`. See "When to send". |
| `alert` | `{title, body, sound?}` | **Required** for `start`, because Apple requires an alert to start a Live Activity. Optional otherwise. |

**`PrintAttributes`**

| Field | Rule |
|---|---|
| `projectId` | 1–128 of `A–Z a–z 0–9 . _ : -` (a UUID fits) |
| `printId` | 1–128 of `A–Z a–z 0–9 . _ : -` |
| `title` | 1–80 characters |
| `printerName` | 1–80 characters |

**`PrintAttributes.ContentState`**

| Field | Rule |
|---|---|
| `state` | One of the counterpart/1 states: `idle`, `preparing`, `printing`, `paused`, `finished`, `failed`, `cancelled`, `offline`, `busy` |
| `progress` | A number, 0–100, as in counterpart/1 |
| `layer` | An integer, 0–10,000,000. **0 when the printer doesn't report layers.** |
| `totalLayers` | An integer, 0–10,000,000. **0 when the printer doesn't report layers** (OctoPrint, PrusaLink and Repetier, per §8.4). |
| `endsAt` | A number: **seconds since 2001-01-01T00:00:00Z**, which is how Swift's default `Codable` encodes `Date`. Must be within 1 day before and 30 days after now. |
| `stage` | 0–80 characters. **`""` when the printer reports no stage.** |
| `problem` | Optional, 1–200 characters. Leave it out when there's no problem. |

**`alert`**

| Field | Rule |
|---|---|
| `title`, `body` | Plain strings, 200 characters together. `title` is at least 1. |
| `sound` | Optional; only `"default"` |

**Rules for every string and object:**
- "Characters" means Unicode scalars: Swift's `string.unicodeScalars.count`.
- Strings may not contain control characters such as newlines.
- Every object rejects keys it doesn't list. `null` is never accepted, so Swift optionals must be left out (the synthesized `Encodable` already does that).

### Two clocks in one request

ActivityKit decodes `content-state` with the default `JSONDecoder` strategies. So `endsAt` must be what `JSONEncoder()` produces for a `Date`: seconds since 2001-01-01. `staleDate`, like APNs' own dates, is Unix seconds. The two differ by 978,307,200.

| Instant | `endsAt` (reference date) | `staleDate` (Unix) |
|---|---|---|
| 2026-11-01T13:00:00Z | `815230800` | `1793538000` |

The relay rejects an `endsAt` that looks like Unix seconds, and a `staleDate` that looks like reference-date seconds, with a message that says so. Otherwise the phone would silently show a date 31 years off.

### Swift shapes

`PrintAttributes` is shared by the phone and the Mac (CounterpartKit). Encode the request with a plain `JSONEncoder()`, and **never set a `dateEncodingStrategy`**.

```swift
import ActivityKit

struct PrintAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum State: String, Codable { case idle, preparing, printing, paused, finished, failed, cancelled, offline, busy }
        var state: State
        var progress: Double   // 0–100
        var layer: Int         // 0 when not reported
        var totalLayers: Int   // 0 when not reported
        var endsAt: Date       // default Codable: seconds since 2001-01-01
        var stage: String      // "" when not reported
        var problem: String?   // left out when nil
    }
    var projectId: String
    var printId: String
    var title: String
    var printerName: String
}

struct LiveActivityPush: Encodable {
    enum Kind: String, Encodable { case start, update, end }
    struct Alert: Encodable { var title: String; var body: String; var sound: String? }  // sound: "default" or nil
    var token: String                              // lowercase hex
    var kind: Kind
    var attributes: PrintAttributes?               // start only
    var contentState: PrintAttributes.ContentState
    var staleDate: Int?                            // Int(date.timeIntervalSince1970); start and update
    var priority: Int                              // 5 or 10
    var alert: Alert?                              // required for start
}
```

## When to send

Which token to use, from PRD §8.8:
- **`start`** uses the phone's push-to-start token, from `Activity<PrintAttributes>.pushToStartTokenUpdates`.
- **`update` and `end`** use that activity's own token, from `activity.pushTokenUpdates`.
  - The relay adds `"input-push-token": 1` to every start. On iOS 18 and later, that's what gives a push-started activity an update token.
  - The phone sends the new token to the Mac the same way as every other token.

| Event | `kind` | `priority` | `alert` |
|---|---|---|---|
| `print.started` | `start` | 10 | required, e.g. "*Title* is printing" |
| `print.status` | `update` | 5 | none |
| `print.resumed` | `update` | 5 | none |
| `print.paused` | `update` | 10 | optional, with the problem |
| `print.done` | `end` | 10 | optional |
| `print.failed` | `end` | 10 | optional |
| `print.cancelled` | `end` | 10 (§8.8 doesn't name it; 10 matches the other ends) | optional |

What the relay adds to each push:
- `timestamp` (now);
- `attributes-type: "PrintAttributes"`;
- `input-push-token` on a start;
- `dismissal-date` = timestamp + 4 hours on an end.

The headers are always `apns-push-type: liveactivity` and `apns-topic: com.scantomake.push-type.liveactivity`.

**One push in flight per token.**
- Keep only the newest content state waiting behind it, and send it when the current one finishes.
- The print monitor emits `print.status` about every 10 s, which is the per-token limit, so updates will sometimes be early. Coalescing absorbs that.

## Responses

Every response is JSON. Every response that tells the caller to wait carries a `Retry-After` header (seconds) and a matching `retryAfterSec` field.

| Status | Body | What the Mac does |
|---|---|---|
| `200` | `{ok: true, apnsId}` | Done. |
| `400` | `{error: "invalid_request", problems: ["path: message", …]}` or `{error: "invalid_json"}` | A bug in the request. Log `problems` and don't resend the same body. |
| `404`, `405`, `413`, `415` | `{error}` | A bug in the request: wrong path, method, size or content type. |
| `410` | `{error: "token_inactive", reason}` | The token is dead (APNs `410`, or `400 BadDeviceToken`; `reason: "denied"` when it's already on the 30-day deny list). Forget it. Stop pushing to that activity and let the phone update it itself. For a push-to-start token, wait for a new one from the phone. |
| `429` | `{error: "rate_limited", scope, retryAfterSec}` | Wait `Retry-After`, then send the **newest** state. **Never drop an `end` or a paused update**: resend it after the wait. |
| `502` | `{error: "apns_rejected", status, reason}` | APNs refused the push for a reason retrying won't fix. For example, `DeviceTokenNotForTopic` is a token from another app or environment. Log it and drop this push. |
| `503` | `{error: "not_configured", retryAfterSec: 3600}` | The relay has no APNs key yet. Use the phone-driven mode (§8.8, "Without the relay") and try again after an hour. |
| `503` | `{error: "apns_unavailable" \| "apns_unreachable" \| "apns_auth" \| "relay_unavailable", …}` | Wait `Retry-After` (60 s, or 900 s after an APNs 5xx as Apple advises), then send the newest state. |

`429` scopes:

| `scope` | Meaning | `Retry-After` |
|---|---|---|
| `token-interval` | Less than 10 s since the last push on this token | 1–10 s |
| `token-daily` | 2,000 pushes on this token today (UTC) | Until 00:00 UTC |
| `ip-daily` | 20,000 pushes from this network today | Until 00:00 UTC |
| `global-daily` | The relay's daily cap for everyone | Until 00:00 UTC |
| `apns` | APNs said `TooManyRequests` for this token | 60 s |

## Examples

Start, sent on `print.started`:

```json
{
  "token": "80b1…e4f2",
  "kind": "start",
  "attributes": {
    "projectId": "2f1d7c9e-1b7a-4c1e-9a55-7d0f0c3e8b21",
    "printId": "9b0e4a6c-3c51-4e0b-8f3a-1c2d3e4f5a6b",
    "title": "Desk hook",
    "printerName": "Bambu Lab P1S"
  },
  "contentState": { "state": "preparing", "progress": 0, "layer": 0, "totalLayers": 300, "endsAt": 815230800, "stage": "Heating the bed" },
  "staleDate": 1793538600,
  "priority": 10,
  "alert": { "title": "Desk hook is printing", "body": "On Bambu Lab P1S" }
}
```

What APNs receives, with `apns-priority: 10`:

```json
{
  "aps": {
    "timestamp": 1793534400,
    "event": "start",
    "content-state": { "state": "preparing", "progress": 0, "layer": 0, "totalLayers": 300, "endsAt": 815230800, "stage": "Heating the bed" },
    "stale-date": 1793538600,
    "attributes-type": "PrintAttributes",
    "attributes": { "projectId": "2f1d7c9e-1b7a-4c1e-9a55-7d0f0c3e8b21", "printId": "9b0e4a6c-3c51-4e0b-8f3a-1c2d3e4f5a6b", "title": "Desk hook", "printerName": "Bambu Lab P1S" },
    "input-push-token": 1,
    "alert": { "title": "Desk hook is printing", "body": "On Bambu Lab P1S" }
  }
}
```

Update, sent on `print.status`:

```json
{
  "token": "5c0d…91aa",
  "kind": "update",
  "contentState": { "state": "printing", "progress": 42.5, "layer": 120, "totalLayers": 300, "endsAt": 815230800, "stage": "Printing" },
  "staleDate": 1793538600,
  "priority": 5
}
```

End, sent on `print.done`. The relay adds `"dismissal-date"`, 4 hours after its timestamp:

```json
{
  "token": "5c0d…91aa",
  "kind": "end",
  "contentState": { "state": "finished", "progress": 100, "layer": 300, "totalLayers": 300, "endsAt": 815230800, "stage": "" },
  "priority": 10,
  "alert": { "title": "Desk hook is done", "body": "Take it off the plate.", "sound": "default" }
}
```

## Where this goes beyond the PRD's text

Each item is either Apple's requirement or the most literal workable reading of the PRD.
- **`input-push-token: 1` on `start`.** Apple: on iOS 18 and later, add it "to start a Live Activity and receive a new push token". Without it the Mac couldn't update a push-started activity.
- **`alert` is required on `start`.** Apple's start requirements: "Include an `alert` in the JSON payload."
- **`staleDate` is optional on `end`,** so an ended activity isn't marked stale.
- **0 and `""` for data a printer doesn't report.** §9.4 lists `layer`, `totalLayers` and `stage` as always present, while §8.4 says some firmwares omit them. Non-optional Swift fields with 0 and `""` satisfy both.
- **The 10 s spacing applies to every push on a token,** `end` included. The caller resends after `Retry-After`.
- **The caller's `priority` is sent as is.** The relay checks that it is 5 or 10 but doesn't derive it from the event. The table above gives the PRD's mapping, plus 10 for `print.cancelled`, which the PRD doesn't name.
- **The provider token is stored.** PRD §8.8 says the relay's "only state is rate-limit counters". The Durable Object also keeps the current APNs provider JWT, which expires within an hour.
  - That way every isolate shares one token, and a restart doesn't mint a new one sooner than Apple's 20-minute rule allows.
  - It is a credential the relay signs itself, not user data.
- **`APNS_ORIGIN` var.** It is unset in production. It allows only the APNs sandbox host or a loopback origin, for the smoke test.
