# Counterpart redesign: Apple design research (iOS 27.2 / macOS 27)

Researched 2026-11-01, using about 20 search and fetch calls. Every claim below cites the URL it came from.

- **[Apple]** marks Apple primary sources: Newsroom, developer.apple.com documentation JSON, and WWDC26 session pages.
- **[press]** marks secondhand coverage.
- **not found** means I could not find a source within the budget.

Apple's developer documentation pages are rendered with JavaScript, so I read them through their JSON endpoints, `https://developer.apple.com/tutorials/data/documentation/<path>.json`. The human-readable URL is cited.

---

## 1. Apple Design Awards 2026

The winners were announced June 2, 2026, ahead of WWDC26. There are six categories, each with an app winner, a game winner, and finalists. **[Apple]** https://www.apple.com/newsroom/2026/06/apple-reveals-winners-of-the-2026-apple-design-awards/

| Category | App winner | Game winner | Finalists |
|---|---|---|---|
| Delight and Fun | grug (Ocho) | Is This Seat Taken? | Blippo+ (Panic), Metaballs, BALL x PIT, PowerWash Simulator |
| Inclusivity | Guitar Wiz (Bijoy Thangaraj) | Pine Hearts | Hearing Buddy, Structured, Sago Mini Jinja's Garden, Civilization VII |
| Innovation | NBA: Live Games & Scores | Blue Prince | D-Day: The Camera Soldier, Detail: AI Video Editor, Pickle Pro, TR-49 |
| Interaction | Moonlitt: Moon Phase Tracker (Flipping Hues) | Sago Mini Jinja's Garden | The Outsiders: Athlete Tracker, Tide Guide, Grand Mountain Adventure 2, TR-49 |
| Social Impact | Primary: News in Depth | Consume Me | Katha Room, Harvee, despelote, Spilled! |
| Visuals and Graphics | Tide Guide: Charts & Tables (Condor Digital) | Cyberpunk 2077: Ultimate Edition | Caradise, (Not Boring) Camera, Arknights: Endfield, SILT |

Source for the table: the same Newsroom URL. An earlier search summary listed finalists one category off from Apple's page, so I used only the fetched Apple page.

### Why Apple honoured the relevant apps (Apple's stated reasons)

The Newsroom page gives reasons only for the winners. It gives **no descriptions of finalists**, so for the finalists the reasons are **not found**.

1. **Moonlitt (Interaction winner).** Apple cites "broad platform support", "easy onboarding", and "best-in-class Liquid Glass integration", which together let people track the sky "in a simple and intuitive way". This is the closest model for Counterpart: a single-purpose utility that wins on glass, onboarding and multi-device reach. **[Apple]** Newsroom URL above.
2. **Tide Guide (Visuals and Graphics winner, Interaction finalist).** Apple cites "full-screen charts ... filled with custom animations", "Liquid Glass integration", an "aquatic theme", and a "sky-matching palette". The lesson is a data-first, full-bleed visualisation with glass controls floating above it, plus a palette that comes from the subject. **[Apple]** Newsroom URL above.
3. **Guitar Wiz (Inclusivity winner).** Apple cites spoken instructions "on everything from pitch to finger placement", plus "Dynamic Type, Increased Contrast, and Differentiate Without Color". The lesson is to guide a physical task by voice and to support the system accessibility settings. **[Apple]** Newsroom URL above.
4. **NBA (Innovation winner).** On Apple Vision Pro it shows "up to five live games at once", floating leaderboards, a 3D court with tabletop mode, and Spatial Audio. For Counterpart, the relevant idea is a tabletop 3D model of a physical object. **[Apple]** Newsroom URL above.
5. **Primary: News in Depth (Social Impact winner).** Apple calls its spatial Vision Pro interface "smartly organized and seamlessly integrated". **[Apple]** Newsroom URL above.
6. **grug (Delight and Fun winner).** Apple says "each prompt is thoughtfully delivered", meaning one moment at a time. **[Apple]** Newsroom URL above.
7. **Relevant finalists, with no reasons published:**
   - Detail: AI Video Editor, a creative and AI tool. It was also iPad App of the Year 2025; see section 2.
   - (Not Boring) Camera, a camera app.
   - Structured, a productivity planner.
   - Hearing Buddy, an accessibility utility.
   - Harvee, a hardware-adjacent app.

   Source: the Newsroom URL above. Apple's reasons for these finalists: **not found**.

