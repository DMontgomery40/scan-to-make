# Mockup app

This is a throwaway SwiftUI target that renders the overhaul mockups. It holds static data only.

The `assets/` folder isn't committed. It contains personal captures:
- `mic.stl`, the mic-mount model;
- `scanA.usdz` and `scanB.usdz`, Object Capture scans;
- `photo1.jpg` to `photo4.jpg`;
- `bed.jpg`, a printer camera frame;
- `thumb-mic.png` and `thumb-potato.png`, crops of the renders.

To rebuild, put those files in `assets/`, then:

```sh
xcodegen generate
xcodebuild -project CounterpartMock.xcodeproj -scheme MockPhone -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build/phone build
xcrun simctl install <sim> build/phone/Build/Products/Debug-iphonesimulator/Counterpart.app
xcrun simctl launch <sim> com.dtmont.counterpartmock.phone -screen home   # also: new, working, ask, ready, inputs, print, plate, printing, lock, hand, rig, printers, split
```

For the Mac app, build `-scheme MockMac`, then `open "build/mac/Build/Products/Debug/Counterpart Mock.app" --args -screen main` (or `print`, `popover`, `devices`).
