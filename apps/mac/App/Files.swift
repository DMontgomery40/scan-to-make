import SwiftUI
import AppKit

/// A picture from the project's folder, read off the main thread and keyed on the file's modification
/// time. `version` (the project's `updatedAtMs`) stands in when that can't be read.
struct FileImage: View {
    let url: URL
    let version: Double
    var contentMode: ContentMode = .fit
    @State private var image: NSImage?
    private var key: String { "\(url.path)#\(FileVersion.of(url, else: version))" }
    var body: some View {
        Group {
            if let image = image ?? FileImages.cached(key) {
                Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: contentMode)
            } else {
                Color.clear
            }
        }
        .task(id: key) {
            if let cached = FileImages.cached(key) { image = cached; return }
            let url = url, key = key
            let loaded = await Task.detached(priority: .userInitiated) { NSImage(contentsOf: url).map(SendableImage.init) }.value
            guard !Task.isCancelled else { return }
            if let loaded { FileImages.store(loaded.image, key) }
            image = loaded?.image
        }
    }
}

/// Fills a fixed box without widening the layout around it.
struct FillImage: View {
    let url: URL
    let version: Double
    var body: some View {
        Color.clear.overlay { FileImage(url: url, version: version, contentMode: .fill) }.clipped()
    }
}

private struct SendableImage: @unchecked Sendable { let image: NSImage }

@MainActor enum FileImages {
    private static let cache: NSCache<NSString, NSImage> = { let cache = NSCache<NSString, NSImage>(); cache.countLimit = 120; return cache }()
    static func cached(_ key: String) -> NSImage? { cache.object(forKey: key as NSString) }
    static func store(_ image: NSImage, _ key: String) { cache.setObject(image, forKey: key as NSString) }
}

/// A file's modification time, so a picture or model reloads when its file is rewritten (a new pass reuses
/// the same names) and not when only the project's state changes. `fallback` if it can't be read.
enum FileVersion {
    static func of(_ url: URL, else fallback: Double) -> Double {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? fallback
    }
}

extension View {
    /// Calls `change` with whether the hosting window is actually visible: on screen, not minimized, not covered
    /// and its app not hidden. SwiftUI keeps a minimized or hidden window's views mounted, so `onAppear` and
    /// `onDisappear` can't say this.
    func onWindowVisibilityChange(_ change: @escaping (Bool) -> Void) -> some View {
        background(WindowVisibilityProbe(change: change))
    }
}

private struct WindowVisibilityProbe: NSViewRepresentable {
    let change: (Bool) -> Void
    func makeNSView(context: Context) -> Probe { Probe(change: change) }
    func updateNSView(_ view: Probe, context: Context) { view.change = change }

    final class Probe: NSView {
        var change: (Bool) -> Void
        private var observers: [NSObjectProtocol] = []
        private var last: Bool?
        init(change: @escaping (Bool) -> Void) { self.change = change; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            guard let window else { report(false); return }
            let names: [Notification.Name] = [NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification,
                                              NSWindow.didDeminiaturizeNotification, NSWindow.willCloseNotification]
            for name in names {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] note in
                    MainActor.assumeIsolated { self?.evaluate(closing: note.name == NSWindow.willCloseNotification) }
                })
            }
            evaluate(closing: false)
        }

        private func evaluate(closing: Bool) {
            guard let window else { report(false); return }
            report(!closing && window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible))
        }

        private func report(_ visible: Bool) {
            guard visible != last else { return }
            last = visible
            change(visible)
        }

        deinit { observers.forEach(NotificationCenter.default.removeObserver) }
    }
}