---

## 2. App Store editorial in 2026

**2025 App Store Awards (announced December 4, 2025):**
- iPhone App of the Year: **Tiimo**, a visual planner.
- iPad App of the Year: **Detail**, an AI video editor.
- Mac App of the Year: **Essayist**.
- Vision Pro App of the Year: **Explore POV**.
- Apple Watch App of the Year: **Strava**.
- Apple TV App of the Year: **HBO Max**.

Sources: **[Apple]** https://www.apple.com/sg/newsroom/2025/12/apple-unveils-the-winners-of-the-2025-app-store-awards/ and **[press]** https://www.macrumors.com/2025/12/04/apple-announces-2025-app-store-award-winners/. I did not fetch Apple's stated reasons for each app; **not found** in this pass. No source tied these awards to Liquid Glass.

**App Store stories:** an ADA 2026 story exists at https://apps.apple.com/story/id1896567319 (surfaced by search, not fetched).

**Apps We Love, App of the Day, and Newsroom spotlights for iOS 27 / Liquid Glass apps: not found.** Searches turned up only press coverage. Examples:
- Pocket Casts 8.13 adopted Liquid Glass on iOS 27. **[press]** https://news.lavx.hu/article/pocket-casts-embraces-liquid-glass-on-ios-27-what-app-developers-can-learn-from-the-migration
- A roundup of iOS 26-era apps updated for Liquid Glass. **[press]** https://bgr.com/1969287/best-ios-26-apps-updated-liquid-glass-design/

I found no Apple editorial list.

---

## 3. WWDC26 / iOS 27 / macOS 27 design changes

### Liquid Glass changes (system level)

- **Look and feel:** apps pick up the refreshed look "without having to change a single line of code". Liquid Glass "automatically responds to the new Liquid Glass slider to adjust its tint". **[Apple]** What's new in SwiftUI, WWDC26 session 269: https://developer.apple.com/videos/play/wwdc2026/269/
- **Interactive glass on the Mac:** custom Liquid Glass elements can now be marked interactive on macOS as well as iOS, so they "respond more fluidly to user's clicks". **[Apple]** session 269, same URL.
- **Inactive appearance on iPad:** iPadOS apps take on a distinct inactive appearance, with icons and text dimmed. You can tune it with the `@Environment(\.appearsActive)` environment value. **[Apple]** session 269.
- **Apple's macOS 27 wording**, as quoted by press: "Updates to Liquid Glass ensure exceptional readability with more uniform refraction and improved contrast". A slider runs "from ultra-clear to fully tinted". The release also mentions uniform toolbars, edge-to-edge sidebars with colourful icons, larger window corner radii, and fewer menu-item icons. **[press, quoting Apple]**
  - https://macrumors.com/2026/06/08/apple-announces-macos-golden-gate
  - https://9to5mac.com/2026/06/09/macos-27-golden-gate-includes-these-changes-that-tahoe-critics-will-appreciate/

  I did not fetch the Apple Newsroom press release itself (**not found** in this pass).
- **Is Liquid Glass adoption now mandatory?** Some posts say Xcode 27 removes the opt-out. The claim is disputed, and I found **no Apple source** for it. **[press]** https://appleinsider.com/articles/26/03/26/stop-holding-out-hope-liquid-glass-will-be-mandatory-in-ios-27

### HIG changes (WWDC26, June 8, 2026)

**[Apple]** Source for all of these: https://developer.apple.com/design/whats-new/

- Design principles: "Reintroduced design principles". The matching session is "Principles of great design": https://developer.apple.com/videos/play/wwdc2026/250/
- Scroll views: "Updated guidance for scroll edge effects".
- Search fields: "refined guidance for search as a tab in iOS". Tab bars: "Updated terminology and art". The matching session is "Design intuitive search experiences": https://developer.apple.com/videos/play/wwdc2026/292/
- Sidebars: updated guidance on sidebar icon colours and the adaptable sidebar style. Menus: updated guidance on menu item icons.
- App icons: "Refined guidance for Liquid Glass". Icon Composer 2 beta builds layered Liquid Glass icons for iPhone, iPad, Mac and Watch from one design. SF Symbols 8 beta also shipped.
- Generative AI: new guidance on letting people refine results and give feedback during generation, and on choosing a model type. This applies directly to Counterpart's "describe it, AI designs it" flow.
- Siri was "Revised for Siri AI". Snippets got a new page. App Shortcuts got guidance on adopting app schemas.
- **Later in 2026:**
  - Sep 9: "Designing for iPhone Duo", the folding iPhone.
  - Oct 13: a Live Activities update that "added limited width layouts", plus a Widgets update for "Apple HomeView".
  - Oct 28: macOS guidance for "gestures and touch input in macOS" and "revealing hidden controls with touch on Mac".

