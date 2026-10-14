# Fit contracts

A shared TypeScript/JSON boundary for explicitly supported fitted-part templates. Runtime validation and TypeScript types use the same Zod schemas. The package has no Node runtime imports and can be consumed by the mobile shell. Build and tests run locally:

```sh
npm ci --prefix packages/contracts
npm test --prefix packages/contracts
```

## Data and edits

`fixtures/tapered-holder.json` is a synthetic, complete input example. All distances are millimetres; the frame is right-handed, Z-up, with the origin at the holder base centre. Each required dimension includes a nominal value, conservative lower/upper bounds, a source category (`manual`, `scan`, `reference`, `design`) and a source record ID. Distances must remain positive over their entire interval; radial clearance may be zero. Radial clearance is the clearance on each side of the lower insert. It is not a diameter allowance.

`validateFitSpec(input: unknown)` rejects missing dimensions, nonfinite values, contradictory intervals, unsupported versions/frames/units and unknown fields. It returns a detached validated object. A source record describes provenance; validation does not establish that a measurement is accurate or that a model is entitled to relabel it. Source records and authorization must be enforced by the project service.

`applyFitSpecPatch(current, {expectedRevision, dimensions, authorizedInterfaceIds?})` validates both the current spec and patch. Each changed dimension is a complete replacement, including provenance and interval. Stale revisions reject. An effective edit increments the revision exactly once; a no-op returns an independent validated copy without incrementing it.

The stable `holder-insert` interface protects the holder's bottom/top internal diameters, insertion depth, wall thickness and radial clearance. Changing any protected value or its provenance requires `authorizedInterfaceIds: ["holder-insert"]` and clears its fit evidence. This list records an authorization decision; it is not authentication. The project service must obtain the user's authorization rather than accepting a model's assertion. Changing the cup width or support height preserves lower-interface fit evidence; it does not establish strength or retention for the new cup.

```ts
const next = applyFitSpecPatch(current, {
  expectedRevision: current.revision,
  dimensions: {
    cupOuterDiameter: {
      nominalMm: 90, lowerMm: 89.8, upperMm: 90.2,
      source: 'manual', sourceId: 'measurement-cup-width-2',
    },
  },
});
```

## Fit evidence and artifacts

Evidence contains the exact protected-dimension snapshot, assessed revision, observation time/source, reported fit or misfit, printer identity/model, nozzle diameter, material, insertion-axis unit vector, settings digest and coupon artifact identity. Evidence with a mismatched interface or future revision rejects. `reported-fit` is a recorded observation, not independent certification. A consumer must compare the entire calibration scope to the proposed job before reusing it; this contract does not claim applicability to another printer, material, orientation or settings profile.

`validateArtifactRef(input)` produces a frozen detached `{sha256, mediaType, byteLength}` identity. The SHA-256 is lowercase hex and the size is a positive safe integer. Locations and access tokens live outside the reference. A digest declaration does not prove that bytes match it: every artifact consumer must hash the exact received snapshot and compare its size. Artifact integrity does not establish printable geometry or physical safety.

This package supplies no geometry, capture pipeline, authentication, artifact store, approval or print dispatch. Worker geometry/print validation and actual fit measurements remain separate acceptance steps.


## Multiple templates and compatibility

`ProjectFitSpecSchema` / `validateProjectFitSpec(input)` form the general consumer boundary, discriminated by `template`. `ProjectFitSpec` is a closed TypeScript union: narrow `spec.template` before using its dimensions. `applyProjectFitSpecPatch(current, input)` dispatches against the validated current template, so a patch cannot switch templates or introduce another template's fields.

| Record | General API | Existing cup API |
| --- | --- | --- |
| `cup-holder-adapter`, schema `0.1.0` | Accepted unchanged | Accepted unchanged |
| `drawer-tray`, schema `0.2.0` | Accepted | Rejected |

`FitSpecSchema`, `FitSpec`, `FitSpecPatch`, `validateFitSpec` and `applyFitSpecPatch` remain cup-specific for existing mobile clients. The original cup fixture and stored project bytes require no migration. There is deliberately no automatic cup-to-drawer conversion: a drawer is a new project with its own measurements and evidence. Unsupported template/version combinations reject. Existing project record envelopes remain `formatVersion: "0.1.0"`; their `spec` now accepts either documented variant.

