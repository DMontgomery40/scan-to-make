# Scan to Make

Build an iPhone app that scans a real object with LiDAR and cleans up the scan's defects. David, 2026-10-31: "this app is so you can scan an object USING LIDAR on iphone. and then smooth out defects and such. but really anything after that is already built and downloaded by 10k people a month and it's my bambu mcp. later we may add mcp 3d printer (both repos are on mac locally, and assume it's the same for our users, that they will have one or another on their computer when they use this app. We may as well just have that be an option between the two (mcp 3d printer server and bambu printer mcp) from the get go."

The app covers capture (LiDAR Object Capture plus close-up stills) and cleanup (`tools/scan-repair`, `tools/scan-correct`, `tools/capture-mesh-convert`, run by the companion). The clean mesh then goes to [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp) or [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server) (`/Users/davidmontgomery/mcp-3D-printer-server` on the Mac). The handoff is built: the companion relays it through `services/printer-handoff` (#124), and the phone's Send to printer flow answers the printer's questions (#132). The consumer journey and Mac app design are in [`docs/design/journey.md`](docs/design/journey.md).

## Read bambu-printer-mcp before you build


## Rules:

- remember that we're on ios/macos 27.7 and to design for liquidglass, and read the latest dev docs; things have significan't changed in apple app dev world even since your knowledge cutoff
- use the t3 code ios dev when it makes sense, but sometimes unfortunately xcode via @BuildiOSapps mcp from codex makes more sense
- it's a companion app, however, that doesn't mean the app is an afterthought, it should be designed as something that apple would feature in it's devday best examples.  Literally see and understand the latest ios apps that apple dev team has endorsed or showcased 
- with the lidar and cameras and scanning, use what exists and don't handroll something apple has built in house for their own hardware, HOWEVER, if we are constrained by something, sometimes you literally have to reinvent pieces of the wheel; use the /be-ambitous skill when needed

## Local PR checks

For now during development, make sure code is pushed after every feature so we don't use it and push to pain unless there is some weird major exception that would require a new branch
- clean up all your stale worktrees and delete branches that we don't need anymore
- clean up all the venv and colima and node and xcode bloat don't leave that shit taking up gigs of space forever when it won't be used again