### SwiftUI APIs new in June 2026 (iOS 27 / macOS 27)

**[Apple]** Source for this list: https://developer.apple.com/documentation/updates/swiftui

- **Toolbars:**
  - `visibilityPriority(_:)` keeps key actions visible as space shrinks.
  - The `ToolbarOverflowMenu` container sends secondary actions straight to the overflow menu.
  - The `.topBarPinnedTrailing` placement stays put even when other items move to overflow.
  - `toolbarMinimizationBehavior(_:for:)` controls minimise-on-scroll. Session 269 spells it `.toolbarMinimizeBehavior(.onScrollDown, for: .navigationBar)`. The two spellings differ, so verify against the SDK.
- **Tab bars:** `Tab(role: .prominent)` places a tab in "a separate, trailing position of the tab bar". Session 269's example is a cart tab at the bottom trailing edge.
- **Sheets:** a `crossFade` transition makes a sheet "fade in over content".
- **Containers:**
  - `reorderable()` and `reorderContainer(for:isEnabled:move:)` add drag-to-reorder in lists, stacks and grids.
  - `swipeActions(...)` with `swipeActionsContainer()` adds swipe actions outside `List`.
- **Alerts:** new item- and error-bound overloads `alert(_:item:actions:)`, `alert(error:actions:)` and `confirmationDialog(_:item:...)`.
- **Documents:** URL-based `ReadableDocument`, `WritableDocument`, `DocumentReader`/`DocumentWriter`, and `URLDocumentConfiguration`. These are built for large files, which fits USDZ and 3MF meshes.
- **Images:** `AsyncImage` gains caching through `asyncImageURLSession(_:)`.
- **Gestures:** `GestureInputKinds` filters input to direct or indirect touch, pencil, or pointer.
- **General:**
  - Under Xcode 27, `@State` becomes a macro that initialises class values only once.
  - `ContentBuilder` unifies `ToolbarContentBuilder`, `CommandsBuilder` and the other result builders.
- **September 2026, for iPhone Duo:**
  - `ArrangementView` provides adaptive primary/secondary layouts in split and overlay styles.
  - `ReservedRegion` marks areas taken by the camera or hinge.
  - `onHingeChange` reports hinge state.
  - `CameraCaptureAccessory` shows content on the outer display while a camera capture session is running. This could matter for a capture app.
  - Toolbars can sit on a vertical axis (`toolbarVerticalEdge`, `axisBehavior(_:)`).
