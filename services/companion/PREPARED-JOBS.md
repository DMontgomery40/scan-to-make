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
  (the prepared-job cases live in `tests/prepared-jobs.test.mjs` and use
  isolated synthetic fixtures only).