## Drawer tray contract

`fixtures/drawer-tray.json` is a synthetic drawer, not a real object capture. Its right-handed frame has Z up, X width, Y depth and origin at the inner drawer floor centre (`drawer-floor-center`). Interval dimensions are `drawerInnerWidth`, `drawerInnerDepth`, `drawerInnerHeight`, `wallThickness`, `floorThickness`, `peripheralClearance` and `trayHeight`. Height is measured from the floor to the lowest obstruction. Clearance is a linear allowance on **each side**, consumed at its upper bound. The non-dimensional `parameters.dividersAcross` and `parameters.dividersAlong` are integers from 0 through 8, specifying dividers along the width and depth respectively.

The generator handoff is a uniform grid with square outer corners (assumed corner radius 0, to be declared in its manifest). Inner width/depth intervals do not describe rounded drawer corners: physical measurement and fitting must establish applicability. The deterministic nominal construction uses:

```text
outerWidth  = drawerInnerWidth.lowerMm - 2 * peripheralClearance.upperMm
outerDepth  = drawerInnerDepth.lowerMm - 2 * peripheralClearance.upperMm
outerHeight = trayHeight.nominalMm
wall        = wallThickness.nominalMm
floor       = floorThickness.nominalMm
dividerTop  = outerHeight - 2 mm
```

Validation rejects rather than silently shrinking/capping. `trayHeight.upperMm <= drawerInnerHeight.lowerMm`; the entire floor must be below the tray top; with any divider, its top must also be above the entire floor interval. Each clear cell span must be at least 10 mm using the smallest drawer, largest clearance and largest wall thickness. The synthetic fixture produces outer width/depth 297.8 × 397.8 mm, height 40 mm and nominal clear cells 96.6 × 195.9 mm. These are CAD sizing bounds, not manufacturing-tolerance or physical-fit guarantees.

All seven drawer dimensions, including their provenance, are protected by `drawer-cavity`. A changed dimension needs explicit authorization and clears existing drawer fit evidence. Divider-count changes preserve the prior **outer-envelope observation only**, increment the revision and require new preview acceptance; they do not certify the new part's strength, rigidity or physical fit. Evidence includes the exact protected-dimension snapshot plus `contactRegion: "full-drawer-envelope"` and the common artifact/calibration identity. This means full perimeter insertion to the intended depth, seated on the floor, and hand removal. A partial-height band or test strip is screening and cannot be recorded as full-envelope fit evidence. These fields record an observer's claim, not independent certification.

```ts
const next = applyProjectFitSpecPatch(drawer, {
  template: 'drawer-tray',
  expectedRevision: drawer.revision,
  dimensions: {},
  parameters: { dividersAcross: 3 },
});
```

Drawer patches require the explicit template discriminator. Protected edits use `authorizedInterfaceIds: ['drawer-cavity']`; an authorization list supplied by a model is still not authentication or human consent. No-op, stale-revision and safe-integer-exhaustion rules match the cup API. New general clients should consume `ProjectFitSpec` and `ProjectFitSpecPatch`; existing cup clients can remain unchanged until their UI/transport integration is deliberately updated.

## Portable saved projects

Import `@scan-to-make/contracts/saved-project` for a separate, versioned project envelope and repository. It has no Node runtime imports; the platform supplies storage. The existing fit exports and Node project-store format are unchanged. No records are migrated automatically between these two formats.

```ts
type SavedProject = {
  formatVersion: '0.2.0';
  id: string;
  revision: number;
  brief: { object: string; context: string; addition: string };
  fit: ProjectFitSpec | null;
  preview: SavedArtifactBinding | null;
  acceptedArtifact: SavedArtifactBinding | null;
};
type SavedArtifactBinding = { sourceFit: ProjectFitSpec; artifact: ArtifactRef };
```

Brief text is preserved exactly, including empty/incomplete fields. A general project starts with `fit: null`; viewing a template example does not attach one. IDs are 1–128 ASCII letters, digits, underscores or hyphens, beginning with a letter/digit. Generate a new unique ID for each project. An attached fit shares that ID; it must not reuse a fixed example seed identity.

`SavedProjectSchema`, `SavedProjectChangeSchema`, `decodeSavedProject` and `applySavedProjectChange` are the portable validation/transition boundary. `createSavedProjects(storage)` supplies these asynchronous operations:

