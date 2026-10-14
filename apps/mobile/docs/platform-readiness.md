# Apple platform readiness

The app uses a single scene-owned React Native window. Window resizing updates layout without restarting the React root. iPhone portrait and both landscape orientations are supported. The screen shell applies all four safe-area insets independently, including when no footer is present. A size change does not save or discard a draft.

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

Verified with Xcode 27.0 (27A266a), the iOS 27.0 SDK and the iPhone 18 Pro / iOS 27.0 Simulator: bundled Release launch, unsaved draft retention through both landscape orientations and return to portrait, scrolling to the lower fields, and save/terminate/relaunch/reopen of the same synthetic text. The automated suite passes 82 tests, including asymmetric-inset updates with and without a footer. The same Release source also launched on iOS 26.0. Apple's Duo guidance distinguishes the 27.0 resizing behavior from the fuller 27.1 experience, which includes vertical system bars and reserved regions. These changes establish the scene and safe-area foundation; they do not claim complete Duo qualification or native Liquid Glass adoption.

Follow-on work: adopt native system materials/controls for the interaction layer, check accessibility settings and older-system fallbacks, and qualify with Xcode 27.1/Duo. Brand and icon design is separate.

References: [Prepare for iPhone Duo](https://developer.apple.com/iphone-duo/prepare/), [Duo layout guidance](https://developer.apple.com/videos/play/tech-talks/111461/), and [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass).
