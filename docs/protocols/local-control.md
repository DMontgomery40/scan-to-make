# Local control protocol v1

The Mac app administers its companion through a Unix domain socket. The phone API remains separate: none of these methods is an HTTP or HTTPS administration route. `RemoteAuthStore` supplies pairing/device administration, the existing stores supply job records, and the same printer-handoff relay serves confirmations from both phone and Mac. The relay preserves bambu-printer-mcp's original message, schema, photo and human answer; it does not duplicate slicing, editing, safety or print dispatch.

## Endpoint and framing

An authenticated companion starts `<auth directory>/control.sock`. `SCAN_TO_MAKE_CONTROL_SOCKET` can override this with an absolute pathname for isolated installations. There is no TCP fallback. The immediate directory must be owned by the companion user and have no group/other permissions; the socket is mode `0600`. Existing unrelated files, symlinks and live sockets are never replaced. A process lock serializes startup; a refused stale socket owned by the same user can be reclaimed. Shutdown removes the listening socket.

Use UTF-8 NDJSON, **one request and one reply per connection**. Keep reading after sending the newline; half-closing the write side is supported. Request maximum is 64 KiB including newline; reply maximum is 8 MiB including newline. Connection deadline is 10 seconds (longer for `events.wait` and `objects.estimate`, see below), with at most 16 connected or executing requests. Unix paths are limited to 103 UTF-8 bytes for macOS portability. The socket boundary trusts the current OS user, not arbitrary local users or browsers.

```json
{"v":1,"id":"00000000-0000-4000-8000-000000000001","method":"status.get","params":{}}
{"v":1,"id":"00000000-0000-4000-8000-000000000001","result":{"protocolVersion":1,"companionVersion":"0.1.0","transport":"lan","pairedDeviceCount":0,"capabilities":{"capture":true,"cleanup":false,"printerHandoff":false}}}
```

Errors use `{v:1,id,error:{code,message}}`; malformed envelopes may have `id:null`. Codes are `invalid-request`, `unsupported-version`, `not-found`, `conflict`, `slicer-error`, `unavailable`, and `internal`. Messages never include input, private paths or provider diagnostics. Requests reject unknown methods, fields and parameters. IDs are UUIDs and replies echo them. Stored schema failures return `unavailable`; they do not blame a valid request. Connection IDs are correlation identifiers, **not idempotency keys**. A disconnect or deadline after sending a mutation has an unknown outcome: inspect current state, and never replay it automatically.

## Methods

| Method | Parameters | Result |
|---|---|---|
| `status.get` | `{}` | Protocol/companion version, transport, paired device count and capability booleans as above; `name`, the Mac's name as people know it ("Mac mini", as in `/healthz`), when the companion has one. |
| `jobs.list` | `{projectId?,cursor?,limit?}` | `{items:[{kind,projectId,projectName,job}],nextCursor?}`. Default limit 50; range 1–100. |
| `devices.list` | `{}` | `{devices:[{deviceId,deviceName,scopes,pairedAt,lastRefreshedAt,expiresAt,pairedVia:{transport,login}}]}`. No tokens or token hashes. |
| `devices.remove` | `{deviceId}` | `{removed:true}`; an unknown device returns `not-found`. Existing device credentials are revoked. |
| `pairing.create` | `{login?}` | Existing invitation `{version:1,baseUrl,code,expiresAt,certificateSha256?,qrPayload}` with capture and printer-handoff scopes. LAN selects `lan`; Tailscale defaults to the first retained allowed login. An explicit login must be allowed. When the companion answers on every address (`SCAN_TO_MAKE_LAN_ALL_ADDRESSES=1`), `qrPayload` is a pairing link v2 (`@scan-to-make/contracts/pairing-link`) listing those addresses; the JSON fields keep their v1 shape. |
| `pairing.isActive` | `{code}` | `{active:boolean}`; false after consumption or expiry. |
| `pairing.icloudToken` | `{}` | LAN mode: `{token,expiresAt,macId,spkiSha256,addresses}` for the Mac app's private CloudKit record. `expiresAt` is an ISO timestamp; each address has `{kind,host,port}`. The token lasts ten minutes, rotates after five, and may enroll one phone. Unavailable without LAN TLS. |
| `nearby.list` | `{}` | `{items:[{id,deviceName,code,expiresAt}]}`: nearby pairing requests waiting for **Allow** (`@scan-to-make/contracts/nearby-pairing`). `code` is the 6 digits the phone shows. Empty when nearby pairing is off (`capabilities.nearbyPairing`). |
| `nearby.answer` | `{id,allow}` | `{answered:true}`. Allow mints one pairing code for that request only; the phone that made it collects it. An unknown, expired or already answered `id` returns `not-found`; with nearby pairing off, `unavailable`. |
| `confirmations.list` | `{}` | `{items:[PendingElicitation]}` using the existing relay's fields, including original schema/photo and expiry. |
| `confirmations.answer` | `{id,answer}` | `{answered:true}`. Answer is `{action:"accept",content:{...}}`, `{action:"decline"}` or `{action:"cancel"}`. Expired or already answered IDs return `not-found`. |
| `doors.prepare` | `{projectId,door}` **or** `{handoffId,door}` | `{action:"open"\|"reveal",fileURL,applicationBundleId?,projectRevision}`. Exactly one target identifier. |

