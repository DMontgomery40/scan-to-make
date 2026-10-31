# Scan processing (preview only)

One job runs a retained capture through `import → repair → advise → correct →
measure → render`. It calls the existing converter and Blender tools as separate
processes. `bambu-printer-mcp` handles the later printer handoff; its mesh-edit
commands do not provide this capture/still provenance or bounded correction job.
No slicing or printer dispatch happens here.

## Host configuration

The listener requires its existing remote-auth settings and an absolute
`SCAN_TO_MAKE_CAPTURE_DIR`. Enable cleanup with:

```sh
export SCAN_TO_MAKE_SCAN_BLENDER=/absolute/path/to/blender
export SCAN_TO_MAKE_SCAN_REPAIR_TOOL=/absolute/checkout/tools/scan-repair/repair.py
export SCAN_TO_MAKE_CAPTURE_PYTHON=/absolute/venv/bin/python
```

Use Blender 5.0.1 and install both Python requirements files:

```sh
python -m pip install -r tools/capture-mesh-convert/requirements.txt -r tools/scan-correct/requirements.txt
```

`SCAN_TO_MAKE_SCAN_CORRECT_TOOL` defaults to `../scan-correct/correct.py` beside
scan-repair. Linux needs libseccomp2; macOS uses the correction tool's enforced
`sandbox-exec` network isolation. Executable paths and provider settings come
only from the operator, never from phone requests. Missing or invalid tool
configuration fails; no network-isolation bypass is used.

`SCAN_TO_MAKE_CORRECTION_ADAPTER` defaults to `scripted`: retain the repaired
shape, scale to the optional reference, then measure. This needs no API key and
does not infer feature cuts from photos. `anthropic` or `openai` enables the
existing model adapter. Optional operator settings are
`SCAN_TO_MAKE_CORRECTION_MODEL`, `SCAN_TO_MAKE_CORRECTION_BASE_URL` and
`SCAN_TO_MAKE_CORRECTION_KEY_ENV` (the name of an environment variable containing
the key). Defaults remain those of scan-correct, including `claude-opus-5-5` and
`ANTHROPIC_API_KEY` for Anthropic. Keys stay in the environment.

The MIT companion invokes the isolated GPL tools over their CLIs; it does not
import `bpy`. Embedded users can construct `createScanCleanupRunner` and pass it
to `ScanProcessingStore`. The existing `createScanRunner` remains available for
repair/measure/render-only embedded callers and retained job compatibility.

## Phone contract

Routes remain under `/v1/saved-projects/:projectId/captures/:captureId`, with
exactly one `projectRevision=N` query parameter and the current `If-Match` ETag:

| Method and suffix | Scope | Result |
| --- | --- | --- |
| POST `/scan-processing` | `captures:import` | 202 `{job}` with queued status |
| GET `/scan-processing` | `captures:read` | `{jobs}`, ascending job ID |
| GET `/scan-processing/:jobId` | `captures:read` | `{job}` with stage statuses and artifacts |
| GET `/scan-processing/:jobId/artifacts/:name` | `captures:read` | Hash-verified bytes and `X-Content-SHA256` |
| DELETE `/scan-processing/:jobId` | `captures:import` | Cancel, await workers, return `{job}` |

POST takes strict JSON, at most 4096 bytes, with a five-second body deadline:

```json
{"reference":{"dimensionsMm":[60,40,20],"source":"Published dimensions","productName":"Known object"},"stillIds":[]}
```

Both fields are optional. Omit `stillIds` to select the newest four retained
stills in attachment order; use `[]` to select none, or up to four unique IDs to
choose photos. The job snapshots exact hash-verified `.img` bytes and sidecars.
The correction CLI sniffs the actual type, converts HEIC and normalizes provider
image limits. Selected source identities are recorded in `detailStills`;
`correction.json` links them by filename and source hash to normalized images
and the model's still IDs. Edit attribution is model-declared evidence, not an
independent proof that an image caused an edit.

The original retained USDZ is re-imported into a private job folder so its OBJ,
MTL and PNG bundle survives. Every converter output is hash-checked. The verified
`metersPerUnit` sidecar drives repair; later stages use mm. Repair retains its
existing bounded Taubin parameters, recorded in the job's `stages` tuple.

