import Foundation
import ImageIO
import UniformTypeIdentifiers

/// What a print's Live Activity shows beside its words (PRD §9.4): the project's own picture, or the
/// Counterpart mark when there is none yet. Never a generic printer.
public enum PrintActivityArtwork: Equatable, Sendable {
    case thumbnail(URL)
    case mark
}

/// Project pictures for the Live Activity, in the App Group container the app, the notification service
/// extension and the widget extension share. The widget can't reach the network, so the app (when it loads
/// projects and starts or updates an activity) and the notification service (when a print notification
/// arrives) write the picture here, keyed by project id. `PrintAttributes` already carries the project id,
/// so the relay's attributes contract doesn't change.
///
/// Apple: Live Activity image assets must be no larger than the presentation, or the activity may fail to
/// start (ActivityKit, "Displaying live data with Live Activities"). Pictures are stored at most
/// `maxPixels` on the long edge: 56 pt at 3x, the largest slot the activity draws them in.
public struct PrintActivityThumbnails: Sendable {
    public static let maxPixels = 168
    public let folder: URL

    public init(folder: URL) { self.folder = folder }

    /// The shared store, or nil when the process has no App Group entitlement.
    public static func shared() -> PrintActivityThumbnails? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: CounterpartIdentifiers.appGroup)
            .map { PrintActivityThumbnails(folder: $0.appendingPathComponent("Library/Caches/PrintActivity", isDirectory: true)) }
    }

    /// Which picture was stored and how new it is. `version` is the project's `updatedAt` (ms) on the Mac's
    /// clock, which both writers know, so an older write never replaces a newer one. `source` names what the
    /// picture came from, so the app downloads again only when it changed.
    public struct Entry: Codable, Equatable, Sendable {
        public var version: Double
        public var source: String
        public init(version: Double, source: String) { self.version = version; self.source = source }
    }

    public func artwork(for projectId: String) -> PrintActivityArtwork {
        let url = imageURL(projectId)
        return FileManager.default.fileExists(atPath: url.path) ? .thumbnail(url) : .mark
    }

    public func entry(for projectId: String) -> Entry? {
        guard let data = try? Data(contentsOf: entryURL(projectId)) else { return nil }
        return try? JSONDecoder().decode(Entry.self, from: data)
    }

    /// Scales the picture at `url` down to `maxPixels` and stores it for `projectId`. Returns false when
    /// it isn't a picture, or when a newer one is already stored.
    @discardableResult
    public func store(imageAt url: URL, projectId: String, version: Double, source: String) -> Bool {
        guard let image = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return false }
        return store(image, projectId: projectId, version: version, source: source)
    }

    @discardableResult
    public func store(imageData: Data, projectId: String, version: Double, source: String) -> Bool {
        guard let image = CGImageSourceCreateWithData(imageData as CFData, nil) else { return false }
        return store(image, projectId: projectId, version: version, source: source)
    }

    public func remove(projectId: String) {
        try? FileManager.default.removeItem(at: imageURL(projectId))
        try? FileManager.default.removeItem(at: entryURL(projectId))
    }

    private func store(_ source: CGImageSource, projectId: String, version: Double, source name: String) -> Bool {
        if let current = entry(for: projectId), current.version > version { return false }
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: Self.maxPixels,
        ] as CFDictionary) else { return false }
        let png = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(png, UTType.png.identifier as CFString, 1, nil) else { return false }
        CGImageDestinationAddImage(destination, thumbnail, nil)
        guard CGImageDestinationFinalize(destination),
              let entry = try? JSONEncoder().encode(Entry(version: version, source: name)) else { return false }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try write(png as Data, to: imageURL(projectId))
            try write(entry, to: entryURL(projectId))
            return true
        } catch { return false }
    }

    /// The Lock Screen draws the activity while the phone is locked, and the notification service runs then
    /// too: never `.complete` protection, or neither could open the file when it matters. (The simulator has
    /// no data protection, so only a device shows the difference.)
    private func write(_ data: Data, to url: URL) throws {
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }

    /// Project ids are UUIDs; anything else is escaped so an id can never name a path outside the folder.
    private func key(_ projectId: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let escaped = projectId.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
        return escaped.isEmpty ? "_" : escaped
    }
    private func imageURL(_ projectId: String) -> URL { folder.appendingPathComponent(key(projectId) + ".png") }
    private func entryURL(_ projectId: String) -> URL { folder.appendingPathComponent(key(projectId) + ".json") }
}
