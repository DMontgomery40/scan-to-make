# Contracts

Shared TypeScript/JSON boundaries for the app and the companion: portable saved projects, capture provenance, detail stills and scan processing. Runtime validation and TypeScript types use the same Zod schemas. The package has no Node runtime imports and can be consumed by the mobile shell. Every export condition map has a `default` matching its `import` target, so Metro Release bundles resolve it.

```sh
npm ci --prefix packages/contracts
npm test --prefix packages/contracts
```

## Artifact references

`validateArtifactRef(input)` produces a frozen detached `{sha256, mediaType, byteLength}` identity. The SHA-256 is lowercase hex and the size is a positive safe integer. Locations and access tokens live outside the reference. A digest declaration does not prove that bytes match it: every artifact consumer must hash the exact received snapshot and compare its size. Artifact integrity does not establish printable geometry or physical safety.

## Portable saved projects

Import `@scan-to-make/contracts/saved-project` for the versioned project envelope and repository. It has no Node runtime imports; the platform supplies storage.

```ts
type SavedProject = {
  formatVersion: '0.2.0';
  id: string;
  revision: number;
  brief: { object: string; context: string; addition: string };
  fit: JSON | null;              // legacy fit-template data, carried unchanged
  preview: JSON | null;          // legacy
  acceptedArtifact: JSON | null; // legacy
};
```

The app names a project by `brief.object`; the other brief fields are kept for records written by earlier versions. Brief text is preserved exactly, including empty fields. IDs are 1–128 ASCII letters, digits, underscores or hyphens, beginning with a letter/digit. Generate a new unique ID for each project.

Earlier app versions also stored fit-template measurements and design review state in `fit`, `preview` and `acceptedArtifact`. This contract no longer interprets them. They are accepted as any JSON value and carried through edits and sync unchanged, so those projects still load. New projects write `null` for all three.

`SavedProjectSchema`, `SavedProjectChangeSchema`, `decodeSavedProject` and `applySavedProjectChange` are the portable validation/transition boundary. `createSavedProjects(storage)` supplies these asynchronous operations:

| Operation | Behavior |
| --- | --- |
| `list()` | Sorted entries `{id, result}`; each entry has its own load outcome, including unreadable entries. |
| `load(id)` | Reads and validates current bytes; no cache or implicit recovery. |
| `create({id, brief})` | Exclusive creation at saved revision zero. |
| `change(id, expectedRevision, change)` | Compares saved revision, validates one explicit change, then atomically replaces the bytes it read. |

The only change is `{kind: 'replace-brief', brief}`. It increments the saved revision; an identical brief is a no-op. Exhausted safe-integer revisions reject effective edits. Inputs are detached and validated before the first asynchronous storage call, and returned records are detached from stored bytes.

`decodeSavedProject` accepts strict legacy `0.1.0` saved-project records and normalizes them in memory to `0.2.0` with null review state. Reads and no-ops never write or migrate stored bytes. The next successful effective change writes `0.2.0`, with compare-and-swap against the **original stored string**, including its whitespace/order. A failed or conflicting migration leaves the old bytes or winning concurrent write intact. New projects use `0.2.0`; older clients that only understand `0.1.0` cannot edit migrated records.

Results are discriminated by `status`. Successful load/write returns `{status: 'ok', project}`; list returns `{status: 'ok', entries}`. Other outcomes are:

| Status | Meaning |
| --- | --- |
| `missing` | No current bytes for the requested ID. |
| `exists` | Exclusive create collided; `latest` is the existing validated record. |
| `stale` | Revision/CAS conflict; `latest` is the current validated record. |
| `corrupt` | Malformed JSON, invalid data or storage-key/record identity mismatch. |
| `unsupported-version` | A future/unrecognized project version; includes `version`. |
| `invalid-change` | Invalid input or an exhausted revision. |
| `storage-error` | Storage operation failed; the caller must not report a confirmed save. |

A failed compare-and-swap reloads the latest record. If it disappeared or became unreadable, that load outcome is returned instead of `stale`. No retry overwrites intervening work. Corrupt/future bytes remain untouched by both `create` and `change`. A storage failure may have an uncertain outcome if the adapter failed after committing; retain the draft and reload before retrying.

### Storage adapter contract

```ts
interface SavedProjectStorage {
  listIds(): Promise<string[]>;
  read(id: string): Promise<string | null>;
  compareAndSwap(id: string, expected: string | null, next: string): Promise<boolean>;
}
```

`read` must return a whole stored string or `null` for absence. `compareAndSwap` must compare the **entire exact stored string** (or absence for `null`) and replace it atomically, returning `true` only after successful persistence. Every writer to that namespace must participate in the same atomicity mechanism. A `getItem` followed by `setItem` without shared serialization/transaction is insufficient. One shared runtime may serialize these operations through one shared queue; separate runtimes/processes require a transaction or equivalent shared locking. Use a dedicated namespace and preserve unknown/corrupt entries for explicit recovery.

The repository neither supplies platform storage nor promises encryption, cross-process locking or crash durability. Those are properties of the adapter and must be verified there. It stores project names and any legacy data, without captures or artifact bytes. A consumer must wait for hydration before editing, retain drafts on errors/conflicts, and report a save only after an `ok` write result. Contract tests use an isolated in-memory adapter to prove repository behavior; native process-kill/relaunch proof belongs to the app integration.


## Retained capture provenance

The `./capture` entry point adds a standalone `CaptureReceiptSchema` and
`CaptureBindingSchema`. It reuses `ArtifactRef` for the original capture, derived
OBJ, converter JSON report and each contributing layer. Native meters-per-unit,
authored-unit status, up axis and composed world-coordinate policy stay explicit.
Exact transform details are retained in the original layers and hash-bound report.
The contract does not apply transforms, rescale geometry or infer missing surfaces.

`validateCaptureBinding(receiptBinding, expected)` compares the project ID and
revision plus independently supplied original, derived and report identities.
Consumers must first verify retained bytes and the converter report's assertions;
schema validation alone cannot authenticate them. Persist using an atomic current
revision check. The standalone binding does not modify the saved-project format;
companion ingestion/persistence must explicitly implement that storage integration.

Unqualified conversions are retainable with reasons. Only qualified conversions
with authored units are eligible for bounds/topology evaluation through
`isCaptureEvaluationEligible`. This is not fit readiness: metric accuracy,
surface completeness and physical fit are always `unknown` in this contract.
Future physical evidence needs a separate, explicitly observed evidence contract.

## Detail stills

`./detail-still` (also re-exported from the package root) defines a `DetailStill`
record for one close-up photo attached to an existing retained capture. The schema
id is `scan-to-make.detail-still/0.1`; `fixtures/detail-still.json` is a synthetic
example. The record binds `id`, `projectId`, `captureId` and `projectRevision` to
the exact image bytes (`mediaType` `image/jpeg`, `image/heic` or `image/png`,
`byteLength`, `sha256`, capped at `MAX_DETAIL_STILL_BYTES` = 25 MiB). An optional
`label` is the user's own free text (at most 200 characters), and `ordinal` is the
attachment order within the capture, at most `MAX_DETAIL_STILLS_PER_CAPTURE` (24)
stills per capture.

There are deliberately no region coordinates, masks or detail taxonomy: a later
model step works out what each photo shows. `validateDetailStill(input)` returns a
detached validated record and rejects unknown fields. `DetailStillListSchema` /
`validateDetailStills(input)` validate one capture's stills as a set: shared
project, capture and revision, unique ids, strictly increasing ordinals. As with
artifact references, the digest does not prove bytes match it; every consumer must
hash the exact received bytes and compare length before use.
