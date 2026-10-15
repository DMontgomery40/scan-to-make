# Companion preparation and intent journal

This library stages exact file bytes, binds a draft print plan to the current accepted design, and keeps a durable once-only intention journal. Its separate read-only MCP discovery entrypoint initializes a trusted local server, reads tool schemas and closes it. An opt-in loopback generation listener runs the configured local drawer generator and returns verified STL bytes. The package has **no printer tool execution, upload, print, heating or motion operation**. Creating an intent does not authorize physical dispatch.

```sh
npm ci --prefix packages/contracts --ignore-scripts
npm ci --prefix services/project --ignore-scripts
npm ci --prefix services/companion --ignore-scripts
npm test --prefix services/companion
```

Construct `new CompanionJournal(privateDirectory, projectStore)` in a trusted local companion. `stageArtifact(sourcePath, expectedArtifactRef)` copies a regular file into a unique private snapshot, verifies SHA-256 and byte length, and seals the snapshot read-only. Metadata is private; callers receive an ID and artifact identity, never a writable source location. Source changes do not alter the snapshot. Staging also accepts synthetic/nonprintable bytes: integrity is not geometry or G-code inspection.

`createPlan({projectId, snapshotId, selection})` requires the current accepted project revision and verifies the snapshot again. The plan records the accepted design identity separately from the proposed printable artifact. It includes printer ID/model, selected plate, complete declared nozzle diameters, material/tray positions, bed and settings digest. Its digest binds every field. Model names, physical tray ranges and complete filament coverage still require validation against the actual discovered MCP schema and inspected selected plate; merely storing them does not establish support. Printer IDs must come from a trusted pairing registry with one stable ID per actual printer; callers cannot choose aliases to evade the journal.

`beginAttempt(plan, approval)` rechecks the plan digest, current accepted design/revision and exact staged bytes, then flushes one intention record before returning. Approval records must name that exact plan, identify an actor, explicitly confirm, and expire within five minutes according to the companion's clock. These fields represent an authenticated human decision supplied by the caller; a model-supplied `confirmed: true` is not authorization. This method does not call a printer and does not freeze project edits. The later executor must recheck project/approval freshness and printer state after any human response and immediately before dispatch.

One unreconciled attempt blocks the printer, including a recorded `started`, `unconfirmed` or `uncertain` outcome. A new service instance reads the same history and cannot replay the old plan. `recordOutcome(printerId, attemptId, {state})` appends the observed backend classification once. Unknown responses, disconnects, crashes and generic errors must be classified as uncertain; an error is not evidence of rejection. `started` is a dispatch receipt, not physical-print or fit verification.

`reconcile(printerId, attemptId, {actorId, confirmed: true, resolution})` records an explicit operator decision (`finished`, `cancelled`, `rejected`) after checking the actual job. It preserves every original event. The old plan still cannot be retried; a new plan and fresh human approval are required. Callers authenticate the operator and verify the job evidence. Reconciliation is not automatic and cannot be delegated to a model's guess.

Files and directories use private permissions. Per-printer filesystem locks serialize readers/writers across instances; the JSONL journal is append-only and every event is flushed. Malformed history or an interrupted lock fails visibly. An operator must verify that no writer remains and inspect the actual printer/job and journal before recovering a lock. No automatic lock expiry, replay or power-loss guarantee is supplied. Use a local filesystem supporting the file/locking operations.

## Read-only MCP discovery

Import `discoverPrinterTools` and `createPreparedPrintValidator` from `@scan-to-make/companion/mcp-discovery`. Supply command, arguments, working directory and environment from trusted operator configuration, never a mobile/model request. Discovery uses the pinned MCP SDK to initialize a stdio server and collect every `tools/list` page. Limits bound time, page count, tool count, decoded catalog bytes and protocol buffer. Duplicate names, cursor loops, missing `print_3mf` or invalid print schemas reject. Cancellation and initialization failures await the same subprocess shutdown and verify actual PID disappearance, including forced termination when required. Stderr is drained without returning its possibly sensitive contents. Only detached, deeply frozen metadata escapes; there is no client or `tools/call` API.

`createPreparedPrintValidator(catalog)` checks the actual discovered public `print_3mf` input schema without coercion, defaults or mutation. It allows only `three_mf_path`, `bambu_model`, `plate_index`, `nozzle_diameters`, `bed_type`, `use_ams`, `ams_slots` and `connection_mode`. Credentials, executable/bridge overrides and all other request keys reject. Validation proves argument shape, not file existence, supported installed firmware, live identity, readiness, safety or permission to execute. The catalog can become stale and must be refreshed when the configured server changes. The journal and discovery remain separate until prepared-file inspection and authenticated execution are integrated.

