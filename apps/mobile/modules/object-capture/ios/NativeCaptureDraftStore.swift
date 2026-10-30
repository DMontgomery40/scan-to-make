import Foundation
import CryptoKit
import Darwin

struct NativeCaptureDestination: Codable, Equatable {
    let projectId: String
    let revision: Int
    let snapshot: String
    let context: String?
}
struct NativeCaptureFile: Codable, Equatable {
    let sha256: String
    let byteLength: Int
    let mediaType: String
}
struct NativeCaptureDraft: Codable, Equatable {
    let formatVersion: Int
    let runID: String
    let origin: NativeCaptureDestination
    let createdAt: String
    var status: String
    var file: NativeCaptureFile?
    var message: String?

    func dictionary() throws -> [String: Any] {
        var value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as! [String: Any]
        var destination = value["origin"] as! [String: Any]
        if origin.context == nil { destination["context"] = NSNull() }
        value["origin"] = destination
        return value
    }
}

/// Paths never cross the JS bridge. Open each mutable directory with NOFOLLOW.
final class NativeCaptureDraftStore {
    static let manifestLimit = 5 * 1024 * 1024
    let root: URL
    init(root: URL = URL.documentsDirectory.appendingPathComponent("NativeCaptures", isDirectory: true)) {
        self.root = root
    }
    static func validID(_ id: String) -> Bool {
        UUID(uuidString: id)?.uuidString.lowercased() == id
    }
    func directory(_ id: String) throws -> URL {
        guard Self.validID(id) else { throw failure("Invalid local capture identity.") }
        return root.appendingPathComponent(id, isDirectory: true)
    }
    private func failure(_ message: String) -> NSError {
        NSError(domain: "NativeCaptureDraft", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    private func rootFD(create: Bool = false) throws -> Int32 {
        if create { try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true) }
        let fd = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw failure("Local captures could not be opened.") }
        return fd
    }
    private func runFD(_ id: String) throws -> Int32 {
        _ = try directory(id)
        let parent = try rootFD(); defer { close(parent) }
        let fd = openat(parent, id, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw failure("This local capture could not be opened.") }
        return fd
    }
    func create(origin: NativeCaptureDestination) throws -> NativeCaptureDraft {
        guard origin.projectId.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
              origin.revision >= 0, origin.snapshot.utf8.count <= 4 * 1024 * 1024,
              (origin.context?.utf8.count ?? 0) <= 4096 else { throw failure("Invalid capture destination.") }
        let parent = try rootFD(create: true); defer { close(parent) }
        let id = UUID().uuidString.lowercased()
        guard mkdirat(parent, id, 0o700) == 0 else { throw failure("A capture folder could not be created.") }
        let draft = NativeCaptureDraft(formatVersion: 1, runID: id, origin: origin,
                                       createdAt: ISO8601DateFormatter().string(from: Date()), status: "capturing")
        try write(draft)
        guard fsync(parent) == 0 else { throw failure("The capture folder could not be saved.") }
        return draft
    }
    func read(_ id: String) throws -> NativeCaptureDraft {
        let parent = try runFD(id); defer { close(parent) }
        let fd = openat(parent, "manifest.json", O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw failure("Capture details could not be read.") }; defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_size > 0, info.st_size <= Self.manifestLimit else { throw failure("Invalid capture details.") }
        let data = try readExactly(fd: fd, count: Int(info.st_size))
        let draft = try JSONDecoder().decode(NativeCaptureDraft.self, from: data)
        guard draft.runID == id, draft.formatVersion == 1 else { throw failure("Capture identity mismatch.") }
        return draft
    }
    private func readExactly(fd: Int32, count: Int) throws -> Data {
        var data = Data(count: count)
        let good = data.withUnsafeMutableBytes { bytes -> Bool in
            var offset = 0
            while offset < count {
                let n = Darwin.read(fd, bytes.baseAddress!.advanced(by: offset), count - offset)
                if n <= 0 { return false }; offset += n
            }
            var extra: UInt8 = 0
            return Darwin.read(fd, &extra, 1) == 0
        }
        guard good else { throw failure("Capture file changed while reading.") }
        return data
    }
    func write(_ draft: NativeCaptureDraft) throws {
        let data = try JSONEncoder().encode(draft)
        guard data.count <= Self.manifestLimit else { throw failure("Capture details are too large.") }
        let parent = try runFD(draft.runID); defer { close(parent) }
        let name = UUID().uuidString + ".tmp"
        let fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw failure("Capture details could not be saved.") }
        defer { close(fd); unlinkat(parent, name, 0) }
        let good = data.withUnsafeBytes { bytes -> Bool in
            var offset = 0
            while offset < data.count {
                let n = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), data.count - offset)
                if n <= 0 { return false }; offset += n
            }
            return true
        }
        guard good, fsync(fd) == 0, renameat(parent, name, parent, "manifest.json") == 0,
              fsync(parent) == 0 else { throw failure("Capture details could not be saved.") }
    }
    func update(_ id: String, status: String, message: String? = nil) throws {
        var draft = try read(id); draft.status = status; draft.message = message; try write(draft)
    }
    func complete(_ id: String) throws -> NativeCaptureDraft {
        let parent = try runFD(id); defer { close(parent) }
        let models = openat(parent, "Models", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard models >= 0 else { throw failure("The model folder could not be opened.") }; defer { close(models) }
        let fd = openat(models, "model-mobile.usdz", O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw failure("Reconstruction returned no readable model.") }; defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size > 0 else {
            throw failure("Reconstruction returned no model bytes.")
        }
        var hash = SHA256(); var total = 0
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            guard count >= 0 else { throw failure("The model could not be verified.") }
            if count == 0 { break }
            total += count
            guard total <= info.st_size else { throw failure("The model changed while verifying.") }
            hash.update(data: Data(buffer.prefix(count)))
        }
        guard total == info.st_size else { throw failure("The model changed while verifying.") }
        var draft = try read(id)
        draft.file = NativeCaptureFile(sha256: hash.finalize().map { String(format: "%02x", $0) }.joined(),
                                       byteLength: total, mediaType: "model/vnd.usdz+zip")
        draft.status = "ready"; draft.message = nil; try write(draft)
        return draft
    }
    func list(activeRunID: String?) throws -> [NativeCaptureDraft] {
        guard FileManager.default.fileExists(atPath: root.path) else { return [] }
        let parent = try rootFD(); close(parent)
        var results: [NativeCaptureDraft] = []
        for id in try FileManager.default.contentsOfDirectory(atPath: root.path) where Self.validID(id) {
            // A damaged folder must not hide other retained captures. Adoption always validates again.
            guard var draft = try? read(id) else { continue }
            if id != activeRunID && ["capturing", "stopping"].contains(draft.status) {
                draft.status = "interrupted"
                draft.message = "Capture was interrupted. Original files are kept on this device."
                try write(draft)
            }
            results.append(draft)
        }
        return results.sorted { $0.createdAt > $1.createdAt }
    }
}
