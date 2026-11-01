# Counterpart

The app's name is Counterpart (formerly Scan to Make; internal identifiers such as the bundle id and folders keep the old name). Docs: https://counterpart.dtmont.com/

An open-source iPhone and iPad app that scans a real object with LiDAR and cleans up the scan's defects. Product scope: "this app is so you can scan an object USING LIDAR on iphone. and then smooth out defects and such. but really anything after that is already built and downloaded by 10k people a month and it's my bambu mcp. later we may add mcp 3d printer. actually, may as well just have that be an option from the get go."

The app captures the object (LiDAR Object Capture, plus close-up stills of details). A companion on your own computer converts the capture and repairs it: it fills holes, removes stray geometry, measures it and renders check views. Slicing and printing belong to [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp) or [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server). The handoff of the clean mesh to those servers isn't built yet; today you share the repaired STL from the scan results.

The app requires iOS 27. Scanning needs a device with LiDAR (iPhone Pro or iPad Pro). On devices without LiDAR, such as the iPhone Duo, everything except the scan step works.

## What's here

| Area | What it does | Entrypoints |
| --- | --- | --- |
| Mobile app | Projects, LiDAR Object Capture scans, scan results and close-up stills; companion pairing | [`apps/mobile/`](apps/mobile/), [`apps/mobile/README.md`](apps/mobile/README.md) |
| Object Capture | Native guided LiDAR capture embedded in the app | [`apps/mobile/modules/object-capture/`](apps/mobile/modules/object-capture/) |
| Contracts | Shared schemas for saved projects, capture provenance, detail stills and scan processing | [`packages/contracts/`](packages/contracts/) |
| Companion | Authenticated loopback listener: project sync, capture import, detail stills and scan processing | [`services/companion/`](services/companion/), [`services/project/`](services/project/) |
| Capture conversion | Offline USDZ → OBJ with authored-unit provenance, input checks and bounds evaluation | [`tools/capture-mesh-convert/`](tools/capture-mesh-convert/), [`tools/capture-pipeline/`](tools/capture-pipeline/), [`tools/capture-fit-eval/`](tools/capture-fit-eval/) |
| Scan cleanup | Headless Blender repair, measurement and views; close-up-guided correction | [`tools/scan-repair/`](tools/scan-repair/), [`tools/scan-correct/`](tools/scan-correct/) |
| Private companion path | Read-only Tailscale preflight and setup notes | [`tools/tailscale/`](tools/tailscale/), [`docs/tailscale-setup.md`](docs/tailscale-setup.md) |
| Docs site | Public docs at counterpart.dtmont.com, served by a Cloudflare Worker | [`site/`](site/) (`npx wrangler@4 deploy --config site/wrangler.jsonc`) |
| Licence audit | Dependency licence allowlist and mobile third-party notices | [`tools/licence-audit/`](tools/licence-audit/) |

## Still open

- **Hosted cleanup (design only).** Modal + R2 worker scope for users without a local Linux companion: [`docs/hosted-service.md`](docs/hosted-service.md). Nothing deployed.
- **Physical-device capture.** The capture, import, cleanup and close-up flows are exercised in tests and the iOS Simulator. A full run on a physical LiDAR iPhone over a live private tailnet is still to be recorded.
- **Printer handoff phone UI.** The companion can bundle a clean mesh and drive bambu-printer-mcp or mcp-3D-printer-server with phone-answered confirmations; the in-app screens for it are still to be wired.
- **Android.** Android reports capture as unavailable.
