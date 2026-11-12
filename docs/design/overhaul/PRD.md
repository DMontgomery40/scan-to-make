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
| Automatic iCloud pairing (§5.10) | Built. **Accepted on device Nov 5**: a fresh install on David's iPad Air (iPadOS 27.2, build 202611052142) connected to the Mac by itself because they share an iCloud account, with no code or Allow (David: "the ipad just connected cause they shared icloud"); the Mac recorded "iPad (FB25)" at 21:56:59Z | The companion doesn't record which path a device connected by (`pairedVia` says `lan`), so the Mac side can't prove it alone |
| Home, search, title, grid, no fake controls (§5.1) | Built; Home checked on device Nov 2–3. Search stays above its filtered list and says how many projects match with Show All on Mac (#326), Android, iPhone/iPad and Linux (#329) | New search behavior: installed-app verification pending; stays connected for an hour (never "Mac isn't answering") |
| Starter projects (§5.11) | Built on iPhone, iPad, Mac, Android, Linux; reachable with projects on every layout (§6.1) | Not accepted; rig original import and physical prints |
| Scanning: Scan it (in a hand or on any arm), in hand (§5.3, §11) | Built; a physical iPhone scan → Mac cleanup → model observed Nov 4 (Leatherman Wave+). Nov 9 (#420): one capture (Apple's freeform, no flag, no mode), the app takes a photo each 5° round it, Done after 60 from two heights, a stopped scan's photos stay findable, and the Mac cuts away what it stood on. After a scan, New asks Copy / Fit / Save (a scan no longer implies a copy) and, for a fit, how its exact size is settled — look up and confirm, measured, or scan estimate | Not accepted: geometry, dimensions, print fitness; in-hand recorder defects (§11) |
| Project page, rename, Project Settings, Done/Works (§5.4) | Built; Done/Works checked on both Nov 2–3 | rename and settings acceptance partial; Compare versions not built (§18) |
| Project pictures (§5.1, §5.4, Nov 10): the gallery (each printable thing in its spool, Together from the pass's seats, what was scanned), See it together, and a project's picture everywhere as the object alone on the stage | Built on every layout (#451). Real fit pass (code engine, the bike-oil bottle, calipers 65 × 28 × 145) gave one seat; See it together on a copy of the Wall holder gave three; both drawn with the bottle(s) in place. Pictures drawn for all 17 of David's projects on a throwaway copy | Not accepted. Per-part colours of a multi-colour design wait for per-part meshes; Linux draws no pictures; prints from before this record no spool |
| Conversation bubbles; "DONE" marks Done without a pass (§5.4.1) | Built | Not accepted |
| Change request reliability | Built: unavailable completion checks log the failure and return a visible sentence; the message stays saved without starting a pass | Not accepted in the installed app |
| Print sheet: printer, estimate, quality, strength (§5.5) | Built; prints from the Mac app's Print button Nov 3 | — · slice estimate: from the MCP's `inspect_print_file` (§8.0 item 9) |
| What will print: the sheet shows the printer MCP's pictures of the exact sliced file, and Print sends only that file (§5.5; David, Nov 5) | Built on Mac and iPhone (#321), Android and Linux (#324); drawn by bambu-printer-mcp 1.1.60+ / mcp-3d-printer-server 1.2.34 (`inspect_print_file` `include_preview`). **Seen in the Mac app Nov 5** (202611050844, caliper card `1f1c5515`): "What will print" shows *Top, as it sits on the bed* and *Bed side, turned over toward you*, and **Print on Bambu Lab P1S** is enabled once they load (not pressed). Screenshot: `~/scan-to-make-work/mac-202611050844/print-sheet-what-will-print.png` | Not accepted: a print from the sheet; the iPhone sheet on device; Android API 35 emulator paired with Mac Nov 5: caliper `1f1c5515` Print sheet displayed both MCP pictures, 1 h 10 m / 14 g / 15 layers; Print enabled, not pressed. Screenshot: `~/scan-to-make-work/android-linux-20261105/android-caliper-print.png`. Linux Nov 5: added P1S through Settings, imported Mac caliper 3MF into local project `1b7a26a2`, installed Bambu Studio 02.09.01.70 and configured the MCP’s slicer/profile paths; both MCP pictures displayed, 1 h 11 min / 14.4 g / 15 layers, Print enabled and not pressed. Screenshot: `~/scan-to-make-work/android-linux-20261105/linux-caliper-preview-enabled.png` |
| Per-part AMS colours for a multi-colour 3MF (§5.5, §8.5) | Built on Mac (#293) and iPhone (`5864c56`) | **Accepted on device Nov 4** (iPhone + P1S, David: "Yes, both colours are correct") · nearest-spool matching **moved to the MCPs** Nov 5 (`counterpart_propose_filaments`, bambu-printer-mcp 1.1.63 / mcp-3d-printer-server 1.2.37, §8.0 #7); the proposal is not yet re-accepted on device · the rows are only the chosen plate's filaments, from `list_3mf_plates` (bambu-printer-mcp 1.1.73 / mcp-3d-printer-server 1.2.53, #378); until those are installed through Update the sheet says to update |
| A colour design from before colour parts asks before printing in one colour (§5.5) | Built (#306) | Not accepted |
| Copies, pause before a layer (§5.5) | Built; P1S paused itself before layer 3 on Nov 3 (Mac, pre-release MCP build) | Not accepted on the published MCPs; mcp-3D-printer-server parity not on npm · per-slicer rules for copies and supports: *In the app today; moves to the MCPs (§8.0).* |
| Plates of an imported 3MF; per-plate print and completion (§5.5) | Built; the plates and their pictures come from the printer MCP's `list_3mf_plates` (bambu-printer-mcp 1.1.69, mcp-3d-printer-server 1.2.49) | Not accepted. The scan-platform starter came in as MakerWorld's single 850 × 521 mm STL, not the six-plate kit 3MF (Nov 6); the starter's download is starter-download's fix |
| Pause, Resume, Stop (§5.7) | Built; worked from the Mac UI over local FULU Nov 3 (hand-copied MCP code) | Not accepted on the published MCP; phone Stop |
| Bambu Cloud print route (§8.2) | Bambu refused cloud printing (-3120, HTTP 403) Nov 3. Fixed the way Bambu Studio sends it (`start_local_print_with_record` first), published in bambu-printer-mcp 1.1.55 and mcp-3d-printer-server 1.2.29 (#102, #56) | Not accepted: install through the app's Update, then a print with Connection = Bambu Cloud |
| FULU through mcp-3D-printer-server | — | **open bug**: crashes on its config-dir mount |
| Copy a designer's 3MF and change one thing (§8.5) | **Failed on the printer Nov 4** (caliper card `1f1c5515`, "use this caliper card exactly but add the counterpart logo"): pass 3 was given the merged STL, rebuilt a bare 3MF, lost the designer's print settings and painted markings (ticks and vernier scale missing); the MCP sliced it at preset values and Strong lowered 100% infill to 25%; the card doesn't fold. **Fixed and installed Nov 5:** every pass edits the designer's 3MF, and a pass whose result's `get_slice_settings` differs from the designer's file is refused (#318, Mac 202611050554). Both MCPs slice a 3MF with its own process and make strength a floor (bambu-printer-mcp 1.1.59, installed through the app's Update; mcp-3d-printer-server 1.2.33 published) | Not accepted until David redoes the card in the app and prints it · slot 2 held yellow where the design said white: no white spool was loaded, and the old app matching chose the nearest colour silently. The MCP's proposal now says so on that row ("White isn’t loaded. Closest loaded: A2 Sunflower Yellow PLA Basic.", or where white is when it's on the other feed); not yet seen on the card in the app |
| Print a published model (§8.11) | Built; MakerWorld caliper import + real P1S estimate observed | Not accepted: print, browser download path · 3MF/G-code metadata parsing: *In the app today; moves to the MCPs (§8.0).* |
| Notifications (§9.1) | Built; OS permission on | Not accepted: delivery of each event type |
| Live Activity (§9.4) | Built; Sandbox relay test start/update/end seen on the Lock Screen | Not accepted: real print, Watch, production push |
| Printer camera (§8.6.1) | Built; 12 reads in 23 s, ≤ 8.4 KB, 0 errors | sustained acceptance |
| Settings on both, the same (§5.9) | Built; keep-awake toggled from the phone changed the Mac. **Seen on device Nov 4** (David, iPhone build 202611041132): Settings shows Connected while the Mac is reachable. The brief "Checking…" state before the first answer (`b845a545`) is covered by the engineering test, not a device check | — |
| Update both MCPs from either app (§8.10) | Built; bambu-printer-mcp 1.1.61 installed through Settings → Update on the Mac and on Linux Nov 5; on Linux, mcp-3d-printer-server 1.2.34 too (Update of the app's own copy with no printer, #320) | from the phone; the Mac's mcp-3D is still a hand-built checkout |
| AI provider routing (§7.5) | Built: Claude Code, Codex CLI, Anthropic/OpenAI API, OpenAI-compatible endpoint, Off | real Claude cleanup observed Nov 4; OpenCode not supported yet |
| Design passes plan how the object prints (FDM prompt pack, `docs/design/fdm-prompt-pack`) | Published in bambu-printer-mcp 1.1.52 / mcp-3D-printer-server 1.2.26 (#99, #52) | Not accepted |
| One app named Counterpart, one icon (§10) | Built; `/Applications/Counterpart.app` is the only registration for `com.scantomake.mac` | — |
| One design engine: the printer MCP's code engine (§8.9) | Stage 1 built: a pass uses it whenever the printer MCP offers `cad/1` and `cad_status` says ready; Settings → the code design engine on every layout. One real holder pass and its 1 mm change ran through the companion against bambu-printer-mcp PR #136 (unpublished), Nov 10 | Not accepted · waits for both MCPs to publish `cad/1`, Update, and David's own passes; stage 2 deletes Blender and Fusion (§8.0 item 13) |
| Fusion design engine (§8.9) | Built; a private real-worker pass made a parametric cube. Being retired (§8.9) | Not accepted · Fusion add-in setup comes from the printer MCP's `fusion_mcp_setup` (§8.0 item 11, #349) |
| Help, docs site, credits (§5.9, §15) | Built; Help opens counterpart.dtmont.com/help.html on both | — |
| No plate checks anywhere (§5.6) | Built in the app and both MCPs | — |
| Finding and adding printers (§5.8) | Built; discovery, setup fields and the slicer settings come from the MCPs (§8.0 #6). Live check Nov 5: both MCPs' `counterpart_discover_printers` found the P1S (serial, `p1s`, firmware 01.10.00.00) | Not accepted: Add printer… with the MCPs' fields on the Mac and Linux (the Mac has bambu-printer-mcp 1.1.65 and mcp-3d-printer-server 1.2.45 through Update, Nov 5), and on the iPhone, iPad and Android (built Nov 6; simulator and emulator checks only) |
| Blender add-on install and repair (§8.9) | Built: the printer MCP's `blender_mcp_setup` checks and replaces the add-on; the companion keeps the states, the print gate and the lock (`touchup/addon-repair.ts`, #349) | Not accepted |
| Remote MCP `/v1/mcp` (§8.12) | Built; tool scopes and argument kinds come from the MCPs (§8.0 item 5) | Not accepted |
| Android app (§16) | Debug APK from clean main `1b66d937`, run Nov 5 on T3 API 35 emulator after KVM permission repair: Mac pairing, project list (after relaunch), caliper `1f1c5515` Print sheet and both MCP pictures observed; Print enabled, not pressed | Main `745e9b9f` rechecked Nov 5: fresh pairing still left Home loading (including a further 15-second wait) until relaunch; welcome headings remained black on dark backgrounds. Search showed “2 of 10 projects match” for “caliper”; Show All cleared the query and restored the list; the field stayed pinned while scrolling results for “a”. Screenshots: `~/scan-to-make-work/android-linux-20261105/android-main745-*.png` on Mac. #333 pairing/text fixes await main-build verification. Emulator shut down. No physical-device, scan or physical-print acceptance |
| Linux desktop (§17) | Installed `27295626` on agents-136; Nov 5 engineering check: added P1S through Settings → Printers (connection and camera passed), imported Mac caliper `1f1c5515` current 3MF into local project `1b7a26a2`, selected its plate, opened Print sheet; both MCP pictures displayed and Print enabled, never pressed | Not accepted: physical print, provider or reconstruction review. Required installing Bambu Studio 02.09.01.70 and configuring the MCP’s `SLICER_PATH`/`BAMBU_PROFILES_ROOT`; Xvfb window needed software-rendering restart. Linux uses its own companion. Evidence: `~/scan-to-make-work/android-linux-20261105/linux-caliper-preview-enabled.png` on Mac |
| TestFlight and Mac beta (§14) | 2.0 (4) approved Nov 7 in Counterpart Public Beta; public link enabled, automatic notification selected, feedback On. Matching Mac v2.0-beta.6 notarized and published | fresh external-tester installation; production push delivery |
| Widgets (§9.5) | Built | Control Center, App Intents/Siri, Spotlight, Share extension and Watch are not built |

**Known issues from the Nov 2–3 hands-on review — re-checked Nov 5, 2026.** Code baseline `1b66d937`; installed Mac 202611051513 (`6a6d4dde`). These are engineering findings, not device acceptance. No physical print was started.

| Item | Re-check and disposition |
|---|---|
| Thickness rounded up; “0 g” | **Already gone in shared formatting:** `Format.size` retains tenths and `Format.grams(0.49)` is `0.5 g` (`SmallMeasurementTests`). Installed Mac accessibility shows `102.6 × 36 × 20.6 mm` in the model stage. The companion sidebar status rounding is fixed in #331: it also retains tenths and shows `<0.1 mm` for a positive value below 0.05 mm, covered in `events.test.mjs`. |
| Wrong-job stage names; milestones out of order | **Already gone in code:** `stageWords` chooses Designing it / Fixing the scan / Getting the designer's file by pass kind. `PrintMonitor` sorts crossed milestones, emits only the highest, and does not back-fill missed milestones after a long sleep. Existing `print-monitor.test.mjs` covers jumps and restart. **Still open:** short-print notification delivery acceptance; no print run in this audit. |
| Old phone draft date; stray “Your project” | **Fixed in #331:** Inspector says “Work started” at the earliest recorded pass (including failed work), or “Draft created” at creation when there is no pass. Existing persisted passes backfill this without changing the store. `ProjectWordsTests` covers an old draft, out-of-order passes, no passes and failed work. Installed Mac sidebar had ten named projects, no stray draft; that observation does not prove draft lifecycle fixed. |
| Developer spool strings | **Fixed Nov 5 (§8.0 #7):** the printer MCPs name each spool (`label` "A2", `spool_name`/`name` "Sunflower Yellow PLA Basic", from Bambu Studio's own colour table) and every client shows "A2 · Sunflower Yellow PLA Basic" instead of "A1 · PLA PLA Basic PLA #000000". Needs bambu-printer-mcp 1.1.63 / mcp-3d-printer-server 1.2.37; an older MCP shows the material. Not yet seen on device. |
| Copies/profile wording | **Fixed in #330:** Inspector labels saved time/weight “Last print estimate”, removing the invented profile name. **Fixed in #336 (print-truth):** the Mac print sheet no longer shows “Copies: as the printer profile says” beside a stepper reading 1. Until you press **Choose** it shows the profile's count, and **Use the profile’s count** goes back to it. Not seen in the installed app yet. The iPhone (“From printer profile” with no number), Android (“Printer setting” and **Use one copy**) and Linux (sends the 1 it shows) had no contradiction. |
| Phone presence flipping | **Fixed in #331:** Mac sidebar, Mac Settings, iPhone device rows and Linux use authenticated-request `lastSeenAt`, never credential refresh, with the same five-minute window. Missing/future timestamps and legacy pairings are not connected. Mac no longer drops a newer request timestamp masked by a credential refresh. HTTP/control parity and timestamp-boundary regressions cover this. Android has no paired-device presence list; its live Mac reachability indicator is a different signal. Installed Mac read “iPhone (13CE) · seen 13 hours ago”; no live flip was observed. |
| Finished print Pause/Stop, notification promise, stale camera, Speed “–” | **Already gone in iPhone code** (`b845a545`): `PrintingView.printEnded` hides controls and future notification text, stops camera polling, and labels a retained frame “Last camera photo”. Speed tile is absent. **Still open:** real iPhone finished-print acceptance. |
| Cancel AXPress; Create Project after AX text set | **Print-sheet Cancel: not reproduced Nov 5** on installed Mac 202611051513. AXPress on the project's “Print…” opened the sheet; AXPress on its Cancel returned success and the sheet was gone 1.5 s later (Swift AX script over ssh; Print was never pressed). No code change. Create Project: Re-tested in installed Mac 202611051513 on Nov 5: AXValue returned success but Create Project stayed disabled; focusing the same field and entering the same request with System Events keystrokes enabled it. Cancel returned to the project without creating anything. **Still open:** direct AXValue does not update the native SwiftUI binding; focus plus keystrokes is the verified automation path. |
| Sidebar printer opens Settings | **Fixed in #330:** opens that printer's live catalog status, model/address and recorded projects; selecting a project opens it. The project list matches its recorded print destination, not the next-print preference. **Alias follow-up in #345:** the companion exposes its existing canonical IDs as catalog aliases, so duplicates and MCP switches keep their recorded projects; an already-open sheet follows a new catalog winner without rewriting history. Catalog, transport and `ObjectsModelTests` regressions cover this. |
| Toolbar rename capsule | **Fixed in #330:** removed the principal rename button; Rename Project remains in More. Before-change installed AX tree exposed “Rename Leatherman Wave+ replica”. Native window title remains. |
| Unexplained “I checked the printer” block | **Fixed in #336 (print-truth, Mac):** the switch stays, because the companion refuses an uncertain project's print without `checked`. Above it the sheet now says why: Counterpart couldn't tell whether the last print reached the printer, plus the job the printer last reported. The iPhone (“Check the previous print” card) and Android (the checkbox's own sentence) already said why. Linux refuses with its own sentence. Not seen in the installed app yet. |
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
   - Thumbnails show the real object when there is one (its first photo or scan frame), so a project is recognisable the same way everywhere; a render stands in only when no real picture exists. Never a placeholder passed off as the object. (David, Nov 9: "some are pictures of the scan, some are colored renders kinda, some are just the tan thing.")
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
- **All projects.** A two-column grid of project pictures, each with a status capsule. Ready projects come first, then the rest by recency.
- **A project's picture** (Nov 10; replaces Nov 9's "real object first: photo, else scan frame"). David, Nov 10, on a grid of raw photographs (a bottle on a turntable with the room behind it, a sign in front of clutter): "of ALL THE OPTIONS, the scanned thing, the 3d thing, everything else, this option, of the photograph including everything in it is by far the worst ... it certainly doesn't match our mockups, which ... still showed a great app. i mean don't use it as gospel at this point." So a project's picture, everywhere it appears (Projects grid and list, sidebar rows, Home cards, search results, notifications, the Live Activity, widgets, the Mac popover), is the first entry of its page's gallery (§5.4) drawn as the object alone on the stage: the result in its spool's colour once there is one (the neutral material before a spool is chosen); before that, the scanned object as its scan model in its own colours, the way the mockup's potato is. Only while no scan model exists yet (photos still uploading, a rebuild still running) a photo stands in, as its subject cut out of its room by Vision; if no clean cut-out can be made, the neutral placeholder. The Mac's companion draws each picture once (`picture`, `pictures`; `mac-reconstruct picture`: SceneKit for models, Vision's foreground mask for a photo), with the same stage, light and framing for every project, so every client and system surface shows the same picture and the grid reads as one set. A designer's file whose every plate has its own picture keeps those pictures; any other model file, a multi-colour 3MF included, is drawn whole by the Mac, and that drawing comes before the pass's render (Nov 10: a 3MF with four objects had no picture). A drawing of an earlier file never stands for a new one: the companion takes it down as soon as the file changes and says the new one is `drawing` (or `failed`) in `pictureStates`, so every client can tell a picture that is coming from one that never will. Raw photos stay where photos belong: one tap in from "What you scanned", and under What you sent. Where this departs from the mockups: they predate fit projects, the gallery and the Duo; a fit project's picture is its part, not the scanned object, once there is a part.
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
- **Show it.** The choices, all visible at once:
  - **Scan it** (a full-width card first): "Walk round it, or use a scan rig. LiDAR measures it." Underneath it: "No scan rig? Print one by Kass 3D →", which opens the model's MakerWorld page (§11.1, §15). Walking round it and swinging round it on any arm are the same capture: there is one tile, not two modes. David, Nov 9: "the rig is just a thing someone might use, other people might not — don't hardcode the rig's existence into 'this is how all scans work'".
  - **Scan in hand**: hold it up and turn it.
  - **Take photos**.
  - **From Photos**.
- **Added.** Thumbnails of everything attached, each with a remove button.
- **What should this scan become?** Once a scan is attached: **Copy this object**, **Make something that fits this** (a holder, mount, case or adapter — the scan is what it must fit, not the print), or **Just save this scan**. A fit then asks how its exact size is settled: **Look up** the maker's published size and confirm it (the default), **I measured** (longest/middle/shortest in mm, blanks allowed), or **Use scan** as an estimate, with **Add a caliper photo** beside them.
- **A scan you already have** (Nov 11, things-and-versions design §3.3, slice 3). David, on his "Leatherman Wave+ replica": "the new workflow would ask me, if i want to make a case or attachment or something. as it is, it assumes i want to print a fucking leatherman". Every project the Mac has a scan for, whatever its kind, offers **Make something else from this scan** under What you scanned and in •••. It opens this sheet already holding that scan (its picture and "<name> · scanned Nov 4"), with no Scan, photo or "Just save" tiles: **What should this scan become?** Copy this object / Make something that fits this, then the words and a fit's exact-size choice. Send makes a new project on the Mac (`POST /v1/objects/<id>/make-from-scan`, docs/protocols/objects-api.md) that holds a copy of the scan, its photos, capture and checked sizes, and opens it; nothing is scanned or sent from the phone, and the source is unchanged. The new project says "Bringing over the scan from “<name>”." until its files are in, then starts. Its What you scanned says "Uses the scan from “<name>”" (opens it); the source's says "Also made from this scan: …". Without a scan attached, New also lists **Use a scan you already have**: those projects' scans by picture and name. A caliper photo goes in the new project's conversation afterwards. Built; companion, CounterpartKit, Linux and simulator tests; Android not compiled here.
- **One main action** (Nov 10, board U17). Every state a project can be in has exactly one main action, or none while Counterpart is the one working, decided once (`PageActions` in CounterpartKit, its Kotlin and TypeScript ports, all held to the shared table `main-actions.json`) and drawn by every layout: one filled control per page, in the state's card when the state has one and otherwise in the bottom bar; an action appears once on a page; the bar keeps Ask for changes whenever changes can be asked and shows Print only when Print is the main action or, after a finished print, as a plain Print Another beside "Did it fit?". Printing is called what it is: Print (ready, sent, or refused before anything was sent), Print Another (done, or after a finished print), Print Again (a print failed; the same file is sent again) and Print the last version (a pass stopped or failed and the result from before it remains). When the pass can be picked up, Try Again leads and that print is plain beside it. When it failed for good, nothing leads: the person asked for a change, and a filled Print the last version would steer them to print the very version they asked to change; the card says why it failed and "Your last version is still here.", with the print plain and Ask for changes in the bar. No Print while a change is being made: the version shown is the one being changed. Before this each card filled its own first button and the bar filled Print whenever a model existed, so a stopped pass on a project with an earlier result showed Try Again, Print Again and a floating Print at once. Built; unit, shared-table and simulator tests only.
- **What a project is waiting on you for has a kind** (`ask.kind`: closeup, file, choice, region, scale, sizes), sent with every question. A **size question** carries one to six sizes, each with a label a person can act on ("width at the waist"), the Mac's number in millimetres and where it came from: `published` (with the exact product the number is for, as the person has it, and where the maker published it; the card says "Published for JETech clear case for iPhone 16 Pro · site"), `scan`, or `estimate` (the Mac's own guess; a source a client doesn't know reads as an estimate, never as the scan); ids are opaque. A published number with no product or source named is not kept, and the question stands as words (#622). The answer is the numbers (`sizes: [{id, mm}]`) and `measured`, the ids the person typed or edited, beside them so an older Mac still takes it, with words and a caliper photo beside them when wanted. A field left blank is a size the person doesn't know and is left out. Whatever is pressed on the card (Confirm, the words' send, Caliper photo) carries the numbers as they stand. A number the person didn't touch is **accepted**, never measured: it is exactly as certain as its source, and the asked value is what is kept; a typed or changed one is **measured** (#622, David Nov 10: "IT'S A KNOWN CASE with published specs"). The answered sizes stay with the project, a fit or not, merged by label with any checked before (a blank keeps the earlier value; an accepted number never replaces a measured one, nor a size the person measured in New), and every later pass is told each by its label, whether the person measured it or accepted it, and for an accepted one where it came from, never as the overall size; New's own fit choice is kept. Sizes stored as `confirmed` before Nov 12 stay as stored and are read as accepted, their source unknown. How a fit uses accepted estimates is the printer MCPs' fit rules (wording proposed on #622). A client that doesn't know a kind shows the question and says to update, and offers no answer at all. `region` and `scale` are named only: a reconstruction review and its route are unchanged. Built; unit and simulator tests only, not seen with a real question.
- **Your request is what you typed.** How a fit's size is settled (look up, measured with its sizes, or the scan) is sent as fields beside the request (`fit`, contracts `FitSchema`: opaque size ids, each with a label a person can act on, in millimetres), never as text inside it. The companion composes its worker's brief from those fields; every client shows the request as written. A project made while the phone and Android appended a "Fit brief:" block to the request (Nov 9–10) is read back the same way: the block is split off at the exact text those clients generated, the file is not rewritten, and the worker reads what it read before. A Mac that doesn't take the fields (`fitFields`) is asked to update. The brief's rules are due to move to the printer MCPs as a prompt (§8.0). Built; companion, CounterpartKit and Android unit tests only.
- **Send to *Mac name***: a full-width prominent button at the bottom. Without a scan it needs text; with a scan it first needs the answer above (and, for a fit, what the part should do).

**Behaviour:**
- The text is kept whatever you do, including when you leave and come back. The field never disappears.
- Scanning returns to this sheet with the scan attached and scrolled to the question above, so a scan and a description go together. Adding the scan starts its files uploading; no pass starts until Copy or Fit is sent, and choosing one sends at once (the send resumes the upload). **Just save this scan** starts nothing and leaves the draft and scan here for the next open of New. A scan by itself never means copy: an unsent draft can still change between fit and copy. David, Nov 9: "there probably over a 50% chance that the user is like, 'i scanned that so you would know the shape of the thing i need to make a holder for'".
- On devices without LiDAR (iPhone Duo, non-Pro iPhones), the scan tiles say "Needs an iPhone or iPad with LiDAR" and stay visible but disabled. Describing a part and adding photos work fully.
- Sending creates the project at once. Upload continues in the background (background `URLSession`), and the project shows Sending until it lands.

### 5.3 Capture

**Status:** Built: walk-around (Apple Object Capture), in hand and on a rig. A physical scan reached the Mac and became a cleaned model on Nov 4. Not accepted: geometry and dimensions. A connected Continuity display blacks out the camera ([camera incident](../../status/camera-incident-2026-11-02.md)).

- **Walk-around (unchanged).** The existing Object Capture module (`apps/mobile/modules/object-capture/`) works and isn't touched. Changes are limited to its entry and exit: it's launched from New and returns its scan to New.
  - Close-ups come from the scan's own images, with no extra step. The Mac picks frames from the capture (§7.4).
  - **The Mac rebuilds it (Nov 8).** The phone sends every image the session took, as Apple wrote them: each HEIC carries its LiDAR depth and gravity. That is what `isOverCaptureEnabled` is for. The phone's own model is only a preview. On a Mac (`objectCaptureImages`), PhotogrammetrySession rebuilds the images folder at `.full`, Apple's way: each photo's own camera, depth and gravity, Apple's own object masking (always on, whatever mode the phone captured in), and `featureSensitivity = .high`; a rebuild that fails is run once more at `.normal` (Nov 9: on Apple's own 33 unicorn photos `.high` failed 6 of 6 times, `.normal` with the box ignored placed 27–28). Its size comes from the depth. David, Nov 8: "Why isn't this just use all Apple libraries and features in the correct way?" Nothing custom is added to the reconstruction. The capture box is ignored (`ignoreBoundingBox`). David: "the box around the thing it forces you to make is damn near impossible to use". On his rig scan the box cut off a letter, and with the box ignored both D's come back. Apple's checkpoint stays on the phone: macOS "starts from scratch, and does not resume from previous checkpoints". If the rebuild fails, the preview stays, and the model's summary says so. An older Mac gets the preview and 24 photos, as before.
  - **One capture, paced by the app (Nov 9, #420).** Apple's freeform capture (no box) is the only capture: no launch flag, no Object/Area switch, no guided box or segments. The app takes the photos: Apple's auto-capture is off (`isAutoCaptureEnabled = false`) and `requestImageCapture()` fires each time the camera's view turns 5° (Core Motion attitude; the session exposes no per-frame camera), at most 3 a second, while tracking is normal and `canRequestImageCapture`. About 70 photos a turn. David's unicorn: three turns gave Apple's auto-capture 9 photos. One line shows the count and the next step ("42 photos · now go higher and look down"); **Done** stays disabled until 60 photos, at least 15 low and 15 looking down from above (each photo's height from gravity). The same rules in a hand or on any arm.
  - **A stopped scan stays findable (Nov 9).** A scan stopped, failed or cut off after it kept photos shows on Home, in the iPad sidebar and on its project as "Scan stopped · 9 photos kept", with **Send to your Mac** (the photos alone; the Mac rebuilds what's there and says plainly when they're too few) and **Scan again**. A run that kept no photos is not listed; its folder is never deleted. A finished scan that never left the phone says "Scan saved · send to your Mac" and its project offers **Send to your Mac** even though the Mac's copy has no scan yet — never only Scan again.
  - **After a scan, what it is for (Nov 9).** New asks Copy, Fit or Save before anything starts (§5.2). For a fit, the request the Mac receives carries a fit brief: the scanned thing is the mating object, plus how its exact size is settled. **Look up** means the worker identifies the exact product, opens the manufacturer's published dimensions, and stops with an Ask — "I found this exact size, is that right?" in effect — before modelling anything that depends on them; an answer can confirm it, correct it in words, or send a caliper photo (`touchup/invocation.ts`). Measured sizes are authoritative and a scan that disagrees by more than 2 mm or 2% asks first; scan-only sizes stay marked estimated. Each place the part meets the object gets a fit chosen by what it has to do (drop in and lift out, slide, grip, clamp, snap, press in), never one number for every interface: a plain clearance where loose is the point, a mechanism that takes up uncertainty (crush ribs, a split with a pinch screw, a flexure, a snap) where it must grip or the size is unsure, and the summary gives each interface's function, fit and why (David, Nov 10: "not everthing is the same. the mic mount is perfect, it would NOT BE CLOSE TO FUNCTIONING if it was .5mm off both sides"). How each fit prints is the printer MCPs' guidance.
  - **What it stood on is cut away, and the bottom is closed (Nov 9).** The kept model drops whatever the object rested on that Apple's masking kept (a table, a plate, any platform), found from the mesh alone, and the summary says so (`mac-reconstruct stl --remove-support`). The cut is then closed flat from its own edge (`HandheldKit/Cap.swift`), so a scan that was watertight stays watertight and prints: David's DAD sign went from 1,081 open edges after the cut to 0, with every other triangle unchanged. Apple can't do this part: a `Request.Geometry` box with its floor just above the plate clipped the sign open at the floor (3,302 open edges) and kept the plate's scraps above it. A hand scan (§11) is never cut.
  - **What a cleanup does (Nov 9).** A cleanup pass first says what the object is and names its parts (a bottle: body, shoulder, cap with ribs, printed label; a sign: separate letters on a base). Manufactured features are rebuilt regular where the photos show them: flat faces flat, straight edges straight, cylinders round, mirrored halves mirrored, repeated features (ribs, teeth, threads, letters of one typeface) equal and evenly spaced, counted from the photos. Printed graphics, labels and colour changes are ink, not shape, so their surface stays smooth unless the photos show relief. Organic and handmade surfaces (fabric, crochet, carving, clay) stay as scanned. Sizes still come from the scan or measurements; regularising never rescales. Each regularisation is listed in the result's changes as `assumed`, or `estimated` with its tolerance when it sets a size; when the photos can't settle a feature, the pass asks for a close-up. A scan sent for cleanup with no words gets one sentence as its request: "Clean up this scan so it prints as the real object in the photos looks: recognise what it is, repair what the scan got wrong, and keep its size." Why: David's bike-oil bottle (Nov 9, project 0ddbecb5) kept 0.6–0.8 mm ripple on the cap's ribs and raised its printed label as 0.5 mm relief, and the DAD sign's letters came back as melted ribbons; nothing told the worker to recognise the object. Rules: `CAPTURED_RULES` in `touchup/invocation.ts` (§8.9).
  - **No touch-up unless asked (Nov 8).** A scan sent without a request becomes the project's model as it is, and is `ready`. **Ask for changes** starts the touch-up. A request sent with the scan still runs it after the rebuild. The rig scan of Nov 8 ran a 7-minute touch-up on a 4,112-point preview nobody had looked at.
- **Scan in hand (new; spec in §11).** Screenshot: `screens/phone-hand.jpg`.
  - A full-screen camera with the object's live outline and a coverage ring. One glass card carries one instruction at a time ("Turn it so the top faces you").
  - Shutter and LiDAR status are always visible ("1/500 s · LiDAR on"), with a count of sharp and skipped frames.
  - A Walk around / In hand switch, and a Done button.
- **On a scan rig.** Not a mode (Nov 9): the phone on any arm runs the same Scan it capture with the same rules. The earlier rig screen (`screens/phone-rig.jpg`: rings, a Walk / In hand / Rig switch) is superseded.

### 5.4 Project

**Worker stops and retry (Nov 9):** a design or touch-up stopped by inactivity, its tool-call budget or its absolute time ceiling stays stopped, with **Try Again** and **Ask for changes**. The project names the actual limit (including its value), never says the person cancelled it, and never announces Ready merely because a checkpoint exists. Any valid saved mesh remains reviewable. All five layouts render the companion's `failure` / `status.text` unchanged. The next request resumes an unfinished Claude Code session from its saved checkpoints; a session that has disappeared starts cold once and records that fact in Activity. No automatic retry spends another budget after a stop.

**Status:** Built. Done/Works checked on both devices Nov 2–3; Claude names projects. Not accepted: rename and Project Settings (partial), Ask for changes from both. **Compare versions** in the menu is not built (archived, §18).

Screenshots:
- `screens/phone-ready.jpg`
- `screens/phone-working.jpg`
- `screens/phone-ask.jpg`
- `screens/phone-inputs.jpg`
- `screens/phone-failed.jpg`

**Layout:**
- **Pictures** (Nov 10, replacing the one-model hero). David, Nov 9: "this used to show the scanned little bottle. cool, perfect. now it shows this 3d form. fine, but.... it ONLY will show that and i am no longer allowed to see the scanned object, anywhere, ever. so that sucks.. but even worse, once it goes through slicing and a filament is picked, it just stays tan and weird forever." And on a box and its lid: "they were two separate parts and i only needed one modified and reprinted, that is an extremely common thing. at that point, now you're beyond the hardcoded three things in that hero carousel." So the top of the page is a gallery over a list derived from the project's data (CounterpartKit `ProjectGallery`, Android `ProjectGallery.kt`, Linux `gallery.ts`, all three checked against `packages/contracts/fixtures/project-gallery.json`):
  - **one entry per thing that will print**: the result ("Your part", "Your copy"), or one per plate of a designer's file by the plate's own name ("Screws", "Main Framework"). A one-colour result is a model to turn in the spool it prints in: the spool its last print was sent with, as the printer MCP reported it (`print.spools`), else the colour the printer reported while printing it (`print.live.activeFilament`); before a spool is chosen, the neutral material (the same grey on every layout). No colour tables in the app: without a colour from the MCP it stays neutral. A 3MF shows the Mac's drawing of the whole file, else its pass's picture, until the app has each part's own mesh; with neither yet it is still an entry, whose stage says its picture is coming or that it can't be had;
  - **Together**, when the pass recorded where the scanned object sits (`current.seats`, [seats](../../protocols/seats.md)): the part in its spool with the scan in every seat, in its own colours. A fit made before passes gave seats offers **See it together**, a short pass that finds them and changes nothing;
  - **What you scanned**, for each scan the project holds (one today): the scan model to turn, in its own colours, with its photos one tap in;
  - the seam for a project's own part list (a box and its lid, one part changed or printed on its own; being designed separately) is `ProjectGallery(project:parts:)`: each part becomes its own entry in its own spool.
  - **The stage is never empty** (review of #539; docs/operations.md, "Waiting, failed and empty are screens too"). Every still on the stage (an entry before its model is drawn, a 3MF's or a plate's picture, the photo's subject, a page with nothing yet) goes through one view per layout, from `Project.still(for:)` (CounterpartKit, Kotlin, `gallery.ts`; the shared fixture's `still`): **shown**, this entry's own picture; **waiting**, an earlier copy of this same picture or a progress mark, with one line saying what is coming ("Model: coming from your Mac"); **not available**, a symbol and one line (the Mac couldn't draw it; a plate came without its picture; the picture didn't come, with Try Again). A picture of something else never stands in. It needs no model at all and stays correct for as long as the page is open.
  - **The stage stays dark** (Nov 11). David, on his Mac showing a Blue Gray part on a pale grey stage: "the fact that we just entered light mode without a flashbang alert signals a major regresssion in code unassociated with the intended changes". There is no light stage: the backdrop is the dark stage for every part on every layout, controls on it keep the dark stage's styling, and a part whose filament would be a silhouette (black, a dark slate blue) is made readable in its material instead — the stage draws it in its hue lifted to a minimum brightness of 0.20 (`StageMaterial` / `drawnColour`, the shared fixture's `stage.drawnColours`), the same floor the Mac's still pictures use, with the stage lights' edge highlight. A true black filament is drawn as charcoal. Only the stage's drawn material is floored: swatches and names keep the spool's real colour.
  Which shows first: the thing that will print once there is one, the scan before that. The control: none for one entry; a row of labels under the stage, never over it, so a drag always turns the model; it scrolls for a designer's dozen plates (HIG [Page controls](https://developer.apple.com/design/human-interface-guidelines/page-controls): a scrolling row for an arbitrary number of pages; [Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls): short noun labels). The Mac uses a segmented control over the stage, a pop-up for more than four. Glass buttons float over the stage:
  - **AR**, one control for whatever the stage shows (Nov 11, David: "we now have 'ar' AND 'see it in your space' so there are TWO options"): the part at true size in the room in its spool's colour, resting on the surface (Quick Look AR on a real USDZ the phone writes on tap, `PartUSDZ`; until Nov 11 it was a Reality file named `.usdz`, and a designed part never appeared), or the scan. While the part's file is written the chip says "Preparing AR…"; with the Mac away and the model not on the phone, "AR needs your Mac". Together, a plate and a multi-colour 3MF's picture offer none;
  - the size capsule, which names what it measures ("Part · 213 × 43 × 82 mm", "Scan · …", "Together · …").
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
- **Plate:** an imported 3MF keeps all its plates in one project, as the designer laid them out and Bambu Studio shows them before slicing (David, Nov 6: "if i download the 3d scanning rig ... and open it in bambu, it just shows up as six plates. BEFORE slicing"). The printer MCP lists them (`list_3mf_plates`) with each plate's picture; Counterpart never splits or rearranges a model. You choose a plate to print or reprint, and each plate remembers that it was printed. The Print sheet names its plate and can change it (Nov 6); the estimate, pictures and colours follow the plate chosen. The sheet sends the plate's identity (`expectedPlate`), so a change on another device can't print a different plate. Only a running print (or touch-up) locks the selection. A send Counterpart couldn't confirm (such as a timed-out printer report) stays on its own plate as "Check print result", never "Print failed"; the other plates stay choosable and print normally, since the printer MCP refuses a start unless a fresh report shows the printer idle. Printing that plate again asks "I checked the printer" (the companion refuses it without), and marking it Printed or Not Printed settles it. The plate carries that doubt as `plates[].uncertain`; a send that was cancelled or refused before anything went out can also read "unknown", but it was never sent, so it never asks. The shared fixture `packages/contracts/fixtures/six-plate-unconfirmed.json` is David's rig in these states; the companion's tests check it against what it serves, and every client's plate tests read it.
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
  - Pause and Stop in the bottom glass bar. Stop asks for confirmation. Only the controls are in the bar; the note ("You'll get a notification…") is on the page under the progress, so it never sits over the tiles.
- **After the print.** The camera stops, and "Did it fit?" (the project page's card, §5.4) and **Open Project** replace the nozzle and bed tiles. This is where a Live Activity or print notification tap lands, so it never ends on 100% with nothing to do.
- **Live Activity.** It starts when the print starts (§9.4) and appears on:
  - the Lock Screen;
  - the Dynamic Island (compact: ring and minutes left; expanded: camera still, Pause, Open);
  - StandBy;
  - the Watch Smart Stack;
  - the Mac menu bar.

### 5.8 Printers

**Status:** Built. Settings → Printers also offers each printer's **Connection** (the MCP's own route, e.g. Local network or Bambu Cloud, written to that MCP's `.env`), which MCP a printer uses, Add Printer…, and Download for both MCPs. Add Printer… is on the iPhone, iPad and Android too, through the same companion calls (§6.1).

Screenshot: `screens/phone-printers.jpg`.
Screenshots, printer detail: `screens/phone-printer.jpg` and `screens/phone-printer-update.jpg`.

- **One row per printer** from the MCP configs on the Mac, showing state, spools, current job and camera.
- **Tap a printer** for its live camera, job, filament and history of prints from Counterpart.
- **The footer says plainly** that printers live in the MCPs on the Mac, and that Add Printer… adds one there. Settings are never duplicated in the app.

### 5.9 Settings and About

**Status:** Built. General values come from the real Mac; keep-awake changed from the phone changed the Mac (Nov 3). Help opens the live help page on both. The phone's Mac row says "Checking…" until reachability is known and never "Connected now" before then (`b845a545`, covered by the engineering test). Home's line and banner, the iPad sidebar and this row read one value (`MacLink` in CounterpartKit: checking, connected, not answering, needs pairing), so they can't say different things; a request the Mac refuses for any other reason counts as an answer and is that request's own error (engineering tests only: `MacLinkTests`, `AppTests`). **Seen on device Nov 4:** David saw Settings show Connected while the Mac was reachable (build 202611041132).

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
- **Code design engine** (§8.9): the printer MCP's own `cad_status` in Counterpart's words, and **Set Up**, which the computer runs (`cad_setup`) while the row shows its progress and then the MCP's own result.
- **Design with Fusion** (§8.9): status and **Set up**. Being retired with Blender (§8.9).
- **Phones and iPads:** every paired device, including the Older pairings section, with **Remove** and **Remove All**.
- **General:** open at login, show in Dock, and keep the Mac awake while working. Each one changes the Mac.
- **How it works.** The companion exposes `GET /v1/settings` and `PATCH /v1/settings` with the same schema the control socket's `settings.get`/`settings.set` already uses, plus `GET /v1/devices` and `DELETE /v1/devices/<id>`. The schema and its labels live in `CounterpartKit` (`SettingsSchema`), so both apps render the same list from one definition, and a new setting appears on both without separate UI work. Settings that need the Mac's GUI (a sign-in window, a Keychain prompt) run on the Mac, and the phone shows their progress.
- **Help:** a guide at the docs site, how scanning works, and **Print the scan rig**. The rig link opens Kass 3D's MakerWorld page, credited by name (§15).
- **About:** the app icon, "Counterpart", the version and build, the website, the licences, and open-source notices.

### 5.10 First run and pairing

**Status:** QR and nearby pairing built and in use. Automatic iCloud pairing (`POST /v1/pair/icloud`) is built, and fresh same-account enrolment was accepted on David's iPad Air on Nov 5.

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
- the **vernier caliper with depth gauge** by 3D Print Masters Hub, 150 mm (the 220 mm version only if the depth gauge isn't offered for 150 mm).

Every starter is a real designer's model. Removed Nov 5: a bundled "Counterpart caliper card" whose files an agent generated with `tools/caliper` (588afd4c). Nobody designed or print-tested it, yet it was offered as something to print right now (David, Nov 5: "It just completely made up that one on its own"). The generator went with it.

**Ready to go.** David, Nov 5: "READY TO GO. not ready to be downloaded from maker world... fully ready to go". Tapping a starter (`POST /v1/objects {"starterId": …}`, the same call on every client) creates the project and at once runs the published-model pass a pasted link runs (§8.11). The worker gets the designer's own files from MakerWorld with the person's own sign-in in Chrome, and the catalog entry's request names which files: the rig's full-kit profile with all six plates; the caliper's 150 mm colour profile and its 150 mm depth-gauge profile. The project keeps every file and plate together (no "which plate?" question; the plate picker prints each one) and lands at **Ready to print**, credited to the designer.
- The companion itself checks `~/Downloads` (and the pass folder) for every model file that arrived while the pass ran. A starter takes the arrived files whose own 3MF metadata names the catalog's designer, one per distinct file (by sha256), and is Ready once they make its whole kit (below), whatever the worker concluded. Nov 6, e95f31ea: both 150 mm profiles were in Downloads at 21:08 (the colour one three times, from repeat clicks), the worker's own check missed them, and the project failed. The worker clicks each Download once and never downloads from JavaScript (Brave held those behind a "Download multiple files" prompt it couldn't see).
- **Downloaded at most once per computer** (Nov 6, after repeated test passes downloaded the caliper again and again). Before any browser work, a starter looks for its files on disk: first the companion's starter cache (`capture/starters/makerworld-<model id>/<sha256>/<file name>` on the Mac), then `~/Downloads` together with the cache's kept fragments, where a file counts only when its 3MF metadata names the designer and its sha256 is one of the catalog's pinned `sha256` (the caliper's two; the rig's `483a2e4b…f8219`, pinned Nov 6 from David's own download, Designer "Kass 3D", six plates). A one-file starter with no pins also takes the designer's 3MF in Downloads with exactly its catalog plate count (the newest such file); a several-file starter needs pins (Nov 6, 7f1a9e33: the rig had no pins, so David's own download was skipped and the worker fetched a second copy). Enough files there and the project is Ready with no worker run, AI on or off. A starter that lands at Ready keeps its files in that cache, and `kit.json` names them by sha256 only when they are its whole kit (below); a cache hit needs that recorded kit, so a partial or wrong set the worker or the person chose is never replayed. Part of a kit that arrived is kept too (for a pinned starter, only its pinned files), and the next pass is told which files are already there so it downloads only the rest. Try Again and a second tap after delete reuse the cache.
- **The print profile, never the raw model** (Nov 6, bb9da63c: the scan platform got MakerWorld's raw-model zip, one 850×521 mm STL of all six plates baked into one mesh, and the file Ask accepted it). The worker downloads the chosen print profile's 3MF (MakerWorld's Download 3MF), never the raw model files. Only a 3MF counts as a starter's file, in a pickup, the cache or Downloads. A starter's file Ask accepts only a 3MF and says: "On MakerWorld, open *starter*, choose the designer's print profile and press Download 3MF, then add that 3MF here. Not the raw model files (STL or a zip): they don't have the designer's plates." An STL or zip handed in anyway is refused: "That's the raw model from MakerWorld, without the designer's plates. On the model's page, choose the designer's print profile and press Download 3MF, then add that 3MF." The rule is enforced where every starter file is kept (`#keepPublished`), so a worker that reports the raw model downloaded can't make a starter Ready either (R24-002); a pasted link's STL is still kept. The scan platform is one 3MF with six plates.
- **A republished kit is still downloaded once.** When none of the files is one of the catalog's pinned ones and the worker reports them downloaded (it chose the profiles from the request) or the person added them, the designer has republished: the designer's files make the kit by the catalog's `files` and `plates` counts (files that only arrived never do: they can't tell two caliper variants from the caliper and its gauge), are kept under the model id with `kit.json` marked `republished`, and the mismatch is logged once. A repeat tap uses them; a hash change never means a download on every tap. Part of the pinned kit with another file (the 150 mm caliper with the 220 mm one) is still no kit.
- **Downloads refused by macOS privacy.** When the companion can't list `~/Downloads` (EPERM from Files & Folders), a published project starts no download and doesn't read the folder as empty: it asks once, in one sentence, "Counterpart can't open your Downloads folder, so it can't use the designer's files there. Turn on Downloads Folder for Counterpart in System Settings → Privacy & Security → Files & Folders, or drop the 3MF here." The same Ask replaces a failure when Downloads is refused during a pass; a dropped file needs no Downloads access. A starter's own cache needs no Downloads access and is used first. Once macOS allows the folder, a project waiting on that Ask goes on by itself: when the projects are listed, or when the starter is tapped again. Logged once per companion run.
- **A starter project from before the kit rule is mended by adding the starter again** (Nov 6, bb9da63c: the rig as one raw STL, Ready with no plates). When an existing starter project's files aren't its kit (a file that isn't a 3MF, too few files, or too few of the plates the printer MCP has listed; unlisted plates are unknown, not missing) and it isn't printing, adding the starter gets the kit (cache, then Downloads, then one pass) into the same project, keeping its title, credit and messages. A project with its kit is just reopened.
- **A pickup is the whole kit** (Codex on #369): a starter that pins its files needs every pinned one (two calipers of other lengths from the same designer never stand in for the caliper and its gauge); one that doesn't needs the catalog's `files` count and `plates` count (the rig's six), never part of it. A kit is made up from what the cache keeps, any pinned file in `~/Downloads` (its sha256 proves what it is, however old), and what the pass brought, whether the worker reports it downloaded or it only arrived. Without a whole kit, the files the worker itself reports downloaded are used as before, together with what is kept.
- The extension may run in Chrome or another Chromium browser (David's is in Brave); the companion finds its host in Chrome's, Brave's, Edge's or Chromium's NativeMessagingHosts.
- If the files can't be downloaded, the project is Failed with one sentence, and every client's **Try Again** runs the pass again. The sentence follows the worker's structured `reason` (never its prose):
  - `not_signed_in` (the site itself showed the worker signed out): "Counterpart couldn't download the designer's files because MakerWorld isn't signed in. Sign in to MakerWorld on the page Counterpart left open in your browser, then try again." The worker leaves that page open at its sign-in, and the browser keeps the sign-in.
  - Anything else (the file server answered an error, a download never reached Downloads): "Counterpart couldn't download the designer's files from MakerWorld." followed by what the worker saw, then "Try again." Never "Sign in". Nov 6, project e95f31ea: the browser was signed in (MakerWorld signed the file link for David's account), its file server answered 503, and the project still said "Sign in".
  - Every published pass that ends without the file writes one line to the companion log (`logs/companion-error.log` on the Mac): project, pass, status, reason, tool calls, seconds, exit, and the worker's session id, which names its transcript under `~/.claude/projects/`.
- With no browser to download with (the Linux companion, Chrome without the Claude extension, or an AI provider other than Claude Code, which alone can drive Chrome), signing in can't help, so the starter asks for the designer's files as a pasted link does (§8.11 step 2.3). The same happens with AI off: the project stays and asks for the files.
- Counterpart never bundles or re-hosts the files: both are under the MakerWorld Standard Digital File License (§15). No personal project history is copied.

**Status:** Built. Not accepted: a starter printed.

## 6. iPad and iPhone Duo

**Status:** Built (one `NavigationSplitView` at both widths, with a shared selection/detail path and `preferredCompactColumn`). Not accepted on an iPad or a Duo.

Screenshots: `screens/ipad-split.jpg` and `screens/duo-closed.jpg`.
Screenshots, reflow: `screens/duo-home-empty.jpg` and `screens/ipad-welcome.jpg`.

- **iPad, and Duo unfolded.** A `NavigationSplitView`:
  - a sidebar grouped as Now / Needs you / Ready / Printed / Printers;
  - the project page in the detail pane, with the model hero larger;
  - New Project in its own bar under the sidebar list (§6.1);
  - drag and drop photos from Files or Safari onto New or onto a project;
  - pointer and keyboard shortcuts: ⌘N new, ⌘P print, ⌘F search.
- **Duo unfolded: Printers and Settings are in the trailing rail** (David, Nov 10: "with the duo flipped open the settings and profile and print icons should go into the side edge"). The system puts the detail column's toolbar buttons in the inner display's rail, so on a device with a hinge (`DeviceHinge`, iOS 27.1) at regular width the two buttons are the detail's, above Share and More when a project is open. An iPad has no hinge and no rail: they stay above its sidebar. Seen on the iPhone Duo simulator Nov 10 (`~/scan-to-make-work/state-machines-2026-11-09/duo-rail/`), not on a device.
- **Duo folded.** The iPhone layout. iOS 27 moves the toolbar to a vertical rail on the outer panel's landscape layout automatically, and the mockup confirms it. New stays at the bottom of the rail.
- **Duo during capture.** Duo can't scan (no LiDAR). Its outer display can still show an "In progress" `CameraCaptureAccessory` for photo capture.
- **iPhone apps are resizable in iOS 27.** Every screen must reflow from compact to regular width. Test with Xcode 27 previews' resize handles.

### 6.1 Every layout

**The parity rule.** David, Nov 5, after the starters went missing on the Mac and iPad: "how do make sure thing like that don't happen again?" A user-facing feature lands on every layout in the same PR: iPhone (compact), iPad and iPhone apps at regular width, Mac, Android and Linux. Where a layout can't have it, this table names the exception and quotes David's decision. Each client has a test that the feature is reachable on a layout with projects present: `LayoutParityUITests` runs on an iPhone and an iPad simulator in the mobile gate, `ObjectsModelTests` on the Mac, `HomeLayoutTests` on Android, `domain.test.ts` on Linux. Android and Linux client tests now run through `clients.yml`, including shared fixture changes, in the same local gate; they were previously absent from the workflow list.

What a person can see and reach, checked in code on `main` Nov 5 (after this PR: †; after the Nov 8 after-the-print fix: ‡):

| Feature | iPhone (compact) | iPad, regular width | Mac | Android | Linux |
|---|---|---|---|---|---|
| A project made from another carries its history (Nov 11) | What you sent: read-only source conversation, then new request; From line opens source or says since deleted (`LayoutParityUITests`) | Same shared view | Request conversation, shared `ProjectConversation`; `ObjectsModelTests` | Follow-up branch `feat/inherited-history-android-linux`; ignores new field meanwhile | Same follow-up branch. David, Nov 11: “move important things forward while putting other work … into a seperate workflow” (operations.md) |
| Design/touch-up limit stop and retry (§5.4, §8.9) | Home → project: exact limit, Try Again; `LayoutParityUITests` | Same words and action in the regular layout; `LayoutParityUITests` | Same shared `ProjectWords`, `ObjectsModelTests` retries with another project present | Home → project with projects present: exact limit and Retry (`HomeLayoutTests`, `ClientTests`) | Home with projects: companion status names limit (`domain.test.ts`), project retains failure and Retry |
| AR on the project's stage (§5.4, Nov 11) | One **AR** chip on the stage for the entry shown: the part (a real USDZ written on tap, "Preparing AR…" meanwhile, "AR needs your Mac" when away, explicit retry if Quick Look cannot open it) or the scan; none on Together or a plate; the separate "View part in your space" button is gone (`LayoutParityUITests.testTheProjectPageHasOneARControlAndItOpensThePart`, `ARModelTests`) | Same view (`ProjectGalleryView`) | No AR: a Mac has no room camera; its stage has no AR control and writes no AR file | No AR control (none in `android/app/src/main`; ARCore is used for scanning only) | No AR control |
| Starters (§5.11) | Home, under the projects, whenever no search is typed; Welcome before pairing | † the start pane (nothing selected, which is how the app opens) and a sidebar "Start with these" section. **Before: never** | † a sidebar "Start with These" section, and New Project. **Before: only with no project selected, and the Mac selects the first project on launch** | Home, above the projects, whenever no search is typed | Home's Projects view, under the grid, whenever no search is typed |
| New Project: fit, copy, scan, published link | New sheet: the five ways to show it, a published link in the text; fit/copy cards on an empty Home. † After a scan: Copy / Make something that fits this / Just save this scan, and for a fit its exact-size source (look up and confirm, measured mm, or scan estimate) with a caliper photo | the same sheet; fit/copy cards in the start pane † (before: only with no projects); † the same post-scan question on LiDAR iPads | New Project pane: fit/copy picker, dropped files, a published link. No scan: the Mac has no LiDAR, scans come from the phone; the fit brief and its confirmation Ask arrive with the project | New: ARCore scan, photos, a published link; fit/copy/published cards only on an empty Home. † After a scan: the same Copy / Fit / Save question and exact-size source (`HomeLayoutTests`) | New dialog: fit, copy, published. No camera scan: Linux imports scans from files and chooses fit or copy in the dialog; the confirmation Ask is answered on the project |
| Make something else from this scan; New → Use a scan you already have (Nov 11, design §3.3) | Project page: the button under What you scanned and the ••• item, on any project with a scan; New holding the scan asks Copy this object / Make something that fits this first, with Exact size starting on Use scan; "Uses the scan from …" and "Also made from this scan" open each other (`LayoutParityUITests.testACopysScanMakesAFitFromItsPageWithoutScanningAgainWithProjectsPresent`, `testNewOffersAScanYouAlreadyHaveWithProjectsPresent`) | the same page and sheet (the same tests on an iPad Air 11-inch in landscape) | Project page: the button under the stage and the two lines; New Project pane holding the scan with the same two answers; a fit offers Look up / I measured / Use scan, defaults to Use scan, and sends `fit` with its selected size source and measurements. Use a Scan You Already Have is under the drop zone (`ObjectsModelTests.testMakeSomethingElseFromACopysScanWithProjectsPresent`, `ObjectsClientTests.testMakeFromScanCarriesTheFitsSizeSourceToTheControlSocket`, `FitChoiceTests`) | Project page button, ⋮ item and the two lines; New holding the scan, and Use a scan you already have with the same Exact size choice as New after a scan, starting on Use scan; several projects made from one scan are a list to choose from (`HomeLayoutTests.aCopysPageOffersMakeSomethingElseFromItsScanWithProjectsPresent`, `aFitFromAKeptScanStartsOnTheScansSizeAndSendsItWithProjectsPresent`, `aScanWithSeveralProjectsMadeFromItListsThemAllWithProjectsPresent`; `ScanLineageTests` on the shared `scan-lineage.json`) | Project page button and lines; the New dialog holding the scan, and Use a scan you already have. A fit offers Look up / I measured / Use scan, defaults to Use scan, and sends `fit` with the selected size source and measurements (`domain.test.ts`, “a fit made from a kept scan sends how its size is settled…”) |
| Give New Project a model file you already have (RUN.md H1–H3, Nov 11) | **Gap, not parity: board X124.** New can't take a model file yet, and Files ▸ Share offers no Counterpart (no document types). A question card's "Choose model file" is a labelled button | **Gap: board X124**, as iPhone | New Project's drop zone has a **Choose Files…** button (was an inline "choose them" link with no accessibility action; identifier `new-project-choose-files`); **File ▸ Open…** (⌘O); a model opened with Counterpart (Finder Open With, a double-click with Counterpart chosen, the Dock icon, `open -a`) opens New Project with it as a drop does. STL, 3MF and USDZ are declared Viewer/Alternate, so the slicer stays the default (Launch Services check in #582); photos aren't declared. A file New Project can't use, opened or dropped, is named with what it takes, from the one list `ObjectsModel.modelExtensions`/`photoExtensions`. `ObjectsModelTests`: the plist is that list's models, an opened file of each type makes the project a drop does, a refused file is named. The button itself has no Mac UI test yet (the pane can't be rendered in `ObjectsModelTests`) | **Gap: board X124.** New can't take a model file yet (ARCore scan, photos, a published link) | New dialog: **Add photos…**, **Add originals…**, **Add scan…** buttons (already labelled controls); unchanged |
| Search, "N of M match", Show All | a pinned field above Home (#329) | a pinned field above the sidebar (#329) | sidebar search (#326) | top-bar search (#329) | Home search; counts within the selected view (#329) |
| Archived | "Archived · N" on Home | "Archived · N" sidebar section | Archived sidebar group | "Archived · N" on Home | Archive view in the sidebar |
| Fold / resize continuity (F4, Nov 8) | One collapsed split: project and Printing history survive; Back clears selection. Checked on the iPhone Duo simulator with `agent-device fold open/closed` (Nov 9): the open project survives both ways, Back while folded returns Home, unfolding then shows the start pane | Same selection on the Duo's inner display and iPad resizes; a notification or Live Activity opens Printing over its project in the detail (`testAFinishedPrintAsksDidItFitOnPrintingAndOpensTheProject` on the iPad). What is open, which column a collapsed split shows and the one sheet that may be up are one value, `ProjectsNavigation` (CounterpartKit), and the fold, unfold, resize, route and sheet cases are its unit tests (`ProjectsNavigationTests`); they replace the two resize UI tests XCTest could not drive. One sheet at a time. A notification's or link's navigation always happens; its sheet takes the place of Settings or Printers but never of a New or Print sheet that is up (an unsent draft or a prepared print is not thrown away), and is then dropped, not queued | Existing single selection | Existing Home/project route | Existing single selection |
| A list row under its phase's heading (Nov 10) | Home's cards carry a phase capsule and the question in quotes; unchanged | Sidebar: the line under a title is the companion's `status.detail` (the question, the size, the stage, or why it stopped), which the companion keeps to 80 characters so it fits its two lines (`events.test.mjs`), never "Needs you ·" under Needs you (`ProjectWordsTests.testARowUnderItsHeadingShowsOnlyWhatDiffers`) | Sidebar: the same detail on up to two lines (`ObjectWords.row`; the project's header keeps the whole line; `ObjectWordsTests.testTheSidebarRowIsTheCompanionsDetailNotItsHeading`) | Home's cards: the line beside the phase capsule is the same detail (`rowLine`) | The list's line is the same detail (`rowWords`, `domain.test.ts`) |
| One main action per project state (Nov 10, U17) | The failed card's Try Again or print, and the bar's Print, take their fill and their words from `ProjectWords.page` (`PageActionsTests`; `LayoutParityUITests.testAStoppedPassWithAnEarlierResultHasOneMainActionWithProjectsPresent`, `testAFinishedPrintsProjectPageOffersPrintingOnceBesideDidItFitWithProjectsPresent`) | Same views | The detail's failed card and bar from `ObjectWords.page` (`ObjectWordsTests.testTheMacsWordsCarryThePagesOneMainAction`) | One filled button on the project page from the Kotlin port (`PageActionsTests.kt`) | The footer from `pageActions` (`domain.test.ts`); Linux has no failed card, so the earlier result's print is in the footer under the same name |
| A scan sent with no words has its own name (Nov 10) | From the companion's title on every layout: what the worker named it, else "Scan, Nov 9, 9:41 PM" (never its size, which is the line under it). In a list the name wraps to two lines before it is cut; rows grow taller; never "Your scan" twice (`events.test.mjs`) | Same | Same | Same | Same |
| A size question (Nov 10) | Project page → the question card: one number field per size the Mac asked about, in its words and prefilled, with **Confirm These Sizes** (or **Send These Sizes** once a number changes), a words box and **Caliper photo**; no Best guess (`LayoutParityUITests.testASizeQuestionShowsItsNumbersPrefilledWithConfirmWithProjectsPresent`). Home's inline answers show only Caliper photo; the fields are on the project page | Same card (the same test on the iPad) | Project → the question card: the same fields and button; numbers only, no words box or photo beside them (`ObjectsModelTests.testASizeQuestionIsAnsweredWithNumbersOnTheMacWithProjectsPresent`) | Project → the question card: the same fields, button, words box and Caliper Photo (`HomeLayoutTests.aSizeQuestionShowsItsNumbersPrefilledAndSendsNumbersWithProjectsPresent`) | Project → the question: the same fields and button, with the words box and a caliper photo (`domain.test.ts`: `sizeFields`, `sizesAnswer`) |
| Whether the computer is answering (Nov 10) | Home's line and banner and Settings' Mac row read one value, `MacLink`: checking, connected, not answering, needs pairing. A request the Mac refuses for another reason counts as an answer (`MacLinkTests`, `AppTests.testARefusedRequestIsNotAConnectionProblem…`). Settings' row has a line per state; needing to pair again says "Connect to your Mac again.", never "Can't reach it right now". A project refresh reports every failure to the link, as the list load does | Same store: the sidebar's line and banner | Its own rule, unchanged: the companion is on the same computer, and the window keeps what it shows until three reads in a row fail (`ObjectsModel.Availability`) | Home's line, banner and the starters read the same sealed `MacLink` (`MacLinkTests`, `HomeLayoutTests.homesConnectionLineAndBannerNeverDisagreeWithProjectsPresent`). It has no Mac row in Settings | Talks to its own companion on the same computer; its shell states are its own (`App.tsx`) |
| Printers and Settings on an open Duo (Nov 10) | Folded Duo and iPhone: unchanged (Home's top bar; the outer display's rail in landscape, by iOS) | Duo unfolded: in the trailing rail, with Share and More when a project is open. iPad: unchanged, above the sidebar (no hinge, no rail); `LayoutParityUITests` still find both buttons there | No rail; unchanged | No foldable layout; unchanged | No rail; unchanged |
| How a pass ended, in a project's history (Nov 10) | Project → Activity: each pass's heading says when it ran and how it ended in the companion's words, a change shows "Your change: …", and the last stage's mark is a question mark when the pass stopped to ask and a cross when it stopped short, never a green tick (`ProjectWordsTests.testAPassSaysHowItLeftThingsAndWhatItWasAsked`). Project → Details: the companion's words for the last pass (`passes[].words`: "Asked you a question", "Stopped at the 120 tool-call limit"), never the wire status (`ProjectWordsTests.testAPassEndsInTheMacsWords`) | Same page | Inspector → Activity: the same words beside each pass's time, and the same marks on its last stage (`Project.Pass.endingWords`, `ending`; it matched spellings the companion never sent) | No pass history is shown on Android; the project's own status line already carries the limit's words | Project → passes: "Pass 1 · <the same words>", the change that started it, and ✓ / ? / ✕ on its last stage (`domain.test.ts`: `passHeading`, `stageMark`) |
| Printer attention and printing summary (F10) | Home's badge and shared summary; “1 needs attention” | Same badge; full wrapping summary above sidebar search | Per-printer attention and printing words; attention count in Printers heading (`ObjectsModelTests`) | Home badge and wrapping summary (`HomeLayoutTests`) | Sidebar Printers button badge; printing summary on Home and sidebar (`domain.test.ts`) |
| Failed projects / Ready rows (F11) | Existing Home grid with explicit failure status | Couldn't finish under Needs you; only selection fills a row | Already under Needs you; only selection fills a row (`ObjectsModelTests`) | Failed cards under Needs you; neutral Ready cards (`HomeLayoutTests`) | Grouped sidebar: Now / Needs you / Ready / Printed (plus Done and Drafts); failed under Needs you; only selection fills a row (`domain.test.ts`) |
| Project pictures (§5.1, §5.4, Nov 10): the gallery (what will print in its spool, Together when the pass recorded seats, What you scanned with its photos, a designer's plates), its labels, the size chip naming what it measures, See it together; and the project's picture everywhere as the object alone on the stage, never a photo; the stage dark for every colour, a dark spool drawn at the fixture's floored `stage.drawnColours` | Project page: `ProjectGalleryView` under the stage (`LayoutParityUITests.testTheProjectGalleryShowsEachThingAndTheProjectPictureIsTheObject`); Projects grid, Now cards, search, the Live Activity and notifications from `picturePath` (CounterpartKit `ProjectGalleryTests`, `AppTests`) | the same view in the detail and the sidebar rows (the same test on the iPad); the Duo folded and unfolded the same as iPhone and iPad | `ProjectDetail`'s segmented control over the stage (a pop-up for more than four), Together in RealityKit, See It Together; sidebar and CloudKit pictures from `thumbnailURL` → `picturePath` (`ObjectsModelTests`) | the labels under the hero over the computer's pictures, See It Together; Home, search and the ongoing-print notification from `picturePath` (`ProjectGalleryTests`, `HomeLayoutTests`) | the labels in the stage; the part turns in 3D in its spool; Together and the scan show the computer's pictures, which a Linux companion can't draw yet (**exception**: no `mac-reconstruct` on Linux, so Linux shows a design's render or the placeholder; Linux has no camera scan); cards from `picturePath` (`domain.test.ts`) |
| Project page | yes | yes, in the detail | yes, with the inspector | yes | yes, with the side panel |
| The question's picture and the scan you sent (David, Nov 9, on his iPad: the ask photo's highlight "is almost impossible to see", and What you sent showing "every single one of these" 130 scan frames). Caption true for any question: "The outlined part is what this question is about." / "The picture that goes with this question." / no picture: "Your project’s picture. No picture came with this question." (shared `AskPicture`); the scan is five frames round the orbit and the count (shared `ScanPhotos`, 130 → frames 1, 33, 66, 98, 130) | Ask card: the photo at the card's width and its own (EXIF-upright) aspect ratio, at most 380 pt tall, rest dimmed and region outlined; tap zooms it full screen (pinch, double-tap). What you sent: the strip and "Your scan · 130 photos"; tapping it opens every frame, each fetched once on screen (`LayoutParityUITests.testTheQuestionsPictureIsLargeTrueToEveryQuestionAndZoomsFullScreen`, `testAQuestionWithoutAPictureShowsTheProjectsPictureAndSaysSo`, `testWhatYouSentShowsTheScanAsOneStripAndFetchesOnlyWhatIsOnScreen`). **Before: a 64-pt square crop captioned "The highlighted part is what I can't see.", and all 130 frames fetched (about 3 MB each)** | the same, at most 460 pt tall (the same tests on the iPad; before, opening the project fetched 122 frames, 429 MB) | Needs-you card: the same picture at the card's width, Quick Look with the region marked; Request: the strip and Show All in a lazy sheet (`ObjectsModelTests.testTheQuestionsPictureAndTheScanStripAreReachableWithProjectsPresent`). **Before: no picture at all; Request listed every frame** | The same picture (region drawn; EXIF applied), a full-screen dialog with pinch and double-tap zoom; What you sent: the strip and Show All in a lazy grid (`HomeLayoutTests.theQuestionsPictureIsLargeAndTheScanIsOneStripWithProjectsPresent`). **Before: the photo without its region, and no scan in What you sent**. Frames are HEIC: Android 8 (API 26–27) can't decode them and shows placeholders | The picture sized to the image so the region lands on the part, rest dimmed, a zoom dialog (wheel, pinch, double-click); Request: the strip and a lazy Show all (`domain.test.ts`). **Before: the region measured against a letterboxed box, so it missed the part; no scan in Request**. Unverified: whether WebKitGTK decodes the iPhone's HEIC frames; if not, the strip shows "Preview unavailable" tiles |
| Print sheet, What will print | yes (#321) | yes, the same sheet | yes (#321) | yes (#324) | yes (#324) |
| Print sheet: a designer's 3MF prints with its own settings, and says so (#336) | † yes: starts at Standard, "Prints with the designer’s settings saved in this file." (`testADesignersFilePrintsWithItsOwnSettings`) | † the same sheet (the same test on the iPad) | † yes (`ObjectsModelTests`) | † yes (`HomeLayoutTests`) | † yes (`domain.test.ts`) |
| Print sheet: a multi-colour model's colours, one spool per part, as the printer MCP proposes them, with its note ("White isn’t loaded. Closest loaded: A2 Sunflower Yellow PLA Basic."), §8.0 #7 | yes (#341; `testMultiColour3MFKeepsAPerPartSpoolRowOnThePhone`) | the same sheet | yes (#341; ControlKit `testTheSheetShowsTheMCPsSpoolNamesFeedsAndNotes`) | † "Colours" rows: a spool menu per part, the MCP's note, the one-feed rule (`ClientTests`). **Before: one spool for the whole model** | † "Colours" rows: a spool menu per part, the MCP's note, the one-feed rule (`domain.test.ts`). **Before: one spool for the whole model** |
| Plates (§5.5): choose any plate on the project and in the Print sheet; a send Counterpart couldn't confirm stays on its own plate ("Check print result") and only that plate asks "I checked the printer" (David, Nov 6: "i can't select which plate to print in the app i can see them but i can't click on them") | † plate cards stay buttons; Print's Plate menu (`ProjectPlatePicker`); `LayoutParityUITests.testEveryPlateStaysChoosableAfterAnUnconfirmedStartOnTheProjectAndInPrint`. **Before: an unconfirmed start disabled every plate, and Print only named its plate** | † the same (the same test on the iPad) | † the same (`ObjectsModelTests`, `ProjectPlateTests`). **Before: as the iPhone** | † plate cards; Print's plate row, radio choices for TalkBack (`HomeLayoutTests`). **Before: as the iPhone** | † plate buttons; Print's Plate select and the check box (`domain.test.ts`). **Before: as the iPhone, and an unconfirmed print couldn't be printed again at all** |
| Add printer… (§5.8): found printers, the MCPs' own setup fields and slicer settings (§8.0 #6), and a field the MCP fetches for the person (`obtain`: "Approve in OctoPrint"), and a web address (https://…, a sub-path) where the MCP's host field takes one (`input: "url"`) | † Printers → Add Printer…: what the MCPs found, one tap each and filled in from discovery; the MCPs' fields, a web address where the MCP's host field takes one, Check, Add, and the MCP's approval button beside the key (`LayoutParityUITests.testAddPrinterFillsAFoundPrinterAndAsksOnlyTheAccessCodeWithProjects`, `testAddPrinterApprovalFromTheMCPFillsTheKey`). **Before: "Add printers in Counterpart on your Mac"** | † the same sheet (the same tests on the iPad) | Settings → Printers → Add Printer…; † the MCPs' fields, the slicer choice, its app and Bambu profiles folder, and the MCP's approval button beside the key | † Printers → Add a Printer: the same found printers, fields, web address and approval button (`HomeLayoutTests`). **Before: "Add one in Counterpart on your computer"** | Settings → Printers → Add a printer; † the same fields and approval button as the Mac. The form shows and sends only the chosen kind's own fields; a found folder whose model nobody could tell asks for it; a typed serial fills the model only when the person hasn't chosen one (`domain.test.ts`) |
| Printers | the toolbar's printer button | the sidebar's printer button | sidebar Printers section; Settings → Printers | Home's printer icon; † Settings → Printers (before: the print sheet said "Settings → Printers", which didn't exist on Android) | Settings → Printers |
| Printer software copies and explicit Move | Printers list/detail and Settings: each effective profile’s path/version (an older copy says so), managed copy separately; each Move names its printers, MCP and copy, in listed order; one accessibility container per MCP; other clients' updates and Moves show from the event stream (`MCPCopiesTests`); † a wait (120 s) or an update under way (35 min) that hears nothing says so and Update and Move come back (`LayoutParityUITests.testAMoveThatNeverHearsBackSaysSoAndCanBePressedAgain`). **Before: Update and Move stayed disabled forever** | Same views at regular width; `LayoutParityUITests` covers both widths | Settings → Printers (#355), `PrinterUpdatesTests`; † the MCP prints don't go through keeps its own row with its version and Update, named by the companion (`testTheRowForTheMcpPrintsDontGoThroughHasItsInstallVersionAndUpdate`), and the 120 s / 35 min clocks (`testAnUpdateUnderWayThatNeverFinishes…`). **Before: that row had no Update** | Printers settings controls, `HomeLayoutTests` (grouping, Moves, another client's Move); † the 120 s wait and 35 min start (`printerSoftwareMoveThatNeverHearsBackSaysSo`, `anMcpUpdateUnderWayThatNeverFinishesSaysSoOnItsOwnClock`). **Before: "waiting" forever** | Settings → Printers (#355), `domain.test.ts`; † the 120 s wait and 35 min start. **Before: "waiting" forever** |
| Code design engine (§8.9, Nov 10): the printer MCP's `cad_status` in the companion's words with its disk size (before Set Up, then after), and Set Up, which runs the MCP's `cad_setup` on the computer and shows its progress and result | Settings → the computer's section: "Code design engine", from `GET /v1/settings/cad` and `POST /v1/settings/cad/setup` (shared `CodeEngineSettingsSection`; `LayoutParityUITests.testTheCodeDesignEngineRowIsInSettingsAndSetUpShowsProgress`, passed on an iOS 27 iPhone 18 Pro simulator; CounterpartKit `ClientTests`) | the same section at regular width (the same test passed on an iPad Air 11 simulator) | Settings → AI → Design engine, first, through `ObjectsModel` → `cad.status`/`cad.setup` (`ObjectsModelTests.testTheDesignEngineRowReadsTheCodeEngineAndSetsItUpWithProjectsPresent`; ControlKit `ObjectsClientTests`) | Settings: "Code design engine" card from `GET /v1/settings/cad` and Set Up (`HomeLayoutTests.settingsShowsTheCodeDesignEngineAndSetsItUpOnTheComputer`, passed in the hosted android check) | Settings → Model access → Design engine, first (`domain.test.ts`) |
| Keep printer software up to date (§8.10, Q9, Nov 10): one switch, on by default, `general.autoUpdateMcps` | Settings → Printer software, above the MCP copies and their Update buttons: "Keep printer software up to date" and what it does; hidden for a Mac that doesn't send the key. Not in General (`SettingsTests`), and not on the Printers sheet, which has no settings model (`LayoutParityUITests`) A copy that isn't updated by itself (a checkout, a global install through ssh, another computer, an install it can't tell) says why on its row (the companion's `uses[].words`, shown as is; `mcp-printer-moves.json`). | The same section at regular width (`LayoutParityUITests` on the iPad) A copy that isn't updated by itself (a checkout, a global install through ssh, another computer, an install it can't tell) says why on its row (the companion's `uses[].words`, shown as is; `mcp-printer-moves.json`). | Settings → Printers → Printer MCPs, above the MCPs and their Update buttons, with the same words (`ObjectsModelTests`) A copy that isn't updated by itself (a checkout, a global install through ssh, another computer, an install it can't tell) says why on its row (the companion's `uses[].words`, shown as is; `mcp-printer-moves.json`). | Home → Printers, once after the printers and their MCP copies; off sends `general.autoUpdateMcps: false`; hidden for a computer that doesn't send the key (`HomeLayoutTests`) A copy that isn't updated by itself (a checkout, a global install through ssh, another computer, an install it can't tell) says why on its row (the companion's `uses[].words`, shown as is; `mcp-printer-moves.json`). | Settings → Printers → Printer tools: "Keep printer software up to date" (`domain.test.ts`). A copy that isn't updated by itself (a checkout, a global install through ssh, another computer, an install it can't tell) says why on its row (the companion's `uses[].words`, shown as is; `mcp-printer-moves.json`). |
| Settings, pairing | Settings sheet; Connect a Different Mac | the same | Settings; Add a Phone | Settings; Connect a Different Computer | Settings; Add a phone |
| Scan it: one capture, paced by the app (a photo each 5°), Done after 60 from two heights; a stopped scan's photos findable; what it stood on cut away on the Mac (§5.2, §5.3; #420) | New → one **Scan it** tile with the Kass 3D link; "Scan stopped · 9 photos kept" on Home and the project. † A finished scan still on the phone says "Scan saved · send to your Mac" with an enabled Send on its project (`LayoutParityUITests`) | † the same tile on LiDAR iPads; the stopped and saved words in the sidebar row and on the project. iPads without LiDAR and the iPhone Duo show the tile disabled ("Needs an iPhone or iPad with LiDAR.") | No camera scan; rebuilds the photos and cuts away the support. | **Exception for now: Android keeps its current scan until the iPhone path is proven** (David, Nov 8/9). † Its finished local scan still offers Send (`ClientTests`), asks Copy / Fit / Save in New | No camera scan |
| Help | Settings → Help: guide, scanning, the scan rig | the same | Help menu: Counterpart Help, the scan rig | † Settings → Help: the guide and the scan rig. **Before: none** | Settings → About → Open guide |
| Offline banner, first run, notification switches (UX walkthrough 2026-11-08, F6/F9/F13/F14/F16) | † Home's banner: **Try Again** (`store.load()`) and **Connect a Different Mac** (`LayoutParityUITests.testTheOfflineBannerOffersTryAgainAndADifferentMac`); a starter's error sits beside **Add to Projects** and says the Mac isn't answering before the tap when the store knows; Welcome's Continue and Home's New never cover content (scroll bottom inset, Needs-you answers inline); first run: dark `CloudPairingView`, **Get Counterpart for Mac** (beta.html), Back from the code screen; Settings → Notifications: one sentence and a link to the app's iOS notification settings instead of disabled switches, and iCloud-unavailable wording. **Before: no banner button, the starter error off-screen, a light pairing screen with no Mac download link or way back, ten disabled switches under a "Connect to your Mac" line** | † the same banner at the top of the sidebar, above the status line (the same test on the iPad); the start pane's and the sidebar's starters show the error, and the pre-tap unreachable line, beside the button (shared `StarterDetail`) | The Mac *is* the computer: no offline-Mac banner and no Mac download link apply. Its notification switches are live (`companion.setNotification`), never disabled. The starter error-beside-the-button fix is shared `CounterpartKit`, so it lands here too | † Home's banner: **Try Again** and **Connect a Different Computer**, which opens pairing (`HomeLayoutTests`); the starter dialog shows its error and the unreachable line at the top; first run: **Get Counterpart for your computer** (beta.html); Settings → Notifications already links to the system notification settings and shows no disabled switches. **Before: banner text only, the starter error under the scroll, no computer download link** | Linux *is* the computer: no offline-Mac banner (its workspace error sits under a **Refresh** action in `App.tsx`) and no download link. Settings shows no unsupported notification switches ("no unsupported switches are shown", `Settings.tsx`), only the live milestone choice |
| After the print (UX walkthrough Nov 8, F1): a finished print's Printing screen, where the Live Activity and print notifications land, asks "Did it fit?" (§5.4) and opens the project | ‡ "Did it fit?" and **Open Project** replace the temperature tiles (`LayoutParityUITests.testAFinishedPrintAsksDidItFitOnPrintingAndOpensTheProject`, `testNeedsChangesOnAFinishedPrintStartsTheChangeOnTheProject`). **Before: 100%, the last temperatures and "The print finished", nothing to do** | ‡ the same, in the detail (the same tests on the iPad) | no Printing screen: a notification selects the project, whose inspector already asks "Did it fit?" | ‡ the same card and **Open Project** (`HomeLayoutTests.aFinishedPrintAsksDidItFitOnPrintingAndOpensTheProject`). **Before: a "Project" button only** | no Printing screen; ‡ the project page asks the same "Did it fit?" (It Works; Needs Changes starts "After printing: " in Ask for changes) once the printer says the print finished (`domain.test.ts`). **Before: only the Status menu** |
| Notification buttons (§9.1, F3) | ‡ each moment's own buttons (`NotificationActions`, CounterpartKit `NotificationActionsTests`); the service extension picks them from the event type | ‡ the same | ‡ the same buttons on Mac notifications, run through the control method a phone command uses (`EventRelayTests`) | ‡ the same buttons, Needs Changes… and Ask for Changes… as replies (`HomeLayoutTests.theDoneNotificationAnswersDidItFitFromItsButtons`). LAN only: Android has no iCloud route | Linux posts no desktop notifications (Settings: "desktop notifications depend on host support"); nothing to add buttons to |
| Notifications while the app is open (§9.2, F7) | ‡ shown, unless that project's page or Printing screen is on screen. **Before: none shown** | ‡ the same | shown (unchanged) | ‡ the same rule. **Before: none posted while open** | none (above) |
| Mac relay default (§8.8, David, Nov 8) | No phone setting; Mac owns push delivery | Same | Settings → Advanced: on by default only for production signing; saved choice wins. Without it, the activity catches up when Counterpart opens | No ActivityKit relay; ongoing print follows the companion | No ActivityKit relay or print notifications |
| Print identity (mark, project picture and words), §9.4 | Counterpart mark + cached project picture (§5.1) on Lock Screen and Dynamic Island; mark while artwork refreshes. An ended activity opens the project | same Lock Screen activity and project link | iPhone-mirrored Live Activity uses the same views; native Mac status item keeps its cube and native print notifications use the app icon and camera frame | Counterpart mark on ongoing and milestone notifications; ongoing print shows the cached project picture (§5.1), refreshes separately, and opens the project (`HomeLayoutTests`) | No print notifications or tray item; print identity is the project picture and words in Printing |
| Progress milestones while a print's Live Activity runs (§9.1, David, Nov 8: an alert on the activity, not a separate notification) | † an alert on the Live Activity through the Mac's relay; a notification when no activity can carry it | † the same on the iPad | The Mac chooses delivery for every paired phone/tablet together (`EventRelayTests`); its own progress notifications stay off by default | unchanged: no Live Activity, so milestones stay notifications | no print notifications |
| First look, New after a scan (U5, Nov 10) | The sheet opens on "What should this scan become?" above "What do you need?", its three answers whole; the button is greyed out reading "Choose what this scan becomes", then "Copy this object", "Continue" (fit: takes you to the words, then "Send to <Mac>") or "Save this scan" (`LayoutParityUITests.testNewAfterAScanOpensOnItsQuestionAndNamesTheChosenAction`). **Before: opened scrolled with its tiles cut off under the header; an orange "Choose what to make" with nothing chosen** | the same, in the system's page-size sheet (`.presentationSizing(.page)`), not a small card over a dimmed Home (the same test on the iPad) | No after-scan question: the Mac doesn't scan; New is a detail pane whose fit/copy picker is always shown and whose button says "Create Project" | the same order, disabled button and words (`HomeLayoutTests.aFinishedScanAsksCopyFitOrSaveBeforeItCanSend`), uncompiled on the Mac | No scan step: New takes a description, files or a link |
| Send on a fit missing its measurement (review F4, X86) | Send with "I measured" and nothing valid entered brings "Enter at least one measurement in millimetres." and the fields to the top of the sheet, then focuses Longest once they have stopped: the line sits above the fields, where the docked keyboard can't reach it (`LayoutParityUITests.testSendOnAFitMissingItsMeasurementGoesToTheFields`). **Before: on the iPad with a hardware keyboard, focus came before the scroll, and the floating number pad stayed where the field had been, over the line and the choices above** | the same; the test puts the iPad in hardware-keyboard mode itself and checks the floating pad sits beside the field and covers neither the line nor the field (the same test on an iPad Air 11-inch in landscape) | New has no measurement fields (a detail pane with the fit/copy picker); a hardware keyboard has no pad to cover anything | the line moved above the fields: focusing Longest brings only the field into view above the keyboard, so a line under it stayed hidden (`HomeLayoutTests.sendOnAFitMissingItsMeasurementGoesToTheFields` still checks it is displayed), uncompiled on the Mac | New has no measurement fields |
| First look, a Result before slicing (U9) | No "—" cards: one row names the printer and says "Print time and filament show here once it's sliced for printing."; tiles only for numbers that exist (`LayoutParityUITests.testAResultBeforeSlicingShowsTheListedPrinterNameAndNoTimeOrFilamentTiles`). A printer chosen for the project that's no longer on the Mac: "The printer chosen for this project isn’t on your Mac anymore." with **Choose a Printer**, which opens this project's print sheet and its printer picker; no printers at all: "No printer set up yet." with **Add a Printer** (`testAResultWhosePrinterIsGoneSaysSoAndChoosesOneForThisProject`, review F3). A printer nobody named is listed by the display name its MCP reports in `counterpart_printer_info`, exactly as given; until it reports one, "Your printer", and "Printer 2", "Printer 3" in the order they were added when several are unnamed at once. **An address is never part of a printer's name** (lead, Nov 10: it tells a person nothing, changes with the router, and a name reaches read-only clients, notifications and the Live Activity); the address shows only on the printer's own settings page, as its own field. The companion composes no brand and applies no casing in any path, and names a person gave are left as they are (`printer-directory.test.mjs`, `objects-printers.test.mjs`, `printer-settings-http.test.mjs`) | the same | No time/filament/printer cards on the project page; its printer list uses the same companion names | No such cards on the project screen | No such cards on the project page |
| The stage is never empty (§5.4, review of #539): shown, waiting with one line, or not available with one line (Try Again after a failed fetch); never a picture of something else; a 3MF with no picture yet still has its entry | `StagePicture`, the only still on the stage (`LayoutParityUITests.testAPictureStageIsShownLoadingWaitingOrSaysItIsNotAvailable` on a 3MF: shown, loading, fetch failed, being drawn, not drawable; `testTheStagePictureIsDrawnLoadingOrSaysItIsNotAvailable` on a scan) | the same view; the same tests on an iPad Air 11-inch in landscape | `StageStill` in `ProjectDetail` (`ObjectsModelTests.testTheStageStillIsShownLoadingOrSaysItIsNotAvailable`). **Before: a bare backdrop while a picture loaded or couldn't be opened** | `StagePicture.kt` (state description `shown`/`loading`/`not available`; the shared fixture's `still` in `ProjectGalleryTests`), uncompiled on the Mac. **Before: one cube for loading, failed and nothing** | `StagePicture` in `Stage.tsx` (`domain.test.ts` reads the fixture's `still`). **Before: a bare ◇ with no path; a plate could show the credit or photo picture** |
| First look, why a search matched (U10) | Under each card whose title lacks the words: a short line from where it matched, words in bold (shared `Project.searchSnippet`, `SearchReason`; `ProjectSearchTests`, `LayoutParityUITests.testASearchResultSaysWhereItMatched`) | the same under each sidebar row | the same under each sidebar row (`ObjectsModelTests.testEverySearchResultWhoseTitleLacksTheWordSaysWhereItMatched`) | under Home's cards and archived rows, from Android's own search: the whole query as one phrase, in the title, instructions and printer only (iOS and Mac match each word across many fields, so a two-word search matching different fields finds results there that Android doesn't); a project without a title still explains its match, and a cut never splits an emoji (`HomeLayoutTests.aSearchResultSaysWhereItMatched`, `searchReasonsSurviveNoTitleEmojiAndArchive`) | under Home's cards, from Linux's own search: the whole query as one phrase across its fields (title, instructions, status, failure, summary, credit, messages, notes, changes, plates); the match marked; the same untitled and emoji cases (`domain.test.ts`) |
| First look, connection line and the end of the list (U11) | Home's subtitle is the system navigation subtitle (unchanged) | The sidebar's line in footnote, `secondaryLabel`. New is a `safeAreaBar` the list scrolls under, with a hard edge and indicators that flash on appear; scrolled to the end, the last row ends above New (`LayoutParityUITests.testNewNeverCoversARow`, which until Nov 10 asserted the list stopped at New's bar). **Before: tiny dark grey; "Done" cut flat at the button with no hint** | The footer's line is the system's primary label at caption size; no change | Home's subtitle 13 sp at #9A9AA0 on black (7.6:1) | Header and sidebar lines darkened to 6.5:1 and 6.2:1 (were 4.2:1 and 4.7:1) |
| First look, Welcome's starters and Continue (U14) | Both starters whole, side by side (shared `StarterProjectsView.cardWidth`: natural width when all fit, both whole when two, a deliberate third-card peek when more; `StarterProjectTests`, `LayoutParityUITests.testWelcomeShowsBothStartersWhole`); Continue's bar has a hard edge so nothing reads through it. **Before: the second starter cut at the margin; the fit card's words showing behind Continue** | the same rule; at iPad width all fit at natural size | the same shared view; at Mac widths, unchanged | Welcome has no starters and Continue is inline at the end; Home's starter row uses the same rule (`starterCardWidth`, `HomeLayoutTests.starterCardsFitWholeOrPeekDeliberately`), uncompiled on the Mac | Starters are a wrapping grid: nothing cut |
| First look, "This build isn't signed for iCloud." (U15) | Shown only in the Simulator or with fixtures: every device build carries `CounterpartCloudEnabled` and the CloudKit entitlements in the one Info.plist Debug and Release share, so TestFlight and the App Store never show it (`CloudBuildTests`). The same rule covers Settings → Notifications' "iCloud isn't available in this build" | the same | Release (`release.sh`) always signs with the CloudKit profile | No iCloud | No iCloud |

On every layout, Together (and See it together) is offered only for a scan in USDZ: the seats are in that scan's frame
(`scan.usdz` world ×1000, Y-up → Z-up), the frame every stage draws. A handheld STL or another mesh has a frame of its
own, so a fit on one shows the part and What you scanned but no Together until a pass records which frame its seats use
(the shared case "a fit with seats on a handheld STL scan" in `project-gallery.json`). With photos sent and no model yet,
the page shows the subject the computer cut out of the first photo (`photoPicture`, the shared photo-only case; iPhone
and iPad in the same UI test).

**Add printer on the phones** (David, 2026-11-06: "adding a printer is filling out a form that hsould be mostly autofilled by discovery"). The iPhone, iPad and Android call the companion's own `printers.discover`, `.check`, `.obtain` and `.add` over `/v1/printers/setup/*` (objects-api.md), so the MCPs still find the printers and declare the fields, and their `.env` files stay on the computer. A found printer opens filled in; the person types only what discovery can't know, such as the access code or API key, or approves it in the printer's own page when the MCP offers that.

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
- **AI → Design engine:** the code design engine's row first (state from `cad_status`, **Set Up**), then Blender's add-on and **Design with Fusion**, which stay until stage 2 (§8.9).
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
| 2 | ~~the `HMS 0500-0500-0001-0007` and "not safely idle" text matches on `print_3mf` errors~~ **Moved** 2026-11-04: bambu-printer-mcp 1.1.57 / mcp-3d-printer-server 1.2.31 return `printer-command-rejected`/`printer-not-ready` as `structuredContent.code`; 1.1.57 installed through the app's Update; the app reads the code (#314). `printer-upload-failed` (the file didn't reach the printer; no command sent) added 2026-11-06 in bambu-printer-mcp 1.1.74 / mcp-3d-printer-server 1.2.57; the app reads it (#385) | the MCPs' structured refusal |
| 3 | ~~`isBambuSlicing`, which slicers accept supports and repetitions, `bambu_model` only for Bambu slicing~~ **Moved** 2026-11-05: bambu-printer-mcp 1.1.58 / mcp-3d-printer-server 1.2.32 report `capabilities.slicing` (supports, copies, orient) and refuse copies they can't make; installed through the app's Update; the app follows the capability (#316) | the MCPs' `counterpart_printer_info` |
| 4 | ~~`services/printer-handoff/src/counterpart.ts`: the `get_printer_status` fallback for MCPs without `counterpart/1`. `services/companion/src/objects/service.ts`: `backend === 'bambu-printer-mcp'` at 632, 722, 1332, 1337, 1378 and 1605~~ **Moved** 2026-11-05: app-only; capabilities, reports, AMS trays and the print tool (`print3mf`/`gcode`) come only from `counterpart_printer_info` and `counterpart_print_progress`; an MCP without them says "Update *MCP* in Settings → Printers". Add Printer's connection check still reads `get_printer_status` (`setup.ts`, `printer-check.ts`, item 6) | deleted; the capability is required |
| 5 | ~~`services/printer-handoff/src/remote-mcp.ts`: the hard-coded per-tool scope table~~ **Moved** 2026-11-05: bambu-printer-mcp 1.1.64 / mcp-3d-printer-server 1.2.42 declare each tool's scope, raising arguments and argument kinds in `_meta["counterpart/remote"]` (equal to the old table on every listed tool); installed through the app's Update (bambu on the Mac, mcp-3D in the Linux app); the app's table, name floors and argument-name lists are deleted | scopes derived from the MCPs' tool annotations |
| 6 | ~~`services/companion/src/printing/discovery.ts` (SSDP, `BAMBU_SERIAL_MODELS` copied from the MCP's `SERIAL_MODELS`); `profiles.ts` and `setup.ts`; the Mac's Add Printer brand list (`PrinterSetupViews.swift`)~~ **Moved** 2026-11-05: bambu-printer-mcp 1.1.63 / mcp-3d-printer-server 1.2.37 answer `counterpart_discover_printers` (each MCP finds its own printers: SSDP, Bonjour) and `counterpart_setup_fields` (every kind it drives, the `.env` settings it reads, its model choices and serial table, and the slicer and profiles it would use). Add printer… on the Mac and Linux renders those fields, slicer path and profiles folder included; `discovery.ts`, `PRINTER_TYPES`, `MODELS`, `BAMBU_SERIAL_MODELS` and `requiredSettings` deleted. **Form made generic** 2026-11-08: Add printer…'s form on every layout shows and sends only the fields the chosen kind's MCP declares, by role (`host`, `port`, `serial`, `model`), and starts on the first kind the MCPs list. A found or added printer's missing model is its MCP's own `model` variable. Check asks for a camera picture only where that MCP's `cameraSnapshot` says `camera_snapshot` reads the kind (bambu-printer-mcp 1.1.82 / mcp-3d-printer-server 1.2.63; an older MCP is one to update). The `"bambu"`, `BAMBU_MODEL` and `BAMBU_DEFAULT_CONNECTION_MODE` branches in CounterpartKit, the Mac sheet, Android and Linux are deleted, and so is Check's reading of the printer's model name. Left in the app: the catalog's identity reading of `.env` names (`objects/printers.ts` `metadata`), Check's per-MCP reading of `get_printer_status` (`setup.ts`, `printer-check.ts`, item 4) and the FULU route copying (`ROUTE_KEYS`, item 12) | a discovery tool, each brand's MCP doing its own, and the MCP declaring its setup fields |
| 7 | ~~`services/companion/src/objects/colour-match.ts` (OKLab nearest spool before slicing), copied into ControlKit `Objects.swift`, CounterpartKit `Printers.swift`/`Project.swift`, the iPhone `PrintSheet.swift` and `apps/linux/src/types.ts`~~ **Moved** 2026-11-05: bambu-printer-mcp 1.1.63 / mcp-3d-printer-server 1.2.37 answer `counterpart_propose_filaments` (each part's spool, verdict and note; the person's `chosen` spools checked against what is loaded; the full mapping) and name each spool; the companion renders it and the clients show its words (`colour-match.ts`, the clients' tray-letter maths and "Closest colour loaded" thresholds deleted). **Which filaments a plate prints moved** 2026-11-06 (#378): `list_3mf_plates` gives each plate its `filaments`, worked out as Bambu Studio does, plus `project_filaments` (bambu-printer-mcp 1.1.73 / mcp-3d-printer-server 1.2.53). The Print sheet's colour rows are exactly that plate's filaments, and `ams_mapping` sends -1 where the plate prints nothing, as Studio does. The Kass scan rig's Screws plate had offered filaments 1 and 2 from other plates on Nov 6 | the MCP proposes the per-part mapping; clients render it and send overrides |
| 8 | ~~`services/printer-handoff/src/slice-cache.ts`: a slice cache keyed on the MCP's env and preset files~~ **Moved** 2026-11-05: bambu-printer-mcp 1.1.64 / mcp-3d-printer-server 1.2.42 keep each finished slice keyed on the slicer executable, the server version and every input file's bytes, and restore an identical one; installed through the app's Update; the app's cache is deleted | the MCP |
| 9 | ~~`slice-estimate.ts`, `slicer-report.ts`: parsing sliced 3MF/G-code metadata and `result.json`~~ **Moved** 2026-11-05: `inspect_print_file` `sliced` (estimate, settings, plate count) and slicing results' `slicer_report` in bambu-printer-mcp 1.1.64 / mcp-3d-printer-server 1.2.42; installed through the app's Update; the app reads them. **Plates moved** 2026-11-06: an imported 3MF's plates, their objects and pictures come from `list_3mf_plates` (bambu-printer-mcp 1.1.69 / mcp-3d-printer-server 1.2.49, installed through the app's Update), and so does the print path's plate check. A 3MF kept before any printer MCP could read it is listed when one can. **Still in the app:** `model-file.ts`'s file checks and its title, designer and licence (the credit; starter-download's Downloads matching reads Designer), next to move into `list_3mf_plates`' answer. Its filament and painting derivation is **deleted** (2026-11-06, #378; item 7). The plate parser `inspectModelFile` still exports plates for those readers until they move | structured results from `inspect_print_file`, `list_3mf_plate_objects` and `get_slice_settings` |
| 10 | ~~`services/companion/src/touchup/invocation.ts` (~42–75): how Bambu Studio orients and generates supports, and how to slice a checkpoint, written into the design prompt~~ **Moved** 2026-11-06: bambu-printer-mcp 1.1.68 / mcp-3d-printer-server 1.2.48 serve `fdm_slicing` for the slicer they run (orient, supports, and how a checked choice reaches the print); 1.1.68 installed through the app's Update on the Mac and served there; a design pass reads it next to `fdm_design`, refuses to start without it ("Update <MCP> in Settings → Printers"), and the app's own rules name no slicer (#338) | the MCPs' `fdm_*` prompts |
| 11 | ~~`services/companion/src/touchup/addon-installer.ts`, `addon-repair.ts` (the Blender add-on); the Mac's `FusionSetup.swift` (the Fusion add-in at a pinned commit and hashes)~~ **Moved** 2026-11-06: bambu-printer-mcp 1.1.67 / mcp-3d-printer-server 1.2.45 (1.2.46 adds Fusion's `message`) have `blender_mcp_setup` and `fusion_mcp_setup`, one Fusion pin for the server and the add-in; 1.1.67 installed through the app's Update and the P1S moved to that copy, where both tools answered on the Mac; the app's copies deleted and the companion's `fusion.setup` runs the tool on the MCP it runs (#349) | the MCP that proxies Blender or Fusion (`blender_mcp_setup`, `fusion_mcp_setup`) |
| 12 | the FULU launcher (`~/Library/Application Support/Scan to Make/printers/fulu-authenticated-lan.sh`, in neither repo). **In both MCPs** 2026-11-06: `BAMBU_NETWORK_BRIDGE_IMAGE` (bambu-printer-mcp 1.1.68, mcp-3d-printer-server 1.2.36–1.2.40) runs FULU's host in Docker with the server's own config folder mounted, which fixes FULU through mcp-3D aborting on its config folder; checked against the real image on the Mac. Left: the Mac's two `.env` files still name the launcher, because the companion finds a FULU route only by `BAMBU_NETWORK_BRIDGE_COMMAND` (`profiles.ts`, `setup.ts`; item 6) | bambu-printer-mcp |
| 13 | **One design engine, stage 2** (David, Nov 9): the Blender and Fusion setup, repair, lock and launch code (`touchup/blender.ts`, `addon-repair.ts`, `fusion-worker-cli.ts`, the Fusion and Blender branches of `touchup/touchup.ts` and `invocation.ts`, `fusion-calls.ts`, the Mac's `FusionSetup.swift`, the Blender and Fusion Settings rows on every layout). Order: (1) `cad/1` in both MCPs (bambu-printer-mcp PR #136; mcp-3D-printer-server port) and the gaps in §8.9 closed there; (2) publish both to npm; (3) install through Counterpart's Update and confirm the code engine is ready in Settings on the Mac; (4) David accepts real fit and cleanup passes on his own device; (5) only then the app PR that deletes this code and requires the capability | `cad_status`, `cad_setup`, `cad_run`, `cad_check_fit` and `cad_design` in both MCPs |

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
4. **Lock Screen, Watch and widgets:** the notification at each milestone (first layer, halfway, done, problem) carries **one** frame, attached by the Notification Service Extension (§9.2), and it reaches the Watch like any notification. The Live Activity shows progress, layer and time left with the cached project picture (§5.1, §9.4); it does not show a live camera frame. ActivityKit pushes carry state, while the app and notification extension refresh the shared project picture separately. Widgets refresh on the system's budget. There is no 15 s camera on the Lock Screen, by design.
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

**Status:** Built. The relay is provisioned for Sandbox and Production. It is on by default in production-signed (Developer ID) Mac builds; a saved Settings choice wins. Development-signed builds stay off by default because their phones use Sandbox tokens. CloudKit owns the pause, done and problem alerts, with their camera frames. A Live Activity push carries an alert on push-to-start, and on a progress milestone while that print's activity runs (§9.1, David, Nov 8); a pause or completion never shows two banners. Not accepted: production push delivery.

**Mac app `EventRelay` (new, Swift).** It loops on `events.wait` and persists its cursor. After a restart it doesn't notify for events older than 10 minutes; it only syncs them.

For every event with `notify ≠ none`:
1. **A Mac notification** (`UNUserNotificationCenter`), according to Settings. Its defaults are the Mac column of §9.1: `pass.ready`, `pass.ask`, `pass.failed`, `print.confirm`, `print.paused`, `print.done`, `print.failed` and `print.not-started` are on; progress, `print.sent` and `print.unreachable` are off.
2. **CloudKit.** Except for a progress milestone (`print.first-layer`, `print.milestone`) that the running Live Activity carries as an alert (§9.1): save a `CounterpartEvent` record in the custom zone `Counterpart` of the private database, in container `iCloud.com.scantomake.counterpart`.
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
  - `apns-priority`: 5 for progress, 10 for start, paused, done, failed and a milestone alert.

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
- **Without the relay** (turned off, no key yet, or the Worker is unreachable):
  - The phone starts the activity itself when the user taps Print, or the next time the app opens during a print.
  - It updates the activity when it gets time: in the foreground, and only occasionally while locked (CloudKit content-available pushes are throttled; `BGAppRefreshTask` runs when iOS allows). So a locked phone's activity falls behind and catches up when Counterpart opens; the Mac's Settings footer says so.
  - Progress milestones come as separate notifications, because nothing can alert the activity.
  - In both modes the activity renders with `Text(timerInterval:)` and `ProgressView(timerInterval:countsDown:)` up to `endsAt`, so it keeps counting between updates. `staleDate = endsAt + 10 min` shows "Checking…" if nothing has arrived.

### 8.9 Design engine: one engine, in the printer MCP

**Decision (David, Nov 9):** Counterpart moves to one design engine. A design or cleanup pass is the same headless `claude -p` worker writing and running a Python script in one confined, headless environment that the printer MCP owns (`cad/1`: `cad_status`, `cad_setup`, `cad_run`, `cad_check_fit` and the `cad_design` prompt). Two prototypes showed it does both jobs better than Blender and Fusion: fit designs exact to calipers plus clearance, a 1 mm change as one parameter edit, the articulated unicorn Blender never finished (`~/scan-to-make-work/cad-engine-prototype-2026-11-09/report.md`); cleanup with letters rebuilt, a bottle label smoothed and cap ribs regular, a potato kept, and a script that regenerates each model (`~/scan-to-make-work/mesh-cleanup-prototype-2026-11-09/report.md`). Blender and Fusion are the path being retired.

**Status:** Stage 1 built (Nov 10). The companion chooses the code engine whenever the printer MCP offers it and it is set up, for fits and copies; Blender and Fusion run exactly as before otherwise. The MCP side is bambu-printer-mcp PR #136 and mcp-3D-printer-server PR #92, both complete and neither merged nor published. Not accepted. Stage 2 (deleting Blender and Fusion from the app) is §8.0 item 13.

**Choosing the engine** (`touchup/touchup.ts`, `codeEngineFor` and `chooseEngine`), from the MCP's structured answers only:

| The printer MCP | The pass |
|---|---|
| lists `cad_status` and `cad_run`, and `cad_status` says `ready: true` | the code engine, for a fit and for a copy or cleanup; no Blender launch, scene reset, Fusion document or their locks |
| lists them, but `cad_status` isn't `ready` (not installed, or installed and not verified since an update, or an error) | today's engine (Blender for a copy, Fusion or Blender for a fit), and the pass's activity says: "This pass used Blender because the code design engine isn't set up. Set it up in Settings for faster designs and cleanups." |
| doesn't list them (an older MCP, or one with `CAD_ENABLED=0`) | today's engine, unchanged, with no note |
| any, with the project's own engine choice (Blender or Fusion) | that choice, exactly as before |

Also on today's path: a change to a Fusion design (it goes back to Fusion), and a copy of a designer's 3MF (it is edited in place, and `cad/1` writes no 3MF project). A capture the companion's converter can't read (§ below) runs on today's engine with its own note.

**What a code pass gets** (`touchup/invocation.ts`):
- The printer MCP exactly as configured, plus this project's passes folder in its `CAD_OUTPUT_DIRS` (any roots the person set are kept). The engine writes runs, and reads scripts and inputs, only there.
- The shared core rules with the code engine's lines (give every `cad_run` the pass's design folder; after each fix, mark the selected whole-model run `final`, so its receipt (`cad-result.json`) selects the model, and never a run that measures the scan or makes one colour's part), the sections the pass needs (a fit: the new design section, and the fit-size section in its fixed order: measurements first; when there is a scan, the ask on any disagreement before fit-critical geometry; each interface sized from the measurements with a fit chosen by its function, reported per interface; and, for the code engine, the `cad_check_fit` result reported in the changes; a copy: the captured-object section from #430 without its Blender line), then the MCP's own `cad_design`, `fdm_design` and `fdm_slicing` prompts as served. How to prepare the fit-check reference, and that a fit check never rescales the scan or resizes a measured interface, are the MCP's `cad_design` prompt's words, not the app's. How a script looks, its libraries, how a scan is prepared and how a run is checked are the MCP's to say; the app names none. A code pass doesn't start without `cad_design`.
- A capture (USDZ) as the companion's own converter makes it (`capture-converter.ts`, `tools/capture-mesh-convert`): the mesh, its material and texture files, and its frame from the conversion report ("the capture converted without changes: 1 unit is 1 metre and +Y is up"). With the MCP's preparation, which needs the units and the object's up axis declared, this is how a cleaned scan comes out in millimetres, Z up, in the orientation the object is used (the cleanup prototype's potato came out on its side). A current-model STL is named as millimetres, Z up.

**What a code pass keeps** (`touchup/runner.ts`, `code-engine.ts`). The worker can't write files, so after it ends, on any ending (a limit or a crash included), the companion files the run folders the MCP left in the pass's design folder:
- only runs the worker marked final count: each run folder's protected receipt `cad-result.json` (cad/1) must say `completed`, `final` and `valid`, with a complete STL. Each such run is a checkpoint (`out/checkpoints/001.stl`, …), in the order they completed. A run not marked final (measuring the scan, one colour's part) never becomes the model, so a pass that measures and then asks, or stops before selecting a run, leaves the project's model alone (found in the Nov 10 holder pass, which made four scan-measurement runs first; until Nov 10 late the signal was a run named `touched`)
- the latest final run becomes `out/touched.stl` and its views the pass's renders, the overall sheet first. Everything is read from disk once the worker ends, on any ending (done, a limit, a crash of the worker, a cancel); nothing is rebuilt to know a run's validation. A companion that is itself stopped mid-pass doesn't collect that attempt: restart recovery keeps only its resumable session, and the resumed attempt is pointed at the previous attempt's run folders;
- that run's script, parameters, input snapshots, STEP and receipt are the pass's design source. The project keeps them in `current/design/` (`current.design: {script, parameters, inputs?, step?, result?}`, the receipt as `touched.result.json`), as `design.f3d` and `parameters.json` are kept for Fusion. A new model from another engine removes them.

**A change to a code design** starts from a copy of the saved script, parameters and input snapshots in the new pass (`design/`), and the worker is told to start from it "as the printer MCP's cad_design prompt says for an edit": a one-dimension change is one `cad_run` with the script and the changed parameter. Checkpoints, the limits and resume (Nov 9, below) work as for every pass; a resumed code pass is pointed at the previous attempt's run folders. Multi-colour requests still combine one run per colour with `counterpart_make_3mf` into `out/touched.3mf`.

**Settings → Code design engine**, on every layout (§6.1): the companion asks the printer MCP's `cad_status` (refreshed every 30 s) and shows "Ready. New designs and scan cleanups use it.", "Not set up yet.", "Installed, but not checked since the last update." or "Update *MCP* in Settings → Printers to use its code design engine." Below it, a size line from the MCP's `storage` fields: before Set Up "Set Up downloads about 367 MB and uses about 1.6 GB on this computer." (`expected_download_bytes`, `expected_installed_bytes`), after it "Uses 1.4 GB on this computer." (`installed_bytes`; nothing while it is unmeasured). The app holds no size, only the formatting. **Set Up** calls `cad_setup {install: true}` in the background (an install outlasts any request), shows "Setting up… N s so far." from the MCP's progress, then the MCP's own `message`. A refusal (`isError` with `{status: "error", code, message, suggestion}`) shows the MCP's `message` and `suggestion` and passes the structured result through; no layout branches on the code. It never starts while a code pass runs: passes and Set Up take the same turn (`CODE_LOCK_PATH`), because the MCP runs one engine job at a time. Clients: `cad.status`/`cad.setup` on the control socket (Mac, Linux), `GET /v1/settings/cad` and `POST /v1/settings/cad/setup` (iPhone, iPad, Android). A plain `GET /v1/settings` carries only the last answer and never starts the printer MCP (settings.md).

**Gaps in `cad/1` for stage 2.** Found Nov 10 and closed in bambu-printer-mcp #136 (`d2f04c75`) and mcp-3D-printer-server #92 (`449d3466`), both still unpublished: disk sizes (`storage`), structured refusals, a protected per-run receipt with `final`, one engine job at a time (a queue), reused input bundles (`.cad-inputs`), renders that show cut-throughs, and fit-reference guidance in `cad_design`. The app follows all of them (Nov 10). Still open: writing an edited 3MF project, so designer copies stay on Blender until then (a stage 2 dependency). Separately, Bambu Studio's command-line slice can block on macOS's "reopen windows?" alert (bambu-printer-mcp #137, mcp-3D-printer-server #93).

#### Blender and Fusion (being retired)

**Status:** Built. Blender runs only while a pass needs it and closes afterwards. A Fusion pass made and exported a parametric cube without touching David's open documents. Not accepted. Runs only when the code engine can't (above).

**Worker lifetime and recovery (Nov 9).** One headless `claude -p --output-format stream-json` process owns a design/touch-up attempt. `touchup/runner.ts` reads its events and enforces **10 minutes without a parsed stream event**, **120 tool calls** (the existing budget), and a **2-hour absolute ceiling**; tests can inject all three. Messages, tool activity, tool replies and system events reset inactivity; stderr and malformed output do not. `project-worker.ts` is the signed credential helper's provider adapter: its Claude branch calls that same runner. Its old independent 900-second timer raced the runner and turned a deadline into cancellation; Claude now has one timer owner, and `model-access.ts` leaves the helper 15 seconds beyond the absolute ceiling to return its result and clean up. Codex/API workers share the limit values and structured limit outcome, but do not claim Claude session recovery.

The read-only state-root survey (`capture/objects/*/object.json`, Nov 9) found 32 `done`/`unchanged` passes; 31 have worker seconds, ranging **44–705 s**. The longest were Vernier caliper (705 s), AirPods hanger revisions (671 and 663 s), Leatherman replica (645 s) and stacking letters (637 s). Retained public tool activity reaches **64 calls** (a lower bound where history was truncated); the largest gap between retained public events in a finished pass was **438.164 s**. Ten minutes leaves headroom over that observed gap; 120 calls retains the prior budget at nearly twice the observed maximum; two hours is a hard safety ceiling roughly ten times the longest completed worker, rather than a normal completion deadline. These observations are bounded by the old 900-second cap and incomplete public activity; they do not prove a production latency target. Articulated unicorn `176821af` has two failed 901-second attempts, both falsely saying `cancelled`.

Each pass keeps validated checkpoint paths, `toolCalls`, a typed `limit` (`inactivity` / `absolute` in milliseconds, `tool-calls` in calls), and the Claude `sessionId`. The session and original session cwd are saved during init, before exit, so restart recovery can use them. The next request on that same project resumes only its immediately previous unfinished session (limit, process crash without a final answer, or companion restart); completed answers and a person's cancel start fresh. Each attempt has new output/checkpoint folders. The continuation prompt names the previous checkpoints, the new folders, the new request and any new photos; the session cwd stays stable across repeated resumptions. A precise missing-session rejection before any work gets one cold start, recorded with a reason. Authentication, tool and model failures do not trigger that fallback. The first limit stop **does not automatically resume**: an inactivity hang or exhausted tool budget should not silently repeat, hide the stop, or spend another budget. Try Again and Ask for changes are the explicit continuation.

**How a pass ends is one closed set** (`services/companion/src/objects/pass-end.ts`): `done`, `unchanged`, `needs_closeup`, `needs_file`, `capped`, `failed`, `interrupted`, the same spellings every client already reads in `passes[].status`. Every ending goes through `endPass`, which closes the open stage, drops the time-left estimate and decides `resumable`: true only for `capped`, `failed` or `interrupted`, only when the ending allows it, and only when the pass has a session. A finished answer or a question to the person never continues a session. **Retry** (`canRetryCleanup`) is offered when the project's failure belongs to its last pass: the companion records which pass failed the project (`failedPass`, never sent to clients) and the store drops that record when anything else changes the failure, so a later printer failure never inherits Retry. Projects saved before this are read the old way (the pass's last activity line equals the failure). Built; companion tests only (`pass-end.test.mjs`).

Resume admission is explicit (`resumable: true`), never inferred from a failed/interrupted status or a saved session ID. The final worker result clears the live flag before post-worker file checks. A thrown pass step disables resume; shutdown can retain it only while the saved session was still live. Restart recovery preserves only that explicit live flag.

Engineering proof: installed Claude Code **2.1.321**, one tiny `-p --output-format stream-json --verbose` conversation and `--resume <session-id>` returned its remembered token with the same session ID (total reported cost **$0.003067**). No app-state migration, existing session backfill, installed-app replacement or real modeling acceptance is claimed.

**Both Blender and Autodesk Fusion are optional dependencies of Counterpart.** Printing existing models that need no changes and reprinting projects must work without either. Their installation and readiness only gate the cleanup, design or editing operation that actually uses them, never pairing, printer setup or printing an existing model.

Without the code engine, scan cleanup uses Blender, and designing a part from scratch ("make something that fits") uses Autodesk Fusion when the user has Fusion installed and set up; otherwise it uses Blender. Both are reached the same way: through a bridge inside the user's printer MCP. The design pass only ever talks to the printer MCP, so nothing changes in the app's UI.

**The worker's rules are composed per pass (Nov 9).** Every pass gets a short shared core: the engine's tools, reading the photos and request, measured versus estimated sizes, planning the print with the printer MCP's guidance, export orientation and supports, units, checkpoints, inspecting from six sides, the final export, and when to ask or fail. On top of it, only the sections the pass needs (`ruleSections` in `touchup/invocation.ts`):

| Section | Given to |
|---|---|
| A new design (interfaces, complete functional geometry in the engine, assembly check) | a fit |
| Cleaning up a captured object (recognise it, fix what the photos support, rebuild manufactured features regular, ink is not shape, §5.3) | a copy, except a designer's 3MF |
| Sizes the part must fit (look up, confirm with an Ask, measured sizes win) | a fit |
| A request in more than one colour or material (one part per colour, `counterpart_make_3mf`, `parts`) | any pass with the person's words, except a designer's 3MF. No input says a request is multi-colour, so any request or change may ask for colours |
| A copy of a designer's 3MF (edit the project in place) | a designer's 3MF |
| A model the person names (never a substitute) | any pass with the person's words |

The printer MCP's `fdm_design` and `fdm_slicing` prompts follow, last. The rules stay generic about printers and slicers (§8.0 item 10). A pass with no kind (the milestone CLI) is a copy when it has a scan and a fit when it doesn't, as `passKind` decides.

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
| `fusion_mcp_status` | `{configured, connected, addinReachable, fusionRunning, activeDesign?, tools[]}`; `activeDesign` (when connected) is whether a design is open, from the add-in's read-only `get_design_type` (bambu-printer-mcp 1.1.76, mcp-3d-printer-server 1.2.56). Takes `launch?: boolean`. When it's true and Fusion isn't running, it runs `open -a "Autodesk Fusion" --env FUSION_MCP_PORT=<port>` and waits up to 90 s for the add-in to answer `ping`. | The Mac asks it through the companion (`fusion.status`), on the copy Settings → Printers runs (with any Update or Move override), and reads only these fields; it never matches the MCP's wording. Whether a design is open comes from `activeDesign`; an MCP without it reads as "update the MCP", never as connected.
| `fusion_mcp_call` | `{tool_name, arguments?, timeout_ms?}` passes the call through to a discovered Faust tool with its full content and errors, never retried. This is the same contract as `blender_mcp_call`. |
| `fusion_mcp_new_design` | Opens a new parametric design document, through `execute_code` with `app.documents.add(FusionDesignDocumentType)`. Faust tools need an active design (issue #12), so the pass calls this first. |
| `fusion_mcp_export` | `{output_dir, name}` writes `<name>.stl` (`export_stl`), `<name>.f3d` (`export_f3d`) and `<name>.parameters.json` (`get_parameters`) into the MCP's allowed output directory, and returns their absolute paths. The STL then goes to `get_stl_info`, `lay_flat` and `slice_stl` like any other model. |

**Choosing between them** (when the code engine can't run the pass). The companion picks the engine for each pass. The agent doesn't choose.
- **Copy an object** (scan cleanup and touch-up): Blender.
- **Make something that fits:** Fusion if `fusion_mcp_status` reports `connected` (calling it with `launch: true` first). Otherwise Blender.
- The pass prompt names the engine and the bridge tools for it, and stays generic about the object.
- The pass result records `engine: "code"|"fusion"|"blender"`. For Fusion it also keeps the project's `design.f3d` and `parameters.json`, so a later "Ask for changes" pass starts from the parametric design instead of the mesh.

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
- **Update installs right away, whatever the printer is doing.** David, Nov 6: "the printer being busy has nothing to do with a update for an mcp, and also, that print has nothing to do with counterpart right now it was printed by studio". A running print lives on the printer; restarting the MCP doesn't touch it. The only thing that delays an update is Counterpart's own work on that MCP at that moment (a send, a slice, a design pass, held in the print gate). It waits for that for up to a minute, saying "Updates as soon as Counterpart finishes its work on this printer." with no spinner, then runs; if the work is still going, the update ends with a sentence and the person presses Update again. When it runs, npm is asked again, so the newest version is the one installed.
- **Nothing in an update waits forever.** npm and git runs (their whole process group), the in-flight check, and the MCP's restart and connect each have a deadline. Past it, the update ends with `mcp.update.failed` and a sentence; a printer that couldn't be switched back says so rather than claiming the previous version is back.
- **No layout waits forever either.** An update the companion never finishes (its event went missing, say after a restart) says "Counterpart didn’t say whether this updated. Try Update again.", and Update and Move can be pressed again, on the Mac, iPhone and iPad (one clock, CounterpartKit's `MCPUpdateWaits`), Android and Linux. The limits come from the companion's own bounds: a wait (`waiting`) after 120 s (it waits up to 60 s for Counterpart's work, then one claim and one npm lookup, ~97 s before `started`); an update under way (`started`) after 35 minutes (three install steps of up to 10 minutes each, plus the MCP's restart).
- **Every installed MCP has its row in Settings → Printers**, with its Update or waiting state. If the list can't be read, Settings says so with Try Again, and never shows a shorter list (Nov 6: "now i only see one to update and missing the other one"). A printer set up in both MCPs names, for each MCP, the install it runs, its name and its versions (`destination.mcps[]`), and every printer names the MCP its prints go through (`mcpLabel`), so the MCP its prints don't go through keeps a row with its own Update; the app takes those names as sent and never names a package itself. On the Mac these printer-built rows are only the fallback for when `printers.mcps` can't be read; with it, Settings lists each MCP's packages and copies from `printers.mcps` instead.
- **After an update:** the companion closes that MCP's sessions, opens one again, re-reads its capabilities (§8.2) and shows the new version.
- **On failure:** the previous version stays in use (npm and git leave it intact), and the log is attached to `mcp.update.failed`.
- **A restart in the middle of an update is undone at the next start.** The companion writes each update down before it changes anything (`printers/mcp-updates/`, one file per install: what it is swapping and the overrides as they were). When it starts and finds one, it puts the previous copy and overrides back before any MCP session connects, and sends one `mcp.update.failed` saying what it did, so no app waits on an update that will never report. A git checkout is not rebuilt at start; its sentence names the commit it was at and says to press Update again, and a checkout whose own undo failed keeps its record so the next start says so once more. An update that reached its own end writes that down before it deletes the previous copy, so a record that couldn't be removed is never read as an update cut short. A file in that folder that isn't a journal this build wrote (torn, hand-edited, another build's shape) changes nothing on the Mac: it is renamed aside, said once if it names an MCP, and the companion starts. Built; engineering tests only (a companion stopped at each step in `mcp-updates.test.mjs`), not accepted.
- **The same flow** updates the Fusion MCP pin (§8.9) once a new pin has passed its acceptance check.
- **Keep printer software up to date** (Q9; David, Nov 10: "there should be an 'auto update' toggle and ours should default to on"). One switch, `general.autoUpdateMcps` in the shared settings (settings.md), on unless the person turns it off. **Built; engineering tests only, not accepted.** Off is exactly the Update button above.
  - *When:* `McpAutoUpdater` (`printing/mcp-auto-update.ts`) asks npm two minutes after the companion starts and then every six hours (the MCPs' own cadence) with up to 30 minutes of jitter. npm that can't be reached is quiet and asked again at the next run.
  - *What* (`McpUpdater.autoTargets`; lead's decision, Nov 10: "every printer is kept current except one the person runs from their own git checkout or on another machine"): Counterpart's own copies (`<data root>/printers/…`, with or without a printer on them) and the npx pins it saves are updated in place. A printer on a global npm install is moved to Counterpart's own copy at the newest version, through Move's own path and the same counterpart/1 check; the global install is never changed, because another MCP client may run it. The person hears it once: "Counterpart now runs its own copy of <package> (<version>) so it can keep it up to date. Your other install was not changed." A failed move leaves the printer on the global install and isn't tried again for that version. Counterpart's own copy stays current wherever it runs, including one reached through an ssh command on this Mac (the Nov 6 forced-command setup): it is updated in place and the printer is reached the same way. A copy the person manages (a git checkout, a global install reached through ssh), a copy on another computer, and an install Counterpart can't tell are never changed by themselves (`autoUpdateKind`), and their row in Settings → Printers says why, in the companion's words (`uses[].words`): "Runs from a folder you manage…", "Runs through ssh from an install you manage…", "Runs on another computer (<host>)…", "Counterpart can't tell how this was installed, so it doesn't update it by itself." (lead, Nov 10: "A copy that Counterpart itself installed and manages stays current wherever it runs … What is never touched by itself is a copy the person manages").
  - *Only while idle,* by the companion's own answers, checked before each install, cheapest first (`companionBusy`): the print gate (a send, a slice, a design or cleanup pass, an answer, a Move, the Blender add-on's repair), Update or Download running, Add printer…'s steps (`PrinterSetup.working`), the code engine's and Fusion's Set Up, and printing (a project printing there, or the printer's own report, the check Complete Settings and Remove use). Busy changes nothing and looks again a minute later, so the update runs soon after the work ends. A print started meanwhile is still refused by the print gate while the update holds it.
  - *How:* the same journaled install as Update, run to its end, one install at a time. After the new copy is in place and before any printer is moved to it, it is started on its own with no printer settings (as Add printer… starts one, so nothing reaches a printer) and must list and answer `counterpart_setup_fields` with `contract: "counterpart/1"`; then every printer on it restarts and connects as with Update. If either fails, the previous copy is put back by itself and that version is never tried again by itself (`printers/auto-update.json`); a newer one is. A failure before anything changed (npm couldn't install it) is quiet and tried at the next two runs, then said once.
  - *Said afterwards, never before and never as a question:* no `started` or `waiting`; one `mcp.update.done` ("Updated automatically from 1.1.78. Your printers use 1.1.79 now.") or `mcp.update.failed` ("Counterpart tried 1.1.79 by itself and put 1.1.78 back: …").
  - *Just the diff:* measured Nov 10 with npm 11 into a scratch prefix whose cache held the previous version: bambu-printer-mcp 1.1.78 → 1.1.79 added 0.9 MB to npm's cache and fetched no dependency tarball (a cold install fetches 200 tarballs, 79 MB); mcp-3d-printer-server 1.2.59 → 1.2.60 added 5.4 MB (cold: 178 tarballs, 82 MB). The staged copy is still a full 103–106 MB install on disk (hard work for npm, not the network), and bambu-printer-mcp's own postinstall may download more. npm has no patch-level download, so this is as close to "just the diff" as it offers.

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
- **Credit the designer.** The project's title is the model's name (from the file or its page). A model file that brings no name is titled from the person's typed words like any other project, once the file is here and by backfill for older ones, never before, so a generated title cannot take the place of the source's own; the companion decides this and no client cuts the request into a title (Nov 10: "First plate from Counterpart's own kernel…"); the project page shows "by *designer* on *site*" and links back to the page. Printing goes through the user's own download, and Counterpart never re-hosts the files.

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
| `print.first-layer` | while the print's Live Activity runs: an alert on the activity, no sound; otherwise "*Title*: first layer's down", with the frame | **Open Print**, **Pause** (notification only) | passive | off |
| `print.milestone` | while the print's Live Activity runs: an alert on the activity; otherwise "*Title* is halfway" · time left, layer, printer, with the frame | **Open Print**, **Pause** (notification only) | active | off |
| `print.paused` | "*Printer* paused *title*" · reason, with the frame | **Open Print**, **Resume** | time-sensitive | on |
| `print.done` | "*Title* is done. Take it off the plate.", with the frame | **It Works** (background), **Needs Changes…** (text input, background), **Open Project** | active | on |
| `print.failed` / `print.not-started` / `pass.failed` | what happened and what to do | **Try Again** (a print: opens Print, never prints by itself; a pass: opens the project), **Open Project** | time-sensitive (print) / active (pass) | on |
| `print.unreachable` | "Lost contact with *printer*. Still trying." | — | passive | off |

Each row has its own switch in Settings → Notifications, on both devices. The milestone choice is in the same place (§8.6).

**Buttons** (`NotificationActions` in CounterpartKit; Android `NotificationActions.kt`). Each **Open** says where it goes: **Open Print** opens the Printing screen, **Open Project** the project. The same buttons are on Mac notifications. A button only acts on its own moment: a cancelled or sent print (`ENDED`) and a lost connection (`PROBLEM`) get only Open Project. The CloudKit subscriptions carry one category for several types, so the service extension sets the category from the event's `type` before it fetches the record. Background buttons need the phone unlocked (`.authenticationRequired`): the pairing is in the Keychain, readable only while unlocked, so Pause from the Lock Screen asks for Face ID first.

**Milestones on the Live Activity** (David, Nov 8; delivery decision refined by the lead Nov 9). Before sending anything, the Mac chooses activity alerts only when every paired device returned by `devices.list`, plus the devices known through LAN/iCloud activity registrations, has a live token for this print. Saved phone notification choices must also allow that milestone; an opt-out or an unreadable choice stays on the existing CloudKit path. Otherwise the milestone goes to CloudKit for everyone. If the device list cannot be read, only a known single-device account can use activity alerting.

Once activity delivery is chosen, the full event and each recipient's pending/result/retry state are persisted before the event cursor advances. Distinct milestones queue in order; statuses can refresh their content without replacing an alert. Network failures and short 429/503 waits retain the alert for up to three attempts, including across a restart; an unconfigured relay or a long wait resolves the recipient as failed. A confirmed recipient is never replayed during recovery. Each resume uses a fresh settings reply: unknown phone choices leave the recipient pending while silent progress updates continue; a saved opt-out receives no ActivityKit milestone alert. A missing activity registration gets a 30-second grace period from first enqueue, then recovery resolves it as failed so a dismissed activity cannot strand the decision. Push-to-start retries retain their required alert; only optional milestone alerts can be stripped, preserving the underlying update's priority (including immediate paused updates). After all recipients finish: all failed means one CloudKit fallback, retained until the CloudKit write is confirmed; any success means no CloudKit fallback, and each missed device is logged. A device that misses a progress alert receives current progress on the next activity update. Pause, problems and done remain normal notifications. Alerting updates use priority 10 and the companion's title/body; the passive first layer has no sound. The activity shows the project's picture (§5.1, §9.4), rather than the notification's camera frame. The phone does not add a second local alert while foregrounded. See [ActivityKit push notifications](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications) and the [Live Activities HIG](https://developer.apple.com/design/human-interface-guidelines/live-activities).

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
- Background actions without a destructive outcome run without opening the app: **Ask for Changes…** (`UNTextInputNotificationAction`), **Best Guess**, **Pause**, **Resume**, **It Works** and **Needs Changes…** (`UNTextInputNotificationAction`; it marks the project and sends "After printing: " and the words as a change).
- Each one sends its command to the Mac:
  - directly on the LAN, through the existing routes: `POST …/corrections`, `…/closeup`, `PATCH …/settings {"status"}`; pause and resume go through `POST …/print/pause` and `…/print/resume`;
  - otherwise, only when the Mac can't be reached at all (`/healthz` doesn't answer), as `CounterpartCommand` records (§9.3). Never after the Mac took the request: a second try could start a second change.
  - A failure is said in a notification ("Couldn't pause the print: *title*").
- **Print** and **Camera** open the app at the right screen.

**No double banners.**
- In the foreground, `userNotificationCenter(_:willPresent:)` suppresses a notification only while its project's page or Printing screen is on screen: that screen already shows the change. Anywhere else (Home, Settings, another project's Print sheet) it shows as a banner. Android posts from its foreground event stream by the same rule.

### 9.3 Commands from anywhere (CloudKit)

**Status:** Built. Not accepted away from home.

- **How a command travels.** When the phone can't reach the Mac directly, it writes a `CounterpartCommand` record into the same private zone:
  - `{type, projectId, payload, photos[CKAsset]}` (the fields deployed in Production, `docs/protocols/cloudkit-schema.ckdb`); the record name is the command's id and the server's creation date is its age. `type` is one of `print | correct | answerAsk | confirm | pause | resume | cancel | status`. `status` (`{"status": "works" | "needs-changes", "note"?}`) is "Did it fit?" answered from a notification; Needs Changes' words ride in the same record, so the Mac sets the status before it starts the change.
- **How the Mac receives it.** The Mac app subscribes to that record type (content-available) and also fetches on launch and on wake.
  - It runs each command through the control socket method that already does the same job: `objects.print`, `objects.correct`, `objects.answerCloseup`, `objects.answerPrintConfirmation`, `objects.settings.set` (status), plus the new pause, resume and cancel.
  - It writes the result back as `status: done|failed` with a message, and deletes the record a day later.
- **Commands are bounded.** The Mac acts only on commands from its own private database that are less than 10 minutes old.
- **The print confirmation is unchanged.** Starting a physical print still answers the printer MCP's own confirmation:
  1. it arrives on the phone as `print.confirm`;
  2. the user's answer goes back as a `confirm` command.

### 9.4 Live Activity

**Status:** Built. Test start, update and end were seen on the Lock Screen through the Sandbox relay. Not accepted: a real print, the Watch, production push.

Screenshots: `screens/phone-lock.jpg` and `screens/phone-island.jpg` (approximations: the system draws the Lock Screen and the Dynamic Island).

`PrintAttributes {projectId, printId, title, printerName}`; content state `{state, progress, layer, totalLayers, endsAt, stage, problem?}`.

**Identity** (David, Nov 8: "the live activities thing on ios uses some generic printer svg not our logo, the critical updates come through with our logo and a thumbnail that looks nice … you'd think for sure you were using two different apps to track this print"). The activity wears the notifications' identity: the Counterpart mark (`CounterpartMark`, drawn from `docs/brand/counterpart-mark.svg`) in filament orange, the project's own picture, and the notifications' words. Apple's HIG for Live Activities says to show a logo mark "without a container … Don't use the entire app icon", and on the Lock Screen "Don't replicate notification layouts", so the mark, colour, picture and words are shared and the layout is the activity's own. The default system background follows Light and Dark like the notifications beside it.

| Presentation | Content (built) |
|---|---|
| **Lock Screen** (and StandBy, which scales it up) | the project's picture (56 pt), or the mark when there is none; the title, led by a small mark when the picture shows; the percent; "Printing · *37:59* left", counting down on its own toward `endsAt`; the milestone notification's detail, "layer *l* of *L* · *printer*", or the printer's problem; an orange bar. **Pause** and **Camera** buttons (`LiveActivityIntent`) are not built. |
| **Dynamic Island, compact** | the mark and the percent |
| **Dynamic Island, limited width** (iPhone Duo, landscape, two activities: Apple's 28 pt circle) | the mark and a progress ring |
| **Dynamic Island, minimal** | a progress ring around the mark |
| **Dynamic Island, expanded** | the picture (or the mark), the title, the percent, the bar, and "Printing · *37:59* left · layer *l* of *L* · *printer*"; the island's key line is orange |

- **The picture.** The widget can't reach the Mac, so the app refreshes each live or ready project's picture (`thumbnailPath`: the project's picture as the Mac drew it, §5.1; a design's render until then; never a photo) into the App Group `group.com.scantomake.counterpart` independently of activity updates. Updates use the cached picture or mark immediately, keyed by project id (`PrintActivityThumbnails`, at most 168 px, as Apple requires images no larger than the presentation). The notification service preserves the enriched notification (including its camera frame and interruption level), then gives the Mac's copy of the same project picture from `CounterpartProject` at most two seconds. On timeout or expiry it delivers the enriched content, so an activity the Mac started by push has it too. The newer project `updatedAt` wins. `PrintAttributes` is unchanged, so the relay's contract is too.
- It also appears automatically in StandBy, on the Watch Smart Stack, in CarPlay and in the Mac menu bar. Apple: the Smart Stack and CarPlay combine the compact views, and the Mac menu bar uses the compact, minimal and expanded views unchanged, so the mark carries to all of them. Not seen on a Watch, in CarPlay or in a Mac menu bar yet.
- **Tapping it** opens Printing while the print runs, and the project once it has finished, failed or been cancelled (`PrintActivityLink`): an ended activity stays on the Lock Screen for up to four hours, and Printing has nothing left to follow.
- Starting and updating it follow §8.8: through the relay when there's an APNs key, and from the phone itself otherwise.
- **Progress milestones alert on it** when all known paired recipients have this print's activity (§9.1). Delivery is selected once per milestone. A partial miss is logged with the device and does not trigger account-wide CloudKit fallback; all recipients failing does. When device enumeration is unavailable, a single-device guard applies.

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

**Status:** **Labs; unavailable in the public beta** (`HandheldCapture.offered = false`). David, 2026-11-07: "scan in hand can be labs and ar shouldn't block it". The existing recorder (`HandheldCapture.swift`, `HandheldDepthRecorder.swift`, `tools/mac-reconstruct samples`) is not accepted; the release does not re-enable it. Printer testing can use an imported STL/3MF without capture or AR. A Codex review found defects that remain open: 24 frames at 10 fps covers only ~2.4 s of nearly identical views; `ObjectMasker` erases the object when a hand is nearer than it; and reconstruction failure reporting was insufficient. Private bounded stderr retention has since landed in `reconstruct.ts`; that improves diagnosis, not capture quality. Its advice: try Apple's own masking (`--no-masks`) first, then move to sharp still photos with depth and turn-pause-capture guidance.

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

**Status:** Superseded Nov 9 (#420): there is no rig mode. The rig is optional; the phone on any arm runs the same Scan it capture with the same rules (§5.3). David, Nov 9: "the rig is just a thing someone might use, other people might not — don't hardcode the rig's existence into 'this is how all scans work'". Counterpart only links to Kass 3D's rig and credits it (New's Scan it tile, Settings, §15). The text below is the earlier plan, kept for its history.

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

1. **Distribution: decided.** TestFlight for the iPhone app (App Store name *Counterpart 3D*, public beta group *Counterpart Public Beta*), and Developer ID with Sparkle for the Mac (v2.0-beta.6 notarized and published at counterpart.dtmont.com/beta.html). The procedure is in [`docs/distribution.md`](../../distribution.md). Build 2.0 (4) was approved in the external group November 7; the public link is enabled and feedback is On. Still open: a fresh external-tester installation and production push delivery.
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
