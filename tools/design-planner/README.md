# Design planner (describe an addition)

Turns what a user types ("a stand that holds it upright", "a wall hook for it",
"a bumper with a lanyard hole") into a plan for one template from
[`tools/templates/catalog.json`](../templates/catalog.json), with parameters
filled from the request and the repaired scan's measurements. When nothing in
the catalog can make the request, the plan says so (`no-fit`) instead of
forcing a template. An optional `generate` step runs the chosen template
headlessly and returns its manifest.

This folder is **MIT** licensed; see [LICENSE](LICENSE). It uses only the Python
standard library (Python 3.10+) and contains no Blender code. Templates run as
separate processes under their own licences and runtimes. The planner never
imports them.

```sh
# Plan (Anthropic by default; key read from ANTHROPIC_API_KEY only)
python3 tools/design-planner/planner.py plan "a stand that holds it upright" \
  --scan /private/job/report.json --out /private/job/plan.json

# Answer the plan's questions by planning again with --answer (repeatable)
python3 tools/design-planner/planner.py plan "a bumper with a lanyard hole" \
  --scan /private/job/report.json --answer "Yes, make it without the hole"

# Re-check a saved plan, then generate it (BLENDER must point at Blender 5.0.1
# for mesh templates)
python3 tools/design-planner/planner.py validate /private/job/plan.json
python3 tools/design-planner/planner.py generate /private/job/plan.json \
  --mesh /private/job/repaired.stl --out /private/job/design

python3 tools/design-planner/planner.py catalog   # model-facing catalog view
python3 -m unittest discover -s tools/design-planner/tests -v
```

## Inputs

- **Request**: 1–1000 characters, plus up to five `--answer` strings (500
  characters each) that reply to earlier questions.
