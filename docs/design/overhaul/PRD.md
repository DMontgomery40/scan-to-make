# Counterpart 2: product requirements for iPhone, iPad and Mac

**Platforms:** iOS 27.2 and iPadOS 27.2 (minimum 27.0), including iPhone Duo; macOS 27.
**Status:** draft for the owner's review, 2026-11-01.
**Replaces:** the screen specs in [`../journey.md`](../journey.md) §5–§9. journey.md's decisions on pairing (§3.4), the companion and its payload (§3.2–3.3) and model sign-in (§3.6) still stand unless this document changes them.

**Read with:**
- [audit.md](audit.md): why this rebuild is needed;
- [`screens/`](screens/): the mockups, rendered as real SwiftUI with real Liquid Glass on iOS 27.2 and macOS 27 simulators and devices;
- [`mockup-app/`](mockup-app/): the source of those mockups;
- [`research/`](research/): Apple design research and the in-hand capture research, both with sources.

---

## 1. The product

Counterpart makes physical things that fit your life, using your iPhone, your Mac and your 3D printer. It has two jobs:

1. **Make something that fits.** You need a part that attaches to, holds or fits something you own. Describe it, and show the thing with a scan or a few photos, or with nothing when its size is published. Your Mac designs the part.
2. **Copy an object.** Scan it. Your Mac fixes what the scanner missed, checks the result against your photos and makes it printable.

Either way you get a notification when it's ready. You look at it, print it or ask for changes, and you're told when the print is done.

The work happens on the user's Mac, through the printer MCP they already have (bambu-printer-mcp or mcp-3D-printer-server) and its Blender bridge. Counterpart never re-implements slicing, printing or print safety. It is the interface to those tools.

## 2. Design principles

Each principle is taken from what Apple rewarded in 2026; sources are in [research/apple-design-2026.md](research/apple-design-2026.md).

1. **The object is the hero.**
   - Every project leads with a live, orbitable 3D model on a dark stage, with Liquid Glass controls floating over it. Tide Guide won Visuals and Graphics with full-bleed content and glass on top.
   - Thumbnails are real renders, never placeholders.
2. **One main action, within thumb reach.** New, Print and Send all sit at the bottom of the screen. Nothing that starts work lives in the top corners.
3. **Always say what's happening, how long it will take, and what comes next.**
   - No silent spinners: every wait shows a stage, an estimate and "you can put your phone down".
   - Every wait that runs longer than a few seconds ends in a notification.
4. **Ask only when it matters, and always offer a way out.**
   - When the Mac needs input, it asks one specific question with a picture.
   - It always offers **Best guess**.
5. **One project, everywhere.** The phone, iPad, Duo, Mac, Lock Screen, Dynamic Island, Mac menu bar and widgets all show the same project in the same words.
6. **Honest states.**
   - Never show success without evidence.
   - Every error says what happened and what to do, in plain words. Raw codes stay hidden.
   - Estimates come from real timings.
7. **Native everywhere.**
   - Use the system's own controls: Liquid Glass, toolbars, sheets, search, menus and haptics.
   - Get Dynamic Type, VoiceOver, Increase Contrast, Reduce Motion and Differentiate Without Color for free, then go further: 3D views get spoken descriptions, and status always pairs a symbol with words.
   - Moonlitt won Interaction for "best-in-class Liquid Glass integration" and easy onboarding. Guitar Wiz won Inclusivity for spoken guidance and full accessibility support.

## 3. Platform decision: native Swift, no React Native, no Electron

**Decision.** Both apps become pure Swift and SwiftUI and share one Swift package, `CounterpartKit`. React Native is removed from the phone, and the Mac stays native.

### Why not Electron or a web stack

- **On iPhone it isn't an option.** Electron only runs on desktops.
- **The phone app depends on native frameworks.** It is built on Object Capture, LiDAR depth from AVFoundation, RealityKit, ActivityKit (Live Activities), WidgetKit, App Intents and Liquid Glass. All of them are Swift frameworks, and a cross-platform layer would only wrap them.
- **On the Mac, Electron costs what matters most here:**
  - **No real Liquid Glass.** Electron can't use `NSGlassEffectView` or the system toolbar.
  - **Size.** It adds about 150–200 MB for a menu-bar companion.
  - **No RealityKit.** The model viewer would have to be rebuilt in three.js.
  - **Native bridges.** Local Network permission attribution, `SMAppService`, the Keychain, `MenuBarExtra`, Quick Look and notifications would each need one.

  journey.md §3.2 already covers these reasons.
- **When a cross-platform shell makes sense:** if a Windows or Linux companion is ever wanted. The companion is already a Node service with a documented protocol, so a Tauri shell for Windows could wrap it later without touching the Apple apps.

### Why remove React Native from the phone

- **It's the worst of both.** Two runtimes ship, the pairing screens look different from the rest of the app, and Metro release-bundle bugs are already recorded in project memory.
- **It's small to replace.** All that's left in React Native is pairing, pairing-link parsing and credential refresh, about 600 lines. They port to Swift directly, with VisionKit's `DataScannerViewController` for the QR scanner.

### Shared code

`CounterpartKit` (an SPM package) holds:
- the domain model (§4);
- the companion API client;
- the status words (one source of truth, replacing the duplicated `ObjectWords` and `ObjectsModel`);
- the CloudKit records and subscriptions (§8.8, §9.2);
- the formatters for size, time and grams.

## 4. Domain model

| Entity | What it is | Key fields |
|---|---|---|
| **Project** | One thing you want made | short title (generated), request text, kind (fit or copy), state, current result, printer target, timestamps |
| **Input** | Something you gave it | scan (walk-around or in hand), photo, close-up, link, note; who added it and when |
| **Pass** | One round of work on the Mac | trigger (new, ask for changes, late photos), stages with start and end times, worker trace (plain-language steps plus tool lines), outcome |
| **Result** | A model version | mesh, renders, dimensions, a "what changed" list (added, changed, assumed or estimated, each tagged), confidence notes |
| **Ask** | A question from the Mac | text, a picture with the region highlighted, the answers allowed (camera, photos, best guess, free text), status |
| **Print** | A print job | printer, profile, colour map, estimate (time, grams), plate check result, live state (percent, layer, time left), events |
| **Printer** | Read from the user's MCP config | name, model, MCP (bambu or 3D-printer-server), state, filament or AMS slots, camera available |
| **Device** | A paired phone or iPad | stable install id, user-facing name ("David's iPhone"), model, last seen. Re-pairing replaces the device; it never duplicates it. |

**Project states and the words shown for them:**

| State | Shown as | Symbol and colour |
|---|---|---|
| sending | Sending to your Mac | arrow.up.circle, blue |
| working | Your Mac is working · *stage* · about *N* min | wand.and.sparkles, blue |
| needs-you | Needs you · *the question* | hand.raised, orange |
| ready | Ready to print · *dimensions* | checkmark.seal, accent |
| preparing | Getting the print ready | gearshape, accent |
| printing | Printing on *printer* · *N*% · *T* left | printer.fill, green |
| printed | Printed *date* | shippingbox, secondary |
| failed | *What happened* · *what to do* | exclamationmark.triangle, red |

## 5. iPhone

### 5.1 Home

Screenshot: `screens/phone-home.jpg`.

- **Title area.** A large "Counterpart" title, with the subtitle "*Mac name* connected · *N* printers ready". Top-trailing holds a Printers button with a badge for printer problems, and the account and settings button. Those are the only items at the top, and neither starts work.
- **Now.** One card for each job that's running:
  - **Printing:** live camera thumbnail, percent, layer, time left, and filament chip.
  - **Working:** model thumbnail, stage in plain words, estimate, and step *n* of *m*.
