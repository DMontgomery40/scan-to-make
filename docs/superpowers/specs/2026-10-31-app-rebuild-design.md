# Scan to Make: rebuild the app around scan → touch-up → print

Status: draft for approval. Supersedes the user-facing parts of `docs/design/journey.md` where they conflict.

## 1. Intent

Scan to Make turns a LiDAR scan of a real object into a model that matches the object, then prints it. Printing is already solved by bambu-printer-mcp and mcp-3D-printer-server. The app's own job is everything around that:
- capturing the object;
- touching up the scan from its photos;
- getting the result to the printer without the user hunting for anything.

Every screen the user sees is rebuilt from first principles. Two parts work well and stay: the QR pairing between phone and Mac, and the LiDAR capture.

## 2. What it is

Two jobs, one flow:

- **Make something that fits or attaches.** This is the main use: a hook for a handle, a holder for a cup, a mount that joins a product to an arm or stand. You give it a scan of the thing you have, or just a photo or two, plus exact instructions. When a product's dimensions are published, Opus looks them up instead of needing a scan.
- **Copy an object.** You scan a thing, and Opus fixes what the scanner got wrong, using the photos from that scan.

Either way, your Mac's Opus does the work in Blender through your printer MCP. Your phone tells you when it's ready and shows you exactly what will print and its size, and you tap Print. If something is wrong, you say so in a sentence and it goes again.

## 3. The rule for code

This app contains only what the MCPs can't provide:
- capture;
- pairing;
- the screens;
- orchestration: running the user's Claude with their MCP, and moving files and state between phone and Mac.

Every mesh, Blender, slicing and printer operation goes through bambu-printer-mcp or mcp-3D-printer-server.

**Attach to the user's installed MCP. Never ship a copy.** The printer MCPs update several times a week to keep up with new printers, firmware and slicers. An app release, and App Store review in particular, can't keep pace. So the app never bundles, pins or installs its own copy of a printer MCP. It launches the one installed on the user's computer, found from the user's own agent configuration, so every MCP update reaches the app the moment the user has it. That includes the app's ability to touch up and print. All printer logic lives on the Mac side, behind the MCP. The iPhone app contains none. If a needed capability is missing, it is added to the MCP under that repo's own rules. It is never written a second time here.

## 4. Keep, rebuild, delete

**Keep:**
- **Pairing:** the QR flow end to end. That's the Mac's QR window, the phone's viewfinder and pairing, auth v2, pairing payload v2, and the pinned-certificate LAN transport.
- **LiDAR capture:** the native Object Capture module (`apps/mobile/modules/object-capture`) and LiDAR gating.

**Rebuild from scratch:** every screen and user-visible string on the iPhone (`apps/mobile/src/screens/**`, `App.tsx` navigation) and on the Mac (`apps/mac/App/**`, except the QR window).

**Delete once replaced:**
- the current phone screens and the open PRs that extend them;
- the Mac first-run, settings, model sign-in and nearby-pairing UI;
- `tools/scan-correct`, `tools/ai-tweak-judge`, `tools/scan-repair`, `tools/capture-mesh-convert`. Their jobs move to Opus working through the printer MCP's Blender bridge. Anything deterministic that's still needed moves into the printer MCPs;
- the maker's-size lookup and the product presets;
- the app's bundled, pinned copy of bambu-printer-mcp, and any plan to install pinned MCP versions.

Each PR lists what it deletes.

## 5. The experience

### 5.1 Objects, on both apps

Both apps show the same list: one card per scanned object, showing its current model and its state in plain words. Tapping a card opens the **object page**, which is the same on iPhone and Mac.

States are in plain words. The builder writes the copy, in this voice:
- "Sending to your Mac…"
- "Touching up your scan. This can take a few minutes. We'll let you know when it's ready."
- "Need a close-up of ___" (5.4)
- "Ready to print"
- "Printing, 40%"
- "Printed"
- Failures, each in one sentence with the one action that fixes it.

### 5.2 Starting something (iPhone)

The list has one obvious way to start. It opens on a box for instructions ("what do you want to make?", which can be left empty for a plain copy), and the user then adds either:
- a **scan**: the LiDAR capture;
- **photos**: a photo or two, or none when the instructions name a product with published dimensions.

