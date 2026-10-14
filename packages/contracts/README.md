# Fit contract 0.1.0

A shared TypeScript/JSON boundary for the first cup-holder adapter. Runtime validation and TypeScript types use the same Zod schemas. The package has no Node runtime imports and can be consumed by the mobile shell. Build and tests run locally:

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