`status.get` capabilities also include `nearbyPairing`. Poll `nearby.list` while it is true and show each request as its own card with the code; the code on the Mac must match the phone's before **Allow**. Requests expire two minutes after they start.

Times are Unix milliseconds. Pairing secrets stay in memory, never argv, logs, analytics or error messages. The caller retains one active invitation per visible pairing session and uses `pairing.isActive` before reusing it. Creating repeated unused invitations still obeys the auth store's existing eight-invitation limit.

### Job index

Cleanup `job` is the existing `ScanProcessingJob`; print `job` is the existing `HandoffManifest`. No lossy status translation is added. Cleanup rows include jobs retained for each capture at its project's **current revision**, including multiple projects and captures. Historical revisions keep their files but are not included in the current-work index. Status is the last persisted status; this read-only index does not restart or repair jobs.

Print manifests currently have no project association, so their `projectId` and `projectName` are `null`. Their bundle `job.id` remains the stable identifier; a project filter excludes those unassociated rows. Clients must not infer a project from the prompt or create a fake association.

Rows sort by `(kind, job ID)` with a cursor bound to the project filter. Each page reads current state, not a frozen transaction; refresh from the beginning to discover new jobs inserted before the cursor. Pagination bounds the reply; the backing stores are scanned for each request.

### Doors

`door` is `finder`, `blender`, `bambu-studio` or `orca`. Requests accept IDs, never executable names, commands or arbitrary file paths. The companion prepares a verified local target; `ControlClient.openDoor` performs the native reveal/open on the Mac.

- A project Finder door reveals its most recently imported retained capture at the current revision. A project without a capture returns `unavailable`.
- A handoff Finder door reveals its validated bundle. Bambu Studio/Orca require exactly one retained, hash-verified `.3mf` artifact. The companion never invokes a slicer to fabricate one.
- Blender requires exactly one retained, verified `.blend` artifact in a handoff. Existing cleanup OBJ files are **not** presented as editable `.blend` files. Project editing/import/watch behavior belongs to MAC-7; until its prepared artifact exists, the door returns `unavailable`.
- Desktop open doors return a fresh editable copy under `<parent of auth directory>/door-copies/open-*/`, with a private directory and mode `0600` file. The bytes are verified before copying. Saving in the editor cannot invalidate the retained bundle or jobs index. Copies remain for the user to save or remove; no automatic re-import or deletion is performed.
- A missing desktop application returns `ControlClientError.unavailable`; no alternate application or shell command is tried. Handoff `projectRevision` is `null` because the manifest has no project association.

## Objects, printers, events and devices

The Mac app shows the same projects as the phone and drives them through these methods. Field shapes are those of [objects-api.md](objects-api.md) and [events.md](events.md); wire schemas are in `@scan-to-make/contracts/counterpart`, with samples in `packages/contracts/fixtures/counterpart-v1.json`. Each `{object}` result is the phone's object plus `directory`, the project's folder on this Mac (renders, model, frames and Ask pictures are read from there). A `new` project whose first files are arriving from the phone right now also has `progress: "Receiving files from your iPhone"`: the companion keeps no other trace of an upload in progress, so a `new` project with no `scan`, `photos`, `capture` or `captureDepth` and no `progress` is a draft still on the phone. When an upload starts or stops on a project with no files, a `project.updated` event with `data.keys: ["receiving"]` makes the apps read it again. Refusals a person should read come back as `conflict` with the sentence as `message`. "PR *n*" marks the KAN-214 pull request that adds a method or field; until then the method is rejected as `invalid-request`. Check the `status.get` capability flags instead of the version.

### `status.get` capability flags

`capabilities` gains these booleans, each true once its PR is in the running companion:

