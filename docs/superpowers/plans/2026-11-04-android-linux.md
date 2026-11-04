# Android and Linux Counterpart Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for your assigned task. Do not start additional agents unless your task explicitly authorizes them.

**Goal:** Ship the existing Counterpart project, scan, design and print experience on Android with both Mac and Linux desktop companions.

**Architecture:** Retain Kotlin/Compose on Android and the existing Node companion and published printer MCPs. The Linux desktop uses Tauri 2, TypeScript/React and Three.js, talking through a narrow Rust bridge to the private control socket. A separate Rust `counterpart-host` executable owns Linux setup, user-service lifecycle and credential-resolving model workers.

**Tech stack:** Kotlin/Compose, TypeScript/Node 24, Rust/Tauri 2, React, Three.js, Secret Service, systemd user services, Avahi, COLMAP/OpenMVS.

**Spec:** `docs/design/journey.md`, `docs/design/overhaul/PRD.md`, `docs/status/asks.md` rows 7, 10, 27, 33, 43–46; David's Android/Linux and TStack council instructions.

## Global constraints

- Acceptance means visible controls in the actual installed apps and the printer's own replies. Unit/mock/CLI/socket checks are engineering evidence only.
- Use published MCPs through Download/Update; no copied development dist or parallel printer backend.
- Preserve Mac/iOS behavior, TLS pinning, user projects and opaque provider credential references.
- No API keys in companion state/process, command arguments, logs or renderer storage. The renderer may submit a freshly entered key only to the native credential-store command.
- Non-Apple builds run on agents-136/173. Android UI uses T3 device_list/open and its returned agent-device command.
- Linux desktop acceptance uses an actual desktop session with D-Bus, Secret Service, notifications and visible UI. Xvfb alone does not establish desktop integration.
- Keep all six scan-platform plates together and both long-caliper originals together. Starters contain no personal conversation history.
- No release/completion claim while Android/Linux flows remain unaccepted. Unavailable reconstruction is a development state, not the completed Linux scope.

## Council decision

The initial design review had three independent seats, without implementation scores: Opus recommended GTK/Rust, Muse Tauri/TypeScript, Sol Electron/TypeScript. The parent chose Tauri for the mature model-viewing ecosystem and smaller runtime distribution; this is a decision, not unanimous council approval. Tauri's documented WebKitGTK graphics limitations require early real-app rendering qualification. Request fresh council reviews against a common screenshot pack after implementation, retaining disagreements and actual scores.

## Review focus

1. A plate changes on another client while Print is open: reject the stale selection, never dispatch the newly selected plate silently.
2. Companion restart/cancellation during a design or confirmation: retain project state and stop only owned child processes; confirmation submission remains independent of the pending operation.
3. LAN/Tailscale address changes: preserve pinned identity and recover without replaying mutations.
4. API key for one endpoint is reused with another choice: refuse the mismatched binding; unavailable/locked Secret Service must yield actionable UI.
5. JPEG-only reconstruction: require measured scale or an explicit size answer, never label arbitrary photogrammetry units as metres.

## Ownership and shared interfaces

- Desktop owner: `apps/linux/**` only, including Tauri bridge, UI, bundle configuration and desktop UI checks.
- Host owner: `tools/linux-host/**`, Linux discovery/advertising and worker path portability in the companion, plus focused checks. Do not edit reconstruction or Android.
- Parent: Android parity, reconstruction, final integration, distribution/status/site docs, physical acceptance and council coordination.
- Device delegate: SDK/owned Android AVD/T3 device setup only, no source edits or printer actions.

Installed Linux resource directory contains `host/counterpart-host` and `Payload/` (bundled Node plus compiled existing companion/source resources). The helper derives this directory from its own installed executable; caller-supplied paths must not redirect a credential-resolving worker. Desktop resolves `resource_dir()/host/counterpart-host`; resource mapping must preserve this exact layout.

Host CLI contract, JSON stdout except `serve`/worker streams; errors are plain non-secret messages and nonzero exit:

- `counterpart-host status` → `{configured:boolean,running:boolean,stateDir:string,controlSocket:string}`.
- `counterpart-host setup` → same status; initializes LAN TLS/auth/empty printer configuration idempotently, retaining existing state; installs/starts the systemd user service. Choose a viable LAN address via existing discovery; actionable failure if none.
- `counterpart-host serve` → long-running companion supervisor for the user unit.
- `counterpart-host service start|stop` → status, operating only its own service.
- `counterpart-host credentials store`, stdin `{choice:ModelAccessChoice,secret:string}` → `{choice:ModelAccessChoice}` with a new opaque `keychainRef`; store the exact choice binding with the secret. Desktop then calls `modelAccess.set` with its revision. Never return the secret.
- `counterpart-host credentials remove`, stdin `{reference:string}` → `{removed:boolean}`, limited to Counterpart's namespace.
- `counterpart-host --model-worker check|run|project …`, stdin the existing `ModelAccessChoice`: resolve Secret Service, validate binding, derive a minimal worker environment, execute existing `ai-tweak-cli.js`, preserving stdout/progress and process-group cancellation.
- `tools/linux-host/prepare-payload.sh OUT_DIR` prepares the resource layout above from committed source on Linux. Do not bundle the printer MCPs or independently distributed GPL cleanup tools.

