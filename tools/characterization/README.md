# Characterization coupon 0.1.0 (FIT-001)

One print that characterizes a printer + nozzle + material + settings profile
once — achievable radial clearance, hole bias, outer bias, XY scale, and
minimum reliable wall — so later fit work starts from measured machine facts
instead of a fresh coupon per interface. This is the fit-first plan's Bet 4,
scoped exactly the way the team agreed: a single stepped print per
interface/printer/nozzle/material/orientation combination.

```sh
# generate STL + manifest (stdlib Python 3 only, fully deterministic)
python3 coupon.py generate --out-dir examples \
  --printer-id p1s-01 --printer-model "Bambu P1S" --nozzle-mm 0.4 \
  --material "PLA" --slicer-settings "your-exported-profile-name"

# after printing and measuring, derive the capability profile
python3 coupon.py profile --measured measurements.json

# tests
python3 -m unittest discover -s tests -v
```

`examples/` holds a ready-to-slice example pair generated with the default
(unspecified) scope. Regenerating with the same parameters always produces
byte-identical output; the test suite pins the golden SHA-256.

## What's on the plate (116 × 102 × 18 mm, Z-up, everything on z=0)

- **Clearance ladder** — a 12.00 mm peg and six slots of width
  peg + 2×clearance for clearance steps 0.00/0.05/0.10/0.15/0.20/0.30 mm
  per side. Pips on the base number the slots 1–6, tightest first.
- **Ring bores** — through-holes of Ø 4/6/8/10 mm (64-facet), wall 3 mm.
- **Bosses** — 20 mm square and Ø 20 mm round outer references.
- **Shrinkage bar** — outermost faces exactly 100.00 mm apart.
- **Wall ladder** — fins of 0.8/1.2/1.6/2.0/2.4 mm, thinnest first.

Pieces are disjoint solids in one STL (peg separate from ladder, rings
straight on the plate). Slicers handle this as one job; there is no support
geometry and nothing needs assembly before measuring.

## Print it, then measure five things (~3 minutes)

Print in the material/profile you want characterized, plate-side down as
generated, no supports. Then record:

1. First slot the peg slides through under its own weight → `firstFreeSlotIndex` (0-based)
2. Largest pin/drill shank passing each ring, or inside-caliper → `ringBoresMm`
3. Square boss outside-caliper across X → `squareBossMm`
4. Bar outermost-faces outside-caliper → `shrinkageBarMm`
5. Thinnest fin that printed complete and survives a firm finger flex → `minReliableWallMm`

`coupon.py profile` turns those into XY scale (+correction), outer bias,
mean hole bias (negative = holes print small), recommended radial clearance,
and minimum reliable wall.

## How this plugs into CORE-001

The manifest's `artifact` is exactly the contracts `ArtifactRef`
(`sha256`/`mediaType`/`byteLength` of the emitted bytes) and its
`calibrationScope` matches `CalibrationScopeSchema` — both verified against
the built `packages/contracts` validators, including a full `FitSpec`
carrying this coupon as `FitEvidence.couponArtifact`. Radial clearance here
is per-side, same convention as the contract (never a diameter allowance).
Reuse rule from the contract stands: evidence belongs to its exact scope —
another printer, nozzle, material, orientation, or settings digest needs its
own coupon.

## Honest limits

- Defaults are a **template scope** (`scopeStatus:
  template-replace-before-evidence`). Declaring real printer/material values
  is an operator claim; nothing here verifies them, and a digest of your
  settings string is stored, never the settings themselves.
- Round features are 64-facet polygons; caliper across vertices reads the
  nominal diameter. Faceting is part of the measured artifact identity.
- This generator has been verified structurally (closed-mesh volume equals
  the analytic design volume) and against the contract schemas. **No
  physical print has been made or claimed** — first plastic, measurements,
  and the resulting profile are the next evidence step.
- Geometry files only. No slicing, dispatch, or printer contact lives here;
  that stays behind the companion's inspection/approval gates.
