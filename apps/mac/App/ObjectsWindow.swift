import SwiftUI
import AppKit
import AgentKit

/// The app's main window: the objects list and pages. One window, reused. While it is open the
/// app has a Dock icon and a menu bar like any Mac app; closing it returns to the menu bar only.
@MainActor final class ObjectsWindow: NSObject, NSWindowDelegate {
    static let shared = ObjectsWindow()
    private var window: NSWindow?
    private lazy var model = ObjectsModel(companion:SocketObjects(path:ModelAccessModel.socketPath(for:Installation(bundle:.main))))
    var isVisible: Bool { window?.isVisible == true }

    static func make(model: ObjectsModel, startWith3D: Bool = false) -> NSWindow {
        let window = NSWindow(contentRect:NSRect(x:0, y:0, width:1020, height:700),
                              styleMask:[.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing:.buffered, defer:false)
        window.title = "Scan to Make"
        // No toolbar: the sidebar runs the full height and the page starts under the traffic lights.
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        let content = NSHostingController(rootView:ObjectsWindowView(model:model, startWith3D:startWith3D))
        content.sizingOptions = [.minSize]
        window.contentViewController = content
        window.setContentSize(NSSize(width:1020, height:700))
        window.contentMinSize = NSSize(width:760, height:520)
        return window
    }

    func show() {
        if window == nil {
            let window = Self.make(model:model)
            window.delegate = self
            window.center()
            window.setFrameAutosaveName("Scan to Make objects")
            self.window = window
        }
        NSApp.setActivationPolicy(.regular)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps:true)
        model.setVisible(true)
        model.wake()
    }

    func windowDidBecomeKey(_ notification: Notification) { model.wake() }
    func windowDidChangeOcclusionState(_ notification: Notification) {
        guard let window else { return }
        model.setVisible(window.isVisible && window.occlusionState.contains(.visible))
    }
    func windowWillClose(_ notification: Notification) {
        model.setVisible(false)
        NSApp.setActivationPolicy(.accessory)
    }
}
