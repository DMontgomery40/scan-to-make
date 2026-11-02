import AppKit
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// Launch with `-capture <png path>` to save this app's own window and quit.
/// ScreenCaptureKit's `currentProcess` content needs no Screen Recording permission,
/// and it captures what the window server draws: real Liquid Glass and RealityKit.
/// `-captureWindow <title>` picks a window by title; otherwise the largest one is used.
enum WindowCapture {
    @MainActor
    static func runIfRequested() {
        guard let path = UserDefaults.standard.string(forKey: "capture") else { return }
        let delay = UserDefaults.standard.double(forKey: "captureDelay")
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            // Put every titled window fully on the primary display, so a restored frame from
            // another display layout can't leave it clipped, and make it key so controls draw active.
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            for w in NSApp.windows where w.isVisible && w.styleMask.contains(.titled) {
                if let screen = NSScreen.screens.first { w.setFrameOrigin(NSPoint(x: screen.visibleFrame.minX + 40, y: screen.visibleFrame.maxY - w.frame.height - 20)) }
                w.makeKeyAndOrderFront(nil)
            }
            try? await Task.sleep(for: .seconds(delay > 0 ? delay : 5))
            // Activation can be refused while another app is frontmost; keep asking briefly.
            for _ in 0..<10 where !NSApp.isActive {
                NSApp.activate(ignoringOtherApps: true)
                NSRunningApplication.current.activate(options: [.activateAllWindows])
                NSApp.windows.first(where: { $0.isVisible && $0.styleMask.contains(.titled) })?.makeKeyAndOrderFront(nil)
                try? await Task.sleep(for: .seconds(0.5))
            }
            print("active", NSApp.isActive)
            try? await Task.sleep(for: .seconds(0.6))
            do {
                try await capture(to: URL(fileURLWithPath: path))
                exit(0)
            } catch {
                FileHandle.standardError.write("capture failed: \(error)\n".data(using: .utf8)!)
                exit(1)
            }
        }
    }

    @MainActor
    static func capture(to url: URL) async throws {
        let content = try await SCShareableContent.currentProcess
        let windows = content.windows.filter { $0.isOnScreen && $0.frame.width > 120 && $0.windowLayer == 0 }
        for w in windows { print("window", w.windowID, w.title ?? "-", w.frame) }
        let wanted = UserDefaults.standard.string(forKey: "captureWindow")
        let main = windows.first(where: { wanted != nil && $0.title == wanted })
            ?? windows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
        guard let main else { throw CocoaError(.fileNoSuchFile) }
        // A sheet's own window captures a scaled copy of its parent, so sheets aren't supported.
        let out = try await image(of: main)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(dest, out, nil)
        CGImageDestinationFinalize(dest)
    }

    @MainActor
    static func image(of window: SCWindow) async throws -> CGImage {
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let cfg = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        cfg.width = Int(filter.contentRect.width * scale)
        cfg.height = Int(filter.contentRect.height * scale)
        cfg.ignoreShadowsSingleWindow = true
        cfg.showsCursor = false
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    }
}
