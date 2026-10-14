# Cup-holder adapter template 0.1.0 (FIT-002)

Turns a validated FitSpec (see `packages/contracts`) into adapter geometry:
a tapered hollow insert, a floor at the holder rim, and a cradle ring for the
cup — a surface of revolution in the contract frame (Z-up, origin at holder
base centre), emitted as a deterministic binary STL plus JSON manifest.

```sh
python3 adapter.py generate \
  --spec ../../../packages/contracts/fixtures/tapered-holder.json \
  --out-dir examples
python3 -m unittest discover -s tests -v
```

## Sizing policy (intervals, not nominals)

Every FitSpec dimension arrives as a conservative interval. Geometry consumes
the ends that guarantee fit across the whole interval:

- insert outside = holder **lower** bound / 2 − radial clearance (per side,
  the contract convention — never a diameter allowance)
- insert length = insertion depth **lower** bound (never bottoms out early)
- cradle inside = cup **upper** bound / 2 + radial clearance
- wall thickness and support height are design choices, taken at nominal

The cup rests on the floor at `depth + wall`; engaged support height is
`cupSupportHeight − wall`. If the holder is too narrow for the wall, or the
cup too narrow for the template, generation refuses instead of emitting
self-intersecting geometry.

## Relationship to the rest of the slice

- `packages/contracts` stays the authoritative validator. This module
  re-checks only the fields it consumes and fails loudly on malformed input.
- The manifest `artifact` is a contracts `ArtifactRef`, so previews can flow
  through `services/project` attach/accept exactly like other artifacts.
- FIT-001's characterization coupon supplies the machine truth (actual
  achievable clearance per printer/nozzle/material). This template trusts the
  clearance written in the spec; the coupon is how that number earns trust.
- This is **preview/check geometry** (`status:
  preview-geometry-not-print-authorized`). No slicing, dispatch, or printer
  contact lives here; that stays behind the companion's inspection and
  approval gates, and no physical fit is claimed until one is printed and
  measured.

Round features are 96-facet polygons (vertices on the nominal radius). The
generator is stdlib-only and byte-deterministic; tests pin the golden hash
and check closed-mesh volume against the exact revolved volume.