- **Needs you.** One card for each open Ask, with the question, its picture, and the **Camera**, **Photos** and **Best guess** buttons inline. You can answer without opening the project.
- **Projects.** A two-column grid of real renders, each with a status capsule. Ready projects come first, then the rest by recency.
- **Bottom toolbar:**
  - search ("Projects, printers, notes"), using the iOS 27 bottom search placement;
  - a prominent **New** button at the bottom trailing edge, in the accent colour. It's the only prominent control on the screen.
  - If a build uses a tab bar, New becomes `Tab(role: .prominent)` (new in iOS 27). Either way it stays bottom-trailing.
- **Empty state.** Show the two jobs as two illustrated cards ("Make something that fits" and "Copy something"), each one tap from the New sheet with that job preselected.
- **Acceptance:**
  - A first-time user starts a project in one tap from Home, with one thumb.
  - Every running job is visible without scrolling on an iPhone 18 Pro.

### 5.2 New

Screenshot: `screens/phone-new.jpg`.

**Layout.** A large sheet:
- **What do you need?** A multiline field with dictation. The hint: "Describe it, scan it, or both. Your Mac can look up published sizes."
- **Show it.** Four tiles, all visible at once:
  - **Scan it**: walk around it; LiDAR measures it.
  - **Scan in hand**: hold it up and turn it.
  - **Take photos**.
  - **From Photos**.
- **Added.** Thumbnails of everything attached, each with a remove button.
- **Send to *Mac name***: a full-width prominent button at the bottom, enabled as soon as there is any text or any input.

**Behaviour:**
- The text is kept whatever you do, including when you leave and come back. The field never disappears.
- Scanning returns to this sheet with the scan attached, so a scan and a description go together.
- On devices without LiDAR (iPhone Duo, non-Pro iPhones), the scan tiles say "Needs an iPhone or iPad with LiDAR" and stay visible but disabled. Describing a part and adding photos work fully.
- Sending creates the project at once. Upload continues in the background (background `URLSession`), and the project shows Sending until it lands.

### 5.3 Capture

- **Walk-around (unchanged).** The existing Object Capture module (`apps/mobile/modules/object-capture/`) works and isn't touched. Changes are limited to its entry and exit: it's launched from New and returns its scan to New.
  - Close-ups come from the scan's own images, with no extra step. The Mac picks frames from the capture (§7.4).
- **Scan in hand (new; spec in §11).** Screenshot: `screens/phone-hand.jpg`.
  - A full-screen camera with the object's live outline and a coverage ring. One glass card carries one instruction at a time ("Turn it so the top faces you").
  - Shutter and LiDAR status are always visible ("1/500 s · LiDAR on"), with a count of sharp and skipped frames.
  - A Walk around / In hand switch, and a Done button.

### 5.4 Project

Screenshots:
- `screens/phone-ready.jpg`
- `screens/phone-working.jpg`
- `screens/phone-ask.jpg`
- `screens/phone-inputs.jpg`

**Layout:**
- **Hero.** A live RealityKit model on a dark stage that you can turn by dragging. Glass buttons float over it:
  - **AR**, which places the model at true size in the room (Quick Look AR);
  - **Compare**: your scan, the result, or side by side;
  - a dimensions capsule.
- **Header.** Status capsule, time, the generated title, and your request.
- **State card**, depending on the state:
  - **working:** "Your Mac is working on it · about *N* min", a progress bar, and "You can put your phone down. We'll let you know when it's ready."
  - **needs-you:** the Ask card, with its question, its picture with the region highlighted, and Camera, Photos and Best guess.
  - **failed:** what happened and what to do, with a retry when one applies.
- **Sections** (segmented):
  - **Result:** the *what changed* list (added, changed, published sizes used, estimates with their tolerance), and tiles for print time, filament and printer.
  - **What you sent:** your request, every photo and scan full size, and your follow-ups with times.
  - **Activity:** the passes as a stage timeline. The current stage pulses, and each step expands to show the worker's plain-language note and tool lines.
- **Bottom bar:**
  - an **Ask for changes…** field with dictation and attachments, which sends a new pass with your text;
  - **Print**, shown when the project is ready.
  - When the project needs you, the Ask card replaces this bar.
- **Menu (•••):**
  - Open on Mac in Blender;
  - Open on Mac in *slicer*;
  - Compare versions;
  - Share (STL, 3MF, USDZ);
  - Delete.

**Acceptance:**
- From a "ready" notification, the user sees the model and **Print** in one tap.
- From a "needs you" notification, the camera opens in one tap.

### 5.5 Print

Screenshot: `screens/phone-print.jpg`. The flow is modelled on Bambu Handy and MakerWorld's Prepare to Print.

**Layout:**
- **Printer.** A horizontal row of cards, one per printer, read from both MCPs. Each card shows the name, model, a ready dot and its spool colours.
  - Offline printers are dimmed and show why.
  - The last printer used is preselected.
- **Plate preview.** The model on a plate, with time, grams and layer count as glass capsules. These come from slicing with the printer MCP (`slice_stl` and its estimate) as soon as a printer is chosen.
- **Colours:**
  - Each part or colour of the model maps to an AMS slot or the loaded spool, matched by the MCP's material and colour.
  - Tap a slot to change it. Grams are shown per colour.
  - A printer without an AMS shows "Uses the loaded filament: *material colour*", with a reminder to change it if needed.
- **Quality:** Draft, Standard or Fine (layer height).
- **Strength:** Standard, Strong or Max (walls and infill).
- **Profile line:** the actual profile name. The trailing toolbar button opens all of the slicer's settings, or "Open in *slicer* on Mac".
- **Check the plate first:** on by default. Its caption: "Your Mac looks through the printer camera. You'll only hear about it if something's there."
- **Print on *printer***: a prominent bottom button with "Done around *time*".

**Behaviour:**
- Starting a print still answers the printer MCP's own confirmation. The app presents the MCP's questions natively, never as a raw form.
- If the MCP asks something the app can't render, it says so and offers "Answer on your Mac".

### 5.6 Plate check

Screenshot: `screens/phone-plate.jpg`.

- **Shown only when something is on the plate.** The check runs on the Mac with the printer camera and bambu-printer-mcp's check. If the plate is clear, the user sees nothing and the print starts.
- **When something is there:**
  - the title "Something's on the plate";
  - one sentence saying where;
  - the camera frame with the region outlined;
  - **I cleared it. Look again** (prominent) and **The plate is clear. Print anyway**.
- **"Clear" is remembered as a correction** for that printer, so glare, glue and the printer's own parts stop raising alerts.
- **It also arrives as a time-sensitive notification** with the frame attached (§9.1).

### 5.7 Printing

Screenshot: `screens/phone-printing.jpg`.

- **Content:**
  - the printer camera at the top, full bleed, as a photo refreshed every 3 s with "Updated *n* s ago", plus full-screen (§8.6);
  - a progress ring, layer, time left, finish time and filament;
  - nozzle, bed and speed tiles;
  - Pause and Stop in the bottom glass bar. Stop asks for confirmation.
- **Live Activity.** It starts when the print starts (§9.4) and appears on:
  - the Lock Screen;
  - the Dynamic Island (compact: ring and minutes left; expanded: camera still, Pause, Open);
  - StandBy;
  - the Watch Smart Stack;
  - the Mac menu bar.

### 5.8 Printers

Screenshot: `screens/phone-printers.jpg`.

- **One row per printer** from the MCP configs on the Mac, showing state, spools, current job and camera.
- **Tap a printer** for its live camera, job, filament and history of prints from Counterpart.
- **The footer says plainly** that printers are configured in the MCPs on the Mac and Counterpart picks them up. Settings are never duplicated in the app.

