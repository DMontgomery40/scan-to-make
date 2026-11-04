# Task 3 implementation and evidence

Base: `5f31406d1a39300da97a8d8255c5bf7fff88d4f5`. Branch: `linux-tauri-desktop`. Ownership: `apps/linux/**` only. Plan: `docs/superpowers/plans/2026-11-04-android-linux.md` (not edited).

This is a functional frontend implementation, not a release or full device acceptance claim. No printer job was started. No printer MCP source/dist, installed Mac app, host source, shared status, distribution, or site file was changed.

## Implementation

- Home, search, archive/in-progress navigation and the three existing shared starters. Native multiple-file selection before project creation. Retained original plates, completion and reprint surfaces.
- Project stills, demand-loaded STL orbit/zoom, conversation/photos, structured asks, queued changes with durable uncertain-send recovery, pass activity and project settings.
- Estimates, filaments, copies, layer pauses and quality/strength, frozen expectedPlate checks, camera and real control-method bindings. Dynamic MCP questions have independent native connections and appear above pending sheets.
- Settings for published MCP downloads/updates, printer routes/discovery/manual forms, QR/nearby pairing/devices, model choices and the helper's Secret Service credential bridge. Unsupported Fusion, CloudKit, OpenCode CLI and non-STL interactive preview are explicit.
- Rust bridge: bounded private socket messages/deadlines, allowlisted methods, identity checks, no mutation replay, referenced/project-scoped artifact reads, native picker grants, fixed editor commands, no general renderer shell/filesystem/HTTP access.
- Debian/AppImage configurations and reproducible resource materialization/verification scripts. The exact shared CLI resolves `resource_dir()/host/counterpart-host` with sibling `Payload/`.

The scoped ledger replaces the shared plan workspace to preserve ownership. Self-review replaces the skill's reviewer dispatch because the task explicitly forbids subagents.

## Native graphics qualification

All builds and tests ran over SSH on agents-136, under `/home/david/scan-to-make-work/linux-desktop/`. No Mac toolchain or build cache was used.

- Ubuntu 26.04.1, kernel 7.0, Rust/Cargo 1.93.1, Node 24.22.2; Tauri 2.12.5, WebKitGTK 2.52.6, Three.js 0.180.
- Actual Tauri/GTK window in an isolated XFCE desktop on Xvfb `:93`, with the user's D-Bus/systemd session and notification daemon. `WEBKIT_DISABLE_DMABUF_RENDERER=1` was used on this software graphics host.
- Mesa 26.0.8 reports llvmpipe / LLVM 21.1.8, `Accelerated: no`. WebKit's masked WebGL renderer string reported “Apple GPU”; it is not evidence of Apple hardware. The UI notes that renderer strings may be masked.
- The actual native file chooser opened the repository's real caliper STL. The native window rendered it; visible Orbit left and Zoom in controls changed the view. See [initial stage](first-native-stage.png) and [orbit/zoom](orbit-zoom-native.png).
- Early debug app cgroup measured 224,587,776 bytes current / 241,291,264 bytes peak and 3.219 seconds accumulated CPU while the model was open. Installed release welcome/setup session measured 120,979,456 bytes current / 164,179,968 bytes peak and 1.100 seconds CPU. These are point-in-time process-group measurements, not sustained performance or physical GPU acceptance.

This establishes native software rendering engineering evidence. It does not establish physical-desktop graphics, suspend/resume, notification delivery, locked-keyring behavior, Android pairing, or printer acceptance.

## Packaging regression

The first `.deb` installed but Set up failed while importing the LAN-address module. The prepared payload imported successfully; Tauri had omitted npm directory symlinks in the package. This was a packaging defect, not network absence.

`materialize-resources.py` now recursively materializes every directory link, including all four original internal links: companion → contracts/project/printer-handoff and project → contracts. The copied project under companion also receives its contracts dependency. Executable npm/npx links become relocatable launchers so their package-relative imports survive. Escaping/cyclic resource links are refused.

`verify-packages.sh` extracts **both actual output packages**, imports all 60 internal package exports, traverses five dependency edges including the duplicated nested project edge, imports the LAN module, and invokes each package's npm/npx. It does not start a companion, MCP or printer. The two packaging regression tests exercise nested dependencies/relocation and link escape/cycle rejection.

After this fix, actual installed Set up passed address discovery and created the user service. The next failure was host-generated `printer-handoff.json` with relative `process.command: "node"`; the companion rejected it with a Zod absolute-path error. This was reported to the host owner without editing host code or state. [Native state after setup](materialized-setup.png). Host commit `a41b298a` supplies the repair.

## Primary references

