# Counterpart 2: product requirements for iPhone, iPad and Mac

**Platforms:** iOS 27.2 and iPadOS 27.2 (minimum 27.0), including iPhone Duo; macOS 27. Also a native Android app (Android 8+, `android/`, §16) and a Linux desktop (Ubuntu 26.04 x86_64, `apps/linux`, §17).
**Status:** working PRD. It describes the code on `main` (checked at `4baf0cd8`, 2026-11-04), not a plan. Fix it in place in the same PR that changes the behaviour. Each section has a status line using these words:
- **Built**: on main, with engineering checks only (tests, scripts, simulators);
- **Accepted on device (date)**: David pressed the buttons in the installed app, and the printer's own reports agreed;
- **Not accepted**: what is still missing or open.

Section 0 lists them all. Who is working on what, and which builds are installed: [`../../status/handoff.md`](../../status/handoff.md).
**Replaces:** the screen specs in [`../journey.md`](../journey.md) §5–§9. journey.md's decisions on pairing (§3.4), the companion and its payload (§3.2–3.3) and model sign-in (§3.6) still stand unless this document changes them.

**Read with:**
- [audit.md](audit.md): why this rebuild is needed;
- [`screens/`](screens/): the mockups, rendered as real SwiftUI with real Liquid Glass on iOS 27.2 and macOS 27 simulators and devices;
- [`mockup-app/`](mockup-app/): the source of those mockups;
- [`research/`](research/): Apple design research and the in-hand capture research, both with sources.

---

## 0. Status at a glance

Checked against `main` at `4baf0cd8` on 2026-11-04. This replaces `docs/status/asks.md` and `docs/status/app-review-2026-11-02.md`; git history keeps both.

