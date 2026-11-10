import Foundation

/// Local diagnostic boundaries only. No URLs, credentials, user text or file contents.
/// Two half-size segments together occupy at most 512 KiB in Library/Caches.
public final class MediaTrace: @unchecked Sendable {
    public struct Context: Sendable {
        public let project: String, version: String, generation: String
        public let scene: String?
        public init(project: String, version: String, generation: String = UUID().uuidString, scene: String? = nil) {
            self.project = project; self.version = version; self.generation = generation; self.scene = scene
        }
        public init(file: URL, scene: String? = nil) {
            let parts = file.pathComponents
            let index = parts.lastIndex(of: "Objects")
            self.init(project: index.flatMap { parts.indices.contains($0 + 1) ? parts[$0 + 1] : nil } ?? "local",
                      version: index.flatMap { parts.indices.contains($0 + 2) ? parts[$0 + 2] : nil } ?? "local", scene: scene)
        }
    }
    @TaskLocal public static var context: Context?
    @TaskLocal public static var destination: MediaTrace?
    public static let shared = MediaTrace(url: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("media-trace.ndjson"))
    public let url: URL
    private let lock = NSLock()
    private let segmentLimit: Int
    public init(url: URL, maximumBytes: Int = 512 * 1024) { self.url = url; segmentLimit = max(512, maximumBytes / 2) }

    public static func record(_ event: String, _ fields: [String: String] = [:], context: Context? = MediaTrace.context) {
        (destination ?? shared).record(event, fields, context: context)
    }
    public func record(_ event: String, _ fields: [String: String] = [:], context: Context?) {
        var row = fields.mapValues { String($0.prefix(256)) }
        row["event"] = event; row["time"] = String(Date().timeIntervalSince1970)
        row["scene"] = row["scene"] ?? context?.scene
        row["project"] = context?.project; row["version"] = context?.version; row["generation"] = context?.generation
        guard var line = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), line.count + 1 <= segmentLimit else { return }
        line.append(10)
        lock.lock(); defer { lock.unlock() }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
            if size + line.count > segmentLimit {
                let previous = url.appendingPathExtension("1")
                try? FileManager.default.removeItem(at: previous)
                try FileManager.default.moveItem(at: url, to: previous)
            }
            if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seekToEnd(); try handle.write(contentsOf: line)
        } catch { /* Diagnostics must never prevent displaying a model. */ }
    }
}
