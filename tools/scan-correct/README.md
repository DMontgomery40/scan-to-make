<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Scan correction (preview only)

A small measured Blender tool library and a host-side model runner. This entire
folder is **GPL-3.0-or-later**; see [LICENSE](LICENSE). Run it on a server or
companion, **never bundle it into the mobile app**. It cannot certify physical
accuracy or authorize printing. Every successful operation and report carries
`previewOnly: true` and `provesPhysicalAccuracy: false`.

## Runtime

Linux, Python 3.10+, **Blender 5.0.1**, and system `libseccomp.so.2`. Blender
supplies numpy/bmesh/mathutils. The host uses Pillow for still decoding/resizing and pillow-heif for HEIC.
Install them with `python -m pip install -r tools/scan-correct/requirements.txt`.
The model adapters use only Python's standard library.
Keep the sibling `tools/scan-repair` folder: import/export, rendering and
`boxExtentsMm` measurement reuse that GPL core. No research stacks, SDKs or
pip packages are required for the correction worker. Blender retains its own
runtime notices, including NumPy's BSD licence. Blender discovery is `$BLENDER`,
then PATH, then the repair helper's fallback; network isolation currently
requires Linux even if Blender can be found on another platform.

```sh
export BLENDER=$HOME/opt/blender-5.0.1/blender
python3 tools/scan-correct/correct.py tools  # JSON tool schemas
python3 tools/scan-correct/correct.py run capture.obj --units mm \
  --texture optional-base-colour.png --still optional-detail.jpg \
  --product 'measured enclosure' --reference-mm 60.6 45.2 21.7 \
  --out /tmp/correction --adapter anthropic --max-steps 24 --max-seconds 600
```

