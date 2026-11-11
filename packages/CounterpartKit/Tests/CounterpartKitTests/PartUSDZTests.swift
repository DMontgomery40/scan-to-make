#if canImport(RealityKit) && canImport(ModelIO)
import XCTest
import RealityKit
@testable import CounterpartKit

/// Nov 11: a designed part never appeared in AR, because the app handed AR Quick Look a Reality file named `.usdz`.
@available(iOS 18, macOS 15, *)
final class PartUSDZTests: XCTestCase {
    /// A box in the STL frame (millimetres, Z up), 146 × 40 × 20 mm, its corner at the origin, wound outwards.
    static func box(_ size: SIMD3<Float> = [146, 40, 20]) -> [PartUSDZ.Triangle] {
        let c: [SIMD3<Float>] = (0..<8).map { i in SIMD3(Float(i & 1), Float((i >> 1) & 1), Float((i >> 2) & 1)) * size }
        let faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]
        return faces.flatMap { f in [(c[f[0]], c[f[1]], c[f[2]]), (c[f[0]], c[f[2]], c[f[3]])] }
    }

    private func folder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        return folder
    }

    /// The file is what its name says (a USD layer first in the zip), at true size, standing on y = 0, Y up, and no
    /// scratch file is left beside it.
    @MainActor func testAPartIsARealUSDZAtTrueSizeRestingOnTheFloor() async throws {
        let folder = try folder()
        let target = folder.appendingPathComponent("model.ff0000.ar.usdz")
        try PartUSDZ.write(Self.box(), srgb: [1, 0, 0], to: target)
        XCTAssertTrue(PartUSDZ.isUSDZ(target))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["model.ff0000.ar.usdz"])
        let entity = try await Entity(contentsOf: target)
        let bounds = entity.visualBounds(relativeTo: nil)
        // 146 mm along X, 20 mm tall (STL Z is up), 40 mm deep: metres, not 146 m and not 0.146 mm.
        XCTAssertEqual(bounds.extents.x, 0.146, accuracy: 0.0005)
        XCTAssertEqual(bounds.extents.y, 0.020, accuracy: 0.0005)
        XCTAssertEqual(bounds.extents.z, 0.040, accuracy: 0.0005)
        XCTAssertEqual(bounds.min.y, 0, accuracy: 0.0005, "it rests on the surface")
        XCTAssertEqual(bounds.center.x, 0, accuracy: 0.0005); XCTAssertEqual(bounds.center.z, 0, accuracy: 0.0005)
    }

    /// The old export: RealityKit's `Entity.write(to:)` named `.usdz`. It is a zip too, and must not pass for USDZ, so the
    /// app replaces the ones it wrote before.
    @MainActor func testARealityFileNamedUSDZIsNotAUSDZ() async throws {
        let folder = try folder()
        let reality = folder.appendingPathComponent("model.usdz")
        try await ModelEntity(mesh: .generateBox(size: 0.1), materials: [SimpleMaterial()]).write(to: reality)
        XCTAssertEqual(try Data(contentsOf: reality).prefix(2), Data("PK".utf8), "the Reality file is a zip")
        XCTAssertFalse(PartUSDZ.isUSDZ(reality))
        XCTAssertFalse(PartUSDZ.isUSDZ(folder.appendingPathComponent("missing.usdz")))
    }

    /// The spool's colour as the printer reports it (sRGB) is decoded for UsdPreviewSurface, which is linear.
    func testTheSpoolColourIsLinearised() {
        XCTAssertEqual(PartUSDZ.linear(1), 1, accuracy: 0.0001)
        XCTAssertEqual(PartUSDZ.linear(0.5), 0.2140, accuracy: 0.0005)
        XCTAssertEqual(PartUSDZ.linear(0.02), 0.02 / 12.92, accuracy: 0.00001)
    }

    func testNothingToDrawWritesNothing() throws {
        let target = try folder().appendingPathComponent("empty.usdz")
        XCTAssertThrowsError(try PartUSDZ.write([], srgb: [1, 1, 1], to: target))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }
}
#endif
