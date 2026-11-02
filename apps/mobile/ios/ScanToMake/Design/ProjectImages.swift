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
    /// The picture that stands for a project: its clearest render (the Mac names it first), else the first
    /// photo or scan image you sent.
    var thumbnailPath: String? {
        if let render = current?.renders.first, let name = render.split(separator: "/").last { return "renders/\(name)" }
        if let photo = photos.first { return "photos/\(photo)" }
        if let frame = capture?.first { return "capture/\(frame)" }
        return nil
    }
}

/// One of a project's images, downloaded once per project version and decoded at the size shown.
struct ProjectImage: View {
    @Environment(AppModel.self) private var app
    let project: Project
    let path: String?
    var maxPixelSize = 600
    var placeholderSymbol = "cube"
    @State private var image: UIImage?

    private var key: String { "\(project.id)#\(Int64(project.mediaVersion))#\(path ?? "")#\(maxPixelSize)" }

    var body: some View {
        ZStack {
            StageBackground()
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
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
        while !Task.isCancelled {
            do {
                let frame = project != nil ? try await client.camera(project: project!) : try await client.camera(printer: printer!)
                let size = maxPixelSize
                let decoded = await Task.detached { ImageMemory.thumbnail(data: frame.jpeg, maxPixelSize: size) }.value
                guard !Task.isCancelled else { return }
                if let decoded { image = decoded; capturedAt = frame.capturedAt ?? Date(); problem = nil }
            } catch let error as CompanionError {
                guard !Task.isCancelled else { return }
                if error.isUnsupported || error.code == "no-camera" { unsupported = true; problem = error.message; return }
                problem = error.message
            } catch { return }
            try? await Task.sleep(for: .seconds(seconds))
        }
    }
}
