# AI-tweak judge renders (KAN-184)

Headless Blender scripts for the visual pick. They render the captured scan and each AI attempt from
the same fixed cameras, measure how far an attempt moved the captured surface, and build the
side-by-side images a sealed judge compares with the close-up photos. The companion's
`services/companion/src/ai-tweak-pick.ts` drives them as subprocesses; see
`services/companion/AI-TWEAK.md`.

| Script | Run with | Does |
| --- | --- | --- |
| `render.py` | `blender -b --factory-startup -P render.py -- --mesh M.obj --cams cams.json --out DIR [--make-cams] [--ring] [--resolution 1600]` | 8 views (front, back, left, right, top, bottom, two isos), plus 8 ring views with `--ring`, each textured and plain grey. The cameras come from the captured scan's box and are reused for every attempt. Shading is always flat and comes from the geometry, so an attempt's own smooth normals can't hide melted detail. |
| `measure.py` | `blender -b --factory-startup -P measure.py -- --reference raw.obj --candidate attempt.obj --out m.json [--mm-per-unit 1000]` | Distances in mm, both ways, between the captured scan and the attempt (mean, p50, p95, max, share over 0.1 mm), plus boxes, closed-mesh and shell counts. |
| `sheet.py` | `python sheet.py --out DIR --cell 800 A=dir B=dir …` | One `compare_<mode>_<view>.png` per view, with the candidates side by side under blind letters. |

The cameras are fixed, not each photo's own viewpoint. Registering each still's pose is KAN-190.

## Runtime and licensing

Tested with **Blender 5.0.1**, the build pinned by `deploy/companion/download-blender.sh`. `render.py`
and `measure.py` use Blender's bundled `bpy`, `bmesh` and `mathutils` (GPL-3.0-or-later). `sheet.py`
needs Pillow (`requirements.txt`).

**This entire directory is GPL-3.0-or-later**; see [LICENSE](LICENSE) and the SPDX headers. The MIT
companion only runs these scripts as separate processes. They run on the companion side only and
**must never be bundled into the iOS or Android app**.

## Why not bambu-printer-mcp

bambu-printer-mcp's `blender_mcp_edit_model` applies decimate, remesh or boolean-union edits to an
STL and writes an STL. It has no render, camera or texture path, and it runs through a Blender MCP
bridge rather than headless. The judge needs textured, pixel-aligned renders of OBJ bundles from
fixed cameras, so these scripts reuse the KAN-177 bpy harness instead. Slicing and printing stay in
bambu-printer-mcp.
