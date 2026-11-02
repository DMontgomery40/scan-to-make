# Apple platform readiness

The app is a SwiftUI `App` with one `WindowGroup`; iPad supports multiple windows. iPhone apps are resizable in iOS 27, so every screen reflows from compact to regular width rather than assuming a device size. iPhone portrait and both landscape orientations are supported.

Pairing, uploads and scans keep their state in the app model and on disk, not in a view, so resizing a window or moving it between displays never restarts a pairing or discards a draft.

The capture preview keeps its existing session. Resizing is not a new capture request: Start is still required, and leaving the foreground or removing the preview stops the run. A stopped or interrupted run must be started again. No captured image or physical-fit result is implied by a layout check.