### 5.9 Settings and About

- **Your Mac:** name, connected or last seen, address in use, Check Connection, Connect a Different Mac.
- **Notifications:** an on/off switch for each event type, and the progress milestones (§9.1, §8.6).
- **Help:** a guide at the docs site, how scanning works, and **Print the caliper card**.
- **About:** the app icon, "Counterpart", the version and build, the website, the licences, and open-source notices.

### 5.10 First run and pairing

**Order:**
1. Welcome: one screen with the two jobs.
2. Find your Mac: a QR scanner, with a nearby Mac shown as a card underneath (journey.md §3.4).
3. Notifications permission, asked with a reason: "So you know when it's ready and when the print is done".
4. Done.

- Camera and Local Network permissions are asked when first used, each with a reason.
- The Mac's pairing window stays the QR code alone (decided in journey.md §3.4).

## 6. iPad and iPhone Duo

Screenshots: `screens/ipad-split.jpg` and `screens/duo-closed.jpg`.

- **iPad, and Duo unfolded.** A `NavigationSplitView`:
  - a sidebar grouped as Now / Needs you / Ready / Printed / Printers;
  - the project page in the detail pane, with the model hero larger;
  - New in the sidebar's bottom bar;
  - drag and drop photos from Files or Safari onto New or onto a project;
  - pointer and keyboard shortcuts: ⌘N new, ⌘P print, ⌘F search.
- **Duo folded.** The iPhone layout. iOS 27 moves the toolbar to a vertical rail on the outer panel's landscape layout automatically, and the mockup confirms it. New stays at the bottom of the rail.
- **Duo during capture.** Duo can't scan (no LiDAR). Its outer display can still show an "In progress" `CameraCaptureAccessory` for photo capture.
- **iPhone apps are resizable in iOS 27.** Every screen must reflow from compact to regular width. Test with Xcode 27 previews' resize handles.

## 7. Mac

### 7.1 App shape

- **A normal Mac app with a menu bar extra.** It has a Dock icon by default, with a Settings switch to hide it, plus a `MenuBarExtra`.
- **SwiftUI scenes only:**
  - `Window` for Counterpart;
  - `Window` for the pairing QR;
  - `Settings`;
  - `MenuBarExtra(.window)`.

  This replaces the hand-built `NSWindow`s and the activation-policy switching (audit M1).
- **The companion** stays the bundled Node service, registered as an `SMAppService` agent as today.

### 7.2 Main window

Screenshot: `screens/mac-main.jpg`.

- **Sidebar:**
  - Now / Needs you / Ready / Printed, each row with a real thumbnail and its status line in the state colour;
  - Printers, with ready dots;
  - footer: "*Phone* connected · *AI provider*".
- **Detail:**
  - a full-height RealityKit model you can orbit and zoom;
  - the window title is the project title, and the subtitle is the state and request;
  - a status capsule;
  - a bottom glass bar with **Ask for changes…** (it also accepts dropped photos and files) and **Print…** (prominent).
- **Toolbar:** Open in Blender, Open in Slicer (a menu: Bambu Studio / OrcaSlicer / Choose Another App…), Show in Finder, New Project, Inspector.
- **Inspector,** with three tabs:
  - Request: request, photos, what changed;
  - Activity: passes, stages and tool lines;
  - Print: printer, profile, colours and the last print's events.
- **New Project on the Mac.** Drop photos, STL, 3MF or USDZ files, or type a request. Projects started on the Mac appear on the phone too.

### 7.3 Print sheet

Screenshot: `screens/mac-print.jpg`. The same content as the phone's (§5.5), laid out as a sheet: printer cards, the plate preview, the colour map, quality, the plate-check switch, and **Print on *printer***.

### 7.4 Menu bar popover

Screenshot: `screens/mac-popover.jpg`.

- **Status:** a header with the app mark and Ready, Working or Problem.
- **Now:** running jobs with progress.
- **Needs you:** cards, each saying "Asked on your iPhone too".
- **Printers:** ready dots.
- **Buttons:** Open Counterpart, Add a Phone (QR), Settings.

### 7.5 Settings

Screenshot: `screens/mac-devices.jpg`.

- **General:** open at login, show in Dock, notifications.
- **Phones and iPads:**
  - one row per device, named and with its model;
  - each row shows connected now or last seen, and its paired date;
  - Remove…, and Add a Phone….
- **Printers:** read-only, listing each printer and which MCP provides it, with a link to the MCP's own config.
- **AI** (journey.md §3.6, unchanged): provider, connected state, and a test.
- **Advanced:** addresses in use, logs, diagnostics export.

### 7.6 What the Mac does without being asked

- **Close-ups from the scan.** On arrival, the Mac selects the sharpest, most informative frames from the capture as reference photos. If the scan can't show a region, the Mac raises an **Ask** with that region highlighted.
- **Background plate check** before each print (§5.6).
- **Prevents idle sleep** while a pass or a print is running (journey.md §3.3).

## 8. Back end: printers, progress and events

This section specifies every connection from the user's printer to their phone's Lock Screen.
- **Baseline:** the `feat/counterpart-project-workspace` branch at `dca404d`, which Codex is still committing to.
- **Existing** marks what that branch already does. Keep it, and don't rebuild it.
- **New** and **Fix** mark the work this PRD adds.
- Re-read the branch head before starting a milestone, because it moves.

### 8.1 Topology

```
iPhone ──HTTPS, LAN/VPN, pinned key──▶ companion (Node, on the Mac) ──MCP over stdio──▶ bambu-printer-mcp ──MQTT 8883 · FTPS 990 · camera TCP 6000 / RTSP 322──▶ Bambu printer
   ▲                                     │        └──────────MCP over stdio──▶ mcp-3D-printer-server ──HTTP──▶ OctoPrint · Moonraker (Klipper) · PrusaLink · Duet · Repetier · Creality
   │                                     │ Unix control socket (existing)
   │                                     ▼
   └────── CloudKit private DB ◀──── Counterpart for Mac (Swift) ──HTTPS──▶ relay Worker (counterpart.dtmont.com) ──APNs──▶ iPhone Live Activity
```

Who runs what:
- **The companion** owns everything that talks to printers: MCP sessions, the print monitor, the event log, the plate check, the phone's HTTP API and the Mac's control socket.
- **The Mac app** delivers events: Mac notifications, CloudKit records, and Live Activity pushes through the relay.
- **The phone** never talks to a printer or an MCP directly.

### 8.2 Finding printers and choosing the MCP

- **Existing.** `services/companion/src/objects/printers.ts` (`loadPrinterCatalog`) builds the list of printers from the MCP configs the user already has:
  - Claude Code (`~/.claude.json`, user and project scopes);
  - Claude Desktop;
  - Cursor;
  - Codemode.

  It runs the user's own installed MCP with their own `.env`, at whatever version they have. Counterpart never pins it, because these MCPs ship updates several times a week.
- **New: one more source.** Read Codex's `~/.codex/config.toml` `[mcp_servers.<name>]` tables (`command`, `args`, `env`, `cwd`). The catalog doesn't read Codex today.
- **Fix: one printer, one destination.** Today the identity key includes the backend, so a Bambu printer configured in both MCPs shows up twice.
  - The new key is the Bambu serial when one is known (`BAMBU_PRINTER_SERIAL`/`BAMBU_SERIAL`); otherwise the lowercased `host:port`.
- **Routing rule.**
  - A Bambu printer uses **bambu-printer-mcp**. mcp-3D-printer-server is used for a Bambu printer only when bambu-printer-mcp isn't configured.
  - Every other printer (Prusa, Klipper, OctoPrint, Duet, Repetier, Creality) uses **mcp-3D-printer-server**, with its `PRINTER_TYPE`.
  - When several profiles reach the same printer through the same MCP, the Mac app's own `printer-handoff.json` (the `current` destination) wins.