- [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri resources](https://v2.tauri.app/develop/resources/)
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri Debian packaging](https://v2.tauri.app/distribute/debian/)
- [Tauri AppImage packaging](https://v2.tauri.app/distribute/appimage/)
- [Three.js WebGLRenderer](https://threejs.org/docs/#api/en/renderers/WebGLRenderer) and [OrbitControls](https://threejs.org/docs/#examples/en/controls/OrbitControls)

## Installed app integration (2026-11-04)

Payload `ga41b298a488d-node24.22.2-x64` was built from the host owner's committed source; their subsequently pushed `2f6b7df75953529f888491abecf80f473008690f` adds only the host test script. No host code was modified here.

Using only actual native controls (AT-SPI/GTK file chooser/window controls):

1. Installed `.deb`, launched it, clicked **Repair setup**. The helper repaired its earlier default configuration. The app reached connected Projects with all three shared starters; the companion service remained active. [Home](installed-home.png).
2. Clicked the caliper card's **Start this project**. Its retained still and instructions displayed. [Project](installed-project.png).
3. Used **Add original files…** and the native chooser to import the repository's real `caliper.stl` beside the starter's 3MF. The app showed both original plates and the normalized plate-selection ask. Selecting the STL changed the active model and resolved the ask. No completion was falsified; both plates remained not printed.
4. Clicked **Explore in 3D**, **Orbit left** and **Zoom in**. Project-scoped artifact loading and actual WebKit/Three rendering worked. [Stage](installed-project-3d.png), [changed view](installed-project-orbit.png). Release app group at the 3D stage: 241,750,016 bytes current / 273,895,424 bytes peak; 5.976 seconds CPU.
5. Opened **Print…** and inspected copies, quality/strength, filament and layer-pause controls, then closed it. No estimate or print was dispatched. [Print sheet](installed-print-sheet.png).
6. Settings displayed the already-installed published Bambu package 1.1.52. Its default unconfigured/offline destination is supplied by the companion. The initial route query eventually closed without a reply and the UI showed that error; no route success is claimed.
7. Clicked **Download** for published `mcp-3d-printer-server`; subsequent actual Settings displayed installed 1.2.26. No MCP dist was copied. [Settings](installed-settings.png), [download result and route-query error](installed-download.png).
8. Inspected Model access choices without changing the provider. Devices → **Add a phone…** displayed the QR dialog; Escape dismissed it. No phone was paired; no QR token is retained in these receipts.
9. Resized the native window to 960×720 and verified stage, inspector, navigation and sticky actions after layout settled. [Resized](installed-resized.png). Fixed unsupported full-width plus glyphs using ordinary `+`.
10. Closed the installed window: its UI service became inactive while the companion stayed active. Launched the packaged AppImage itself (FUSE runtime), opened the retained project and its 3D stage. [AppImage native window](appimage-project-3d.png). AppImage process group at the stage: 367,398,912 bytes current / 390,062,080 bytes peak; 2.514 seconds CPU. These are not directly comparable to a long-running `.deb` session. AppImage emitted software-renderer DRI3 and missing GStreamer appsink warnings; video/camera playback is not qualified.

## Checks and handoff limits

- Frontend: 8 tests passed (search, plate guard, dynamic questions, stale response, interrupted queue recovery).
- Rust: 12 tests passed (private socket/framing/limits, independent confirmation while control waits, no disconnect replay, artifact containment, persisted queue validation).
- Packaging: 2 tests passed. Both release package formats built on Linux. Extracted package checks pass 60 export imports/five internal dependency edges and npm/npx 11.19.1 for each format.
- These tests are engineering evidence, separate from the observed native UI interactions above. No mocked backend was used for UI work.
- Runtime artifacts and full logs are retained under `agents-136:/home/david/scan-to-make-work/linux-desktop/artifacts/` and `receipts/`. `verification.txt` records final output hashes/build/test summaries.

Remaining acceptance belongs to integration: real provider-backed changes/reconstruction and photos/asks; phone QR/nearby pairing and address changes; configured printer estimates/filaments/camera/controls and actual MCP elicitations; cross-client stale-plate refusal; jobs through restart/suspend; physical desktop/GPU and credential-store failure UI. No print was authorized within this task, so printing/physical acceptance is deliberately unperformed. Fusion/CloudKit are unsupported, not pending fake buttons. Linux desktop notifications/sleep prevention depend on host support and are not represented as working switches.

Cleanup: removed the task-owned Rust/Tauri target directory (about 6 GiB), obsolete extracted bundler tools and temporary Node compile cache after retaining final artifacts. Source, prepared resources, installed app, session and receipts remain available for parent integration.
