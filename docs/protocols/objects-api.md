# Objects API (phone, HTTPS)

The iPhone and iPad app reach the Mac companion over the existing pairing (pinned key, addresses in order, `Authorization: Bearer <token>` plus `X-Scan-Device: <deviceId>`). This document lists every `/v1/objects`, `/v1/events`, `/v1/settings` and `/v1/devices` route, the object fields they return, and which KAN-214 pull request adds each new one. The Mac app reaches the same operations through the control socket ([local-control.md](local-control.md)). Events, their words and the long poll are in [events.md](events.md).

Wire types are zod schemas in `packages/contracts/src/counterpart.ts` (`@scan-to-make/contracts/counterpart`). Sample JSON for every event and response type is in `packages/contracts/fixtures/counterpart-v1.json`; decode tests should use it.

**Compatibility rules for clients.** Ignore unknown keys. Decode an unknown enum value (an object `state`, an event `type`, a stage id) as "unknown" without failing the whole response. All times are Unix milliseconds (`…Ms`) or ISO 8601 strings with an offset (`…At`); the field name says which.

**Errors.** `{error: {code, message}}` with HTTP status: 400 `invalid-request` / `invalid-name`, 401/403 from pairing, 404 `not-found`, 405 `method-not-allowed`, 409 `invalid-state` (the `message` is a sentence written for the person: show it), 413 `too-large`, 503 `unavailable` (a printer or camera that can't be reached right now: retry later).

**Scopes.** Every paired phone has these (`PHONE_SCOPES`); no new scope is added, so existing pairings keep working.

| Name in this doc | Scope |
|---|---|
| READ | `projects:read` (the PRD calls it `objects:read`) |
| WRITE | `captures:import` |
| SETTINGS | `projects:write` |
| PRINT | `printer-handoff:use` |

**Status.** "PR 1" to "PR 4" mark the KAN-214 pull request that adds a route or field; the rest exists on `main`. Until a PR merges, its routes return 404 and its fields are absent. `status.get` on the control socket reports the matching capability flags (local-control.md).

## Headers the phone sends

| Header | Value | Status |
|---|---|---|
| `X-Scan-Device-Model` | The hardware identifier, `^[A-Za-z0-9,._ -]{1,64}$` (for example `iPhone18,2`). Optional on every request. The Mac's device list shows it (`devices.list` `model`). Older companions ignore it. | PR 3 |

## Projects

| Method and path | Scope | Body | Reply |
|---|---|---|---|
| `GET /v1/objects` | READ | | `{objects: Object[]}`, newest first |
| `POST /v1/objects` | WRITE | `{instructions?: string ≤ 8000, kind?: "fit"\|"copy"}` (`kind` PR 4) | 201 `{object}` |
| `GET /v1/objects/<id>` | READ | | `{object}` |
| `PATCH /v1/objects/<id>` | WRITE | `{instructions}`; only while `state` is `new` | `{object}` |
| `DELETE /v1/objects/<id>` | WRITE | | `{deleted: true}`; 409 while a pass or print runs |
| `PUT /v1/objects/<id>/scan` | WRITE | The scan's bytes (≤ 64 MiB). Optional `?name=scan.usdz\|scan.stl\|scan.3mf` (PR 1; default `scan.usdz`) | `{object}`; only while `state` is `new` |
| `POST /v1/objects/<id>/photos?name=<file>` | WRITE | JPEG, PNG or HEIC bytes (≤ 25 MiB) | `{object}`. From PR 1 photos are accepted in every state except while the project is being deleted; photos added after a pass started are used by the next pass ("late photos"). |
| `POST /v1/objects/<id>/capture?name=NNNN.heic`, `…/capture-depth?name=NNNN.depth.plist` | WRITE | In-hand capture frames | `{object}` |
| `POST /v1/objects/<id>/start` | WRITE | `{captureManifest?}` | `{object}` |
| `POST /v1/objects/<id>/corrections` | WRITE | `{note: string 1–4000}`. Upload any new photos first with `…/photos`. | `{object}` (a new pass) |
| `POST /v1/objects/<id>/closeup` | WRITE | `{bestGuess?: boolean, text?: string ≤ 2000}` (`text` PR 4). Answers the open Ask: upload the photo first, then post `{}`; or `{bestGuess: true}`; or `{text}`. | `{object}` (a new pass) |
| `GET /v1/objects/<id>/passes/<n>/activity` | READ | | `{activity: [{atMs, kind: "message"\|"tool", text}]}` |
| `GET /v1/objects/<id>/model.stl`, `…/renders/<name>` | READ | | the file |
| `GET /v1/objects/<id>/photos/<name>`, `…/capture/<name>` | READ | | the image |
| `GET /v1/objects/<id>/asks/<askId>.jpg` | READ | | The Ask's picture (PR 4). Draw `ask.region` over it. |

## Printing

| Method and path | Scope | Body | Reply |
|---|---|---|---|
| `GET /v1/objects/printers` | READ | | `{defaultDestinationId, destinations: PrinterDestination[]}`. From PR 1 each destination may carry `origin`, `state`, `stateCheckedAt` and `capabilities` (below). |
| `GET /v1/objects/printers/<destinationId>/camera.jpg` | PRINT | | A JPEG from that printer's camera (PR 2), shared 3 s cache. 404 when the destination has no camera; 503 when the camera is busy or unreachable. Header `X-Captured-At` (ISO). |
| `POST /v1/objects/<id>/printer` | PRINT | `{destinationId}` | `{object}` |
| `GET /v1/objects/<id>/filaments` | PRINT | | `{filaments: [{slot, colour, material, name, filamentId, destinationId, suggested?}]}` for the project's printer. `suggested: true` (PR 2) marks the one preselected tray. |
| `POST /v1/objects/<id>/estimate` | PRINT | `{destinationId?, quality?, strength?}` (PR 2) | `PrintEstimate` (below), unwrapped. Slices through the printer's MCP; can take up to 150 s. |
| `POST /v1/objects/<id>/print` | PRINT | `{checked?, filament?, quality?, strength?, colour?}` (settings PR 2) | `{object}` with `state: "printing"` |
| `POST /v1/objects/<id>/print-confirmation` | PRINT | `{confirmationId, answer: {action: "accept", content: {<field>: boolean}} \| {action: "decline"\|"cancel"}}` | `{object}` |
| `POST /v1/objects/<id>/plate` | PRINT | `{clear: true}` | Always 409: a clear plate alone never approves a print (unchanged from `main`). Answer `…/print-confirmation` instead. |
| `GET /v1/objects/<id>/plate.jpg` | PRINT | | The frame the plate check judged |
| `GET /v1/objects/<id>/camera.jpg` | PRINT | | A JPEG from the camera of the printer this project is printing on, or its chosen printer (PR 2). Same cache, codes and header as the printer camera route. |
| `POST /v1/objects/<id>/print/pause`, `…/print/resume`, `…/print/cancel` | PRINT | `{}` | `{object}` (PR 2). 409 when nothing of this project's is printing, or the MCP lacks the tool. The MCP's own confirmation, if it asks, arrives as `printConfirmation` exactly as for Print. The app asks "Stop the print?" before posting cancel. |
| `GET /v1/objects/<id>/prints/<printId>/frames/<eventId>.jpg` | READ | | An event's camera frame (PR 3); the event's `frame` field gives the path. |

### Print settings (PR 2)

`POST …/print` and `objects.print` take these, all optional (`PrintSettingsSchema`):

| Field | Values | What the companion sends to the printer MCP |
|---|---|---|
| `quality` | `draft`, `standard` (default), `fine` | `slice_stl` `layer_height`: draft 0.28 mm, fine 0.12 mm for a 0.4 mm nozzle, scaled by nozzle ÷ 0.4 for another configured nozzle size and rounded to 0.01 mm. **Standard sends nothing: the MCP's own preset decides** (0.20 mm on its 0.4 mm presets). |
| `strength` | `standard` (default), `strong`, `max` | `slice_stl` `wall_loops` and `sparse_infill_density`: strong 4 and `"25%"`, max 6 and `"40%"`. Standard sends nothing (the preset's own, 2 and 15% on Bambu's standard presets). |
| `colour` | omitted, `{auto: true}`, `{amsSlot: n}`, `{external: true}`, `{material: "PETG"}` | Omitted: the MCP's own defaults, as today. `auto`: `print_3mf` `use_ams: true, auto_match_ams: true` (the user kept the preselection). `amsSlot`: the slot must be a loaded tray in the live filament list; `use_ams: true, ams_slots: [n], auto_match_ams: false`, and `slice_stl` `load_filaments` with that tray's profile and `filament_colours`. `external`: `use_ams: false`. `material` (generic printers): `upload_gcode` `material`, and `slice_stl` `load_filaments` when the MCP's filament list gives a profile for it. |

`filament` (the full tray identity, as today) is still accepted; send either `filament` or `colour`, not both (400).

A non-standard `quality` or `strength` the destination's MCP can't apply (its `slice_stl` schema lacks the argument) is refused with 409 and a sentence naming the update, never silently printed at preset values. `capabilities.quality` / `capabilities.strength` say beforehand which the print sheet can offer.

### `PrintEstimate` (PR 2)

`{destinationId, quality, strength, seconds?, grams?, layers?, layerHeightMm?, infillPercent?, wallLoops?, slicedAt}`. The companion lays the model flat and slices it with exactly the settings a Print with the same values would use, then reads time and grams from the sliced file (`Metadata/slice_info.config`), and layer height, infill and walls from its settings (`Metadata/project_settings.config`, or the G-code header for G-code output). It never prints. Results are cached per model, destination and settings until the model changes; identical concurrent requests share one slice. A new pass (new model) discards the cache.

### `PrinterDestination` (PR 1)

`{id, name, backend, model?, address?, source, origin?, state?, stateCheckedAt?, capabilities?}`.

- **One printer, one destination.** Destinations are keyed by the Bambu serial when the MCP config has one (`BAMBU_PRINTER_SERIAL` or `BAMBU_SERIAL`), otherwise by the lowercased `host:port`. A printer configured in several clients or in both MCPs appears once.
- **Which MCP wins.** A Bambu printer uses bambu-printer-mcp; mcp-3D-printer-server is used for a Bambu printer only when no bambu-printer-mcp profile reaches it. Every other printer uses mcp-3D-printer-server. Among profiles that reach the same printer through the same MCP, the Mac app's own `printer-handoff.json` (`source: "current"`) wins, then the first source in this order: Claude Code, Claude Desktop, Cursor, Codemode, Codex.
- **Ids are stable.** `current` is the Mac app's own configuration. Every other id is `mcp-` plus a hash of the config file and profile name. When `current` and another profile reach the same printer and the other wins, `defaultDestinationId` names the winner, and `current` is left out of the list but still resolves for projects that already chose it.
- `origin`: `printer-handoff`, `claude-code`, `claude-desktop`, `cursor`, `codemode` or `codex`.
- `state`: `ready` (idle, finished, failed or cancelled), `busy` (preparing, printing, paused or busy), `offline`, or `unknown`; `stateCheckedAt` is when it was read. A list request returns the last known value at once and starts a background read for each destination not read in the last 30 s, so a Printers screen that polls every 10 s sees it fill in.
- `capabilities` (`PrinterCapabilitiesSchema`) are absent until that destination's MCP has connected once since the companion started (the first background read connects it). They come from the MCP's `initialize` reply and its tool list, plus `counterpart_printer_info` when it exists:

| Field | True when |
|---|---|
| `progress` | `counterpart_print_progress` exists, or the MCP is bambu-printer-mcp (its `get_printer_status` has progress). mcp-3D-printer-server's `get_printer_status` has no job progress. |
| `layers` | as `progress`, and the printer reports layers (`counterpart_printer_info`) |
| `camera` | `counterpart_printer_info`'s value; otherwise `bambu-tcp` (or `rtsp` for X1, P2S, H2 and X2D models) when bambu-printer-mcp has `camera_snapshot`, else `none` |
| `filaments` | `counterpart_printer_info`'s value; otherwise `ams` when bambu-printer-mcp has `get_printer_filaments`, `single` when mcp-3D-printer-server has it, else `none` |
| `pause`, `resume`, `cancel` | the tool exists (and `counterpart_printer_info` doesn't say the firmware can't) |
| `quality` | `slice_stl` takes `layer_height` |
| `strength` | `slice_stl` takes `wall_loops` and `sparse_infill_density` |
| `multiColour` | `counterpart_make_3mf` exists |

`missing` lists what this install's version lacks (not what the hardware lacks), and `update.message` says which update unlocks it, for example "Update mcp-3D-printer-server to see progress and camera." `update.command` is the package-manager command for how that MCP is installed (`["npm","install","-g","bambu-printer-mcp@latest"]` for a global npm install); it is absent for an `npx` profile (npx fetches the latest itself; restarting Counterpart is enough) and for a source checkout. The companion never runs it; the Mac app's Update button does.

## Project fields

`Object` is the companion's `StmObject` (`services/companion/src/objects/store.ts`) minus internal paths. Fields added by KAN-214:

| Field | Type | Status |
|---|---|---|
| `status` | `ObjectStatus` `{phase, text, symbol, tint}`: the PRD §4 state line, written by the companion. Show `text` as is. `phase` is `sending`, `working`, `needs-you`, `ready`, `preparing`, `printing`, `printed`, `failed` or `sent` (symbol `paperplane`, tint `secondary`). | PR 3 |
| `title` | The short title ("Mic mount"). Always a string: generated at the first pass, and for a project from before titles the first time it is listed (once, in the background, then saved). Until then it is the request's first six words ("A mount for my mic stand…"), or "Your scan" / "Your project" without a request. | PR 4 |
| `kind` | `fit` (make something that fits) or `copy` (copy an object). Set at creation (send it: the phone's New flow knows which job it is), else from the first pass: a project with a scan or a handheld capture is a `copy` even with a request ("Copy this. Close up the bottom."), and a request with photos alone is a `fit`. A copy is always cleaned up in Blender; a design uses Fusion when the printer MCP's `fusion_mcp_status` reports it connected and a new design opens, else Blender. | PR 4 |
| `ask` | `Ask` `{id, question, photo?, region?, answers, status, askedAtMs}` while `state` is `needs-closeup` (and kept, `status: "answered"`, after). The old `question.closeup` is still set for older apps. | PR 4 |
| `current.changes` | `[{tag: "added"\|"changed"\|"assumed"\|"estimated", text, toleranceMm?}]`: the what-changed list | PR 4 |
| `current.engine` | `blender` or `fusion` | PR 4 |
| `current.design` | `{f3d, parameters}` paths (relative) when the engine was Fusion | PR 4 |
| `passes[].trigger` | `new`, `changes`, `late-photos` or `ask-answer` | PR 4 |
| `passes[].stages` | `[{id, words, startedAtMs, endedAtMs?, typicalSec}]` (`id`: `building`, `preparing`, `working`, `saving`) | PR 4 |
| `passes[].estimate` | `{remainingSec, endsAtMs}` while the pass runs | PR 4 |
| `passes[].engine` | `blender` or `fusion` | PR 4 |
| `passes[].engineNote` | Why a design pass used Blender when Fusion was wanted ("Fusion couldn't open a new design: …") | PR 4 |
| `print.printId` | A uuid per dispatched print | PR 2 |
| `print.destinationId` | The destination it was sent to (same as `print.destination.id`) | PR 2 |
| `print.fileBase` | Set when the dispatch returned no job identity: the name a job is adopted by | PR 2 |
| `print.sentVia` | `bambu-connect` when the print was handed to Bambu Connect | PR 2 |
| `print.dispatchedAt` | ISO; when the printer MCP accepted the print | PR 2 |
| `print.jobName` | The job name the printer reports for it | PR 2 |
| `print.taskId` | The printer's task id, when the MCP returns one | PR 2 |
| `print.settings` | The `PrintSettings` it was printed with | PR 2 |
| `print.live` | `PrintLive`: the latest normalized printer report for this print (state, job progress, layer, time left, `endsAt`, temperatures, active filament, problems). Replaces reading `printerStatus` once present. | PR 2 |
| `print.monitor` | `PrintMonitor` `{phase: starting\|watching\|ended, startedAt, lastReportAt?, milestonesSent, firstLayerSent, unreachableSince?, endState?, endedAt?}` | PR 2 |

`print.printerStatus` (`{state, job?, checkedAtMs, percent?, remainingMinutes?}`) is kept for older apps; from PR 2 it is derived from `print.live`.

### What `state` means while printing (PR 2)

"Printed" now means printed. `state` stays `printing` from Print until the printer reports the end of this exact job:

| Moment | `state` | `status.phase` | Other fields |
|---|---|---|---|
| Print tapped: slicing, checking, waiting for the MCP's confirmation | `printing` | `preparing` | `progress` (words), `print.events` |
| The MCP accepted the print | `printing` | `preparing` until the printer reports it, then `printing` | `print.printId`, `dispatchedAt`, `jobName`, `taskId?`, `estimate`, `monitor.phase: "starting"` |
| The printer reports our job preparing or printing | `printing` | `printing` | `monitor.phase: "watching"`, `print.live` |
| Paused | `printing` | `printing` (text says Paused) | `print.live.state: "paused"` |
| Finished | `printed` | `printed` | `monitor.endState: "done"` |
| Failed | `failed` | `failed` | `failure` is the printer's problem message; `monitor.endState: "failed"` |
| Cancelled (from the app or the printer) | `ready` | `ready` | `monitor.endState: "cancelled"`; Print is offered again |
| Never started within 180 s | `failed` | `failed` | `failure`: "*Printer* didn't start *title*. Nothing was sent twice." `monitor.endState: "not-started"`. `print.uncertain` is cleared, so Print works again without `checked`. |
| A different job is running | `failed` | `failed` | `failure`: "*Printer* is printing something else." `monitor.endState: "replaced"`; never reported as ours. |
| Lost contact | `printing` | `printing` | `monitor.unreachableSince`; the monitor keeps trying. |
| The printer has it, but Counterpart can't follow it (below) | `sent` | `sent` | `print.uncertain: true` (Print needs `checked: true`); `monitor.endState: "sent"` when a monitor was waiting to adopt it; `print.sentVia: "bambu-connect"` for Bambu Connect |

**A print the companion can't follow: `sent`.** Never success without evidence (PRD §2.6). The new object `state` `sent` (and status phase `sent`) means the printer MCP accepted the print but Counterpart can't confirm it printed:
- An mcp-3D-printer-server install without `counterpart_print_progress` (`capabilities.progress` false) can't say which job is printing: `sent` at once.
- Bambu Connect only opens the job on the Mac: `sent` at once, with `print.sentVia: "bambu-connect"`; its status reads "Finish on your Mac: press Print in Bambu Connect".
- Routes that return neither a task id nor a job name (a pre-sliced `.gcode.3mf` on P1, X1 and A1 mini; X2D native; BambuNetwork when it omits `printerJobName`): the monitor starts as usual with `print.fileBase` (the sliced file's name without its extension). The first report within 180 s of a job whose name equals it, or ends with `-` or `_` and it, is adopted (`print.jobName` is set) and watched normally. Otherwise the print ends `sent`, never `not-started`: not seeing an unnamed job proves nothing.

A `sent` print raises one `print.sent` event (passive) and no first-layer, milestone or done events. Its status line is "Sent to *printer* · Counterpart can't follow this print". Older apps that don't know `sent` decode it as an unknown state.

After a companion restart, a print whose monitor is `starting` or `watching` resumes watching (no milestone is sent twice and missed ones are not back-filled; the end state is still delivered). A print that was still being prepared is marked `failed` ("interrupted when your Mac restarted the app"); if it had reached the dispatch step, `print.uncertain` is set and Print needs `checked: true`.

## Settings (PR 2)

| Method and path | Scope | Body | Reply |
|---|---|---|---|
| `GET /v1/settings` | READ | | `{settings: {milestones}}` |
| `PATCH /v1/settings` | SETTINGS | `{milestones: "off"\|"50"\|"25-50-75"\|"every-10"}` | `{settings}` |

`milestones` (default `"50"`) chooses which `print.milestone` events the companion emits; it is read at each report, so a change applies to prints already running. The per-event notification switches stay on each device.

## Devices (PR 3)

| Method and path | Scope | Body | Reply |
|---|---|---|---|
| `POST /v1/devices/live-activity-tokens` | SETTINGS | `{pushToStart?: hex, activity?: {printId, token: hex \| null}}`, at least one (`LiveActivityTokenUploadSchema`) | `{stored: true}` |

Tokens are stored for the calling device (`X-Scan-Device`) in `<data root>/live-activity-tokens.json` (mode 0600), never sent anywhere by the companion, and read by the Mac app with `liveActivity.tokens`. `pushToStart` replaces the device's push-to-start token. `activity.token` adds or replaces that print's update token; `null` forgets it (the activity ended on the phone). Activity tokens are also dropped 7 days after they were stored, and all of a device's tokens go when the device is removed. Re-pairing the same installation keeps its `deviceId` (the installation key), so its tokens stay attached.

## Events (PR 3)

`GET /v1/events?after=<seq>&wait=<0–25>&limit=<0–500>` (READ). See [events.md](events.md).