| Flag | Meaning | Status |
|---|---|---|
| `objectsCreate` | `objects.create`, `objects.addFile` and `objects.correct` `photos` | PR 1 |
| `printSettings` | `objects.print` settings, `objects.estimate`, destination `state` and `capabilities`, `settings.*` | PR 2 |
| `printControl` | `objects.pausePrint`, `objects.resumePrint`, `objects.cancelPrint`, `objects.camera`, `printers.camera`, the print monitor | PR 2 |
| `events` | `events.wait`, `liveActivity.tokens`, device `model` and `lastSeenAt`, object `status` | PR 3 |
| `structuredPasses` | object `title`, `kind`, `ask`, `current.changes`, pass `stages` and `estimate`, the design engine | PR 4 |
| `projectSettings` | `objects.settings.get`/`objects.settings.set` (Status), object `settings.status`, the `confirmed` phase, `project.updated`. Also in `GET /healthz` `capabilities`. | PR 8a |
| `printCopies` | `objects.print` and `objects.estimate` take `copies`: true when a configured printer's MCP takes `repetitions` (destination `capabilities.copies`). Also in `GET /healthz`. | PR 8b |
| `genericConfirmations` | `printConfirmation.fields[]` may be text, number, integer and choice fields as well as yes/no, and `objects.answerPrintConfirmation` takes and checks those answers (below). The phone reads the same flag from `GET /healthz` `capabilities` ([objects-api.md](objects-api.md)). | PR 5 |
| `publishedModels` | `kind: "published"`, `objects.create` `url`, `credit` and `files`, Ask `type` `file` and `choice`, `objects.answerAsk`, `objects.addFile` `model`. Also in `GET /healthz`. | PR 7 |
| `mcpUpdates` | `printers.updateMcp` and `POST /v1/printers/mcp/<mcpId>/update`, destination `mcpId` and `capabilities.update.latestVersion`, the `mcp.update.*` events. Also in `GET /healthz` `capabilities`. | PR 6 |
| `printerSetup` | Settings → Printers setup: `printers.mcps`, `printers.installMcp` (Download), and the printer setup methods below. Present without a printer configured. | Nov 3 |
| `printerChoices` | The phone's Settings → Printers pickers: `GET`/`PUT /v1/objects/printers/<id>/route` and `PUT /v1/objects/printers/<id>/mcp`, the same work as `printers.route` and `printers.chooseMcp` ([objects-api.md](objects-api.md)). Also in `GET /healthz` `capabilities`. | Nov 4 |
| `materialChoice` | `objects.print` `colour: {material}` is accepted on every printer ("What's loaded?"): sliced with a profile the printer reports for that material, or refused with a sentence saying what to do. Also in `GET /healthz` `capabilities`. | PR 5 |
| `colourMapping` | `objects.colourMapping` (a multi-part model's filaments, loaded spools, nearest spool per colour) and `objects.print` `filaments: […]` (the chosen spool per colour). Also in `GET /healthz` `capabilities`. | #293 |

Destination `capabilities.materialChoice` (PR 5) says the same per printer; what each MCP is sent, and when it is refused, is in [objects-api.md](objects-api.md#print-settings-pr-2). `objects.get` of a printing project and `objects.printers` warm the printers' cameras as the phone's routes do, so `objects.camera` and `printers.camera` answer from a recent frame (objects-api.md, "Camera timing").

### Methods

| Method | Parameters | Result | Status |
|---|---|---|---|
| `objects.list` | `{}` | `{objects: [object]}` | |
| `objects.get` | `{id}` | `{object}` | |
| `objects.settings.get` | `{id}` | `{settings: {status, archived}}` | PR 8a, 8b |
| `objects.settings.set` | `{id, status?: "not-printed"\|"printed"\|"works"\|"needs-changes", archived?: boolean}`, at least one | `{settings, object}`; as `PATCH /v1/objects/<id>/settings` (objects-api.md). A refusal is `conflict` with its sentence. | PR 8a, 8b |
| `objects.create` | `{instructions?: string ≤ 8000, kind?: "fit"\|"copy"\|"published", url?: string ≤ 2048}` | `{object}` (`kind` from PR 4) | PR 1 |
| `objects.addFile` | `{id, kind: "photos"\|"scan"\|"model", path, forMessage?: boolean}` | `{object, photoName?}` | PR 1 |
| `objects.answerAsk` | `{id, askId, choices: [optionId]}` | `{object}`; chooses the published file/plate | PR 7 |
| `objects.start` | `{id}` | `{object}` | |
| `objects.correct` | `{id, note: string 1–4000, photoNames?: string[] ≤ 100, photos?: [path] ≤ 24}` | `{object}`: a new pass (`photos` PR 1) | |
| `objects.answerCloseup` | `{id, bestGuess: boolean, text?: string ≤ 2000, photoNames?: string[] ≤ 100}` (omitted names select none; an empty answer is refused) | `{object}`: a new pass (`text` PR 4) | |
| `objects.delete` | `{id}` | `{deleted: true}` | |
| `objects.passActivity` | `{id, index}` | `{activity}` | |
| `objects.printers` | `{}` | `{defaultDestinationId, destinations: [PrinterDestination]}`; `origin`, `state`, `stateCheckedAt`, `capabilities` from PR 1 | |
| `objects.selectPrinter` | `{id, destinationId}` | `{object}` | |
| `objects.filaments` | `{id}` | `{filaments}`; `suggested` from PR 2 | |
| `objects.colourMapping` | `{id}` | `{filaments, trays, modelVersion}`: a multi-part model's filaments with the suggested spool for each colour; `modelVersion` binds the sheet's choices to these model bytes, plate and declared colours (#293) | |
| `objects.estimate` | `{id, destinationId?, quality?: "draft"\|"standard"\|"fine", strength?: "standard"\|"strong"\|"max", filaments?: [tray…], filamentsModelVersion?}` | `PrintEstimate` `{destinationId, quality, strength, seconds?, grams?, layers?, layerHeightMm?, infillPercent?, wallLoops?, slicedAt}` | PR 2 `copies` from PR 8b. |
| `objects.print` | `{id, checked?, filament?, filaments?: [tray…], filamentsModelVersion?, quality?, strength?, colour?: {auto: true}\|{amsSlot}\|{external: true}\|{material}}` | `{object}` (settings PR 2; `material` on every printer PR 5; `filaments` the spool per colour of a multi-part model with its required `filamentsModelVersion`, #293) | `copies` (1–64) from PR 8b; a Done project prints without `checked`. |
| `objects.answerPrintConfirmation` | `{id, confirmationId, answer: {action: "accept", content: {<field>: boolean\|string ≤ 4096\|number}}\|{action: "decline"\|"cancel"}}` | `{object}`. An answer that doesn't fit the question is `invalid-request` with the field and reason as `message`. | strings and numbers PR 5 |
| `objects.pausePrint`, `objects.resumePrint`, `objects.cancelPrint` | `{id}` | `{object}` | PR 2 |
| `objects.camera` | `{id}` | `{format: "jpeg", base64, capturedAt}` from the project's printer | PR 2 |
| `printers.camera` | `{destinationId}` | `{format: "jpeg", base64, capturedAt}` | PR 2 |
| `printers.route` | `{destinationId, route?: "lan"\|"cloud"}` | `{route: {route, mode, type, choices, savedTo} \| null}`: how the destination's MCP reaches the printer, read from (or, with `route`, changed in) the MCP itself through bambu-printer-mcp's `counterpart_print_route`. The MCP saves the change in its own config (`savedTo`); Counterpart keeps no copy. `null` for an MCP without a route choice (mcp-3D-printer-server). Unknown destination: `not-found`. A change while a project prints there, or while the printer was last read as printing, is `conflict` ("This printer is printing. Change its connection when the print finishes."); reading is always allowed. Deadline 25 s (it may start the MCP's session). | Nov 3 |
| `printers.updateMcp` | `{mcpId, fresh?: boolean}` | `{update: {mcpId, state: "started"\|"waiting"\|"current"\|"unresolved", fromVersion?, toVersion?, found?}}`. Unknown `mcpId`: `not-found`; npm unreachable: `unavailable` with the sentence. It answers within about 7 s: when npm is slower, `unavailable` "npm is slow to answer…" (try again; the lookup keeps going and is cached). What runs and when: objects-api.md, "Updating the printer MCPs". | PR 6 |
| `printers.mcps` | `{}` | `{packages: [{package, label, description, installed, version?, latestVersion?, appMcpId, installs: [{kind: "npx"\|"global"\|"app"\|"checkout"\|"folder", path?, version?}]}], options}`: both printer MCPs, always (`options` as in `printers.discover`, for Complete Settings' model choice). A package is `installed` when any copy is on this Mac: one a configured printer runs (as configured or after an Update), the app's own copies under `<appPrinters>` (including earlier `bambu-<version>` folders), or a built clone with `dist/index.js` in the home folder or one level below it (protected folders such as Documents, and hidden ones, are skipped). `version` belongs to the runnable copy Check and Add select: the app's managed copy first, otherwise the first runnable copy found. That copy is first in `installs`, so its location and version agree. An unknown on-disk version stays absent; a newer worktree or an uninstalled npx pin never supplies it. `latestVersion` is independently read from npm. `appCopy?: {kind, path?, version?}` describes the canonical managed copy separately. `uses: [{destinationId, printerId, printer, mcpId, kind, path?, version?, canMove}]` includes every configured profile, including profiles merged into another destination; its copy and on-disk version come from the effective process after overrides. An uninstalled npx pin is not an installed version. Each usage also has `managed` (it runs Counterpart’s own copy) and `words`, the sentence clients show: which copy, its version, and “older than Counterpart’s copy (x)” when it is (an earlier `printers/bambu-1.1.46` reads as Counterpart’s older copy, never as Counterpart’s copy). `moves: [{mcpId, title}]` lists the Moves in the order the uses are listed, each titled by its printers, MCP and the copy they leave, so two profiles of one printer never show the same button; clients render these, and derive them the same way only from a companion that predates them. `latestVersion` waits up to 3 s for an npm check that opening Settings starts (or one already running), so a version published since the last check shows on this visit. Clients display each usage separately. An explicit “Move … to Counterpart’s updated copy” action calls `printers.updateMcp` with that usage’s `mcpId` and `fresh: true`; it names all profiles sharing that id, preserves their settings, and leaves their old checkout untouched. Updating `appMcpId` alone does not move checkout profiles. | Nov 3 |
| `printers.installMcp` | `{package: "bambu-printer-mcp"\|"mcp-3d-printer-server"}` | `{installed: true, package}` when this Mac already has a copy (nothing is installed), else `{update: {mcpId, state: "started", toVersion}}`: Download installs only that package, latest, into the app's own copy (`<appPrinters>/bambu` or `/generic`) with Update's staged npm install and swap. Progress comes as `mcp.update.*` events with that `mcpId` (the package's `appMcpId`). npm unreachable or slow: `unavailable` with the sentence. Deadline 15 s. | Nov 3 |
| `printers.discover` | `{}` | `{found: [{id, source: "folder"\|"ssdp"\|"bonjour", name, backend, printerType, model?, host?, port?, serial?, folder?, added, missing?, fill?}], network: "complete"\|"unavailable", options: {types: [{printerType, label, backends, serial, secret: {label, hint, required}}], models: {<package>: [{value, label}]}, serialModels: {<serial prefix>: <model>}}}`. A found folder whose `.env` lacks what its MCP needs for its printer type (bambu-printer-mcp's manifest `user_config`; mcp-3D-printer-server's `.env.example`) carries `missing` (names) and `fill`: `BAMBU_MODEL`, from the printer's SSDP DevModel, else its serial number; and, for an mcp-3D-printer-server Bambu printer whose `.env` sets no `BAMBU_DEFAULT_CONNECTION_MODE` and whose `dist/index.js` reads it, the authenticated route another MCP config on this Mac uses for the same serial (`BAMBU_DEFAULT_CONNECTION_MODE=bambu_network` with a `BAMBU_NETWORK_BRIDGE_COMMAND`, plus `BAMBU_DEFAULT_CONNECTION_TYPE`), whose lines are copied verbatim and nothing else from that file. Add appends exactly those. Found printers for Add printer…, in about 4 s, never a secret: (a) built copies of either MCP with a `.env` in the home folder (to depth 2) that no configured printer runs, read for host, `PRINTER_TYPE`, serial and model only; (b) Bambu printers announcing on UDP 2021 (SSDP, KAN-163's checks: Location must be the private sender; DevModel ids mapped to the MCP's model names), `added` when the serial is already a printer; (c) Bonjour `_octoprint._tcp`, `_moonraker._tcp` and (best-effort) `_prusalink._tcp` through `dns-sd -Z`. `network: "unavailable"` when UDP 2021 couldn't be opened (another app may hold it). `options` are the MCPs' own values: mcp-3D-printer-server's `PRINTER_TYPE`s and each MCP's model list. Deadline 15 s. | Nov 3 |
| `printers.check` | `{printer}` | `{check: {reached, camera: "connected"\|"failed"\|"not-supported", image?: {mimeType: "image/jpeg", base64}, model?}}`. `printer` is `{folder, model?}` (a found folder, run as it is; `model` when its missing BAMBU_MODEL couldn't be told) or `{backend, printerType, host, port?, serial?, model?, secret?, name?}` (`secret` is the Bambu access code or the API key; `host` is a host name or address, or an http or https web address with a path, without credentials, query or quote, only for a kind whose MCP host field says `input: "url"`, mcp-3d-printer-server 1.2.55+ for OctoPrint; otherwise `invalid-request`). Starts that MCP in a separate process with those settings (nothing written; its working directory has no `.env`), calls `get_printer_status` and, for a Bambu printer when the MCP has it, `camera_snapshot`. Never a print, heating, motion or settings tool; no telemetry, MCP error text or credentials come back. MCP not on this Mac: `unavailable` "Download … first". Deadline 60 s. | Nov 3 |
| `printers.obtain` | `{backend, printerType, host, port?, field, session?}` | `{session?, status: "pending"\|"approved"\|"failed", message, approveUrl?, value?}`. For a form field whose MCP field declares `obtain` (mcp-3d-printer-server 1.2.51+: OctoPrint's key, approved in OctoPrint). Without `session` it starts that MCP with no printer settings and calls the tool the field names with `host`, `port` and `app: "Counterpart"`; the copy keeps running (up to 10 minutes, 4 at a time) because the MCP holds the request. With `session` it waits up to 20 s for the person's answer. `approveUrl` is the MCP's page, http or https only. Once approved, `value` is only that field's own variable; the client puts it in the form, and Check and Add send it as they send a typed one. A field without `obtain`: `invalid-request`. Deadline 60 s. | Nov 6 |
| `printers.add` | `{printer}` | `{id, destinationId?, sameAs?}`. A found folder runs where it is (`node <folder>/dist/index.js`, cwd the folder, its own `.env`). A form printer gets `<appPrinters>/profiles/<id>/.env` (0600, folder 0700) with exactly the MCP's variables (bambu-printer-mcp: `MCP_TRANSPORT`, `PRINTER_HOST`, `BAMBU_SERIAL`, `BAMBU_MODEL`, `BAMBU_TOKEN`; mcp-3D-printer-server: `MCP_TRANSPORT`, `PRINTER_HOST`, `PRINTER_TYPE`, `PRINTER_PORT`, `API_KEY` or the Bambu ones) and runs the app's copy of that MCP (else another copy on this Mac) with that folder as its working directory. Either way it is recorded in `<appPrinters>/profiles.json` (`{version, profiles: [{id, name, backend, process: {command, args, cwd}, owned}], choices}`, no settings) and the catalog reads it as a destination (`origin: "counterpart"`, with `folder`). `sameAs` when it is a printer already listed through the other MCP (see `mcps`). No address in its settings: `invalid-request`, and nothing is kept. Deadline 30 s. | Nov 3 |
| `printers.remove` | `{destinationId}` | `{removed: true}`. Only a printer added in Counterpart (`not-found` otherwise); refused (`conflict`) while it prints. Its folder is deleted only if Counterpart made it. Deadline 30 s. | Nov 3 |
| `printers.completeSettings` | `{destinationId, model?}` | `{destinationId, model?}`. A printer added in Counterpart whose `.env` lacks a setting its MCP needs (the destination carries `incomplete: {missing, fill}`, names only): appends what `fill` says: `BAMBU_MODEL` (from `model`, else the serial number's model, bambu-printer-mcp's `SERIAL_MODELS`) and the authenticated route lines as in `printers.discover`; `incomplete` is present when `fill` has anything even if nothing is strictly missing; keeping every other line, their order and the file's mode; secrets are never written. Records the model in the profile (passed as `bambu_model`), then restarts that printer's MCP so it reads the file again. A model nobody can tell without `model`: `invalid-request`. Refused while it prints. Deadline 30 s. | Nov 3 |
| `printers.chooseMcp` | `{destinationId, backend}` | `{destinationId}` (the printer's id now). For a printer reachable through both MCPs (its destination lists `mcps: [{backend, destinationId}]`, the one in use first), which one it uses: Counterpart's own preference, in `profiles.json` `choices` by the printer's serial (else host), overriding PRD §8.2's routing rule for that printer only. Projects that chose either id follow it. Refused while it prints. Deadline 30 s. | Nov 3 |
| `settings.get` | `{}` | `{settings: {milestones}}` | PR 2 |
| `settings.set` | `{milestones: "off"\|"50"\|"25-50-75"\|"every-10"}` | `{settings}` | PR 2 |
| `events.wait` | `{after: integer ≥ 0, timeoutMs?: 0–25000 (default 25000), limit?: 0–500}` | `EventsPage` `{events, next, latest, truncated?, reset?}` | PR 3 |
| `liveActivity.tokens` | `{}` | `{pushToStart: [{deviceId, token, updatedAt}], activities: [{printId, deviceId, token, updatedAt}]}` | PR 3 |
| `devices.list` | `{}` | as above, each device also with `model?` (the phone's `X-Scan-Device-Model`), `lastSeenAt?` (ms of its last authenticated request) and `legacy?: true` (below) | PR 3 for `model` and `lastSeenAt`, PR 5 for `legacy` |

**Deadlines.** Every connection still carries one request. Its deadline is 10 s, except `events.wait` (its `timeoutMs` plus 5 s), `objects.estimate` (630 s: its slice may take 600 s, after the plates, settings and spools are read) and the printer methods whose rows give their own. A camera read gives up after 10 s.

**`objects.addFile`.** `path` is an absolute path on this Mac: the companion reads the file itself because requests are capped at 64 KiB. It must be a regular file (a symlink is followed), and its extension and first bytes must agree.

For correction queues and Ask answers, send `forMessage: true` when importing photos. This preserves
the attachment's purpose if the initial pass fails before the upload finishes. Other photos added
after an initial failure with no current model are request evidence for Try Again. Use the returned
`photoName` to select this upload; do not infer its name from the whole pending-photo list.

| `kind` | Accepted | Limit | Stored as | When |
|---|---|---|---|---|
| `photos` | `.jpg`/`.jpeg`, `.png`, `.heic` | 25 MiB | its own file name under `photos/` (a `-2`, `-3`… suffix when taken) | any state; a photo added while a pass runs is used by the next pass |
| `scan` | `.stl`, `.3mf`, `.usdz` | 64 MiB | `scan/scan.<ext>` | only while `state` is `new` |

The file is copied; the original is never changed. Then call `objects.start`. A wrong type or size is `conflict` with a sentence; a missing or unreadable file is `not-found`. `objects.correct` `photos` takes the same photo paths and adds them before the new pass starts.

**`objects.estimate`.** Slices the current model with the same settings a Print would use, through the destination's MCP session; it never prints. The default destination is the project's chosen printer. A repeated call with the same model and settings returns the cached estimate at once. Quality or strength the MCP can't apply is `conflict` with a sentence naming the update. When Bambu Studio refuses the slice (KAN-223), the error is `slicer-error` and `message` is Studio's own words; the Mac holds Print for that file. Every other refusal stays `conflict`, which never blocks printing. The result's `slicerWarning` is Studio's warning on a slice that worked, verbatim; the print run asks "Print anyway" with the same words.

**Printer questions.** `printConfirmation` and the checks on an answer are in [objects-api.md](objects-api.md) ("Printer questions"). A question whose schema isn't a flat set of yes/no, text, number and choice fields has `supported: false` and can only be cancelled. 

**Device names.** A phone that sends `X-Scan-Device-Name` (objects-api.md, "Headers the phone sends") keeps its `deviceName` in `devices.list` current: a renamed iPhone shows its new name after its next request.

**Legacy devices.** Pairings made before stable installation identity have no installation key, so each re-pair of the same phone added a row (audit M4: several "My phone" rows). `devices.list` marks those `legacy: true`; a device paired with an installation key never is. The companion removes a legacy device, its Live Activity tokens and its presence once it has made no authenticated request for 14 days. The 14 days count from its last request, or, when it has made none since this version started keeping presence, from that start (recorded as `since` in `auth/device-presence.json`, which survives restarts). The check runs at start and every 6 hours. A legacy device that makes a request is recognised like any other: it gets `lastSeenAt` and `model` (from `X-Scan-Device-Model`) and stays as long as it keeps being used. Re-pairing turns it into a current device with the same `deviceId` only when the app sends an installation key together with the old `deviceId` and its still-valid token; any other re-pair adds a new device, and the old row is removed by this rule. The 14 days also count from the device's pairing or last token refresh when either is later, so a legacy pairing made after this release gets its own 14 days. (Independently, any credential lapses 30 days after its last refresh.) `auth.json` itself is only changed through the store; removal is the same as `devices.remove`.

**No bed check** (PRD §5.6). Counterpart doesn't look at the plate before a print: Bambu's own bed levelling finds a full plate. The printer MCP's own confirmation is relayed as `printConfirmation` and answered with `objects.answerPrintConfirmation`; the camera is for the Printing screen and event frames only.

## Swift integration

`printer.check` accepts `{start:true}` to start a read-only check of the retained
operator printer configuration, and `{}` (or `{start:false}`) to poll. It returns
`{state:"idle"|"checking"|"complete", status?, camera?, cameraSha256?, cameraBytes?}`.
Starts coalesce while a check runs. Completed `status` is `connected` or `failed`;
`camera` is `connected`, `failed`, or `not-supported` for a non-Bambu backend,
a backend without the tool, or an operator config with `cameraSnapshot:false`.
Only `get_printer_status` and, for a connected Bambu, `camera_snapshot` are called.
The receipt contains a SHA-256 and length of the returned JPEG, never its bytes,
printer report, access code or raw error. No print is dispatched. A missing
operator configuration returns `unavailable`. `ControlClient.checkPrinter(start:)`
exposes this diagnostic; each poll stays within the socket deadline.

`apps/mac/ControlKit` is an independent Swift package for macOS 13+. It provides typed status, device, invitation, confirmation and door results. `ControlJob.job` preserves the existing job schema as `JSONValue`; `id` and `status` are convenience properties. Calls are asynchronous, deadline bounded and cancellable. A missing/refused endpoint returns `unavailable` before a request is sent; a deadline after sending still has unknown mutation outcome. Large replies are processed linearly. Socket errors and decoding failures are sanitized, and invitations redact ordinary debug descriptions.

```swift
let client = try ControlClient(socketPath: state.appendingPathComponent("auth/control.sock").path)
let status = try await client.status()
let invitation = try await client.createPairing()
// Render invitation.qrPayload directly; do not log it.
let pending = try await client.pendingConfirmations()
```

No SwiftUI views are part of this package. Switching the existing Mac app's stdin helpers to this client is a separate integration after the app-shell PR merges. Existing CLI commands remain compatible.

## Model access

The signed Mac app owns API credentials in its local, non-synchronizing Keychain
service `com.scantomake.model-access`, with a random UUID account per saved key.
The companion stores only metadata in `auth/model-access.json` (0600 in the
private auth directory). This is independent of phone authentication and TLS.
The schema and worker environment names live in
`packages/contracts/src/model-access.ts`.

| Method | Parameters | Result |
| --- | --- | --- |
| `modelAccess.get` | `{}` | `{revision, choice, check}` |
| `modelAccess.set` | `{expectedRevision, choice}` | New snapshot; stale revision returns `conflict` |
| `modelAccess.check` | `{revision}` | Snapshot immediately; stale revision returns `conflict` |

`revision` is a UUID. `choice` is one of:

```json
{"kind":"none"}
{"kind":"claude-code"}
{"kind":"codex-cli"}
{"kind":"api","provider":"anthropic","model":"claude-opus-5-5","keychainRef":"6f3de8c4-83b6-4ad7-9c6f-9b73c7077c73"}
{"kind":"endpoint","url":"http://localhost:1234/v1","model":"local-model"}
```

The API providers currently implemented by `ai-tweak` are `anthropic` and
`openai`. Endpoint access uses the OpenAI Responses API through Codex; its
`keychainRef` is optional. URLs cannot contain credentials, queries or fragments.
CLI subscription modes use the user's own installed, unmodified CLI and its own
login. The Mac app does not copy subscription credentials into its Keychain.

`check` is `null` until a test starts, then
`{id, revision, state, outcome?}`. States are `checking`, `connected`, `failed`
and `skipped`. While checking, poll `get`; repeating `check` returns the same
in-flight check. Only a successful tiny `ai-tweak-cli check` call produces
`connected`. The result is bound to the choice revision and is cleared on edit
or restart. A new choice cancels the old check. `none` returns `skipped` without
launching a model. Failure outcomes are `auth-failed`, `needs-gui-session`,
`timed-out`, `cancelled`, or `failed`; raw provider errors and transcripts never
cross the socket.

`ControlKit` exposes `ModelAccessChoice`, `ModelAccessSnapshot`,
`ModelAccessCheck`, `ModelKeychain`, and the three typed `ControlClient` methods.
Construct a choice with a fresh UUID, call `ModelKeychain.save(key, for: choice)`,
then submit that same choice. The encrypted Keychain record binds its full kind,
provider, endpoint, model and reference; existing bindings cannot be overwritten. On a socket timeout, refresh the choice before deleting an item: the
mutation may have succeeded. Keep previous key references until jobs that
snapshotted them finish. The UI owns sign-in, presentation, and polling.

### Worker boundary

The companion invokes the fixed signed app entry point `--model-worker`, sends
choice metadata on private stdin, and passes `check` or `run` arguments. The app
reads the selected Keychain item at spawn and launches its bundled
`ai-tweak-cli.js`; the secret appears only in the worker's environment. It is
never sent to the companion, put on command lines, or written to `companion.env`.
For keyed workers, the helper rejects caller environment overrides and a choice
that does not exactly match its Keychain binding. It derives the destination from
the saved record and uses app-owned HOME/PATH/temp/locale and tool paths. CLI
subscription modes inherit only HOME/PATH/temp/locale and explicit tool paths;
printer tokens and unrelated provider keys are excluded, following the
bambu-printer-mcp bridge's environment and error-handling pattern. That bridge
does not provide this app-specific model-choice or Keychain API.

The helper uses `execve` so Node retains its PID/process group. Cancellation sends
one SIGTERM, then SIGKILL after ten seconds if needed; the response wait is bounded
even if a faulty descendant holds a pipe open.

The worker receives `SCAN_TO_MAKE_AI_ACCESS`, plus model/provider/endpoint fields
as appropriate. For a referenced key, `SCAN_TO_MAKE_AI_KEY_ENV` names
`SCAN_TO_MAKE_MODEL_KEY`; only the worker receives its value. Subscription and
unauthenticated endpoint modes receive neither field. A missing/locked Keychain
item fails the check without falling back to an inherited key or subscription.

`ModelAccessService.run(args, {signal, timeoutMs})` snapshots the choice and
exposes this boundary to the cleanup job integration. It runs the existing AI
CLI, returning its exit code and bounded stdout to the local job orchestrator.
The cleanup pipeline's attempt/judge/export wiring is a separate change; this
plumbing does not substitute a model into existing scripted cleanup stages.
Non-app deployments can persist preferences but cannot resolve Mac Keychain
references; checks fail as unavailable until a signed worker is configured.


Photo imports through `objects.addFile` additionally return `photoName`, the exact sanitized/unique name
assigned to that upload. Cloud Ask answers collect those receipts and send only them as `photoNames`;
they never infer ownership from the whole project photo list. Cloud corrections send an explicit empty
`photoNames` plus their local asset paths, so only newly imported assets (and a held message's existing
owned evidence) belong to the correction. A cloud answer without text, photos or explicit Best Guess is
refused; missing downloaded assets never imply permission to guess.