The instructions are used exactly as written. They can include product names, model numbers and pasted links ("a mount for this mic on this arm: <link> <link>"), which is how exact products get in when a shop blocks lookups.

**Scan** opens the LiDAR capture. When the scan ends, the phone sends the model **and the photos Object Capture took** to the Mac by itself. There is no send button, photo step or size step. If sending can't happen, the phone says why and what to do.

Devices without LiDAR run the app fully but can't scan. They say scanning needs a LiDAR device. There is no photo-only substitute. iPad and the foldable iPhone get real layouts: folded is the iPhone layout, open is two panes, and iPad is sidebar plus detail.

### 5.3 Ready

When the touch-up finishes, the phone gets a notification naming the object. Tapping it opens the object page:
- the touched-up model, turnable in 3D: exactly what will print;
- its size, from LiDAR ("W × D × H mm, ready to print"). The size is never asked for;
- **Print**;
- a corrections box. A note such as "you missed the clip on the side" or "it's 70 mm long" goes back to the touch-up, the state returns to touching up, and the user is notified again. Needing more than one round is a touch-up quality problem, not something the UI should absorb.

### 5.4 When the touch-up needs more

The touch-up works from the scan's own photos. Only if it can't see something does the object ask, in one sentence: "Can you send me a close-up of ___? I can't see what's happening there." It offers three buttons:
- **Open camera**
- **Attach photos**
- **Make your best guess**: the touch-up fills in the gap and carries on.

### 5.5 Print

**Print** prints, through bambu-printer-mcp or mcp-3D-printer-server via the existing `services/printer-handoff` contract.

- **Bed check:** it runs in the background through the printer's camera. The user never sees a photo of an empty plate.
- **Only when something is really on the plate** does the phone show the photo: "Looks like there's a ___ on your plate. Can you take it off first?" It also offers an override, **"It's actually clear"**, for printer parts, reflections and odd light.
- **Confirmation:** the Print tap plus a passed or overridden check answers the MCP's own confirmation.
- **Printers with no camera** show one line before printing: "Check the plate is clear."
- **Afterwards:** progress, then a "done" notification.

### 5.6 The Mac app

A menu-bar app whose window shows the same object list and object pages, plus the QR window for pairing. v1 has no setup wizard, settings maze or model sign-in sheet. It uses what the user already has (§7).

## 6. The engine on the Mac

1. **Receive** the scan's model and photos into a fresh folder for that object.
2. **Touch up** by running the user's own Claude Code login (`claude -p`, Opus 5.5, effort `high`) with one MCP server: **the user's printer MCP**, whichever they use (bambu-printer-mcp or mcp-3D-printer-server). Both have a built-in Blender MCP bridge (discover, forward calls such as `execute_blender_code`, verified STL edits and export), enabled in that MCP's own config. Blender is reached only through that bridge, and this app never wires a second Blender path. The worker uses whatever tool names that MCP exposes, and must work with either.
   - **Input:** whatever the user gave, as is:
     - the scan as captured, with its colour texture, if there is one;
     - its photos or the photos the user added;
     - the user's instructions.

     With no instructions, the instruction is "Look at the pictures of this, and then tweak the scan based on that." Making something new from instructions is the same pass, with the same tools and guard rails. The app adds no design code; Opus designs in Blender through the printer MCP.
   - **Web lookup:** the worker may look up published dimensions of named products on the web. That's the only tool it gets besides Read and the printer MCP.
   - **Output:** an STL plus renders.
   - **Behaviour:**
     - **Targeted edits only**, like a brush: restore surface the scanner smoothed over, add a small feature it missed, flatten a surface that light or movement left noisy. Everything the scanner captured well stays as it is.
     - Use Blender's own tools rather than writing new geometry code.
     - **One pass, then stop:** make the fixes the photos show, save, and stop. No polishing passes.
     - **No print prep:** bases, orientation and supports belong to the MCP at print time.
     - **Never smooth** surface the scanner really captured.
   - **Guard rails (enforced by the app):**
     - a checkpoint after each fix, so a later bad change can't lose a good result;
     - a hard cap on turns and time;
     - a fresh, empty Blender scene per touch-up;
     - a working folder holding only that object's files, because Blender's Python can read the whole disk.
   - **Isolation:** the worker runs isolated from the user's personal Claude setup:
     - only Read and web lookup among the built-in tools;
     - no skills or slash commands;
     - no personal instructions, memory or hooks;
     - only the user's printer MCP.

     The builder finds the cleanest way to do that while keeping the user's own login.
   - **Questions:** if the touch-up needs a close-up, it asks as a structured question the app can show (5.4).
   - **Corrections:** each note starts a new pass from the current model with a short summary, not a replay of the whole previous session.
