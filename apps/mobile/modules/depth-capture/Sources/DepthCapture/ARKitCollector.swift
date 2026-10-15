#if os(iOS)
import ARKit
import CoreVideo
import Foundation
import Metal

/// Call serially from the owning session's delegate queue. Does not create/run a session or retain ARFrames.
@available(iOS 17.0, *)
public struct ARKitEvidenceCollector {
    public private(set) var evidence: CaptureEvidence
    public static var capabilities: CaptureCapabilities {
        .init(worldTracking: ARWorldTrackingConfiguration.isSupported,
              sceneDepth: ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth),
              mesh: ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh))
    }
    public static func makeConfiguration() throws -> ARWorldTrackingConfiguration {
        let available = capabilities
        guard available.worldTracking && (available.sceneDepth || available.mesh) else { throw CaptureError.unavailable }
        let configuration = ARWorldTrackingConfiguration()
        if available.sceneDepth { configuration.frameSemantics.insert(.sceneDepth) }
        if available.mesh { configuration.sceneReconstruction = .mesh }
        // Plane detection is deliberately not enabled: this collector does not ask ARKit to flatten surfaces.
        return configuration
    }
    public init(session: ARSession, maxFrames: Int = 8, maxRawBytes: Int = CaptureEvidence.rawByteCeiling) throws {
        evidence = try CaptureEvidence(sessionIdentifier: session.identifier, capabilities: Self.capabilities, maxFrames: maxFrames, maxRawBytes: maxRawBytes)
    }
    public mutating func capture(_ session: ARSession) throws {
        guard session.identifier == evidence.sessionIdentifier else { throw CaptureError.invalid("session identity changed") }
        guard let frame = session.currentFrame else { throw CaptureError.invalid("no current frame") }
        guard evidence.frames.count < evidence.maxFrames else { throw CaptureError.limit }
        var remaining = evidence.maxRawBytes - evidence.rawByteCount
        var depth: DepthPlane?
        if evidence.capabilities.sceneDepth, let observation = frame.sceneDepth {
            let buffer = observation.depthMap
            let raw = try Self.copy(buffer, format: kCVPixelFormatType_DepthFloat32, remaining: &remaining)
            var confidence: Data?, confidenceStride: Int?
            if let map = observation.confidenceMap {
                guard CVPixelBufferGetWidth(map) == CVPixelBufferGetWidth(buffer),
                      CVPixelBufferGetHeight(map) == CVPixelBufferGetHeight(buffer) else { throw CaptureError.invalid("confidence resolution") }
                confidence = try Self.copy(map, format: kCVPixelFormatType_OneComponent8, remaining: &remaining)
                confidenceStride = CVPixelBufferGetBytesPerRow(map)
            }
            depth = try DepthPlane(bytes: raw, width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer),
                                   rowBytes: CVPixelBufferGetBytesPerRow(buffer), confidence: confidence, confidenceRowBytes: confidenceStride)
        }
        let anchors = evidence.capabilities.mesh ? frame.anchors.compactMap { $0 as? ARMeshAnchor } : []
        guard anchors.count <= 256 else { throw CaptureError.limit }
        var meshes: [MeshEvidence] = []
        for anchor in anchors {
            let geometry = anchor.geometry, source = geometry.vertices, faces = geometry.faces
            guard source.format == .float3, source.componentsPerVector == 3,
                  faces.primitiveType == .triangle, faces.indexCountPerPrimitive == 3 else { throw CaptureError.invalid("mesh format") }
            // ARKit can expose empty anchors while reconstruction changes; retain only nonempty observations.
            guard source.count > 0 && faces.count > 0 else { continue }
            let vertices = try Self.copy(source.buffer.contents(), length: source.buffer.length, remaining: &remaining)
            let indices = try Self.copy(faces.buffer.contents(), length: faces.buffer.length, remaining: &remaining)
            meshes.append(try MeshEvidence(identifier: anchor.identifier.uuidString.lowercased(), vertices: vertices,
                vertexCount: source.count, vertexOffset: source.offset, vertexStride: source.stride,
                indices: indices, faceCount: faces.count, bytesPerIndex: faces.bytesPerIndex, transform: Self.matrix(anchor.transform)))
        }
        let tracking: TrackingState
        switch frame.camera.trackingState {
        case .normal: tracking = .normal
        case .limited: tracking = .limited
        case .notAvailable: tracking = .unavailable
        }
        let k = frame.camera.intrinsics
        let intrinsics = (0..<3).flatMap { column in (0..<3).map { k[column][$0] } }
        let record = try FrameEvidence(sessionIdentifier: evidence.sessionIdentifier, timestamp: frame.timestamp, cameraTransform: Self.matrix(frame.camera.transform),
            intrinsics: intrinsics, imageWidth: Int(frame.camera.imageResolution.width), imageHeight: Int(frame.camera.imageResolution.height),
            tracking: tracking, depth: depth, meshes: meshes)
        guard session.identifier == evidence.sessionIdentifier else { throw CaptureError.invalid("session identity changed") }
        try evidence.append(record)
    }
    private static func matrix(_ matrix: simd_float4x4) -> [Float] {
        (0..<4).flatMap { column in (0..<4).map { matrix[column][$0] } }
    }
    private static func copy(_ buffer: CVPixelBuffer, format: OSType, remaining: inout Int) throws -> Data {
        guard CVPixelBufferGetPixelFormatType(buffer) == format, !CVPixelBufferIsPlanar(buffer) else { throw CaptureError.invalid("pixel format") }
        let (length, overflow) = CVPixelBufferGetBytesPerRow(buffer).multipliedReportingOverflow(by: CVPixelBufferGetHeight(buffer))
        guard !overflow, length <= CVPixelBufferGetDataSize(buffer) else { throw CaptureError.invalid("pixel buffer length") }
        guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { throw CaptureError.invalid("pixel buffer lock") }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let pointer = CVPixelBufferGetBaseAddress(buffer) else { throw CaptureError.invalid("pixel buffer address") }
        return try copy(pointer, length: length, remaining: &remaining)
    }
    private static func copy(_ pointer: UnsafeRawPointer, length: Int, remaining: inout Int) throws -> Data {
        guard length > 0, length <= remaining else { throw CaptureError.limit }
        remaining -= length
        return Data(bytes: pointer, count: length)
    }
}
#endif
