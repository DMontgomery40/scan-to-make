# Scan-to-checked-STL pipeline

MIT, Python 3.11+ standard-library subprocess orchestration. This command ends
at a printability-checked **preview STL plus hash-bound manifest**. It does not
slice, orient, inspect sliced files, contact a printer, accept a project on the
user's behalf, or authorize dispatch.

```sh
# Use a Python environment with capture-mesh-convert/requirements.txt installed.
BLENDER=$HOME/opt/blender-5.0.1/blender LIBGL_ALWAYS_SOFTWARE=1 \
  xvfb-run -a python3 tools/make-pipeline/make.py capture.usdz \
  --make scan-cradle --reference 60 45 22 --profile p1s-0.4-hardened \
  --out /private/fresh-job

python3 tools/make-pipeline/make.py capture.obj --units mm \
  --make wall-mount --param clearance_mm=0.5 --param 'up="X"' \
  --stills /private/detail-stills --profile p1s-0.4-hardened \
  --out /private/fresh-wall-job
```

Keep the existing sibling tools and their licences installed. Blender 5.0.1
runs only in those subprocesses; this directory imports no GPL worker or bpy.
Linux headless renders need Xvfb/software GL. OBJ requires explicit units;
USDZ uses authored units and retains the textured converter's provenance.
`--reference W H D` declares millimetres: original order is recorded and values
are sorted long-to-short for every **boxExtentsMm** comparison. Dimension fitting
is by construction, not evidence of physical accuracy. `--profile` is explicit;
no printer identity or installed nozzle is inferred.

## Stages and Match boundary

Intake → textured conversion (USDZ only) → repair → measure → advise → bounded
correction → optional planner → **Match** → Generate (`design`) → printability.

Named templates are `scan-cradle`, `wall-mount`, `protective-sleeve`, `edge-clip`.
`--param NAME=JSON` accepts catalogued parameters only; templates enforce their
own numerical and relational constraints. Match records the selected catalog
entry, parameters, selection source and catalog hash **before** generation.
A named template is an explicit CLI selection. A free-text request uses the
optional `tools/design-planner/planner.py`; only a `ready` plan selecting one of
these four templates proceeds through Match. `needs-input`, `no-fit`, rejected
plans and missing planner stop before generation. With the scripted adapter,
free text needs the planner's own `--planner-script replies.json` format.

