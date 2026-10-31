# Prepared print jobs

`PreparedJobStore` (`src/prepared-jobs.ts`) turns an accepted portable saved
project plus exact printable bytes and a printer selection into one durable,
digest-sealed prepared job, and records at most one human-approved dispatch
intent for it. It never dispatches a print, slices anything, or observes hardware state. An
operator can configure a trusted file-only MCP inspector before preparing jobs.

## What a prepared job binds

Each job is one directory named by its UUID:

- `printable.bin` — the exact printable bytes the caller supplied, fsynced and
  stored read-only. The caller also declares the expected artifact identity
  (SHA-256, byte length, media type); bytes that do not match that declaration
  are rejected before anything is committed.
- `job.json` — the validated job record: project id and portable-project
  revision, the design artifact taken from the project's *current accepted
  artifact* (never from the caller), the printable artifact identity, and the
  full print selection (printer, model, plate, nozzles, bed, materials, slicer
  settings digest) validated by `PrintSelectionSchema`. The record carries a
  SHA-256 digest over its own body; any later edit makes it unreadable.
- `intent.json` — absent until claimed, then written exactly once (see below).

Publication is a staging directory renamed into place while holding the
portable project's storage lock at the bound revision, so a project edit
during preparation prevents a stale commit. Reopening a job re-reads and
re-hashes the printable bytes, re-checks the job digest, and re-checks that
the project still sits at the bound revision with the same accepted design.
Design/source bytes themselves stay with the accepted artifact; the job binds
and re-verifies its exact artifact identity rather than staging a second copy.

## Optional trusted file inspection

Configure `new PreparedJobStore(storage, directory, {inspection: {process,
options}})` with a trusted `TrustedMcpProcess` and bounded discovery options.
Executable, arguments and environment are operator configuration, never remote
request fields. With this configuration every preparation must successfully:

1. Write a private copy of the retained bytes as `.3mf` or `.gcode`.
2. Discover the actual `inspect_print_file` and `print_3mf` schemas, invoke only
   `inspect_print_file`, and close the process within the bounded lifecycle.
3. Verify its version1 file-only receipt, exact hash/length/format, selected
   model/plate/nozzles/bed and canonical material families at used project slots.
4. Check constructed prepared arguments against the discovered print schema;
   no print tool is called. Rehash retained bytes before atomic publication.

The receipt and catalog digest are included in the job digest and survive
reopen. Caller-supplied receipts cannot replace this operation. Receipt size is
capped at1MiB; failures, cancellation and timeout publish no job. Only
`model/3mf` and `text/x.gcode` are accepted; G-code has only plate0. Selection
uses canonical adapter model/material identifiers rather than guessed aliases.
This checks declared file compatibility, not physical tray contents or current
printer state. `slicerSettingsSha256` remains a declared selection binding,
not an independently recovered slicer-settings digest.

Without inspector configuration, preparation retains the original bookkeeping
behavior and produces no inspection evidence. Existing jobs are not promoted
to inspected status. Inspection is evidence, never dispatch authorization.

## Intent is evidence, not permission

`claimIntent(jobId, approval)` records one intent after re-verifying the
bytes, the project binding, and an approval that names the exact job digest,
confirms a human actor, and expires within five minutes (checked before and
after verification). The intent file is committed with an atomic
write-then-link, so a second claim — including an exact replay after a restart
or from another process — always rejects, and a torn intent can never appear
half-written. A corrupt retained intent fails closed on load instead of
looking unclaimed.

Recording intent does not authorize execution. A future executor must still
independently inspect the prepared bytes and selected plate, verify exact
model/nozzle/material against fresh observed printer identity and state, and
dispatch once through the existing printer gate. Without configured inspection the media type is only declared. Even inspected
files are not proof of physical fit or permission to print.

## Limits and trust model

Printable bytes are capped (64 MiB default) and metadata at 1 MiB; options may
only lower those caps. Reads are bounded, regular-file, no-follow. Like the
portable project storage it builds on, the store assumes a dedicated, trusted
local directory; it does not authenticate callers, and an abandoned project
lock requires manual inspection before recovery.

## Integration points

- Consumers use the existing `@scan-to-make/companion/prepared-jobs` export.
- Outcomes and reconciliation are deliberately out of scope: after an intent
  is claimed, learning what the printer actually did belongs to the executor
  and its journal, not to preparation.
- Run the maintained checks with `npm test --prefix services/companion`
  (the prepared-job cases live in `tests/prepared-jobs.test.mjs` and
  `tests/prepared-produce-cli.test.mjs` and use isolated synthetic fixtures
  only).
