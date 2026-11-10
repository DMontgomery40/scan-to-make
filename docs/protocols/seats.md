# Seats: where the scanned object sits in a fit part

A part made to fit a scanned object (a holder, a cradle, a hook, a case) has places for that object. The pass that
designs the part knows where they are, because it built the pocket for it, so it says so in its answer. Every client
then shows the part with the object in place (the project gallery's **Together** entry, PRD §5.4), and the code
engine's fit check uses the same numbers. David, Nov 10: "it's generally painfully painfully obvious where the object
should be."

## The two frames

Both are millimetres with +Z up.

- **The part:** the model as the pass exported it (`current/model.stl`; the worker's `out/touched.stl`, or the code
  engine run it marked final), in the orientation it is used in. This is the file the companion serves at
  `GET /v1/objects/<id>/model.stl`, unchanged.
- **The scan:** the project's scan model as the companion serves it (`GET /v1/objects/<id>/scan/<scan>`, normally
  `scan.usdz`), in its own world coordinates (every prim's transform applied, as the capture converter writes it),
  scaled to millimetres (× 1000 × `metersPerUnit`) and turned so its up axis is +Z by the smallest rotation. An Object
  Capture scan is metres with +Y up, so a point (x, y, z) becomes (1000x, −1000z, 1000y). It is **not** moved, centred
  or dropped to the floor.
  - This is the printer MCP's `load_scan(name, source_units="m", up_axis="y", ground=False)` on the capture
    converter's OBJ (bambu-printer-mcp `src/cad/worker.py`, `scan_loader`). With the default `ground=True` the MCP
    lifts the scan so its lowest point is at z = 0; seats are never given in that lifted frame.
  - It is **not** what `mac-reconstruct stl` writes for a copy's model: that STL is centred and rests on z = 0
    (`tools/mac-reconstruct/Sources/mac-reconstruct/main.swift`), so it can't be used as the scan frame.
  - Blender's USD import with its default up-axis conversion gives the same turn; the worker scales metres to millimetres.

## A seat

```json
{"name": "left", "rotationDeg": [0, 0, 0], "translationMm": [-71.32, -26.04, 1.75],
 "check": {"minimumGapMm": 0, "interferenceMm3": 379.67, "clear": false}}
```

- The scan is turned about the fixed X, then Y, then Z axes through the origin (`rotationDeg`, degrees), then moved
  (`translationMm`). As a matrix: Rz·Ry·Rx, then the translation; trimesh's `euler_matrix(rx, ry, rz, 'sxyz')`. This is
  exactly the `transform` (`rotation_deg`, `translation_mm`) that bambu-printer-mcp's `cad_check_fit` takes, so the
  worker checks the seat it reports.
- `name` is there when there is more than one ("left", "middle", "right").
- `check` is what `cad_check_fit` returned for that seat, when the worker ran it: information for the view ("0.8 mm
  clear"), never a verdict the app makes. Counterpart does no fit geometry of its own.

## Who writes them, and what the companion checks

- **The worker** answers with `seats` (`TOUCHUP_RESULT_SCHEMA`, `services/companion/src/touchup/invocation.ts`) on
  every fit pass that has the scan: the "Where the scanned object sits:" rule section. A fit from measurements alone
  has no scan and no seats. A change pass is given the current seats and restates them for the changed model.
- **The companion** keeps them on `current.seats` (`services/companion/src/objects/seats.ts`) and refuses nonsense
  cheaply, with what it already has: the scan's box placed at a seat must overlap the part's box, and no two seats may
  be the same place. The scan's box comes from the capture converter's OBJ in the frame above. A refused set is
  dropped with a line in the pass's activity; the model is kept.
- **Seats are never inherited by a changed model.** A pass that changed the geometry and gave no seats leaves none (no
  Together view rather than a stale one). A pass that changed nothing (`unchanged`) keeps them.

## Locate: seats for a part made before passes gave them

`POST /v1/objects/<id>/locate` (WRITE; local `objects.locate`) starts a short pass that only says where the object
sits in the existing part: the worker gets the part's STL and the scan, its rules forbid editing or exporting
anything (`LOCATE_RULES`), and the companion refuses an answer that comes with a model. Only a fit project with a
scan and an STL model, not printing or working. The project goes back to the state it had; its seats join
`current.seats` when they pass the check above; otherwise the pass is `failed` with the reason in its activity.
Clients offer it as **See it together** on the part's picture when `current.seats` is empty.

## Drawing it

- iPhone, iPad and Mac draw Together live in RealityKit: the part's STL (millimetres, Z up) turned to the stage
  (metres, Y up: (x, y, z) → (x, z, −y) / 1000), and the scan entity (metres, Y up) moved into the seat frame, placed
  by each seat, and turned back to the stage with the part (`ModelStage`, both apps).
- The Mac's companion also draws it once as a picture (`pictures.together`, `mac-reconstruct picture --object … --seat
  …`), for Android, Linux and anything else that shows pictures.
