# Wall mount holder (preview geometry)

Make a screw-on wall pocket from a **repaired, watertight mm OBJ or STL**. It has an open-top
cup, fused to a back plate on the -Y side, with two screw holes above the cup.
The wall is the plane `y = fit.plateBackYMm`. The object drops in along -Z.
There is no slicing, printing or load rating. `manifest.json` always carries
`previewOnly: true` and `provesPhysicalAccuracy: false`.

Runtime, licence (**GPL-3.0-or-later**, [LICENSE](LICENSE)), Blender discovery
and frame match `scan-cradle`. Shared code is in
[`../_fitted-core`](../_fitted-core/README.md). Keep `tools/scan-repair` alongside.

```sh
python3 tools/templates/wall-mount/mount.py repaired.obj --out /tmp/mount
python3 tools/templates/wall-mount/mount.py repaired.stl --out /tmp/mount-upright \
  --up Y --clearance-mm .8 --screw-spacing-mm 20
python3 -m unittest discover -s tools/templates/wall-mount/tests -v
```

| Parameter | Default | Range | Meaning |
| --- | --- | --- | --- |
| `--clearance-mm` | 0.5 | 0.05–5 | Minimum gap to every pocket surface |
| `--wall-mm` | 2.0 | 0.8–10, ≥ 2 × grid | Minimum cup side wall, rounded up to the grid |
| `--floor-mm` | 2.0 | 0.8–10 | Cup floor thickness, exact |
| `--hold-depth` | 0.6 | 0.1–1 | Cup top as a fraction of object height |
| `--plate-mm` | 3.0 | 2–10 | Back plate thickness, rounded up to the grid |
| `--plate-extension-mm` | 16 | 8–80, ≥ hole + 2 × wall | Plate height above the cup |
| `--screw-hole-mm` | 4.5 | 2–8 | Screw clearance diameter |
| `--screw-spacing-mm` | 30 | 4–200, ≥ hole + 2 × wall | Hole centre spacing along X; the plate widens to fit |
| `--up` | Z | ±X/±Y/±Z | Source axis that becomes +Z |
| `--grid-mm` | 0.4 | 0.1–2 | XY cell size |

The pocket covers the whole silhouette below the plate top, so the plate also clears
parts of the object above the cup. The screw holes are stepped cell approximations
that contain the requested disc. They have no countersink, so use pan-head screws.
The manifest's `fit` block reports the
pocket, walls, floor, plate thickness, back-wall total, hole centres and spans, and
the bounding box. The tests cast rays through each hole centre and rim and against
the solid plate between the holes.

For the synthetic AirPods Pro 2 case envelope at defaults, the pocket opening is 61.6 × 46.4 mm
with 0.5 mm clearance. The side wall is 2.0 mm, the floor 2.0 mm and the plate 3.2 mm. The holes span
5.2 × 4.8 mm for the 4.5 mm request. The bounding box is 65.6 × 53.6 × 31.52 mm.
