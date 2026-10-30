// SPDX-License-Identifier: MIT
import Foundation
import CryptoKit
import ImageIO

public struct Failure: Error, CustomStringConvertible {
    public let description: String
    public init(_ message: String) { description = message }
}
public struct Options: Codable, Equatable {
    public var detail = "medium"
    public var ordering = "unordered"
    public var sensitivity = "normal"
    public var masking = true
    public var timeoutSeconds: Double = 3600
    public var input = ""
    public var output = ""
    public var objDirectory: String?
    public static let usage = """
    photogrammetry-reconstruct IMAGES --output MODEL.usdz
      [--detail preview|reduced|medium|full|raw]
      [--ordering unordered|sequential] [--sensitivity normal|high]
      [--masking on|off] [--timeout-seconds 3600] [--obj-directory NEW_FOLDER]
    Writes MODEL.usdz.report.json. Output paths must not exist or be inside IMAGES.
    """
    public static func parse(_ args: [String]) throws -> Self {
        guard let first = args.first, !first.hasPrefix("-") else { throw Failure(usage) }
        var o = Self(); o.input = first
        var i = 1; var seen = Set<String>()
        while i < args.count {
            let key = args[i]
            guard seen.insert(key).inserted, i + 1 < args.count else { throw Failure("Duplicate option or missing value: \(key)") }
            let value = args[i + 1]; i += 2
            switch key {
            case "--output": o.output = value
            case "--obj-directory": o.objDirectory = value
            case "--detail": o.detail = value
            case "--ordering": o.ordering = value
            case "--sensitivity": o.sensitivity = value
            case "--masking":
                guard ["on", "off"].contains(value) else { throw Failure("Invalid masking") }; o.masking = value == "on"
            case "--timeout-seconds":
                guard let n = Double(value), n.isFinite, n > 0, n <= 86400 else { throw Failure("Timeout must be >0 and <=86400 seconds") }; o.timeoutSeconds = n
            default: throw Failure("Unknown option: \(key)")
            }
        }
        guard !o.output.isEmpty, URL(fileURLWithPath: o.output).pathExtension.lowercased() == "usdz",
              ["preview", "reduced", "medium", "full", "raw"].contains(o.detail),
              ["unordered", "sequential"].contains(o.ordering), ["normal", "high"].contains(o.sensitivity) else { throw Failure("Invalid options.\n" + usage) }
        return o
    }
}
public struct ImageRecord: Codable, Equatable {
    public let name: String
    public let sha256: String
}
public func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
public func fileDigest(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
    var hash = SHA256()
    while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty { hash.update(data: chunk) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}
public func validateNames(_ names: [String]) throws {
    var seen = Set<String>()
    for name in names {
        let key = name.precomposedStringWithCanonicalMapping.lowercased()
        guard seen.insert(key).inserted else { throw Failure("Duplicate image name (case/Unicode folded): \(name)") }
    }
}
public func images(in folder: URL) throws -> [ImageRecord] {
    let fm = FileManager.default
    var isDir: ObjCBool = false
    guard fm.fileExists(atPath: folder.path, isDirectory: &isDir), isDir.boolValue else { throw Failure("Image folder is missing or not a directory") }
    let files = try fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey]).filter { $0.lastPathComponent != ".DS_Store" }
    guard !files.isEmpty else { throw Failure("Image folder is empty") }
    try validateNames(files.map(\.lastPathComponent))
    return try files.sorted { $0.lastPathComponent < $1.lastPathComponent }.map { url in
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              ["heic", "heif", "jpg", "jpeg", "png", "tif", "tiff"].contains(url.pathExtension.lowercased()),
              let source = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(source) > 0,
              CGImageSourceCopyPropertiesAtIndex(source, 0, nil) != nil else { throw Failure("Unsupported or unreadable image entry: \(url.lastPathComponent)") }
        return ImageRecord(name: url.lastPathComponent, sha256: try fileDigest(url))
    }
}
public func canonical<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
}
public struct OutputRecord: Codable {
    public let name: String
    public let sha256: String
    public let vertices: Int?
    public let triangles: Int?
    public init(name: String, sha256: String, vertices: Int? = nil, triangles: Int? = nil) {
        self.name = name; self.sha256 = sha256; self.vertices = vertices; self.triangles = triangles
    }
}
public struct Payload: Encodable {
    public let schemaVersion = 1
    public let provesPhysicalAccuracy = false
    public let api = "RealityKit.PhotogrammetrySession"
    public let apiVersion = "macOS 14 API surface; framework version follows OS (no public independent version)"
    public let os: String
    public let inputImageCount: Int
    public let images: [ImageRecord]
    public let options: Options
    public let outputs: [OutputRecord]
    public let warnings: [String]
    public init(os: String, images: [ImageRecord], options: Options, outputs: [OutputRecord], warnings: [String]) {
        self.os = os; self.inputImageCount = images.count; self.images = images; self.options = options; self.outputs = outputs; self.warnings = warnings.sorted()
    }
}
public struct Report: Encodable {
    public let payload: Payload
    public let payloadSHA256: String
    public let elapsedSeconds: Double
    public init(payload: Payload, elapsedSeconds: Double) throws {
        self.payload = payload; self.payloadSHA256 = digest(try canonical(payload)); self.elapsedSeconds = elapsedSeconds
    }
}
