# Hosted service architecture

Status: design proposal. The only code is the local-dev skeleton in
[`services/hosted/`](../services/hosted/); nothing here is deployed, and no
paid cloud resources exist. Provider choices are deliberately left open where
they do not change the contracts (see "Decisions needed" at the end).

## Product shape

Scan to Make is a $10–20 consumer app with a free trial: scan an object,
describe an addition, make something that fits, print it. Phones cannot run
the heavy stages well (USD conversion, Blender repair/measure/render, AI
correction, slicing), so the paid hosted service supplies inference and
compute. The same core stays self-hostable: everything the hosted service
runs is the companion pipeline behind the same contracts, so a self-hoster
with a Mac/PC gets the same results without an account, and the app cannot
tell the difference except for how it authenticates.

```text
phone app ──HTTPS──> hosted API ──> job queue ──> workers
   │                     │              │          ├─ convert (usd-core)
   │                     │              │          ├─ scan-processing (Blender, server-side only)
   │                     ├─ accounts    │          ├─ AI correction (model APIs)
   │                     ├─ metering    │          ├─ design generation (templates)
   │                     └─ metadata DB │          └─ slicing (prepared-file production)
   │                                    │
   └──signed URLs──> object storage <───┘   (captures, stills, meshes, artifacts)

self-host: phone app ──private Serve──> companion on the user's computer
           (same routes, same contracts, pairing instead of accounts)
```

Printing never moves to the cloud. Physical dispatch stays on the user's
companion through the existing printer-adapter contract, with its inspection,
fresh printer state, human approval and once-only journal. Hosted output that
leads to a print (prepared files) is downloaded to the local companion first.

## Same contracts, same pipeline

The hosted API serves the same route families and payload schemas as the
companion, from the same `@scan-to-make/contracts` package. Nothing in the
contracts changes for hosted; only the backing implementations differ.

| Capability | Self-host (today) | Hosted |
|---|---|---|
| Project sync | `GET/PUT /v1/saved-projects/:id`, ETag `If-Match` | Same routes and semantics; bytes in object storage, index in Postgres |
| Capture import | `POST .../captures`, local usd-core worker | Same route; conversion becomes a queued job |
| Detail stills | `POST/GET/DELETE .../detail-stills` | Same routes; bytes in object storage |
| Scan processing | `POST/GET/DELETE .../scan-processing`, local Blender | Same routes; Blender worker pool |
| AI correction | Companion job wrapping `tools/scan-correct` (planned) | Same job shape; model-API worker pool |
| Design generation | `POST /v1/generate`, local template workers | Same request/response; template worker pool |
| Prepared jobs | Host-local production + verified download | Slicing worker produces; download and print stay local |
| Print dispatch | Local companion + printer adapter, human approval | Unchanged; never hosted |

Two consequences are load-bearing:

- **The app needs one client implementation.** The typed clients in
  `apps/mobile/src/{capture,stills,processing,prepared}` already take an
  injected transport and an acknowledged `{etag, snapshot}`. Hosted support
  is a second transport + base URL, not a second protocol.
- **Asynchronous stages keep the scan-processing job shape** (start → 202
  with a durable job id → poll → hash-verified artifact download → DELETE to
  cancel), including the no-automatic-retry rule for ambiguous starts. The
  companion's single-worker-per-capture rule becomes a per-capture
  serialization constraint in the queue, not a global bottleneck.

## Accounts and auth

The companion's pairing model maps cleanly onto hosted accounts:

- **Account identity** via an OIDC provider (email magic link and/or
  passkeys; social login optional). The API never sees passwords.
- **Devices** are registered per account, reusing the pairing ideas the app
  already implements: a stable device id, scoped credentials, expiry,
  per-device revocation. A device credential is a short-lived access token
  (minutes) plus a rotating refresh token stored in the phone
  Keychain/Keystore — the hosted analogue of the companion's scoped Bearer
  token and `X-Scan-Device` header, with the same scope vocabulary
  (`projects:read`, `captures:import`, `prepared-jobs:read`, …).
