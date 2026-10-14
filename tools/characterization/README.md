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
  --material "PLA" --slicer-settings-file exported-profile.json

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
  per side. Pips on the base number the slots 1–6, tightest first. The peg's
  insertion end is relieved 0.3 mm per side over its first 1.2 mm so
  first-layer elephant's foot cannot decide the reading.
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
6. Optional: round boss diameter across vertices → `roundBossMm`

`coupon.py profile` turns those into XY scale (+correction), square and
round outer bias, mean hole bias (negative = holes print small),
`printedPairClearanceMm`, and minimum reliable wall.

Two different clearances, do not conflate them: the ladder measures a
printed peg in a printed slot, so `printedPairClearanceMm` stacks outer and
hole bias together. The contracts `radialClearance` is the per-side gap
between a printed insert and an *unprinted* holder bore; sizing that
interface uses XY scale plus (round) outer bias at holder scale. The profile
never feeds a FitSpec silently — a human or a later explicit step converts.

## How this plugs into CORE-001

The manifest's `artifact` is exactly the contracts `ArtifactRef`
(`sha256`/`mediaType`/`byteLength` of the emitted bytes) and its
`calibrationScope` matches `CalibrationScopeSchema` — both verified against
the built `packages/contracts` validators. Shape compatibility is all that
claims: this generic coupon has no insert geometry, so it **cannot** serve
as `FitEvidence` for a `holder-insert` snapshot. Fit evidence still needs a
printed insert (or insert-band coupon) tried in the real holder; this coupon
helps choose the dimensions that get printed. Referencing a capability
profile from a FitSpec would be a contracts change, handled separately.
Per-side clearance naming follows the contract (never a diameter allowance).
Scope discipline stands: another printer, nozzle, material, orientation, or
settings digest needs its own coupon.

## Honest limits

- Defaults are a **template scope** (`scopeStatus:
  template-replace-before-evidence`) — including when printer/material are
  declared but slicer settings are left unspecified. Declaring real values
  is an operator claim; nothing here verifies them. Settings evidence is
  recorded honestly in `slicerSettingsEvidence.source`: `file-bytes` means
  the digest covers an exported settings file's exact bytes
  (`--slicer-settings-file`), `declared-string` means it covers only the
  name/text passed to `--slicer-settings`, `unspecified` means no settings
  were supplied. Settings contents themselves are never stored.
- Round features are 64-facet polygons; caliper across vertices reads the
  nominal diameter. Faceting is part of the measured artifact identity.
- This generator has been verified structurally (closed-mesh volume equals
  the analytic design volume) and against the contract schemas. **No
  physical print has been made or claimed** — first plastic, measurements,
  and the resulting profile are the next evidence step.
- Geometry files only. No slicing, dispatch, or printer contact lives here;
  that stays behind the companion's inspection/approval gates.
