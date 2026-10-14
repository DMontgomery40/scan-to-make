# Apple platform readiness

The app uses a single scene-owned React Native window. Window resizing updates layout without restarting the React root. iPhone portrait and both landscape orientations are supported. The screen shell applies all four safe-area insets independently, including when no footer is present. A size change does not save or discard a draft. In iOS windows shorter than 500 points, the actions scroll with the form so the software keyboard cannot leave a fixed footer occupying the entire remaining viewport.

The capture preview continues to use its existing session. Resizing is not a new capture request: explicit Start remains required, and leaving the foreground or removing the preview stops the run. A stopped/interrupted run must be started again explicitly. No captured image or physical-fit result is implied by a layout check.

## Verification matrix

| Check | Required evidence |
| --- | --- |
| SDK build | Record Xcode/build version, SDK and source commit separately from runtime version. |
| Launch and rotation | Launch the bundled Release app, enter a draft, rotate both ways, return to portrait, and confirm text/navigation remain intact. |
| Safe areas | Exercise unequal leading/trailing insets, then swap sides; inspect scroll content and footer controls. |
| Persistence | Save synthetic values, terminate/relaunch, and reopen the same stored values. |
| Capture lifecycle | Confirm a resize does not start capture and background/removal still stops it; real camera qualification needs a real device. |
| iPhone Duo | Run on the appropriate Duo Simulator and test inner/outer displays and split layouts; ordinary iPhone rotation is not this proof. |

Verified with Xcode 27.0 (27A266a), the iOS 27.0 SDK and the iPhone 18 Pro / iOS 27.0 Simulator: bundled Release launch, unsaved draft retention through both landscape orientations and return to portrait, scrolling to the lower fields, and save/terminate/relaunch/reopen of the same synthetic text. The automated suite passes 87 tests, including asymmetric-inset updates with and without a footer and draft preservation across short/tall window transitions. A native landscape keyboard check confirmed that lower form fields and actions remain reachable by scrolling, and edited text remains visible above the software keyboard. The same Release source also launched on iOS 26.0. Apple's Duo guidance distinguishes the 27.0 resizing behavior from the fuller 27.1 experience, which includes vertical system bars and reserved regions. These changes establish the scene and safe-area foundation; they do not claim complete Duo qualification.

## Native action controls

Shared primary/secondary actions and Back use UIKit `UIButton` controls on iOS. On iOS 26 and later, these use `prominentGlass()` and `glass()` configurations; earlier supported systems use native filled/tinted configurations. Android retains its existing controls. UIKit owns the material, enabled state, accessibility label/hint and primary-action event. The React Native wrapper also rejects disabled events. Native text measurement sends the required height back to the layout when the title, width or preferred content size changes.

The iPhone 18 Pro / iOS 27.0 Release check verified primary, secondary and Back navigation, an incomplete brief remaining disabled with its accessibility hint, reopening a saved draft, and reachable Save/Review actions at the largest accessibility text size in landscape. A long disabled action label wrapped across three lines in portrait. Reduce Transparency made secondary controls opaque; primary and Back navigation remained functional with Reduce Motion and Reduce Transparency enabled. Settings were restored afterward. These observations cover controls and navigation, not an instrumented animation audit or a full VoiceOver workflow. The older-iOS fallback is compile-checked but has not been run on a pre-26 runtime.

Follow-on work: qualify the older-system fallback on a pre-26 runtime, inspect the rest of the navigation/chrome, and qualify with Xcode 27.1/Duo. Brand and icon design is separate.

Control references: [glass configuration](https://developer.apple.com/documentation/uikit/uibutton/configuration-swift.struct/glass()), [prominent glass configuration](https://developer.apple.com/documentation/uikit/uibutton/configuration-swift.struct/prominentglass()).

References: [Prepare for iPhone Duo](https://developer.apple.com/iphone-duo/prepare/), [Duo layout guidance](https://developer.apple.com/videos/play/tech-talks/111461/), and [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass).
