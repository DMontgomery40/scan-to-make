import SwiftUI
import ImageIO
import CounterpartKit

/// Decoded thumbnails, kept for the session so scrolling never decodes twice.
@MainActor final class ImageMemory {
    static let shared = ImageMemory()
    private let cache = NSCache<NSString, UIImage>()
    func image(_ key: String) -> UIImage? { cache.object(forKey: key as NSString) }
    func store(_ image: UIImage, _ key: String) { cache.setObject(image, forKey: key as NSString) }

    /// Decode only the pixels a view can show, without expanding a full capture first.
    nonisolated static func thumbnail(at url: URL, maxPixelSize: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
                kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    nonisolated static func thumbnail(data: Data, maxPixelSize: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

extension Project {
    /// The picture that stands for a project: the real thing you showed Counterpart, so a project is
    /// recognisable the same way on every card. A model render is the fallback when there is no real
    /// photo or scan frame (a described or published project); the model itself is on its page.
    var thumbnailPath: String? {
        if let photo = photos.first { return "photos/\(photo)" }
        if let frame = capture?.first { return "capture/\(frame)" }
        if let render = current?.renders.first, let name = render.split(separator: "/").last { return "renders/\(name)" }
        return nil
    }
}

/// One of a project's images, downloaded once per project version and decoded at the size shown.
struct ProjectImage: View {
    @Environment(AppModel.self) private var app
    let project: Project
    let path: String?
    var maxPixelSize = 600
    var contentMode: ContentMode = .fill
    var placeholderSymbol = "cube"
    @State private var image: UIImage?

    private var key: String { "\(project.id)#\(Int64(project.mediaVersion))#\(path ?? "")#\(maxPixelSize)" }

    var body: some View {
        ZStack {
            StageBackground()
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else if path == nil {
                Image(systemName: placeholderSymbol).font(.title2).foregroundStyle(.white.opacity(0.35))
            }
        }
        .clipped()
        .task(id: key) {
            if let cached = ImageMemory.shared.image(key) { image = cached; return }
            image = nil
            guard let path, let url = try? await app.projects.mac.download(project, path) else { return }
            let size = maxPixelSize
            let decoded = await Task.detached { ImageMemory.thumbnail(at: url, maxPixelSize: size) }.value
            guard !Task.isCancelled, let decoded else { return }
            ImageMemory.shared.store(decoded, key)
            image = decoded
        }
        .accessibilityHidden(true)
    }
}

/// The printer camera as a refreshing photo (PRD §5.7, §8.6): a new still every `every` seconds while
/// shown, with when it was taken. Not video, and never called video.
@MainActor @Observable final class CameraFeed {
    var image: UIImage?
    var capturedAt: Date?
    var problem: String?
    var unsupported = false

    func run(_ client: CompanionClient, project: String? = nil, printer: String? = nil, every seconds: Double, maxPixelSize: Int = 1200) async {
        guard project != nil || printer != nil else { return }
        var previous: CompanionClient.CameraFrame?
        let fullScreen = seconds < 10
        var snapshots = false
        unsupported = false
        func display(_ frame: CompanionClient.CameraFrame) async {
            let size = fullScreen ? maxPixelSize : 300
            let decoded = await Task.detached { ImageMemory.thumbnail(data: frame.jpeg, maxPixelSize: size) }.value
            guard !Task.isCancelled else { return }
            if let decoded { image = decoded; capturedAt = frame.capturedAt ?? Date() }
            problem = nil
        }
        while !Task.isCancelled {
            do {
                if snapshots {
                    let frame = project != nil ? try await client.camera(project: project!, fullScreen: fullScreen, previous: previous)
                        : try await client.camera(printer: printer!, fullScreen: fullScreen, previous: previous)
                    if previous == nil || frame.etag == nil || frame.etag != previous?.etag { await display(frame) }
                    previous = frame; problem = nil
                } else {
                    let frames = project != nil ? client.cameraFrames(project: project!, fullScreen: fullScreen)
                        : client.cameraFrames(printer: printer!, fullScreen: fullScreen)
                    for try await frame in frames { await display(frame) }
                }
            } catch let error as CompanionError {
                guard !Task.isCancelled else { return }
                if error.isUnsupported, !snapshots { snapshots = true; continue }
                if error.isUnsupported || error.code == "no-camera" || error.needsPairing {
                    unsupported = error.isUnsupported || error.code == "no-camera"; problem = error.message; return
                }
                problem = error.message
            } catch { return }
            try? await Task.sleep(for: .seconds(fullScreen && previous?.streaming == true ? 2 : seconds))
        }
    }
}