`pipelineStages` records all six stages, while the original three-stage `stages`
tuple remains for existing screen code. `correctionAdapter` records the chosen
adapter. The top-level job status determines whether work is terminal: after
failure/cancellation, `failed` marks the interrupted stage and `queued` marks
steps never started. No queued step is automatically retried. New records include `measuredBoxExtentsMm`; PCA extents remain available
for compatibility. **All reference comparisons use minimum-volume box extents**,
with both triples sorted descending. Scaling matches a reference by construction;
it does not establish physical accuracy, surface completeness or local detail.
All jobs carry `previewOnly: true`.

The contract adds optional fields so new code can read older retained jobs.
Deploy the companion and mobile app with the updated shared contract: an older
compiled strict schema will reject unfamiliar fields. UI rendering is separate
from this backend contract.

## Artifacts and publication

After advice succeeds, `advice.json` and up to four neutral `advice-01.png` through
`advice-04.png` images are available even while correction runs. Advice JSON keeps
the scan-correct `closeupAdvice` schema unchanged: render paths such as
`renders/target-01.png` map by target rank to the API artifact `advice-01.png`.
These images contain no texture. Advice remains downloadable after a later
failure or cancellation, subject to the current project, ETag and authorization.

On success, geometry is available as `corrected.obj` and `corrected.stl`.
`repaired.obj` and `repaired.stl` are byte-identical aliases of the **final**
geometry for the existing download flow. `correction.json` and
`correction-calls.jsonl` retain the correction report and complete tool-call log.
`report.json` combines conversion, repair, correction, still identities, final
measurement and the optional reference comparison. The ten existing canonical
512×512 PNG names stay unchanged (`pos_x`, `pos_y`, `pos_z`, `neg_x`, `neg_y`,
`neg_z`, `iso_pp`, `iso_np`, `iso_nn`, `iso_pn`).

Jobs live at `<captures>/<captureId>/scan-processing/<jobId>.json`, with artifacts
in the adjacent `<jobId>/` directory. Original textures, source/normalized stills,
worker checkpoints and diagnostic logs remain under `<jobId>/private-work/`,
including failed jobs when diagnostic retention succeeds. Terminal failure is
persisted before that best-effort move. That directory has no artifact route. Protect the capture
directory as personal data; retention has no automatic expiry.

Records are private synced temporary files renamed atomically. The advice record
is its publication point; the final successful record publishes the geometry.
Final hashes and authorization are checked before publication; the revision
resolved at enqueue is not re-checked, so a later project edit neither blocks
publication nor breaks job reads. No job is rebound to another revision.
Downloads rehash regular no-follow files. Output failures expose
`failureStage` (including `publish` for final publication) and a fixed error
code; provider error bodies are not returned to the phone.

## Queueing and automatic starts (BE-2)

Cleanup starts by itself: a successful capture import enqueues a job
(`trigger: "capture-import"`, no reference needed), and a detail still that
arrives afterwards enqueues a follow-up (`trigger: "detail-still"`) unless a
job is already waiting, in which case that job absorbs it. Still bytes are
snapshotted when a job starts, so a waiting job sees the newest close-ups.
Jobs run one at a time in FIFO order per capture directory; nothing fails
busy any more. Because execution is serial, jobs for a capture finish in
enqueue order, so the newest finished result is the latest successful one
enqueued (a failed or cancelled job never displaces it). A follow-up
inherits the newest live job's reference, since the reference drives
correction scaling. Which job the phone displays is the app's choice; the
records carry `enqueuedAt`/`finishedAt` for that ordering.

