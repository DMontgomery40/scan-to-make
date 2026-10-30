# Scan cradle (preview geometry)

Make an open stand from a **repaired, watertight mm OBJ or STL**. Output is a
solid rectangular base with an object-derived pocket and a straight Z lift-out
path. No slicing, printing, strength certification or physical-fit claim.
`manifest.json` always carries `previewOnly: true` and
`provesPhysicalAccuracy: false`.

## Runtime and licence

Blender **5.0.1**, headless, plus its bundled NumPy, bmesh and mathutils; no pip
packages. The stdlib Python wrapper reuses scan-repair's Blender discovery:
`BLENDER`, then PATH, then `/Applications/Blender.app/Contents/MacOS/Blender`.
An invalid explicit `BLENDER` fails. Blender runs as a subprocess with
`--background --factory-startup --python-exit-code 1`. CLI stdout is JSON;
errors go to stderr and exit 2. Keep the sibling `tools/scan-repair` directory.

This directory is **GPL-3.0-or-later**; see [LICENSE](LICENSE) and SPDX headers.
Blender-side code runs only on the host/companion, and **never ships in the
app**. Bundled runtimes retain their own notices (NumPy: BSD-3-Clause).

```sh
python3 tools/templates/scan-cradle/cradle.py repaired.obj --out /tmp/cradle --render
python3 tools/templates/scan-cradle/cradle.py repaired.stl --out /tmp/cable-cradle \
  --clearance-mm .3 --wall-mm 2 --seat-depth .4 --margin-mm 3 \
  --up Z --notch-side +Y --notch-position-mm 0 --notch-width-mm 5
python3 -m unittest discover -s tools/templates/scan-cradle/tests -v
```

Use a fresh empty output directory. Input is read-only. All lengths are mm;
no unit guessing or rescaling. Default Z-up follows scan-repair's grounded
orientation. `--up X|Y|Z|-X|-Y|-Z` explicitly chooses another source axis;
the output is always right-handed Z-up, XY bounds centred, source bottom at
Z=0. This is a geometric frame, not an inference about the object's purpose.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `--clearance-mm` | 0.3 | Positive minimum geometric offset |
| `--wall-mm` | 2.0 | Positive floor and side wall minimum |
| `--seat-depth` | 0.4 | Seat line as a fraction of object Z height, strictly (0,1) |
| `--margin-mm` | 3.0 | Beyond object bounds plus clearance, each side; at least wall + 2 grid steps |
| `--grid-mm` | 0.4 | Maximum XY voxel-column step; smaller costs more runtime |
| `--notch-side` | none | Optional cable trench through selected side, to floor level |
| `--notch-position-mm` | 0 | Along-side coordinate in output frame |
| `--notch-width-mm` | 4 | Positive requested width; grid conservatism enlarges it |

## Pocket construction and limits

The Blender-side voxel-column offset clips every source triangle to XY voxel
neighbourhoods and retains the minimum Z. It uses a **cube (L-infinity)
offset**, containing the requested Euclidean clearance sphere, plus one grid
step in XY to cover interpolation. Subtract clearance from the lower envelope,
cap at the seat line, and sweep the void upward. Triangulate that single-valued
floor, join its perimeter to a flat bottom, and orient the closed mesh outward.
This is a direct solid construction equivalent to subtracting the swept pocket;
it avoids fragile booleans. Triangle clipping preserves local shape, including
sloped surfaces, without extra dependencies.

Every occupied XY column is cleared from its lowest surface to the opening:
wide feet and shoulders cannot leave an inward lip. It is deliberately
conservative: narrow concavities, cube corners and the grid padding make the
pocket **larger** than a precise isotropic offset. Clearance is a lower bound,
not a snug-fit target. A base made from an oversized scan stays oversized.
Smaller grid steps reduce the added XY padding. Grid limits: 512 cells per
axis and 200,000 total; increase the step if rejected.

The source frame's Z=0 sits clearance above the lowest cavity floor; the
base bottom is `-clearance - wall`. The top is `seat-depth * object-height`.
A notch clears from a selected outer side to the centre line, with floor
thickness retained. It is a deliberate wall opening, excluded from the side
wall minimum; corner-breaking notches fail. It does not identify a real port.

## Outputs and evidence

- `cradle.stl`: binary STL, mm, one closed heightfield solid.
- `manifest.json`: sorted, timestamp-free JSON with all parameters, frame,
  input/output SHA-256, watertightness, dimensions, pocket opening spans,
  sample counts and measured minimum clearance/wall thickness.
- `renders/*.png` with `--render`: all ten views through the unchanged
  `tools/scan-repair/repair.py render` helper. That helper chooses PCA, so view
  labels describe its render frame, not necessarily the cradle's output frame.

Clearance samples include every input vertex and triangle centroid, queried
against a BVH of the output mesh. Wall samples are every cavity grid vertex,
measured to the exterior base and side planes; intentional notch side excluded.
They are geometric samples, not a manufacturing tolerance, complete Hausdorff
bound or proof of strength. Acceptance fails below 90% requested clearance or
wall thickness (1e-4 mm numerical tolerance). Lift-out follows the continuous
single-valued floor construction, independently checked on serialized STL by
upward-facing interior triangles and vertical rays through source samples.
Watertightness checks closed, consistently wound edges, not real-world fit.
Manifests/STL are deterministic on a fixed runtime; cross-platform floating
point and renderer differences can change hashes. Output hashes cover the STL and, when requested, all ten renders. The manifest
does not hash itself. All outputs remain preview only.

Tests generate only synthetic temporary fixtures, run actual Blender, and skip
explicitly if absent. Cases: rounded box with Apple's published case envelope
**60.6 × 45.2 × 21.7 mm** ([Apple specifications](https://support.apple.com/en-us/111834)),
a cylinder, and a wide-foot/waist/shoulder object that traps a naive negative.
The rounded box uses an invented 5 mm corner radius, not an Apple CAD model;
it lies on its broad face to match scan-repair's default frame. Tests check
STL topology, independent distances/walls/lift rays, repeatability, alternate
up, notch, and rejected parameters. CI downloads pinned/checksummed Blender
5.0.1 and uses software-rendering libraries. Personal scans and evidence never
belong in this directory or Git.
