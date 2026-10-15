# Prepared print jobs

`PreparedJobStore` (`src/prepared-jobs.ts`) turns an accepted portable saved
project plus exact printable bytes and a printer selection into one durable,
digest-sealed prepared job, and records at most one human-approved dispatch
intent for it. It never dispatches a print, calls a printer or MCP tool,
slices anything, inspects printability, or observes hardware state.

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
dispatch once through the existing printer gate. This module also makes no
claim that the bytes are printable, correctly sliced, or a physical fit; the
media type is the caller's declared identity, not an inspected format.

## Limits and trust model

Printable bytes are capped (64 MiB default) and metadata at 1 MiB; options may
only lower those caps. Reads are bounded, regular-file, no-follow. Like the
portable project storage it builds on, the store assumes a dedicated, trusted
local directory; it does not authenticate callers, and an abandoned project
lock requires manual inspection before recovery.

## Integration points

- Add a `./prepared-jobs` package export when wiring consumers (tests import
  `../dist/prepared-jobs.js` directly until then).
- Outcomes and reconciliation are deliberately out of scope: after an intent
  is claimed, learning what the printer actually did belongs to the executor
  and its journal, not to preparation.
- Run the maintained checks with `npm test --prefix services/companion`
  (the prepared-job cases live in `tests/prepared-jobs.test.mjs` and use
  isolated synthetic fixtures only).