- **Entitlement** (trial, subscribed, lapsed) is server-side state derived
  from billing webhooks plus the metering ledger. The app only displays it;
  it never asserts it. Paid endpoints check entitlement and meter before
  accepting work, exactly as companion routes check scopes before reading a
  body.
- Authorization is per-account on every object: project ids are only unique
  within an account, and every storage key, queue job and download is
  account-scoped. There is no cross-account sharing in v1.

Abuse controls reuse the companion's fail-closed posture: per-account and
per-device rate limits, the existing contract size bounds (32 MiB captures,
25 MiB stills, 160 MiB scan outputs), and pairing-style attempt limits on
auth endpoints.

## Object storage and metadata

Bytes and facts stay separate, as they already do on disk in the companion:

- **Object storage** (S3-compatible) holds every content-addressed byte
  blob: project snapshots, capture originals/derived meshes/reports, detail
  stills, scan-processing artifacts, prepared printable files. Keys are
  `<account>/<project>/<capture>/<sha256>`-shaped; the artifact identities
  in the contracts (`{sha256, byteLength, mediaType}`) remain the authority,
  verified on upload and on every worker read, exactly as the companion
  rehashes retained files. Phones upload/download through short-lived signed
  URLs issued after an authorized API call, so large bytes never transit the
  API tier; small JSON stays on the API.
- **Postgres** holds accounts, devices, entitlements, project/capture/job
  indexes, and the metering ledger. The portable project snapshot remains
  the sync unit (same ETag conflict rules: 409/412/428), so offline edits
  and conflict handling in the app are unchanged.
- Encryption at rest via the storage provider, TLS everywhere, and
  per-account deletion that removes both rows and blobs. Captures are
  photos and scans of people's homes: they are never used for model
  training without separate explicit consent, and worker logs carry job
  ids and byte counts, never image or mesh content (the companion already
  never returns subprocess diagnostics; hosted keeps that rule).

## Job queue and workers

Every expensive or subprocess-backed stage is a queued job with a durable
record, mirroring `ScanProcessingStore`:

- **Queues per stage family** (convert, scan-processing, AI correction,
  design generation, slicing), at-least-once delivery, with the job id as
  the idempotency key. A redelivered job finds its retained outputs and
  returns them instead of re-running, the same recovery rule the companion
  uses for prepared jobs and scan records.
- **Job records are the contract records** (`ScanProcessingJob` and its
  successors), stored in Postgres with artifact identities pointing at
  object storage. Status reads are cheap and never blocked by a running
  worker; publication is still the atomic commit point, and a changed
  project revision fails publication rather than rebinding results.
- **Per-capture serialization, per-account fairness.** At most one active
  processing job per capture (contract rule today), at most a small number
  of concurrent jobs per account, and a fair-share scheduler across
  accounts so one trial user cannot starve subscribers.
- **Cancellation** marks the job, aborts the worker's process group, and
  awaits cleanup before reporting the terminal record — the hosted version
  of the companion's cancel, with the worker pool replacing the single
  in-process registry.
- **Crash recovery** treats a worker death like the companion treats a dead
  lock owner: the job becomes `failed/interrupted`, never silently resumed,
  and orphaned subprocess groups are reaped by the worker supervisor.
  The user explicitly starts a new job.

### What runs where

| Worker | Runs | Placement rule |
|---|---|---|
| Convert | `usd-core` capture-mesh-convert/pipeline | Server or self-host; identical code |
| Scan-processing | `tools/scan-repair` under Blender 5.0.1 (GPL-3.0-or-later) | **Server-side only** in hosted; never bundled into the app |
| AI correction | WS3 `tools/scan-correct` runner + hosted model APIs | Server-side for hosted; self-host supplies its own model access |
| Design generation | Template workers (drawer, cup-holder, …) | Either; pure compute on validated FitSpecs |
| Slicing | Prepared-file production + file-only inspection | Server produces; print dispatch stays local |

Blender deserves its own note: `tools/scan-repair` invokes Blender as a
separate process and is GPL-3.0-or-later (see its README). In the hosted
build it runs only on our workers, in its own service boundary, invoked the
same way the companion invokes it — no Blender code ships in the phone app,
and no app binary links it. Self-hosters install their own Blender exactly
as today. Any future change that would distribute Blender (or a modified
scan-repair) to user devices needs a fresh licensing review first; it is
out of scope here.

