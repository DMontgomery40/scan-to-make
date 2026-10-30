<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Scan correction (preview only)

A small measured Blender tool library and a host-side model runner. This entire
folder is **GPL-3.0-or-later**; see [LICENSE](LICENSE). Run it on a server or
companion, **never bundle it into the mobile app**. It cannot certify physical
accuracy or authorize printing. Every successful operation and report carries
`previewOnly: true` and `provesPhysicalAccuracy: false`.

## Runtime

Linux, Python 3.10+, **Blender 5.0.1**, and system `libseccomp.so.2`. Blender
supplies numpy/bmesh/mathutils. The host uses only Python's standard library.
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
UVs; an override uses repeat sampling. Up to four PNG/JPEG/WebP detail stills
(maximum 8 MiB each) go to the model for interpretation; they are not silently
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
| `convex_hull` | No parameters; replaces geometry with a hull. A deliberate convex-product prior that erases concavities. |
| `remesh` | `voxel_mm` .05–10; voxel remesh with grid/polygon caps. |
| `smooth` | `iterations` 1–30, `factor` .01–.5; simultaneous uniform Laplacian smoothing followed by measured volume restoration. This restores total volume, not local detail or silhouette accuracy. |
| `scale_to_reference` | `target_mm` long-to-short; align to the measured box and scale per axis, restricted to .5–2×. Retained source evidence follows only the rigid frame, preserving intentional shrink in deviation. The resulting dimension match is **by construction**. |
| `cut_feature` | `kind` slot/pocket/hole/groove; `axis`, `side` -1/+1, `centre_mm`, `length_mm`, `width_mm`, `depth_mm`. Surface rays, exact boolean, measurable volume loss and topology checks; failure commits no geometry checkpoint. |
| `deviation` | `count`, `seed`; two-sided sampled source↔corrected BVH distances, split captured/filled/unknown. Requires classification. Counts, mean/p95/max are geometric change, not Hausdorff bounds or physical accuracy. |

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
operation paths. Inputs may reference sibling/subdirectory MTL/base-colour
assets only, never escape their source directory.

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
requirements (usd-core/Pillow). Other tests need no pip packages. Tests skip
explicitly if Blender or that optional bridge runtime is absent. No workflow
is added: this ticket's scope is this tool directory only.

For an offline CLI run, `--adapter scripted --script sequence.json` replaces
API access. The JSON file is a list of `{ "name": "measure", "arguments": {} }`
objects; each model turn returns the next call, then terminates at the end.
Tests generate a lumpy rounded box, replay symmetry → hull → remesh → smooth →
reference fit → measure, and require convergence to the target dimensions.
They also verify every tool's measured effect, actual merged converter texture
import, renderer/image forwarding, retained-frame deviation, missed/unchanged
booleans, polygon/grid/step/time limits, network denial and provider payloads
with an injected offline transport. No real API run has been performed.

Before the first real-model run: select a provider/model with image/tool
support, supply its key outside Git through the caller's environment, choose
an explicitly authorized private capture and fresh private output directory,
set time/step/face budgets, review converter texture warnings and declared
units, then inspect the full report/renders and assumptions. Reference matches
and smooth surfaces still require independent physical measurements to assess fit.

Provider formats follow the [Anthropic tool lifecycle](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
and [OpenAI Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).
