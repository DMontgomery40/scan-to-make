# Drawer tray template 0.1.0

Turns a validated `DrawerFitSpec` into an open drawer tray: a solid
floor, perimeter walls, and a uniform divider grid in the contract frame
(right-handed, Z-up, origin at the inner drawer floor centre; X width, Y
depth). Output is a deterministic binary STL plus a JSON manifest.

```sh
python3 drawer.py generate \
  --spec ../../../packages/contracts/fixtures/drawer-tray.json \
  --out-dir examples
python3 -m unittest discover -s tests -v
```

## Construction follows the merged contract

The generator does not invent a second sizing model. It consumes the merged
drawer schema (`schemaVersion: "0.2.0"`, `template: "drawer-tray"`)
and its deterministic formulas:

```text
outerWidth  = drawerInnerWidth.lowerMm - 2 * peripheralClearance.upperMm
outerDepth  = drawerInnerDepth.lowerMm - 2 * peripheralClearance.upperMm
outerHeight = trayHeight.nominalMm
wall        = wallThickness.nominalMm
floor       = floorThickness.nominalMm
dividerTop  = outerHeight - 2 mm
```

Peripheral clearance is consumed at its upper bound on each side. The
synthetic contract fixture yields a 297.8 × 397.8 × 40 mm tray, a 2 mm wall
and floor, a divider top at 38 mm, and nominal clear cells of
96.6 × 195.9 mm. Worst-case validation uses the smallest drawer, largest
clearance and largest wall thickness; undersized cells and impossible heights
are rejected instead of silently capped or shrunk.

Divider positions are uniform within the inner cavity. `dividersAcross`
creates internal walls across the depth at successive X positions;
`dividersAlong` creates internal walls across the width at successive Y
positions. The manifest records the derived centers and clear spans.

## Geometry and evidence boundaries

The STL is one closed, outward-wound orthogonal mesh built from shared grid
cells, so wall/divider crossings do not duplicate coincident faces. Outer
corners are square: the manifest declares `cornerRadiusAssumedMm: 0`. Width
and depth intervals do not prove that a real drawer's corners are square;
measurement and physical fitting must establish applicability. An input tray
cannot become a smaller rounded design silently.

The example artifacts in `examples/` use the synthetic contract fixture, not
a measured drawer. They are preview/check geometry with status
`preview-geometry-not-print-authorized`, not manufacturing-tolerance,
strength, rigidity or physical-fit evidence. Full-envelope fit evidence
requires a printed tray to be inserted around its full perimeter, seated on
the drawer floor and removed by hand under the exact protected dimension
snapshot and calibration scope. Printing remains behind the companion's
inspection and approval gates.

## Contract boundary

`packages/contracts` remains authoritative for validation, protected edits,
evidence and persistence. This stdlib-only module re-checks the exact drawer
fields and relationships it consumes, refuses unknown/malformed or impossible
inputs, and deliberately offers no cup-to-drawer field aliases or conversion.
Changing divider counts can preserve only the earlier outer-envelope
observation under the contract rules; it produces a new preview artifact and
does not certify the changed tray's new physical fit.
