# Local control protocol v1

The Mac app administers its companion through a Unix domain socket. The phone API remains separate: none of these methods is an HTTP or HTTPS administration route. `RemoteAuthStore` supplies pairing/device administration, the existing stores supply job records, and the same printer-handoff relay serves confirmations from both phone and Mac. The relay preserves bambu-printer-mcp's original message, schema, photo and human answer; it does not duplicate slicing, editing, safety or print dispatch.

## Endpoint and framing

An authenticated companion starts `<auth directory>/control.sock`. `SCAN_TO_MAKE_CONTROL_SOCKET` can override this with an absolute pathname for isolated installations. There is no TCP fallback. The immediate directory must be owned by the companion user and have no group/other permissions; the socket is mode `0600`. Existing unrelated files, symlinks and live sockets are never replaced. A process lock serializes startup; a refused stale socket owned by the same user can be reclaimed. Shutdown removes the listening socket.

Use UTF-8 NDJSON, **one request and one reply per connection**. Keep reading after sending the newline; half-closing the write side is supported. Request maximum is 64 KiB including newline; reply maximum is 8 MiB including newline. Connection deadline is 10 seconds, with at most 16 connected or executing requests. Unix paths are limited to 103 UTF-8 bytes for macOS portability. The socket boundary trusts the current OS user, not arbitrary local users or browsers.

```json
{"v":1,"id":"00000000-0000-4000-8000-000000000001","method":"status.get","params":{}}
{"v":1,"id":"00000000-0000-4000-8000-000000000001","result":{"protocolVersion":1,"companionVersion":"0.1.0","transport":"lan","pairedDeviceCount":0,"capabilities":{"capture":true,"cleanup":false,"printerHandoff":false}}}
```

Errors use `{v:1,id,error:{code,message}}`; malformed envelopes may have `id:null`. Codes are `invalid-request`, `unsupported-version`, `not-found`, `conflict`, `unavailable`, and `internal`. Messages never include input, private paths or provider diagnostics. Requests reject unknown methods, fields and parameters. IDs are UUIDs and replies echo them. Stored schema failures return `unavailable`; they do not blame a valid request. Connection IDs are correlation identifiers, **not idempotency keys**. A disconnect or deadline after sending a mutation has an unknown outcome: inspect current state, and never replay it automatically.

## Methods

| Method | Parameters | Result |
|---|---|---|
| `status.get` | `{}` | Protocol/companion version, transport, paired device count and capability booleans as above. |
| `jobs.list` | `{projectId?,cursor?,limit?}` | `{items:[{kind,projectId,projectName,job}],nextCursor?}`. Default limit 50; range 1–100. |
| `devices.list` | `{}` | `{devices:[{deviceId,deviceName,scopes,pairedAt,lastRefreshedAt,expiresAt,pairedVia:{transport,login}}]}`. No tokens or token hashes. |
| `devices.remove` | `{deviceId}` | `{removed:true}`; an unknown device returns `not-found`. Existing device credentials are revoked. |
| `pairing.create` | `{login?}` | Existing invitation `{version:1,baseUrl,code,expiresAt,certificateSha256?,qrPayload}` with capture and printer-handoff scopes. LAN selects `lan`; Tailscale defaults to the first retained allowed login. An explicit login must be allowed. When the companion answers on every address (`SCAN_TO_MAKE_LAN_ALL_ADDRESSES=1`), `qrPayload` is a pairing link v2 (`@scan-to-make/contracts/pairing-link`) listing those addresses; the JSON fields keep their v1 shape. |
| `pairing.isActive` | `{code}` | `{active:boolean}`; false after consumption or expiry. |
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
