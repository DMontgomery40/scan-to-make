import Foundation
import CryptoKit

public enum CaptureError: Error, Equatable { case invalid(String), limit, unavailable }
public struct CaptureCapabilities: Codable, Equatable {
    public let worldTracking: Bool
    public let sceneDepth: Bool
    public let mesh: Bool
    public init(worldTracking: Bool, sceneDepth: Bool, mesh: Bool) {
        self.worldTracking = worldTracking; self.sceneDepth = sceneDepth; self.mesh = mesh
    }
}
public enum TrackingState: String { case normal, limited, unavailable }

private func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw CaptureError.invalid(message) }
}
private func product(_ a: Int, _ b: Int) throws -> Int {
    guard a >= 0, b >= 0 else { throw CaptureError.limit }
    let (value, overflow) = a.multipliedReportingOverflow(by: b)
    guard !overflow, value <= CaptureEvidence.rawByteCeiling else { throw CaptureError.limit }
    return value
}
private func affine(_ values: [Float]) throws {
    try require(values.count == 16 && values.allSatisfy(\.isFinite), "transform")
    try require(values[3] == 0 && values[7] == 0 && values[11] == 0 && values[15] == 1, "affine transform")
}
private func float(_ data: Data, _ offset: Int) -> Float {
    data.withUnsafeBytes { Float(bitPattern: UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self))) }
}
private func index(_ data: Data, _ offset: Int, _ size: Int) -> Int {
    data.withUnsafeBytes { buffer in
        size == 2 ? Int(UInt16(littleEndian: buffer.loadUnaligned(fromByteOffset: offset, as: UInt16.self)))
                  : Int(UInt32(littleEndian: buffer.loadUnaligned(fromByteOffset: offset, as: UInt32.self)))
    }
}

/// Owned copies of the exact strided depth/confidence buffers. Padding is preserved but not interpreted.
public struct DepthPlane {
    public let bytes: Data
    public let width: Int, height: Int, rowBytes: Int
    public let confidence: Data?
    public let confidenceRowBytes: Int?
    public init(bytes: Data, width: Int, height: Int, rowBytes: Int,
                confidence: Data? = nil, confidenceRowBytes: Int? = nil) throws {
        try require(width > 0 && height > 0 && width <= 2048 && height <= 2048, "depth dimensions")
        try require(rowBytes >= product(width, 4), "depth stride")
        try require(bytes.count == product(rowBytes, height), "depth length")
        for y in 0..<height { for x in 0..<width {
            let value = float(bytes, y * rowBytes + x * 4)
            try require(value.isFinite && value >= 0, "nonfinite or negative depth")
        }}
        if let confidence {
            guard let stride = confidenceRowBytes else { throw CaptureError.invalid("confidence stride") }
            try require(stride >= width && confidence.count == product(stride, height), "confidence length")
            for y in 0..<height { for x in 0..<width { try require(confidence[confidence.startIndex + y * stride + x] <= 2, "confidence value") } }
        } else { try require(confidenceRowBytes == nil, "confidence absent") }
        self.bytes = bytes.withUnsafeBytes { Data($0) }; self.width = width; self.height = height; self.rowBytes = rowBytes
        self.confidence = confidence.map { value in value.withUnsafeBytes { Data($0) } }; self.confidenceRowBytes = confidenceRowBytes
    }
    var byteCount: Int { bytes.count + (confidence?.count ?? 0) }
}