- **Capabilities are detected, never assumed.** On the first connection, the companion reads the server name and version from MCP `initialize`, plus its tool list. Each feature lights up only when its tool exists (§8.4).
  - If a tool is missing, Printers says exactly which update unlocks it, with an **Update** button that runs the user's own package manager command for that MCP. Example: "Update mcp-3D-printer-server to see progress and camera."

### 8.3 MCP sessions: one long-lived session per printer

- **Fix.** Today `PrintRunner.status()`, `filaments()` and the print run each spawn a new MCP process and close it afterwards (`printer-handoff/src/print.ts`). The project `GET` calls `status()` every 15 s while a print is open (`objects/service.ts`).
  - Each spawn of bambu-printer-mcp opens its own MQTT connection to the printer.
  - During a print, that means a churn of processes and several MQTT clients at once.
- **New: `PrinterSessionPool`** (in `services/printer-handoff`).
  - **One connection per destination.** One `PrinterMcpClient` per destination id, connected on first use and shared by every call to that printer: progress, camera, filaments, slicing, printing, pause, resume and cancel.
  - **Lifetime.** Reference-counted holders keep a session open: the print monitor, and any open Printing screen or Printers screen. The session closes 120 s after the last holder releases it.
  - **Restarts.** If the transport closes, the next call reconnects. Backoff is 1, 2, 5, 15 then 30 s. A health field records the time of the last successful call.
  - **Concurrency.**
    - Reads run concurrently: `counterpart_print_progress`, `camera_snapshot`, `get_printer_filaments`, `counterpart_printer_info`.
    - Calls that change the printer are serialized by a per-destination mutex: `print_3mf`, `upload_gcode`, `start_print`, `pause_print`, `resume_print`, `cancel_print`.
    - `slice_stl` is local CPU work, so it doesn't take the mutex.
  - **Fix: elicitation context per call.** `PrinterMcpClient.setElicitationContext` is per client today. With shared sessions, the confirmation context belongs to the mutating call in flight; the mutex guarantees there is only one. Reads never elicit.
  - **Why this matters for Bambu.** bambu-printer-mcp caches the printer's MQTT reports (`reportSnapshots`). On a held session, a progress read is served from that cache without any extra printer traffic.

### 8.4 The Counterpart tool contract (`counterpart/1`), added to both MCPs

Both MCPs gain the same small set of tools with the same arguments and results. Each tool declares an `outputSchema` and returns `structuredContent`, plus the same JSON as text for older clients. The companion validates results with zod.
- **Bambu tools** take the existing optional `host`, `bambu_serial` and `bambu_token` overrides.
- **Generic tools** take the existing optional `host`, `port`, `type` and `api_key` overrides.

| Tool | bambu-printer-mcp | mcp-3D-printer-server |
|---|---|---|
| `counterpart_printer_info` | new | new |
| `counterpart_print_progress` | new; wraps `getStatus` | new; per-firmware mapping below |
| `camera_snapshot` | existing | **new**, with the same arguments and result as Bambu's |
| `get_printer_filaments` | existing | **new**, single-slot result |
| `pause_print` / `resume_print` / `cancel_print` | existing | `cancel_print` exists; **add** pause and resume |
| `print_3mf` result | **add** `taskId` and `subtaskName` to the result. It already sends `task_id = submissionId` and `subtask_name` (`printers/bambu.ts:957-961`) but doesn't return them | `upload_gcode` / `start_print` result: **add** `jobName` (the remote file name) |

**`counterpart_printer_info` result:**
```ts
{ contract: "counterpart/1",
  server: { name: string, version: string },
  printer: { kind: "bambu"|"octoprint"|"klipper"|"prusa"|"duet"|"repetier"|"creality",
             model?: string, serial?: string, host: string, name?: string },
  capabilities: { progress: boolean, layers: boolean,
                  camera: "bambu-tcp"|"rtsp"|"http-snapshot"|"none",
                  filaments: "ams"|"single"|"none",
                  pause: boolean, resume: boolean, cancel: boolean, print3mf: boolean, gcode: boolean } }
```

**`counterpart_print_progress` result:**
```ts
{ contract: "counterpart/1",
  observedAt: string,            // when the printer reported this (MQTT report time / HTTP response time), ISO 8601
  state: "idle"|"preparing"|"printing"|"paused"|"finished"|"failed"|"cancelled"|"offline"|"busy",
  job?: { name: string, id?: string, progress?: number /* 0–100 */, elapsedSec?: number, remainingSec?: number,
          layer?: number, totalLayers?: number, stage?: string /* "Heating the bed", "Auto bed leveling", … */ },
  temps?: { nozzle?: {actual: number, target: number}, bed?: {actual: number, target: number}, chamber?: number },
  activeFilament?: { slot?: string, material?: string, color?: string /* #RRGGBB */ },
  problems: { code: string, severity: "fatal"|"error"|"warning"|"info", message: string, url?: string }[] }
```

**Per-firmware mapping for `counterpart_print_progress`.** Each row lists the request it makes and where each field comes from.

