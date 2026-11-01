# Counterpart 2 overhaul

- [audit.md](audit.md): where the iPhone and Mac apps stand today, with evidence.
- [PRD.md](PRD.md): the requirements for iOS 27.2, iPadOS and macOS 27. They cover the screens, the back end and how it connects to bambu-printer-mcp and mcp-3D-printer-server, notifications and Live Activities, in-hand scanning, and the build plan.
- [research/](research/): Apple's 2026 design awards and iOS 27/macOS 27 changes, and the in-hand capture research. Every claim cites its source.
- [mockup-app/](mockup-app/): the SwiftUI source for the mockups below. It's a throwaway target and not product code.

The mockups are real SwiftUI with real Liquid Glass, rendered on iOS 27.2 simulators and on macOS 27. Two are approximations, because the system draws them itself: the Lock Screen (`phone-lock`) and the camera feed under the in-hand capture HUD (`phone-hand`).

## iPhone

| Home | New | Working | Needs you |
|---|---|---|---|
| ![](screens/phone-home.jpg) | ![](screens/phone-new.jpg) | ![](screens/phone-working.jpg) | ![](screens/phone-ask.jpg) |

| Ready | What you sent | Print | Plate check |
|---|---|---|---|
| ![](screens/phone-ready.jpg) | ![](screens/phone-inputs.jpg) | ![](screens/phone-print.jpg) | ![](screens/phone-plate.jpg) |

| Printing | Lock Screen | Scan in hand | Printers |
|---|---|---|---|
| ![](screens/phone-printing.jpg) | ![](screens/phone-lock.jpg) | ![](screens/phone-hand.jpg) | ![](screens/phone-printers.jpg) |

## iPad and iPhone Duo

![](screens/ipad-split.jpg)

![](screens/duo-closed.jpg)

## Mac

![](screens/mac-main.jpg)

![](screens/mac-print.jpg)

| Menu bar | Settings → Phones |
|---|---|
| ![](screens/mac-popover.jpg) | ![](screens/mac-devices.jpg) |
