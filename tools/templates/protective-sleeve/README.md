# Protective sleeve (preview geometry)

Make an open-top conformal bumper from a **repaired, watertight mm OBJ or STL**.
The object drops in along -Z and lifts straight out. There is no slicing or
printing, and the sleeve makes no flexibility or physical-fit claim. `manifest.json` always carries
`previewOnly: true` and `provesPhysicalAccuracy: false`.

Runtime, licence (**GPL-3.0-or-later**, [LICENSE](LICENSE)), Blender discovery
and frame match `scan-cradle`. Shared code is in
[`../_fitted-core`](../_fitted-core/README.md). Keep `tools/scan-repair` alongside.

```sh
python3 tools/templates/protective-sleeve/sleeve.py repaired.obj --out /tmp/sleeve
python3 tools/templates/protective-sleeve/sleeve.py repaired.stl --out /tmp/sleeve-loose \
  --clearance-mm 1.2 --wall-mm 2.4 --floor-mm 1.6 --coverage 1 --up Z --grid-mm .4
python3 -m unittest discover -s tools/templates/protective-sleeve/tests -v
```

| Parameter | Default | Range | Meaning |
| --- | --- | --- | --- |
| `--clearance-mm` | 0.5 | 0.05–5 | Minimum gap to every sleeve surface |
| `--wall-mm` | 1.6 | 0.8–10, ≥ 2 × grid | Minimum conformal wall; up to one cell thicker |
| `--floor-mm` | 1.6 | 0.8–10 | Floor thickness, exact |
| `--coverage` | 0.7 | 0.1–1 | Sleeve top as a fraction of object height |
| `--up` | Z | ±X/±Y/±Z | Source axis that becomes +Z |
| `--grid-mm` | 0.4 | 0.1–2 | XY cell size |

The pocket is the object's silhouette below the sleeve top, grown by the clearance.
The outside follows the pocket at the wall distance, so a rounded case gets a
rounded bumper. Below narrower sections the prismatic pocket is loose.

Outputs are `sleeve.stl` (binary, mm) and a sorted, timestamp-free `manifest.json`. The
manifest's `fit` block holds the sampled minimum clearance, the minimum side wall, floor, pocket
opening and depth, the height of object left exposed, and the bounding box.

For the synthetic AirPods Pro 2 case envelope (60.6 × 45.2 × 21.7 mm, invented
5 mm corner radius) at defaults, the pocket opening is 61.6 × 46.4 mm with 0.5 mm sampled
clearance. The side wall is at least 1.65 mm and the floor is 1.6 mm. The bounding box is
65.6 × 50.4 × 17.29 mm.
