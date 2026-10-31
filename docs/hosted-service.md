# Hosted scan cleanup worker (design)

**Status:** design only. **Nothing in this document is deployed.** No Modal app, R2 bucket, or paid cloud account exists for Scan to Make yet. Turning any of this on spends David's money and needs his explicit approval first (team rule, 2026-10-31).

**Tracking:** **KAN-134** (hosted cleanup worker design — docs only).

**Decision:** [D003](https://app.slack.com/client/T0C92NRJM5G/C0C96L9JC76) — after local, repeatable workers and isolation proof, the lean hosted prototype uses **Modal** for compute and **Cloudflare R2** for bytes. David's D003 addendum: **the same cleanup job contract** must run locally and on Modal; hosted is a configuration change, not a second pipeline.

This document covers only the **hosted cleanup worker**: headless [`tools/scan-repair`](../tools/scan-repair) plus [`tools/scan-correct`](../tools/scan-correct) (including deterministic `advise`), using **project-owned model API keys** for users who cannot run Linux + Blender 5.0.1 + libseccomp on their own machine. Capture conversion, companion pairing, project sync, billing, and printer MCPs stay on the self-host path documented elsewhere ([`deploy/companion/README.md`](../deploy/companion/README.md), [`services/companion/`](../services/companion/)).

---

## Problem and product fit

The phone captures LiDAR and close-up stills. Cleanup is GPL/server-side Blender work (`scan-repair`, `scan-correct`) that must not ship inside the app. Many users have no suitable computer (macOS cannot run the Linux libseccomp sandbox `scan-correct` requires; see companion packaging notes). The hosted worker runs the **same commands and bounds** as a capable self-host, stores inputs and outputs in R2, and bills against the product's trial/credit model when that layer exists.

Preview-only semantics are unchanged: reports carry `previewOnly: true` and `provesPhysicalAccuracy: false` ([`tools/scan-repair/README.md`](../tools/scan-repair/README.md), [`tools/scan-correct/README.md`](../tools/scan-correct/README.md)).

---

## Worker image (KAN-130 / PR #110)

Do **not** design a second worker image. Reuse the companion container built from [`deploy/companion/Dockerfile`](../deploy/companion/Dockerfile) (merged as **KAN-130**, PR #110):

| Image contents | Role in cleanup |
| --- | --- |
| Blender **5.0.1** (linux/amd64), `LIBGL_ALWAYS_SOFTWARE=1`, Xvfb-friendly deps | `scan-repair` and Blender subprocesses inside `scan-correct` |
| Python venv with `tools/capture-mesh-convert` + `tools/scan-correct` requirements | USD/OBJ bridge, Pillow/HEIC, host runner |
| `tools/scan-repair`, `tools/scan-correct` | Cleanup entrypoints |
| `libseccomp2` | Production network denial for correction worker ([`tools/scan-correct/sandbox.py`](../tools/scan-correct/sandbox.py)) |

The default image **CMD** starts the companion HTTP server. On Modal, override the command to a thin **cleanup orchestrator** (future code) that:

1. Pulls job inputs from R2 into a private `0700` scratch dir (same layout the tools expect).
2. Runs the staged pipeline (below) via the existing CLIs.
3. Uploads hash-verified outputs to R2 and returns artifact identities `{sha256, byteLength, mediaType}` matching [`@scan-to-make/contracts`](../packages/contracts/).

Printer MCP packages in the image are unused by the hosted cleanup worker; they remain for self-host parity of the **same** image digest.

---

## Job pipeline (what actually runs)

Align with companion scan processing today ([`services/companion/SCAN-PROCESSING.md`](../services/companion/SCAN-PROCESSING.md)) and the in-flight full cleanup shape (Codex KAN-119): re-import retained textured geometry, then:

| Stage | Tool | Notes |
| --- | --- | --- |
| Repair | `python3 tools/scan-repair/repair.py repair …` | Subprocess: `--background --factory-startup --python-exit-code 1`. Default params recorded in job JSON. |
| Measure + views | `repair.py measure` / `repair.py render` | Ten 512×512 PNGs (`pos_*`, `neg_*`, `iso_*`). |
| Close-up advice (optional) | `python3 tools/scan-correct/correct.py advise …` | No model key; writes `advice.json` ([`closeup-advice.schema.json`](../tools/scan-correct/closeup-advice.schema.json)). |
| AI correction | `python3 tools/scan-correct/correct.py run … --adapter anthropic` | Default model **`claude-opus-5-5`** when `--adapter anthropic` and `--model` omitted ([`tools/scan-correct/adapters.py`](../tools/scan-correct/adapters.py)). Key from **`ANTHROPIC_API_KEY`** in the worker environment only. |
| Outputs | `corrected.obj`, `corrected.stl`, `report.json`, repair/correct artifacts | Same filenames and preview flags as local runs. |

**Bounds** (already enforced by tools and companion; hosted must not relax them):

- Companion scan-processing: **10 min** whole job, **5 min** per subprocess stage, **160 MiB** total retained outputs, **64 MiB** mesh cap ([`SCAN-PROCESSING.md`](../services/companion/SCAN-PROCESSING.md)).
- `scan-correct`: default **24** model steps, **600 s** wall, **200k** faces; hard max **100** steps / **3600 s** / **1M** faces ([`tools/scan-correct/README.md`](../tools/scan-correct/README.md)).
- Detail stills: up to **four** images, **25 MiB** each (companion contract); runner normalizes for the model.

Hosted jobs should expose the same stage list and artifact names the app already uses for companion scan-processing, extended with correction artifacts when enabled.

---

## Modal mapping

| Concern | Design choice |
| --- | --- |
| **Image** | Build and publish the KAN-130 Dockerfile to Modal (`modal.Image.from_dockerfile` or registry mirror). Pin by digest; rebuild when `main` changes the Dockerfile or tool pins. |
| **Shape** | One **Modal Function** (or Web endpoint + background spawn) per cleanup job: `run_cleanup(job_id) -> artifact manifest`. Input: R2 keys + job spec JSON. No long-lived companion HTTP inside Modal. |
| **GPU** | **None.** All Blender work is CPU + software GL (same as CI `LIBGL_ALWAYS_SOFTWARE=1`). |
| **CPU / memory** | Request **2 physical cores** (4 vCPU-equivalent) and **8 GiB** RAM; raise to 4 cores / 16 GiB only if profiling shows OOM on large meshes (still within 64 MiB mesh contract). Modal bills `max(request, usage)` ([Modal pricing](https://modal.com/pricing)). |
| **Timeout** | Function timeout ≥ **20 minutes** to cover companion 10 min cap + 600 s correction + staging; cancel via Modal cancellation → SIGKILL process groups (mirror companion scan-processing). |
| **Concurrency** | Modal `max_containers` per app for burst; application-side **one active cleanup job per capture** (contract rule) and fair per-account caps when the API exists. |
| **Secrets** | Modal Secret: `ANTHROPIC_API_KEY` (and optional OpenAI-compatible keys if product config adds `--adapter openai`). Never in job JSON, logs, or client responses. |
| **Cold start** | Accept 1–2 s container spin-up; optional `keep_warm` only after David approves spend. |
| **Idle billing** | Modal may bill ~60 s after last input while a container winds down; size batches accordingly. |

---

## Cloudflare R2 artifact flow

| Phase | Storage pattern |
| --- | --- |
| **Upload (phone → R2)** | After auth, API returns **short-lived signed PUT** URLs (or single POST policy) for content-addressed keys, e.g. `{accountId}/{projectId}/{captureId}/{sha256}` for converted OBJ/MTL/PNG, USDZ if needed, and detail-still blobs. Client sends `Content-Length` bounded by contract. |
| **Worker read** | Orchestrator lists job manifest, **GET** inputs by key, verifies **SHA-256** before invoking tools (same as companion artifact verification). |
| **Worker write** | On each committed stage, **PUT** outputs with `Content-Type` and custom metadata `sha256=…`. Job record in Postgres (future) holds artifact identities only; bytes stay in R2. |
| **Download (phone ← R2)** | **Signed GET** URLs after `captures:read` (or successor scope) check; optional `X-Content-SHA256` header echo for client verify. |
| **Retention** | **Design default (not implemented):** delete scratch prefixes **24 h** after job terminal state; keep user-visible artifacts until account deletion or **90 days** after last project access, whichever policy product legal chooses. Lifecycle rules on bucket prefixes implement this. |
| **Egress** | R2 **egress to Internet is free** on standard storage ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)); phones download via signed URLs. Modal workers should read/write R2 from Cloudflare network (same region) to minimize latency. |

Operations classes follow Cloudflare's definitions: uploads are **Class A**; downloads and HEAD verification are **Class B**.

---

## Per-scan cost estimate

Prices below were checked on **2026-10-31** from the cited official pages. Runtime figures mix **measured** CI/host evidence and **explicit estimates** where no production telemetry exists yet.

### Runtime (wall clock)

| Component | Value | Basis |
| --- | --- | --- |
| Synthetic full path (convert + repair + measure + render + advise + **scripted** correct, one tool step) | **~12 s** | **Measured:** GitHub Actions `e2e-pipeline` run [41168182649](https://github.com/DMontgomery40/scan-to-make/actions/runs/41168182649) on `main`, test `synthetic USDZ → … → scripted scan-correct`, `duration_ms ≈ 11960`. |
| `scan-repair` only on a real AirPods scan (UV-preserving path) | **~0.7 s** | **Measured (team-reported):** review notes for PR #117 in #build-room (2026-10-30): repair **0.71 s**, deterministic. |
| Typical phone capture (repair → measure → render, no voxel catastrophe) | **~30 s – 3 min** | **Estimated:** synthetic box is far smaller than LiDAR meshes; companion allows up to **5 min/subprocess** and **10 min/job** ([`SCAN-PROCESSING.md`](../services/companion/SCAN-PROCESSING.md)). |
| `scan-correct` with **real** Anthropic adapter | **~1 – 10 min** typical, **up to 600 s** default cap | **Estimated:** default `--max-seconds 600` and up to **24** API rounds ([`tools/scan-correct/README.md`](../tools/scan-correct/README.md)). **No real-provider run is qualified in-repo yet.** |
| **Planning figure for Modal billing** | **2 min – 8 min** active CPU | Uses mid-range of repair+advise+partial correction through full cap. |

### Modal compute (CPU + memory)

Modal list prices ([Modal pricing](https://modal.com/pricing), checked **2026-10-31**):

- CPU: **$0.0000131 / physical core / second**
- Memory: **$0.00000222 / GiB / second**

Assume **2 cores** and **8 GiB** for the planning runtime above:

| Runtime | CPU cost | Memory cost | **Modal subtotal** |
| --- | --- | --- | --- |
| 120 s (2 min) | 120 × 2 × 0.0000131 = **$0.0031** | 120 × 8 × 0.00000222 = **$0.0021** | **~$0.005** |
| 480 s (8 min) | 480 × 2 × 0.0000131 = **$0.0126** | 480 × 8 × 0.00000222 = **$0.0085** | **~$0.021** |

Add **~$0–0.01** for container wind-down / cold-start overhead at low volume (Modal FAQ, same page).

### R2 storage and operations

[R2 pricing](https://developers.cloudflare.com/r2/pricing/) (checked **2026-10-31**):

- Standard storage: **$0.015 / GB-month**
- Class A: **$4.50 / million** requests
- Class B: **$0.36 / million** requests
- Egress: **$0** (standard)

**Stored bytes per cleanup job (estimate):** companion scan-processing allows up to **160 MiB** retained outputs; a typical job with ten PNGs, OBJ/STL, reports, and correction `work/` is assumed **20–60 MiB** until product telemetry exists (**estimated**).

| Item | Assumption | **Cost / scan** |
| --- | --- | --- |
| Storage 30 days @ 40 MiB average | 0.039 GB-month × $0.015 | **~$0.0006** |
| ~25 Class A + ~40 Class B ops | Well inside free tier at trial scale | **~$0.0001** marginal |

At low trial volume, R2 often falls within the **10 GB-month / 1M Class A / 10M Class B** free tier (same page).

### Model API (`scan-correct`, Anthropic default)

Provider: **Anthropic Messages API**, default model id **`claude-opus-5-5`** ([`adapters.py`](../tools/scan-correct/adapters.py)).

Token prices ([Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing), checked **2026-10-31**):

- Input: **$4 / MTok**
- Output: **$20 / MTok**

**No production token counts exist in this repo** (`tools/scan-correct/README.md`: no real-provider run qualified). Estimates assume vision-heavy turns (tool schemas + up to four stills + periodic render PNGs):

| Scenario | Assumed tokens | **Model subtotal** |
| --- | --- | --- |
| Light correction (~4 API rounds) | 180k in / 12k out | 0.18×4 + 0.012×20 ≈ **$0.96** |
| Medium (~10 rounds) | 450k in / 30k out | 0.45×4 + 0.03×20 ≈ **$2.40** |
| Heavy (~20 rounds, many renders) | 900k in / 60k out | 0.9×4 + 0.06×20 ≈ **$4.80** |

Prompt caching, step limits, and user-cancelled jobs reduce spend; worst case approaches the **24-step** ceiling.

### Total per scan (planning range)

| Line | Low | High |
| --- | --- | --- |
| Modal CPU/RAM | ~$0.005 | ~$0.03 |
| R2 | ~$0.0001 | ~$0.001 |
| Anthropic (`claude-opus-5-5`) | ~$0.50 (few steps, small context) | ~$5.00 (many vision turns) |
| **Total** | **~$0.51** | **~$5.03** |

Round for product planning: **about $0.50 – $5.00 per hosted cleanup scan**, dominated by model usage until step budgets and caching are tuned on real captures.

---

## Self-host parity

| Dimension | Self-host (today) | Hosted (design) |
| --- | --- | --- |
| **Runtime** | Same Docker image ([`deploy/companion/compose.yaml`](../deploy/companion/compose.yaml)) or macOS installer for capture-only paths | Same image digest on Modal |
| **Commands** | `repair.py` / `correct.py` CLI with documented flags | Identical argv and env (`BLENDER`, `LIBGL_ALWAYS_SOFTWARE=1`) |
| **Model keys** | Operator sets `ANTHROPIC_API_KEY` in `companion.env` (future host cleanup CLI) | Modal Secret injected into worker only |
| **Storage** | Local volume under `SCAN_TO_MAKE_CAPTURE_DIR` | R2 keys + signed URLs |
| **Auth** | Tailscale Serve + pairing ([`docs/tailscale-setup.md`](tailscale-setup.md)) | Account/device tokens (future API) |
| **Network isolation** | libseccomp deny in `scan-correct` worker | Same filter inside container |

**Avoiding drift:**

1. **One Dockerfile** (`deploy/companion/Dockerfile`) is the source of truth; Modal builds from it in CI alongside [`companion-package.yml`](../.github/workflows/companion-package.yml).
2. **Shared tests:** `tests/e2e/pipeline.test.mjs` (synthetic path) and companion scan-processing tests remain the contract; add a hosted fixture that runs the same job spec against R2 mocks before any deploy.
3. **Pinned Blender 5.0.1** checksum gate already in CI ([`scan-correct.yml`](../.github/workflows/scan-correct.yml), e2e workflow).
4. **Versioned job spec** JSON (parameters, stage list, tool paths) checked into repo; local and Modal orchestrators read the same file.

macOS companions continue to run **scan-repair** natively but not production **scan-correct** ([`deploy/companion/README.md`](../deploy/companion/README.md)); parity for correction requires Linux (self-host NAS/container or hosted worker).

---

## Explicit non-goals (current design)

- Deploying Modal, R2, or model keys in production.
- Replacing companion capture conversion or project sync on day one.
- Qualifying or mandating a specific real-world correction quality level (preview-only tooling).
- Publishing this doc as a customer SLA.

When implementation starts, the first code PR should name this document, the KAN-130 image digest, and the bambu-printer-mcp capabilities **not** used (cleanup only).

---

## References

- D003 thread: [#decisions](https://app.slack.com/client/T0C92NRJM5G/C0C96L9JC76) (Cloudflare R2 + Modal after local proof).
- Companion packaging: [`deploy/companion/README.md`](../deploy/companion/README.md) (KAN-130 / PR #110).
- Scan processing HTTP contract: [`services/companion/SCAN-PROCESSING.md`](../services/companion/SCAN-PROCESSING.md).
- Tool licensing and bounds: [`tools/scan-repair/README.md`](../tools/scan-repair/README.md), [`tools/scan-correct/README.md`](../tools/scan-correct/README.md).