| Area | Status | Still open |
|---|---|---|
| One native iPhone/iPad app, no React Native (§3) | Built; installed 2.0 (202611050845, main `0c967a58`) | — |
| Mac app (§7) | Built; installed 202611050844 (main `0c967a58`) | full mockup parity; background memory budget remains open (Nov 5 measurements in §9.6) |
| Pairing: QR, nearby code (§5.10) | Built; in daily use on Davica3 | — |
| Automatic iCloud pairing (§5.10) | Built | Not accepted: fresh same-account enrolment |
| Home, search, title, grid, no fake controls (§5.1) | Built; Home checked on device Nov 2–3. Search stays above its filtered list and says how many projects match with Show All on Mac (#326), Android, iPhone/iPad and Linux (#329) | New search behavior: installed-app verification pending; stays connected for an hour (never "Mac isn't answering") |
| Starter projects (§5.11) | Built on iPhone, iPad, Mac, Android, Linux; reachable with projects on every layout (§6.1) | Not accepted; rig original import and physical prints |
| Scanning: walk-around, in hand, rig (§5.3, §11) | Built; a physical iPhone scan → Mac cleanup → model observed Nov 4 (Leatherman Wave+) | Not accepted: geometry, dimensions, print fitness; in-hand recorder defects (§11) |
| Project page, rename, Project Settings, Done/Works (§5.4) | Built; Done/Works checked on both Nov 2–3 | rename and settings acceptance partial; Compare versions not built (§18) |
| Conversation bubbles; "DONE" marks Done without a pass (§5.4.1) | Built | Not accepted |
| Change request reliability | Built: unavailable completion checks log the failure and return a visible sentence; the message stays saved without starting a pass | Not accepted in the installed app |
| Print sheet: printer, estimate, quality, strength (§5.5) | Built; prints from the Mac app's Print button Nov 3 | — · slice estimate: from the MCP's `inspect_print_file` (§8.0 item 9) |
| What will print: the sheet shows the printer MCP's pictures of the exact sliced file, and Print sends only that file (§5.5; David, Nov 5) | Built on Mac and iPhone (#321), Android and Linux (#324); drawn by bambu-printer-mcp 1.1.60+ / mcp-3d-printer-server 1.2.34 (`inspect_print_file` `include_preview`). **Seen in the Mac app Nov 5** (202611050844, caliper card `1f1c5515`): "What will print" shows *Top, as it sits on the bed* and *Bed side, turned over toward you*, and **Print on Bambu Lab P1S** is enabled once they load (not pressed). Screenshot: `~/scan-to-make-work/mac-202611050844/print-sheet-what-will-print.png` | Not accepted: a print from the sheet; the iPhone sheet on device; Android API 35 emulator paired with Mac Nov 5: caliper `1f1c5515` Print sheet displayed both MCP pictures, 1 h 10 m / 14 g / 15 layers; Print enabled, not pressed. Screenshot: `~/scan-to-make-work/android-linux-20261105/android-caliper-print.png`. Linux Nov 5: added P1S through Settings, imported Mac caliper 3MF into local project `1b7a26a2`, installed Bambu Studio 02.09.01.70 and configured the MCP’s slicer/profile paths; both MCP pictures displayed, 1 h 11 min / 14.4 g / 15 layers, Print enabled and not pressed. Screenshot: `~/scan-to-make-work/android-linux-20261105/linux-caliper-preview-enabled.png` |
| Per-part AMS colours for a multi-colour 3MF (§5.5, §8.5) | Built on Mac (#293) and iPhone (`5864c56`) | **Accepted on device Nov 4** (iPhone + P1S, David: "Yes, both colours are correct") · nearest-spool matching: *In the app today; moves to the MCPs (§8.0).* |
| A colour design from before colour parts asks before printing in one colour (§5.5) | Built (#306) | Not accepted |
| Copies, pause before a layer (§5.5) | Built; P1S paused itself before layer 3 on Nov 3 (Mac, pre-release MCP build) | Not accepted on the published MCPs; mcp-3D-printer-server parity not on npm · per-slicer rules for copies and supports: *In the app today; moves to the MCPs (§8.0).* |
| Plates of an imported 3MF; per-plate print and completion (§5.5) | Built | Not accepted · 3MF plate metadata parsing: *In the app today; moves to the MCPs (§8.0).* |
| Pause, Resume, Stop (§5.7) | Built; worked from the Mac UI over local FULU Nov 3 (hand-copied MCP code) | Not accepted on the published MCP; phone Stop |
| Bambu Cloud print route (§8.2) | Bambu refused cloud printing (-3120, HTTP 403) Nov 3. Fixed the way Bambu Studio sends it (`start_local_print_with_record` first), published in bambu-printer-mcp 1.1.55 and mcp-3d-printer-server 1.2.29 (#102, #56) | Not accepted: install through the app's Update, then a print with Connection = Bambu Cloud |
| FULU through mcp-3D-printer-server | — | **open bug**: crashes on its config-dir mount |
| Copy a designer's 3MF and change one thing (§8.5) | **Failed on the printer Nov 4** (caliper card `1f1c5515`, "use this caliper card exactly but add the counterpart logo"): pass 3 was given the merged STL, rebuilt a bare 3MF, lost the designer's print settings and painted markings (ticks and vernier scale missing); the MCP sliced it at preset values and Strong lowered 100% infill to 25%; the card doesn't fold. **Fixed and installed Nov 5:** every pass edits the designer's 3MF, and a pass whose result's `get_slice_settings` differs from the designer's file is refused (#318, Mac 202611050554). Both MCPs slice a 3MF with its own process and make strength a floor (bambu-printer-mcp 1.1.59, installed through the app's Update; mcp-3d-printer-server 1.2.33 published) | Not accepted until David redoes the card in the app and prints it · slot 2 held yellow where the design said white (colour mapping, owner's §8.0 item) |
| Print a published model (§8.11) | Built; MakerWorld caliper import + real P1S estimate observed | Not accepted: print, browser download path · 3MF/G-code metadata parsing: *In the app today; moves to the MCPs (§8.0).* |
| Notifications (§9.1) | Built; OS permission on | Not accepted: delivery of each event type |
| Live Activity (§9.4) | Built; Sandbox relay test start/update/end seen on the Lock Screen | Not accepted: real print, Watch, production push |
| Printer camera (§8.6.1) | Built; 12 reads in 23 s, ≤ 8.4 KB, 0 errors | sustained acceptance |
| Settings on both, the same (§5.9) | Built; keep-awake toggled from the phone changed the Mac. **Seen on device Nov 4** (David, iPhone build 202611041132): Settings shows Connected while the Mac is reachable. The brief "Checking…" state before the first answer (`b845a545`) is covered by the engineering test, not a device check | — |
| Update both MCPs from either app (§8.10) | Built; bambu-printer-mcp 1.1.61 installed through Settings → Update on the Mac and on Linux Nov 5; on Linux, mcp-3d-printer-server 1.2.34 too (Update of the app's own copy with no printer, #320) | from the phone; the Mac's mcp-3D is still a hand-built checkout |
| AI provider routing (§7.5) | Built: Claude Code, Codex CLI, Anthropic/OpenAI API, OpenAI-compatible endpoint, Off | real Claude cleanup observed Nov 4; OpenCode not supported yet |
| Design passes plan how the object prints (FDM prompt pack, `docs/design/fdm-prompt-pack`) | Published in bambu-printer-mcp 1.1.52 / mcp-3D-printer-server 1.2.26 (#99, #52) | Not accepted |
| One app named Counterpart, one icon (§10) | Built; `/Applications/Counterpart.app` is the only registration for `com.scantomake.mac` | — |
| Fusion design engine (§8.9) | Built; a private real-worker pass made a parametric cube | Not accepted · Fusion add-in install (`FusionSetup.swift`): *In the app today; moves to the MCPs (§8.0).* |
| Help, docs site, credits (§5.9, §15) | Built; Help opens counterpart.dtmont.com/help.html on both | — |
| No plate checks anywhere (§5.6) | Built in the app and both MCPs | — |
| Finding and adding printers (§5.8) | Built: SSDP discovery, the Bambu DevModel/serial→model table, Add Printer's brand list | discovery, model table and brand list: *In the app today; moves to the MCPs (§8.0).* |
| Blender add-on install and repair (§8.9) | Built (`touchup/addon-installer.ts`, `addon-repair.ts`) | *In the app today; moves to the MCPs (§8.0).* |
| Remote MCP `/v1/mcp` (§8.12) | Built; tool scopes and argument kinds come from the MCPs (§8.0 item 5) | Not accepted |
| Android app (§16) | Debug APK from clean main `1b66d937`, run Nov 5 on T3 API 35 emulator after KVM permission repair: Mac pairing, project list (after relaunch), caliper `1f1c5515` Print sheet and both MCP pictures observed; Print enabled, not pressed | Main `745e9b9f` rechecked Nov 5: fresh pairing still left Home loading (including a further 15-second wait) until relaunch; welcome headings remained black on dark backgrounds. Search showed “2 of 10 projects match” for “caliper”; Show All cleared the query and restored the list; the field stayed pinned while scrolling results for “a”. Screenshots: `~/scan-to-make-work/android-linux-20261105/android-main745-*.png` on Mac. #333 pairing/text fixes await main-build verification. Emulator shut down. No physical-device, scan or physical-print acceptance |
| Linux desktop (§17) | Installed `27295626` on agents-136; Nov 5 engineering check: added P1S through Settings → Printers (connection and camera passed), imported Mac caliper `1f1c5515` current 3MF into local project `1b7a26a2`, selected its plate, opened Print sheet; both MCP pictures displayed and Print enabled, never pressed | Not accepted: physical print, provider or reconstruction review. Required installing Bambu Studio 02.09.01.70 and configuring the MCP’s `SLICER_PATH`/`BAMBU_PROFILES_ROOT`; Xvfb window needed software-rendering restart. Linux uses its own companion. Evidence: `~/scan-to-make-work/android-linux-20261105/linux-caliper-preview-enabled.png` on Mac |
| TestFlight and Mac beta (§14) | 2.0 (3) uploaded; Mac v2.0-beta.4 notarized and published | external review approval; production push delivery |
| Widgets (§9.5) | Built | Control Center, App Intents/Siri, Spotlight, Share extension and Watch are not built |

**Known issues from the Nov 2–3 hands-on review — re-checked Nov 5, 2026.** Code baseline `1b66d937`; installed Mac 202611051513 (`6a6d4dde`). These are engineering findings, not device acceptance. No physical print was started.

| Item | Re-check and disposition |
|---|---|
| Thickness rounded up; “0 g” | **Already gone in shared formatting:** `Format.size` retains tenths and `Format.grams(0.49)` is `0.5 g` (`SmallMeasurementTests`). Installed Mac accessibility shows `102.6 × 36 × 20.6 mm` in the model stage. The companion sidebar status rounding is fixed in #331: it also retains tenths and shows `<0.1 mm` for a positive value below 0.05 mm, covered in `events.test.mjs`. |
| Wrong-job stage names; milestones out of order | **Already gone in code:** `stageWords` chooses Designing it / Fixing the scan / Getting the designer's file by pass kind. `PrintMonitor` sorts crossed milestones, emits only the highest, and does not back-fill missed milestones after a long sleep. Existing `print-monitor.test.mjs` covers jumps and restart. **Still open:** short-print notification delivery acceptance; no print run in this audit. |
| Old phone draft date; stray “Your project” | **Fixed in #331:** Inspector says “Work started” at the earliest recorded pass (including failed work), or “Draft created” at creation when there is no pass. Existing persisted passes backfill this without changing the store. `ProjectWordsTests` covers an old draft, out-of-order passes, no passes and failed work. Installed Mac sidebar had ten named projects, no stray draft; that observation does not prove draft lifecycle fixed. |
| Developer spool strings | **Still open / assigned to mig-discovery:** labels must come from MCP structured fields. |
| Copies/profile wording | **Fixed in #330:** Inspector labels saved time/weight “Last print estimate”, removing the invented profile name. **Still open / assigned to print-truth:** copies/profile contradiction in the print sheet. |
| Phone presence flipping | **Fixed in #331:** Mac sidebar, Mac Settings, iPhone device rows and Linux use authenticated-request `lastSeenAt`, never credential refresh, with the same five-minute window. Missing/future timestamps and legacy pairings are not connected. Mac no longer drops a newer request timestamp masked by a credential refresh. HTTP/control parity and timestamp-boundary regressions cover this. Android has no paired-device presence list; its live Mac reachability indicator is a different signal. Installed Mac read “iPhone (13CE) · seen 13 hours ago”; no live flip was observed. |
| Finished print Pause/Stop, notification promise, stale camera, Speed “–” | **Already gone in iPhone code** (`b845a545`): `PrintingView.printEnded` hides controls and future notification text, stops camera polling, and labels a retained frame “Last camera photo”. Speed tile is absent. **Still open:** real iPhone finished-print acceptance. |
| Cancel AXPress; Create Project after AX text set | **Still open / assigned to print-truth:** print-sheet Cancel. Re-tested in installed Mac 202611051513 on Nov 5: AXValue returned success but Create Project stayed disabled; focusing the same field and entering the same request with System Events keystrokes enabled it. Cancel returned to the project without creating anything. **Still open:** direct AXValue does not update the native SwiftUI binding; focus plus keystrokes is the verified automation path. |
| Sidebar printer opens Settings | **Fixed in #330:** opens that printer's live catalog status, model/address and recorded projects; selecting a project opens it. The project list matches its recorded print destination, not the next-print preference. **Alias follow-up in #345:** the companion exposes its existing canonical IDs as catalog aliases, so duplicates and MCP switches keep their recorded projects; an already-open sheet follows a new catalog winner without rewriting history. Catalog, transport and `ObjectsModelTests` regressions cover this. |
| Toolbar rename capsule | **Fixed in #330:** removed the principal rename button; Rename Project remains in More. Before-change installed AX tree exposed “Rename Leatherman Wave+ replica”. Native window title remains. |
| Unexplained “I checked the printer” block | **Still open / assigned to print-truth:** toggle remains gated by uncertain prior dispatch; needs the reason visible alongside it. |
| Six minutes “Getting the print ready”; Busy after completion | **Still open for acceptance:** installed sidebar reported P1S Ready, not Busy, with all projects ready/done/printed. Current monitor correlates the job and terminal state; this idle observation cannot verify the dispatch-to-print transition. No autonomous reprint. |


## 1. The product

**Status:** Built. A physical scan became a cleaned model on the Mac (Nov 4), and a two-colour design printed in both AMS colours from the iPhone (Nov 4, accepted). The fit and copy jobs have no end-to-end acceptance yet.

Counterpart makes physical things that fit your life, using your iPhone, your Mac and your 3D printer. It has three jobs:

1. **Make something that fits.** You need a part that attaches to, holds or fits something you own. Describe it, and show the thing with a scan or a few photos, or with nothing when its size is published. Your Mac designs the part.
2. **Copy an object.** Scan it. Your Mac fixes what the scanner missed, checks the result against your photos and makes it printable.
3. **Print a published model.** Paste or share a link to a model someone else designed (MakerWorld, Printables, Thingiverse), with any choices in plain words ("the 150 mm one, with the depth gauge, in black and yellow"). Counterpart prints the designer's own file as published. It never redesigns it.

Every way, you get a notification when it's ready. You look at it, print it or ask for changes, and you're told when the print is done.

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

## 3. Platform decision: native on every platform, no React Native, no Electron

**Decision.**
- **Apple:** the iPhone/iPad and Mac apps are pure Swift and SwiftUI and share one Swift package, `CounterpartKit`. React Native is gone from the phone; CI fails if a Release build contains it.
- **Android:** a native Kotlin and Jetpack Compose app (`android/`, §16). It speaks the iPhone's companion protocol and reuses the shared starter catalog and contract fixtures.
- **Linux:** a Tauri 2 desktop with a React/TypeScript and Three.js frontend (`apps/linux`, §17). It drives the same Node companion, bundled with its host helper (`tools/linux-host`) and the Linux reconstruction runtime (`tools/linux-reconstruct`). The Apple reasoning below doesn't apply to Linux: there's no Liquid Glass or RealityKit to lose, and the companion was already a Node service.
- **Windows:** nothing yet.

**Status:** Built. The Apple apps are installed and in daily use. Android and Linux are built but not accepted (§16, §17).

### Why not Electron or a web stack

- **On iPhone it isn't an option.** Electron only runs on desktops.
- **The phone app depends on native frameworks.** It is built on Object Capture, LiDAR depth from AVFoundation, RealityKit, ActivityKit (Live Activities), WidgetKit, App Intents and Liquid Glass. All of them are Swift frameworks, and a cross-platform layer would only wrap them.
- **On the Mac, Electron costs what matters most here:**
  - **No real Liquid Glass.** Electron can't use `NSGlassEffectView` or the system toolbar.
  - **Size.** It adds about 150–200 MB for a menu-bar companion.
  - **No RealityKit.** The model viewer would have to be rebuilt in three.js.
  - **Native bridges.** Local Network permission attribution, `SMAppService`, the Keychain, `MenuBarExtra`, Quick Look and notifications would each need one.

  journey.md §3.2 already covers these reasons.
- **Where a cross-platform shell made sense:** Linux, where it now exists (§17). The same Tauri shell could later serve Windows without touching the Apple apps.

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

**Status:** Built. A project can also hold several plates from an imported 3MF, each with its own completion; a Print carries the per-part colour map and its model version.

| Entity | What it is | Key fields |
|---|---|---|
| **Project** | One thing you want made | short title (generated), request text, kind (fit or copy), state, current result, printer target, timestamps |
| **Input** | Something you gave it | scan (walk-around or in hand), photo, close-up, link, note; who added it and when |
| **Pass** | One round of work on the Mac | trigger (new, ask for changes, late photos), stages with start and end times, worker trace (plain-language steps plus tool lines), outcome |
| **Result** | A model version | mesh, renders, dimensions, a "what changed" list (added, changed, assumed or estimated, each tagged), confidence notes |
| **Ask** | A question from the Mac | text, a picture with the region highlighted, the answers allowed (camera, photos, best guess, free text), status |
| **Print** | A print job | printer, profile, colour map, estimate (time, grams), live state (percent, layer, time left), events |
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
| printed | Printed *date* · Did it fit? | shippingbox, secondary |
| confirmed | Works · *date* | checkmark.circle.fill, green |
| failed | *What happened* · *what to do* | exclamationmark.triangle, red |

## 5. iPhone

### 5.1 Home

**Status:** Built; title, two-column grid, search over notes and every field, and no fake controls were checked on Davica3 Nov 2–3. Not accepted: staying connected on Home for an hour. The empty state offers the starters (§5.11).

**No screen is titled "Counterpart".** David, 2026-11-02: "it looks like it's printing a part called counterpart, i mean, there is not difference in the fonts. and since 3d printing involves printing parts, having it as it is makes it looks like not the name of the app". Like Apple's own apps (Photos says "Library", Music says "Home"), a large title names the screen, never the app; the app icon carries the brand. The app name appears only on Welcome, About and the Mac's menu bar and window chrome. The mockup screenshots below still show the old "Counterpart" title.

Screenshot: `screens/phone-home.jpg`.
Screenshot, empty state: `screens/phone-home-empty.jpg`.

- **Title area.** A large "Projects" title, with the subtitle "*Mac name* connected · *N* printers ready". Top-trailing holds a Printers button with a badge for printer problems, and the account and settings button. Those are the only items at the top, and neither starts work.
- **Now.** One card for each job that's running:
  - **Printing:** live camera thumbnail, percent, layer, time left, and filament chip.
  - **Working:** model thumbnail, stage in plain words, estimate, and step *n* of *m*.
- **Needs you.** One card for each open Ask, with the question, its picture, and the **Camera**, **Photos** and **Best guess** buttons inline. You can answer without opening the project.
- **All projects.** A two-column grid of real renders, each with a status capsule. Ready projects come first, then the rest by recency.
- **Bottom toolbar:**
  - search ("Projects, printers, notes"), using the iOS 27 bottom search placement. It matches every word typed, anywhere in: the title, the request, every follow-up note, the "What changed" lines, Ask questions and answers, the printer, the filament, and a published model's name and designer. David, 2026-11-02: "search doesn't really work, it doesn't search notes or anything";
  - a prominent **New** button at the bottom trailing edge, in the accent colour. It's the only prominent control on the screen.
  - If a build uses a tab bar, New becomes `Tab(role: .prominent)` (new in iOS 27). Either way it stays bottom-trailing.
- **Empty state.** Show the two jobs as two illustrated cards ("Make something that fits" and "Copy something"), each one tap from the New sheet with that job preselected.
- **Acceptance:**
  - A first-time user starts a project in one tap from Home, with one thumb.
  - Every running job is visible without scrolling on an iPhone 18 Pro.

### 5.2 New

**Status:** Built. Not accepted.

Screenshot: `screens/phone-new.jpg`.

**Layout.** A large sheet:
- **What do you need?** A multiline field. Dictation is the keyboard's own mic; there is no separate mic button. The hint: "Describe it, scan it, or both. Your Mac can look up published sizes."
- **Show it.** Five choices, all visible at once:
  - **On a scan rig** (a full-width card first, marked *Best quality*): "Clamp your phone to the 360° rig and swing it around." Underneath it: "Don't have one? Print the rig by Kass 3D →", which opens the model's MakerWorld page (§11.1).
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

**Status:** Built: walk-around (Apple Object Capture), in hand and on a rig. A physical scan reached the Mac and became a cleaned model on Nov 4. Not accepted: geometry and dimensions. A connected Continuity display blacks out the camera ([camera incident](../../status/camera-incident-2026-11-02.md)).

- **Walk-around (unchanged).** The existing Object Capture module (`apps/mobile/modules/object-capture/`) works and isn't touched. Changes are limited to its entry and exit: it's launched from New and returns its scan to New.
  - Close-ups come from the scan's own images, with no extra step. The Mac picks frames from the capture (§7.4).
- **Scan in hand (new; spec in §11).** Screenshot: `screens/phone-hand.jpg`.
  - A full-screen camera with the object's live outline and a coverage ring. One glass card carries one instruction at a time ("Turn it so the top faces you").
  - Shutter and LiDAR status are always visible ("1/500 s · LiDAR on"), with a count of sharp and skipped frames.
  - A Walk around / In hand switch, and a Done button.
- **On a scan rig (new; spec in §11.1).** Screenshot: `screens/phone-rig.jpg`.
  - The camera view, with one glass card for the current instruction ("Ring 1 of 3 · swing the arm slowly").
  - A list of rings, each with its own progress ring: clamp low and level; clamp high and tilted down; flip the object and clamp low.
  - Shutter, LiDAR and mask status are always visible.
  - The mode switch reads Walk / In hand / Rig.

### 5.4 Project

**Status:** Built. Done/Works checked on both devices Nov 2–3; Claude names projects. Not accepted: rename and Project Settings (partial), Ask for changes from both. **Compare versions** in the menu is not built (archived, §18).

Screenshots:
- `screens/phone-ready.jpg`
- `screens/phone-working.jpg`
- `screens/phone-ask.jpg`
- `screens/phone-inputs.jpg`
- `screens/phone-failed.jpg`

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
  - **What you sent:** the conversation, shown as message bubbles (§5.4.1).
  - **Activity:** the passes as a stage timeline. The current stage pulses, and each step expands to show the worker's plain-language note and tool lines.
- **Bottom bar:**
  - an **Ask for changes…** field with attachments, which sends a new pass with your text. Dictation is the keyboard's own mic. No icon is ever drawn that doesn't do something: David, 2026-11-02, "the microphone button in the diaglogue box, is decoration and hitting it doesn't do anything… just kinda janky to show fake icons";
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


**After printing: did it fit?** A `printed` project shows a card under the hero:
- **Did it fit?**, with **It works** and **Needs changes**.
- **It works** sets the state to `confirmed` (`PATCH /v1/objects/<id>/settings {"status":"works"}`, or `objects.settings.set` on the Mac; gated on `capabilities.projectSettings`). The project moves to a **Done** section on Home and in the Mac sidebar, with a green **Works** capsule.
- **Needs changes** opens Ask for changes with "After printing: " prefilled and the camera ready, so a photo of the part on the real object can go with it. That starts a new pass, keeps the print history, and sets the status to `needs-changes`.
- The same two answers are actions on the `print.done` notification (§9.1). Done projects can still be printed again or changed.
- Projects nobody answers stay `printed` and are never nagged about again after the first card.


**Names.** Every project has a real name, never "Your project", "Your scan" or "Unfinished project".
- **Naming:** the moment a project is created, the user's own Claude names it in two to four words from whatever there is: the request text, the link's page title, or the first photo. That's one short call to the user's own Claude. No reasoning step, and nothing waits on it.
- **Fallbacks:** until the name arrives, the project shows the first words of the request. A published model takes the model's own name.
- **Old projects:** projects created before this get named the same way, once, the first time the companion starts with this change.
- **Renaming:** tap the name on the project page (phone and Mac), or use **Rename** in its menu or in Project Settings. A name the user set is never replaced.

**Project Settings** (••• → **Project Settings**, on the phone and the Mac; stored in the companion, so the same on both):

| Setting | What it does |
|---|---|
| Name | Rename. |
| Status | Not printed yet → Printed → **Done** (it works); Needs changes is a side branch from Printed. Set it by hand any time, for example to mark something done that was printed elsewhere. **Archive** is a separate action ("Hide from Home"), not a status step: it keeps the project's status, Done stays Done, and Unarchive brings it back. |
| Printer | The printer this project prints on by default. |
| Colours | The default colour per part or filament (AMS slot or loaded spool), reused for every reprint. |
| Quality and strength | The default Draft/Standard/Fine and Standard/Strong/Max. |
| Copies | How many to put on the plate (`slice_stl` `repetitions`). |
| Design engine | Blender or Fusion for this project's next changes (when Fusion is set up). |
| Notifications | Follow this project's prints (milestones and done), or only problems. |
| Files | Show in Finder (Mac); share or export STL, 3MF or USDZ; the original files; the designer credit for a published model. |
| Duplicate | A new project from this one's current model and settings. |
| Archive / Delete | Archive hides it from Home and keeps everything. Delete removes it from the Mac, with a confirmation. |

Home and the Mac sidebar group projects as Now, Needs you, Ready, **Done** (Works) and Printed, with Archived behind a filter. Marking a project **Works** moves it to Done. A Done project stays printable: **Print another** opens the print sheet with the last printer, settings and colours, plus Copies; it needs no extra confirmation, and it stays Done after the new print finishes.

### 5.4.1 The conversation (phone "What you sent", Mac inspector "Request")

**Status:** Built. Not accepted.

David, 2026-11-02: "'you're request' like the dialogue words, and the model/llm words, should be like ios message bubbles… at a glance, and user can see, more eaily, how the whole thing really just a quick texting exchange. DO NOT GO OVER THE TOP and put everything in actions or logs… BUTTTT just the user messages, with just the main actions message, yes… and also they should be in order kinda… my photos of the thing being finished, should not be clusted together with my first pictures."

- **Only two kinds of bubble.** Each of the user's messages (the request, each follow-up, each close-up answer) is a right-aligned bubble in the accent colour. Each pass's reply (its `summary`) is a left-aligned grey bubble. Nothing else becomes a bubble: Activity, stages, tool lines, print events and Ask cards stay where and as they are.
- **In time order.** Request → reply → follow-up → reply, by `startedAtMs` and the note's time. A small time label appears between messages more than an hour apart, as in Messages.
- **Photos belong to the message they came with,** shown as a tight thumbnail stack inside or just above that bubble. The finished-part photos sent with "DONE" sit with "DONE", not with the first request.
  - Data: each pass records the photo names added with its note (`passes[].photos`); the request's photos are the ones present at creation.
  - Older projects are attributed once, by each photo's time against the passes'.
- **A long reply shows its first paragraph,** with **More** expanding it in place. Markdown renders: bold, lists.
- **The bubbles are presentation only.** Same words, same place, same data. No typing indicators, avatars, reactions or invented chat.
- **A message that says it's finished doesn't start a pass.** "DONE. mounted and working. thanks!!" ran a whole design pass that re-saved the same model. When a follow-up only reports that the part works or fits, the companion classifies it before starting a pass and answers with "Marked Done" (the status becomes Works), with **Undo**. That's one cheap classification call, not a design pass.

### 5.5 Print

**Status:** Built on iPhone, Mac, Android and Linux. Per-part AMS colours **accepted on device Nov 4** (iPhone, P1S). Copies, pause before a layer, plates and the legacy-colour choice are built, not accepted on the published MCPs.

**AirPods: accepted on device, Nov 4 evening** (AirPods Max hanger, project `5158831c`): David printed it through the app, on its side, it ended done, and the project is confirmed. Before that, the auditor's check: Both failed prints ran on builds from before #303, in the as-designed pose: 48 mm tall, 240 layers, no supports, after Studio's floating-cantilever "needs a yes". The 11:17Z print was cancelled at layer 17; at 13:06Z the printer stopped it at layer 0. The second bundle has `clean_flat.stl` from lay_flat. No #303 build has sliced or printed it since, and there's no `slices/` cache, so the next Print slices fresh. An engineering slice through the installed bambu-printer-mcp 1.1.57 and Bambu Studio with `orient: true` stands it on its side: 80 mm, 400 layers, with no Studio warning. Overhang wall time drops from 91 s to 0.2 s and bridges from 685 s to 81 s; tree(auto) supports would add only 68 s. The design pass predates the supports field (`current.supports` is absent), so the app sends no supports choice and the preset decides (off). Behaviour unchanged; David presses Print. Receipts: `~/scan-to-make-work/airpods-slice-check/`.

Screenshot: `screens/phone-print.jpg`. The flow is modelled on Bambu Handy and MakerWorld's Prepare to Print.
Screenshots of the variants: `screens/phone-print-one.jpg` (one colour), `screens/phone-print-noams.jpg` (no AMS), `screens/phone-print-loaded.jpg` (What's loaded?), `screens/phone-confirm.jpg` (the MCP's confirmation) and `screens/phone-confirm-mac.jpg` (Answer on your Mac).

**Layout:**
- **Printer.** A horizontal row of cards, one per printer, read from both MCPs. Each card shows the name, model, a ready dot and its spool colours.
  - Offline printers are dimmed and show why.
  - The last printer used is preselected.
- **Plate preview.** The model on a plate, with time, grams and layer count as glass capsules. These come from slicing with the printer MCP (`slice_stl` and its estimate) as soon as a printer is chosen.
- **Colours.**
  - **v1: one colour.** Pick an AMS slot or the loaded spool. It's preselected by matching the MCP's live filaments to the profile's material. Grams are shown.
  - **Multi-colour (M3b), when the model has separate parts.** One row per part (`GET /v1/objects/<id>/colour-mapping`), each starting on the nearest loaded spool. "Closest colour loaded" is said out loud when the match is loose. Print stays off until every part has a spool, and AMS trays and the external spool can't be mixed. The chosen order travels with Estimate and Print, bound to the model version (`filamentsModelVersion`) so a redesign can't inherit old choices. The same rows are on the Mac (#293) and the iPhone (`5864c56`); the phone never says "Open Counterpart on your Mac". The pipeline is in §8.5.
  - **A colour design from before colour parts existed** (#306) keeps only one merged STL. Print asks first: **Make it again in colour** (a new pass) or **Print in one colour**. It never quietly adopts old pass outputs.
  - The mockup shows the multi-colour version.
  - A printer without an AMS shows "Uses the loaded filament: *material colour*", with a reminder to change it if needed.
- **Quality:** Draft, Standard or Fine (layer height).
- **Strength:** Standard, Strong or Max (walls and infill).
- **Copies:** how many on the plate, only when the person picks a number (`capabilities.printCopies`). Otherwise the printer profile's own count applies.
- **Pause before layers:** "Before layer *N* of *T*", for dropping in magnets or nuts (`pauseBeforeLayers`, at most `PrintChoice.maxPauses`). The MCP has the slicer write the printer's own pause (`pause_at_layers`), and pauses already saved in a Studio/Orca 3MF are kept. Gated on `capabilities.layerPauses`.
- **Plate:** an imported 3MF keeps all its plates in one project. You choose a plate to print or reprint, and each plate remembers that it was printed. The sheet sends the plate's identity (`expectedPlate`), so a change on another device can't print a different plate. Active or uncertain prints lock the selection.
- **Profile line:** the actual profile name. The trailing toolbar button opens all of the slicer's settings, or "Open in *slicer* on Mac".
- **Print on *printer***: a prominent bottom button with "Done around *time*".

**Behaviour:**
- Starting a print still answers the printer MCP's own confirmation. The app presents the MCP's questions natively, never as a raw form.
- If the MCP asks something the app can't render, it says so and offers "Answer on your Mac".

### 5.6 No plate check

**Status:** Built, in the app and in both MCPs.

There is no plate check of any kind: no camera judging, no "is the plate clear?" prompt, no checkbox and no notification. The printer detects an occupied bed itself during bed leveling and stops; that's the only check. When bambu-printer-mcp or another printer MCP asks its own confirmation, the app shows exactly the checks that MCP asks for, and never adds a plate line.

### 5.7 Printing

**Status:** Built. Pause, Resume and Stop worked from the Mac UI over local FULU on Nov 3 with hand-copied MCP code; not accepted on the published MCP or from the phone. Live Activity: test start, update and end were seen on the Lock Screen through the Sandbox relay; not accepted for a real print or on the Watch.

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

**Status:** Built. Settings → Printers also offers each printer's **Connection** (the MCP's own route, e.g. Local network or Bambu Cloud, written to that MCP's `.env`), which MCP a printer uses, Add Printer…, and Download for both MCPs.

Screenshot: `screens/phone-printers.jpg`.
Screenshots, printer detail: `screens/phone-printer.jpg` and `screens/phone-printer-update.jpg`.

- **One row per printer** from the MCP configs on the Mac, showing state, spools, current job and camera.
- **Tap a printer** for its live camera, job, filament and history of prints from Counterpart.
- **The footer says plainly** that printers are configured in the MCPs on the Mac and Counterpart picks them up. Settings are never duplicated in the app.

### 5.9 Settings and About

**Status:** Built. General values come from the real Mac; keep-awake changed from the phone changed the Mac (Nov 3). Help opens the live help page on both. The phone's Mac row says "Checking…" until reachability is known and never "Connected now" before then (`b845a545`, covered by the engineering test). **Seen on device Nov 4:** David saw Settings show Connected while the Mac was reachable (build 202611041132).

Screenshots: `screens/phone-settings.jpg`, `screens/phone-settings-notifications.jpg` and `screens/phone-about.jpg`.

**Every setting the Mac has is also on the phone, and the two are always the same.** Settings live in the companion, which is the single source of truth. Both apps read and write them through the paired connection, so changing one on either device changes it everywhere. The phone has no "do this on your Mac" settings.

- **Your Mac:** name, connected or last seen, address in use, Check Connection, Connect a Different Mac.
- **Notifications:**
  - an on/off switch for each event type, for this iPhone and separately for the Mac;
  - the progress milestones (§9.1, §8.6).
  - Phone switches default on. Mac switches use the Mac defaults in §8.8.
- **Printers.** Each printer shows:
  - its state, its MCP and that MCP's version;
  - **Update** (§8.10), with its progress, when a newer version is available;
  - the features that version is missing ("Update to choose quality and colours").
- **AI:**
  - the provider and whether it's connected, plus **Test**;
  - switching provider, so long as switching doesn't need a sign-in window on the Mac. When it does, the phone says "Finish signing in on Mac mini" and the Mac shows the sign-in window by itself.
- **Design with Fusion** (§8.9): status and **Set up**.
- **Phones and iPads:** every paired device, including the Older pairings section, with **Remove** and **Remove All**.
- **General:** open at login, show in Dock, and keep the Mac awake while working. Each one changes the Mac.
- **How it works.** The companion exposes `GET /v1/settings` and `PATCH /v1/settings` with the same schema the control socket's `settings.get`/`settings.set` already uses, plus `GET /v1/devices` and `DELETE /v1/devices/<id>`. The schema and its labels live in `CounterpartKit` (`SettingsSchema`), so both apps render the same list from one definition, and a new setting appears on both without separate UI work. Settings that need the Mac's GUI (a sign-in window, a Keychain prompt) run on the Mac, and the phone shows their progress.
- **Help:** a guide at the docs site, how scanning works, and **Print the scan rig**. The rig link opens Kass 3D's MakerWorld page, credited by name (§15).
- **About:** the app icon, "Counterpart", the version and build, the website, the licences, and open-source notices.

### 5.10 First run and pairing

**Status:** QR and nearby pairing built and in use. Automatic iCloud pairing (`POST /v1/pair/icloud`) is built; fresh same-account enrolment is not accepted.

Screenshots: `screens/phone-welcome.jpg`, `screens/phone-pair.jpg` and `screens/phone-notify.jpg`.

**With the same Apple ID on both devices, nothing needs setting up.** The phone finds the Mac through the user's own iCloud and connects by itself, with no QR code, code to type or Allow button. Both devices already belong to one person, so a second confirmation would add nothing.

**Order:**
1. Welcome: one screen with the two jobs.
2. **Connecting to *Mac name*…**, then **Connected.** Under it: "Your iPhone and Mac use the same Apple Account, so they found each other."
3. Notifications permission, asked with a reason: "So you know when it's ready and when the print is done".
4. Done.

**Automatic connection through iCloud** (the default):
1. **The Mac publishes itself.** Counterpart for Mac writes a `CounterpartMac` record to the user's **private** CloudKit database (zone `Counterpart`, §8.8) on launch and whenever its addresses change. The record holds:
   - `macId`;
   - the name ("Mac mini");
   - every address (the LAN IPs, `.local`, and the Tailscale address when present);
   - the companion's key pin (SPKI SHA-256);
   - an **enrolment token**: 32 random bytes, valid for 10 minutes, replaced every 5 minutes while the Mac app runs.
2. **The phone reads it on first launch** (and whenever it has no working Mac). Several Macs mean a one-tap choice; one Mac means no question.
3. **The phone enrols.** It connects to the first address that answers, pins the key, and calls `POST /v1/pair/icloud {macId, enrolmentToken, installId, deviceName, model}`. The companion checks that the token is current and unused, then issues the normal device credential (the same scopes as QR pairing) and records the phone under its `installId`. Re-enrolling the same `installId` replaces its record; it never adds a duplicate.
4. **Away from home,** the phone still shows projects and receives notifications through CloudKit (§9). It enrols over the LAN the next time it's on the same network.

**Why this is safe.** Only the owner's Apple Account can read their private CloudKit database. The enrolment token is short-lived, single-use and pinned to this Mac's key. The phone's credential can be revoked in Settings on either device.

**Fallbacks, only when iCloud can't be used:** a different Apple Account on the phone, iCloud turned off, or no network path to the Mac.
- The QR code (journey.md §3.4) is available from **Settings → Connect a Different Mac** and from the Mac's **Add a Phone**.
- The nearby 6-digit flow is the second fallback.
- Neither appears in the default first run.

- **Permissions.** Local Network is asked when first used, with a reason. The camera is only needed for the QR fallback.

### 5.11 Starter projects

Every layout lists the starters while projects exist (§6.1): iPhone Home, the iPad start pane and sidebar, the Mac sidebar and New Project, Android Home and Linux Home, plus the welcome flow before pairing. They offer two starters from one shared catalog (`packages/CounterpartKit/Sources/CounterpartKit/Resources/Starters/catalog.json`, also used by Android and Linux):
- the **scan platform** by Kass 3D;
- the **long vernier caliper with depth gauge** by 3D Print Masters Hub.

Every starter is a real designer's model. Removed Nov 5: a bundled "Counterpart caliper card" whose files an agent generated with `tools/caliper` (588afd4c). Nobody designed or print-tested it, yet it was offered as something to print right now (David, Nov 5: "It just completely made up that one on its own"). The generator went with it.

MakerWorld starters carry credits and instructions and import the designer's original files; Counterpart never redistributes their geometry (§15). Several original files can be imported into one project. `POST /v1/objects {"starterId": …}` creates the project on the companion. No personal project history is copied.

**Status:** Built. Not accepted: importing the rig original, and printing a starter.

## 6. iPad and iPhone Duo

**Status:** Built (`NavigationSplitView` at regular width). Not accepted on an iPad or a Duo.

Screenshots: `screens/ipad-split.jpg` and `screens/duo-closed.jpg`.
Screenshots, reflow: `screens/duo-home-empty.jpg` and `screens/ipad-welcome.jpg`.

- **iPad, and Duo unfolded.** A `NavigationSplitView`:
  - a sidebar grouped as Now / Needs you / Ready / Printed / Printers;
  - the project page in the detail pane, with the model hero larger;
  - New Project in its own bar under the sidebar list (§6.1);
  - drag and drop photos from Files or Safari onto New or onto a project;
  - pointer and keyboard shortcuts: ⌘N new, ⌘P print, ⌘F search.
- **Duo folded.** The iPhone layout. iOS 27 moves the toolbar to a vertical rail on the outer panel's landscape layout automatically, and the mockup confirms it. New stays at the bottom of the rail.
- **Duo during capture.** Duo can't scan (no LiDAR). Its outer display can still show an "In progress" `CameraCaptureAccessory` for photo capture.
- **iPhone apps are resizable in iOS 27.** Every screen must reflow from compact to regular width. Test with Xcode 27 previews' resize handles.

### 6.1 Every layout

**The parity rule.** David, Nov 5, after the starters went missing on the Mac and iPad: "how do make sure thing like that don't happen again?" A user-facing feature lands on every layout in the same PR: iPhone (compact), iPad and iPhone apps at regular width, Mac, Android and Linux. Where a layout can't have it, this table names the exception and quotes David's decision. Each client has a test that the feature is reachable on a layout with projects present: `LayoutParityUITests` runs on an iPhone and an iPad simulator in the mobile gate, `ObjectsModelTests` on the Mac, `HomeLayoutTests` on Android, `domain.test.ts` on Linux.

What a person can see and reach, checked in code on `main` Nov 5 (after this PR: †):

| Feature | iPhone (compact) | iPad, regular width | Mac | Android | Linux |
|---|---|---|---|---|---|
| Starters (§5.11) | Home, under the projects, whenever no search is typed; Welcome before pairing | † the start pane (nothing selected, which is how the app opens) and a sidebar "Start with these" section. **Before: never** | † a sidebar "Start with These" section, and New Project. **Before: only with no project selected, and the Mac selects the first project on launch** | Home, above the projects, whenever no search is typed | Home's Projects view, under the grid, whenever no search is typed |
| New Project: fit, copy, scan, published link | New sheet: the five ways to show it, a published link in the text; fit/copy cards on an empty Home | the same sheet; fit/copy cards in the start pane † (before: only with no projects) | New Project pane: fit/copy, dropped files, a published link. No scan: the Mac has no LiDAR, scans come from the phone | New: ARCore scan, photos, a published link; fit/copy/published cards only on an empty Home | New dialog: fit, copy, published. No camera scan: Linux imports scans from files |
| Search, "N of M match", Show All | a pinned field above Home (#329) | a pinned field above the sidebar (#329) | sidebar search (#326) | top-bar search (#329) | Home search; counts within the selected view (#329) |
| Archived | "Archived · N" on Home | "Archived · N" sidebar section | Archived sidebar group | "Archived · N" on Home | Archive view in the sidebar |
| Project page | yes | yes, in the detail | yes, with the inspector | yes | yes, with the side panel |
| Print sheet, What will print | yes (#321) | yes, the same sheet | yes (#321) | yes (#324) | yes (#324) |
| Printers | the toolbar's printer button | the sidebar's printer button | sidebar Printers section; Settings → Printers | Home's printer icon; † Settings → Printers (before: the print sheet said "Settings → Printers", which didn't exist on Android) | Settings → Printers |
| Settings, pairing | Settings sheet; Connect a Different Mac | the same | Settings; Add a Phone | Settings; Connect a Different Computer | Settings; Add a phone |
| Help | Settings → Help: guide, scanning, the scan rig | the same | Help menu: Counterpart Help, the scan rig | † Settings → Help: the guide and the scan rig. **Before: none** | Settings → About → Open guide |

**Public site** (`site/public`): Help is in every page's nav. The scan rig is in help.html and index.html; the starters are listed only on beta.html.

**How the starters went missing.** Nothing removed them; they never reached two layouts.
- The starters landed in `588afd4c` (Nov 3) on three surfaces: iPhone Home, Welcome and the Mac's no-selection view. Its own spec asked only for "first launch", and its one UI test covered the empty iPhone Home.
- The Mac has selected the first project on launch since #193 (`205a9757`, Nov 1), two days earlier. So with any project, its no-selection view (and the starters in it) was unreachable from the day it landed.
- The iPad split view (#201, `a84720f0`, Nov 1) predates the starters, and `588afd4c` didn't touch `ProjectsRoot.swift`. With projects the iPad showed "Choose a project"; with none, only the two job cards.
- The mobile gate ran UI tests only on an iPhone simulator, so nothing ran the regular-width layout.

**The New button over the last iPad sidebar row** (build 202611052142): On iPadOS 27, New as a sidebar `.bottomBar` toolbar item draws as a borderless floating glass "+" (its "New" label collapses), over whichever row is behind it. Reproduced on an iPad Air 11-inch simulator, main `a745c1f6`, with a list longer than the screen: scrolled to the end, the last row clears it (the list inset works). Rows scroll under the floating button, so a list longer than the screen has a row behind it until it is scrolled to the end, which is what David's iPad showed; the simulator run checked only the scrolled-to-end case. This was not #329's search bar. † New is now a full-width **New Project** button in its own bar under the sidebar list, as search has its bar above it; `testNewNeverCoversARow` checks the list ends where the bar begins. Screenshots: `~/scan-to-make-work/parity-20261105/ipad-sim-main-new-overlap*.png` on the Mac.

**Fixed by this rule:** a feature PR's UI test runs at both widths (`LayoutParityUITests`, in the iPhone and iPad steps of `mobile.yml`), and a reviewer rejects a user-facing change that skips a layout without a row here.

## 7. Mac

**Status:** Built; installed build 202611041137 (source `c5762972`).

### 7.1 App shape

**Status:** Built: SwiftUI scenes, a `MenuBarExtra`, and the companion as an `SMAppService` agent.

- **A normal Mac app with a menu bar extra.** It has a Dock icon by default, with a Settings switch to hide it, plus a `MenuBarExtra`.
- **SwiftUI scenes only:**
  - `Window` for Counterpart;
  - `Window` for the pairing QR;
  - `Settings`;
  - `MenuBarExtra(.window)`.

  This replaces the hand-built `NSWindow`s and the activation-policy switching (audit M1).
- **The companion** stays the bundled Node service, registered as an `SMAppService` agent as today.

### 7.2 Main window

**Status:** Built; the real model shows on a transparent stage and enters 3D. Not accepted: full parity with the mockups. Open review items are in §0.

Screenshot: `screens/mac-main.jpg`.
Screenshots, inspector and New Project: `screens/mac-inspector-activity.jpg`, `screens/mac-inspector-print.jpg` and `screens/mac-new.jpg`.

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
  - Request: the conversation as message bubbles (§5.4.1);
  - Activity: passes, stages and tool lines;
  - Print: printer, profile, colours and the last print's events.
- **New Project on the Mac.** Drop photos, STL, 3MF or USDZ files, or type a request. Projects started on the Mac appear on the phone too.

### 7.3 Print sheet

**Status:** Built, including per-part colours, copies, layer pauses and plates (§5.5).

Screenshot: `screens/mac-print.jpg`. The same content as the phone's (§5.5), laid out as a sheet: printer cards, the plate preview, the colour map, quality and strength, and **Print on *printer***.

### 7.4 Menu bar popover

**Status:** Built. Not accepted.

Screenshot: `screens/mac-popover.jpg`.

- **Status:** a header with the app mark and Ready, Working or Problem.
- **Now:** running jobs with progress.
- **Needs you:** cards, each saying "Asked on your iPhone too".
- **Printers:** ready dots.
- **Buttons:** Open Counterpart, Add a Phone (QR), Settings.

### 7.5 Settings

**Status:** Built.

Screenshot: `screens/mac-devices.jpg`.
Screenshots, the other tabs: `screens/mac-settings-general.jpg`, `screens/mac-settings-printers.jpg`, `screens/mac-settings-ai.jpg` and `screens/mac-settings-advanced.jpg`.

- **General:** open at login, show in Dock, notifications.
- **Phones and iPads:**
  - one row per device, named and with its model;
  - each row shows connected now or last seen, and its paired date;
  - Remove…, and Add a Phone….
- **Printers:** read-only, listing each printer and which MCP provides it, with a link to the MCP's own config.
- **AI:** which model runs the jobs, with its connected state and a **Test**. The choices are Claude Code, Codex CLI, an Anthropic or OpenAI API key (kept in the Keychain), an OpenAI-compatible endpoint (OpenRouter or a local server), or **Off**. Every job snapshots the choice when it starts: design, change, cleanup, published model, title and completion. Off is enforced, and nothing falls back to Claude. OpenCode isn't offered yet. The contract is in [`docs/protocols/settings.md`](../../protocols/settings.md). A real Claude cleanup of David's scan ran Nov 4; an earlier Codex pass failed.
- **Advanced:** addresses in use, logs, diagnostics export.

### 7.6 What the Mac does without being asked

**Status:** Built. Keep-awake while working is a setting on both devices.

- **Close-ups from the scan.** On arrival, the Mac selects the sharpest, most informative frames from the capture as reference photos. If the scan can't show a region, the Mac raises an **Ask** with that region highlighted.
- **Prevents idle sleep** while a pass or a print is running (journey.md §3.3).

## 8. Back end: printers, progress and events

This section specifies every connection from the user's printer to their phone's Lock Screen. The **Existing**, **New** and **Fix** marks are historical: they record what the Nov 1 plan added to the code of that time. All of it is now on main; each status line says what is accepted.

### 8.0 Boundary: the app staples onto the MCPs

David, 2026-11-04: "we have to constantly make updates basically everyday in the mcp servers because of new printers, fixed bugs upstream ... multiple slicers, like 8 printer brands, all rolling out new firmware all the time, and then try to maintain parity as much as is reasonable with fusion mcp and blender mcp ... seperating that and just "stapling together" the front end of the app to the backend of the mcp servers, is the clever way to go, because the iOS App Store would be a nightmare dealing with that many updates. and agents are CONSTANTLY blurring the boundary and adding backend stuff that should be in mcp to the app itself".

**The rule.** Code that would have to change when a printer, slicer, firmware, filament system, Blender or Fusion changes belongs in the MCPs, in both of them. The app calls tools, renders their structured results and passes the person's choices through. App code (the companion, printer-handoff and every client) has none of these:
- branching on the MCP package or the slicer;
- printer-model tables;
- matching on MCP or printer error codes or wording;
- slicer setting keys or presets;
- fallbacks for MCPs without the contract.

When a capability is missing, the app says "Update *MCP* in Settings → Printers" (`settingsUnsupported` does this). The `counterpart/1` contract (§8.4) is the seam. Every tool and result field the app reads is listed in [`docs/protocols/mcp-contract.md`](../../protocols/mcp-contract.md).

**Stays in the app:**
- capture and close-ups;
- reconstruction (`tools/mac-reconstruct`, `tools/linux-reconstruct`);
- scan cleanup (`tools/scan-repair`, `tools/scan-correct`, `tools/capture-mesh-convert`), which is the app per David on Oct 31;
- the companion's pairing, auth, relay, events, notifications, Live Activities and CloudKit project store;
- the MCP install/update lifecycle;
- the print monitor as orchestration, fed by `counterpart_print_progress`;
- #306's legacy-pass detection.

The caliper generator (`tools/caliper`) was on this list until Nov 5. It only made the bundled caliper card starter, which nobody designed or print-tested, so both were removed (§5.11).

**In the app today; moves to the MCPs.** Migration order, one item at a time. For each item:
1. extend `counterpart/1` in both MCPs;
2. publish both to npm;
3. install them through the app's own Update and confirm in the real app;
4. only then open the app PR that deletes the app code and requires the capability.

Deleting app code before the published MCP has the replacement would regress installed devices.

| # | In the app today (checked on main `d1f68252`) | Moves to |
|---|---|---|
| 1 | ~~quality → layer height, strength → walls/infill, nozzle scaling~~ **Moved** 2026-11-04: bambu-printer-mcp 1.1.56 / mcp-3d-printer-server 1.2.30 take `quality`/`strength`; 1.1.56 installed through the app's Update; app copies deleted in #313 | the MCPs' `slice_stl` |
| 2 | ~~the `HMS 0500-0500-0001-0007` and "not safely idle" text matches on `print_3mf` errors~~ **Moved** 2026-11-04: bambu-printer-mcp 1.1.57 / mcp-3d-printer-server 1.2.31 return `printer-command-rejected`/`printer-not-ready` as `structuredContent.code`; 1.1.57 installed through the app's Update; the app reads the code (#314) | the MCPs' structured refusal |
| 3 | ~~`isBambuSlicing`, which slicers accept supports and repetitions, `bambu_model` only for Bambu slicing~~ **Moved** 2026-11-05: bambu-printer-mcp 1.1.58 / mcp-3d-printer-server 1.2.32 report `capabilities.slicing` (supports, copies, orient) and refuse copies they can't make; installed through the app's Update; the app follows the capability (#316) | the MCPs' `counterpart_printer_info` |
| 4 | ~~`services/printer-handoff/src/counterpart.ts`: the `get_printer_status` fallback for MCPs without `counterpart/1`. `services/companion/src/objects/service.ts`: `backend === 'bambu-printer-mcp'` at 632, 722, 1332, 1337, 1378 and 1605~~ **Moved** 2026-11-05: app-only; capabilities, reports, AMS trays and the print tool (`print3mf`/`gcode`) come only from `counterpart_printer_info` and `counterpart_print_progress`; an MCP without them says "Update *MCP* in Settings → Printers". Add Printer's connection check still reads `get_printer_status` (`setup.ts`, `printer-check.ts`, item 6) | deleted; the capability is required |
| 5 | ~~`services/printer-handoff/src/remote-mcp.ts`: the hard-coded per-tool scope table~~ **Moved** 2026-11-05: bambu-printer-mcp 1.1.64 / mcp-3d-printer-server 1.2.42 declare each tool's scope, raising arguments and argument kinds in `_meta["counterpart/remote"]` (equal to the old table on every listed tool); installed through the app's Update (bambu on the Mac, mcp-3D in the Linux app); the app's table, name floors and argument-name lists are deleted | scopes derived from the MCPs' tool annotations |
| 6 | `services/companion/src/printing/discovery.ts` (SSDP, `BAMBU_SERIAL_MODELS` copied from the MCP's `SERIAL_MODELS`); `profiles.ts` and `setup.ts`; the Mac's Add Printer brand list (`PrinterSetupViews.swift`) | a discovery tool, each brand's MCP doing its own, and the MCP declaring its setup fields |
| 7 | `services/companion/src/objects/colour-match.ts` (OKLab nearest spool before slicing), copied into ControlKit `Objects.swift`, CounterpartKit `Printers.swift`/`Project.swift`, the iPhone `PrintSheet.swift` and `apps/linux/src/types.ts` | the MCP proposes the per-part mapping (bambu has only post-slice `resolve_3mf_ams_slots`; mcp-3D has none); clients render it and send overrides |
| 8 | ~~`services/printer-handoff/src/slice-cache.ts`: a slice cache keyed on the MCP's env and preset files~~ **Moved** 2026-11-05: bambu-printer-mcp 1.1.64 / mcp-3d-printer-server 1.2.42 keep each finished slice keyed on the slicer executable, the server version and every input file's bytes, and restore an identical one; installed through the app's Update; the app's cache is deleted | the MCP |
| 9 | ~~`slice-estimate.ts`, `slicer-report.ts`: parsing sliced 3MF/G-code metadata and `result.json`~~ **Moved** 2026-11-05: `inspect_print_file` `sliced` (estimate, settings, plate count) and slicing results' `slicer_report` in bambu-printer-mcp 1.1.64 / mcp-3d-printer-server 1.2.42; installed through the app's Update; the app reads them. **Still in the app:** `model-file.ts` (an imported 3MF's plates, object names, filaments, painting: `Metadata/plate_*`, `filament_ids`), which needs a model-file tool in both MCPs and feeds item 7's per-part mapping | structured results from `inspect_print_file`, `list_3mf_plate_objects` and `get_slice_settings` |
| 10 | `services/companion/src/touchup/invocation.ts` (~42–75): how Bambu Studio orients and generates supports, and how to slice a checkpoint, written into the design prompt | the MCPs' `fdm_*` prompts |
| 11 | `services/companion/src/touchup/addon-installer.ts`, `addon-repair.ts` (the Blender add-on); the Mac's `FusionSetup.swift` (the Fusion add-in at a pinned commit and hashes) | the MCP that proxies Blender or Fusion (`blender_mcp_status`, `fusion_mcp_status` and their setup) |
| 12 | the FULU launcher (`~/Library/Application Support/Scan to Make/printers/fulu-authenticated-lan.sh`, in neither repo) | bambu-printer-mcp |

To review, not on the move list: the Mac's "Open in Blender" (`BlenderBridge.swift`) starts the person's own Blender with an inbox watcher. It's an external-editor action, not a printer path.

**No client talks to a printer or an MCP directly.** The iPhone, Mac, Android and Linux apps reach printers only through the companion's HTTP API or control socket. Checked on main: their sources have no MQTT, FTPS, OctoPrint/Moonraker or MCP transport.

**Enforcement:**
- `services/companion/tests/mcp-contract.test.mjs` fails when app code starts reading an MCP tool that `docs/protocols/mcp-contract.md` doesn't list.
- `scripts/branch_check.py --merge` asks the Jev checker whether the diff adds printer, slicer, firmware, Blender or Fusion knowledge to app code. If the checker can't answer, the gate fails closed. TypeSafe direct has no credits (HTTP 402, 2026-11-04), so it answers through Jev on OpenRouter, as David's other Jev runners do. It was calibrated on 14 real hunks (threshold 0.3).

### 8.1 Topology

**Status:** Built as drawn. Android and Linux reach the companion the same way as the iPhone (§16, §17).

```
iPhone ──HTTPS, LAN/VPN, pinned key──▶ companion (Node, on the Mac) ──MCP over stdio──▶ bambu-printer-mcp ──MQTT 8883 · FTPS 990 · camera TCP 6000 / RTSP 322──▶ Bambu printer
   ▲                                     │        └──────────MCP over stdio──▶ mcp-3D-printer-server ──HTTP──▶ OctoPrint · Moonraker (Klipper) · PrusaLink · Duet · Repetier · Creality
   │                                     │ Unix control socket (existing)
   │                                     ▼
   └────── CloudKit private DB ◀──── Counterpart for Mac (Swift) ──HTTPS──▶ relay Worker (counterpart.dtmont.com) ──APNs──▶ iPhone Live Activity
```

Who runs what:
- **The companion** owns everything that talks to printers: MCP sessions, the print monitor, the event log, the phone's HTTP API and the Mac's control socket.
- **The Mac app** delivers events: Mac notifications, CloudKit records, and Live Activity pushes through the relay.
- **The phone** never talks to a printer or an MCP directly.

### 8.2 Finding printers and choosing the MCP

**Status:** Built, including the Codex `config.toml` source and one destination per printer. Bambu Cloud printing was refused by Bambu (-3120, HTTP 403) on Nov 3. bambu-printer-mcp 1.1.55 and mcp-3d-printer-server 1.2.29 now send a cloud print the way Bambu Studio does; not accepted on the printer yet.

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
  - Screenshot: `screens/phone-printer-update.jpg`.

### 8.3 MCP sessions: one long-lived session per printer

**Status:** Built (`PrinterSessionPool`).

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

**Status:** Built in both MCPs (on mcp-3D-printer-server's main). The installed mcp-3D-printer-server is a hand-built dist from `feat/bambu-complete@56d8fb9`, not npm; its `pause_at_layers`, Resume notice and refusal reporting aren't published.

Both MCPs gain the same small set of tools with the same arguments and results. Each tool declares an `outputSchema` and returns `structuredContent`, plus the same JSON as text for older clients. The companion validates results with zod.
- **Bambu tools** take the existing optional `host`, `bambu_serial` and `bambu_token` overrides.
- **Generic tools** take the existing optional `host`, `port`, `type` and `api_key` overrides.

| Tool | bambu-printer-mcp | mcp-3D-printer-server |
|---|---|---|
| `counterpart_printer_info` | new | new |
| `counterpart_print_progress` | new; wraps `getStatus` | new; per-firmware mapping below |
| `camera_snapshot` | existing | **new**, with the same arguments and result as Bambu's |
| `get_printer_filaments` | existing | **new**, single-slot result |
| `slice_stl` arguments | **add** `layer_height` (mm), `wall_loops` (int) and `sparse_infill_density` (e.g. `"15%"`). The MCP writes them as a process override on top of the machine and process preset it already resolves (Bambu Studio/Orca keys `layer_height`, `wall_loops`, `sparse_infill_density`). Today the only route is a whole `slicer_profile` file | **add** the same three arguments, mapped to the slicer in use (Orca keys as for Bambu; PrusaSlicer `layer_height`, `perimeters`, `fill_density`) |
| `counterpart_make_3mf` (M3b) | **new**: `{parts: [{stl_path, name, filament?}], out_path}` → one 3MF object with one part per STL, each part carrying its filament number (default 1, 2, …). Separate objects get arranged apart by BambuStudio 02.08.02.61, and its CLI rejects `--load-filament-ids` for 3MF input, so the filament mapping lives in the 3MF (KAN-215) | not needed: generic printers are single-extruder in v1 |
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
| **Bambu** (MQTT report, cached) | none; reads the MCP's `reportSnapshots` | `gcode_state`: IDLE→idle, PREPARE/SLICING→preparing, RUNNING→printing, PAUSE→paused, FINISH→finished, FAILED→failed, except FAILED with error `0300400C` (a user cancel, in `print_error` or X2D's `fail_reason`)→cancelled, never listed as a problem | `mc_percent`; `mc_remaining_time` is in **minutes**, so ×60 | `layer_num`, `total_layer_num` | `print_error` (non-zero, as 8-digit hex); each `hms[]` entry as `AAAA_BBBB_CCCC_DDDD` from `attr`/`code`. **New:** messages come from a generated `src/safety/hms-messages.ts`, built from the same Bambu Studio `resources/hms/hms_en_<prefix>.json` files and pinned tag that `scripts/generate-hidden-hms.mjs` already reads for `hidden-hms.ts`. `url` points to Bambu's page for that code. **New:** `stg_cur` maps to `job.stage` through a generated stage table, from Bambu Studio's stage strings at the same tag; the MCP has none today |
| **OctoPrint** | `GET /api/job`, plus `GET /api/printer` for temperatures | `state` text: Printing→printing, Pausing/Paused→paused, Operational→idle (finished when the last job's `progress.completion` = 100), Error→failed, Offline→offline | `progress.completion`; `progress.printTime`; `progress.printTimeLeft` | not in core: omitted | `state.error` |
| **Klipper** (Moonraker) | `GET /printer/objects/query?print_stats&virtual_sdcard&display_status&extruder&heater_bed&webhooks` | `print_stats.state`: standby→idle, printing, paused, complete→finished, cancelled, error→failed; `webhooks.state` ≠ ready→busy | `display_status.progress` ×100 (falling back to `virtual_sdcard.progress`); `print_stats.print_duration`; remaining = file `estimated_time` (`GET /server/files/metadata?filename=`) − `print_duration` | `print_stats.info.current_layer` / `total_layer` (set when the slicer emits `SET_PRINT_STATS_INFO`; OrcaSlicer and PrusaSlicer do) | `print_stats.message`; `webhooks.state_message` |
| **PrusaLink** | `GET /api/v1/status` | `printer.state`: PRINTING, PAUSED, FINISHED, STOPPED→cancelled, ERROR→failed, ATTENTION→paused (with a problem), IDLE/READY→idle, BUSY→busy | `job.progress`; `job.time_printing`; `job.time_remaining` | omitted | ATTENTION/ERROR plus `GET /api/v1/job` details |
| **Duet** (RRF 3) | `GET /rr_model?key=state` and `GET /rr_model?key=job&flags=d99f` (standalone); `GET /machine/status` (SBC) | `state.status`: processing→printing, paused/pausing→paused, idle, busy | `job.filePosition` / `job.file.size`; `job.duration`; `job.timesLeft.slicer` (falling back to `.file`) | `job.layer`, `job.file.numLayers` | `state.messageBox`, `state.displayMessage` |
| **Repetier** | `GET /printer/api/<slug>?a=listPrinter&apikey=…` | `online`, `job`, `paused` | `done` (percent); time from `printTime` / `printedTimeComp` | omitted | none |
| **Creality** | K1/K2-series printers run Moonraker: use the Klipper row when port 7125 or 4408 answers. Otherwise use the existing `GET /api/device/status` | as the Klipper row, or from that endpoint | as above | as above | as above |

**`camera_snapshot` in mcp-3D-printer-server** returns the same result as Bambu's: `{ format: "image/jpeg", base64, savedTo? }` (Bambu has always returned `image/jpeg`), plus `capturedAt`.
- **OctoPrint:** use the snapshot URL from `GET /api/settings`. That's `webcam.snapshotUrl` on OctoPrint ≤ 1.8, and `plugins.classicwebcam.snapshot` on 1.9+. Otherwise fall back to `http://host/webcam/?action=snapshot`.
- **Moonraker:** `GET /server/webcams/list`, then the first enabled webcam's `snapshot_url`, resolved against the host.
- **Repetier:** the printer config's `webcams[].staticUrl`.
- **PrusaLink and Duet:** there's no local snapshot API, so the camera is `none`.
- **Any firmware:** the `PRINTER_CAMERA_SNAPSHOT_URL` env variable overrides the source.

**`get_printer_filaments` in mcp-3D-printer-server** returns `{ slots: [{ id: "ext", material?, color?, name?, profile?, source: "spoolman"|"unknown" }] }`. `profile` is the absolute path of the installed slicer filament profile for that material (OrcaSlicer or PrusaSlicer, preferring presets for this printer), the path `slice_stl` takes as `load_filaments`. It is left out when nothing resolves; it never falls back to a profile for a different material. bambu-printer-mcp names the same thing `resolved_profile_path`.
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

**Older MCP installs.** An MCP without `counterpart_printer_info` and `counterpart_print_progress` gets no progress, camera, spools or controls; Printers says "Update *MCP* in Settings → Printers" (§8.0 item 4). The app never reads `get_printer_status` in their place.

### 8.5 Printing a project (dispatch)

**Status:** Built, including per-part colours (M3b: `parts`, `counterpart_make_3mf`, `ams_mapping`) and the orientation/support pass-through (#303): no `lay_flat`. Bambu Studio orients an STL itself, a 3MF keeps its placement, other slicers get the model as it is, and the designer's support choice goes straight to `slice_stl`. A two-colour pick printed correctly from the iPhone on Nov 4.

**AirPods: accepted on device, Nov 4 evening** (AirPods Max hanger, project `5158831c`): David printed it through the app, on its side, it ended done, and the project is confirmed. Before that, the auditor's check: Both failed prints ran on builds from before #303, in the as-designed pose: 48 mm tall, 240 layers, no supports, after Studio's floating-cantilever "needs a yes". The 11:17Z print was cancelled at layer 17; at 13:06Z the printer stopped it at layer 0. The second bundle has `clean_flat.stl` from lay_flat. No #303 build has sliced or printed it since, and there's no `slices/` cache, so the next Print slices fresh. An engineering slice through the installed bambu-printer-mcp 1.1.57 and Bambu Studio with `orient: true` stands it on its side: 80 mm, 400 layers, with no Studio warning. Overhang wall time drops from 91 s to 0.2 s and bridges from 685 s to 81 s; tree(auto) supports would add only 68 s. The design pass predates the supports field (`current.supports` is absent), so the app sends no supports choice and the preset decides (off). Behaviour unchanged; David presses Print. Receipts: `~/scan-to-make-work/airpods-slice-check/`.

- **Existing.** `PrintRunner.runBundle` runs `lay_flat` → `slice_stl` → `inspect_print_file` → `camera_snapshot` → `print_3mf` (Bambu). For other printers it runs `slice_stl` → `upload_gcode`/`start_print`.
  - It reports preparation phases: connecting, slicing, slice-ready (with the estimate from `sliceEstimate`), checking the printer, and requesting the print.
  - It relays the MCP's own print confirmation (elicitation) to the phone and the Mac. `DispatchedPrintError` and the "uncertain" result are handled.
- **New: the print settings from the print sheet (§5.5) are carried into the run.**
  - **Destination:** `objects.selectPrinter` (existing).
  - **Quality and strength** map to the slicer through the MCP's own options:
    - layer height Draft 0.28 / Standard 0.20 / Fine 0.12 mm;
    - walls and infill Standard 2/15%, Strong 4/25%, Max 6/40%.

    They go in as the new `slice_stl` arguments `layer_height`, `wall_loops` and `sparse_infill_density` (§8.4). If the installed MCP lacks them (checked from its tool schema, as `print.ts` already does for its other optional arguments), the print sheet shows only Standard, which means the preset's own values.
  - **Colour, v1 (one colour):**
    - Bambu: `print_3mf` with `use_ams: true` and `ams_slots: [chosen tray index]`, or `auto_match_ams: true` when the user kept the preselection.
    - Bambu, external spool: `use_ams: false`.
    - Generic: `slice_stl` with the chosen material's filament profile through `load_filaments`.
  - **Colour, M3b (multi-colour):**
    1. The touch-up or design pass exports each body as its own STL through the printer MCP's Blender bridge (`blender_mcp_call`, export of the selected object). The pass contract gains `parts: [{name, stl}]`.
    2. `counterpart_make_3mf` combines them.
    3. `slice_stl` slices with `load_filaments` (one profile per filament number in the 3MF). It refuses `load_filament_ids` for 3MF input, because the BambuStudio CLI does.
    4. `print_3mf` prints with `ams_mapping` set from the print sheet.
- **No plate check.** The companion doesn't take a camera snapshot before printing and doesn't judge the plate. `objects/bedcheck.ts`, `judgePlate`, `objects.answerPlate`, `POST …/plate` and the `plate.blocked` event are removed.
- **Fix: "printed" now means printed.** On `print_3mf`/`start_print` success, the object goes to `printing` with `print.printId` (a new uuid), `destinationId`, `dispatchedAt`, `jobName`, `taskId?` and the slice `estimate`. Today it goes straight to `printed`. The monitor (§8.6) sets `printed` when the matching job finishes.

### 8.6 The print monitor (new: `services/companion/src/printing/monitor.ts`)

**Status:** Built. A print that never started ends its Live Activity (#302).

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

### 8.6.1 The printer camera, done cheaply

**Status:** Built; an installed sample had 0 errors over 12 reads. Not accepted: a sustained run.

David, 2026-11-02: "are we doing that in an effecient and clever say like how scrypted nvr sends over webrtc peer to peer nad it takes like zero memory or compute and it's basically fucking instant… but somehow, i highly doubt we're doing this in an effecient and clever way". He was right. As of `37ecbb6`, every frame opened a new TLS connection to the printer's camera (P1S, port 6000: handshake, auth, one JPEG, close), RTSP printers started a new ffmpeg per frame, phones re-downloaded on a timer whether or not the picture changed, and a dropped event stream fell back to polling the whole project list every 3 s.

The design, Scrypted's shape at a 3D printer's pace:
1. **One camera connection per printer, only while someone is looking.** The printer MCP gains a camera stream (`camera_stream_start`/`camera_frame`/`camera_stream_stop`, or a long-lived tool result). It keeps the one TLS socket on 6000 (or one ffmpeg reading RTSP and writing MJPEG to stdout) open, holds the latest frame in memory, and closes 30 s after the last viewer. No per-frame reconnects, no per-frame processes. With nobody looking, there is no camera traffic at all.
2. **Push, don't poll.** The companion serves one long-lived stream per viewer (`GET …/camera.mjpeg`, multipart; or frames on the existing events connection). It sends a frame only when the picture has changed (a 32×18 grayscale difference over a threshold) and at most every 2 s full-screen or every 10 s for a 300 px card, sized for that viewer. A printer slowly laying plastic sends very little.
3. **Away from home:** the same stream through Tailscale, which is peer-to-peer WireGuard and so works like Scrypted's WebRTC. Without Tailscale there is no live camera away from home; notifications still carry a frame.
4. **Lock Screen, Watch and widgets:** the notification at each milestone (first layer, halfway, done, problem) carries **one** frame, attached by the Notification Service Extension (§9.2), and it reaches the Watch like any notification. The Live Activity shows progress, layer and time left with no image, because iOS doesn't allow pushed images in a Live Activity. Widgets refresh on the system's budget. There is no 15 s camera on the Lock Screen, by design.
5. **No timer polling while events work.** The phone re-reads only on events (§8.7). If the event stream is down, it retries the stream and polls no faster than every 30 s meanwhile.

**Budgets (added to §9.6):**
- with one viewer: the Mac under 2% CPU for the camera path;
- the phone under 30 KB/s full-screen and 3 KB/s per card;
- zero camera bytes and zero printer connections when nobody is looking;
- measured on the real P1S.

### 8.7 The event log (new: `services/companion/src/events/`)

**Status:** Built.

Every user-visible change becomes one event.
- Events are appended to `~/Library/Application Support/Scan to Make/events.ndjson`, with a monotonic `seq`, and kept for 7 days.
- All notification wording is written by one function, `events/words.ts`, so the Mac, the phone, the Lock Screen and the menu bar say the same thing.

```ts
type CounterpartEvent = {
  v: 1; seq: number; id: string /* uuid */; at: string /* ISO */;
  type: "pass.started"|"pass.stage"|"pass.ready"|"pass.ask"|"pass.failed"
      | "print.preparing"|"print.confirm"|"print.started"|"print.status"|"print.first-layer"
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

**Status:** Built. The relay is provisioned for Sandbox and Production. CloudKit owns the discrete alerts, with their camera frames. A Live Activity push carries an alert only on push-to-start, so a pause or completion never shows two banners. Not accepted: production push delivery.

**Mac app `EventRelay` (new, Swift).** It loops on `events.wait` and persists its cursor. After a restart it doesn't notify for events older than 10 minutes; it only syncs them.

For every event with `notify ≠ none`:
1. **A Mac notification** (`UNUserNotificationCenter`), according to Settings. Its defaults are the Mac column of §9.1: `pass.ready`, `pass.ask`, `pass.failed`, `print.confirm`, `print.paused`, `print.done`, `print.failed` and `print.not-started` are on; progress, `print.sent` and `print.unreachable` are off.
2. **CloudKit.** Save a `CounterpartEvent` record in the custom zone `Counterpart` of the private database, in container `iCloud.com.scantomake.counterpart`.
   - Fields: `eventId`, `seq`, `type`, `projectId`, `printId`, `title`, `body`, `notify`, `progress`, `remainingSec`, `createdAt`, and `frame` (a `CKAsset`: a JPEG at most 1280 px on the long edge and about 300 KB, made with ImageIO).
   - A daily sweep deletes records older than 7 days.

**For every event, including `print.status`:**
- Upsert `CounterpartProject {projectId, title, state, stateText, thumbnail (CKAsset, only when it changes), updatedAt, openAsk?, print?{printId, printerName, state, progress, remainingSec, endsAt}}`.
- Print upserts are capped at one per 60 s per print, except on state changes.
- This record is the off-LAN mirror the phone reads (§12).

**Live Activity relay** (new: a Cloudflare Worker at `https://counterpart.dtmont.com/relay/v1`).
- **Why it's needed.** A Live Activity updates on the Lock Screen only from the app itself or from an APNs push signed with the team's key. Apple says that key "must remain private", so it can't ship in the Mac app.
- **Cost.** The Worker holds the key as secrets (`APNS_KEY_P8`, `APNS_KEY_ID`, `TEAM_ID = X7F5F9LR24`). Its only state is rate-limit counters (below); it stores no tokens, payloads or user data. It fits Cloudflare's free tier.
- **The one manual step:** the owner creates the APNs key in the developer portal.
- **Phone → Mac:**
  - The phone sends its push-to-start token (`Activity<PrintAttributes>.pushToStartTokenUpdates`) and each activity's update token (`activity.pushTokenUpdates`) to the Mac. On the LAN they go through `POST /v1/devices/live-activity-tokens` (new); otherwise through a `CounterpartDevice` CloudKit record.
  - Tokens never go to the Worker except inside a push request.
- **Mac → Worker:** `POST /relay/v1/live-activity` with `{token, kind: "start"|"update"|"end", attributes?, contentState, staleDate, priority, alert?}`.
  - **Threat model.** A Live Activity push token is known only to the user's own devices and Mac, so a caller without a token can't reach anyone. The Worker's job is to stop abuse of the team's APNs key: floods, or pushes that aren't Live Activities.
  - **Payload checks.** The Worker validates the payload against the `PrintAttributes` / content-state schema (title ≤ 80 chars, alert ≤ 200 chars) and rejects anything else. It is not a general push relay.
  - **Rate limits,** each kept in a Durable Object with a 24-hour window, keyed as shown:
    - per token (SHA-256 of the token): one update every 10 s and 2,000 a day;
    - per client IP: 20,000 a day;
    - globally: a daily cap.
  - **An APNs `410` or `BadDeviceToken`** adds the token hash to a 30-day deny list, in the same Durable Object.
  - **No per-install authentication in v1.** App Attest is documented as unavailable on Mac. macOS 27 reports are still provisional ([Apple docs](https://developer.apple.com/documentation/devicecheck/dcappattestservice/issupported), [forum](https://developer.apple.com/forums/thread/836329)). If `DCAppAttestService.isSupported` returns true in the shipping Mac app, add attestation of the Mac app as a later hardening step.
- **Worker → APNs:** HTTP/2 to `api.push.apple.com`, with these headers:
  - `apns-push-type: liveactivity`;
  - `apns-topic: com.scantomake.push-type.liveactivity`;
  - `apns-priority`: 5 for progress, 10 for start, paused, done and failed.

  The body is `{"aps": {"timestamp", "event": "start"|"update"|"end", "content-state", "stale-date", "attributes-type": "PrintAttributes", "attributes", "alert", "dismissal-date"}}`. The app sets `NSSupportsLiveActivitiesFrequentUpdates = YES`.
- **When the Mac sends:**
  - `start` on `print.started` (push-to-start, so it appears even if the phone app isn't open);
  - `update` on each `print.status`, `print.paused` and `print.resumed`;
  - `end` on done, failed or cancelled, with a `dismissal-date` 4 hours later.
- **CloudKit works with Developer ID.** The Mac app can use CloudKit and push whether it ships through the Mac App Store or with Developer ID. Apple has allowed CloudKit and remote notifications for Developer ID-signed apps since 2016 ([summary](https://mjtsai.com/blog/2016/06/16/cloudkit-and-map-kit-for-gatekeeper-apps)). Deploy the CloudKit schema to production before the first release, because Developer ID and App Store builds use the production environment.
- **Delivery depends on the Mac app running.** Events are always logged by the companion, which runs as its own `SMAppService` agent. They only reach the phone, CloudKit and the relay while Counterpart for Mac is running.
  - The app opens at login by default (journey.md §3.3).
  - Its **Quit** menu item reads "Quit Counterpart (your phone stops getting updates)".
  - On the next launch, catch-up writes every missed record to CloudKit. It notifies only for terminal events (`print.done`, `print.failed`, `pass.ready`, `pass.ask`) that are still unanswered, once each.
- **Without the relay** (no key yet, or the Worker is unreachable):
  - The phone starts the activity itself when the user taps Print, or the next time the app opens during a print.
  - It updates the activity whenever it gets time: in the foreground, on CloudKit content-available pushes, and on `BGAppRefreshTask`.
  - In both modes the activity renders with `Text(timerInterval:)` and `ProgressView(timerInterval:countsDown:)` up to `endsAt`, so it keeps counting between updates. `staleDate = endsAt + 10 min` shows "Checking…" if nothing has arrived.

### 8.9 Design engine: Blender, or Fusion when the user has it

**Status:** Built. Blender runs only while a pass needs it and closes afterwards. A Fusion pass made and exported a parametric cube without touching David's open documents. Not accepted.

**Both Blender and Autodesk Fusion are optional dependencies of Counterpart.** Printing existing models that need no changes and reprinting projects must work without either. Their installation and readiness only gate the cleanup, design or editing operation that actually uses them, never pairing, printer setup or printing an existing model.

Scan cleanup always uses Blender. Designing a part from scratch ("make something that fits") uses Autodesk Fusion when the user has Fusion installed and set up; otherwise it uses Blender, as it does today. Both are reached the same way: through a bridge inside the user's printer MCP. The design pass only ever talks to the printer MCP, so nothing changes in the app's UI.

**The Fusion MCP: [faust-machines/fusion360-mcp-server](https://github.com/faust-machines/fusion360-mcp-server)** (MIT). Chosen 2026-11-01 as the most-used and most-maintained community server:

| Server | Stars | Forks | Contributors | Commits since Sept | Last push |
|---|---|---|---|---|---|
| **faust-machines** (chosen) | 141 | 33 | 6 | 7 | 2026-10-06 |
| imranduratbegovic/fusion-mcp | 55 | 8 | 1 | 0 | 2026-03-14 |
| Joe-Spencer/fusion-mcp-server (GPL-3.0) | 50 | 9 | 1 | 0 | 2025-04-22 |
| Joelalbon/Fusion-MCP-Server | 41 | 7 | 3 | 0 | 2025-06-12 |
| frankhommers/autodesk-fusion-mcp | 37 | 4 | 3 | 17 | 2026-09-26 |

**Why this one:**
- It is tested on macOS arm64.
- It offers 93 explicit CAD tools that suit an agent working with nobody watching:
  - `create_sketch`, `extrude`, `revolve`, `create_hole`, `create_thread`, `fillet`, `shell`, `boolean_operation`;
  - parameters (`get_parameters`, `create_parameter`, `set_parameter`);
  - `check_interference`, `compare_meshes`;
  - `export_stl`, `export_step`, `export_f3d`;
  - `execute_code` as the escape hatch.

**How it runs.** An MCP client talks stdio to the server, which talks TCP on `localhost:9876` to the `Fusion360MCP` add-in, which talks to Fusion's main thread.

**Install exactly this (pinned):**
- **Server:** `uvx --from git+https://github.com/faust-machines/fusion360-mcp-server@19b9f1e95192 fusion360-mcp-server --mode socket`.
  - The PyPI release (0.1.0, February 2026) crashes under mcp 2.x (issue #30). Main pins `mcp>=1.0,<2`.
- **Add-in:** the repo's `addon/` folder at the same commit, copied to `~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/Fusion360MCP` and set to **Run on Startup**.
- **Known broken:** `measure_distance` (issue #27; fixes in PRs #28 and #29). Counterpart never relies on it, because results are measured from the exported STL with `get_stl_info` and our own measuring tool.
- **Updating the pin:** move it only after the acceptance check below passes on the new commit.
- **Known gap at this pin:** faust issue #12. The add-in refuses every command, `execute_code` included, until a design is open, so `fusion_mcp_new_design` can't start from Fusion's Home tab. The bridge says so in plain words. The acceptance check needs a design open, or a patched add-in.

**The bridge, added to both printer MCPs.** It mirrors `src/blender-mcp-bridge.ts`, which bambu-printer-mcp and mcp-3D-printer-server already share almost line for line, as a new `src/fusion-mcp-bridge.ts`:

- **Configuration, in the same env file as `BLENDER_MCP_*`:**

  | Variable | Value |
  |---|---|
  | `FUSION_MCP_COMMAND` | `uvx` |
  | `FUSION_MCP_ARGS` | `["--from","git+https://github.com/faust-machines/fusion360-mcp-server@19b9f1e95192","fusion360-mcp-server","--mode","socket"]` |
  | `FUSION_MCP_TIMEOUT_MS` | default `180000` |
  | `FUSION_MCP_HOST` | passed through; default `localhost` |
  | `FUSION_MCP_PORT` | `9877`. Blender's MCP add-on already listens on `localhost:9876`, the add-in's default, so Fusion moves off it. Both the server and the add-in read this variable (`addon/Fusion360MCP.py:45`, `src/fusion360_mcp/connection.py:26` at the pin) |

- **Transport:** a stdio `Client`, kept for the life of the printer MCP session, as the Blender bridge does.
- **Tools:**

| Tool | Does |
|---|---|
| `fusion_mcp_status` | `{configured, connected, addinReachable, fusionRunning, tools[]}`. Takes `launch?: boolean`. When it's true and Fusion isn't running, it runs `open -a "Autodesk Fusion" --env FUSION_MCP_PORT=<port>` and waits up to 90 s for the add-in to answer `ping`. |
| `fusion_mcp_call` | `{tool_name, arguments?, timeout_ms?}` passes the call through to a discovered Faust tool with its full content and errors, never retried. This is the same contract as `blender_mcp_call`. |
| `fusion_mcp_new_design` | Opens a new parametric design document, through `execute_code` with `app.documents.add(FusionDesignDocumentType)`. Faust tools need an active design (issue #12), so the pass calls this first. |
| `fusion_mcp_export` | `{output_dir, name}` writes `<name>.stl` (`export_stl`), `<name>.f3d` (`export_f3d`) and `<name>.parameters.json` (`get_parameters`) into the MCP's allowed output directory, and returns their absolute paths. The STL then goes to `get_stl_info`, `lay_flat` and `slice_stl` like any other model. |

**Choosing the engine.** The companion picks the engine for each pass. The agent doesn't choose.
- **Copy an object** (scan cleanup and touch-up): Blender, always.
- **Make something that fits:** Fusion if `fusion_mcp_status` reports `connected` (calling it with `launch: true` first). Otherwise Blender.
- The pass prompt names the engine and the bridge tools for it, and stays generic about the object.
- The pass result records `engine: "fusion"|"blender"`. For Fusion it also keeps the project's `design.f3d` and `parameters.json`, so a later "Ask for changes" pass starts from the parametric design instead of the mesh.

**Setup on the Mac.** Settings → AI has an optional **Design with Fusion** row:

Screenshots: `screens/mac-settings-ai.jpg` and `screens/mac-settings-ai-nofusion.jpg`.

- It shows "Fusion found" or "Fusion isn't installed".
- **Set up** installs the add-in at the pinned commit and adds the five `FUSION_MCP_*` variables to the printer MCP's env file, next to `BLENDER_MCP_*`.
- **The add-in's port.** Fusion is a GUI app, so it doesn't see the MCP's env file. Set up also installs a login LaunchAgent that runs `launchctl setenv FUSION_MCP_PORT 9877`, so Fusion gets the port however it's opened. `fusion_mcp_status` with `launch: true` opens it with `open -a "Autodesk Fusion" --env FUSION_MCP_PORT=9877` too.
- **The bridge checks it's really the add-in.** It sends the add-in's `ping` and needs `pong` back within 2 s, because another listener (such as Blender's) may hold the port.
- Fusion and its licence (including Autodesk's free personal-use licence) belong to the user. Counterpart never ships or requires Fusion.

**Acceptance check** (run on the Mac before the pin moves, and in M1F):
1. Start a "make something that fits" pass for a dimensioned bracket through bambu-printer-mcp.
2. Check that `fusion_mcp_export` returns STL, F3D and parameters.
3. `get_stl_info` matches the requested dimensions within ±0.2 mm.
4. Run a follow-up pass that changes one dimension by 1 mm. It must be a single `set_parameter`, and the re-export must match within ±0.2 mm.
5. `slice_stl` succeeds on the P1S profile.
6. Run steps 1–5 again through mcp-3D-printer-server's bridge.

### 8.10 Updating the printer MCPs from either app

**Status:** Built. bambu-printer-mcp 1.1.54 was installed through the Mac's Settings → Printers → Update on Nov 4. Not accepted: from the phone, and for mcp-3D-printer-server.

**Update** is one tap in Settings → Printers, on the phone or the Mac. It actually updates; it never shows a config file. The phone sends the request through the paired connection (`POST /v1/printers/mcp/<mcpId>/update`, or the `printers.updateMcp` control method on the Mac). The companion does the work and reports progress as events (`mcp.update.started`, `mcp.update.done`, `mcp.update.failed`), so both apps show the same progress bar and result.

**How the companion updates.** It works out how each MCP is installed from the process it runs (§8.2), then runs the matching update in that installation's own directory:

| How it's installed | What the companion runs |
|---|---|
| `npx <pkg>` or `npx <pkg>@<version>` | rewrites the MCP profile's args to `<pkg>@<latest>`; npx then fetches it on the next session start. Nothing global changes. |
| global npm (`<prefix>/bin/<pkg>` or `<prefix>/lib/node_modules/<pkg>/dist/index.js`) | `npm install --global --prefix <that prefix> <pkg>@latest`, using the same `node`/`npm` that installation uses |
| the app's own install (`~/Library/Application Support/Scan to Make/printers/<bambu\|generic>`) | `npm install --global --prefix <that folder> <pkg>@latest` |
| a git checkout (`<dir>/dist/index.js` with `<dir>/.git`) | `git -C <dir> pull --ff-only`, then `npm ci`, then `npm run build`. If the checkout has local changes, it reports "This copy has local changes" and doesn't update. |
| wrapped (for example `ssh … 127.0.0.1` running one of the above) | resolves the wrapped command from the profile's documented target (the remote command or the forced command in the key's `authorized_keys`) and updates that installation as above. If it can't resolve it, it says what it found, in plain words, and offers **Install a fresh copy** (the app's own install). It never just shows the config. |

- **Latest version:** `npm view <pkg> version`, checked once a day and when Settings opens.
- **The update runs between jobs.** It never starts while that printer has a print being prepared or monitored; it waits, and says "Updates after the current print".
- **After an update:** the companion closes that MCP's sessions, opens one again, re-reads its capabilities (§8.2) and shows the new version.
- **On failure:** the previous version stays in use (npm and git leave it intact), and the log is attached to `mcp.update.failed`.
- **The same flow** updates the Fusion MCP pin (§8.9) once a new pin has passed its acceptance check.

### 8.11 Print a published model

**Status:** Built. A MakerWorld caliper imported as Ready with credit, licence, link, the exact file hash and a real P1S estimate. Not accepted: printing it, and the browser download path.

**When this job applies.** The request contains a link to a model page, or a 3MF or STL was shared or dropped together with a link or a model name. The companion sets `kind: "published"`. This job never goes to the Blender or Fusion design pass.

**The worker's tools, for every job (fit, copy, published).** No artificial restrictions:
- `Read`, which includes images: photos, renders, and pages' pictures when they help;
- `WebSearch` and `WebFetch`, for published specs of known objects and model pages;
- the browser integration (`--chrome`) when Chrome and the extension are present, for logged-in pages and downloads;
- the printer MCP, with its Blender, Fusion and MakerWorld tools.

`--strict-mcp-config` stays, so a pass doesn't load every unrelated connector the user has, but nothing the job needs is withheld. The pass's sealed folder still protects the originals (hash-checked inputs).

**Rules:**
- **Never rebuild a published model from its pictures** when the designer's file exists. Pictures on a model page are for picking a variant, never geometry to copy.
- **Print what the designer published,** with only the user's choices applied: variant, plate, colours, quality.
- **Edits the user asks for are made to the designer's own file,** through the printer MCP's Blender or Fusion bridge, never by redrawing the model. Examples: "put the Counterpart logo where the maker's logo is", "add my name", "make the hook 5 mm longer". The edit touches only that region; everything else, scales and fit features included, stays exactly as published. The project keeps the original and the edited file side by side, and "Compare" shows both. Counterpart's own mark is in `docs/brand/counterpart-mark.svg`.
- **Credit the designer.** The project's title is the model's name; the project page shows "by *designer* on *site*" and links back to the page. Printing goes through the user's own download, and Counterpart never re-hosts the files.

**Flow:**

1. **Read the page** (`kind: "published"`, stage "Reading the model page").
   - The companion fetches the page through the user's own browser session, never a scraper. That means Safari on the Mac, or a `WKWebView` the user can see.
   - It extracts the title, the designer, the licence, and the list of print profiles and files with their names, plates and sizes.
   - If the page can't be read, the project goes straight to step 2 with the link.
2. **Get the designer's file. The worker downloads it itself, on the user's Mac, with the user's own logins.** It runs on the user's own Mac in their own session, so it has the tools a person sitting there would. It isn't sandboxed into a narrower kit. In order:
   1. **The user's browser, driven where the user can see it.** The worker runs with Claude Code's browser integration (`claude --chrome`, the Claude in Chrome extension), which uses the user's own Chrome profile and logins. It opens the page, selects the matching print profile and clicks Download. The file lands in `~/Downloads`, where the companion picks it up by name and time.
      - Codex workers use their computer-use tool the same way.
      - This works for Printables, Thingiverse and any other site.
   2. **The `~/Downloads` pickup.** A matching `.3mf`/`.stl` that appears in `~/Downloads`, from the browser step or from the user downloading it by hand, is used at once.
   3. **Only when neither produces the file** (not signed in, or no browser integration) does the project ask the user: state `needs-you`, Ask type `file`, "Sign in to MakerWorld in Chrome, or download *model name* and share it with Counterpart". Its buttons are **Open in Safari**/**Open in Browser**, the Share sheet, Files, drop, and the Mac's `~/Downloads` watch.
   - **No reading of stored logins.** Counterpart and its worker never read cookies, keychain items or other apps' token stores. A site's login is used only through the user's own browser session.
   - **Download tools in the printer MCP:** used only if a printer MCP offers one through its own documented sign-in. None does today.
   - **Never a substitute model.** If the file can't be obtained, the pass stops with that Ask. It does not model a look-alike from the page's pictures. A look-alike of a measuring tool or a fitted part is wrong in ways nobody can see.
3. **Pick the variant and plate** (stage "Choosing the parts").
   - Use the file's plates and objects (`list_3mf_plate_objects`) and the profile names, matched to the user's words. Example: "150 mm" plus "depth gauge" picks the plates and objects whose names contain those words.
   - Several objects requested "on one plate" are arranged with `slice_stl` `arrange: true`.
   - If the words are ambiguous or don't match anything, raise an Ask that lists the file's plates and objects by name, with thumbnails.
4. **Colours.** Map the user's colours ("black and yellow") to AMS slots with `get_printer_filaments`. Keep the file's own filament assignment, which a published 3MF already carries per object, and slice with `load_filaments` (one profile per filament number). Never pass `load_filament_ids`: `slice_stl` refuses it for 3MF input (§8.5). Apply `ams_mapping` at `print_3mf`. A colour that isn't loaded raises an Ask: "Yellow isn't loaded. Use *closest*, or load it first?"
5. **Print.** Use the normal print sheet (§5.5), with the file's profile settings preselected. `slice_stl` slices with `slice_plate` set to the chosen plate. The print, monitor and notifications work as for every other job (§8.5–8.8). "Did it fit?" (§5.4) becomes "Did it come out right?".

**What the user sees.** The New sheet (§5.2) accepts a pasted link. Typing or pasting a URL turns the field into a link card with the page's title and thumbnail, and the action becomes **Get this model**. The Share sheet from Safari or the MakerWorld app does the same.

### 8.12 Remote MCP: `/v1/mcp`

A paired device or remote MCP client reaches every configured printer MCP through the companion's existing front door (`services/companion/src/remote-mcp-http.ts`, `services/printer-handoff/src/remote-mcp.ts`). `/v1/mcp` serves all destinations and `/v1/mcp/<destinationId>` serves one, as stateless Streamable HTTP. It uses the same pairing, tokens and revocation as the phone. A remote client always gets read and never the phone's scopes. Design: [`docs/design/remote-mcp.md`](../remote-mcp.md).

**Status:** Built. Not accepted.

### 8.13 The companion's HTTP surface

These are the routes the phone, Android, Linux and remote clients use, from `services/companion/src`:

| Route | What |
|---|---|
| `/healthz` | liveness |
| `/v1/pair`, `/v1/pair/icloud`, `/v1/pair/nearby{,/reveal,/result}`, `/v1/auth/refresh` | pairing and credentials |
| `/v1/devices`, `/v1/devices/<id>`, `/v1/devices/live-activity-tokens` | paired devices, Live Activity tokens |
| `/v1/settings`, `/v1/settings/ai/test`, `/v1/settings/fusion/setup` | shared settings (§5.9) |
| `/v1/objects` (`GET`, `POST` incl. `starterId`), `/v1/objects/<id>` (`PATCH`, `DELETE`) | projects |
| `/v1/objects/<id>/…`: `scan`, `model`, `model.stl`, `ask`, `asks/<id>.jpg`, `plate-selection`, `settings`, `duplicate`, `photos`, `capture`, `capture-depth`, `capture-camera`, `reconstruction`, `reconstruction-preview.stl`, `start`, `corrections`, `closeup`, `estimate`, `filaments`, `colour-mapping`, `printer`, `print`, `print/pause`, `print/resume`, `print/cancel`, `print-confirmation`, `camera.jpg`, `prints/<id>/frames/<id>.jpg`, `original/<n>`, `passes/<id>/activity`, `renders/…` | everything on a project page and print sheet |
| `/v1/objects/printers`, `/v1/objects/printers/<id>/{route,mcp}`, `/v1/objects/printers/<id>/camera.jpg` | printers, connection route, which MCP |
| `/v1/printers/mcp/<id>/update` | MCP update (§8.10) |
| `/v1/events` | long-poll event log (§8.7) |
| `/v1/saved-projects/<id>/captures/…` | captures, detail stills, scan processing, model assets, size, maker size |
| `/v1/printer-handoff/bundles…`, `/v1/printer-handoff/elicitations…` | print bundles and the MCP's own questions |
| `/v1/blender{,/check,/update}` | Blender add-on status and repair |
| `/v1/mcp`, `/v1/mcp/<destinationId>` | remote MCP (§8.12) |

## 9. Notifications and Live Activities

Both apps notify. Events come from §8.7 and travel by the routes in §8.8. Android posts its own notifications from the same event log (§16).

**Status:** Built. Duplicate alerts are suppressed, and the Live Activity recovers when its update token changes. Not accepted: delivery of each event type on a real print.

### 9.1 What the user gets

**Status:** Built. Not accepted: delivery of each event on a real print.

Screenshot: `screens/phone-notifications.jpg` (an approximation: the system draws the Lock Screen).

| Event | iPhone notification | Actions | Level | Mac |
|---|---|---|---|---|
| `pass.ready` | "*Title* is ready to print" · size and estimate, with a render | **Print** (opens the print sheet), **Ask for Changes…** (text input, sent in the background) | active | on |
| `pass.ask` | "*Title*: *the question*", with the region picture | **Camera** (opens it), **Best Guess** (background) | active | on |
| `print.confirm` | "*Printer* needs a yes before printing *title*" | opens the confirmation | time-sensitive | on |
| `print.started` | no banner; the Live Activity starts | — | passive | off |
| `print.first-layer` | "*Title*: first layer's down", with the frame | **Open**, **Pause** | passive | off |
| `print.milestone` | "*Title* is halfway" · time left, layer, printer, with the frame | **Open**, **Pause** | active | off |
| `print.paused` | "*Printer* paused *title*" · reason, with the frame | **Open**, **Resume** | time-sensitive | on |
| `print.done` | "*Title* is done. Take it off the plate.", with the frame | **Open**, **It Works** (background), **Needs Changes** (text input, background) | active | on |
| `print.failed` / `print.not-started` / `pass.failed` | what happened and what to do | **Open** / **Try Again** | time-sensitive (print) / active (pass) | on |
| `print.unreachable` | "Lost contact with *printer*. Still trying." | — | passive | off |

Each row has its own switch in Settings → Notifications, on both devices. The milestone choice is in the same place (§8.6).

### 9.2 iPhone: subscriptions, extension and actions

**Status:** Built. Not accepted.

**Subscriptions.** The phone creates these once, with fixed IDs so it's idempotent: `CKQuerySubscription`s on `CounterpartEvent`, in the private database, `firesOnRecordCreation`. There is one per category, because a subscription carries one category:

| ID | Predicate (`type`) | Category |
|---|---|---|
| `ev-ready` | `pass.ready` | `READY` |
| `ev-ask` | `pass.ask` | `ASK` |
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

**CloudKit's limits, stated honestly.** CloudKit coalesces pushes and can leave fields out to stay under APNs' size limit. Apple: "don't rely on them for specific changes".
- Discrete events (ready, ask, plate, milestone, done, failed) are reliable enough as alerts. When the app opens, it always reconciles from the records, never from the pushes.
- Silent `proj-silent` pushes are throttled by iOS, so they can't carry per-percent progress. That's what the relay (§8.8) is for.
- Everything needs the same iCloud account on both devices. Without iCloud, the phone gets events only from the LAN long poll while the app is running or has background time. Settings says so.

**Actions:**
- Background actions without a destructive outcome run without opening the app: **Ask for Changes…** (`UNTextInputNotificationAction`), **Best Guess**, **Pause** and **Resume**.
- Each one sends its command to the Mac:
  - directly on the LAN, through the existing routes: `POST …/corrections`, `…/closeup`; pause and resume go through the new `POST …/print/pause` and `…/print/resume`;
  - otherwise as a `CounterpartCommand` record (§9.3).
- **Print** and **Camera** open the app at the right screen.

**No double banners.**
- In the foreground, `userNotificationCenter(_:willPresent:)` suppresses events the app already showed from its LAN long poll, matched by `eventId`.
- The in-app UI then shows the change instead.

### 9.3 Commands from anywhere (CloudKit)

**Status:** Built. Not accepted away from home.

- **How a command travels.** When the phone can't reach the Mac directly, it writes a `CounterpartCommand` record into the same private zone:
  - `{commandId, type, projectId, payload, photos[CKAsset], createdAt}`, where `type` is one of `print | correct | answerAsk | confirm | pause | resume | cancel`.
- **How the Mac receives it.** The Mac app subscribes to that record type (content-available) and also fetches on launch and on wake.
  - It runs each command through the control socket method that already does the same job: `objects.print`, `objects.correct`, `objects.answerCloseup`, `objects.answerPrintConfirmation`, plus the new pause, resume and cancel.
  - It writes the result back as `status: done|failed` with a message, and deletes the record a day later.
- **Commands are bounded.** The Mac acts only on commands from its own private database that are less than 10 minutes old.
- **The print confirmation is unchanged.** Starting a physical print still answers the printer MCP's own confirmation:
  1. it arrives on the phone as `print.confirm`;
  2. the user's answer goes back as a `confirm` command.

### 9.4 Live Activity

**Status:** Built. Test start, update and end were seen on the Lock Screen through the Sandbox relay. Not accepted: a real print, the Watch, production push.

Screenshots: `screens/phone-lock.jpg` and `screens/phone-island.jpg` (approximations: the system draws the Lock Screen and the Dynamic Island).

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

**Status:** Widgets are built. Control Center controls, App Intents and Siri, Spotlight, the Share extension and the Watch are not built.

Screenshots: `screens/phone-widgets.jpg` and `screens/phone-widgets-lock.jpg` (approximations: the system draws the Home Screen and the Lock Screen).

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

### 9.6 Performance budgets

**Status:** Background budget still not accepted. Re-measured Nov 5, 2026, 20:04–20:10 UTC on installed Release 202611051513 with `footprint -p <pid> --noCategories` over `ssh mac`: UI PID 52075 **260 MB window open**, **543 MB lifetime peak**; companion server PID 52878 **85 MB**, agent node PID 52167 **14 MB**, companion launcher PID 52072 **3520 KB**. Open-window UI is below 350 MB; companion server is below 120 MB. Immediately hiding the app gave 262 MB; immediately closing its project window gave 263 MB (both above 150 MB), then the original window was reopened. These immediate samples are not a settled menu-bar-only measurement. `vmmap -summary 52075` while hidden showed about 134 MB swapped owned graphics, but no allocation history establishing a fixable cause. No memory fix claimed. Earlier build 1355 measured 348 MB open / 349 MB closed, peak 591 MB on Nov 3.

Counterpart runs all day in the menu bar and on the phone, so it has to be cheap when nothing is happening.

| State | CPU | Memory (physical footprint) | GPU |
|---|---|---|---|
| Mac, menu bar only | < 1% | < 150 MB | none |
| Mac, window open, idle on a project | < 3% | < 350 MB | no continuous frames |
| Mac companion (node), idle | < 1% | < 120 MB | none |
| iPhone, Home or a project, idle | < 5% (Instruments) | < 250 MB | no continuous frames |

- **3D models show as a still image by default.** That's the companion's render or a one-time snapshot, cached per file version. The live RealityKit view runs only while the user drags, pinches or taps **Explore in 3D**, and returns to the still image about 3 s after the last touch.
- **One live 3D view per window at most.** It pauses when the window or app isn't visible.
- **Models are loaded once per file version** and never rebuilt by a refresh. Lists update only what changed.
- **Only Release builds are installed**, never Debug builds or ones that include Xcode Previews.
- **No background helpers between jobs.** Blender (and Fusion, when Counterpart opened it) starts when a touch-up or design pass begins and quits when that pass ends. If another pass is already queued, it carries straight on; otherwise it quits right away. Counterpart only ever quits a Blender or Fusion it started itself, never one the user opened. Between jobs, all Counterpart runs is the menu-bar app and the companion.
- **Every UI PR reports its numbers:** `top -l 5 -pid`, `footprint`, and an Instruments energy log for the phone.

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

**Status:** Built (`HandheldCapture.swift`, `HandheldDepthRecorder.swift`, `tools/mac-reconstruct samples`). Not accepted. A Codex review found defects that remain open: 24 frames at 10 fps covers only ~2.4 s of nearly identical views; `ObjectMasker` erases the object when a hand is nearer than it; and `reconstruct.ts` discards the reconstruction's stderr. Its advice: try Apple's own masking (`--no-masks`) first, then move to sharp still photos with depth and turn-pause-capture guidance.

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

### 11.1 On a scan rig

**Status:** Built (the rig mode and its Kass 3D credit). Not accepted: the §11.1 pass criteria on a real rig.

- **What the rig is.** The rig is "Fully 3D-printed 360° photography turntable" by **Kass 3D**, published on MakerWorld:
  - <https://makerworld.com/en/models/1531561>
  - Released 2025-06-18.
  - Profiles for most Bambu printers, including an A1 mini version.
  - Printed in PLA; the full kit takes about 25 h.

  The phone clamps to an arm that swings around a round platform, with a backdrop panel behind the object. Counterpart links to the model page and never redistributes its files (§15).
- **Why it gives the best scans:**
  - The object stays still and the phone moves. That's the condition Object Capture and ARKit tracking are built for.
  - The phone is clamped and swings slowly at a fixed radius, so frames are sharp and the distance stays constant.
  - There's no hand to mask.
  - If the backdrop moves with the arm, every frame has the same plain background. Masking the object is then a colour key, not a segmentation problem.
- **Capture path. Test first which of the two applies:**
  1. **Object Capture (preferred).** Run the existing `ObjectCaptureSession` with the phone on the arm.
     - If world tracking stays locked through a full ring, use it unchanged. The only addition is the ring guidance HUD.
     - Tracking can still lock because the room around the backdrop stays visible.
  2. **Mac reconstruction.** If tracking drifts, because the backdrop fills the view and moves with the camera, use the §11 stills pipeline:
     - full-resolution LiDAR stills;
     - masks from a chroma key on the backdrop colour, intersected with the LiDAR depth band;
     - `PhotogrammetrySample` with `objectMask` and no gravity;
     - `isObjectMaskingEnabled = true`, so the flip between ring 2 and ring 3 is allowed.

     Hand subtraction isn't needed.
- **Guidance.** Three rings: clamp low and level; clamp high and tilted down; flip the object and clamp low.
  - Shots fire by themselves every ~10° of arm rotation, about 36 per ring. Rotation is measured from the phone's gyroscope (`CMMotionManager` attitude yaw), so it works even when visual tracking can't.
  - Exposure follows §11: 1/250 s or faster.
  - Each ring fills its own progress ring. A gap in a ring sends you back to fill it.
- **Detecting the rig.** The app asks once ("Using the scan rig?") and remembers the answer. It never infers the rig silently.
- **Pass criteria.** The same as §11, plus three repeat scans on the rig that agree within 0.5% on every axis. The rig is the repeatable bench for the in-hand and walk-around tests too.

## 12. Sync and data

**Status:** Built (CloudKit project mirror and events).

- **The Mac is the source of truth.** Projects, inputs, passes and results live in the companion's store, as today.
- **On the home network or a VPN,** the phone talks to the companion over the existing pairing (pinned key, addresses in order; journey.md §3.4).
- **Away from home,** the Mac mirrors a project summary to the user's private CloudKit database: title, state, render thumbnail, the open Ask, and print progress.
  - The phone can then show Home, answer an Ask with photos (uploaded as `CKAsset`, collected by the Mac) and see prints from anywhere.
  - This needs no VPN and no server.
  - Full meshes are fetched only on the LAN or VPN.
- **Privacy.** Everything stays in the user's own iCloud and on their own Mac. Counterpart has no account system. Its only server is the stateless Live Activity relay (§8.8), which stores nothing.

## 13. Build plan

Each milestone ends in an on-device check with screenshots compared against `screens/`, and a VoiceOver pass on the new screens.

Status per milestone, checked on 2026-11-04: M0 Accepted (React Native gone; pairing in daily use). M1, M1F, M2, M4 and M5 Built, with acceptance partial as §0 lists. M3 Built; real-print Live Activity not accepted. **M3b accepted on device Nov 4:** a two-part guitar pick printed in black and yellow AMS colours on the P1S, from the iPhone. M6: widgets only.

| # | Milestone | Done when |
|---|---|---|
| M0 | **Foundation.** `CounterpartKit` package; pure-SwiftUI iPhone app shell; pairing ported out of React Native; React Native removed. | The app pairs by QR and by the nearby card on a real iPhone, and the app bundle no longer contains React Native |
| M1 | **Back end and notifications.** All of the following:<br>• fixes: `remaining` → `timeRemaining`, "printed" set only on finish, catalog de-duplication, Codex `config.toml` source<br>• `PrinterSessionPool`<br>• `counterpart_printer_info` and `counterpart_print_progress` (with the generated HMS and stage tables), plus `taskId` in the `print_3mf` result, in bambu-printer-mcp<br>• print monitor<br>• event log, `GET /v1/events` and `events.wait`<br>• Mac `EventRelay` (Mac notifications and CloudKit)<br>• iPhone subscriptions, Notification Service Extension and background actions<br>• structured `pass.*` events, with a generated title and a what-changed summary | On a real P1S print, all of these hold:<br>• with the phone locked and on cellular, the halfway notification arrives with a camera frame, and so does "done"<br>• restarting the companion mid-print sends no duplicate milestone<br>• a print that never starts produces `print.not-started` within 3 min<br>• replying to a "ready" notification from the Lock Screen starts a new pass |
| M1F | **Fusion design engine.**<br>• `fusion-mcp-bridge.ts` with `fusion_mcp_status`, `fusion_mcp_call`, `fusion_mcp_new_design` and `fusion_mcp_export`, in bambu-printer-mcp and mcp-3D-printer-server, each through its own repo's release process<br>• the companion picks the engine per pass<br>• Mac Settings → Design with Fusion | The §8.9 acceptance check passes through both MCPs on the Mac |
| M2 | **iPhone core.** Home, New, Project (all states), Ask card, Settings and About. | Each screen matches its mockup on iPhone 18 Pro, iPhone 17e, Duo closed and iPad |
| M3 | **Print and Live Activity.**<br>• print sheet (printers from both MCPs, slice estimate, colour map, quality, strength)<br>• Printing screen with the camera<br>• pause, resume and stop<br>• Live Activity, with the relay Worker once the APNs key exists<br>• the `slice_stl` quality arguments in both MCPs<br>• the Counterpart tools, `camera_snapshot`, `get_printer_filaments`, pause and resume in mcp-3D-printer-server<br>• `CounterpartCommand` for use away from home | All of these hold:<br>• a real P1S print from the phone shows the Live Activity on the Lock Screen and the Mac menu bar, counting down<br>• a full run on OctoPrint's virtual printer and a Klipper simulator through mcp-3D-printer-server delivers progress, the halfway notification and done<br>• Pause from the Lock Screen pauses the P1S |
| M3b | **Multi-colour.** The pass contract gains `parts`; per-body STL export through the Blender bridge; `counterpart_make_3mf`; `slice_stl` with `load_filaments` (filament numbers carried in the 3MF); `print_3mf` `ams_mapping`; per-part colour map in the print sheet. | A two-part result prints in two AMS colours on the P1S, from the phone |
| M4 | **Mac rebuild.** SwiftUI scenes, main window, inspector, print sheet, popover, Settings with de-duplicated devices, drop-to-create. | The same project is visible and actionable on the Mac and the phone at once, and re-pairing a phone leaves one row |
| M5 | **Scan in hand and on a rig.** As specified in §11 and §11.1, including the test of which rig capture path holds tracking. | The §11 pass criteria are met on a real iPhone in hand, and §11.1 on the rig |
| M6 | **System surfaces.** Widgets, Control Center control, App Intents and Siri, Spotlight, Share extension, iPad keyboard shortcuts. | Each one is demonstrated on a device |

**Reuse, don't rebuild:**
- The `feat/counterpart-project-workspace` branch already has, in the companion: printer listing across MCPs (`objects/printers.ts`), live filament inventory, retained activity, stable device identity, and the external-editor actions on the Mac. M1–M4 build on those endpoints.
- Printing, slicing, orientation and print confirmation stay in bambu-printer-mcp and mcp-3D-printer-server. Every PR that touches them names the MCP tool it uses.

## 14. Open questions and the one manual step

1. **Distribution: decided.** TestFlight for the iPhone app (App Store name *Counterpart 3D*, public beta group *Counterpart Public Beta*), and Developer ID with Sparkle for the Mac (v2.0-beta.4 notarized and published at counterpart.dtmont.com/beta.html). The procedure is in [`docs/distribution.md`](../../distribution.md). Still open: Apple's approval of the external build, and production push delivery.
2. **The APNs key: done.** The relay is provisioned for Sandbox and Production.

## 15. Credits

- **Scan rig:** "Fully 3D-printed 360° photography turntable" by **Kass 3D**, on MakerWorld: <https://makerworld.com/en/models/1531561>.
  - It's licensed under MakerWorld's Standard Digital File License, so Counterpart only links to the page. It never bundles, re-hosts or modifies the files.
  - Everywhere the app mentions the rig (New, Help, scan tips), it names Kass 3D and opens the MakerWorld page, so prints, likes and reviews go to the designer.
  - The designer describes it as a recreational and casual-photography rig, not professional equipment. Counterpart's help says the same.
- **Fusion MCP:** [fusion360-mcp-server](https://github.com/faust-machines/fusion360-mcp-server) by Faust Machines and its contributors (MIT), used through the printer MCPs' Fusion bridge at a pinned commit.
- **Print flow reference:** Bambu Handy and MakerWorld's Prepare to Print.

## 16. Android

A native Kotlin/Jetpack Compose client (`android/`, minSdk 26, target 35, application id `com.scantomake`). Screens: Welcome, Pairing (QR or nearby), Home, Starter projects, New project, Scan (ARCore capture), Project with plates and reconstruction review, Printing, Printer settings, Settings. It pairs, sends descriptions, photos, links and scans, and follows the work and the print. Its print sheet has capability-gated copies and layer pauses. It pauses and stops prints, and posts notifications ("Ready to print", "Did it fit?"). Once a print finishes it stops refreshing the camera and hides Pause, Resume, Stop and time left. Build: `./gradlew assembleDebug`. Details: [`android/README.md`](../../../android/README.md).

**Status:** Built (debug APK; unit tests and lint pass). **Not accepted: it has never run on a device or an emulator**; the T3 emulator failed to start. No signed release.

## 17. Linux desktop

A Tauri 2 app (`apps/linux`) for Ubuntu 26.04 x86_64, shipped as a `.deb` and an AppImage. Its frontend is React/TypeScript with Three.js, which loads only for Explore in 3D. It talks to the bundled companion through the private control socket and never serves an admin API or talks to printers directly. `tools/linux-host` provides setup, the user service and the credential-resolving model worker. `tools/linux-reconstruct` provides COLMAP/OpenMVS reconstruction with its own Python. Tailscale reaches it from the phone ([`docs/tailscale-setup.md`](../../tailscale-setup.md)). Build: `apps/linux/scripts/bundle.sh`.

**Status:** Built. Repair, retained projects, starters, the plate/STL viewer and phantom-printer removal were observed on software-rendered XFCE (agents-136, Xvfb :93). **Not accepted:** pairing a phone, printing, the AI provider and reconstruction review.

## 18. Backlog: work that never landed

Every unmerged branch and dirty worktree was preserved on 2026-11-04 as a pushed tag; `git ls-remote --tags origin 'archive/2026-11-04/*'` lists all 83. Don't delete them. The notable ones:

| Tag | What | Why it matters |
|---|---|---|
| `archive/2026-11-04/agents-173/dirty/t3-98ed2eba` | KAN-200 scan-repair colour sampler and fixed-rim fill, uncommitted, 259 lines | core cleanup work (§5.3) |
| `archive/2026-11-04/agents-173/branch/KAN-159-dependency-manager` | dependency manager, 3,178-line WIP | install/update of tools |
| `archive/2026-11-04/Mac-mini/dirty/KAN-217-accept` | `DeviceCameraAcceptanceUITests.swift` | camera acceptance on a device |
| `archive/2026-11-04/github/KAN-184-compare-versions` | Compare versions (§5.4 menu) | listed in the PRD, not built |
| `archive/2026-11-04/github/KAN-201-newest-codex` | "Update Codex" | provider maintenance (§7.5) |
| `archive/2026-11-04/github/KAN-198-mac-judge-tool` | Mac judge tool | |
| `archive/2026-11-04/github/KAN-209-caliper` | caliper work | starters (§5.11) |