Only the mesh, declared `--units mm|cm|m`, and fresh `--out` directory are
required. Omit optional flags rather than passing placeholder filenames.
Textures/UVs are imported directly from the merged capture converter's
OBJ/MTL/PNG output. `--texture` overrides the sampled image but still requires
UVs; an override uses repeat sampling. Up to four PNG/JPEG/WebP/HEIC detail stills
(up to the companion's 25 MiB each) go to the model for interpretation; they are not silently
registered to the mesh. No frame, units or product dimensions are inferred
from a filename. Reference dimensions must be ordered long to short.

Anthropic defaults to `claude-opus-5-5` and reads `ANTHROPIC_API_KEY` only when
explicitly selected for a run. The OpenAI-compatible adapter uses
`/chat/completions`, requires an explicit provider model ID, and accepts
`--base-url` and `--key-env` for GPT/Kimi-compatible providers. For example:

```sh
python3 tools/scan-correct/correct.py run capture.obj --units mm --out /tmp/gpt-run \
  --adapter openai --model "$PROVIDER_MODEL_ID" --key-env OPENAI_API_KEY
python3 tools/scan-correct/correct.py run capture.obj --units mm --out /tmp/kimi-run \
  --adapter openai --model "$KIMI_MODEL_ID" --base-url "$KIMI_BASE_URL" --key-env KIMI_API_KEY
```

Model IDs, image support and tool-call support depend on the endpoint/account.
No real-provider run has been qualified yet. No keys are installed or requested
by this tool. HTTP is allowed only for loopback test endpoints; remote endpoints
must use HTTPS. Redirects are refused. Provider errors are sanitized, not echoed
with headers or response bodies. There are no retries or hidden model changes.
Provider usage/cost accounting belongs to the caller; max steps and wall time
are execution limits, not a monetary spending limit.

## Tool contract

`schema.py` is the closed, shared vocabulary; `correct.py tools` emits JSON
schemas with no additional properties. `host.Worker.stage(mesh, units, texture)`
initializes a private work directory, then `Worker.apply(name, arguments)`
accepts JSON-compatible objects and returns JSON-compatible results. The worker
subprocess receives one `request.json` and produces one `result.json`; the
model cannot supply those paths or call internal initialize/export operations.

Every operation returns `before`, `after` (topology, area, volume, oriented-box
extents/rotation), `effect` (volume/face/vertex deltas), and operation-specific
`data`. Volume is null for open geometry. Spec comparisons always use
`boxExtentsMm`, never PCA. Its search is the repair tool's bounded approximate
minimum-volume box; it is not a certified global optimum or semantic frame.

| Tool | Parameters / effect |
| --- | --- |
| `measure` | No parameters; mesh-only measurements. |
| `render` | `resolution` 16–1024; ten neutral input-frame PNGs with hashes. Four views (+X/+Y/+Z/isometric) are forwarded to the model as images. |
| `sample_texture` | `count` 100–20,000 and `seed`; deterministic area samples on the retained textured source, nearest texels, Blender RGB values, first 128 samples returned and full `samples.json` retained. OBJ repeat/clamp mapping is used; this does not reconstruct arbitrary USD shaders. |
| `find_features` | `threshold` luminance, `link_mm`, `min_samples`; bounded connected clusters of dark samples with measured centres/spans, up to 128 IDs. Labels such as port/LED are model interpretations, not detector ground truth. Requires prior sampling. |
| `feature_frame` | `origin_feature`, `x_feature`, `plane_feature` IDs from measured clusters; right-handed orthonormal frame from three non-collinear centres. Transforms current and source meshes/evidence together. It is a geometric datum, not automatic pose recognition. |
| `classify_regions` | `saturation_min`; sample-majority saturation labels source faces as filled/captured, with unobserved faces unknown. A table-colour heuristic, not proof a region was uncaptured. |
| `symmetrize` | `axis` X/Y/Z, `direction` NEGATIVE/POSITIVE, `iterations` 1–4; average both sides against a mirrored BVH, then copy the selected side across the origin. This assumes product symmetry and may erase asymmetric features. |
| `rigid_frame` | `rotation` (nine row-major numbers, proper orthonormal matrix), `translation_mm`; explicit measured datums applied to current/source evidence together. No arbitrary affine scaling or reflection. |
| `mirror` | `axis`, `direction`; copy-only symmetry, preserving the chosen captured side when the other side is missing. |
| `laplacian_smooth` | `iterations` 1–30, `lambda_factor` .01–1; Blender normalized, volume-preserving modifier, with an 8M vertex-iteration cap. Distinct from uniform `smooth`. |
| `subdivide` | `levels` 1–2; Catmull–Clark, rejecting predicted output beyond the face cap. |
| `convex_hull` | No parameters; replaces geometry with a hull. A deliberate convex-product prior that erases concavities. |
| `remesh` | `voxel_mm` .05–10; voxel remesh with grid/polygon caps. |
| `smooth` | `iterations` 1–30, `factor` .01–.5; simultaneous uniform Laplacian smoothing followed by measured volume restoration. This restores total volume, not local detail or silhouette accuracy. |
| `scale_to_reference` | `target_mm` long-to-short; align to the measured box and scale per axis, restricted to .5–2×. Retained source evidence follows only the rigid frame, preserving intentional shrink in deviation. The resulting dimension match is **by construction**. |
| `cut_feature` | `kind` slot/pocket/hole/groove; `axis`, `side` -1/+1, `centre_mm`, `length_mm`, `width_mm`, `depth_mm`. Surface rays, exact boolean, measurable volume loss and topology checks; failure commits no geometry checkpoint. |
| `cut_oriented_feature` | All `cut_feature` parameters plus `length_axis` transverse to `axis`; selects the slot/pocket's long direction explicitly. Legacy cuts keep their cyclic tangent-axis convention. |
| `deviation` | `count`, `seed`; two-sided sampled source↔corrected BVH distances, split captured/filled/unknown. Requires classification. Counts, mean/p95/max are geometric change, not Hausdorff bounds or physical accuracy. |

Use `cut_oriented_feature` for measured slot orientation; axis alone does not determine the long direction.

Cuts: axis is the inward cutting direction from the selected side; transverse
centre coordinates choose the ray and the axial coordinate is surface-located.
A slot is a stadium; `length_mm >= width_mm`. A pocket is rectangular. A hole
uses `width_mm` as diameter and requires equal `length_mm`. A groove instead
uses `centre_mm[axis]` as its plane, `width_mm` as axial band width and
`depth_mm` as inward normal offset; length is accepted by the common schema
but does not define the perimeter. Its transverse centre must permit a perimeter
ray to hit the body. Grooves assume a simple, sufficiently convex shell: offset
surfaces can fail on arbitrary concave geometry. Cuts require watertight input
and output, may not add components, must remove more than a numerical threshold
and at most half the input volume. An unchanged boolean fails loudly. These
checks do not establish exact feature dimensions, collision freedom or printability.

## Detail-still provenance

`--still` accepts companion `detail-stills/<stillId>.img` paths directly; it does not
access companion accounts or download images. The runner snapshots supplied
provider-ready image bytes under `stills/still-N.ext`, records stable `still-1`…`still-4` IDs
and SHA-256 receipts in `detailStills`, and identifies those images in the model
context. Type comes from magic bytes, not the suffix or a possibly stale sidecar.
JPEG, PNG and WebP below the output budget retain their bytes unless EXIF
orientation needs applying. HEIC becomes JPEG; oversized images are downscaled
with aspect ratio preserved and converted to JPEG (transparency flattened onto
white). Normalized JPEGs omit metadata. Both adapters receive the resulting MIME
type and bytes, and job snapshots use matching `.png`/`.jpg`/`.webp` extensions.

Provider-ready base64 is bounded to 5,000,000 bytes per image and 8000 pixels
per edge. This fits the lower 5 MB managed-endpoint allowance and direct Claude
API's 10 MB per-image allowance, leaving room for four images within the normal
32 MB request budget; see [Anthropic's image limits](https://platform.claude.com/docs/en/build-with-claude/vision#request-limits).
These are output budgets, not extra upload rejection limits. OpenAI-compatible
endpoints vary; this is a portable default, not a guarantee for every proxy.
The loop's other messages/render results also count toward provider request limits.

Original upload bytes are retained privately as `stills/still-N-source.img`.
Each `detailStills`/`evidenceStills` entry records `sourceArtifact`, `sourceSha256`,
`sourceBytes`, `sourceMediaType`, original/sent pixel sizes and normalization
operations. Existing `sha256` and `artifact` describe exactly the image sent to
the model. No sidecar-provided media type or claimed hash overrides the bytes.

Tool schemas expose optional `evidence_still_ids`, consumed by the runner before
geometry dispatch (not a Blender/Worker parameter). Scripted and real models can
attribute a call with, for example:

```json
{"name":"scale_to_reference","arguments":{"target_mm":[60,45,22],"evidence_still_ids":["still-1"]}}
```

Each tool log entry records the referenced still IDs, hashes and private snapshot
artifacts in `evidenceStills`. This is **model-declared association**, not proof
that a still caused or validates the edit. Empty attribution is explicitly
`not supplied`; do not infer that all attached images informed every operation.
Unknown, duplicate or excessive still IDs fail before the edit. `toolFailures`
in the final report lists failed calls even if later geometry meets completion
requirements; a successful dimension fit alone is not a faithful script replay.

## Bounds and persistence

Defaults: 24 model-requested tool calls, 600 seconds total worker/model budget,
200,000 faces. Hard configuration limits: 100 calls, 3,600 seconds, 1,000,000
faces; worker subprocesses and HTTP requests each receive at most 120 seconds
and the remaining job time. Worker timeouts kill its entire process group;
HTTP is handled in a killable subprocess, preventing a slow response stream
from bypassing the wall budget. A final local measure/export is additional
bookkeeping, still within the wall budget. Finish fails if not watertight or
more than 0.05 mm from any supplied reference box dimension.

Additional work caps: 256 voxel cells per axis / 8 million cells, 3 million
vertex-smoothing steps, 2 million feature-neighbour checks, 16 million texture
pixels, 128 MiB per input mesh/asset and 32 staged assets. Large or difficult
inputs fail; reduce resolution/steps or choose a coarser operation explicitly.
Blender allocations happen before the post-operation polygon check; these
are work/polygon caps, not an OS memory quota.

A Linux libseccomp filter denies non-Unix socket creation (including IPv4/IPv6),
legacy socketcall and io_uring setup before executing Blender. It is inherited
by children and fails closed if unavailable. The worker environment excludes
provider credentials; auto-execution is disabled. This is network syscall
isolation, not a filesystem/container sandbox. Only trusted fixed Python
implementations run: no model-written Python, shell, arbitrary executables or
operation paths. Every `mtllib` target must have a `.mtl` suffix; nonstandard
suffixes are rejected before import. Material and base-colour dependencies must resolve inside the
source directory: absolute/parent paths and escaping symlinks are rejected.
References use plain converter-style portable paths (letters/digits/underscore,
hyphen, period and slash), with no quoting, escaping or expansion. The entire
dependency graph is validated and snapshotted before any assets are staged;
Blender receives those validated bytes. An explicit caller-selected `--texture`
override is snapshotted into the staged input directory separately from MTL
references. A future filesystem sandbox would add defence in depth against
importer behaviour; it is not implemented here. The socket filter does not
restrict filesystem reads, and callers must keep source/job directories private
and unmodified during staging.

Each successful operation saves `pending.blend`, then the host commits it as
`state.blend`. A failed geometry operation leaves the last committed state
unchanged. Evidence caches and render files are diagnostics, not rollbackable
geometry transactions. One runner owns a job directory; do not run concurrent
workers in the same directory. Use a fresh directory per run.

## Outputs and private data

- `corrected.obj`, `corrected.stl`: neutral corrected geometry in mm, with
  SHA-256 receipts. Current remeshed geometry is not assigned guessed UVs.
- `report.json`: status, input hashes, limits, initial/final measurements,
  reference errors, explicit caveats, artifact/log hashes and model summary.
- `tool-calls.jsonl`: full normalized model tool requests/results and measured
  effects, including failed requests. No provider authorization headers/keys.
- `work/`: staged original OBJ/MTL/PNG, packed retained source, checkpoints,
  source evidence caches, renders and private failure diagnostics.

Job directories are mode 0700. Logs, stills, source textures, captures and
rendered personal engravings are private data: never commit them or post them
in public coordination. Only caller-selected images/render previews are sent
to the selected model endpoint. Failure exits 2 and retains a partial report/
log; no successful corrected artifacts are claimed. Reports are not timestamp-
free/deterministic (elapsed time and model output vary). Fixed-runtime synthetic
geometry and seeded evidence routines are reproducible within floating-point
limits. No slicing, purchases, paid deployment or physical dispatch exists here.

## Verification and scripted model

```sh
# No API keys; actual pinned Blender. Xvfb/software graphics for render checks.
BLENDER=$HOME/opt/blender-5.0.1/blender LIBGL_ALWAYS_SOFTWARE=1 \
  xvfb-run -a python3 -m unittest discover -s tools/scan-correct/tests -v
```

The converter bridge test additionally needs the existing capture converter's
requirements (usd-core/Pillow). Still tests also need this tool's requirements. Without the optional HEIC
decoder, the HEIC test verifies the explicit install error; with it, a synthetic
HEIC is actually encoded and decoded. Full local qualification installs both
requirement files. Tests skip
explicitly if Blender or that optional bridge runtime is absent. The dedicated `scan-correct` GitHub Actions workflow installs pinned Blender,
libseccomp and exactly the converter bridge's pinned Python dependencies, then
runs the full suite under Xvfb; any skip fails CI. It also probes real IPv4/IPv6
denial as the ordinary runner user. libseccomp installs a `no_new_privs` filter,
so no root capability or user/network namespace is needed. If the runner forbids
filter installation, production fails closed and CI fails explicitly; there is
no test-only sandbox fallback or blanket skip.

For an offline CLI run, `--adapter scripted --script sequence.json` replaces
API access. The JSON file is a list of `{ "name": "measure", "arguments": {} }`
objects; each model turn returns the next call, then terminates at the end.
Tests generate a lumpy rounded box, replay symmetry → hull → remesh → smooth →
reference fit → measure, and require convergence to the target dimensions.
They also verify every tool's measured effect, actual merged converter texture
import, renderer/image forwarding, retained-frame deviation, missed/unchanged
booleans, polygon/grid/step/time limits, network denial and provider payloads
with an injected offline transport. No real API run has been performed. Additional synthetic tests remove a rounded
box's back face, inject lumps, and replay copy-only symmetry, hull, remesh,
normalized modifier smoothing, subdivision and reference fitting within 0.3 mm.
An explicit slot-axis regression checks its serialized pocket-floor extents;
synthetic stills exercise image forwarding, edit attribution and invalid-ID
rejection. Personal replay sequences, datums, captures and gap reports remain
outside Git.

Before the first real-model run: select a provider/model with image/tool
support, supply its key outside Git through the caller's environment, choose
an explicitly authorized private capture and fresh private output directory,
set time/step/face budgets, review converter texture warnings and declared
units, then inspect the full report/renders and assumptions. Reference matches
and smooth surfaces still require independent physical measurements to assess fit.

Provider formats follow the [Anthropic tool lifecycle](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
and [OpenAI Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

## Close-up advice without a model

```sh
BLENDER=$HOME/opt/blender-5.0.1/blender LIBGL_ALWAYS_SOFTWARE=1 \
  xvfb-run -a python3 tools/scan-correct/correct.py advise repaired.obj \
  --units mm --reference-mm 60 45 22 --out /private/job/closeups
```

`advise` works before AI correction and requires no provider credentials. It
uses the same validated OBJ/MTL/PNG staging and network-denied Blender worker.
It writes deterministic `advice.json` with a `closeupAdvice` object conforming
to [closeup-advice.schema.json](closeup-advice.schema.json), and prints that same
object wrapper to stdout. Input hashes and each render's SHA-256 are included;
paths are relative to the fresh, private output directory. Repeatability means
the same bytes under the same pinned Blender/runtime, not across render engines.

The ranked targets combine inferred missing/reconstructed regions (open
boundaries or unusually coarse, near-axis faces, with texture saturation as
support), local normal residual and curvature variation, small connected
concavities, and dark texture clusters. A reference, when provided long-to-short,
is compared with **boxExtentsMm**, never PCA extents. Large discrepancies suggest
a view with a ruler. If no face clears the normal cutoff, the best-facing
faces still supply that size-check region. Geometry still works without textures;
unavailable texture or capped clustering produces an explicit warning. A repaired mesh that lost UVs
cannot recover texture evidence through this command.

Each target includes a reason, a heuristic expected-benefit score from 0 to 100,
a region bounding box and centre, an outward target-to-camera `viewDirection`
in the input frame, and `distanceMm`. Distance is a geometry-based starting point,
not phone-camera calibration. One target per input-axis side is returned, up to
`--max-targets` (default 3, range 1–6). Side names default to plain axis-relative
labels. Optional `--axis-labels labels.json` supplies known semantic labels, for
example `{"pos_z":"Back (hinge side)"}`; `labelSource` distinguishes caller labels
from defaults. These labels do not affect ranking or assert anatomy detection.

Each target's `render` is a small PNG of the current mesh, neutral grey with
orange highlighted faces, or an orange boundary rim for an opening. Opening
targets use the boundary centroid and fitted outward plane normal rather than
incident wall centres; their bounds describe the opening. Source geometry is
hidden, source materials are removed from the displayed mesh, and the renderer uses material colours rather
than texture pixels. No images or requests go to a model. Keep the complete job
private because `work/` still contains the staged source texture and geometry.
`--resolution` is bounded to 64–512 pixels (default 256); wall time and face caps
use `--max-seconds` and `--max-faces` with the existing hard worker limits.

This is a priority heuristic, not proof that a face was uncaptured or a marking
is a feature. Sparse intentional topology can resemble a fill; smooth intentional
curvature can resemble a lump; shadows/markings can resemble ports. Scores are
not calibrated probabilities. A clean mesh may yield no targets. The command
does not modify the supplied mesh or perform correction. Synthetic tests cover
a filled face competing with a smaller patch, an injected lump, a small blind
cut, byte-repeatable advice/renders, texture-independent highlight pixels and
rejection of out-of-bounds options before Blender staging.
