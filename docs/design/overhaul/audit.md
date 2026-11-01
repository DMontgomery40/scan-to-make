# Counterpart: where the iPhone and Mac apps stand (2026-11-01)

This audit covers the builds actually installed: the iPhone app on the owner's phone and the Mac app running in `/Applications`. Both come from the `feat/counterpart-project-workspace` branch, which is ahead of `main` and still being worked on. The redesign answers it in [PRD.md](PRD.md).

The evidence is in [`audit/`](audit/).

| File | What it shows |
|---|---|
| `phone-installed-project.jpg` | The iPhone project page, as the owner photographed it |
| `mac-installed-2026-11-01.jpg` | The Mac window as it is on screen now |
| `mac-previous-build.jpg` | The previous Mac build, with Settings open |
| `reference-bambu-handy.jpg` | The print flow the owner pointed to as the bar to meet |

## 1. Verdict

Neither app is designed. Each is a set of forms, one per plumbing ticket.
- The back end works: capture, touch-up through the user's printer MCP and Blender, slicing, printing.
- The apps give no account of what that back end is doing: what it is working on, how long it will take, what it needs from you, or where your print is going.
- No notification of any kind exists in either app.
- Half the iPhone app still runs inside a React Native shell.

The redesign is a rebuild of the user-facing layer. The capture module and the companion stay.

## 2. iPhone app

| # | Finding | Evidence |
|---|---|---|
| P1 | **Two runtimes.** The app is SwiftUI hosted in a React Native shell. `App.tsx` mounts the `STMObjectsApp` native view, but pairing (`FindYourMacScreen.tsx`), pairing links and credential refresh are still React Native, with their own look. | `apps/mobile/App.tsx`, `apps/mobile/src/` |
| P2 | **One 1,709-line file.** Every screen lives in `ObjectsApp.swift`. `ObjectsModel.swift` exists as two identical copies, one in the app and one in `ObjectsCoreTests`. The status words are written twice: `ObjectWords` in the Mac's ControlKit and again in the phone. | `apps/mobile/ios/ScanToMake/Objects/` |
| P3 | **The main action was out of reach.** On `main`, the only way to start is a `+` in the top-right toolbar. Scanning appeared only after opening and dismissing the photo picker. The workspace branch now lists Scan, Capture in Hand and Photos in a Form, but the button that opens them is still the top-right `+`. | `ObjectsApp.swift` `listToolbar`, `NewObjectView` |
| P4 | **The project page is a document dump.** The AI's markdown reply is printed as body text. A red warning ("The printer may have started this print…") offers no action. The printer picker is greyed out. The main button ("It Isn't Printing, Print Again") sits on top of the text. The "3D" view is a carousel of static renders. | `audit/phone-installed-project.jpg` |
| P5 | **No sense of progress.** There's no estimate, stage list, live progress, or "you can put the phone down". Activity exists on the branch as a raw list of worker messages. | `ProjectActivity` |
| P6 | **No notifications.** There's no `UNUserNotificationCenter` call, no `aps-environment` entitlement, no Live Activity and no widget, in either app. | `grep` over `apps/` finds none |
| P7 | **Printing has no choices.** The branch added a printer and filament list. There's still no profile or quality choice, no time or grams before you commit, and no colour-to-part mapping. The printer's confirmation form is rendered raw. | `PhonePrintPreparation` |
| P8 | **The bed photo always appears.** The camera photo shows on every print and asks for a confirmation. It should appear only when something is on the plate. | `ObjectDetailView` confirmation |
| P9 | **The Mac never asks for anything.** There's no structured "the Mac needs a close-up of X" card with Camera, Photos or Best guess. | companion has no ask object |
| P10 | **In-hand capture has never worked on the device.** The first build used the front TrueDepth camera, so all frames were black and there was no depth. The next build used the rear LiDAR camera but shot at 1/40 s with the object filling about 2% of the frame. The Mac's error text is thrown away. The walk-around Object Capture works and stays as it is. | `research/inhand-capture.md` §1 |
| P11 | **Identity.** On `main` there's no app name, version, help, website or connection status. The workspace branch's Settings adds them. | — |

## 3. Mac app

| # | Finding | Evidence |
|---|---|---|
| M1 | **It fights the scene system.** The app switches activation policy between `.accessory` and `.regular` by hand and builds five `NSWindow`s itself. `DesignStability.swift` exists to stop windows shaking. | `apps/mac/App/ObjectsWindow.swift`, `Main.swift` |
| M2 | **The names are meaningless.** Projects are listed as "Unfinished project", "Something new", "Copy of your scan" and "Photo project". Status says "Needs attention" without saying what needs attention. | `ControlKit/ObjectWords.swift:37-43`, `audit/mac-installed-2026-11-01.jpg` |
| M3 | **The project page has no hierarchy.** A warning, Prepare to Print, a greyed printer field, Open in Slicer, Open in Blender, a segmented control, a model, a filmstrip and a wall of AI text all have the same weight. | screenshot |
| M4 | **Devices aren't de-duplicated.** Settings lists six identical "My phone" rows. Every re-pair adds a row. | `audit/mac-previous-build.jpg` |
| M5 | **No notifications** on the Mac, not even local ones. | — |
| M6 | **The model viewer is a static render.** The Mac has RealityKit, which would allow a real orbitable model. | — |

## 4. Back-end gaps that the UX depends on

The companion already has most of what's needed (`services/companion/src/objects/`). It is missing:
- **Per-stage timing and an estimate** (`startedAtMs` exists; a stage list with typical durations doesn't).
- **A structured `ask`** (question, region photo, allowed answers) instead of free text.
- **A short generated title** ("Mic mount"), not a truncated request.
- **A structured "what changed" summary** (added, changed, assumed and estimated items) instead of a markdown reply.
- **Print events** (started, layer progress, paused, failed, done, plate obstruction) emitted as records, so they can become notifications.
- **A stable device identity** at pairing, so re-pairing replaces a device instead of adding one. The workspace branch has started on this.

## 5. What the owner has asked for, in the order the PRD answers it

1. Keep the main action within thumb reach and visible without digging.
2. Let people describe what they need, and keep that text.
3. Show every project with its inputs, photos, request, progress and the model's trace.
4. Say what the Mac is doing, how long it will take, and that the phone can go down. Notify when it's ready.
5. From the notification, go straight to the result: print it, or say what's wrong and send it back.
6. Check the plate in the background. Show the camera only when something is on it, with "it's actually clear" as an answer.
7. Take close-ups from the scan by themselves. Ask only for a specific missing view, with Camera, Photos and Best guess.
8. Show which printer a print goes to, and handle more than one printer, from either MCP.
9. Before printing, choose colours and a profile, the way the Bambu Handy print flow does.
10. Give the app a name, help, a version and connection status.
11. Make in-hand scanning work, without breaking the walk-around scan.
12. Make all of this available on both the Mac and the phone.
