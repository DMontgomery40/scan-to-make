# Companion

The companion runs on the user's own computer. It receives LiDAR captures and close-up stills from the phone, converts captures to meshes and runs scan cleanup (`tools/scan-repair`) as retained jobs. With the optional printer-handoff configuration it can also hand a clean mesh to the operator-installed [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp) or [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server) for slicing and printing, relaying that server's confirmations to the phone (see Printer handoff below).

```sh
npm ci --prefix packages/contracts --ignore-scripts
npm ci --prefix services/project --ignore-scripts
npm ci --prefix services/companion --ignore-scripts
npm test --prefix services/companion
```

## Run the listener

```sh
npm run serve --prefix services/companion
```

`dist/server-cli.js` binds `127.0.0.1:9077`; `SCAN_TO_MAKE_GENERATION_PORT` overrides the port (the variable keeps its original name so existing setups still start). Without further configuration it answers only a loopback `GET /healthz` with `{status:"ok",protocolVersion:"0.1.0"}`. The variables below turn on the authenticated routes:

| Variable | Enables |
| --- | --- |
| `SCAN_TO_MAKE_REMOTE_AUTH_DIR` | Paired LAN TLS or private Serve authentication (below) |
| `SCAN_TO_MAKE_CAPTURE_DIR` | Saved-project sync, capture import and detail stills; requires authentication |
| `SCAN_TO_MAKE_CAPTURE_PYTHON` | The Python 3.12 environment with `usd-core==26.8` used for conversion and cleanup |
| `SCAN_TO_MAKE_SCAN_REPAIR_TOOL`, `SCAN_TO_MAKE_SCAN_BLENDER` | Scan processing (see [SCAN-PROCESSING.md](SCAN-PROCESSING.md)) |
| `SCAN_TO_MAKE_PRINTER_HANDOFF_CONFIG`, `SCAN_TO_MAKE_PRINTER_HANDOFF_DIR` | Printer handoff bundles and elicitation relay (below); both required together, and authentication |

## Existing LAN or VPN transport

Phones that already reach the companion LAN through a VPN can pair directly,
without Tailscale. Host administration is explicit:

```sh
python3 deploy/companion/generate-lan-tls.py /absolute/private/tls 192.168.1.10
node services/companion/dist/remote-auth-cli.js init-lan /absolute/private/auth \
  https://192.168.1.10:9077 /absolute/private/tls/cert.pem
export SCAN_TO_MAKE_REMOTE_AUTH_DIR=/absolute/private/auth
export SCAN_TO_MAKE_LAN_TLS_CERT=/absolute/private/tls/cert.pem
export SCAN_TO_MAKE_LAN_TLS_KEY=/absolute/private/tls/key.pem
node services/companion/dist/server-cli.js
# Separately, on the same host:
node services/companion/dist/remote-auth-cli.js pair-capture /absolute/private/auth
```

The listener binds the configured private IPv4 address. It requires TLS with the
exact certificate recorded at initialization, rejects proxy identity headers,
and requires a paired device token for every API except the one-time pairing
exchange. There is no silent fallback from Serve and no anonymous capture mode.
The synthetic `lan` identity binds invitations/devices to this local registry;
it is not an identity-provider login. Tailscale mode still checks Serve identity.