public struct MeshEvidence {
    public let identifier: String
    public let vertices: Data, indices: Data
    public let vertexCount: Int, vertexOffset: Int, vertexStride: Int, faceCount: Int, bytesPerIndex: Int
    public let transform: [Float]
    public init(identifier: String, vertices: Data, vertexCount: Int, vertexOffset: Int, vertexStride: Int,
                indices: Data, faceCount: Int, bytesPerIndex: Int, transform: [Float]) throws {
        try require(!identifier.isEmpty && identifier.utf8.count <= 128, "mesh identifier")
        try require(vertexCount > 0 && vertexCount <= 100_000 && faceCount > 0 && faceCount <= 200_000, "mesh counts")
        try require(vertexOffset >= 0 && vertexStride >= 12 && (bytesPerIndex == 2 || bytesPerIndex == 4), "mesh layout")
        let span = try product(vertexCount - 1, vertexStride)
        try require(vertexOffset <= vertices.count && vertices.count <= CaptureEvidence.rawByteCeiling, "vertex offset")
        try require(vertices.count - vertexOffset >= 12 && span <= vertices.count - vertexOffset - 12, "vertex truncation")
        try require(indices.count >= product(product(faceCount, 3), bytesPerIndex) && indices.count <= CaptureEvidence.rawByteCeiling, "index length")
        try affine(transform)
        for vertex in 0..<vertexCount { for axis in 0..<3 {
            try require(float(vertices, vertexOffset + vertex * vertexStride + axis * 4).isFinite, "nonfinite vertex")
        }}
        for element in 0..<(faceCount * 3) { try require(index(indices, element * bytesPerIndex, bytesPerIndex) < vertexCount, "index range") }
        self.identifier = identifier; self.vertices = vertices.withUnsafeBytes { Data($0) }; self.indices = indices.withUnsafeBytes { Data($0) }
        self.vertexCount = vertexCount; self.vertexOffset = vertexOffset; self.vertexStride = vertexStride
        self.faceCount = faceCount; self.bytesPerIndex = bytesPerIndex; self.transform = transform
    }
    var byteCount: Int { vertices.count + indices.count }
    func worldVertex(_ number: Int) throws -> [Float] {
        let offset = vertexOffset + number * vertexStride
        let xyz = (0..<3).map { float(vertices, offset + $0 * 4) }
        let result = (0..<3).map { row in transform[row] * xyz[0] + transform[4 + row] * xyz[1] + transform[8 + row] * xyz[2] + transform[12 + row] }
        try require(result.allSatisfy(\.isFinite), "world vertex overflow")
        return result
    }
    func triangle(_ number: Int) -> [Int] { (0..<3).map { index(indices, (number * 3 + $0) * bytesPerIndex, bytesPerIndex) } }
}

public struct FrameEvidence {
    public let sessionIdentifier: UUID
    public let timestamp: Double
    public let cameraTransform: [Float], intrinsics: [Float]
    public let imageWidth: Int, imageHeight: Int
    public let tracking: TrackingState
    public let depth: DepthPlane?
    public let meshes: [MeshEvidence]
    public init(sessionIdentifier: UUID, timestamp: Double, cameraTransform: [Float], intrinsics: [Float], imageWidth: Int, imageHeight: Int,
                tracking: TrackingState, depth: DepthPlane? = nil, meshes: [MeshEvidence] = []) throws {
        try require(timestamp.isFinite && timestamp >= 0, "timestamp")
        try affine(cameraTransform)
        try require(intrinsics.count == 9 && intrinsics.allSatisfy(\.isFinite), "intrinsics")
        try require(intrinsics[0] > 0 && intrinsics[4] > 0 && intrinsics[2] == 0 && intrinsics[5] == 0 && intrinsics[8] == 1, "intrinsics basis")
        try require(imageWidth > 0 && imageHeight > 0 && imageWidth <= 16_384 && imageHeight <= 16_384, "image size")
        try require(meshes.count <= 256 && Set(meshes.map(\.identifier)).count == meshes.count, "mesh identifiers")
        self.sessionIdentifier = sessionIdentifier; self.timestamp = timestamp; self.cameraTransform = cameraTransform; self.intrinsics = intrinsics
        self.imageWidth = imageWidth; self.imageHeight = imageHeight; self.tracking = tracking
        self.depth = depth; self.meshes = meshes.sorted { $0.identifier < $1.identifier }
    }
    var byteCount: Int { (depth?.byteCount ?? 0) + meshes.reduce(0) { $0 + $1.byteCount } }
}

