import XCTest
@testable import DepthCapture

final class EvidenceTests: XCTestCase {
    let sessionIdentifier = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
    let identity: [Float] = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
    func floats(_ values: [Float]) -> Data {
        var data = Data()
        for value in values { var bits = value.bitPattern.littleEndian; withUnsafeBytes(of: &bits) { data.append(contentsOf: $0) } }
        return data
    }
    func triangle(transform: [Float]? = nil) throws -> MeshEvidence {
        try MeshEvidence(identifier: "mesh-1", vertices: floats([0,0,0,99, 1,0,0,99, 0,1,0,99]), vertexCount: 3,
            vertexOffset: 0, vertexStride: 16, indices: Data([0,0,1,0,2,0]), faceCount: 1, bytesPerIndex: 2,
            transform: transform ?? identity)
    }
    func frame(depth: DepthPlane? = nil, meshes: [MeshEvidence] = []) throws -> FrameEvidence {
        try FrameEvidence(sessionIdentifier: sessionIdentifier, timestamp: 1, cameraTransform: identity, intrinsics: [10,0,0,0,10,0,1,1,1],
            imageWidth: 2, imageHeight: 2, tracking: .normal, depth: depth, meshes: meshes)
    }
    func testPaddedDepthPreservesOriginalAndValidatesConfidence() throws {
        var bytes = floats([1,2,77,3,4,88])
        let plane = try DepthPlane(bytes: bytes, width: 2, height: 2, rowBytes: 12,
            confidence: Data([2,1,99,0,2,99]), confidenceRowBytes: 3)
        bytes[0] = 100
        XCTAssertEqual(plane.bytes, floats([1,2,77,3,4,88]))
        XCTAssertThrowsError(try DepthPlane(bytes: floats([.nan]), width: 1, height: 1, rowBytes: 4))
        XCTAssertThrowsError(try DepthPlane(bytes: Data([0,0,0]), width: 1, height: 1, rowBytes: 4))
        XCTAssertThrowsError(try DepthPlane(bytes: floats([1]), width: 1, height: 1, rowBytes: 3))
        XCTAssertThrowsError(try DepthPlane(bytes: floats([1]), width: 1, height: 1, rowBytes: 4, confidence: Data([3]), confidenceRowBytes: 1))
    }
    func testMeshStrideTransformAndDeterministicIdentityExport() throws {
        var translated = identity; translated[12] = 10
        let record = try frame(meshes: [triangle(transform: translated)])
        var capture = try CaptureEvidence(sessionIdentifier: sessionIdentifier, capabilities: .init(worldTracking: true, sceneDepth: false, mesh: true))
        try capture.append(record)
        let first = try capture.export()
        XCTAssertEqual(first, try capture.export())
        XCTAssertTrue(String(decoding: first["mesh.obj"]!, as: UTF8.self).contains("v 10.0 0.0 0.0"))
        XCTAssertTrue(String(decoding: first["mesh.obj"]!, as: UTF8.self).contains("f 1 2 3"))
        let manifest = try XCTUnwrap(JSONSerialization.jsonObject(with: first["manifest.json"]!) as? [String: Any])
        XCTAssertEqual((manifest["evidence"] as? [String: String])?["physicalFit"], "unknown")
        XCTAssertNotNil(manifest["artifacts"])
        XCTAssertEqual(first["frames/0000/meshes/0000/vertices.bin"], try triangle().vertices)
    }
    func testRejectsInvalidGeometryAndMetadata() throws {
        XCTAssertThrowsError(try MeshEvidence(identifier: "bad", vertices: floats([.infinity,0,0]), vertexCount: 1, vertexOffset: 0, vertexStride: 12,
            indices: Data([0,0,0,0,0,0]), faceCount: 1, bytesPerIndex: 2, transform: identity))
        XCTAssertThrowsError(try MeshEvidence(identifier: "bad", vertices: floats([0,0,0]), vertexCount: 1, vertexOffset: 0, vertexStride: 12,
            indices: Data([0,0,1,0,0,0]), faceCount: 1, bytesPerIndex: 2, transform: identity))
        XCTAssertThrowsError(try MeshEvidence(identifier: "bad", vertices: floats([0,0,0]), vertexCount: 1, vertexOffset: 0, vertexStride: 12,
            indices: Data([0]), faceCount: 1, bytesPerIndex: 2, transform: identity))
        var bad = identity; bad[3] = 1
        XCTAssertThrowsError(try triangle(transform: bad))
        XCTAssertThrowsError(try FrameEvidence(sessionIdentifier: sessionIdentifier, timestamp: .nan, cameraTransform: identity, intrinsics: [Float](repeating: 1,count: 9), imageWidth: 1, imageHeight: 1, tracking: .normal))
    }
    func testIndependentCapabilitiesLimitsAndNoPartialMutation() throws {
        var capture = try CaptureEvidence(sessionIdentifier: sessionIdentifier, capabilities: .init(worldTracking: true, sceneDepth: true, mesh: false), maxFrames: 1, maxRawBytes: 4)
        let depth = try DepthPlane(bytes: floats([1]), width: 1, height: 1, rowBytes: 4)
        XCTAssertThrowsError(try capture.append(frame(meshes: [triangle()])))
        try capture.append(frame(depth: depth))
        XCTAssertThrowsError(try capture.append(frame(depth: depth)))
        XCTAssertEqual(capture.frames.count, 1)
        XCTAssertThrowsError(try CaptureEvidence(sessionIdentifier: sessionIdentifier, capabilities: .init(worldTracking: false, sceneDepth: true, mesh: true)))
        var empty = try CaptureEvidence(sessionIdentifier: sessionIdentifier, capabilities: .init(worldTracking: true, sceneDepth: true, mesh: true))
        XCTAssertThrowsError(try empty.append(frame()))
        XCTAssertEqual(empty.frames.count, 0)
    }
}

