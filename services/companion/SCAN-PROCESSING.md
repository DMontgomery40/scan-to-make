# Scan processing (preview only)

A retained, converted capture can run a deterministic `repair → measure → render`
job. The explicit stages and their parameters are recorded under
`@scan-to-make/contracts/scan-processing`; the root contract export includes them.
A later correction stage can extend this model. No AI stage, slicing, printer
operation or physical-fit certification is supplied here.

## Host configuration

The authenticated listener requires `SCAN_TO_MAKE_CAPTURE_DIR` and its existing
remote-auth configuration. Enable processing with both absolute paths:

```sh
export SCAN_TO_MAKE_SCAN_BLENDER=/Applications/Blender.app/Contents/MacOS/Blender
export SCAN_TO_MAKE_SCAN_REPAIR_TOOL=/absolute/checkout/tools/scan-repair/repair.py
```

`SCAN_TO_MAKE_CAPTURE_PYTHON` chooses the Python executable (default `python3`),
as for capture conversion. Only the host operator supplies these paths. Empty,
relative or partial Blender/tool configuration fails startup. Omitted processing
configuration leaves its routes disabled. Use Blender 5.0.1, the tested version.
The companion invokes the tool as a separate process, never bundles Blender into
the mobile app. The tool is GPL-3.0-or-later; see
[scan-repair licensing and runtime notes](../../tools/scan-repair/README.md).

The worker uses the capture's verified `metersPerUnit` provenance through a units
sidecar, preserving metric scale rather than guessing it from OBJ comments.
Default repair parameters are explicit in each record and subprocess invocation.
Measurement uses the repaired OBJ in mm. Renders are the ten canonical 512×512
views from scan-repair. All records carry `previewOnly: true`.

## HTTP

All routes use the existing private Serve boundary, exactly one
`projectRevision=N` query parameter, and the current project `If-Match` ETag.

| Method and path under `/v1/saved-projects/:projectId/captures/:captureId` | Scope | Result |
| --- | --- | --- |
| `POST /scan-processing?projectRevision=N` | `captures:import` | 202 `{job}` with a generated `jobId` and queued status |
| `GET /scan-processing/:jobId?projectRevision=N` | `captures:read` | `{job}` with current stage statuses and retained output identities |
| `GET /scan-processing/:jobId/artifacts/:name?projectRevision=N` | `captures:read` | Hash-verified exact bytes, Content-Length, Content-Type and X-Content-SHA256 |
| `DELETE /scan-processing/:jobId?projectRevision=N` | `captures:import` | Cancel active job, await process cleanup, return `{job}` |

POST requires `application/json` and a strict body, at most 4096 bytes with a
five-second deadline. Use `{}` or:

```json
{"reference":{"dimensionsMm":[60.6,45.2,21.7],"source":"Manufacturer published spec","productName":"Known product"}}
```

Dimensions are positive finite mm values. The optional source is a free-text
label, not an automatically verified citation. Manufacturer dimensions should
be supplied as ground truth for a known product. The job does not rescale the
mesh to match. Principal extents have no semantic width/height/depth labels:
**both measured and reference triples are sorted descending**, then the three
signed errors are `measured - reference` in mm. Positive means oversized. The
record and retained report say `matching: "sorted-descending"`. Symmetry, vertex
density and protrusions can affect PCA; these errors do not prove local feature
accuracy, complete surfaces or physical fit.

Artifact names: `repaired.stl`, `repaired.obj`, `report.json`, `pos_x.png`,
`pos_y.png`, `pos_z.png`, `neg_x.png`, `neg_y.png`, `neg_z.png`, `iso_pp.png`,
`iso_np.png`, `iso_nn.png`, `iso_pn.png`. The report combines the tool repair
report, independent measurement, optional reference/comparison and preview flag.

Stale revision/ETag returns 412; missing precondition 428; invalid request 400;
wrong scope 403; missing/disabled job or artifact 404; concurrent job 429;
corrupt retained output 422; storage errors 503. Responses use the existing
`{error:{code,message}}` envelope. Other capture/project requests retain their
existing single request slot; the background job has a separate single worker
slot. Status reads remain available while Blender works. Authorization is checked
before queuing and again before publishing success. Revocation at publication
fails the job. Disconnect after the 202 commit does not cancel it: use DELETE.
Shutdown cancels and awaits the worker. A changed project revision fails final
publication; no result is rebound to a later revision.

POST is not idempotent. Save the returned job ID for status and cancellation.
An ambiguous POST response can leave a queued job; do not automatically retry.
No listing or automatic job replay is provided in this increment.

## Retention and bounds

Jobs live beside the retained capture:

```text
<captures>/<captureId>/scan-processing/<jobId>.json
<captures>/<captureId>/scan-processing/<jobId>/<artifact name>
```

Records are synced private temporary files renamed atomically. Success is
published only after synced artifacts have been renamed into place; the final
record is the commit point. Failed jobs expose no artifact handles. Reopening
verifies the original retained capture binding and current project, then validates
the job binding. Downloads rehash exact regular, no-follow files. Publication
and response flush use the same project edit lock as existing capture routes.

One worker at a time is enforced in memory and with an exclusive host lock at
`<captures>/.scan-processing-lock`. The lock owner record also carries the live
worker's detached process-group id, updated as each stage spawns. Whole-job
deadline: ten minutes; subprocess deadline: five minutes per stage.
Cancellation/deadline sends SIGKILL to the whole detached process group and
awaits close before cleanup. Logs are drained, limited to one MiB per stage and
never returned to remote callers. Each mesh is at most 64 MiB, report two MiB,
each PNG eight MiB, total retained outputs 160 MiB. A 100 ms disk-size watchdog
also kills a subprocess exceeding 160 MiB; this is a sampled bound, not a
filesystem quota. Configure private storage on a bounded volume when a strict
disk quota is needed. Retention has no automatic expiry.

One companion process owns a capture directory at a time. Starting the
listener with scan processing configured claims
`<captures>/.companion-instance-lock`; a second listener on the same directory
fails startup with `instance-busy` until the first closes or its owner process
is gone. Cancellation therefore always lands in the owning process, where a
process-wide registry routes it to the store instance that started the job.
Direct library use of `ScanProcessingStore` outside the listener must uphold
the same one-process rule itself.

Records and outputs survive restart. A nonterminal record whose recorded owner
PID is absent becomes `failed/interrupted` on read; it is never resumed. When a
dead owner's job lock is recovered (on read, and again before the next start
reclaims the lock), the recorded worker process group is terminated with
SIGKILL and verified gone first; if the group cannot be signalled or verified
dead, the lock is kept and the start reports busy instead of running a second
worker beside an orphan. A hard crash can still leave hidden staging files and,
if the owner record itself is unreadable, an unrecorded worker: after verifying
no worker or descendant is alive, the operator may remove the stale lock and
unreferenced staging files. There is no automatic lock expiry. A reused live
PID can delay interruption detection; investigate the recorded owner manually.

## Verification

```sh
npm test --prefix packages/contracts
npm test --prefix services/companion
```

Both scripts compile TypeScript before tests. Routine tests inject a fake runner;
a real integration test runs Blender 5.0.1 on a synthetic metric box, checks its
reference errors, and verifies all thirteen retained artifacts. If Blender is
absent it skips with an explicit message; set `BLENDER` to its absolute path.
Companion CI downloads and checksum-verifies pinned Blender 5.0.1 using the
scan-repair workflow pattern and runs tests under Xvfb/software graphics.
Only synthetic fixtures belong in Git.