This is a **local template subset** of the
[Made to Fit PRD §8.1](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/prd/scan-to-print-PRD.md#81-pipeline).
Full registry/FitBase interface-signature matching, a free-remix offer, the
critic, intake FitSpec/use-class handling and free-form coding are not
implemented here. Match reports the missing registry/FitBase search explicitly;
it does not misrepresent a catalog selection as a complete PRD Match. There is
no automatic free-form fallback or claim of full PRD compliance.

Advice uses the original textured capture when its declared scale is m/cm/mm,
so its views use the original capture frame. Other authored USD scales use
repaired geometry with a warning. Scan-repair drops UVs; correction and design
consume repaired mm geometry without guessed UV transfer. Private work folders
retain original textures. Advice renders are neutral and texture-free.

`--adapter scripted` is the default: measure, then fit declared reference sizes
if supplied. It does not reconstruct details, guess symmetry or cut features.
`--script sequence.json` supplies a bounded existing correction sequence; any
failed tool call stops before design even if the runner later exports. Explicit
`--adapter anthropic|openai`, `--model`, `--base-url`, `--key-env` forward to the
existing adapters. Keys come only from the selected environment variable, are
admitted only to model stages and are never supplied in argv. Real provider
runs require the caller's credential/spend authorization.

`--stills DIR` snapshots 1–4 PNG/JPEG/WebP files in sorted order, each resolving
inside that directory, and forwards paths as correction `--still` arguments.
Runner logs retain still IDs/hashes and model-declared edit associations;
attachment alone does not prove an image informed an edit.

## Companion handoff: reuse Bambu capabilities

Read [docs/print-path.md](../../docs/print-path.md) and
[bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp) (reviewed
against 1.1.41) before extending this boundary. No Bambu MCP capability supplies
this capture/conversion/template orchestration or the offline geometric
printability analysis, so those existing Scan to Make tools are invoked here.

The following capabilities already cover subsequent work and are deliberately
**not implemented or called by this CLI**:

- `lay_flat(stl_path)` places the largest flat face on XY at Z=0. It can address
  mechanical parts needing flat-face placement; it is less reliable on organic
  geometry without a dominant face. This CLI checks the template frame unchanged
  and fails the gate if necessary. Companion orientation must produce a new
  snapshot, new hashes and a fresh printability check.
- `slice_stl` accepts the explicit model, nozzle diameter/type, bed type and
  `orient`/`arrange`; it resolves the exact machine preset and exports sliced 3MF.
- `inspect_print_file` inspects exact sliced-file bytes and a selected plate
  without contacting a printer; it establishes no readiness or dispatch authority.

The companion's accepted-artifact/prepared-job flow owns these calls in a
separate credential-free process with a file-only tool allowlist and no
`PRINTER_HOST`, `BAMBU_SERIAL`, `BAMBU_TOKEN`. Human-approved dispatch uses its
separate credentialed flow. This tool creates no prepared job, approval intent,
MCP client, slicer wrapper, orientation picker or fake-slicer production flag.

## Outputs and integrity

- `manifest.json`: exact STL path/hash/size in mm, source template-manifest
  receipt, printability-report receipt, verdict/profile/material/support choice,
  `acceptedByHuman: false`, and the companion handoff boundary. It is a local
  checked-design receipt, not a PreparedJob or contract FitProof.
- `pipeline-report.json`: sorted timestamp-free stage verdicts, inputs/outputs
  with SHA-256/size, tool entry-point hashes, capabilities, limits and PRD gaps.
- `*-result.json` and `tool-calls.jsonl`: canonical projections of tool results.
  Job/tool roots become `$JOB`/`$TOOLS`; elapsed time is omitted and the correction
  log receipt binds normalized log bytes. Raw tool reports remain untouched.
- `timings.json`: elapsed durations and exact raw-diagnostic/correction-log
  receipts, excluded from the stable report hash. `summary.txt`: human summary.

Before checking, the template manifest must bind the mm preview STL. The
printability input digest must match that snapshot and the bytes must remain
unchanged. `not-printable` blocks publication; `printable-with-supports` needs
`--allow-supports`. A complete result still has no physical-fit or print approval.
Byte repeatability requires identical inputs/configuration/tool versions and
output bytes on the same runtime; real model and runtime changes can change
output hashes. The synthetic suite proves repeatability with actual geometry.

## Bounds and verification

Defaults: 1,800 s total, 600 s per subprocess, 200,000 faces, 24 correction calls.
Hard ceilings: 7,200 s total, 900 s per subprocess, 1,000,000 faces, 100 calls.
Stage timeout/cancellation kills the process group and discovered descendant
workers, including separate sessions (`/bin/ps` required for tree discovery).
Existing geometry tools retain their tighter operation/work bounds. No retries
or arbitrary executable/model-written-code interface exists.

Input caps: 128 MiB/file; OBJ graph 32 assets / 256 MiB; USDZ 256 members /
256 MiB declared expanded bytes; stills 16 MiB each; scripts 1 MiB; tool JSON
stdout 16 MiB before parsing. OBJ materials are fully validated and snapshotted
before any Blender import: no non-`.mtl` material references, absolute/parent
asset paths, escaping symlinks or unsupported directives. These are work caps,
not OS memory/disk quotas or a filesystem sandbox. Keep source/job directories
private and unmodified while staging. Fresh output is mode 0700; captures,
textures, stills, requests and logs never belong in Git or public image posts.

Exit 0 means checked STL + manifest produced; exit 2 names a failed stage and
retains private diagnostics. Invalid preflight arguments create no report.

```sh
BLENDER=$HOME/opt/blender-5.0.1/blender LIBGL_ALWAYS_SOFTWARE=1 \
  xvfb-run -a python3 -m unittest discover -s tools/make-pipeline/tests -v
python3 -m unittest discover -s tools/licence-audit/tests
```

Synthetic tests exercise real conversion, repair, advice, correction, template
geometry, printability and repeatable receipts; optional planner statuses use
unit doubles. Tests also cover material escapes, bounded/cancelled subprocesses,
secret filtering and fail-fast correction. No slicer or printer is involved.
CI installs checksum-verified Blender and the converter's pinned requirements,
then fails on any unexpected skipped test.