Routine tests use protocol fixture subprocesses and record every received method to prove no tool is called. Separate opt-in installed-process evidence uses `BAMBU_MCP_ENTRY=/absolute/path/to/bambu-printer-mcp/dist/index.js npm test --prefix services/companion`. That test uses a private empty working/home directory, explicit empty model/serial/token, human-confirmation defaults, and a preload blocking socket connections/sends. It does not read a printer or use the user's live configuration. Without that environment variable the installed-process test is reported as skipped; fixture results do not imply it passed.

Protocol implementation uses the pinned SDK's public client/stdio APIs: [MCP client documentation](https://modelcontextprotocol.io/docs/develop/build-client). No server implementation is copied into this package.

## Checked accepted-STL export

Import `exportAcceptedStl` from `@scan-to-make/companion/stl-export` and provide the trusted project store, project ID, explicit expected revision, source path and a new output path. The accepted artifact must have media type `model/stl`. Export captures at most 32 MiB, verifies exact accepted SHA-256/length, independently parses strict single-solid ASCII STL or exact-length binary STL, and rejects empty meshes, nonfinite coordinates/normals, degenerate triangles and more than 500,000 triangles. Binary STL headers beginning with `solid` are correctly distinguished by their declared count and exact byte length.

After preparing a private flushed temporary copy, export rechecks revision and artifact acceptance, then publishes exclusively to the new destination. Concurrent exporters cannot overwrite each other, existing destination files survive, and source symlinks reject. The immutable receipt names the project/revision, exact artifact, output path, triangle count and bounds. Caller-selected paths/revision are captured before asynchronous work. Authentication and authorization of local paths belong to the trusted caller.

STL itself does not encode units: reported bounds interpret coordinates using the project's declared millimetres; this does not establish the generator's scale or frame provenance. These checks are structural sanity and exact-byte evidence. An open mesh can pass; manifoldness, intersections, wall strength, functional fit, printer-envelope/material checks and slicing remain separate. The revision-labelled export is not a lock on later project edits or later modifications to the exported file. Any print route must independently inspect its own exact snapshot after slicing. This increment enables accepted-STL export only, not checked 3MF/G-code export.

## Remaining integration gates

The existing `bambu-printer-mcp` remains a separate process. Its actual public `print_3mf` schema uses `three_mf_path`, `bambu_model`, `plate_index`, full `nozzle_diameters`, `use_ams`/`ams_slots` and model-specific `connection_mode`. Discovery validates a narrow prepared-argument projection against that schema. This package does not translate a journal plan into those arguments or send them yet.

Before enabling a print/prepared-G-code export route, integrate authenticated pairing/project access, genuine geometry and slicer provenance tying these two artifact identities together, prepared-file/selected-plate inspection, discovered model/route support, exact model/nozzle/material/AMS checks, fresh observed identity/ready/error state, human elicitation and once-only dispatch through the existing MCP gate. Unsliced input must not silently change approved bytes through auto-slicing. Accepted-STL export is available separately and does not authorize that route. Stop/cancel/heater-off in the existing MCP remain available independently of this journal and any future billing/design service.

Source baseline for protocol facts: `bambu-printer-mcp` 1.1.26, `src/index.ts` public `print_3mf` schema/handler and response handling; `src/printers/bambu.ts` returns `dispatch: started | unconfirmed`. No implementation code was copied or imported from that GPL server.

## Local drawer generation

From a source checkout with Node 22/24, Python 3 and the dependencies above installed:

```sh
npm run generate:serve --prefix services/companion
```

The CLI listens at `http://127.0.0.1:9077`. `SCAN_TO_MAKE_GENERATION_PORT` selects a different local port; `0` selects a free port printed at startup. `GET /healthz` returns the protocol version and supported templates. `POST /v1/generate` accepts `Content-Type: application/json` and `{formatVersion: "0.1.0", sourceFit: <complete ProjectFitSpec>}`. Only `drawer-tray` generation is supported. Unknown request keys, command/path overrides and unsupported fits reject. The configured Python script is resolved relative to this source checkout; a separately packaged installation must explicitly supply its trusted generator path.