/// A bounded evidence collection; no session control, fusion, hole filling or fit qualification.
public struct CaptureEvidence {
    public static let rawByteCeiling = 32 * 1024 * 1024
    public let sessionIdentifier: UUID
    public let capabilities: CaptureCapabilities
    public let maxFrames: Int, maxRawBytes: Int
    public private(set) var frames: [FrameEvidence] = []
    public private(set) var rawByteCount = 0
    public init(sessionIdentifier: UUID, capabilities: CaptureCapabilities, maxFrames: Int = 8, maxRawBytes: Int = rawByteCeiling) throws {
        guard capabilities.worldTracking && (capabilities.sceneDepth || capabilities.mesh) else { throw CaptureError.unavailable }
        try require(maxFrames > 0 && maxFrames <= 32 && maxRawBytes > 0 && maxRawBytes <= Self.rawByteCeiling, "capture limits")
        self.sessionIdentifier = sessionIdentifier; self.capabilities = capabilities; self.maxFrames = maxFrames; self.maxRawBytes = maxRawBytes
    }
    public mutating func append(_ frame: FrameEvidence) throws {
        try require(frame.sessionIdentifier == sessionIdentifier, "session identity")
        try require(frame.depth == nil || capabilities.sceneDepth, "depth capability")
        try require(frame.meshes.isEmpty || capabilities.mesh, "mesh capability")
        try require(frame.depth != nil || !frame.meshes.isEmpty, "no observed input")
        if let last = frames.last { try require(frame.timestamp > last.timestamp, "timestamp order") }
        guard frames.count < maxFrames, frame.byteCount <= maxRawBytes - rawByteCount else { throw CaptureError.limit }
        rawByteCount += frame.byteCount; frames.append(frame)
    }
    /// Returns deterministic named files. Caller owns private, no-overwrite persistence.
    public func export() throws -> [String: Data] {
        try require(!frames.isEmpty, "empty capture")
        var files: [String: Data] = [:], records: [[String: Any]] = []
        for (i, frame) in frames.enumerated() {
            let prefix = String(format: "frames/%04d", i)
            var record: [String: Any] = ["timestamp": frame.timestamp, "cameraTransform": frame.cameraTransform,
                "intrinsics": frame.intrinsics, "imageResolution": [frame.imageWidth, frame.imageHeight], "tracking": frame.tracking.rawValue]
            if let depth = frame.depth {
                files[prefix + "/depth.bin"] = depth.bytes
                var descriptor: [String: Any] = ["file": prefix + "/depth.bin", "width": depth.width, "height": depth.height,
                    "rowBytes": depth.rowBytes, "format": "float32-little-endian", "zeroMeans": "invalid-or-unmeasured"]
                if let confidence = depth.confidence {
                    files[prefix + "/confidence.bin"] = confidence
                    descriptor["confidence"] = ["file": prefix + "/confidence.bin", "rowBytes": depth.confidenceRowBytes!, "format": "uint8-ordinal-0-2"]
                } else { descriptor["confidence"] = NSNull() }
                record["depth"] = descriptor
            } else { record["depth"] = NSNull() }
            record["meshes"] = frame.meshes.enumerated().map { (j, mesh) -> [String: Any] in
                let root = prefix + String(format: "/meshes/%04d", j)
                files[root + "/vertices.bin"] = mesh.vertices; files[root + "/indices.bin"] = mesh.indices
                return ["identifier": mesh.identifier, "vertices": root + "/vertices.bin", "indices": root + "/indices.bin",
                    "vertexCount": mesh.vertexCount, "vertexOffset": mesh.vertexOffset, "vertexStride": mesh.vertexStride,
                    "faceCount": mesh.faceCount, "bytesPerIndex": mesh.bytesPerIndex, "transform": mesh.transform,
                    "vertexFormat": "float32x3-little-endian", "indexFormat": "unsigned-little-endian"]
            }
            records.append(record)
        }
        // Only the final frame's mesh snapshot; do not fuse duplicate anchors across time or resurrect removed anchors.
        if let last = frames.last, !last.meshes.isEmpty {
            var obj = "# Final frame ARKit mesh snapshot; meters; no completeness or fit claim\n", offset = 1
            for (i, mesh) in last.meshes.enumerated() {
                obj += "g mesh_\(i)\n"
                for v in 0..<mesh.vertexCount { let xyz = try mesh.worldVertex(v); obj += "v \(xyz[0]) \(xyz[1]) \(xyz[2])\n" }
                for face in 0..<mesh.faceCount { let t = mesh.triangle(face); obj += "f \(t[0] + offset) \(t[1] + offset) \(t[2] + offset)\n" }
                offset += mesh.vertexCount
                guard obj.utf8.count <= Self.rawByteCeiling else { throw CaptureError.limit }
            }
            files["mesh.obj"] = Data(obj.utf8)
        }
        let artifacts: [[String: Any]] = files.keys.sorted().map { name in
            let bytes = files[name]!
            return ["path": name, "byteLength": bytes.count, "sha256": SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(),
                    "role": name == "mesh.obj" ? "derived-final-frame-mesh" : "original-buffer-copy"]
        }
        let manifest: [String: Any] = ["formatVersion": "0.1.0", "sessionIdentifier": sessionIdentifier.uuidString.lowercased(), "source": "arkit-buffer-snapshot", "units": "meters",
            "matrixLayout": "column-major", "worldFrame": "arkit-session-right-handed", "cameraFrame": "right-up-backward",
            "depthConvention": "positive-camera-plane-distance", "timestampClock": "arkit-session-seconds",
            "capabilities": ["worldTracking": capabilities.worldTracking, "sceneDepth": capabilities.sceneDepth, "mesh": capabilities.mesh],
            "evidence": ["metricAccuracy": "unknown", "surfaceCompleteness": "unknown", "physicalFit": "unknown"],
            "frames": records, "artifacts": artifacts]
        files["manifest.json"] = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes])
        return files
    }
}