- **Scan measurements** (`--scan`, optional): a complete `tools/scan-correct`
  `report.json` (uses `final`), a `tools/scan-repair` `report.json` (uses
  `after`), or `repair.py measure` output. The planner passes `boxExtentsMm`
  (oriented box, long to short), `bboxExtentsMm` (along the mesh's X/Y/Z, which
  the templates' `up` parameter refers to), `principalExtentsMm`, volume, area
  and watertightness to the model. Malformed, unsorted, non-positive or non-mm
  values are refused rather than passed through.
- **Catalog**: `--catalog` defaults to the repository catalog. FitSpec
  templates also read their `exampleSpec` from `packages/contracts/fixtures`.

## Plan output

```json
{
  "schemaVersion": 1, "status": "ready", "outcome": "plan", "previewOnly": true,
  "templateId": "scan-cradle", "templateName": "Scan cradle", "input": "repaired-scan-mesh",
  "params": {"clearance_mm": 0.4, "wall_mm": 2.0, "seat_depth": 0.3, "up": "X", "...": "..."},
  "paramSources": {"clearance_mm": "planner", "wall_mm": "default", "...": "..."},
  "rationale": "A cradle with the long X axis vertical holds the phone upright.",
  "confidence": 0.85, "questions": [], "unsupported": [], "missingMeasurements": [],
  "warnings": [], "measurements": {"boxExtentsMm": [150.1, 72.0, 8.3], "...": "..."},
  "request": "a stand that holds it upright", "answers": [],
  "catalogSha256": "...", "attempts": 1
}
```

| `status` | Meaning | Exit code |
| --- | --- | --- |
| `ready` | Valid, complete parameters; no open questions; confidence ≥ `--min-confidence` (0.6). | 0 |
| `needs-input` | A valid plan with questions to answer first. Causes: the model asked, part of the request is `unsupported` by the template, confidence is low, or a `missingMeasurements` value is required. | 0 |
| `no-fit` | Nothing in the catalog can make the request; `templateId` is null and `params` is empty. | 0 |
| `rejected` | The model never produced a valid plan; `errors` and `lastProposal` say why. | 2 |

Every catalogued parameter appears in `params`. Values the model set are marked
`planner` and the rest take the catalog default. For example, the
partial-fit request "a bumper with a lanyard hole" yields the protective sleeve
with `unsupported: ["lanyard hole"]` and a question about continuing without it,
not a silently dropped feature.

### Validation

Model output must be a single forced `submit_plan` tool call (`outcome`,
`templateId`, `params`, `rationale`, `confidence`, `questions`, `unsupported`;
no other fields). The host checks, without trusting the model:

- `templateId` exists in the catalog; a `no_fit` must name no template and no params;
- every parameter name exists for that template;
- `number`/`integer` types (booleans and integral floats are refused for integers),
  finite values, `min`/`max` with `exclusiveMin`/`exclusiveMax`, `enum` choices
  (null only where the catalog default is null), and `interval` objects with
  exactly `nominalMm`, `lowerMm`, `upperMm`, ordered and each within bounds;
- rationale ≤ 600 characters, confidence 0–1, at most five questions and
  unsupported items.

Out-of-bounds values are rejected and never clamped. The errors go back to the
model for at most `--max-attempts` tries (default 2, maximum 4). After that the
plan is `rejected`.

FitSpec dimensions whose example-spec `source` is not `design` (drawer
inside size, cup-holder bore and depth, cup diameter) describe the user's
surroundings. The planner never fills them from the synthetic fixture defaults.
If the model does not set them, they are listed in `missingMeasurements` with a
question each.

Relational limits that the catalog states only in prose (`wall_mm ≥ 2 × grid_mm`,
grid cell caps, tray height versus drawer height) are not re-implemented here.
The template enforces them during `generate`, and its error is reported.

## Generate

`generate` re-validates the saved plan against the current catalog (same
SHA-256, `ready` status, complete in-bounds parameters) before running anything.
The output directory must be new or empty.

- **Mesh templates** (`repaired-scan-mesh`): runs
  `python3 <folder>/<entrypoint> MESH --out DIR --flag=value ...`. Null
  optional values are omitted and `--render` is never passed. The template
  validates again and runs Blender (`$BLENDER`).
- **FitSpec templates**: copies the catalog's example spec, replaces every
  catalogued dimension and integer parameter with the plan values (user
  measurements are tagged `source: manual`, design values `design`), writes it
  as `fitspec.json`, and runs `<entrypoint> generate --spec ... --out-dir DIR`.
  Plans do not yet record whether a measurement came from the scan or from
  the user's words, so every non-design dimension is tagged `manual`.

The result is the template's manifest plus SHA-256 hashes of every output file.
The plan is saved beside it as `design-plan.json`. Templates run with the
repository as working directory, a time limit (`--max-seconds`, default 900,
maximum 3600), and an environment with variables named like keys, tokens,
secrets, passwords or credentials removed. Each template runs as the leader of
a new process group; when it exits or the time limit expires the whole group,
including the Blender process a mesh template launches, is killed. Templates
must not start descendants in a session of their own. Generated geometry is preview only:
no slicing, printing or physical-fit claim happens here.

Plans and generate outputs contain the user's request text and scan
measurements. Keep them with the private job data, never in Git.

## Model adapters

The adapters follow the same pattern as `tools/scan-correct/adapters.py` but are
a separate MIT implementation:

- `--adapter anthropic` (default model `claude-opus-5-5`, key `ANTHROPIC_API_KEY`);
- `--adapter openai --model ID` for OpenAI-compatible `/chat/completions`
  endpoints, with `--base-url` and `--key-env NAME` for other providers;
- `--adapter scripted --script replies.json` for offline runs. The file is a
  list of `{"submit_plan": {...}}` or `{"text": "..."}` replies, used in order.

Keys come only from the named environment variable. They are never written to
plans, logs or errors, and no key is provisioned. Endpoints must be HTTPS (HTTP
only on loopback), with no credentials or query in the URL, and redirects are
refused. Each HTTP request runs in a separate `python -I` process, which receives
the request (key header included) on stdin, never in argv or its environment.
That process is killed at 120 s or when the remaining `--max-seconds` budget
(default 180) runs out, and responses are capped at 4 MiB.
Transient failures (network errors, timeouts, HTTP 408/409/425/429/5xx/529)
retry up to `--retries` times (default 2, maximum 5) with 1 s, 2 s, ... backoff,
only while the budget allows. Other HTTP errors fail at once. Errors report the
HTTP status only, never provider bodies. Provider spend is the caller's concern.
These limits bound time, not cost.

## Tests

All tests use the scripted model or an injected transport; no API key or
external network is involved. `tests/fixtures/requests.json` holds 17 synthetic
requests with scripted replies:

- ready: upright stand, wall hook, desk-edge clip, sized drawer tray, leaky-scan
  sleeve, and a corrected snug stand;
- needs-input: an ambiguous "something to hold it", low confidence, a lanyard
  hole the sleeve cannot make, a drawer without sizes, and a cup-holder
  adapter without holder sizes;
- no-fit: a laptop hinge, a bookshelf, and a gear whose first reply wrongly
  named a template;
- rejected: screw spacing out of bounds twice, wrong parameter types, and an
  invented template followed by a reply with no tool call.

Other tests cover catalog bounds and types, measurement parsing, adapter
payloads, and bounded retries against a loopback HTTP server. Generate tests
cover the real stdlib drawer and cup-holder templates, plus the real wall-mount,
scan-cradle and edge-clip CLIs with a fake Blender executable that records the
request it received. CI (`.github/workflows/design-planner.yml`) runs everything
on Python 3.10 and 3.12 and fails on any skip.
