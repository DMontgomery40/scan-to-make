# Counterpart 2 overhaul

- [audit.md](audit.md): where the iPhone and Mac apps stand today, with evidence.
- [PRD.md](PRD.md): the requirements for iOS 27.2, iPadOS and macOS 27. They cover the screens, the back end and how it connects to bambu-printer-mcp and mcp-3D-printer-server, notifications and Live Activities, in-hand scanning, and the build plan.
- [research/](research/): Apple's 2026 design awards and iOS 27/macOS 27 changes, and the in-hand capture research. Every claim cites its source.
- [mockup-app/](mockup-app/): the SwiftUI source for the mockups below, with the `-screen` name for each. It's a throwaway target and not product code.

The mockups are real SwiftUI with real Liquid Glass, rendered on iOS 27.2 simulators and on macOS 27. They're the visual contract: the product apps port these views and match them.

Some are approximations, because the system draws them itself or the simulator has no camera:
- the Lock Screen (`phone-lock`, `phone-notifications`, `phone-widgets-lock`) and the Home Screen (`phone-widgets`);
- the Dynamic Island (`phone-island`);
- the camera feed under the in-hand and rig capture HUDs and the QR scanner (`phone-hand`, `phone-rig`, `phone-pair`).

What's inside them (the words, frames, widget and Live Activity layouts) is the contract. `phone-notifications` shows every banner expanded with its actions; on a real Lock Screen the actions appear when you press and hold a notification.

## iPhone

| Home | New | Working | Needs you |
|---|---|---|---|
| ![](screens/phone-home.jpg) | ![](screens/phone-new.jpg) | ![](screens/phone-working.jpg) | ![](screens/phone-ask.jpg) |

| Ready | What you sent | Couldn't finish | Home, no projects yet |
|---|---|---|---|
| ![](screens/phone-ready.jpg) | ![](screens/phone-inputs.jpg) | ![](screens/phone-failed.jpg) | ![](screens/phone-home-empty.jpg) |

| Print (multi-colour) | Print, one colour | Print, no AMS | Print, What's loaded? |
|---|---|---|---|
| ![](screens/phone-print.jpg) | ![](screens/phone-print-one.jpg) | ![](screens/phone-print-noams.jpg) | ![](screens/phone-print-loaded.jpg) |

| The printer MCP's confirmation | Answer on your Mac | Plate check | Printing |
|---|---|---|---|
| ![](screens/phone-confirm.jpg) | ![](screens/phone-confirm-mac.jpg) | ![](screens/phone-plate.jpg) | ![](screens/phone-printing.jpg) |

| Printers | Printer detail | Printer, MCP update needed | Scan in hand |
|---|---|---|---|
| ![](screens/phone-printers.jpg) | ![](screens/phone-printer.jpg) | ![](screens/phone-printer-update.jpg) | ![](screens/phone-hand.jpg) |

| On a scan rig | Settings | Settings → Notifications | About |
|---|---|---|---|
| ![](screens/phone-rig.jpg) | ![](screens/phone-settings.jpg) | ![](screens/phone-settings-notifications.jpg) | ![](screens/phone-about.jpg) |

The scan rig is ["Fully 3D-printed 360° photography turntable" by Kass 3D](https://makerworld.com/en/models/1531561) on MakerWorld. Counterpart links to it and doesn't redistribute it; see PRD §15.

### First run

| Welcome | Find your Mac | Notifications |
|---|---|---|
| ![](screens/phone-welcome.jpg) | ![](screens/phone-pair.jpg) | ![](screens/phone-notify.jpg) |

### Lock Screen, widgets and the Dynamic Island (approximations)

| Live Activity | Notifications | Widgets | Lock Screen widgets | Dynamic Island |
|---|---|---|---|---|
| ![](screens/phone-lock.jpg) | ![](screens/phone-notifications.jpg) | ![](screens/phone-widgets.jpg) | ![](screens/phone-widgets-lock.jpg) | ![](screens/phone-island.jpg) |

## iPad and iPhone Duo

![](screens/ipad-split.jpg)

| iPhone Duo closed | Duo closed, no projects yet | iPad, Welcome |
|---|---|---|
| ![](screens/duo-closed.jpg) | ![](screens/duo-home-empty.jpg) | ![](screens/ipad-welcome.jpg) |

## Mac

The Mac screens are captured from the app's own window through ScreenCaptureKit, so the glass and the model are real.

![](screens/mac-main.jpg)

| Inspector → Activity | Inspector → Print |
|---|---|
| ![](screens/mac-inspector-activity.jpg) | ![](screens/mac-inspector-print.jpg) |

![](screens/mac-new.jpg)

![](screens/mac-print.jpg)

| Menu bar | Settings → General | Settings → Phones and iPads |
|---|---|---|
| ![](screens/mac-popover.jpg) | ![](screens/mac-settings-general.jpg) | ![](screens/mac-devices.jpg) |

| Settings → Printers | Settings → AI | Settings → AI, no Fusion | Settings → Advanced |
|---|---|---|---|
| ![](screens/mac-settings-printers.jpg) | ![](screens/mac-settings-ai.jpg) | ![](screens/mac-settings-ai-nofusion.jpg) | ![](screens/mac-settings-advanced.jpg) |