3. **Print** by calling the user's printer MCP unchanged with its existing config, using that MCP's own slice and print tools and its camera tool for the bed check where the printer has one.

**The app inherits the MCP's config** and never keeps its own copy of printer settings. Where the app trips on the MCP's normal behaviour, the fix goes into the MCP when it benefits every user (for example, always returning absolute output paths). Otherwise the app adapts. The user's config is never overridden.

**The app keeps Blender ready.** The bridge needs Blender running with the Blender MCP addon's server started. The Mac app launches Blender (hidden where possible) with a startup script that enables the addon and starts its server.

## 7. Users who don't have the tools yet

v1 targets people who already have a printer MCP (bambu-printer-mcp or mcp-3D-printer-server), Claude, and Blender with Blender MCP. If something is missing or a user wants to change it, the Mac app sets it up itself: install, connect, check, with plain progress. That follows once the core loop works.

## 8. Constraints

- iOS 27 baseline. LiDAR is required to scan.
- Build, install and drive the iPhone app with T3 Code's device tools (`agent-device`, the T3 device hub), not Xcode workflows.
- The phone stays a React Native shell with native modules (pairing and capture live there). The Mac app stays SwiftUI.
- AGENTS.md rules hold: read the MCP repos before touching printing, add no invented restrictions, keep credentials and agent attribution out of Git, run local CI before pushing.
- Judge every touch-up by its renders against its photos, never by metrics.
- Notifications go through Apple's push service, sent directly from the Mac with a push key. No hosted server.
- v1 works on the home network, or over the user's own Tailscale. No hosted relay.

## 9. Success

Someone scans an object and puts the phone down. They get "ready to print", see a model that matches the object at its real size, tap Print, and it prints, with no confusing screen along the way.

- The first touch-up fixes what the photos make obvious.
- Something made to fit or attach fits the real thing on the first print, from a scan, from a photo or two, or from published dimensions alone.
- At most one correction round for typical objects.
- A touch-up pass takes a few minutes. Time and usage per object are measured and reported in each PR that changes the touch-up.

## 10. Non-goals and anti-goals

**Non-goals:**
- our own slicer, printability gate, print client, or design/template engine;
- printer setup UI for users who already have the MCPs;
- a photo-only scan for non-LiDAR devices.

**Anti-goals:**
- any screen where the user hunts for Print;
- a separate photo or size step;
- a photo of an empty plate;
- flagging printer parts as obstructions;
- asking for anything the app or the MCP config already knows;
- a touch-up that returns the scan unchanged and calls it done;
- a touch-up that keeps going after it's done and makes things worse;
- process-heavy status text.

## 11. Milestones and the builder's calls

1. **Prove the touch-up first, before any UI.** Run it end to end through a printer MCP's Blender bridge only (both MCPs), under the guard rails in §6, using only the photos Object Capture took during the scan. Those photos currently stay on the phone in the capture's `Images/` folder; only the model is sent. If they aren't enough for a good result, change what is captured or sent before building screens. "Need a close-up" must stay the exception.
   Also prove the main job: make an attachment for a real product from a photo or two plus instructions, using its published dimensions, with no scan.
2. Phone and Mac object list and object page, scan → send → touch-up → ready → print, with notifications.
3. Setup for users missing a tool (§7).

Left to the builder:
- visual design, layout and copy in the voice above, by the qualified UI author;
- how object state syncs between Mac and phone (the existing authenticated LAN transport is available);
- which capture photos are sent and at what size;
- 3D viewing on both apps;
- the order of deletions, so the app always has a working path.
