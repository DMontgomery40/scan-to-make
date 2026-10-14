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
