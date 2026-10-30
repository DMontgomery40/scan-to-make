# Fitted-template core (support folder, not a template)

Shared code for `wall-mount`, `protective-sleeve` and `edge-clip`, which turn a
**repaired, watertight mm OBJ or STL** into preview accessory geometry. It
reuses `tools/scan-repair` for loading, topology statistics and hashing, the
same way `scan-cradle` does. **GPL-3.0-or-later**; see [LICENSE](LICENSE).
Blender-side code runs on the host or companion and never ships in the app.

| File | Runs in | Role |
| --- | --- | --- |
| `fit_core.py` | Blender 5.0.1 | Frame, silhouette pocket, cell masks, voxel solid, STL, manifest |
| `cli_core.py` | Python stdlib | Bounds and input/output checks, one isolated Blender process |
| `synthetic_fixtures.py` | Blender | Test meshes: AirPods Pro 2 case envelope box, cylinder, wide shoulder |
| `inspect_fit.py` | Blender | Independent checks on the serialized STL |
| `fit_testing.py` | Python stdlib | unittest harness used by each template's tests |

## Frame

As scan-cradle: `--up` picks the source axis that becomes +Z. The output frame is right-handed,
the XY bounds are centred, and the source bottom sits at Z = 0. No unit guessing or rescaling.

## Construction

1. **Pocket.** On an integer XY grid (cell `i` spans `[i*g, (i+1)*g]`), a cell is pocket
   if its square, grown by the clearance in L-infinity, meets the XY projection of
   any source triangle that starts below the part's highest material. A separating-axis
   test does this exactly per triangle. Every cell left solid is more than the clearance from the object
   horizontally. The pocket floor sits at `Z = -clearance`. The pocket is a vertical prism, so
   the object lifts straight out along +Z.
2. **Walls.** Either a Euclidean cell-square offset (sleeve: every cell within the wall
   distance of the pocket, so the outer face is at least `wall` away) or a rectangle
   rounded up to whole cells (mount, clip).
3. **Solid.** The template stacks 2D masks on exact Z levels. Faces are emitted only between solid and empty cells,
   with vertices shared by grid index. Masks are grown so that no cells touch only at
   a corner. Adjacent layers are nested. The result is a closed, consistently wound
   surface with no booleans; scan-repair's `stats()` re-checks it.

## Evidence

The manifest's `fit` block reports the design clearance and the sampled minimum distance
from every source vertex and triangle centroid to the output mesh. It also reports the
blocked +Z lift rays (must be 0), the exact minimum side wall between pocket and outside
cells, floor thickness, pocket opening and the output bounding box. Acceptance fails if the
sampled clearance falls short of the requested value (1e-4 mm), any lift ray is blocked,
or a wall is thinner than requested. Tests then run `inspect_fit.py` on the STL, which
casts rays to measure wall and floor thickness and template-specific probes
(screw holes, clamp slot).

These are geometric samples. They do not establish physical fit, strength or
manufacturing tolerance, and the manifest always carries `previewOnly: true`.
