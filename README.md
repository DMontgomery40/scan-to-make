# Scan to Make

An open-source consumer app for making useful things that fit the objects and spaces around you: scan objects and their surroundings, describe an addition, make something that fits, and print it. A hosted service can supply inference and compute; the same core remains self-hostable.

This repository is the product. Printer adapters stay behind the companion contract and are not inlined here. The cup-holder adapter is one validation example — captured reference and confirmed dimensions, editable preview, a scoped fit coupon, and independently checked export or companion printing — not the app identity. A drawer organizer is a second dimensional template.

Native review/export is demonstrated on an isolated iOS Simulator only. Physical-fit acceptance remains **OPEN**. Preview geometry is not print authorization. Software licences and distribution rights will be recorded before shipping code that depends on them.

## Current capabilities

| Area | What exists now | Entrypoints |
| --- | --- | --- |
| Mobile shell | React Native app: project brief, local saved projects, cup-holder measurement study, drawer design preview, companion pairing, capture support check | [`apps/mobile/`](apps/mobile/), [`apps/mobile/README.md`](apps/mobile/README.md), [`apps/mobile/src/screens/`](apps/mobile/src/screens/) |
| Fit contracts | Shared schemas for cup-holder and drawer-tray templates, portable saved projects, generation protocol, capture provenance | [`packages/contracts/`](packages/contracts/), [`packages/contracts/README.md`](packages/contracts/README.md) |
| Cup-holder example | Template that turns a validated FitSpec into preview STL + manifest | [`tools/templates/cup-holder-adapter/`](tools/templates/cup-holder-adapter/), fixture [`packages/contracts/fixtures/tapered-holder.json`](packages/contracts/fixtures/tapered-holder.json) |
| Drawer organizer | Template that turns a `DrawerFitSpec` into a tray STL + manifest; iOS generation preview | [`tools/templates/drawer-organizer/`](tools/templates/drawer-organizer/), [`apps/mobile/src/screens/DrawerScreen.tsx`](apps/mobile/src/screens/DrawerScreen.tsx), fixture [`packages/contracts/fixtures/drawer-tray.json`](packages/contracts/fixtures/drawer-tray.json) |
| Characterization | Coupon that records achievable clearance for a printer, nozzle, material, and settings profile | [`tools/characterization/`](tools/characterization/) |
| Capture conversion | Offline USDZ → OBJ with authored-unit provenance | [`tools/capture-mesh-convert/`](tools/capture-mesh-convert/) |
| Capture evaluation | Bounds-only mesh evaluation against held-out dimensions | [`tools/capture-fit-eval/`](tools/capture-fit-eval/) |
| Capture pipeline | Bounded convert → evaluate, plus exact duplicate of a qualified capture | [`tools/capture-pipeline/`](tools/capture-pipeline/) |
| Object Capture eval | Isolated LiDAR Object Capture evaluation app (not the consumer UI) | [`apps/mobile/modules/object-capture/`](apps/mobile/modules/object-capture/), [`EVALUATION.md`](apps/mobile/modules/object-capture/EVALUATION.md) |
| RoomPlan / depth | RoomPlan suitability notes for drawer interiors; bounded ARKit depth/mesh evidence collector | [`apps/mobile/modules/room-capture/`](apps/mobile/modules/room-capture/), [`apps/mobile/modules/depth-capture/`](apps/mobile/modules/depth-capture/) |
| Consumer capture | Support check and manual sizes; developer AR probe is separate from consumer scan-to-mesh | [`apps/mobile/src/screens/CaptureScreen.tsx`](apps/mobile/src/screens/CaptureScreen.tsx), [`apps/mobile/modules/scan-capture/`](apps/mobile/modules/scan-capture/) |
| Local workers | Filesystem project store; companion generation, capture import, pairing, and print-intent journal (no printer dispatch) | [`services/project/`](services/project/), [`services/companion/`](services/companion/) |
| Private companion path | Read-only Tailscale preflight and setup notes | [`tools/tailscale/`](tools/tailscale/), [`docs/tailscale-setup.md`](docs/tailscale-setup.md) |

## Still OPEN

- **Native review/export.** Demonstrated (isolated iOS Simulator only, separate app bundle, against a disposable loopback authenticated companion fixture; independently reviewed in [PR #46](https://github.com/DMontgomery40/scan-to-make/pull/46), merged as `1c194c5`, [public review](https://github.com/DMontgomery40/scan-to-make/pull/46#issuecomment-6190152023)): native Files-picker import of a public sample USDZ photogrammetry reconstruction, companion conversion to OBJ, app restart with the saved project and retained capture surviving and reopening verified, native rendering of the converted hash-checked OBJ, share-sheet export of the original USDZ, derived OBJ and JSON conversion report with exact-byte identity verified, and explicit capture-permission denial, credential revocation, and re-pair/reopen recovery. Quick Look on Simulator showed metadata only, not a geometry render. Still OPEN / not established: capture on a physical iPhone/device, live private HTTPS/tailnet (private-network) reachability, metric accuracy, surface completeness and physical fit, print approval or dispatch, and Android capture import (Android reports it unavailable).
- **Physical-fit acceptance.** Generated preview STLs, bounds-only mesh checks, and coupon geometry are not printed-and-measured fit. Cup-holder and drawer examples emit preview/check artifacts (`preview-geometry-not-print-authorized` / `preview-only`). Physical insertion, caliper comparison, and printer dispatch remain separate.
- **Native capture qualification.** Object Capture, RoomPlan, and ARKit depth/mesh paths exist as isolated evaluation or evidence modules. They do not substitute for a qualified consumer capture flow or physical accuracy. RoomPlan parametric output is not the measurement authority for a fitted drawer interior.

## Self-host

From a clean clone, two commands cover the offline tools and the authenticated portable-project/capture HTTP path. Both reuse a `usd-core` 26.8 venv (prefer `PYTHON=python3.12` when available). Both summaries still print native review/export as `OPEN`; they do not exercise the isolated Simulator path.

```sh
git clone https://github.com/DMontgomery40/scan-to-make && cd scan-to-make
tools/self-host-smoke/smoke.sh
tools/self-host-smoke/auth-smoke.sh
```

`smoke.sh` bootstraps the venv and runs the tests and synthetic repros for `tools/capture-mesh-convert`, `tools/capture-fit-eval` and `tools/capture-pipeline` (pipeline and duplicate). It does not start the companion listener.

`auth-smoke.sh` installs the checkout's companion/project/contracts packages, starts the authenticated generation/capture listener with isolated fixture auth only (no live tailnet or device changes), then exercises portable-project sync → real USDZ import → listener restart against the same storage → verified reopen and exact original download. Wrong-scope and stale `If-Match` requests must fail closed. The checkout is left clean (`git status --porcelain` empty).

Each command prints a PASS/FAIL summary and exits nonzero on any failure. A passing authenticated run is the HTTP path only; it does not claim native review, export, or physical-fit validation. See [`tools/self-host-smoke/README.md`](tools/self-host-smoke/README.md).