Workers are stateless beyond a job scratch directory: inputs are fetched by
artifact identity and verified, outputs are written back and rehashed before
the job record commits them. The existing resource bounds carry over as
worker sandbox limits (per-stage deadlines, log caps, output byte caps,
disk watchdogs), enforced by the worker runtime rather than one Node
process.

## Model APIs, keys and cost controls

AI correction (and any future model-backed stage) is the only place hosted
spend can grow per request, so it gets explicit controls:

- **Keys live server-side only**, in the deployment's secret manager,
  injected into worker processes at runtime. Keys never reach the phone,
  never appear in job records, logs or error responses, and rotate without
  an app release. Self-hosting keeps today's model: the operator supplies
  their own key to their own companion; the hosted key grants nothing there.
- **Per-account cost budgets.** Every model call is attributed to
  `(account, job, stage)` in the metering ledger with its provider-reported
  usage where available. Accounts have a hard monthly budget (by plan) and
  per-job caps (max stills compared, max correction rounds — bounds the
  WS3 runner must accept as parameters); a job that would exceed its cap
  fails before the call, not after.
- **Choice of model is a server-side, versioned config**, recorded on the
  job (provider, model id, prompt/runner version) so results stay
  reproducible and A/B rollback is possible. The app never names a model.
- **Provider outage behaviour** is a job failure with the existing generic
  failure record, never a silent fallback to a different model or to
  uncorrected geometry presented as corrected.

## Free-trial metering

The trial is a grant of metered units, not a timer, so it survives slow
experimentation and is trivially explainable in the app ("3 of 10 free scan
jobs left"):

- **Units** are the job families users perceive as value:
  `scan-processing`, `ai-correction`, `design-generation`, `slicing`.
  Sync, still uploads and status reads are unmetered (bounded by storage
  and rate limits instead).
- **The ledger is append-only** (`account, unit, job id, recorded at`),
  written in the same transaction that accepts the job. A job that fails
  for our reasons (interrupted, worker crash, provider outage) is
  comped automatically by a compensating entry; a user-cancelled job
  still counts once work has started. Trial checks and records use exactly
  the `check`/`tryRecord` shape prototyped in
  `services/hosted/src/metering.ts`.
- **Trial grant → subscription.** When a unit's trial balance hits zero,
  that family returns a typed `402`-style entitlement error (code
  `trial-exhausted`) the app already knows how to surface as a paywall;
  other families keep working. Subscribing flips entitlement via the
  billing webhook; balances become plan budgets, with the same ledger
  continuing for cost attribution. Lapsed accounts keep read access to
  their projects and artifacts (export is never paywalled) but cannot
  start new metered jobs.
- Trial abuse (many accounts per person) is bounded by the usual means —
  email/device signals and rate limits — accepting that a determined user
  can self-host for free anyway; the trial protects margin, not secrecy.

## Rollout, in dependency order

1. **Skeleton + identity**: this package grows auth and the health probe
   becomes the app's hosted-reachability check; app gains a hosted
   transport beside the companion one.
2. **Sync + storage**: project sync, capture import and detail stills on
   object storage (no workers beyond convert). Self-host companion remains
   the reference implementation; a shared HTTP contract test-suite runs
   against both.
3. **Scan-processing workers**: queue + Blender pool, metering in
   observe-only mode (record, never block) to calibrate trial sizes.
4. **AI correction + enforcement**: WS3 runner behind the same job shape;
   trial limits become hard; per-account budgets and alerts on.
5. **Design + slicing workers, billing webhooks**, then public trial.

Each phase keeps the self-host path working unchanged; hosted is additive.

## Decisions needed (not made here)

- Cloud and regions (data residency for household scans), Postgres and
  queue providers, OIDC provider.
- Billing surface: App Store IAP vs web checkout (drives entitlement
  webhook shape and store policy review).
- Trial sizes per unit and plan prices against measured worker/model cost.
- Whether converted/processed artifacts get CDN delivery or stay on signed
  URLs only.
- Desktop self-host packaging (the companion today is a from-source Node
  service; a packaged installer is a separate product decision).