| Firmware | Request | state | progress / time | layers | problems |
|---|---|---|---|---|---|
| **Bambu** (MQTT report, cached) | none; reads the MCP's `reportSnapshots` | `gcode_state`: IDLE→idle, PREPARE/SLICING→preparing, RUNNING→printing, PAUSE→paused, FINISH→finished, FAILED→failed | `mc_percent`; `mc_remaining_time` is in **minutes**, so ×60 | `layer_num`, `total_layer_num` | `print_error` (non-zero, as 8-digit hex); each `hms[]` entry as `AAAA_BBBB_CCCC_DDDD` from `attr`/`code`. Messages come from Bambu's published HMS table, bundled in the MCP; `url` points to Bambu's page for that code. `stg_cur` maps to `job.stage` through the MCP's stage table |
| **OctoPrint** | `GET /api/job`, plus `GET /api/printer` for temperatures | `state` text: Printing→printing, Pausing/Paused→paused, Operational→idle (finished when the last job's `progress.completion` = 100), Error→failed, Offline→offline | `progress.completion`; `progress.printTime`; `progress.printTimeLeft` | not in core: omitted | `state.error` |
| **Klipper** (Moonraker) | `GET /printer/objects/query?print_stats&virtual_sdcard&display_status&extruder&heater_bed&webhooks` | `print_stats.state`: standby→idle, printing, paused, complete→finished, cancelled, error→failed; `webhooks.state` ≠ ready→busy | `display_status.progress` ×100 (falling back to `virtual_sdcard.progress`); `print_stats.print_duration`; remaining = file `estimated_time` (`GET /server/files/metadata?filename=`) − `print_duration` | `print_stats.info.current_layer` / `total_layer` (set when the slicer emits `SET_PRINT_STATS_INFO`; OrcaSlicer and PrusaSlicer do) | `print_stats.message`; `webhooks.state_message` |
| **PrusaLink** | `GET /api/v1/status` | `printer.state`: PRINTING, PAUSED, FINISHED, STOPPED→cancelled, ERROR→failed, ATTENTION→paused (with a problem), IDLE/READY→idle, BUSY→busy | `job.progress`; `job.time_printing`; `job.time_remaining` | omitted | ATTENTION/ERROR plus `GET /api/v1/job` details |
| **Duet** (RRF 3) | `GET /rr_model?key=state` and `GET /rr_model?key=job&flags=d99f` (standalone); `GET /machine/status` (SBC) | `state.status`: processing→printing, paused/pausing→paused, idle, busy | `job.filePosition` / `job.file.size`; `job.duration`; `job.timesLeft.slicer` (falling back to `.file`) | `job.layer`, `job.file.numLayers` | `state.messageBox`, `state.displayMessage` |
| **Repetier** | `GET /printer/api/<slug>?a=listPrinter&apikey=…` | `online`, `job`, `paused` | `done` (percent); time from `printTime` / `printedTimeComp` | omitted | none |
| **Creality** | K1/K2-series printers run Moonraker: use the Klipper row when port 7125 or 4408 answers. Otherwise use the existing `GET /api/device/status` | as the Klipper row, or from that endpoint | as above | as above | as above |

**`camera_snapshot` in mcp-3D-printer-server** returns the same result as Bambu's: `{ format: "jpeg", base64, savedTo? }`, plus `capturedAt`.
- **OctoPrint:** use the snapshot URL from `GET /api/settings`. That's `webcam.snapshotUrl` on OctoPrint ≤ 1.8, and `plugins.classicwebcam.snapshot` on 1.9+. Otherwise fall back to `http://host/webcam/?action=snapshot`.
- **Moonraker:** `GET /server/webcams/list`, then the first enabled webcam's `snapshot_url`, resolved against the host.
- **Repetier:** the printer config's `webcams[].staticUrl`.
- **PrusaLink and Duet:** there's no local snapshot API, so the camera is `none`.
- **Any firmware:** the `PRINTER_CAMERA_SNAPSHOT_URL` env variable overrides the source.

**`get_printer_filaments` in mcp-3D-printer-server** returns `{ slots: [{ id: "ext", material?, color?, name?, source: "spoolman"|"unknown" }] }`.
- **Moonraker with Spoolman:** `GET /server/spoolman/spool_id`, then `POST /server/spoolman/proxy` with `{request_method:"GET", path:"/v1/spool/<id>"}` for the material and colour.
- **Everything else:** `unknown`. The print sheet then asks "What's loaded?", with material chips, defaulting to the slicer profile's material.

**Pause and resume in mcp-3D-printer-server:**
- **OctoPrint:** `POST /api/job` with `{command:"pause", action:"pause"|"resume"}`.
- **Moonraker:** `POST /printer/print/pause` and `/resume`.
- **PrusaLink:** `PUT /api/v1/job/<id>/pause` and `/resume`.
- **Duet:** `GET /rr_gcode?gcode=M25` to pause, `M24` to resume.
- **Repetier:** `GET /printer/api/<slug>?a=send&data={"cmd":"@pause"}`.

**Verification.** Each mapping row is verified against a live device or the firmware's own API docs before its PR merges. These four need particular care:
- OctoPrint 1.9's webcam settings path;
- Repetier's time fields;
- Duet's `flags`;
- Creality's ports.

Each change follows the MCP repo's own AGENTS.md and release process.

**Older MCP installs.** If `counterpart_print_progress` is missing, the monitor falls back to `get_printer_status`:
- **Bambu.** Read `print.progress`, `print.timeRemaining` (in **minutes**), `print.currentLayer`, `print.totalLayers`, `raw.gcode_state`, `raw.hms` and `raw.print_error`.
  - **Fix:** `objects/service.ts:154` reads `print.remaining`, which bambu-printer-mcp never returns. That's why "time left" is always empty today.
- **mcp-3D-printer-server.** Its `get_printer_status` returns the firmware's raw printer endpoint (OctoPrint `/api/printer`, Moonraker `/printer/info`), which has no job progress. On those installs, the app shows only the state and asks the user to update the MCP.

### 8.5 Printing a project (dispatch)

- **Existing.** `PrintRunner.runBundle` runs `lay_flat` → `slice_stl` → `inspect_print_file` → `camera_snapshot` → `print_3mf` (Bambu). For other printers it runs `slice_stl` → `upload_gcode`/`start_print`.
  - It reports preparation phases: connecting, slicing, slice-ready (with the estimate from `sliceEstimate`), checking the printer, and requesting the print.
  - It relays the MCP's own print confirmation (elicitation) to the phone and the Mac. `DispatchedPrintError` and the "uncertain" result are handled.
- **New: the print settings from the print sheet (§5.5) are carried into the run.**
  - **Destination:** `objects.selectPrinter` (existing).
  - **Quality and strength** map to the slicer through the MCP's own options:
    - layer height Draft 0.28 / Standard 0.20 / Fine 0.12 mm;
    - walls and infill Standard 2/15%, Strong 4/25%, Max 6/40%.

    They go in through `slice_stl`'s existing settings arguments or `slice_with_template`, whichever the installed MCP exposes. Detect which from its tool schema, as `print.ts` already does for its other optional arguments.
  - **Colour map:**
    - Bambu: `ams_mapping` / `ams_slots`, or `auto_match_ams` when the user didn't change it.
    - Generic: the material chosen for the single slot.
- **Plate check (existing, extended).**
  - Before `print_3mf`, the companion takes `camera_snapshot`, and `judgePlate` (`objects/bedcheck.ts`) asks the user's own Claude.
  - **Clear:** nothing is shown and the run continues.
  - **Not clear:** emit `plate.blocked` with the frame and the item. **Look again** retakes the photo and judges again. **It's clear** continues, and appends a note for that printer to a per-printer list ("the white piece at the back left is part of the printer"). That list is added to the judge's prompt next time.
  - **Printers whose capability is `camera: "none"`** skip the camera check. The MCP's own confirmation is still what the user answers.
- **Fix: "printed" now means printed.** On `print_3mf`/`start_print` success, the object goes to `printing` with `print.printId` (a new uuid), `destinationId`, `dispatchedAt`, `jobName`, `taskId?` and the slice `estimate`. Today it goes straight to `printed`. The monitor (§8.6) sets `printed` when the matching job finishes.

### 8.6 The print monitor (new: `services/companion/src/printing/monitor.ts`)

One monitor runs per active print. It holds the destination's session (§8.3) until the print ends.

**Matching the job.** A report belongs to our print when either of these holds:
- **Bambu:** `job.id` equals the `taskId` that `print_3mf` returned. Fall back to `job.name` = `subtaskName`.
- **Generic:** `job.name` equals the uploaded `jobName`.

If a different job is running, the monitor marks ours `replaced` and stops; it never reports someone else's print as ours.

**Phase 1: confirming the start.**
- Poll `counterpart_print_progress` every 3 s for up to 180 s.
- The first matching `preparing` or `printing` report emits **`print.started`**, with `job.stage` as the words ("Heating the bed", "Auto bed leveling").
- If neither appears, emit **`print.not-started`**: "*Printer* didn't start *title*. Nothing was sent twice."
  - This replaces today's ambiguous "the printer may have started this print" with an answer from evidence.

**Phase 2: watching.**
- Poll every 10 s.
- Emit `print.status` (no banner) only when something changes:
  - progress changes by at least 1 point;
  - state, layer or problems change;
  - or 60 s have passed since the last one.

**Events from the matching job:**

| Condition | Event | Frame | Words |
|---|---|---|---|
| layer ≥ 2 for the first time (or 5% progress when layers aren't reported) | `print.first-layer` | yes | "*Title*: first layer's down" · "*remaining* left on *printer*" |
| progress crosses each chosen milestone; default **50** | `print.milestone` | yes | "*Title* is halfway" · "*remaining* left · layer *l* of *L* · *printer*" |
| state → paused | `print.paused` | yes | "*Printer* paused *title*" · problem message ("AMS slot 1 ran out of filament") |
| paused → printing | `print.resumed` | no | updates the Live Activity only |
| state → finished | `print.done` | yes | "*Title* is done" · "Take it off the plate." |
| state → failed | `print.failed` | yes | "*Printer* stopped *title*" · problem message |
| state → cancelled | `print.cancelled` | no | "*Title* was cancelled" |
| 3 failed calls in a row, or `offline` for ≥ 60 s | `print.unreachable` | no | "Lost contact with *printer*. Still trying." Never shown as a failure. The monitor keeps polling every 30 s and goes back to 10 s on recovery |

**Milestone settings.** Off, 50% (the default), 25/50/75%, or every 10%.

**Durability.**
- The monitor's state lives in the object's `print.monitor`: phase, last report, `milestonesSent[]`, `firstLayerSent`, end state and end time.
- On a companion restart, every object whose monitor is in `starting` or `watching` resumes, with milestones already in `milestonesSent` skipped.
- If the Mac slept through part of a print, it doesn't back-fill missed milestones. It does deliver the terminal state.

**Frames.**
- A frame is taken only for events that carry one, never on every poll.
- `camera_snapshot` gets `timeout_ms: 8000`.
- The event never waits more than 10 s for its frame. If the camera is busy or slow, the event goes without it.
- Files: `objects/<id>/prints/<printId>/frames/<eventId>.jpg`.

**The Printing screen's camera.**
- `GET /v1/objects/<id>/camera.jpg` (new) calls `camera_snapshot` through the session, with a shared 3 s cache so several viewers don't hit the camera more than once.
- The screen refreshes it every 3 s and shows "Updated *n* s ago". It's labelled honestly as a refreshing photo, not video.
- RTSP printers (X1, P2S, H2, X2D) need ffmpeg, which the Mac app downloads on demand (journey.md §3.3).

**Controls.**
- Pause, Resume and Stop go through the session mutex as `pause_print`, `resume_print` and `cancel_print`.
- Stop asks for confirmation in the app.
- The printer MCP's own confirmation, if it asks one, is relayed as usual.

### 8.7 The event log (new: `services/companion/src/events/`)

Every user-visible change becomes one event.
- Events are appended to `~/Library/Application Support/Scan to Make/events.ndjson`, with a monotonic `seq`, and kept for 7 days.
- All notification wording is written by one function, `events/words.ts`, so the Mac, the phone, the Lock Screen and the menu bar say the same thing.

```ts
type CounterpartEvent = {
  v: 1; seq: number; id: string /* uuid */; at: string /* ISO */;
  type: "pass.started"|"pass.stage"|"pass.ready"|"pass.ask"|"pass.failed"
      | "print.preparing"|"plate.blocked"|"print.confirm"|"print.started"|"print.status"|"print.first-layer"
      | "print.milestone"|"print.paused"|"print.resumed"|"print.done"|"print.failed"|"print.cancelled"
      | "print.not-started"|"print.unreachable";
  projectId: string; printId?: string; destinationId?: string; printerName?: string;
  title: string; body: string;
  notify: "none"|"passive"|"active"|"timeSensitive";
  data?: { progress?: number; remainingSec?: number; endsAt?: string; layer?: number; totalLayers?: number;
           state?: string; stage?: string; problems?: {code: string; message: string}[];
           estimateSec?: number; grams?: number; askId?: string; confirmationId?: string; expiresAt?: string };
  frame?: string; // path relative to the project directory
};
```

- **Where touch-up events come from.** The pass runner (`touchup/`) already streams worker messages; stage changes and the result become `pass.*` events.
  - `pass.ask` is emitted when a pass ends needing a close-up (existing `answerCloseup` flow).
  - `print.confirm` is emitted when an MCP elicitation is pending (existing relay), with its `expiresAt`.

**Readers:**
- **Phone, on the LAN or a VPN:** `GET /v1/events?after=<seq>&wait=25` (new). It's a long poll that uses the existing `objects:read` scope and returns `{events, next}`. Frames come from `GET /v1/objects/<id>/prints/<printId>/frames/<eventId>.jpg`.
- **Mac app:** the new control method `events.wait {after: number, timeoutMs ≤ 25000}` returns the same payload. Frames are read straight from disk, at the path the event gives.

### 8.8 Delivery: Mac, CloudKit, and the Live Activity relay

**Mac app `EventRelay` (new, Swift).** It loops on `events.wait` and persists its cursor. After a restart it doesn't notify for events older than 10 minutes; it only syncs them.

For every event with `notify ≠ none`:
1. **A Mac notification** (`UNUserNotificationCenter`), according to Settings. By default it notifies for `pass.ready`, `pass.ask`, `plate.blocked`, `print.done`, `print.failed`, `print.paused` and `print.not-started`; progress events are off by default on the Mac.
2. **CloudKit.** Save a `CounterpartEvent` record in the custom zone `Counterpart` of the private database, in container `iCloud.com.scantomake.counterpart`.
   - Fields: `eventId`, `seq`, `type`, `projectId`, `printId`, `title`, `body`, `notify`, `progress`, `remainingSec`, `createdAt`, and `frame` (a `CKAsset`: a JPEG at most 1280 px on the long edge and about 300 KB, made with ImageIO).
   - A daily sweep deletes records older than 7 days.

**For every event, including `print.status`:**
- Upsert `CounterpartProject {projectId, title, state, stateText, thumbnail (CKAsset, only when it changes), updatedAt, openAsk?, print?{printId, printerName, state, progress, remainingSec, endsAt}}`.
- Print upserts are capped at one per 60 s per print, except on state changes.
- This record is the off-LAN mirror the phone reads (§12).

**Live Activity relay** (new: a Cloudflare Worker at `https://counterpart.dtmont.com/relay/v1`).
- **Why it's needed.** A Live Activity updates on the Lock Screen only from the app itself or from an APNs push signed with the team's key. Apple says that key "must remain private", so it can't ship in the Mac app.
- **Cost.** The Worker holds only that key (secrets `APNS_KEY_P8`, `APNS_KEY_ID`, `TEAM_ID = X7F5F9LR24`) and stores nothing. It fits Cloudflare's free tier.
- **The one manual step:** the owner creates the APNs key in the developer portal.
- **Phone → Mac:**
  - The phone sends its push-to-start token (`Activity<PrintAttributes>.pushToStartTokenUpdates`) and each activity's update token (`activity.pushTokenUpdates`) to the Mac. On the LAN they go through `POST /v1/devices/live-activity-tokens` (new); otherwise through a `CounterpartDevice` CloudKit record.
  - Tokens never go to the Worker except inside a push request.
- **Mac → Worker:** `POST /relay/v1/live-activity` with `{token, kind: "start"|"update"|"end", attributes?, contentState, staleDate, priority, alert?}`.
  - The request is signed with a per-install key registered on first use.
  - The Worker validates the payload against the `PrintAttributes` schema, limits each install to one update every 10 s per activity and 2,000 a day, and rejects anything else. It is not a general push relay.
- **Worker → APNs:** HTTP/2 to `api.push.apple.com`, with these headers:
  - `apns-push-type: liveactivity`;
  - `apns-topic: com.scantomake.push-type.liveactivity`;
  - `apns-priority`: 5 for progress, 10 for start, paused, done and failed.

  The body is `{"aps": {"timestamp", "event": "start"|"update"|"end", "content-state", "stale-date", "attributes-type": "PrintAttributes", "attributes", "alert", "dismissal-date"}}`. The app sets `NSSupportsLiveActivitiesFrequentUpdates = YES`.
- **When the Mac sends:**
  - `start` on `print.started` (push-to-start, so it appears even if the phone app isn't open);
  - `update` on each `print.status`, `print.paused` and `print.resumed`;
  - `end` on done, failed or cancelled, with a `dismissal-date` 4 hours later.
- **Without the relay** (no key yet, or the Worker is unreachable):
  - The phone starts the activity itself when the user taps Print, or the next time the app opens during a print.
  - It updates the activity whenever it gets time: in the foreground, on CloudKit content-available pushes, and on `BGAppRefreshTask`.
  - In both modes the activity renders with `Text(timerInterval:)` and `ProgressView(timerInterval:countsDown:)` up to `endsAt`, so it keeps counting between updates. `staleDate = endsAt + 10 min` shows "Checking…" if nothing has arrived.

## 9. Notifications and Live Activities

Neither app has any notifications today (audit P6, M5). Events come from §8.7 and travel by the routes in §8.8.

### 9.1 What the user gets

| Event | iPhone notification | Actions | Level | Mac |
|---|---|---|---|---|
| `pass.ready` | "*Title* is ready to print" · size and estimate, with a render | **Print** (opens the print sheet), **Ask for Changes…** (text input, sent in the background) | active | on |
| `pass.ask` | "*Title*: *the question*", with the region picture | **Camera** (opens it), **Best Guess** (background) | active | on |
| `plate.blocked` | "Something's on the *printer* plate", with the frame | **Look Again**, **It's Clear** (both background) | time-sensitive | on |
| `print.confirm` | "*Printer* needs a yes before printing *title*" | opens the confirmation | time-sensitive | on |
| `print.started` | no banner; the Live Activity starts | — | passive | off |
| `print.first-layer` | "*Title*: first layer's down", with the frame | **Open**, **Pause** | passive | off |
| `print.milestone` | "*Title* is halfway" · time left, layer, printer, with the frame | **Open**, **Pause** | active | off |
| `print.paused` | "*Printer* paused *title*" · reason, with the frame | **Open**, **Resume** | time-sensitive | on |
| `print.done` | "*Title* is done. Take it off the plate.", with the frame | **Open** | active | on |
| `print.failed` / `print.not-started` / `pass.failed` | what happened and what to do | **Open** / **Try Again** | time-sensitive (print) / active (pass) | on |
| `print.unreachable` | "Lost contact with *printer*. Still trying." | — | passive | off |

Each row has its own switch in Settings → Notifications, on both devices. The milestone choice is in the same place (§8.6).

### 9.2 iPhone: subscriptions, extension and actions

**Subscriptions.** The phone creates these once, with fixed IDs so it's idempotent: `CKQuerySubscription`s on `CounterpartEvent`, in the private database, `firesOnRecordCreation`. There is one per category, because a subscription carries one category:

| ID | Predicate (`type`) | Category |
|---|---|---|
| `ev-ready` | `pass.ready` | `READY` |
| `ev-ask` | `pass.ask` | `ASK` |
| `ev-plate` | `plate.blocked` | `PLATE` |
| `ev-confirm` | `print.confirm` | `CONFIRM` |
| `ev-progress` | `print.first-layer`, `print.milestone` | `PROGRESS` |
| `ev-done` | `print.done` | `DONE` |
| `ev-problem` | `print.paused`, `print.failed`, `print.not-started`, `pass.failed`, `print.unreachable` | `PROBLEM` |
| `proj-silent` | updates to `CounterpartProject` | content-available only; refreshes Home and the Live Activity |

**Each visible subscription's `NotificationInfo`:**
- `titleLocalizationKey = "%1$@"`, `titleLocalizationArgs = ["title"]`;
- `alertLocalizationKey = "%1$@"`, `alertLocalizationArgs = ["body"]`;
- `category` from the table above;
- `soundName = "default"`;
- `shouldSendMutableContent = true`, `shouldSendContentAvailable = true`;
- `desiredKeys = ["eventId", "projectId", "printId", "type", "notify", "progress", "remainingSec"]`;
- `collapseIDKey = "printId"` on `ev-progress` only, so a later milestone replaces the earlier one.

The app's `Localizable.strings` maps `"%1$@" = "%1$@";`.

**Notification Service Extension** (new target):
1. Reads the `CKQueryNotification` and fetches the record with its `frame` asset.
2. Attaches the frame as a `UNNotificationAttachment`.
3. Sets `interruptionLevel` from `notify`. Time-sensitive uses the `com.apple.developer.usernotifications.time-sensitive` entitlement.
4. Sets `threadIdentifier = projectId` and a `relevanceScore`.

If the fetch runs past the extension's time limit, the notification is delivered without the image.

**Actions:**
- Background actions without a destructive outcome run without opening the app: **Ask for Changes…** (`UNTextInputNotificationAction`), **Best Guess**, **Look Again**, **It's Clear**, **Pause** and **Resume**.
- Each one sends its command to the Mac:
  - directly on the LAN, through the existing routes: `POST …/corrections`, `…/closeup`, `…/plate`; pause and resume go through the new `POST …/print/pause` and `…/print/resume`;
  - otherwise as a `CounterpartCommand` record (§9.3).
- **Print** and **Camera** open the app at the right screen.

**No double banners.**
- In the foreground, `userNotificationCenter(_:willPresent:)` suppresses events the app already showed from its LAN long poll, matched by `eventId`.
- The in-app UI then shows the change instead.

### 9.3 Commands from anywhere (CloudKit)

- **How a command travels.** When the phone can't reach the Mac directly, it writes a `CounterpartCommand` record into the same private zone:
  - `{commandId, type, projectId, payload, photos[CKAsset], createdAt}`, where `type` is one of `print | correct | answerAsk | plate | confirm | pause | resume | cancel`.
- **How the Mac receives it.** The Mac app subscribes to that record type (content-available) and also fetches on launch and on wake.
  - It runs each command through the control socket method that already does the same job: `objects.print`, `objects.correct`, `objects.answerCloseup`, `objects.answerPlate`, `objects.answerPrintConfirmation`, plus the new pause, resume and cancel.
  - It writes the result back as `status: done|failed` with a message, and deletes the record a day later.
- **Commands are bounded.** The Mac acts only on commands from its own private database that are less than 10 minutes old.
- **The print confirmation is unchanged.** Starting a physical print still answers the printer MCP's own confirmation:
  1. it arrives on the phone as `print.confirm`;
  2. the user's answer goes back as a `confirm` command.

### 9.4 Live Activity

`PrintAttributes {projectId, printId, title, printerName}`; content state `{state, progress, layer, totalLayers, endsAt, stage, problem?}`.

| Presentation | Content |
|---|---|
| **Lock Screen** | title, a progress bar running on its own toward `endsAt`, minutes left, "*printer* · layer *l*/*L*", and **Pause** and **Camera** buttons (`LiveActivityIntent`) |
| **Dynamic Island, compact** | a ring and minutes left |
| **Dynamic Island, minimal and limited-width** | the ring (iOS 27 adds limited-width layouts for landscape) |
| **Dynamic Island, expanded** | the Lock Screen layout plus the stage text |

- It also appears automatically in StandBy, on the Watch Smart Stack, in CarPlay and in the Mac menu bar.
- Starting and updating it follow §8.8: through the relay when there's an APNs key, and from the phone itself otherwise.

### 9.5 Widgets and system surfaces

- **Widgets:**
  - **Now printing:** small and medium sizes, plus Lock Screen circular and rectangular;
  - **Needs you:** small.

  They read the `CounterpartProject` mirror through an App Group cache, which the app and the extension refresh.
- **Control Center control and Action button:** "New Scan" opens the walk-around capture.
- **App Intents and Siri:**
  - "Scan something with Counterpart";
  - "What's printing?", answered from the mirror;
  - "Print *project*", which opens the print sheet.

  App Shortcuts adopt the iOS 27 app schemas where they fit.
- **Spotlight:** projects are indexed (`IndexedEntity`).
- **Share extension:** photos or a product web page shared from Photos or Safari open New with them attached.

## 10. Visual system

- **Accent:** one warm "filament orange", used only for the primary action, selection and Ready. Status colours are fixed: blue for working, orange for needs you, green for printing, red for failed. Each is always paired with a symbol and words.
- **Surfaces:**
  - Content (models, camera, photos) sits on a near-black stage.
  - Controls are system Liquid Glass, with `GlassEffectContainer` for groups that morph together.
  - Glass is tinted only to carry state: orange tint on Ask cards, blue on working.
  - The user's iOS 27 clear-to-tinted glass slider is respected; no custom blur.
- **Type:** system SF; large titles for project names; monospaced digits for size, time and percent.
- **Motion:** stage pulses with `symbolEffect`; glass morphs between Print → Preparing → Printing. Reduce Motion is honoured.
- **Haptics:** success when a result is ready and the app is open, and a warning on a plate alert. No other haptics.
- **App icon:** two interlocking pieces, an object and its counterpart, built in Icon Composer 2 as a layered Liquid Glass icon for iPhone, iPad and Mac. The placeholder is in the mockups.

## 11. Scan in hand

The full research is in [research/inhand-capture.md](research/inhand-capture.md).

- **Placement.** A separate mode, "Scan in hand", for small objects. It is also offered after a walk-around as **Get the underside**. The walk-around module is not changed.
- **Capture: stills, not video.**
  - Use `AVCapturePhotoOutput` on `builtInLiDARDepthCamera` (the rear camera, asserted at start), with depth delivery on and unfiltered.
  - It fires automatically at 2–3 frames/s while the object turns.
- **Exposure: blur is a shutter problem, not a speed-of-turning problem.**
  - Meter, then set a custom exposure: 1/500 s preferred, 1/250 s at the slowest, with ISO up to the format's maximum. Use `photoQualityPrioritization = .speed` so the custom exposure is honoured.
  - If the light can't support 1/250 s, fall back to 1/125 s bursts and keep the sharpest frame for each angle, by Laplacian variance inside the mask.
  - The app never tells the user to "move slowly". It says "More light gives a sharper scan" when that's the problem.
- **Framing.** The object must fill at least about 15% of the frame, within valid LiDAR range. Otherwise the app says "Bring it closer".
- **Masking.** Foreground instance mask, minus the person/hand masks (dilated around the hand-pose joints), within the object's depth band. Frames with empty or erratic masks are rejected live.
- **Coverage without flipping:**
  - three grips: top and bottom, then the sides, then tilting toward and away;
  - one ring per grip, filled by the estimated rotation;
  - a new still about every 8–12° of rotation;
  - 60–120 stills in all.
- **Mac reconstruction.** `PhotogrammetrySession` with custom samples: image, depth, object mask, no gravity, object masking on, sequential ordering, high feature sensitivity. Its stderr and per-sample errors are kept and shown in words.
- **Pass criteria (on the device).** For a matte reference print with caliper-measured dimensions, all of these must hold:
  - every still has a shutter of 1/250 s or faster, nonzero ISO, and depth;
  - no hand geometry appears in the mesh;
  - every bounding-box axis is within ±1.0 mm or ±1.5% of the caliper measurement, whichever is larger;
  - the underside is closed;
  - two scans agree within 1%.

## 12. Sync and data

- **The Mac is the source of truth.** Projects, inputs, passes and results live in the companion's store, as today.
- **On the home network or a VPN,** the phone talks to the companion over the existing pairing (pinned key, addresses in order; journey.md §3.4).
- **Away from home,** the Mac mirrors a project summary to the user's private CloudKit database: title, state, render thumbnail, the open Ask, and print progress.
  - The phone can then show Home, answer an Ask with photos (uploaded as `CKAsset`, collected by the Mac) and see prints from anywhere.
  - This needs no VPN and no server.
  - Full meshes are fetched only on the LAN or VPN.
- **Privacy.** Everything stays in the user's own iCloud and on their own Mac. Counterpart has no account system. Its only server is the stateless Live Activity relay (§8.8), which stores nothing.

## 13. Build plan

Each milestone ends in an on-device check with screenshots compared against `screens/`, and a VoiceOver pass on the new screens.

| # | Milestone | Done when |
|---|---|---|
| M0 | **Foundation.** `CounterpartKit` package; pure-SwiftUI iPhone app shell; pairing ported out of React Native; React Native removed. | The app pairs by QR and by the nearby card on a real iPhone, and the app bundle no longer contains React Native |
| M1 | **Back end and notifications.** All of the following:<br>• fixes: `remaining` → `timeRemaining`, "printed" set only on finish, catalog de-duplication, Codex `config.toml` source<br>• `PrinterSessionPool`<br>• `counterpart_printer_info` and `counterpart_print_progress`, plus `taskId` in the `print_3mf` result, in bambu-printer-mcp<br>• print monitor<br>• event log, `GET /v1/events` and `events.wait`<br>• Mac `EventRelay` (Mac notifications and CloudKit)<br>• iPhone subscriptions, Notification Service Extension and background actions<br>• structured `pass.*` events, with a generated title and a what-changed summary | On a real P1S print, all of these hold:<br>• with the phone locked and on cellular, the halfway notification arrives with a camera frame, and so does "done"<br>• restarting the companion mid-print sends no duplicate milestone<br>• a print that never starts produces `print.not-started` within 3 min<br>• replying to a "ready" notification from the Lock Screen starts a new pass |
| M2 | **iPhone core.** Home, New, Project (all states), Ask card, Settings and About. | Each screen matches its mockup on iPhone 18 Pro, iPhone 17e, Duo closed and iPad |
| M3 | **Print and Live Activity.**<br>• print sheet (printers from both MCPs, slice estimate, colour map, quality, strength)<br>• plate check with the alert and per-printer notes<br>• Printing screen with the camera<br>• pause, resume and stop<br>• Live Activity, with the relay Worker once the APNs key exists<br>• the Counterpart tools, `camera_snapshot`, `get_printer_filaments`, pause and resume in mcp-3D-printer-server<br>• `CounterpartCommand` for use away from home | All of these hold:<br>• a real P1S print from the phone shows the Live Activity on the Lock Screen and the Mac menu bar, counting down<br>• a deliberate plate obstruction is caught and cleared with Look Again<br>• a full run on OctoPrint's virtual printer and a Klipper simulator through mcp-3D-printer-server delivers progress, the halfway notification and done<br>• Pause from the Lock Screen pauses the P1S |
| M4 | **Mac rebuild.** SwiftUI scenes, main window, inspector, print sheet, popover, Settings with de-duplicated devices, drop-to-create. | The same project is visible and actionable on the Mac and the phone at once, and re-pairing a phone leaves one row |
| M5 | **Scan in hand.** As specified in §11. | The §11 pass criteria are met on a real iPhone |
| M6 | **System surfaces.** Widgets, Control Center control, App Intents and Siri, Spotlight, Share extension, iPad keyboard shortcuts. | Each one is demonstrated on a device |

**Reuse, don't rebuild:**
- The `feat/counterpart-project-workspace` branch already has, in the companion: printer listing across MCPs (`objects/printers.ts`), live filament inventory, retained activity, stable device identity, and the external-editor actions on the Mac. M1–M4 build on those endpoints.
- Printing, slicing, orientation, plate checks and print confirmation stay in bambu-printer-mcp and mcp-3D-printer-server. Every PR that touches them names the MCP tool it uses.

## 14. Open questions and the one manual step

1. **Distribution.** TestFlight first for the iPhone app, and Developer ID with Sparkle for the Mac (journey.md §3.2)? Or App Store for both from the start?
2. **Manual step (not a decision): the APNs key.** The owner creates an APNs auth key in the Apple developer portal and puts it in the Worker's secrets. The Live Activity relay (§8.8) needs it. Everything else in M1 works without it, including notifications with frames.
