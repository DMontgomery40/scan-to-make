# CloudKit: the phone's view of the Mac away from home

Counterpart for Mac mirrors projects and events into the user's own private CloudKit database, and runs the commands the phone writes back (PRD §8.8, §9.2, §9.3, §12). There is no server and no account: everything stays in the user's iCloud. The Mac side is `apps/mac/App/CloudSync.swift` and `EventRelay.swift`.

| | |
|---|---|
| Container | `iCloud.com.scantomake.counterpart` |
| Database | private |
| Zone | `Counterpart` (owner: the current user). The Mac creates it on its first save. |

Delivery depends on the Mac app running (PRD §8.8). After a restart the Mac writes every missed event record; it notifies on the Mac only for events from the last ten minutes, plus `print.done`, `print.failed`, `pass.ready` and `pass.ask` that still stand, once each.

## `CounterpartEvent` (the Mac writes)

`recordName` is the event's id. One record per companion event whose `notify` is not `none`, including catch-up after a restart (`print.sent` is passive, so it is written too). A record iCloud refuses waits in a queue on the Mac and is written again later.

| Field | Type | Notes |
|---|---|---|
| `eventId` | String | the event's uuid |
| `seq` | Int | the companion log's sequence number |
| `type` | String | `pass.ready`, `print.done`, … (docs/protocols/events.md) |
| `projectId` | String | |
| `printId` | String? | |
| `title` | String | written by the companion for every surface |
| `body` | String | |
| `notify` | String | `passive`, `active` or `timeSensitive` |
| `progress` | Double? | 0–100 |
| `remainingSec` | Double? | |
| `confirmationId` | String? | `print.confirm`: the question's id, for `confirm` |
| `expiresAt` | Date? | `print.confirm`: when the question expires |
| `createdAt` | Date | when the event happened |
| `frame` | Asset? | a JPEG, at most 1280 px on its long edge and about 300 KB, made with ImageIO |

The Mac deletes its own event records 7 days after `createdAt` (a daily sweep over the records it wrote; it needs no query index).

## `CounterpartProject` (the Mac writes)

`recordName` is the project's id. Upserted on every event for that project (a print's upserts at most once a minute unless its state or the printer's state changes), in full when delivery starts for the first time, and in full after the event log was pruned or recreated.

| Field | Type | Notes |
|---|---|---|
| `projectId` | String | |
| `title` | String | |
| `state` | String | the PRD §4 stage, as CounterpartKit's `ProjectPhase` and the companion's `status.phase` spell it: `draft`, `sending`, `working`, `needs-you`, `ready`, `preparing`, `printing`, `printed`, `sent`, `failed`, `unknown` |
| `stateText` | String | the status line, e.g. "Printing on P1S · 42% · 38 min left" |
| `updatedAt` | Date | |
| `openAsk` | String? | the question while the project needs the person |
| `confirmationId` | String? | the printer MCP's pending question (`printConfirmation.id`); cleared once it is answered or gone. `confirm` must carry this exact id |
| `confirmationMessage` | String? | its message, shown as is |
| `confirmationExpiresAt` | Date? | after this the Mac refuses an answer |
| `confirmationSupported` | Int64? | 1 when it can be accepted; 0 means decline or cancel only |
| `confirmationFields` | String? | JSON `[{name, title, description?, required}]`; an accept sets every required one to `true` in `answer.content` |
| `printId` | String? | |
| `printerName` | String? | |
| `printState` | String? | the printer's state (`printing`, `paused`, …) |
| `progress` | Double? | 0–100 |
| `remainingSec` | Double? | |
| `endsAt` | Date? | |
| `thumbnail` | Asset? | a JPEG of the first render, sent only when it changes. Saved with `.changedKeys`, so the last one stays in place. |

## `CounterpartDevice` (the phone writes)

The phone's Live Activity tokens when it isn't on the LAN (PRD §8.8). On the LAN they go to the companion instead (`POST /v1/devices/live-activity-tokens`). The Mac reads both and sends each push through the relay; tokens never go anywhere else.

