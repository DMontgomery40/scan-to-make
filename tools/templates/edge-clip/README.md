# Desk or shelf edge clip holder (preview geometry)

Make a clip-on holder from a **repaired, watertight mm OBJ or STL**. It is an
open-top cup whose floor is the upper jaw of a C-clamp. The clamp slides onto a desk
or shelf edge from the front. The slot opens toward -Y with the spine at +Y, and the cup sits
above the surface. There is no slicing, printing, sprung grip or load rating.
`manifest.json` always carries `previewOnly: true` and
`provesPhysicalAccuracy: false`.

Runtime, licence (**GPL-3.0-or-later**, [LICENSE](LICENSE)), Blender discovery
and frame match `scan-cradle`. Shared code is in
[`../_fitted-core`](../_fitted-core/README.md). Keep `tools/scan-repair` alongside.

```sh
python3 tools/templates/edge-clip/clip.py repaired.obj --out /tmp/clip
python3 tools/templates/edge-clip/clip.py repaired.stl --out /tmp/shelf-clip \
  --edge-thickness-mm 25 --edge-clearance-mm .8 --grip-depth-mm 60 --clearance-mm .3
python3 -m unittest discover -s tools/templates/edge-clip/tests -v
```

| Parameter | Default | Range | Meaning |
| --- | --- | --- | --- |
| `--clearance-mm` | 0.5 | 0.05–5 | Minimum gap to every pocket surface |
| `--wall-mm` | 2.0 | 0.8–10, ≥ 2 × grid | Minimum cup side wall, rounded up to the grid |
| `--hold-depth` | 0.6 | 0.1–1 | Cup top as a fraction of object height |
| `--edge-thickness-mm` | 18 | 1–60 | Desk or shelf edge thickness |
| `--edge-clearance-mm` | 0.3 | 0–3 | Added to the edge thickness; the slot height is exact |
| `--grip-depth-mm` | 25 | 5–80 | Jaw reach over the edge, rounded up to the grid |
| `--jaw-mm` | 3.0 | 2–10 | Jaw thickness (exact; the upper jaw is the floor), spine (rounded up) |
| `--up` | Z | ±X/±Y/±Z | Source axis that becomes +Z |
| `--grid-mm` | 0.4 | 0.1–2 | XY cell size |

The manifest's `fit` block reports the pocket, walls and floor, plus the slot height and Z range,
the slot opening and spine planes, grip depth, spine and jaw thickness, and the bounding box. The tests
measure the slot height independently by ray casting up and down from inside the slot.
They also check that the slot is open toward -Y and that the spine sits at the reported plane.

For the synthetic AirPods Pro 2 case envelope at defaults, the pocket opening is 61.6 × 46.4 mm
with 0.5 mm clearance. The side wall is 2.0 mm and the floor and jaws are 3.0 mm. The slot is 18.3 mm for an
18 mm edge, the grip 25.2 mm and the spine 3.2 mm. The bounding box is 65.6 × 50.4 × 37.82 mm.
