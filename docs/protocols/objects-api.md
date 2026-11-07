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

**Status.** "PR 1" to "PR 5" mark the KAN-214 pull request that adds a route or field; the rest exists on `main`. Until a PR merges, its routes return 404 and its fields are absent. `status.get` on the control socket reports the matching capability flags (local-control.md).

**What this companion supports.** `GET /healthz` (READ) replies `{status: "ok", protocolVersion: "0.1.0", capabilities: {genericConfirmations: true, materialChoice: true}}` from PR 5. `capabilities` is absent on older companions, so treat a missing flag as false. `name` (when present) is the Mac's name as people know it, its Computer Name ("Mac mini"), else its host name without `.local`: say "Mac mini connected" rather than "Your Mac". `genericConfirmations` means the printer questions below may carry text, number and choice fields, and `…/print-confirmation` takes those answers. Without it, show only yes/no questions and send booleans. `materialChoice` means `colour: {material}` is accepted ("What's loaded?", below). `printerChoices` means the printer connection and Printer MCP routes below exist (`GET`/`PUT …/printers/<id>/route`, `PUT …/printers/<id>/mcp`); without it, show neither picker.

`printerSettings` retains the earlier Android/phone capability for POST aliases of the printer routes; these aliases now require both PRINT and SETTINGS for changes, like PUT. The POST MCP reply also includes the refreshed printer catalog. `printLayerPauses` means Print and Estimate accept `pauseBeforeLayers`; also require the destination's `capabilities.layerPauses` before offering the control. Missing flags mean the older companion does not support these controls.

## Headers the phone sends

| Header | Value | Status |
|---|---|---|
| `X-Scan-Device-Model` | The hardware identifier, `^[A-Za-z0-9,._ -]{1,64}$` (for example `iPhone18,2`). Optional on every request. The Mac's device list shows it (`devices.list` `model`). Older companions ignore it. | PR 3 |
| `X-Scan-Device-Name` | The device's own name ("David’s iPhone"), UTF-8 percent-encoded (`encodeURIComponent`); raw UTF-8 is accepted too. Optional on every request. When it differs from the paired name, the companion saves it as the device's `deviceName` (control characters removed, cut to 64 characters). An empty or undecodable value is ignored and never replaces a name. | PR 5 |

## Projects

| Method and path | Scope | Body | Reply |
|---|---|---|---|
| `GET /v1/objects` | READ | | `{objects: Object[]}`, newest first |
| `POST /v1/objects` | WRITE | `{instructions?: string ≤ 8000, kind?: "fit"\|"copy"\|"published", url?: string ≤ 2048}` (`kind` PR 4; `published` and `url` PR 7). A `url` alone on a known model site makes the project `published` (below). | 201 `{object}` |
| `GET /v1/objects/<id>` | READ | | `{object}` |
| `PATCH /v1/objects/<id>` | WRITE | `{instructions}`; only while `state` is `new` | `{object}` |
| `DELETE /v1/objects/<id>` | WRITE | | `{deleted: true}`; 409 while a pass or print runs |
| `GET /v1/objects/<id>/settings` | READ | | `{settings: {status, archived, printerDestinationId?, printDefaults?, designEngine?, notifications?}}`. The `projectPreferences` capability advertises the saved defaults. |
| `PATCH /v1/objects/<id>/settings` | WRITE | `{title?, status?, archived?, printerDestinationId?: string \| null, printDefaults?: PrintSettings, designEngine?: "auto" \| "blender" \| "fusion", notifications?: "all" \| "problems"}`, at least one; unknown keys are 400 | `{settings, object}`. Status set by hand, any time (PRD §5.4). The path is `not-printed` → `printed` → `works` (shown as **Done**: "Done · it works", Done on Home); `needs-changes` branches off `printed`; `not-printed` makes the state `ready`. `archived` (PR 8b) is a separate flag (Hide from Home): the status underneath, and the state (`sent` included), stay exactly as they were and show again when it is unhidden. `status: "archived"` still works and sets the flag. 409 while a pass or print runs, or (for works/printed) before there is a model. Emits `project.updated` (`keys: ["status"]` or `["archived"]`). |
| `PUT /v1/objects/<id>/scan` | WRITE | The scan's bytes (≤ 64 MiB). Optional `?name=scan.usdz\|scan.stl\|scan.3mf` (PR 1; default `scan.usdz`) | `{object}`; only while `state` is `new` |
| `POST /v1/objects/<id>/photos?name=<file>` | WRITE | JPEG, PNG or HEIC bytes (≤ 25 MiB); optional `forMessage=true` query for a correction or Ask attachment. | `{object}`. Photos are accepted in every state except while the project is being deleted. Message attachments stay pending even if the initial pass fails during upload. Other photos added after an initial failure with no model join the request evidence for Try Again. |
| `POST /v1/objects/<id>/capture?name=NNNN.heic`, `…/capture-depth?name=NNNN.depth.plist` | WRITE | In-hand capture frames | `{object}` |
| `POST /v1/objects/<id>/start` | WRITE | `{captureManifest?}` | `{object}` |
| `POST /v1/objects/<id>/corrections` | WRITE | `{note: string 1–4000}`. Upload any new photos first with `…/photos`. | `{object}` (a new pass) |
| `POST /v1/objects/<id>/model?name=<file>` | WRITE | 3MF or STL bytes, ≤64 MiB; preserves the supplied original | `{object}` (ready or plate/file choice) |
| `POST /v1/objects/<id>/ask` | WRITE | `{askId, choices: [optionId]}` | `{object}` |
| `POST /v1/objects/<id>/closeup` | WRITE | `{bestGuess?: boolean, text?: string ≤ 2000, photoNames?: string[] ≤ 100}`. Answers the open Ask: upload photos first, then name those exact files in `photoNames`; or use `{bestGuess: true}` or `{text}`. Omitted names select no photos; queued correction evidence remains pending. Empty answers or missing photos are refused before consuming the Ask. | `{object}` (a new pass) |
| `GET /v1/objects/<id>/passes/<n>/activity` | READ | | `{activity: [{atMs, kind: "message"\|"tool", text}]}` |
| `GET /v1/objects/<id>/model.stl`, `…/renders/<name>` | READ | | the file |
| `GET /v1/objects/<id>/photos/<name>`, `…/capture/<name>` | READ | | the image |
| `GET /v1/objects/<id>/asks/<askId>.jpg` | READ | | The Ask's picture (PR 4). Draw `ask.region` over it. |

