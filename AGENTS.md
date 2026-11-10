do not add anything to user memories based on user instructions

# Scan to Make

Build an iPhone app that scans a real object with LiDAR and cleans up the scan's defects. David, 2026-10-31: "this app is so you can scan an object USING LIDAR on iphone. and then smooth out defects and such. but really anything after that is already built and downloaded by 10k people a month and it's my bambu mcp. later we may add mcp 3d printer (both repos are on mac locally, and assume it's the same for our users, that they will have one or another on their computer when they use this app. We may as well just have that be an option between the two (mcp 3d printer server and bambu printer mcp) from the get go."

The app covers capture (LiDAR Object Capture plus close-up stills) and cleanup (`tools/scan-repair`, `tools/scan-correct`, `tools/capture-mesh-convert`, run by the companion). The clean mesh then goes to [bambu-printer-mcp](https://github.com/DMontgomery40/bambu-printer-mcp) or [mcp-3D-printer-server](https://github.com/DMontgomery40/mcp-3D-printer-server) (`/Users/davidmontgomery/mcp-3D-printer-server` on the Mac). The handoff is built: the companion relays it through `services/printer-handoff` (#124), and the phone's Send to printer flow answers the printer's questions (#132). The consumer journey and Mac app design are in [`docs/design/journey.md`](docs/design/journey.md).

## Start here

Android app: see [`android/AGENTS.md`](android/AGENTS.md) and [`android/README.md`](android/README.md).

New session? Read the working PRD, [`docs/design/overhaul/PRD.md`](docs/design/overhaul/PRD.md): what is built and accepted, from the code (§0 is the status table). Then [`docs/status/handoff.md`](docs/status/handoff.md) (one screen: owner, installed builds, what is in motion), [`docs/status/board.md`](docs/status/board.md) (every open item with its owner and next step; anything David says gets a row there in the same turn) and [`docs/operations.md`](docs/operations.md) (how to gate, build, install and drive the apps). Handoffs go in `docs/status/handoff.md`, not in temp folders or agent memory.

## One trunk

David, 2026-11-04: "we need to make sure regressions and overwrites dont happen again".

- `main` is the only trunk. Feature branches merge to main by PR (gate: `scripts/ci_local.py` and
  `scripts/branch_check.py --merge` printing SAFE). There is no long-lived release branch.
- Finished branches land together, the day they finish, on a train: one combined branch, one review, one gate
  (`docs/operations.md`, "Changing code: one trunk"). David, 2026-11-09, after eight finished branches sat unmerged:
  "I was presumably NEVER using the app with all fixes included."
- Nothing installs from a non-main SHA: Mac, iPhone, TestFlight, Linux and Android builds refuse a dirty tree
  or a HEAD that isn't on `origin/main` (`scripts/trunk_guard.sh`, listed in `scripts/README.md`). The
  `STM_TRUNK_OVERRIDE` escape is logged and only for local debugging; never install that build for David.

## The app staples onto the MCPs

David, 2026-11-04: "agents are CONSTANTLY blurring the boundary and adding backend stuff that should be in mcp to the app itself". The MCPs change "basically everyday" for new printers, slicers, firmware and Blender/Fusion; the App Store can't.

- Code that would have to change when a printer, slicer, firmware, filament system, Blender or Fusion changes goes in the MCPs (both of them), never in the app. The app calls tools, renders their structured results and passes the person's choices through.
- In app code: no branching on MCP package or slicer, no printer-model tables, no matching on MCP or printer error codes or wording, no slicer setting keys or presets, no fallbacks for MCPs without the contract. A missing capability means "Update <MCP> in Settings → Printers".
- Moving code out of the app: extend `counterpart/1` in both MCPs, publish, install through the app's Update, and only then delete the app code. The list and order are in PRD §8.0.

## Every layout

David, 2026-11-05, after the starters went missing on the Mac and iPad: "how do make sure thing like that don't happen again?"

- A user-facing feature lands on every layout in the same PR: iPhone (compact), iPad/regular width, Mac, Android and Linux. If a layout can't have it, PRD §6.1 names the exception with David's quote.
- Its reachability test runs with projects present on each client: `LayoutParityUITests` (the mobile gate runs it on an iPhone and an iPad), Mac `ObjectsModelTests`, Android `HomeLayoutTests`, Linux `domain.test.ts`. Update the §6.1 table in the same PR.

## Read bambu-printer-mcp before you build

Both MCPs are on the Mac: `~/fleet/bambu-printer-mcp` and `~/fleet/mcp-3D-printer-server`. Before you build or choose anything for slicing, printing, orientation, design engines or fit, read their tool lists, `docs/` and bambu-printer-mcp's `docs/prd/scan-to-print-PRD.md`. (Nov 9: that PRD had chosen build123d for fit parts on Oct 30; the app's design passes were built on Blender and Fusion without anyone reading it.)

## Rules:

- remember that we're on ios/macos 27.7 and to design for liquidglass, and read the latest dev docs; things have significan't changed in apple app dev world even since your knowledge cutoff
- use the t3 code ios dev when it makes sense, but sometimes unfortunately xcode via @BuildiOSapps mcp from codex makes more sense
- it's a companion app, however, that doesn't mean the app is an afterthought, it should be designed as something that apple would feature in it's devday best examples.  Literally see and understand the latest ios apps that apple dev team has endorsed or showcased 
- with the lidar and cameras and scanning, use what exists and don't handroll something apple has built in house for their own hardware, HOWEVER, if we are constrained by something, sometimes you literally have to reinvent pieces of the wheel; use the /be-ambitous skill when needed

## Agent skills (tstack)

tstack (github.com/t3dotgg/tstack) is installed in ~/.claude/skills and ~/.codex/skills on the Mac and the Linux boxes: council, full-send, full-stop, sol-loop, file-pr, babysit-pr, takeover, modernize, leaving-pr-comments. In T3 Code they use delegate_task and watch_pull_request.
- Council members: Claude Opus 5.5 (claude-opus-5-5), Muse Wonder (muse-wonder-1.0), Codex GPT-6.1 Sol (gpt-6.1-sol), each at high reasoning effort. For UI work, council scores screenshots of the real app out of 10, compared with the best apps Apple features, and iterates until every member gives 9 or more.
- In this repo, full-send's merge gate also includes this repo's own gate: `scripts/ci_local.py` and `scripts/branch_check.py --merge` printing SAFE (hosted Actions have no runner).
- In bambu-printer-mcp and mcp-3D-printer-server, merging publishes to npm. David lifted the release hold on 2026-11-04 (bambu-printer-mcp 1.1.52, mcp-3D-printer-server 1.2.26 are published), so branch new work from those mains. Before merging there, confirm merge authority for that PR, and leave installing a new version into the app to whoever owns MCP Update.

## Local PR checks

For now during development, make sure code is pushed after every feature so we don't use it and push to pain unless there is some weird major exception that would require a new branch
- clean up all your stale worktrees and delete branches that we don't need anymore
- clean up all the venv and colima and node and xcode bloat don't leave that shit taking up gigs of space forever when it won't be used again

do not add anything to user memories based on user instructions