| Field | Type | Notes |
|---|---|---|
| `deviceId` | String | the paired device's id; also the `recordName` |
| `pushToStartToken` | String? | hex, from `Activity<PrintAttributes>.pushToStartTokenUpdates` |
| `activityTokens` | [String] | `"<printId>:<hex token>"` for each running activity (`activity.pushTokenUpdates`); remove an entry when its activity ends |

The phone overwrites its one record whenever a token changes. The Mac reads it through the same zone changes as commands.

## `CounterpartCommand` (the phone writes)

Written by the phone when it can't reach the Mac directly (PRD §9.3). There is no plate command: plate-clearance prompts were removed (main `ac44431`); the printer MCP's own confirmation, answered with `confirm`, is the check.

| Field | Type | Notes |
|---|---|---|
| `type` | String | `print`, `correct`, `answerAsk`, `confirm`, `pause`, `resume`, `cancel` |
| `projectId` | String | |
| `payload` | String | a JSON **string**, by type (below) |
| `photos` | [Asset]? | for `correct` and `answerAsk` |
| `status` | String? | the Mac writes `running`, then `done` or `failed` |
| `message` | String? | the Mac's sentence for the person |

`payload` by `type`:

| `type` | `payload` | Control method the Mac runs |
|---|---|---|
| `print` | `{quality?, strength?, colour?, checked?}`. A companion without `capabilities.printSettings` gets only `checked`; anything other than standard quality and strength or `colour: {auto: true}` is refused with `failed`, never printed at other settings | `objects.print` |
| `correct` | `{note}`, plus `photos` | `objects.correct` |
| `answerAsk` | `{bestGuess?, text?}`; photos answer it with `bestGuess: false` | `objects.answerCloseup` |
| `confirm` | `{confirmationId, answer: {action, content?}}` | `objects.answerPrintConfirmation` |
| `pause`, `resume`, `cancel` | `{}` | `objects.pausePrint`, `objects.resumePrint`, `objects.cancelPrint` |

How the Mac handles a command:
- Each command runs apart from the reader and from the others, so a `pause` waiting on the printer's confirmation doesn't hold back the `confirm` that answers it. Its results are written in order by one writer.
- It finds new commands with `recordZoneChanges` (a change token it keeps), on launch, on wake, and on the content-available push from its `CKRecordZoneSubscription` `mac-zone`. No query index is needed.
- It judges freshness by the server's `creationDate`, never a time the phone wrote: older than 10 minutes, it writes `failed` without running it.
- It writes `status: "running"` before it runs, then `done` or `failed` with a `message`, on the same record. A result iCloud doesn't take is kept and written again later; the command is never run twice.
- `answerAsk` and `correct` photos are added to the project before the pass resumes. A typed `answerAsk` goes only to a companion with `capabilities.structuredPasses`.
- Every CloudKit write checks each record's own result, not only the request's: a record iCloud refused stays queued.
- A deadline after sending has an unknown outcome: the Mac writes `failed` and never runs the command again.
- It deletes the record a day later.

## Schema

- **`type` on `CounterpartEvent` must be Queryable.** The phone's `CKQuerySubscription`s (PRD §9.2) filter on it.
- Development builds create record types as they first save. Production needs the schema deployed.

## Before the first production deploy

1. In CloudKit Console, open `iCloud.com.scantomake.counterpart` → Development and check that `CounterpartEvent`, `CounterpartProject` and `CounterpartCommand` exist with the fields above (save one of each from a development build if any is missing).
2. Add a **Queryable** index on `CounterpartEvent.type`.
3. **Deploy Schema Changes** to Production. Developer ID and App Store builds use production (PRD §8.8).
4. Sign the Mac app with its iCloud entitlement (`STM_ENTITLEMENTS_SUFFIX=+CloudKit`) and `STM_APS_ENVIRONMENT=production`, so command pushes reach it.
5. On a Mac and a phone signed in to the same iCloud account: a print event appears as a `CounterpartEvent`, the project as a `CounterpartProject`, and a `pause` command written from the phone comes back `done`.