## Printing

| Method and path | Scope | Body | Reply |
|---|---|---|---|
| `GET /v1/objects/printers` | READ | | `{defaultDestinationId, destinations: PrinterDestination[]}`. Each destination may carry `aliases: string[]`: other opaque destination IDs the companion currently resolves to this same printer, including duplicates within one MCP and profiles reached through another MCP. Historical `print.destination.id` remains unchanged; match it against the listed ID and aliases when showing printer history. Omitted when there are no aliases. From PR 1 each destination may carry `origin`, `state`, `stateCheckedAt` and `capabilities` (below). |
| `GET /v1/objects/printers/<destinationId>/route` | PRINT | | `{route: PrintRoute \| null}`: how that printer's MCP reaches the printer, the MCP's own setting (`counterpart_print_route`, both MCPs; the Mac's `printers.route`). `null` when the MCP has no such choice. `PrintRoute` is `{route, mode, type, choices: [id], options?: [{id, label, available, reason?, controls?}], savedTo}`: show `options[].label` (fall back to the id), and `controls` under the choice. 404 for an unknown printer. Needs `capabilities.printerChoices`. |
| `PUT /v1/objects/printers/<destinationId>/route` | PRINT and SETTINGS | `{route}` (one of `choices`) | `{route: PrintRoute}` as the MCP saved it (in its own `.env`). 409 `invalid-state` while a project prints there or the printer was last read as printing ("This printer is printing. Change its connection when the print finishes."); 409 `not-supported` when the MCP has no choice. |
| `PUT /v1/objects/printers/<destinationId>/mcp` | PRINT and SETTINGS | `{backend: "bambu-printer-mcp" \| "mcp-3d-printer-server"}` | `{destinationId}`: which MCP a printer reached through both uses (`destination.mcps`; the Mac's `printers.chooseMcp`). The printer's id may change: read the printers again and use the returned id. 409 while it prints; 400 when that MCP doesn't reach it; 404 for an unknown printer; 503 when this companion can't change it. Needs `capabilities.printerChoices`. |
| `GET /v1/objects/printers/<destinationId>/camera.jpg` | PRINT | | A JPEG from that printer's camera (PR 2), shared 3 s cache. 404 when the destination has no camera; 503 when the camera is busy or unreachable. Header `X-Captured-At` (ISO), when the frame was taken. From PR 5 a frame up to 2 min old is returned at once while the next is fetched, so only a camera with no frame yet makes the request wait (below). |
| `POST /v1/objects/<id>/printer` | PRINT | `{destinationId}` | `{object}` |
| `GET /v1/objects/<id>/filaments` | PRINT | | `{filaments: [{slot, colour, material, name, filamentId, destinationId, suggested?}]}` for the project's printer. `suggested: true` (PR 2) marks the one preselected tray. |
| `POST /v1/objects/<id>/estimate` | PRINT | `{destinationId?, quality?, strength?}` (PR 2) | `PrintEstimate` (below), unwrapped. Slices through the printer's MCP; can take up to 150 s. `copies` (PR 8b, 1–64): time and grams cover every copy; refused with the update when the printer's MCP can't (`capabilities.copies`). |
| `POST /v1/objects/<id>/print` | PRINT | `{checked?, filament?, quality?, strength?, colour?, copies?, pauseBeforeLayers?}` (settings PR 2; `copies` PR 8b, 1–64, default 1) | `{object}` with `state: "printing"`. `copies`: that many on the plate (`slice_stl` `repetitions`), recorded in `print.settings`; 409 with the update when the MCP can't. `pauseBeforeLayers`: 1–16 layer numbers (each 2 or more, as in the slicer's preview); the printer stops before each and waits for Resume on the printer (`slice_stl` `pause_at_layers`). Offer it only when the destination's `capabilities.layerPauses` is true, and leave the key out when there are none (an empty list is 400; an older companion refuses the key). A Done project prints without `checked`. |
| `POST /v1/objects/<id>/print-confirmation` | PRINT | `{confirmationId, answer: {action: "accept", content: {<field>: boolean \| string \| number}} \| {action: "decline"\|"cancel"}}` (strings and numbers PR 5) | `{object}`. An answer that doesn't fit the question is 400 `invalid-request`, and `message` names the field and the reason (below). |
| `GET /v1/objects/<id>/camera.jpg` | PRINT | | A JPEG from the camera of the printer this project is printing on, or its chosen printer (PR 2). Same cache, codes and header as the printer camera route. |
| `POST /v1/objects/<id>/print/pause`, `…/print/resume`, `…/print/cancel` | PRINT | `{}` | `{object}` (PR 2). 409 when nothing of this project's is printing, or the MCP lacks the tool. The MCP's own confirmation, if it asks, arrives as `printConfirmation` exactly as for Print. The app asks "Stop the print?" before posting cancel. |
| `GET /v1/objects/<id>/prints/<printId>/frames/<eventId>.jpg` | READ | | An event's camera frame (PR 3); the event's `frame` field gives the path. |

`PrintRoute` is `{route, mode, type, choices: string[], options?: [{id, label, available, reason?, controls?}], savedTo?: string | null}`. Use the MCP's option labels, availability and control description; show unknown future ids as reported. Earlier MCPs report only `choices` (`lan`, `cloud`); their fallback labels are Local network and Bambu Cloud. Destination ids are `[A-Za-z0-9_-]{1,256}` and route ids are `[a-z][a-z0-9_-]{0,31}`. Mutations reject unknown fields and never accept a replacement `destinationId` in the body. These operations use existing pairing scopes, so no new pairing is needed.

### Saved Project Settings (`projectPreferences`)

Both clients use the same settings mutation (local control: `objects.settings.set`).
`printDefaults` replaces that defaults object; omitted fields in the replacement return to the printer profile.
Print and Estimate merge these defaults beneath explicit per-run choices. Explicit `quality: "standard"`,
`strength: "standard"`, and `copies: 1` override saved values. The print record retains an explicit one.
The print sheets show and send one copy when a destination lacks multiple-copy support. Changing the
physical printer clears the saved colour so a tray number cannot silently select a different printer's spool.
`printerDestinationId: null` selects the companion's default printer.

The next worker receives `designEngine`; Blender bypasses Fusion discovery and the Fusion lock.
Scanned copies always use Blender. Automatic/Fusion choices use the existing setup/availability fallback.
`notifications: "problems"` retains routine print events but gives them `notify: "none"`; printer questions,
pauses, failures, unreachable and sent-without-monitoring notices remain available. Device preferences
still apply. The Live Activity relay ends existing activities silently and does not push-start an activity
for a muted event, because push-to-start requires an alert.

`POST /v1/objects/<id>/duplicate` (WRITE; local `objects.duplicate`) returns `{object}`: a new ready,
not-printed, unarchived project with independent copies of the current model, renders and editable design,
its request, credit and defaults. It keeps legacy last-print settings when no saved defaults exist. It copies
no active job, Ask, pending message, print history or outcome. Missing source files remove only the partial copy.
A working pass must finish before duplication.

Read-authorized exports include `GET /v1/objects/<id>/scan/<name>` for the recorded original scan and
`GET /v1/objects/<id>/original/<index>` for a recorded `files.original` STL, 3MF or USDZ. Original/photo/scan
exports require a regular file canonically inside the project, reject external symlinks and cap downloads at
64 MiB. They never accept an arbitrary filesystem path. Existing model/photo/capture routes remain available.

### Print settings (PR 2)

`POST …/print` and `objects.print` take these, all optional (`PrintSettingsSchema`):

| Field | Values | What the companion sends to the printer MCP |
|---|---|---|
| `quality` | `draft`, `standard` (default), `fine` | `slice_stl` `layer_height`: draft 0.28 mm, fine 0.12 mm for a 0.4 mm nozzle, scaled by nozzle ÷ 0.4 for another configured nozzle size and rounded to 0.01 mm. **Standard sends nothing: the MCP's own preset decides** (0.20 mm on its 0.4 mm presets). |
| `strength` | `standard` (default), `strong`, `max` | `slice_stl` `wall_loops` and `sparse_infill_density`: strong 4 and `"25%"`, max 6 and `"40%"`. Standard sends nothing (the preset's own, 2 and 15% on Bambu's standard presets). |
| `colour` | omitted, `{auto: true}`, `{amsSlot: n}`, `{external: true}`, `{material: "PETG"}` | Omitted: the MCP's own defaults, as today. `auto`: `print_3mf` `use_ams: true, auto_match_ams: true` (the user kept the preselection). `amsSlot`: the slot must be a loaded tray in the live filament list; `use_ams: true, ams_slots: [n], auto_match_ams: false`, and `slice_stl` `load_filaments` with that tray's profile and `filament_colours` (a chosen profile replaces the profile's configured `filament_profile`; the two are never sent together). `external`: `use_ams: false`. `material` ("What's loaded?", any printer, PR 5): see below. |

`filament` (the full tray identity, as today) is still accepted; send either `filament` or `colour`, not both (400).

**Multi-part 3MF colours.** A 3MF model (a published file, or a design in several colours) owns its per-part filaments, so `colour`/`filament` do not apply. `GET /v1/objects/<id>/colour-mapping` / `objects.colourMapping` (PRINT) answers `{filaments: [{index, name?, colour?, material?, slot?, distance?, materialMismatch?, guessed?}], trays: [...], modelVersion}`: the model's filaments in project order (colours from the file's project settings, or from what the design pass declared), the loaded spools, and the suggested spool per colour — the nearest loaded colour in OKLab space, preferring the asked-for material. Send the person's choice back as `filaments: [tray, …]` (full tray identities, one per model filament, in order) with `filamentsModelVersion` set to that `modelVersion` (required with choices; a model or plate that changed since is refused, 409). Each choice is checked against the live inventory (409 when one changed or the count is wrong), and one print feeds from one source: a mix of AMS trays and the external spool is refused. Omitted, the companion uses the suggestions. Either way it sends `print_3mf` a project-level `ams_mapping` with one entry per declared project slot (a slot no part names is matched by its own declared colour from the same feed source — and when the file carries painting, such slots are listed as filaments of the model (rows in the sheet) in the first place) and `auto_match_ams: false`, and slices an unsliced 3MF with one `load_filaments` profile and `filament_colours` entry per declared slot, from the chosen spools. For an already-sliced file the material is a hard rule (its temperatures are fixed): suggestions and choices are restricted to spools of the sliced material. Automatic matches never mix AMS trays with the external spool in one print. Every spool in the final mapping is re-read at dispatch and again before a waiting print confirmation is forwarded as accepted; a swapped spool stops the print before anything is sent. `estimate` accepts the same `filaments` choices and slices with them. An already-sliced file keeps its slicing and takes only the mapping. When the model's filaments can't be read, or the destination's MCP isn't one that reports an AMS inventory (bambu-printer-mcp, or any MCP whose filament capability is `ams`), printing falls back to the MCP's own defaults as before — unless the request carried explicit `filaments` choices, which are refused rather than dropped.

**`colour: {material}` (PR 5).** The person says which material is loaded, for example `"PETG"` (case doesn't matter). Offer it when the destination's `capabilities.materialChoice` is true. What is sent depends on the printer's MCP:

- **bambu-printer-mcp, the material is on a loaded spool** (an AMS tray, or the external spool when the printer reports it): that spool, exactly as `amsSlot` would choose it: its profile in `slice_stl` `load_filaments` and its colour in `filament_colours`, then `print_3mf` with `ams_slots: [slot]`, or `use_ams: false` for the external spool.
- **bambu-printer-mcp, no spool reports that material**: refused with 409, "The printer doesn't report a PETG spool. Set the external spool to PETG on the printer, or load PETG in the AMS, then try again." Nothing is sliced or sent: without a spool there is no profile for the material, and the preset's filament would slice it with another material's settings. A printer without an AMS reports the external spool once its type is set on the printer, and that case is the first bullet (`use_ams: false`).
- **mcp-3D-printer-server**: `slice_stl` `load_filaments` with the profile its `get_printer_filaments` reports for a slot of that material (`slots[].profile`, or `slots[].resolved_profile_path`; absolute paths only), and `upload_gcode` `material`. Without such a profile, only the destination's configured material is accepted (the MCP's own preset is for it). Any other material is refused with 409: "mcp-3D-printer-server doesn't give a slicing profile for PETG on this printer, so Counterpart can't slice for it. Choose PLA, the configured material, or update mcp-3D-printer-server." Today's mcp-3D-printer-server reports no profiles, so on it the choice works once KAN-216 adds them.

A non-standard `quality` or `strength` the destination's MCP can't apply (its `slice_stl` schema lacks the argument) is refused with 409 and a sentence naming the update, never silently printed at preset values. `capabilities.quality` / `capabilities.strength` say beforehand which the print sheet can offer.

### Printer questions: `printConfirmation` (PR 5 for the field types)

While the printer's MCP asks something (MCP elicitation, form mode), the object carries `printConfirmation`:

`{id, message, expiresAtMs, supported, fields: [{name, title, description?, required, type?, enum?, enumNames?, default?, minimum?, maximum?, minLength?, maxLength?, format?}]}`

| Field | Meaning |
|---|---|
| `type` | `string`, `number` or `integer`. **Absent means boolean**: the companion leaves `type` out for booleans so older apps read the same fields as before. |
| `enum`, `enumNames` | A string choice: the allowed values, and the words to show for each (same length). Both MCP spellings are relayed this way: `enum` with optional `enumNames`, and `oneOf: [{const, title}]`. |
| `default` | The MCP's suggested value (boolean, string or number, matching `type`). Preselect it; it is never sent unless the person submits it. |
| `minimum`, `maximum` | Number and integer bounds, inclusive |
| `minLength`, `maxLength` | String length bounds, counted in Unicode code points as JSON Schema does (an emoji made of several code points counts as several) |
| `format` | `email`, `uri`, `date` (`YYYY-MM-DD`, a real calendar day: `2026-02-30` is refused) or `date-time` (`YYYY-MM-DDTHH:MM[:SS[.fff]]` with `Z` or an offset) |

`supported` is true when the MCP's schema is a flat object whose every property is one of these primitives. Anything else (nested objects, arrays, unknown keywords) is relayed with `supported: false`; show `message` and offer only Cancel.

**Answers.** `{action: "accept", content}` sends `content` as `{<field name>: value}`, each value a boolean, a string or a number matching that field. The companion checks it against the question before the MCP sees it, and a failure is 400 `invalid-request` (`objects.answerPrintConfirmation`: `invalid-request`) whose `message` names the field by its title:

| Check | `message` |
|---|---|
| boolean field given something else | `"<title>" needs yes or no.` |
| string field given something else | `"<title>" needs text.` |
| not one of `enum` | `"<title>" must be one of the choices.` |
| shorter than `minLength` / longer than `maxLength` | `"<title>" needs at least N characters.` / `"<title>" takes at most N characters.` |
| `format` not met | `"<title>" must be a valid email` (or `uri`, `date`, `date-time`) |
| number field given something else | `"<title>" needs a number.` |
| integer field given a fraction | `"<title>" needs a whole number.` |
| below `minimum` / above `maximum` | `"<title>" must be at least N.` / `"<title>" must be at most N.` |
| a key the question doesn't have | `"<name>" isn't part of the printer's question.` |
| a `required` field left out | `"<title>" needs an answer.` |
| accepting a `supported: false` question | `This printer question can only be cancelled here.` |

A rejected answer leaves the question open, so the person can correct it and send again. `decline` and `cancel` take no content. Only a person's answer is sent: nothing is answered on the person's behalf.

### Watched camera delivery

Both `camera.jpg` routes accept `?stream=1&size=full` (or `size=card`, the default). They keep the usual PRINT authorization and return `Content-Type: application/x-ndjson` with `X-Camera-Protocol: 1`. Each newline-terminated frame is `{v: 1, seq, capturedAt, base64}`. `base64` is JPEG; a complete line is at most 65536 bytes. Blank lines every 15 seconds are keep-alives. Clients must bound their partial-line buffer, ignore blank lines, and cancel the connection when the camera view disappears or the app becomes inactive.

An explicit `capabilities.cameraStream: false` or structured `camera_stream_start` status `not-supported` also selects snapshot compatibility. Tool names alone do not prove the optional native runtime is available. Authentication, discovery and connection failures remain errors. Capability refusal is cached only for the current MCP connection.

The companion discovers all three MCP stream tools plus `camera_frame.max_bytes` before opening a watched feed. An older MCP returns ordinary JSON `404 not-supported` before streaming headers; the phone then uses the existing JPEG route. A stream sends only changed images, at most once every two seconds full-screen or ten seconds for a card. Full-screen requests cap JPEG at 42000 bytes (at most 56000 base64 bytes); cards cap at 20000. Widths are ceilings of 1200 and 300 respectively; the MCP may reduce dimensions to meet the byte cap. Several viewers share MCP reads and one native camera source. Closing one viewer releases only its lease; the last viewer cancels the outstanding MCP wait and releases the session, and the MCP closes its shared source after 30 seconds idle. Authorization is rechecked before frames and keep-alives. Slow readers stop the stream rather than growing an unbounded output queue.

Without `stream=1`, replies remain JPEG. `size=full` selects the larger bounded stream frame when supported. `ETag` and `If-None-Match` permit `304` with no JPEG bytes; `X-Camera-Stream: 1` identifies the available MCP capability. Metadata, notifications and project reads never imply a camera viewer.

### Snapshot fallback timing (PR 5)

A P1S camera snapshot (bambu-printer-mcp `camera_snapshot`, bambu-tcp) takes 5 to 7 s on its own, measured on David's printer. So the companion:

- answers a camera request from the last frame when it is under 3 s old, and otherwise from a frame up to 2 min old while one fetch for the next runs (several viewers share it). An event's frame (`print.done`, milestones) always waits for a new one, since it is saved with the event. `X-Captured-At` is always when that frame was taken: show "a few seconds ago" from it rather than assuming it is live;
- waits only when there is no frame yet, or the last one is over 2 min old;
- starts camera work only for an explicit camera request; project and printer metadata reads do not fetch frames;
- keeps the session held for 30 s after each camera request, so a view refreshing every 3 s never meets a closed session.

Live, P1S through bambu-printer-mcp 1.1.46: cold first frame 5.3 s; then 0 to 1 ms per 3 s refresh (each new frame arrives about every 6 s, as fast as the camera gives them); a view's first request 1 s after it opened waited 4.0 s instead of 5.3 s.

### `PrintEstimate` (PR 2)

`{destinationId, quality, strength, seconds?, grams?, layers?, layerHeightMm?, infillPercent?, wallLoops?, copies?, slicerWarning?, slicedAt}`. The companion lays the model flat and slices it with exactly the settings a Print with the same values would use, then reads time and grams from the sliced file (`Metadata/slice_info.config`), and layer height, infill and walls from its settings (`Metadata/project_settings.config`, or the G-code header for G-code output). It never prints. Results are cached per model, destination and settings until the model changes; identical concurrent requests share one slice. A new pass (new model) discards the cache.

Bambu Studio's own verdict on the slice (KAN-223, when the MCP returns `slicer_result`) reaches the print sheet in Studio's words, exactly as Print would show them:
- **A warning** on a slice that worked (for example "It seems object x.stl has floating cantilever. Please re-orient the object or enable support generation.") is `slicerWarning`, verbatim. The estimate asks nothing; Print asks "Print anyway" with the same words before the printer is asked anything.
- **An error** (`return_code` other than 0) refuses the estimate with 409 `invalid-state`, and the message is Studio's `error_string` plus each plate's warning, word for word: the same text a Print of that model fails with. Other slice failures still read "Couldn't slice it for an estimate: …".

### `PrinterDestination` (PR 1)

`{id, name, backend, model?, address?, source, origin?, state?, stateCheckedAt?, capabilities?, mcpId?, mcps?}`. `mcps` (the same printer reached through both MCPs) is `[{backend, destinationId}]`, the one in use first; with two entries, Settings → Printers offers the Printer MCP choice (`PUT …/mcp`). `mcpId` (PR 6, `mcp-<16 hex>`) names the MCP install the printer runs; every printer on the same install has the same one (below).

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
| `copies` | `slice_stl` takes `repetitions` and the slice really makes them (PR 8b): always on bambu-printer-mcp; on mcp-3D-printer-server only on its Bambu-compatible route (PrusaSlicer, Cura and plain OrcaSlicer would slice one). Print and Estimate take `copies`; elsewhere it is refused with the update. |
| `layerPauses` | `slice_stl` takes `pause_at_layers`: Print takes `pauseBeforeLayers` |
| `materialChoice` | always (PR 5): `colour: {material}` is accepted for this destination ("What's loaded?"); the material is sliced with a profile the printer reports for it, or refused with what to do (above) |

`missing` lists what this install's version lacks (not what the hardware lacks), and `update.message` says which update unlocks it, for example "Update mcp-3D-printer-server to see progress and camera." `update.command` is the package-manager command for how that MCP is installed (`["npm","install","-g","bambu-printer-mcp@latest"]` for a global npm install); it is absent for an `npx` profile and for a source checkout. It is kept for Copy Command; from PR 6 the Update button posts the update instead (below). `update.latestVersion` (PR 6) is the newest published version (`npm view <package> version`); from PR 6 `update` is also present, with "Update bambu-printer-mcp to 1.1.50.", when only a newer version exists.

### Adding a printer from the phone (PRD §5.8, §6.1)

Add printer… on the iPhone, iPad and Android calls the same companion methods as the Mac and Linux (`local-control.md`: `printers.discover`, `printers.check`, `printers.obtain`, `printers.add`), with the same parameter schemas and replies. Every route is `POST`, needs PRINT and SETTINGS (it writes an MCP's `.env`), and is advertised by `printerAdd` in `/healthz`.

| Path | Body | Reply |
|---|---|---|
| `/v1/printers/setup/discover` | `{}` | `{found, network, options}`: printers the MCPs found, and every MCP's own setup fields (`counterpart_setup_fields`). The brands list only MCPs that answered, so the form never offers one that isn't on the computer |
| `/v1/printers/setup/check` | `{printer}` | `{check}` |
| `/v1/printers/setup/obtain` | `{backend, printerType, host, port?, field, session?}` | one `printers.obtain` step (`status`, `message`, `approveUrl?`, `value?`) |
| `/v1/printers/setup/add` | `{printer}` | `{id, destinationId?, sameAs?}` |

`printer` is `PrinterFormSchema`. A `{folder}` printer is accepted only when the last discovery from a phone listed that folder: a paired device never names a path on the computer itself. A refusal from the setup is `{error: {code, message}}` with its own sentence in `message` and `sentence` (400 `invalid-request`, 404, 409 `conflict`, 503 `unavailable`). The answers in `packages/contracts/fixtures/printer-setup-phone.json` are shared by the companion, iPhone and Android tests.

### Updating the printer MCPs (PR 6, PRD §8.10)

| Method and path | Scope | Body | Reply |
|---|---|---|---|
| `GET /v1/printers/mcps` | READ | none | `{packages}`: effective per-profile copies, canonical `printerId`, and separate `appCopy`; read-only, advertised by `mcpCopies` |
| `POST /v1/printers/mcp/<mcpId>/update` | SETTINGS | `{fresh?: boolean}` (`{}` or no body is fine) | `{update: McpUpdate}`; 404 `not-found` for an unknown `mcpId`; 503 `unavailable` with a sentence when npm can't be reached |

`McpUpdate` is `{mcpId, state, fromVersion?, toVersion?, found?}` (`McpUpdateSchema`):

| `state` | Meaning | Show |
|---|---|---|
| `started` | The update is running now. Progress and the result arrive as `mcp.update.*` events ([events.md](events.md)). | a progress bar |
| `waiting` | Counterpart is sending, slicing or designing on one of this install's printers; it starts when that ends (up to a minute, then it fails with a sentence). A printer printing on its own never makes it wait | "Updates as soon as Counterpart finishes its work on this printer" |
| `current` | `fromVersion` is already the latest | "Up to date" |
| `unresolved` | Counterpart can't tell how this copy is installed. `found` says what it found, in plain words. Nothing ran. | `found`, and **Install a Fresh Copy** (`{fresh: true}`) |

Asking again while an update is `started` or `waiting` returns that update; it never starts a second. `fresh: true` installs the latest into the app's own copy (`~/Library/Application Support/Scan to Make/printers/bambu` or `…/generic`) and runs that copy for these printers from then on, with the profile's own variables (and, for a wrapped command, its directory and variables). Without events (see events.md), poll by posting again: `current` means it finished.

**What runs**, from the process the profile starts (PRD §8.10's table):

| Installed as | Update runs |
|---|---|
| `npx <pkg>[@version]` | nothing global: the profile runs `<pkg>@<latest>` from then on (kept in `printers/overrides.json`; the client's own config file is not edited) |
| global npm (`<prefix>/bin/<pkg>`, or `node <prefix>/lib/node_modules/<pkg>/…`) | `npm install --global --prefix <prefix>/.counterpart-update-<uuid> <pkg>@<latest>`, with that prefix's own `node`/`npm` when it has them; then the staged package replaces `<prefix>/lib/node_modules/<pkg>` (the old one is kept until the new one has connected) |
| the app's own copy (`…/Scan to Make/printers/<folder>`) | the same, with the node that runs the MCP and the first npm found (beside that node, on PATH, `/opt/homebrew/bin`, `/usr/local/bin`, then the newest nvm) |
| a git checkout (`<dir>` with `package.json` named `<pkg>` and `.git`) | stops with "This copy has local changes" if `git status --porcelain` shows any; else `git pull --ff-only`, `npm ci`, `npm run build` in `<dir>`. If a step after the pull fails, the checkout goes back to the commit it was on and is rebuilt |
| `ssh … 127.0.0.1` (this Mac, this user) | the command it runs: the remote command when the profile gives one, else the `command="…"` for its `-i` key in `~/.ssh/authorized_keys`; that command is then one of the rows above. An npx command behind ssh is `unresolved` (its version is in a command Counterpart doesn't own): offer a fresh copy |

**Moving to Counterpart's copy** (`fresh: true`) saves an override in `printers/overrides.json` that runs Counterpart's own copy, started with the variables and directory the profile's own command sets (for ssh, its forced command's). It never falls back: an npx pin is dropped when its profile changes, but a Move is made again from the changed profile (same MCP) and saved for it at start, so the printer never returns to the copy the profile wraps (Nov 6: an ssh forced command naming `printers/bambu-1.1.46`, 1.1.65). The profile and `~/.ssh/authorized_keys` are left as they are. Settings → Printers says when a printer runs a copy older than Counterpart's (`printers.mcps` `uses[].words`).

**Between prints.** Prints and updates on a printer exclude each other. An update first marks its printers (a Print or a phone handoff print there is then refused with "The printer's software is updating. Try again in a minute."), then checks for a print being prepared or monitored; if there is one it unmarks them and reports `waiting`, and looks again every 15 s. A print that has started holds its printer until its dispatch ends, after which its `printing` state keeps the update waiting until the print ends. One update runs per install at a time. `mcpId` includes the package, so both MCPs under one global prefix stay apart. After an npx or fresh-copy update the install is read from what now runs, so asking again says `current`.

Then the companion restarts every session on that install (each waits for any printer-changing call in flight), connects one, re-reads capabilities, and reports the version the MCP now gives (`mcp.update.done` `toVersion`). On failure the previous version stays in use: a staged npm install is never swapped in (and a swap that fails puts the old copy back), a checkout goes back to its commit and is rebuilt, and an npx or fresh-copy change is put back; if a checkout can't be rebuilt, `mcp.update.failed` says so in plain words instead. The failure event carries the log's last 4 KB. npx and fresh-copy changes are kept per printer (each keeps its own variables and directory), and printers that end up running the same files are locked and restarted together. An npx group is `current` only when every one of its printers runs the latest. A key's forced command in `authorized_keys` wins over the remote command the profile sends (as OpenSSH does), and a wrapped npx profile is a separate install from directly launched ones. A saved npx or fresh-copy change is dropped when its printer's profile changes. A fresh copy also counts every printer already running the app's own copy: they wait, lock and restart with it. The latest version is checked at start and once a day, and again when a printer list is read and the last check is over an hour old. Nothing ever shows or opens a config file.

## Project fields

`Object` is the companion's `StmObject` (`services/companion/src/objects/store.ts`) minus internal paths. Fields added by KAN-214:

| Field | Type | Status |
|---|---|---|
| `status` | `ObjectStatus` `{phase, text, symbol, tint}`: the PRD §4 state line, written by the companion. Show `text` as is. `phase` is `sending`, `working`, `needs-you`, `ready`, `preparing`, `printing`, `printed`, `failed` or `sent` (symbol `paperplane`, tint `secondary`). From PR 8a also `confirmed` ("Done · it works", symbol `checkmark.circle.fill`, tint `green`). While the printer gets ready (layer 0: heating, cleaning, levelling) `phase` is `preparing` and `text` is "Getting ready · *stage*", never a percent or time left. A print the printer stopped is `failed` with "The printer stopped: *its message*", or "The printer stopped (*code*)" when Bambu has no text. | PR 3 |
| `settings` | `{status, archived}`: Project Settings' Status (`not-printed`, `printed`, `works`, `needs-changes`; PRD §5.4) and whether it's hidden from Home (PR 8b). A Done (`works`) project stays printable: Print needs no `checked`, its state goes to `printing`, and when that print finishes it is `confirmed` (Done) again. Any other project's next finished print makes it `printed`, so "Did it fit?" comes back after changes. A correction that changes the model clears Done: that version hasn't been shown to work, so its first print asks again. | PR 8a, 8b |
| `title` | The short title ("Mic mount"). Always a string: generated at the first pass, and for a project from before titles the first time it is listed (once, in the background, then saved). Until then it is the request's first six words ("A mount for my mic stand…"), or "Your scan" / "Your project" without a request. | PR 4 |
| `kind` | `fit` (make something that fits), `copy` (copy an object) or `published` (print a published model, PR 7, below). Set at creation (send it: the phone's New flow knows which job it is), else from the first pass: a project with a scan or a handheld capture is a `copy` even with a request ("Copy this. Close up the bottom."), and a request with photos alone is a `fit`. A copy is always cleaned up in Blender; a design uses Fusion when the printer MCP's `fusion_mcp_status` reports it connected and a new design opens, else Blender. | PR 4 |
| `ask` | `Ask` `{id, question, photo?, region?, answers, status, askedAtMs}` while `state` is `needs-closeup` (and kept, `status: "answered"`, after). The old `question.closeup` is still set for older apps. From PR 7 an Ask has a `type` (below). | PR 4 |
| `credit` | `{url, designer?, site?, title?, licence?, thumbnail?}`: the published model's page and designer, shown as "by *designer* on *site*" with a link. `thumbnail` is relative to the project's folder. | PR 7 |
| `files` | `{original: [path], current: path, receipts?: [receipt]}`: the designer's files exactly as published (`original/…`), and the file that prints. Paths are relative to the project's folder (`directory` on the Mac). | PR 7 |
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

## Published models (PRD §8.11)

Create with `kind: "published"`, a model-page `url` and optional instructions. The retrieval worker opens the page in the user's visible Chrome integration when available, retaining title/designer/licence credit. It has Read, Glob, WebSearch, WebFetch and browser tools; no printer tools, geometry operations or physical dispatch tools. Neither configured printer MCP currently exposes a documented model-download tool. Existing fit/copy worker policy is unchanged.

A named download must be a regular non-symlink file that arrived during this pass. An older Downloads match is offered for confirmation instead of proving origin by filename. If retrieval cannot obtain every named file, a `file` Ask offers the model page and a file picker. Explicitly shared files are accepted as user-provided inputs. Receipt hashes prove the bytes retained locally, **not an independently verified publisher checksum**.

`files.original` retains content-addressed original paths. `files.receipts` records each original's SHA-256, byte length, format, embedded title/designer/licence, source credit and plates. `files.current` and `current.model` identify the selected original. Neither retrieval nor printing modifies it. Previews copied from the 3MF are display-only: an archive containing only thumbnails/settings and no geometry or printable plate is refused.

| Ask | Fields | Answer |
|---|---|---|
| `file` | `url`, `modelName?`, `site?`, `accepts`, `candidate?` | `POST …/model?name=<filename>` with bytes, or `objects.addFile {id, kind: "model", path}` |
| `choice` | `options: [{id, label, detail?, thumbnail?}]` | `POST …/ask {askId, choices: [optionId]}` or `objects.answerAsk`; stale/unknown choices are refused |

Multiple files or plates produce an explicit choice. `publishedSelection` records the chosen file and zero-based plate. Choice completion emits `pass.ready`. `start` after a supplied file is idempotent, so Mac create-with-file never retrieves a replacement.

An unsliced 3MF passes unchanged into `slice_stl`, with one-based `slice_plate`, no `lay_flat`, no `load_filament_ids`, and its saved orientation, arrangement and per-part filament assignments retained. Explicit additional copies can request arrangement. Slicing creates a separate artifact. A pre-sliced plate requires the printer MCP's `inspect_print_file` receipt matching the exact SHA and selection, and refuses slicing overrides it cannot apply. `print_3mf` receives the original sliced file or derived sliced artifact and a zero-based `plate_index`; existing printer confirmation remains required. Separate 3MF files are not silently combined or reduced to the first file.

The phone offers pasted-link creation, file and plate Asks, source credit and normal printing. `capabilities.publishedModels` advertises these contracts. Live browser download and physical print acceptance are separate from fixture tests.

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

### Message photo ownership

New projects record `requestPhotos` explicitly. Photos uploaded after a project starts enter
`pendingPhotos`. A correction may send `photoNames: string[]` to claim only those uploaded names;
omitting the field uses the currently pending names. Mac control `objects.correct` also accepts
`photoNames` when `capabilities.messagePhotos` is true, alongside local `photos` file paths.

The companion retains each new follow-up or Ask answer in `messages` as
`{id, text, atMs, photos}`. A resulting pass stores `messageId` and `photos`, while its worker `note`
may contain additional Ask context. Success reports store the same `messageId` on `completion`
and do not start a pass, even with photo evidence. An uncertain report keeps `pendingMessageId`
and `pendingFollowup`; retrying it retains its message and photos. Both clients persist queued
messages with their timestamps and claimed photo names, so later queued photos cannot attach to
an earlier message. Old photos without recorded ownership remain separate; their association is
not guessed from file order or a project's modification time.

### Printer software copies

`GET /v1/printers/mcps` requires `projects:read` and returns `{packages}` from the local-control `printers.mcps` catalog, without setup options. Each `uses` entry includes `printerId` (the selected/canonical printer), `destinationId` (the particular profile), its effective copy’s path/version, stable `mcpId`, and `canMove`. `mcpCopies` in `/healthz` advertises this read. Clients keep `appCopy.version` separate from each use’s version. An explicit move uses the existing `POST /v1/printers/mcp/<mcpId>/update` with `{fresh:true}` and requires `projects:write`; it names all profiles sharing that installation, preserves the checkout and settings, and reports waiting/progress via the existing reply/events. Reads never change a profile.

Read-only and print-only credentials receive 403 for update or move; a write-only credential receives 403 for the copy catalog. Update and move share the desktop updater and print guard: active prints defer replacement and process restarts until the guard is released.