| Operation | Behavior |
| --- | --- |
| `list()` | Sorted entries `{id, result}`; each entry has its own load outcome, including unreadable entries. |
| `load(id)` | Reads and validates current bytes; no cache or implicit recovery. |
| `create({id, brief, fit})` | Exclusive creation at saved revision zero; optional initial fit must also be revision zero. |
| `change(id, expectedRevision, change)` | Compares saved revision, validates one explicit change, then atomically replaces the bytes it read. |

Brief/fit changes are `{kind: 'replace-brief', brief}`, `{kind: 'attach-fit', fit}` and `{kind: 'patch-fit', patch}`. Attaching a fit is allowed only once, with fit revision zero. Replacing or removing an attached fit is not supported. A fit patch goes through the existing template-specific authorization and revision rules; no unrestricted `put` operation can inject a replacement fit/evidence snapshot.

Artifact review uses `{kind: 'attach-preview', sourceFit, artifact}` followed by `{kind: 'accept-preview', sourceFit, artifact}`. The full validated source fit must equal the current fit, including measurements, provenance and evidence; matching ID/revision alone is insufficient. Object property order does not matter. Acceptance requires an already attached preview with the same full source and exact SHA-256, media type and byte length. It cannot implicitly attach an unseen artifact. A different preview clears acceptance. Reattaching or accepting the identical binding is a no-op and preserves acceptance.

Saved-project and fit revisions are distinct. A brief or review-state edit increments only the saved revision. A fit attachment increments the saved revision while its fit starts at zero. An effective fit patch increments both and clears preview and acceptance; a no-op increments neither. Brief-only edits preserve review state. The fit revision cannot exceed the saved revision. Exhausted safe-integer revisions reject effective edits. Inputs are detached and validated before the first asynchronous storage call, and returned records are detached from stored bytes.

`decodeSavedProject` accepts strict legacy `0.1.0` saved-project records and normalizes them in memory to `0.2.0` with null review state. Reads and no-ops never write or migrate stored bytes. The next successful effective change writes `0.2.0`, with compare-and-swap against the **original stored string**, including its whitespace/order. A failed or conflicting migration leaves the old bytes or winning concurrent write intact. New projects use `0.2.0`; older clients that only understand `0.1.0` cannot edit migrated records. This does not migrate the separate Node project-store format.

Results are discriminated by `status`. Successful load/write returns `{status: 'ok', project}`; list returns `{status: 'ok', entries}`. Other outcomes are:

| Status | Meaning |
| --- | --- |
| `missing` | No current bytes for the requested ID. |
| `exists` | Exclusive create collided; `latest` is the existing validated record. |
| `stale` | Revision/CAS conflict; `latest` is the current validated record and `scope` is `project` or `fit`. |
| `corrupt` | Malformed JSON, invalid data or storage-key/record identity mismatch. |
| `unsupported-version` | A future/unrecognized project or known-template fit version; includes `scope` and `version`. |
| `invalid-change` | Invalid input, exhausted revision, missing/already-attached fit or a rejected protected/template edit. |
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

`read` must return a whole stored string or `null` for absence. `compareAndSwap` must compare the **entire exact stored string** (or absence for `null`) and replace it atomically, returning `true` only after successful persistence. Every writer to that namespace must participate in the same atomicity mechanism. A `getItem` followed by `setItem` without shared serialization/transaction is insufficient. One shared runtime may serialize these operations through one shared queue; separate runtimes/processes require a transaction or equivalent shared locking. Use a dedicated namespace, never the existing Node project-store files, and preserve unknown/corrupt entries for explicit recovery.

The repository neither supplies platform storage nor promises encryption, cross-process locking or crash durability. Those are properties of the adapter and must be verified there. It stores briefs, measured fit data and artifact review metadata, without captures, artifact bytes or print authorization. Metadata does not verify an STL or its physical fit. Consumers must verify the exact cached bytes against the artifact hash/length before rendering, accepting or exporting, including after reopening; missing or corrupt bytes must disable those actions. A consumer must wait for hydration before editing, retain drafts on errors/conflicts, and report a save only after an `ok` write result. Contract tests use an isolated in-memory adapter to prove repository behavior; native process-kill/relaunch proof belongs to the app integration.