- Host-only production is `src/prepared-produce-cli.ts` (`npm run prepared:produce`).
  Private inspector and producer JSON files are read by `src/private-config.ts`
  (owner-only, no-follow, at most 64 KiB, strict schema). Generation-cli uses
  the same reader for inspector configuration.

## Trusted production from an accepted STL

The internal `prepareProduced` method accepts a current portable project ID,
revision, strong ETag, client job UUID, exact accepted STL bytes, and a selection
without `slicerSettingsSha256`. The produced selection must name `nozzleType`
(David's P1S is `hardened_steel`). Configure both `production` and `inspection`
on the store. `createPreparedProducer` calls bambu-printer-mcp's `slice_stl`
through a separate trusted MCP process, using the same `TrustedMcpProcess`
pattern as file inspection. Its private config is
`{process: {command, args?, cwd?, env}, timeoutMs?}`. The operator-configured
environment must set `SLICER_TYPE` and an absolute `SLICER_PATH`; the producer
adds a per-call private `TEMP_DIR`. Requests cannot choose executables, paths,
presets, or receipts. Host operators create
produced jobs with `npm run prepared:produce --prefix services/companion --`
followed by the capture directory, private inspector config, private producer
config, project id/revision/ETag, job UUID, accepted STL path, and selection
JSON. The CLI prints `{jobId, jobSha256, created}` and is the operator-host
entrypoint for `prepareProduced`. CLI arguments and environment variables cannot
override the producer or inspector identities pinned in those private files.
The CLI also accepts an optional `--printability-config <path>` (private config,
same reader) and a bare `--allow-supports` flag for the printability gate below.

Source identity and STL structure are checked before slicing: the CLI reads the
supplied STL and `prepareProduced` rejects it unless those bytes match the
current accepted project artifact. Slicing runs outside the project edit lock.
The host CLI takes an exclusive same-jobId produce lock before calling
`prepareProduced`, so a concurrent same-ID invocation fails closed with
`job-conflict` instead of starting a second slice. The final commit uses the
existing lock to check the current ETag, revision and acceptance, inspect the
exact output, and check authorization/cancellation after fsync. A concurrent
project edit rejects the result. Retry the same job UUID and unchanged request
after an ambiguous result: a persisted job is reverified and returned without
slicing or inspecting again. A different request, producer configuration, or
imported/produced identity rejects.

## Printability gate and selection-driven slicing

When the store is configured with `printability`, `prepareProduced` runs an
operator-pinned printability gate after `readVerifiedStl` and before slicing.
The private config pins the report CLI, its analyzer sibling, and the profiles
file by SHA-256, plus the printer profile id; the gate invokes
`python -I -B <script> check <tmp-stl> --profile <id> --out <tmp-report>` as a
bounded detached subprocess and strictly validates the report (schema, input
digest/length, and the profile's model, bed type, nozzle type, and nozzle
diameter against the sealed selection). Verdict handling is fail-closed:

- `not-printable` rejects with `printability-failed` (HTTP 422).
- `printable-with-supports` rejects with `supports-required` (HTTP 409) unless
  the caller passed an explicit `allowSupports`. Support generation itself is
  governed by the operator-pinned slicer profile used by `slice_stl`; there is
  no per-request slicer override.
- Any gate, pin, or report failure rejects with `printability-unavailable`
  (HTTP 503). A failed gate never falls through to slicing.

The sealed `production.printability` record
(`{profileId, verdict, allowSupports, reportArtifact}`) binds the verdict into
the job digest; the full report is retained as `printability.json` beside
`production.json` and reverified on reopen. `requestSha256` also binds
`allowSupports` and the gate identity, so changing either is a different
request. Without a gate config, production behaves exactly as before; enabling
the gate is an operator deployment choice.

Slicing takes `bambu_model`, `nozzle_diameter`, `bed_type`, and `nozzle_type`
from the sealed selection and calls `slice_stl` with
`use_printer_filaments: false`, `orient: true`, `arrange: true`, and
`ensure_on_bed: true`.
The producer identity (`adapterVersion: 3`) binds the trusted MCP process and
its operator slicer environment. The selected nozzle type is cross-checked
against every inspected `nozzleTypes` entry; an explicit inspector
`expectedNozzleType` pin wins over the selection value. The output is a sliced
`model/3mf`, read only from the producer's per-call private `TEMP_DIR` and then
inspected with `inspect_print_file` before sealing.

## App-facing production, approval, and attempt routes

When the listener is configured with `SCAN_TO_MAKE_PREPARED_PRODUCTION_CONFIG`
(absolute private JSON: `{producer, printability?, selection, displayName}`),
the store enables app production behind three authenticated routes under
`/v1/saved-projects/:projectId/prepared-jobs/:jobId`. Without it, production
routes return 404 `not-available` and behavior is unchanged. Printer, material,
tray, and profile are operator-pinned in that config; the phone never picks
hardware.

- `POST .../production?projectRevision=N[&allowSupports=1]` (scope
  `prepared-jobs:prepare`) runs `prepareProduced` as a background operation.
  The body is the raw accepted `model/stl` bytes streamed by the native bridge
  from the phone's verified cache; the companion checks them against the
  project's accepted artifact digest before slicing. Returns 202 with the
  production view, or 200 for an identical replay. An identical start returns
  the retained operation instead of slicing again; a different request for the
  same job id conflicts. Only one production runs per capture directory; a
  concurrent start returns `busy`. `GET .../production` (scope
  `prepared-jobs:read`) polls the view:
  `{jobId, status, failure?, job{jobId, jobSha256, printableArtifact, selection}, printability, gcodeSummary?, profile{displayName, nozzleDiameterMm, nozzleType?, bedType}}`,
  where `gcodeSummary` appears only if the producer manifest emits one.
  Operation records are retained under `.production-operations/`; an operation
  interrupted by a companion restart reads as failed with `interrupted`.
- `POST .../intent?projectRevision=N` (new scope `prints:approve`, granted
  only by an explicit `pair-print` invitation) records the user's approval.
  The body is exactly `{jobSha256, confirmed: true}`. The approving actor is
  derived from the authenticated pairing and the five-minute expiry is stamped
  on the host clock; client-supplied actor or expiry values are rejected.
  Returns 201 with `{intent}`, the full sealed intent record. The app's approval creates the intent only —
  physical dispatch stays with the host's printer adapter and its own safety
  gates.
- `GET .../attempt?projectRevision=N` (scope `prepared-jobs:read`) returns
  `{jobId, intent, linkedAttempt}`. `linkedAttempt` is populated only when the
  host executor writes an `attempt-link.json` beside the job
  (`{attemptId, printerId, planSha256, outcome?, resolution?}`, outcome one of
  `started`/`unconfirmed`/`uncertain`, resolution one of
  `finished`/`cancelled`/`rejected`). A null `linkedAttempt` means the intent
  reached the companion only; it never means anything printed.

Error codes clients branch on: `printability-failed`, `supports-required`,
`approval-expired`, `already-approved`, `approval-mismatch`, `busy`,
`not-available`, and `project-changed` (client mapping of a stale ETag).
`printer-offline`, `printer-busy`, `already-sent`, and `ambiguous-send` are
reserved for the host executor and are not emitted by these routes. Starts
and approvals are never automatically replayed by the client: a transport
failure surfaces as an explicit ambiguous code and the UI polls status
instead.

The optional `production` record is sealed in the job digest. New MCP-produced
jobs carry `producerKind: "bambu-printer-mcp"`, the MCP server name/version and
catalog digest, `tool: "slice_stl"`, and the configured slicer type. The job
retains `source.stl`, `settings.json`, and `production.json` alongside the
printable and job metadata. Reopen verifies their exact lengths and SHA-256
values, their manifest bindings and the current accepted source. Source is
capped at 32 MiB, settings at 8 MiB, manifest at 1 MiB, and the sliced 3MF at
the store's printable limit. Jobs retained by the removed local slicer wrapper
keep their legacy production record and still reverify on reopen.

For **trusted-produced jobs only**, `selection.slicerSettingsSha256` means the
SHA-256 of the exact retained settings bytes from that run: the canonical
`slice_stl` request recorded by the companion for MCP-produced jobs, or the
exported settings for legacy jobs. Imported jobs keep their caller-declared
meaning. This is not proof of complete internal settings equivalence,
calibration, physical fit, or observed printer/tray state.
No `CalibrationScope` is created or modified.

Collection GET discovery stays imported-only unless the client opts in with
exact query `productionVersion=1`. That opt-in returns inspected imported and
produced summaries in catalog order, using the same compact handle shape
(`jobId`, `jobSha256`, `printableArtifact`, `model`, `plateIndex`). Omitting
the parameter keeps the existing imported-only list and response shape, so
legacy clients never see produced jobs. Unknown or duplicate
`productionVersion` values are rejected as `invalid-request`. Discovery
cursors bind the selected mode; a cursor from one mode cannot be reused on
the other (`invalid-cursor`). Existing project scope, ETag, revision, page
limits, and discovery budgets are unchanged. Direct verified GET of a
produced job by id already returns the sealed record to compatible consumers
and is not part of this negotiation. `requiresVerifiedGet` remains true.
