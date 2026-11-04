# Counterpart for Linux

Tauri 2 + React/TypeScript + Three.js frontend for the existing private companion control socket. It never hosts an HTTP administration API or talks directly to printers.

## Build on Linux

Use the distribution's Rust/Cargo and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), including `libwebkit2gtk-4.1-dev`, GTK 3, a C compiler, OpenSSL development headers, `librsvg2-dev`, `patchelf`, and `libayatana-appindicator3-dev`. Node 24 builds the frontend. A graphical desktop session must have D-Bus, Secret Service, and systemd user services.

From the repository root:

```sh
apps/linux/scripts/prepare-frontend.sh
cd apps/linux
npm ci
npm test
npm run build
cd src-tauri
cargo test --locked
```

`prepare-frontend.sh` copies the shared Swift/companion starter catalog and existing preview images into an ignored build-input directory. It does not create another catalog or copy personal projects. Three.js and STL parsing load only when someone selects Explore in 3D. Rendering is event driven; closing the view disposes its GPU objects and context.

For packages, after integrating Task 2's committed `tools/linux-host`:

```sh
apps/linux/scripts/bundle.sh
```

The helper's payload preparation takes **committed source**. Commit the intended companion/host changes before packaging. The script builds `.deb` and `.AppImage` with this exact resource layout:

```text
resource_dir()/
  BUILD-ID
  host/counterpart-host
  Payload/node/
  Payload/source/
```

Before Tauri packaging, `materialize-resources.py` resolves **all** internal directory links, recursively including npm `file:` dependencies. Executable symlinks become relocatable launchers, preserving npm/npx package-relative imports. The bundle is checked by importing every internal package export and the LAN-address module with its own Node runtime; this is engineering evidence only.

The helper owns first setup, retained data, the background user service, LAN/Tailscale addresses, and provider workers. The UI resolves only `resource_dir()/host/counterpart-host`. `status` is the authority for its socket path. No caller-supplied worker/resource path is accepted. The app bundles neither printer MCP; Settings installs/updates published packages through the companion. No Apple toolchains are needed.

An engineering build without bundled host resources can preview a real STL through the native file chooser. Its setup failure explains the missing host. This is not a product runtime substitute.

## UI and boundaries

- Home/search and all three shared starters; project stills, STL orbit/zoom, conversation with explicitly attached photos, activity, structured asks, and corrections.
- Multiple original files stay in one project; plate selection/completion/reprint uses the companion's normalized plate rows. Print freezes `expectedPlate` at sheet opening and refuses stale selection. Estimates, loaded filaments, copies, quality/strength, layer pauses, camera, and pause/resume/stop use existing control methods.
- MCP fields are rendered as native form controls, never HTML. Questions open above existing modal dialogs. Answers have independent connections/capacity, so a control waiting for an MCP answer cannot deadlock the answer.
- Settings covers published MCP downloads/updates, printer discovery/manual forms/routes/provider choice, QR and nearby pairing, devices, model access and native Secret Service storage. API keys are neither persisted in renderer storage nor sent to the companion. A changed provider/endpoint/model needs a newly bound credential.
- Credential choice changes use the companion's revision. References from ambiguous saves are retained because a job may already be using them. The helper validates the saved binding.
- Every socket request has a UUID, a 64 KiB request limit, 8 MiB reply limit and the matching companion deadline. One request uses one connection; errors never trigger mutation replay. Socket ownership and private permissions are checked.
- Artifact reads start with a fresh `objects.get`, accept only referenced preview/model/photo paths, reject traversal, check the canonical project boundary and opened descriptor, limit regular files to 64 MiB, and expose no general filesystem API. Only native picker-selected paths enter import operations. External editors receive retained copies under the app cache, never originals.
- Event long-poll and fallback reads recover after disconnect/restart. Tickets and project timestamps reject stale reads/results. Correction drafts persist in the app data directory; a send is saved as `sending` before dispatch and becomes `uncertain` after restart. Such requests require explicit Retry/Discard. Queued drafts resume when the window is reopened; accepted jobs run in the host service after the window closes.
- Ctrl+N opens New Project; Ctrl+F searches; Ctrl+, opens Settings; Escape closes sheets. Dialog focus returns to its trigger. Stage buttons offer keyboard orbit/zoom/reset.

Fusion and CloudKit are explicitly unavailable. OpenCode CLI is not represented in the shared worker protocol; an OpenAI-compatible endpoint can be configured. A 3MF uses its retained plate still and can open in a slicer; interactive model preview supports STL. No reconstruction engine, printer backend, or model worker is implemented in this frontend.

## Evidence

See [receipts/implementation.md](receipts/implementation.md). Tests and software-rendering qualification are engineering evidence, distinct from published-MCP hardware acceptance. `scripts/native-ui.py` uses AT-SPI against the real desktop application, without injected JavaScript or a mock backend. No print should be started by a qualification run without explicit authorization.