The response is the portable [`GenerationResponse`](../../packages/contracts/README.md#portable-generation-protocol): full immutable source fit, exact artifact digest/length, structurally inspected geometry, generator version, square-corner assumption and canonical base64 STL. The worker keeps the supplied fit revision, including nonzero revisions. It creates no project store, changes no fit and makes no acceptance decision. Each job uses a private temporary directory and a fixed executable/script configuration; the HTTP request cannot choose those paths. The manifest must match the requested source identity and generated bytes. The returned source fit comes from the validated request snapshot, and geometry is measured independently from the verified STL snapshot.

Import `createGenerationWorker`, `GenerationFailure` or `startGenerationServer` from `@scan-to-make/companion/generation`. Trusted operator options are `executable`, absolute `generatorPath`, absolute existing `temporaryRoot`, and `timeoutMs` (1–30,000 ms). The default worker runs the repository's Python drawer generator with no shell. It drains at most 64 KiB of combined stdout/stderr before terminating, permits a 64 KiB regular manifest and a 32 MiB regular STL, and rejects symlink outputs. Deadline or cancellation kills and awaits the configured direct child before removing its private job directory. The configured generator is trusted and must not spawn detached descendants; this is not a sandbox for arbitrary executables.

The listener accepts one active generation request, including body parsing and cleanup. Request bodies are capped at 256 KiB even when chunked, with a five-second body deadline; the worker has a separate 30-second deadline. A disconnect aborts the job. The slot remains occupied until the child exits and cleanup finishes; another request receives `429 busy` during that interval. `close()` aborts active work and waits for cleanup. Responses are limited by `MAX_GENERATION_RESPONSE_BYTES`, which includes base64 expansion and metadata. Consumers must enforce that download limit before decoding JSON.

| HTTP | Error code | Meaning |
| --- | --- | --- |
| 400 | `invalid-request` | Malformed, invalid or incomplete request body |
| 403 | `forbidden` | Foreign Host or browser-origin headers |
| 404 | `not-found` | Unknown route |
| 405 | `method-not-allowed` | Generation requires POST |
| 413 | `payload-too-large` | Request exceeds its bound |
| 415 | `unsupported-media-type` | Non-JSON or compressed request |
| 422 | `unsupported-template` | Valid fit without a supported generator |
| 429 | `busy` | Another request or its cleanup is active |
| 502 | `generation-failed` | Process/startup/cancellation failure |
| 502 | `invalid-output` | Manifest, artifact integrity or STL validation failed |
| 504 | `generation-timeout` | Configured worker deadline elapsed |

Errors use `{error: {code, message}}` with fixed messages, never subprocess diagnostics or filesystem paths. The listener binds IPv4 loopback only and requires its exact `127.0.0.1:<port>` Host. Requests carrying `Origin` or `Sec-Fetch-Site` reject; no CORS is enabled. This supports direct local clients, including an iOS Simulator on the same Mac, not a browser frontend or a remote phone. It does not authenticate local processes. This is the default mode. Requests with Tailscale or forwarded-proxy headers also reject, so accidentally proxying the local listener does not grant anonymous access. The explicit private Serve mode below adds authentication; it does not change this default.

Tests exercise real Python generation through HTTP into saved-project acceptance, reopening, exact-byte checked export and edit invalidation. Native mesh rendering, durable artifact caching and sharing remain app responsibilities; these tests do not establish native or physical-fit evidence.


## Authenticated private Serve transport

Remote mode is opt-in and generation-only. It still binds **127.0.0.1**, behind an operator-managed **private HTTPS Tailscale Serve TCP proxy**. Use the existing client/setup guidance in [Tailscale setup](../../docs/tailscale-setup.md). This program never installs or configures Tailscale, obtains certificates, changes account/policy access, or enables Funnel. Public hosting, Unix-socket proxies, browser clients and tagged-node clients are unsupported.

The forwarding fixture pins [Tailscale v1.94.2, commit 2de4d3](https://github.com/tailscale/tailscale/blob/2de4d317a8c2595904f1563ebd98fdcf843da275/ipn/ipnlocal/serve.go). Its TCP proxy preserves incoming Host, sets X-Forwarded-Host and HTTPS protocol, strips supplied identity headers, and assigns the authenticated user's login. Tagged nodes lack a login; Funnel lacks a login and sets a Funnel marker. Our tests replay this **source-derived** contract; they do not prove an installed Tailscale version or a phone connection. Before enabling an actual remote listener, verify the installed version's forwarded headers with an isolated non-sensitive backend and check that private Serve, not Funnel, is configured. See [Serve identity documentation](https://tailscale.com/docs/features/tailscale-serve#identity-headers).

Every remote request must carry exactly the configured FQDN Host (without a port), matching X-Forwarded-Host, X-Forwarded-Proto: https, and one exact allowlisted ASCII Tailscale-User-Login. Missing/duplicate/wrong headers, Funnel markers, Origin and Sec-Fetch-Site reject. These headers are trusted **only because Serve forwards over loopback**. Local processes can impersonate Serve; this design assumes a trusted host and trusted local users. It is not a security boundary against local malware. Tailnet access alone is insufficient: application pairing and scoped tokens are also required. Clients must validate the normal HTTPS certificate for that exact FQDN, with no certificate-verification bypass.

### Host-local administration

After building, an operator uses the local CLI (paths below are examples). Use a private trusted parent on a local POSIX filesystem; do not put auth state in Git or a shared/synced folder. `init` requires a new absolute directory and will never overwrite existing state. Configuration changes require stopping the listener and intentionally initializing a fresh registry/re-pairing; corrupt state never falls back to local mode.

```sh
node services/companion/dist/remote-auth-cli.js init /absolute/private/auth companion.example-tail.ts.net alice@example.test
node services/companion/dist/remote-auth-cli.js pair /absolute/private/auth alice@example.test
SCAN_TO_MAKE_REMOTE_AUTH_DIR=/absolute/private/auth node services/companion/dist/generation-cli.js
node services/companion/dist/remote-auth-cli.js devices /absolute/private/auth
node services/companion/dist/remote-auth-cli.js revoke /absolute/private/auth DEVICE_UUID
```

`pair` returns a secret code and a `qrPayload` JSON string containing `{version:1, baseUrl:"https://<fqdn>", code, expiresAt}`. It is QR **payload data**, not a rendered QR image. The UI can encode that string as a QR. The code has 192 random bits, is bound to the selected login, expires after five minutes, and can be exchanged once. Display/share it only with the intended phone; do not put it in a query URL, logs, analytics or a ticket. If the response is lost, generate a fresh invitation rather than retrying a consumed code.

State uses directory mode 0700/file mode 0600, SHA-256 hashes of high-entropy codes/tokens, atomic replacement with fsync and an exclusive mutation lock. Reads reject symlinks, malformed/oversized state, wrong ownership or nonprivate permissions. A lock conflict returns 503; an interrupted lock requires the operator to verify that no writer remains before removing it. No automatic stale-lock recovery is performed. A lost store requires re-pairing. A stolen bearer token can be copied; device IDs are credential identifiers, not hardware attestation. Revoke the compromised device, and protect tokens in the phone's Keychain/Keystore.

### Phone contract

All timestamps are Unix milliseconds from the host's clock. The host clock must be correct. Scopes are host-admin assigned; phone requests cannot enlarge them. Import `RemoteAuthStore` from `@scan-to-make/companion/remote-auth` for host-local administration in an embedded companion, and pass its opened instance as `remoteAuth` to `startGenerationServer`. The CLI grants `generation:health` and `generation:create`; local library callers can issue a health-only invitation. Tokens expire after 30 days and require re-pairing. No refresh or administrative endpoint is exposed.

| Request | Requirement | Success |
| --- | --- | --- |
| POST `/v1/pair` | JSON `{code,deviceName}`; valid Serve identity | `{protocolVersion:"0.1.0",deviceId,token,expiresAt,scopes}` |
| GET `/healthz` | `Authorization: Bearer <token>`, `X-Scan-Device: <deviceId>`, `generation:health` | Existing health response |
| POST `/v1/generate` | Same credentials; `generation:create`; existing JSON generation request | Existing verified generation response |

Pairing allows five attempts per allowlisted login per minute, persisted across restart; malformed attempts count. Pair bodies are limited to 4096 bytes and five seconds. At most 8 unexpired invitations and 64 unexpired devices are retained. Unknown fields and invalid device names reject. Auth responses use no-store and opaque fixed errors: 401 `unauthorized` for rejected code/token,403 `forbidden` for identity/scope rejection, 429 `rate-limited`, 503 `auth-unavailable` for lock/storage problems. Existing media/body/route errors retain their codes. Retry a transient 503 with a short backoff; a 401 requires a new pairing or user intervention. Never silently downgrade to unauthenticated HTTP.

Each credential binds a token hash, device ID, user login, scopes and expiry. Revocation takes effect on subsequent requests and is rechecked after generation body upload. It does not cancel a generation already executing. Revoking one device does not revoke others. Print/discovery/dispatch/journal operations and local pairing/revocation administration are not HTTP routes.

Tests use isolated temporary registries and actual loopback HTTP/Python generation. They prove transport behavior, not phone onboarding, certificate provisioning, tailnet reachability, native capture accuracy or printing.
