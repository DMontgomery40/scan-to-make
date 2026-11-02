import SwiftUI
import AppKit
import ImageIO

/// A picture from the project's folder, read off the main thread and keyed on the file's modification
/// time. `version` (the project's `updatedAtMs`) stands in when that can't be read. It is decoded at the size it is
/// shown (ImageIO, orientation applied), never at the camera's: a 12 MP photo is 46.5 MB decoded, 93 MB in HDR, and a
/// 26 pt thumbnail needs a few hundred KB (PRD §9.6).
struct FileImage: View {
    let url: URL
    let version: Double
    var contentMode: ContentMode = .fit
    @Environment(\.displayScale) private var scale
    @State private var image: NSImage?
    /// The longest side to decode, in pixels: the shown size, rounded up to a step so resizing rarely reloads.
    @State private var pixels = 0
    private var key: String { "\(url.path)#\(FileVersion.of(url, else: version))@\(pixels)" }
    var body: some View {
        Group {
            if let image = image ?? FileImages.cached(key) {
                Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: contentMode)
            } else {
                Color.clear
            }
        }
        .onGeometryChange(for: CGFloat.self) { max($0.size.width, $0.size.height) } action: { side in
            // Only ever larger: a fitted image is smaller than its box, and shrinking would reload it.
            let step = FileImages.step(side * scale)
            if step > pixels { pixels = step }
        }
        .task(id: key) {
            guard pixels > 0 else { return }
            if let cached = FileImages.cached(key) { image = cached; return }
            let url = url, key = key, pixels = pixels, scale = scale
            let loaded = await Task.detached(priority: .userInitiated) { FileImages.decode(url, maxPixels: pixels, scale: scale) }.value
            guard !Task.isCancelled else { return }
            if let loaded { FileImages.store(loaded.image, key, bytes: loaded.bytes) }
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

struct SendableImage: @unchecked Sendable { let image: NSImage; let bytes: Int }

@MainActor enum FileImages {
    /// Decoded pictures, limited by their bytes rather than their number.
    private static let cache: NSCache<NSString, NSImage> = {
        let cache = NSCache<NSString, NSImage>()
        cache.totalCostLimit = 96 << 20
        return cache
    }()
    static func cached(_ key: String) -> NSImage? { cache.object(forKey: key as NSString) }
    static func store(_ image: NSImage, _ key: String, bytes: Int) { cache.setObject(image, forKey: key as NSString, cost: bytes) }

    /// The decode size for a side of `pixels`: the next of 128, 256, 512, 1024, 2048, 4096.
    nonisolated static func step(_ pixels: CGFloat) -> Int {
        guard pixels > 0 else { return 0 }
        var step = 128
        while CGFloat(step) < pixels && step < 4096 { step *= 2 }
        return step
    }

    /// The picture at most `maxPixels` on its longest side, 8-bit, upright.
    nonisolated static func decode(_ url: URL, maxPixels: Int, scale: CGFloat) -> SendableImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                        kCGImageSourceThumbnailMaxPixelSize: maxPixels, kCGImageSourceShouldCacheImmediately: true]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let size = NSSize(width: CGFloat(image.width) / max(scale, 1), height: CGFloat(image.height) / max(scale, 1))
        return SendableImage(image: NSImage(cgImage: image, size: size), bytes: image.bytesPerRow * image.height)
    }
}

/// A file's modification time, so a picture or model reloads when its file is rewritten (a new pass reuses
/// the same names) and not when only the project's state changes. `fallback` if it can't be read.
enum FileVersion {
    /// Read at most once a second per file: views ask on every update, and a `stat` each time adds up (PRD §9.6).
    @MainActor private static var read: [String: (at: Date, value: Double?)] = [:]

    static func of(_ url: URL, else fallback: Double) -> Double {
        guard Thread.isMainThread else { return stat(url) ?? fallback }
        return MainActor.assumeIsolated {
            if let cached = read[url.path], Date().timeIntervalSince(cached.at) < 1 { return cached.value ?? fallback }
            let value = stat(url)
            if read.count > 512 { read.removeAll() }
            read[url.path] = (Date(), value)
            return value ?? fallback
        }
    }

    private static func stat(_ url: URL) -> Double? {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date)?.timeIntervalSince1970
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
