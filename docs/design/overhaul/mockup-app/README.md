# Mockup app

This is a throwaway SwiftUI target that renders the overhaul mockups. It holds static data only. The product apps port these views and must match them.

The `assets/` folder isn't committed (`.gitignore` here keeps it out). It contains personal captures:
- `mic.stl`, the mic-mount model;
- `scanA.usdz` and `scanB.usdz`, Object Capture scans;
- `photo1.jpg` to `photo4.jpg`;
- `bed.jpg`, a printer camera frame;
- `thumb-mic.png` and `thumb-potato.png`, crops of the renders.

`Shared/` holds the data and the RealityKit stage. The repo's root `.gitignore` has `shared/`, which matches `Shared/` on a case-insensitive disk, so this folder's `.gitignore` re-includes it.

## Build

Put the asset files in `assets/`, then:

```sh
xcodegen generate
xcodebuild -project CounterpartMock.xcodeproj -scheme MockPhone -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build/phone build
xcodebuild -project CounterpartMock.xcodeproj -scheme MockMac -destination 'platform=macOS' -derivedDataPath build/mac build
```

## iPhone, iPad and Duo

```sh
xcrun simctl install <sim> build/phone/Build/Products/Debug-iphonesimulator/Counterpart.app
xcrun simctl launch <sim> com.dtmont.counterpartmock.phone -screen <name>
xcrun simctl io <sim> screenshot shot.png          # iPhone Duo closed: add --display=1
```

| `-screen` | Screen | PRD |
|---|---|---|
| `home`, `empty` | Home; Home with no projects | §5.1 |
| `new` | New sheet | §5.2 |
| `working`, `ask`, `ready`, `inputs`, `failed` | Project states | §5.4 |
| `print`, `print-one`, `print-noams`, `print-loaded` | Print sheet: multi-colour, one colour, no AMS, What's loaded? | §5.5 |
| `confirm`, `confirm-mac` | The printer MCP's confirmation; Answer on your Mac | §5.5 |
| `plate` | Plate check | §5.6 |
| `printing` | Printing | §5.7 |
| `printers`, `printer`, `printer-update` | Printers; printer detail; a printer whose MCP needs an update | §5.8, §8.2 |
| `settings`, `notifications`, `about` | Settings; Settings → Notifications; About | §5.9 |
| `welcome`, `pair`, `notify` | First run: Welcome, Find your Mac, the notifications permission | §5.10 |
| `hand`, `rig` | Scan in hand; on a scan rig | §11 |
| `split` | iPad and Duo unfolded | §6 |
| `lock`, `notifs` | Lock Screen with the Live Activity; the notification stack | §5.7, §9.1 |
| `widgets`, `widgets-lock` | Home Screen and Lock Screen widgets | §9.5 |
| `island` | Dynamic Island: expanded, compact, minimal, limited width | §9.4 |

## Mac

```sh
"build/mac/Build/Products/Debug/Counterpart Mock.app/Contents/MacOS/Counterpart Mock" -screen <name> -capture shot.png
```

`-capture` saves the app's own window through ScreenCaptureKit and quits (`Mac/Capture.swift`). It needs no Screen Recording permission, and it captures what the window server draws, so the glass and the RealityKit model are real. Leave `-capture` off to just open the screen. A sheet comes out wrong this way (its window captures a copy of its parent), so `mac-print.jpg` is still the earlier capture.

| `-screen` | Screen | PRD |
|---|---|---|
| `main` | Main window, inspector on Request | §7.2 |
| `inspector-activity`, `inspector-print` | Inspector on Activity; on Print | §7.2 |
| `new` | New Project drop target | §7.2 |
| `print` | Print sheet | §7.3 |
| `popover` | Menu bar popover | §7.4 |
| `settings-general`, `devices`, `settings-printers`, `settings-ai`, `settings-ai-nofusion`, `settings-advanced` | Settings tabs, in a real `Settings` scene | §7.5, §8.9 |