Every job records `captureSha256` (the retained capture's original bytes).
Within one retained capture, the same SHA-256 with the same reference, the
same close-up selection and the same pipeline/adapter is one job while it
is queued or running: POST retries, double taps and the automatic import
job all resolve to the existing in-flight record instead of duplicating
work, and automatic re-enqueues also resolve to a finished record. An
explicit POST after completion is a deliberate re-check and always runs
fresh, so a tool fix or model change is never masked by the old result.
Re-importing identical bytes creates a distinct retained capture (unchanged
capture-store behavior) and therefore its own job. A different reference,
or a close-up set the finished job did not use, is a new job. The current
project revision and ETag are resolved at enqueue and pinned on the record;
reads never re-check them.

Job and stage records carry `enqueuedAt`/`startedAt`/`finishedAt` (per-stage
on both `pipelineStages` and the legacy `stages` tuple) for time estimates.
Every job also carries `createdAtMs` (epoch milliseconds at enqueue, the
same instant as `enqueuedAt`): job IDs are random, so clients order jobs by
`createdAtMs` — the newest finished result is the succeeded job with the
largest `createdAtMs`. Records written before the field existed derive it
from `enqueuedAt` on read; older records have neither and sort oldest. The
per-capture collection GET keeps ascending job-ID order (the current phone
validates it); only the cross-project index is newest-first. Stage kinds
map to the phone labels in the contract's `SCAN_CLEANUP_STAGE_LABELS`
(Getting your scan, Filling holes, Looking for weak spots, Fixing details
from your close-ups, Measuring, Almost done). `scan-job-index.json` in the
captures directory indexes every job across projects, newest first by
`createdAtMs`; `listJobIndex()` refreshes nonterminal entries from their
records and rebuilds the file from records when it is missing.

Stale revision/ETag returns 412; missing precondition 428; invalid request 400;
wrong scope 403; missing artifact 404; corrupt artifact 422; storage errors
503. POST is idempotent per capture and request while the job is in flight
(see above); after an ambiguous response, re-POST or use the collection
GET to find the same job.
A disconnect after 202 does not cancel the job. DELETE and shutdown do;
DELETE of a still-queued job removes it before it ever runs.

## Bounds and lifecycle

One job at a time owns the existing process-wide registry and filesystem job lock; further jobs wait in the per-directory queue.
The listener also owns the capture-directory instance lock; embedded users must
maintain the same one-process-per-directory rule. Full cleanup has a thirty-minute whole-job ceiling (recorded as
`wallClockLimitMs`); legacy repair-only jobs retain ten minutes. Each cleanup
subprocess has thirty seconds of startup/export headroom above its worker
budget. `failure: "deadline-exceeded"` distinguishes a job deadline from user
cancellation. Advice has 120 seconds; correction
has 300 seconds, 24 tool calls and a 200,000-face cap. Up to four stills use the
companion's existing 25 MiB source limit.

New cleanup stages drain at most two MiB of subprocess output, sample the whole
private job directory every 250 ms, and reject over 512 MiB or 4,000 entries.
The existing repair runner retains its one MiB log and 160 MiB output watchdog.
Published artifacts total at most 256 MiB, with 64 MiB meshes, two MiB JSON,
16 MiB tool logs and eight MiB PNGs. These are sampled worker bounds, not a
filesystem quota; a bounded storage volume supplies a strict disk limit.

A trusted Python supervisor terminates descendants even when a Blender/model
worker starts a separate process session. Linux uses parent-death notification
and child subreaping, falling back to PPID entries in `/proc/<pid>/stat` when
the kernel omits the optional `children` interface; macOS watches its parent and enumerates children with
libproc before terminating the tree. The trusted CLIs wait for their children.
Cancellation first signals the supervisor, with a process-group kill fallback.
The correction tool's OS network-denial sandbox remains unchanged.

On restart, an abandoned nonterminal record becomes `failed/interrupted`, never
an automatic rerun. Recovery terminates the recorded worker group before
reclaiming the lock; inability to verify termination keeps the job busy. A corrupt
owner record or hard-killed supervisor can still require operator cleanup of
orphaned workers and hidden staging files. There is no automatic lock expiry.

## Verification

```sh
npm test --prefix packages/contracts
BLENDER=/absolute/blender CAPTURE_TEST_PYTHON=/absolute/venv/bin/python xvfb-run -a npm test --prefix services/companion
BLENDER=/absolute/blender CAPTURE_TEST_PYTHON=/absolute/venv/bin/python xvfb-run -a npm test --prefix tests/e2e
```

Companion CI installs the converter and still-decoder dependencies and verifies
pinned Blender's checksum. A synthetic textured USDZ and PNG still exercise one
paired HTTP job, final dimensions within 0.05 mm, retained texture/still evidence,
and every downloadable hash. The same test runs in the e2e gate. Other tests cover
advice before/after failure, still selection, forged hashes, box comparisons,
process-tree cancellation, and companion death. Lifecycle tests support macOS; the in-repo CI currently runs them only on Linux.
Only synthetic fixtures belong in Git.