LAN invitations include `certificateSha256`, the lowercase SHA-256 of the DER
leaf certificate, and add `f` with that value to the deep-link query. The phone
must verify that certificate before transmitting the code, store the pin with
the credential, and check it for all subsequent requests. A LAN URL without the
pin is not a complete invitation. Tailscale invitations omit it and use normal
platform trust. The same five-minute expiry, single use, scopes, revocation and
rate limits apply. In LAN mode the five pairing attempts per minute are shared
by every client, rather than allocated per device; an already paired phone can
still use its token when that pairing limit is reached. IPv6 and DNS-named LAN certificates are not supplied by this
installer. See the [installer](../../deploy/companion/README.md#macos).

## Authenticated private Serve transport

Remote mode is opt-in. It still binds **127.0.0.1**, behind an operator-managed **private HTTPS Tailscale Serve TCP proxy**. Use the existing client/setup guidance in [Tailscale setup](../../docs/tailscale-setup.md). This program never installs or configures Tailscale, obtains certificates, changes account/policy access, or enables Funnel. Public hosting, Unix-socket proxies, browser clients and tagged-node clients are unsupported.

The forwarding fixture pins [Tailscale v1.94.2, commit 2de4d3](https://github.com/tailscale/tailscale/blob/2de4d317a8c2595904f1563ebd98fdcf843da275/ipn/ipnlocal/serve.go). Its TCP proxy preserves incoming Host, sets X-Forwarded-Host and HTTPS protocol, strips supplied identity headers, and assigns the authenticated user's login. Tagged nodes lack a login; Funnel lacks a login and sets a Funnel marker. Our tests replay this **source-derived** contract; they do not prove an installed Tailscale version or a phone connection. Before enabling an actual remote listener, verify the installed version's forwarded headers with an isolated non-sensitive backend and check that private Serve, not Funnel, is configured. See [Serve identity documentation](https://tailscale.com/docs/features/tailscale-serve#identity-headers).

Every remote request must carry exactly the configured FQDN Host (without a port), matching X-Forwarded-Host, X-Forwarded-Proto: https, and one exact allowlisted ASCII Tailscale-User-Login. Missing/duplicate/wrong headers, Funnel markers, Origin and Sec-Fetch-Site reject. These headers are trusted **only because Serve forwards over loopback**. Local processes can impersonate Serve; this design assumes a trusted host and trusted local users. It is not a security boundary against local malware. Tailnet access alone is insufficient: application pairing and scoped tokens are also required. Clients must validate the normal HTTPS certificate for that exact FQDN, with no certificate-verification bypass.

### Host-local administration

After building, an operator uses the local CLI (paths below are examples). Use a private trusted parent on a local POSIX filesystem; do not put auth state in Git or a shared/synced folder. `init` requires a new absolute directory and will never overwrite existing state. Configuration changes require stopping the listener and intentionally initializing a fresh registry/re-pairing; corrupt state never falls back to local mode.

```sh
node services/companion/dist/remote-auth-cli.js init /absolute/private/auth companion.example-tail.ts.net alice@example.test
node services/companion/dist/remote-auth-cli.js pair-capture /absolute/private/auth alice@example.test
SCAN_TO_MAKE_REMOTE_AUTH_DIR=/absolute/private/auth node services/companion/dist/server-cli.js
node services/companion/dist/remote-auth-cli.js devices /absolute/private/auth
node services/companion/dist/remote-auth-cli.js revoke /absolute/private/auth DEVICE_UUID
```

`pair-capture` and `pair-capture-and-printer-handoff` render a QR in the terminal
(stderr) and start a short-lived page
at the printed `http://127.0.0.1:<port>/pair` address. Scan either QR with the iPhone
Camera app to open Scan to Make. The app must support the `scantomake` deep link.
The page stays on loopback, is never forwarded through Serve, and removes the QR
on its next refresh after use or expiry. It sends no-store, rejects foreign Host,
Origin and proxy headers, and closes no later than ten seconds after expiry.

Stdout remains one invitation JSON object containing `version`, `baseUrl`, `code`
and `expiresAt`, plus `qrPayload` and (when the page starts) `pairingPageUrl`.
Existing JSON-paste clients continue to work. `qrPayload` is now the deep link
`scantomake://pair?v=1&u=<encoded-HTTPS-base-URL>&c=<code>&e=<expiry-ms>`;
parameters use `URLSearchParams` encoding. This replaces the former JSON string
in that field. Terminal/page generation uses pinned MIT-licensed `qrcode`; its
licence is included in the installed npm package and checked by the repository audit.

The code has 192 random bits, is bound to the selected login, expires after five
minutes, and can be exchanged once. The QR and invitation are credentials: keep
them out of logs, analytics and tickets. The display child receives the invitation
through private IPC, not process arguments, environment or a disk file. If QR
startup fails, the CLI still returns the JSON invitation. If the response is lost,
generate a fresh invitation rather than retrying a consumed code.

State uses directory mode 0700/file mode 0600, SHA-256 hashes of high-entropy codes/tokens, atomic replacement with fsync and an exclusive mutation lock. Reads reject symlinks, malformed/oversized state, wrong ownership or nonprivate permissions. A lock conflict returns 503; an interrupted lock requires the operator to verify that no writer remains before removing it. No automatic stale-lock recovery is performed. A lost store requires re-pairing. A stolen bearer token can be copied; device IDs are credential identifiers, not hardware attestation. Revoke the compromised device, and protect tokens in the phone's Keychain/Keystore.

### Phone contract

All timestamps are Unix milliseconds from the host's clock. The host clock must be correct. Scopes are host-admin assigned; phone requests cannot enlarge them. Import `RemoteAuthStore` from `@scan-to-make/companion/remote-auth` for host-local administration in an embedded companion, and pass its opened instance as `remoteAuth` to `startCompanionServer` (`@scan-to-make/companion`). A phone pairing (`pair`, `pair-capture-and-printer-handoff`, or `createPairing` with no scopes) grants `PHONE_SCOPES` from `@scan-to-make/contracts/device-auth`: `generation:health`, the project and capture scopes listed below, and `printer-handoff:use`. `pair-capture` grants the same without printing. The health scope keeps its original name so existing pairings and phone keychain records still parse. A credential expires 30 days after pairing or its last refresh; `POST /v1/auth/refresh` gives a live credential another 30 days with the same token, and an expired or revoked one must pair again. No administrative endpoint is exposed.

| Request | Requirement | Success |
| --- | --- | --- |
| POST `/v1/pair` | JSON `{code,deviceName}`; valid Serve identity | `{protocolVersion:"0.1.0",deviceId,token,expiresAt,scopes}` |
| GET `/healthz` | `Authorization: Bearer <token>`, `X-Scan-Device: <deviceId>`, `generation:health` | `{status:"ok",protocolVersion:"0.1.0"}` |
| POST `/v1/auth/refresh` | `Authorization: Bearer <token>`, `X-Scan-Device: <deviceId>`; a live credential; an empty body (400 otherwise) | The same shape as `/v1/pair`: same `deviceId`, `token` and `scopes`, `expiresAt` 30 days from now. Refreshing again within an hour returns the current expiry without a write |

Pairing allows five attempts per allowlisted login per minute, persisted across restart; malformed attempts count. Pair bodies are limited to 4096 bytes and five seconds. At most 8 unexpired invitations and 64 unexpired devices are retained. Unknown fields and invalid device names reject. Auth responses use no-store and opaque fixed errors: 401 `unauthorized` for rejected code/token,403 `forbidden` for identity/scope rejection, 429 `rate-limited`, 503 `auth-unavailable` for lock/storage problems. Existing media/body/route errors retain their codes. Retry a transient 503 with a short backoff; a 401 requires a new pairing or user intervention. Never silently downgrade to unauthenticated HTTP.

Each credential binds a token hash, device ID, scopes and expiry. It is not bound to the network path: the same credential works through any allowed path (the LAN, a VPN, or any allowlisted Tailscale login), and a path whose login is not allowed is refused before the credential is checked. Pairing codes stay bound to the login that created them. The store records `pairedAt`, `lastRefreshedAt` and `pairedVia` (transport and login) for the device list only. Revocation takes effect on subsequent requests. Revoking one device does not revoke others. Local pairing and revocation administration are not HTTP routes.

**Store version 2.** Opening a version 1 store (`auth.json` written before auth v2) migrates it in place; if the lock is busy then, the next successful write migrates it, and reads work on the version 1 file meanwhile. Every device keeps its ID, token hash, scopes and expiry, so paired phones keep working with no new scopes. Using a credential never writes; only pairing, refresh, revocation and listing do. The migrating write first keeps the exact version 1 bytes as `auth.v1.json` (mode 0600, written to a temporary file and linked into place, so it is complete or absent); if an older, different `auth.v1.json` exists, the new one is `auth.v1-<SHA-256 prefix>.json`. A companion or `remote-auth-cli.js` built before auth v2 cannot read a version 2 store and fails closed (auth unavailable). To roll back, stop the companion, restore `auth.v1.json` as `auth.json`, and run the older build; devices paired after the migration are lost. Any other version fails closed and is left untouched.

Tests use isolated temporary registries and actual loopback HTTP. They prove transport behavior, not phone onboarding, certificate provisioning, tailnet reachability or native capture accuracy.

## Retained capture ingestion

`@scan-to-make/companion/capture-import` exports `CaptureStore`; `capture-converter` exports `createCaptureConverter`. These are host-local library APIs; the listener exposes them only through the authenticated routes below.

Use a trusted private parent on a local POSIX filesystem for project storage, retained captures and temporary worker files. Configure a Python 3.12 environment with `usd-core==26.8`; pass its executable to `createCaptureConverter`. The adapter uses this checkout's capture-pipeline input validation and capture-mesh-convert implementation. Executable, adapter and storage paths are operator configuration, never request parameters. Windows, network filesystems and hostile local writers are unsupported.

Import takes `{projectId, projectRevision, source: Uint8Array}` and an optional abort signal. It snapshots the original bytes, converts in a separate bounded worker, verifies the source/output/report identities and authored coordinate basis, then publishes one immutable bundle by atomic rename under the same project lock used by edits. The default limits are 32 MiB source, 64 MiB derived output, 1 MiB report, 64 KiB combined diagnostics and a 60-second worker deadline. Python also enforces CPU/file-size limits and archive expansion bounds. The host must budget aggregate concurrency and memory when exposing this library to clients.

`loadCapture(projectId, projectRevision, captureId)` reads and re-verifies retained original, mesh, report and binding bytes against the current project revision. An edit invalidates use of older attachments but preserves their historical bytes. Multiple captures can belong to one revision; import does not increment the project revision or automatically select a capture. Stale-project, corruption, worker failure and pre-commit cancellation reject. Publication is the commit point; an abort after publication cannot roll it back. A filesystem durability failure after rename can leave an immutable bundle despite a rejected call; no automatic retry/deduplication protocol is promised by this local API.

Metric qualification means authored units and supported conversion, with physical accuracy, completeness and fit still unknown. A submitted receipt alone never establishes trusted conversion.

The suite always includes an actual USDZ conversion/import/reopen test and malformed-input rejection. Install the Python dependency before running it; there is no fallback skip when it is missing:

```sh
CAPTURE_TEST_PYTHON=/absolute/venv/bin/python npm test --prefix services/companion
```

## Authenticated project and capture routes

The same private Serve listener can opt into project/capture storage with `SCAN_TO_MAKE_CAPTURE_DIR=/absolute/private/capture-data`; `SCAN_TO_MAKE_REMOTE_AUTH_DIR` is required. The capture directory contains portable projects, immutable capture bundles and temporary workers. Set `SCAN_TO_MAKE_CAPTURE_PYTHON` to the Python environment with usd-core26.8. Invalid or empty capture configuration fails startup.

Host-local `remote-auth-cli.js pair-capture <auth-directory> <login>` creates an invitation with `generation:health`, `projects:read`, `projects:write`, `captures:read` and `captures:import`. Devices paired with narrower scopes do not gain capture access; pair them again with `pair-capture`. All routes retain the exact Host, private Serve forwarding, login, token, revocation and browser-origin checks described above. No service configures tailnet access or provisions credentials automatically.

| Route | Permission and input | Result |
|---|---|---|
| `GET /v1/saved-projects/:id` | `projects:read` | Exact portable 0.2 JSON and strong `ETag` |
| `PUT /v1/saved-projects/:id` | `projects:write`, JSON snapshot, create-only `If-None-Match: *` or current `If-Match` | 201 created or 200 replaced, exact JSON and new ETag |
| `POST /v1/saved-projects/:id/captures?projectRevision=N` | `captures:import`, raw `model/vnd.usdz+zip`, current `If-Match` | 201 `{captureId, binding}` |
| `GET /v1/saved-projects/:id/captures/:captureId?projectRevision=N` | `captures:read`, current `If-Match` | Verified `{captureId, binding}` |
| `GET /v1/saved-projects/:id/captures/:captureId/artifacts/:kind?projectRevision=N` | `captures:read`, current `If-Match`; kind `original`, `derived` or `report` | Exact bytes, media type, Content-Length and X-Content-SHA256 |

Snapshot synchronization preserves nonzero revisions, and keeps any fit, preview and acceptance data written by earlier app versions unchanged. Updates require exact-byte ETags; backward revision or same-revision/different-content returns409, stale ETag412, missing precondition428. Missing projects return404; corrupt/unavailable project storage503. Invalid capture data or retained capture corruption returns422.

Native clients retain the acknowledged remote ETag and snapshot separately from the portable project. Preserve local edits made while a request is in flight; never overwrite them with a delayed response. Conflicts require explicit reconciliation. Exact equal snapshots with a current ETag are idempotent; **capture POST has no automatic retry guarantee**. A lost response may follow a committed bundle, so do not automatically retry an ambiguous import.

Bodies have a five-second deadline and limits of4MiB for snapshots and32MiB for captures, enforced for chunked requests too. One snapshot/capture request owns the capture slot through conversion and response cleanup; another receives429. Downloads have a30-second response deadline and hold the project edit lock through response flush. Concurrent edits can report storage unavailable while that lock is held. Disconnect/shutdown aborts active conversion and waits for cleanup. Authorization is checked again before capture publication and before download; ETag/revision are checked under the project lock. These tests model private Serve headers locally; they do not establish a live phone/tailnet connection.

## Detail stills

Close-up photos attached to a retained capture use the same storage,
scopes and ETag conventions. See [DETAIL-STILLS.md](DETAIL-STILLS.md) for
the storage layout, the four routes (`POST`/`GET` collection, `GET`/`DELETE`
one still), the 25 MiB and 24-per-capture limits, and error codes.


## Retained scan processing

Host-configured capture import, Blender repair, close-up advice, correction,
measurement and ten canonical views run as one preview-only capture job. See
[SCAN-PROCESSING.md](SCAN-PROCESSING.md) for configuration, routes, retention,
resource bounds and tests.

## Printer handoff

Optional routes hand a clean STL to the operator-installed printer MCP
server (bambu-printer-mcp or mcp-3D-printer-server) through the
`@scan-to-make/printer-handoff` client. The backend, MCP process command and
printer selection come only from the operator config file named by
`SCAN_TO_MAKE_PRINTER_HANDOFF_CONFIG` (see that package's README for its
schema); bundles are stored under `SCAN_TO_MAKE_PRINTER_HANDOFF_DIR`. The
phone never chooses the backend, process or printer. Every route requires
the `printer-handoff:use` scope, granted explicitly by host-local
`remote-auth-cli.js pair-printer-handoff <auth-directory> <login>`, which
grants only that scope plus health (capture pairings do not gain it, and a
handoff pairing does not gain capture access).
For a phone that captures and hands off with its single companion credential,
use `remote-auth-cli.js pair-capture-and-printer-handoff <auth-directory> <login>`
to explicitly grant both sets of scopes in one invitation.

| Route | Behaviour |
| --- | --- |
| `POST /v1/printer-handoff/bundles` | Raw `model/stl` body (64 MiB bound); optional percent-encoded `x-handoff-prompt` header. Returns `201 {bundle}` in the configured backend/selection |
| `GET /v1/printer-handoff/bundles` | `{bundles}` manifests, verified on read |
| `GET /v1/printer-handoff/bundles/:id` | `{bundle, printing}` |
| `POST /v1/printer-handoff/bundles/:id/print` | Starts the slice, inspect and print run; `202 {bundleId, printing:true}`. One print at a time (`409 print-busy`); poll the bundle for `sliced`/`printed`/`failed` |
| `GET /v1/printer-handoff/elicitations` | `{elicitations}` pending printer-server confirmations, including any camera snapshot |
| `POST /v1/printer-handoff/elicitations/:id/respond` | JSON `{action:"accept",content}` or `{action:"decline"\|"cancel"}`. `404 elicitation-not-pending` once answered or expired |

Use bundle and elicitation IDs exactly as returned (lowercase UUIDs).
`printed` records a successful printer MCP call, not physical print completion.
If saving the resulting artifacts fails, the bundle retains `printed` with a
sanitized `failure` code and rejects another print with `409 already-printed`.
If even the manifest cannot be saved, that dispatch status and retry guard
remain in memory for the companion process lifetime; they are not a durable
receipt across a restart while storage is unavailable.

Confirmations are never answered by the companion itself: an unanswered
prompt expires as cancel. A desktop agent with filesystem access to the
bundle directory may claim a bundle and add a designed STL locally; the
companion then runs the final slice and print so elicitation still reaches
the phone.

A bundle is durably marked `uncertain` immediately before the printer tool call.
A lost response, server crash, or timeout leaves `failure: dispatch-uncertain`;
`POST .../print` refuses that bundle with HTTP 409, including after restart.
Check the printer before preparing another handoff. Pre-call failures and declined
confirmations remain `failed` and retryable. A successful retry clears its old
failure code. `printed` with a failure code means dispatch succeeded but saving
outputs failed; it is also not retryable.