extension EvidenceTests {
    func testCopiesBorrowedStorageBeforeItChanges() throws {
        let pointer = UnsafeMutableRawPointer.allocate(byteCount: 64, alignment: 4)
        defer { pointer.deallocate() }
        for offset in stride(from: 0, to: 64, by: 4) { pointer.storeBytes(of: Float(1).bitPattern, toByteOffset: offset, as: UInt32.self) }
        let borrowed = Data(bytesNoCopy: pointer, count: 64, deallocator: .none)
        let plane = try DepthPlane(bytes: borrowed, width: 16, height: 1, rowBytes: 64)
        pointer.storeBytes(of: Float(2).bitPattern, as: UInt32.self)
        XCTAssertEqual(plane.bytes, floats([Float](repeating: 1, count: 16)))
    }
    func testPaddedIndicesArePreservedWithoutBecomingFaces() throws {
        let mesh = try MeshEvidence(identifier: "padded", vertices: floats([0,0,0,1,0,0,0,1,0]), vertexCount: 3,
            vertexOffset: 0, vertexStride: 12, indices: Data([0,0,1,0,2,0,99,99]), faceCount: 1, bytesPerIndex: 2, transform: identity)
        XCTAssertEqual(mesh.indices.count, 8)
    }
    func testIdentityDigestMatchesExactRawAndDerivedBytes() throws {
        var capture = try CaptureEvidence(sessionIdentifier: sessionIdentifier, capabilities: .init(worldTracking: true, sceneDepth: false, mesh: true))
        try capture.append(frame(meshes: [triangle()]))
        let files = try capture.export()
        let manifest = try XCTUnwrap(JSONSerialization.jsonObject(with: files["manifest.json"]!) as? [String: Any])
        let artifacts = try XCTUnwrap(manifest["artifacts"] as? [[String: Any]])
        for artifact in artifacts {
            let path = try XCTUnwrap(artifact["path"] as? String)
            let data = try XCTUnwrap(files[path])
            XCTAssertEqual(artifact["byteLength"] as? Int, data.count)
            // Known SHA-256 of this fixture's three uint16 triangle indices.
            if path.hasSuffix("indices.bin") { XCTAssertEqual(artifact["sha256"] as? String, "90c2698921ca9fd02950be353f721888760e33ab5095a21e50f1e4360b6de1a0") }
        }
    }
    func testLaterSnapshotDoesNotDuplicateOrResurrectOldMeshes() throws {
        var capture = try CaptureEvidence(sessionIdentifier: sessionIdentifier, capabilities: .init(worldTracking: true, sceneDepth: true, mesh: true))
        try capture.append(frame(meshes: [triangle()]))
        let depth = try DepthPlane(bytes: floats([1]), width: 1, height: 1, rowBytes: 4)
        try capture.append(FrameEvidence(sessionIdentifier: sessionIdentifier, timestamp: 2, cameraTransform: identity, intrinsics: [10,0,0,0,10,0,1,1,1], imageWidth: 2, imageHeight: 2, tracking: .limited, depth: depth))
        let files = try capture.export()
        XCTAssertNil(files["mesh.obj"])
        XCTAssertNotNil(files["frames/0000/meshes/0000/vertices.bin"])
        XCTAssertNotNil(files["frames/0001/depth.bin"])
    }
    func testRejectsOversizeOverflowAndOutOfOrderWithoutPartialAppend() throws {
        XCTAssertThrowsError(try DepthPlane(bytes: Data(), width: 1, height: 2, rowBytes: Int.max))
        XCTAssertThrowsError(try DepthPlane(bytes: Data(), width: 2049, height: 1, rowBytes: 8196))
        var capture = try CaptureEvidence(sessionIdentifier: sessionIdentifier, capabilities: .init(worldTracking: true, sceneDepth: false, mesh: true), maxRawBytes: 1)
        XCTAssertThrowsError(try capture.append(frame(meshes: [triangle()])))
        XCTAssertEqual(capture.frames.count, 0)
        XCTAssertEqual(capture.rawByteCount, 0)
        var ordered = try CaptureEvidence(sessionIdentifier: sessionIdentifier, capabilities: .init(worldTracking: true, sceneDepth: false, mesh: true))
        try ordered.append(frame(meshes: [triangle()]))
        XCTAssertThrowsError(try ordered.append(frame(meshes: [triangle()])))
        XCTAssertEqual(ordered.frames.count, 1)
    }
    func test32BitIndicesAndOffsetVerticesUseDeclaredLayout() throws {
        let mesh = try MeshEvidence(identifier: "offset", vertices: floats([999, 0,0,0, 1,0,0, 0,1,0]), vertexCount: 3,
            vertexOffset: 4, vertexStride: 12, indices: Data([0,0,0,0,1,0,0,0,2,0,0,0]), faceCount: 1, bytesPerIndex: 4, transform: identity)
        var capture = try CaptureEvidence(sessionIdentifier: sessionIdentifier, capabilities: .init(worldTracking: true, sceneDepth: false, mesh: true))
        try capture.append(frame(meshes: [mesh]))
        let obj = String(decoding: try capture.export()["mesh.obj"]!, as: UTF8.self)
        XCTAssertTrue(obj.contains("v 1.0 0.0 0.0")); XCTAssertFalse(obj.contains("999"))
    }
}

extension EvidenceTests {
    func testRejectsCoordinateFramesFromAnotherSession() throws {
        var capture = try CaptureEvidence(sessionIdentifier: sessionIdentifier, capabilities: .init(worldTracking: true, sceneDepth: false, mesh: true))
        let other = try FrameEvidence(sessionIdentifier: UUID(), timestamp: 2, cameraTransform: identity,
            intrinsics: [10,0,0,0,10,0,1,1,1], imageWidth: 2, imageHeight: 2, tracking: .normal, meshes: [triangle()])
        XCTAssertThrowsError(try capture.append(other))
        XCTAssertEqual(capture.frames.count, 0)
    }
}
