import Foundation

/// One file to send to a project: the walk-around scan, a photo you added, or an in-hand capture frame and
/// its depth.
public struct UploadFile: Equatable, Sendable {
    public enum Kind: String, Sendable { case scan, photo, capture, depth }
    public enum Source: Equatable, Sendable { case file(URL), bytes(Data) }
    public var kind: Kind
    /// The file name on the Mac (ignored for the scan, which is always `scan.usdz`).
    public var name: String
    public var source: Source
    public var type: String

    public init(kind: Kind, name: String, source: Source, type: String) {
        self.kind = kind; self.name = name; self.source = source; self.type = type
    }

    public static func image(_ url: URL, name: String? = nil, kind: Kind = .photo) -> UploadFile {
        let ext = url.pathExtension.lowercased()
        let type = ext == "heic" ? "image/heic" : ext == "png" ? "image/png" : "image/jpeg"
        return UploadFile(kind: kind, name: name ?? url.lastPathComponent, source: .file(url), type: type)
    }
}

/// Sends files to a project, skipping what the Mac already has, so a send cut short can simply run again.
/// One send per project at a time.
public actor ProjectUploader {
    private let client: CompanionClient
    private var sending: Set<String> = []

    public init(client: CompanionClient) { self.client = client }

    public func isSending(_ projectId: String) -> Bool { sending.contains(projectId) }

    /// Sends whatever of `files` the Mac doesn't have yet, one after another, stopping at the first failure.
    /// Returns how many photos or frames were sent (the scan isn't counted). `progress` gets the share of `files`
    /// on the Mac, 0…1: what it already had first, then after each file, so a resumed send starts where it stopped.
    @discardableResult
    public func send(_ files: [UploadFile], to projectId: String, forMessage: Bool = false,
                     progress: (@Sendable (Double) -> Void)? = nil) async throws -> Int {
        guard !sending.contains(projectId) else { throw CompanionError(code: "busy", message: "This is already being sent.") }
        sending.insert(projectId)
        defer { sending.remove(projectId) }
        let project: Project
        do { project = try await client.get(projectId) }
        catch let error as CompanionError where error.code == "not-found" { throw error }
        let photos = Set(project.photos), captured = Set(project.capture ?? [])
        let depths = Set(Self.depths(project))
        let missing = files.filter { file in
            switch file.kind {
            case .scan: project.scan == nil
            case .photo: !photos.contains(file.name)
            case .capture: !captured.contains(file.name)
            case .depth: !depths.contains(file.name)
            }
        }
        var sent = 0, arrived = files.count - missing.count
        func report() { if !files.isEmpty { progress?(Double(arrived) / Double(files.count)) } }
        report()
        for file in missing {
            let bytes: Data?
            switch file.source {
            case .bytes(let data): bytes = data
            case .file(let url): bytes = try? Data(contentsOf: url, options: .mappedIfSafe)
            }
            let limit = file.kind == .scan ? CompanionClient.scanLimit : file.kind == .depth ? CompanionClient.depthLimit : CompanionClient.photoLimit
            guard let bytes, !bytes.isEmpty, bytes.count <= limit else {
                throw CompanionError(code: "unreadable-file", message: "A file from this scan couldn't be read.")
            }
            let path: String, method: String
            if file.kind == .scan { path = "/v1/objects/\(projectId)/scan"; method = "PUT" }
            else {
                let route = file.kind == .depth ? "capture-depth" : file.kind == .capture ? "capture" : "photos"
                let name = file.name.addingPercentEncoding(withAllowedCharacters: Self.queryValue) ?? file.name
                path = "/v1/objects/\(projectId)/\(route)?name=\(name)" + (file.kind == .photo && forMessage ? "&forMessage=true" : ""); method = "POST"
            }
            let reply = try await client.send(method, path, body: bytes, contentType: file.type)
            if reply.status == 409 { throw CompanionError(code: "conflict", message: "This is already being touched up.") }
            guard (200..<300).contains(reply.status) else {
                throw reply.status == 404 ? CompanionError(code: "not-found", message: "This is no longer on your Mac.")
                    : CompanionError(code: "upload-failed", message: "Your Mac didn't accept a file from this scan. Try again.")
            }
            if file.kind != .scan { sent += 1 }
            arrived += 1
            report()
        }
        return sent
    }

    /// `captureDepth` isn't part of `Project` (the screens never show it); read it from the raw reply shape.
    private static func depths(_ project: Project) -> [String] { project.captureDepth ?? [] }

    /// Query-safe: `+` and `&` encoded too, so a name can't split the query.
    static let queryValue: CharacterSet = {
        var set = CharacterSet.urlQueryAllowed
        set.remove(charactersIn: "+&=#")
        return set
    }()

    /// Every image of an Object Capture session's Images folder, in capture order, with the name the Mac keeps it under:
    /// NNNN and its own extension in lower case, as the Mac's capture frames are named. Apple names them by seconds since
    /// the session started ("00041.732011084.HEIC"), which sorts in capture order. The bytes go as they are; the capture
    /// time stays in each HEIC. Anything else in the folder stops the send, in words.
    public static func captureFrames(_ entries: [String]) throws -> [(file: String, name: String)] {
        let files = entries.filter { !$0.hasPrefix(".") }.sorted()
        guard files.count <= 9999 else {
            throw CompanionError(code: "capture-too-large", message: "This scan has more photos than Counterpart can send (\(files.count)). Scan it again with fewer.")
        }
        return try files.enumerated().map { index, file in
            let ext = (file as NSString).pathExtension.lowercased()
            let name = String(format: "%04d.", index + 1) + ext   // the Mac takes ^[0-9]{4}\.(heic|jpe?g|png)$ only
            guard ["heic", "jpg", "jpeg", "png"].contains(ext), !file.contains("/"), !file.contains("..") else {
                throw CompanionError(code: "unsendable-capture", message: "This scan has a file Counterpart can't send (\(file)). Scan it again.")
            }
            return (file, name)
        }
    }

    /// Evenly spread picks from first to last, so every side of the object stays represented.
    public static func spread<T>(_ items: [T], count: Int) -> [T] {
        guard items.count > count, count > 1 else { return Array(items.prefix(max(count, 0))) }
        return (0..<count).map { items[Int((Double($0) * Double(items.count - 1) / Double(count - 1)).rounded())] }
    }
}