- **Carried over from iOS 26 and still the current API:**
  - Liquid Glass: `glassEffect(_:in:)` and the `.glass` button style.
  - Toolbars: `ToolbarSpacer`.
  - Scroll edges: `scrollEdgeEffectStyle(_:for:)` and `backgroundExtensionEffect()`.
  - Tab bars: `tabBarMinimizeBehavior(_:)`, `Tab(role: .search)` (the search field takes the tab bar's place), and `TabViewBottomAccessoryPlacement`.
  - Other: `Slider` tick marks and `windowResizeAnchor(_:)`.

  Same URL, June 2025 section. `GlassEffectContainer` and `glassProminent` are not named in the June 2025 changelog text I extracted. Their absence there does not mean they are gone.
- **Not covered by Apple sources I fetched:** iOS 27 changes to the bottom accessory, scroll edge effects or sheets (beyond `crossFade`). Session 269 does not cover them. **not found**

### macOS 27: menu bar, menus, windows, AppKit

- **Menu icons:** iPad and Mac menu bars now show "a minimal set of icons by default, reserving them for key actions". To keep an icon, apply `.labelStyle(.titleAndIcon)` to it. **[Apple]** session 269.
- **Resizable iPhone apps:** iOS 27 makes iPhone apps resizable, which also affects iPhone Mirroring. Xcode 27 previews include resize handles. **[Apple]** session 269.
- **AppKit, June 2026:**
  - Touch input: gesture recognizers can receive touch from a Sidecar-connected iPad. `NSRefreshController` adds pull-to-refresh and touch scrolling. The new `NSIsTouchNative` Info.plist key configures touch.
  - Controls: `NSControl` gains an `Events` type, similar to `UIControl` events.

  **[Apple]** https://developer.apple.com/documentation/updates/appkit
- **AppKit, 2025 and still current:** `NSGlassEffectView`, `NSGlassEffectContainerView`, `NSButton.BezelStyle.glass`, `NSBackgroundExtensionView`, `NSSplitViewItemAccessoryViewController`, and prominent tinted toolbar items. **[Apple]** same URL.
- **MenuBarExtra changes in macOS 27: not found.** Neither the SwiftUI changelog nor session 269 mentions any.

---

## 4. Notifications and Live Activities in iOS 27 / macOS 27

### ActivityKit

- **Mac and CarPlay (June 2025, the 26 releases):** "Live Activities automatically appear on the Mac in the Menu bar and in CarPlay". Live Activities can also be scheduled with `request(attributes:content:pushType:style:alertConfiguration:start:)`. **[Apple]** https://developer.apple.com/documentation/updates/activitykit
- **June 2024:** Live Activities in the watchOS Smart Stack, plus broadcast push through channels. **[Apple]** same URL.
- **June 2026:** the ActivityKit changelog has **no June 2026 entry**. **[Apple]** same URL.
- **"Live Activities essentials" (WWDC26 session 223)** lists the surfaces as the Lock Screen, Dynamic Island, StandBy, the Apple Watch Smart Stack, "the macOS menu bar", and "the CarPlay Dashboard". Live Activities are "automatically forwarded from iPhone to CarPlay". **[Apple]** https://developer.apple.com/videos/play/wwdc2026/223/
- **What the session says is new in iOS 27:** "Live Activities are visible in the Dynamic Island, when in portrait and landscape". Use the `isDynamicIslandLimitedInWidth` environment value to swap in a compact trailing icon. The HIG added "limited width layouts" on Oct 13, 2026: https://developer.apple.com/design/whats-new/
- **Other APIs in the session:**
  - `supplementalActivityFamilies([.small])` and `activityFamily` for the Watch and CarPlay layouts.
  - `showsWidgetContainerBackground` for StandBy.
  - `LiveActivityIntent` buttons.
  - Scheduled start, push-to-start ("start it from a push notification"), broadcast push for "hundreds, thousands or more" people, and per-activity token push.

  The session does not say which of these are new in 27. **[Apple]** session 223.
- **A native macOS 27 ActivityKit API (a Mac app starting its own Live Activity): not found.** Apple's wording describes iPhone activities appearing on the Mac.

### UserNotifications

- The changelog's last entry is June 2024 (offline queue store and `apns-collapse-id`). There is **no 2025 or 2026 entry**. **[Apple]** https://developer.apple.com/documentation/updates/usernotifications

### Can a consumer Mac app push to the same user's iPhone without a developer server?

**Yes, through CloudKit subscriptions. Raw APNs from the app would need a provider server.**

- Database and query subscriptions push to "the user's devices" when CloudKit saves a record. "When appropriate, the server excludes the device where the change originates." A subscription "applies only to the user that creates it". Apple also says "You don't need to explicitly enable push notifications for your App ID ... Xcode automatically adds the entitlement when you enable the CloudKit capability". **[Apple]**
  - https://developer.apple.com/documentation/cloudkit/ckdatabasesubscription
  - https://developer.apple.com/documentation/cloudkit/ckquerysubscription
- **Database subscriptions** work only in the private and shared databases. They cover custom zones only; the default zone of the private database "doesn't participate". **Query subscriptions** work in the public and private databases, not the shared one. **[Apple]** same URLs.
- **Getting a visible alert:** `CKSubscription.NotificationInfo` lets you "provide content that the system displays to the user, describe the sounds to play, and indicate whether the app's icon has a badge". "If you don't set any of the alertBody, soundName, or shouldBadge properties, CloudKit sends the push notification using a lower priority and doesn't display any content to the user." The available properties are:
  - Alert text: `title`, `subtitle`, `alertBody`, and the localisation keys and arguments.
  - Record data: `desiredKeys`.
  - Grouping: `category` and `collapseIDKey`.
  - Delivery flags: `shouldSendContentAvailable` and `shouldSendMutableContent`.

  **[Apple]** https://developer.apple.com/documentation/cloudkit/cksubscription/notificationinfo-swift.class
- **Caveat:** "Because the system coalesces notifications, don't rely on them for specific changes. CloudKit can omit data to keep the payload size under the APNs size limit." **[Apple]** CKDatabaseSubscription URL.
- **Preconditions** (inferred from the docs above, not tested):
  - The Mac and iOS apps use the same CloudKit container.
  - The user is signed into the same iCloud account on both. A subscription "applies only to the user that creates it".
  - The iPhone app has notification authorization from the user. The CloudKit entitlement is added automatically, but that is not the user's permission, and without it `alertBody` won't display.
- **Recommended pattern:** the iPhone saves a `CKQuerySubscription` for a `PrintJobEvent` record type in the private database, with `alertBody` or `title` set (localisation arguments can carry record fields). The Mac writes that record when a print starts, fails or finishes. The iPhone then shows the alert, and the Mac is excluded as the originating device. This is my inference from the docs above. I did not test it, and Apple gives no example of this exact pattern.
- **Can a .p8 key ship inside the app?** Apple's wording: "Secure both pieces of information carefully. You use the authentication token signing key to encrypt your JSON tokens, so this key must remain private to prevent anyone else from generating those tokens." Apple also says "If you suspect that you may have a compromised authentication token signing key, revoke it". A team-scoped key can send "notifications to any topic in a team". **[Apple]** https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
  - Apple's model assumes "Your company's server, known as the provider server". **[Apple]** https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server
  - Shipping the .p8 in a distributed binary would make it non-private, which contradicts that wording. I found no explicit sentence saying "never embed it in an app" (**not found**). The "must remain private" sentence is Apple's controlling wording.
- **Broadcast push and push-to-start** both need a provider sending to APNs. Without a server, that leaves CloudKit alerts, or a Live Activity the iPhone app starts locally and updates while it gets background time. This is inferred from sessions 223 and the docs above.

---

## 5. Bambu Handy / MakerWorld print flow

- **App Store description:** "Remotely control your Bambu Lab 3D printers". It offers MakerWorld model access, remote start and stop, "real-time printing status and resolve errors promptly", "High-resolution live view of the printing process", and "Automatic timelapse video". **[Bambu, App Store]** https://apps.apple.com/us/app/bambu-handy/id1625671285
- **Flow as described in the official wiki first-print guides** (search snippet; the pages returned HTTP 402 when fetched):
  1. Select the model.
  2. Tap **"Prepare to Print"**.
  3. Choose print settings. The A2L guide adds a **print profile** step.
  4. Confirm print info.
  5. Tap **"Start Printing"**.

  **[Bambu wiki, via search]**
  - https://wiki.bambulab.com/en/p2s/manual/first-print
  - https://wiki.bambulab.com/en/x2d/manual/first-print
  - https://wiki.bambulab.com/en/a2l/manual/first-print
- **Screens and features named in App Store release notes:**
  - Printer selection on the "Prepare to Print" page (3.27.0, Aug 15).
  - Printer preselection on the "Device" page (3.14.0).
  - "Select a Print Profile" page (3.25.0).
  - "Next Plate" (3.14.0).
  - Quick-edit for unknown filaments on Prepare to Print, and a print-queue task-limit prompt (4.0.2–4.0.4, Sep 11–15).
  - Filament Track Switch on X2D, which maps nozzles to AMS units (3.20.0).
  - Automatic AMS enrollment in Filament Management (3.16.1).
  - Mixed AMS plus external-spool multicolour printing on A2L (3.22.0).
  - Free choice of nozzle and filament on multi-nozzle printers (3.13.0).
  - Live-view fixes (3.27.0).
  - An in-app print-status notification type (3.16.0).

  **[App Store]** same URL.
- **AMS mapping logic:** the system automatically maps the "sliced preset filament" to the "actually loaded filament in AMS", matching type and colour, and puts process safety ahead of visual match. That is Bambu's documented principle for Studio. **[Bambu wiki, via search]**
  - https://wiki.bambulab.com/en/software/bambu-studio/filament-mapping-principle
  - https://wiki.bambulab.com/en/software/bambu-studio/use-ams-on-bambu-studio
- **Whether Handy exposes manual slot remapping: not found** in an official source.
- **Cloud caching:** jobs sent through the cloud from Handy or Studio are cached on the printer. **[Bambu wiki, via search]** https://wiki.bambulab.com/en/knowledge-sharing/how-to-use-internal-model-cache-space
- **Live Activities or widgets in Handy:** the App Store page mentions neither (**not found**).

---

## Design moves to steal

1. **Win on what Moonlitt won on.** Apple cited easy onboarding, broad platform support, and best-in-class Liquid Glass integration (ADA 2026, Moonlitt). My recommendation on top: ship on iPhone, iPad and Mac, and keep glass on the control layer, not on the model itself.
2. **Make the object the hero, as Tide Guide does with its charts.** Put the scan or mesh preview full bleed, with custom animation (for example, a turntable reveal when cleanup finishes). Glass toolbars float over it, and the tint comes from the object's own captured colour. (ADA 2026, Tide Guide)
3. **Guide the scan by voice and haptics.** Speak coaching such as "move closer" or "circle left", and support Dynamic Type, Increased Contrast and Differentiate Without Color, so status is never shown by colour alone. (ADA 2026, Guitar Wiz)
4. **Use a `Tab(role: .prominent)` "New" tab** for scan or describe, sitting apart at the trailing edge. Use a `Tab(role: .search)` for the library. (SwiftUI June 2026; HIG "search as a tab")
5. **Set toolbar priorities.** Give Undo, Redo and Send to printer `visibilityPriority(.high)`. Put Export, Share and Delete in a `ToolbarOverflowMenu`. Pin Share or Print with `.topBarPinnedTrailing`. Minimise the nav bar on scroll down.
6. **Let the glass adapt for free.** Don't hard-code blur or opacity on custom glass, so it follows the user's clear-to-tinted slider. Mark custom glass `interactive` on macOS too, and dim inactive iPad windows using `appearsActive`.
7. **Treat the mesh as a document.** Use `ReadableDocument`/`WritableDocument` (URL-based, built for large files) and `fileExporter`, so USDZ and 3MF files open and export natively.
8. **Build a Live Activity for the print job, within the no-server limits.**
   - **Start:** the iPhone app starts it with `Activity.request` while in the foreground, or schedules the start.
   - **Updates:** only when the iPhone app gets background time, for example when a CloudKit subscription with `shouldSendContentAvailable` wakes it. Apple says those pushes are coalesced, so don't promise layer-by-layer progress. Use a `staleDate` and show that status is approximate.
   - **Push-to-start and broadcast push:** both need a provider server, so they are out unless we add one.
   - **Layouts:** a small family for Watch and CarPlay, and a limited-width trailing icon for the landscape Dynamic Island in iOS 27.
   - **Mac menu bar:** the activity shown there is the iPhone's, forwarded by the system. I found no Mac-native Live Activity API.
   - **Buttons:** add `LiveActivityIntent` buttons, for example Open camera.
9. **Notify without a server through CloudKit.** The iPhone subscribes to a private-database `CKQuerySubscription` with `alertBody` and `title`. The Mac writes a `PrintEvent` record, and the iPhone gets a visible alert. Never ship an APNs .p8 key (Apple: "must remain private").
10. **Follow the Mac menu rules.** Show icons only on key menu items (`.labelStyle(.titleAndIcon)`). Use edge-to-edge sidebars with colourful icons, and plan for larger window corner radii.
11. **Follow the GenAI guidance in "describe it".** Let people refine results, give feedback during generation, and see progress while the Mac designs the model. (HIG Generative AI, June 2026)
12. **Mirror Handy's printing vocabulary.** Users know Bambu's flow: Prepare to Print, then printer pick, then plate and profile, then filament-to-AMS mapping with automatic type and colour matching that the user can override, then Start Printing, then live camera, progress and timelapse. Keep that order and those words, but answer the printer's questions in fewer steps.
13. **Plan for iPhone Duo.** Use `ArrangementView` for a split layout of scan and model, and `ReservedRegion` to avoid the hinge and camera. `CameraCaptureAccessory` can put content on the outer display during capture. Verify which way that display faces while scanning: it may face the subject rather than the operator, which would suit a "hold still" cue for a person being scanned, not operator guidance.
14. **Use the new list interactions.** Add swipe actions (Reprint, Delete) and drag-to-reorder for the print queue (`swipeActionsContainer`, `reorderContainer`).
15. **Ship App Shortcuts with app schemas** ("Print my last scan", "Scan an object"). Siri AI and app-schema guidance are a WWDC26 focus. (HIG June 2026; sessions 240 and 345)