State uses XDG data directories; socket uses a private `counterpart` directory under XDG runtime (safe owned fallback when unavailable). Set `SCAN_TO_MAKE_CONTROL_SOCKET` explicitly. Host status is the authority for the UI socket path; UI does not guess it. User D-Bus/home discovery must still work when createModelWorker strips the environment for credential-backed requests.

## Task 1: Android integration and parity

- [x] Integrate downloaded source without changing Apple/companion behavior (`0e43a2e`).
- [x] Reuse shared starter catalog/assets and wire fresh project creation (`40cc1d9`).
- [x] Add plate selection/completion/reprint, multiple original import and expectedPlate guard (`40cc1d9`). Build/lint and existing contract checks pass; UI acceptance remains open.
- [x] Implement Android copies and layer pauses through existing HTTPS print/estimate routes, with capability gating and sliced-original preservation. Build verification only; visible UI acceptance is still pending.
- [x] Implement Android connection/MCP selection and updates against existing authorized HTTPS routes, plus host-neutral app wording. Update results follow companion events. Visible app acceptance remains pending.
- [ ] Add remaining current phone features: provider/general/device settings, MCP installation, queued corrections and 3D viewing. Work against existing authorized HTTPS routes.
- [ ] Qualify foreground/background event delivery and recovery for long prints; do not rely indefinitely on dataSync foreground-service runtime.
- [ ] Build signed installable beta, inspect real UI, pair with Mac then Linux. Capture needs physical Android evidence.

## Task 2: Linux host and portable companion

- [ ] Implement the host CLI and resource layout above in `tools/linux-host/` with exact saved provider binding and cancellation parity to `apps/mac/App/Runtime.swift` and `AgentKit/ModelAccess.swift`.
- [ ] Add Linux Bonjour advertising/discovery (Avahi) in `services/companion/src/bonjour.ts` and `printing/discovery.ts`, preserving macOS paths and SSDP.
- [ ] Qualify CLI lookup/Blender paths, host name and unavailable Apple capabilities. Preserve existing response fields; add platform metadata only compatibly.
- [ ] Package bundled Node/compiled companion/shared starters and user service; update Linux MCP defaults to npm latest without vendoring MCP dist.
- [ ] Run focused real-process engineering checks for setup idempotency, missing/locked credentials, endpoint binding and child cancellation. Do not claim UI acceptance from these.
- [ ] Commit and push; return exact helper contract, artifacts and limitations for parent integration.

## Task 3: Linux desktop UI

- [ ] Build Tauri native socket bridge with method allowlist, request IDs, size/deadline limits, no mutation replay and independent confirmation requests.
- [ ] Build a first runnable slice: setup → workspace → real artifact preview/orbit → project conversation/Ask for changes. Qualify WebKitGTK early and record rendering/device details.
- [ ] Complete Home/search, three starters, project/plate views, questions, multiple originals, camera, estimates, filaments, layer pauses, Pause/Resume/Stop and refusal/recovery UI.
- [ ] Complete settings: model choices, native credential storage, printers/MCP Download/Update/routes, QR/nearby pairing, devices and supported general preferences.
- [ ] Native dialogs/opening tools, safe scoped artifact reads, accessibility, keyboard operation, resizing, close-window behavior and resource cleanup. Preserve jobs outside the window.
- [ ] Produce `.deb` and AppImage packaging configuration and build on Linux with Task 2 payload. Verify actual package installation/UI separately from fixture checks.
- [ ] Commit/push; return actual screenshots and resource measurements, clearly identifying any unqualified surfaces.

## Task 4: Portable reconstruction and scale

- [ ] Implement Linux reconstruction behind `Reconstruct` in `services/companion/src/objects/reconstruct.ts`, with tool code in `tools/linux-reconstruct/`; leave Apple reconstruction intact.
- [ ] Use COLMAP CPU sparse plus OpenMVS CPU mesh; provide cancellable progress and bounded private diagnostics, preserving photos on failure.
- [ ] Carry scale provenance through conversion and force an explicit measurement where Android JPEGs have no metric metadata. Evaluate ARCore pose/intrinsics export against existing capture contracts before adding sidecars.
- [ ] Reconstruct a real capture, inspect all sides through the actual app and check known dimensions. Record time/resources and failure/retry behavior.

## Task 5: Integration, real acceptance and distribution

- [ ] Integrate reviewed branches, resolve cross-client contract drift and run relevant Apple/Linux build checks once.
- [ ] Establish a real Linux desktop session and Android device in T3. Never simulate approval by writing state files.
- [ ] Actual UI matrix: Android × Mac, iPhone × Linux, Android × Linux; pair/reconnect, starters/import, design/cleanup, selected-plate estimate/print/control and MCP update through published packages.
- [ ] Run fresh three-provider council against identical real screenshots. Fix concrete findings, recapture changed screens and repeat until reviewers accept the scoped result.
- [ ] Publish Android/Linux artifacts and accurate setup/limitations; finish external TestFlight availability and remaining release acceptance. Update the one handoff/status list and remove only owned obsolete caches/artifacts.
