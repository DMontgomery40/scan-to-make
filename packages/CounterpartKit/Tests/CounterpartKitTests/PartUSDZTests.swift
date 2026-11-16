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
    /// #691, #845: a design in two colours goes to AR as one file with each part in its own colour, the parts where they
    /// sit together (the bar under the letters), resting on the floor as a whole.
    @MainActor func testTwoPartsGoToARInOneFileEachInItsOwnColour() async throws {
        let folder = try folder()
        let bar = Self.box([150, 20, 8])
        let letters = Self.box([120, 8, 40]).map { ($0.0 + [15, 6, 8], $0.1 + [15, 6, 8], $0.2 + [15, 6, 8]) }
        let layer = folder.appendingPathComponent("parts.usda")
        XCTAssertEqual(try PartUSDZ.usda([(bar, [0.69, 0.52, 0.36]), (letters, [0.07, 0.07, 0.07])], to: layer), 24)
        let text = try String(contentsOf: layer, encoding: .utf8)
        XCTAssertTrue(text.contains("def Mesh \"Mesh1\"") && text.contains("def Mesh \"Mesh2\""), "a mesh per part")
        XCTAssertTrue(text.contains("</Part/Materials/Filament1>") && text.contains("</Part/Materials/Filament2>"), "each bound to its own colour")
        XCTAssertTrue(text.contains("color3f inputs:diffuseColor = (\(String(format: "%.4f", PartUSDZ.linear(0.69)))"), "the bar's colour, linear")
        let target = folder.appendingPathComponent("parts.ar.usdz")
        try PartUSDZ.write(parts: [(bar, [0.69, 0.52, 0.36]), (letters, [0.07, 0.07, 0.07])], to: target)
        XCTAssertTrue(PartUSDZ.isUSDZ(target))
        let entity = try await Entity(contentsOf: target)
        let bounds = entity.visualBounds(relativeTo: nil)
        XCTAssertEqual(bounds.min.y, 0, accuracy: 0.0005, "the whole rests on the floor")
        XCTAssertEqual(bounds.extents.y, 0.048, accuracy: 0.0005, "the letters stand on the bar: 8 + 40 mm")
        XCTAssertEqual(bounds.extents.x, 0.150, accuracy: 0.0005)
    }

    /// Review of #872: a part with no triangle that can be drawn fails the whole file, so AR isn't offered, rather than an
    /// AR file with that part quietly missing.
    func testAPartWithNothingToDrawFailsTheFileRatherThanGoingMissing() throws {
        let folder = try folder()
        let target = folder.appendingPathComponent("parts.ar.usdz")
        let flat: [PartUSDZ.Triangle] = [([0, 0, 0], [0, 0, 0], [0, 0, 0]), ([1, 1, 1], [2, 2, 2], [3, 3, 3])]
        XCTAssertThrowsError(try PartUSDZ.write(parts: [(Self.box(), [1, 0, 0]), (flat, [0, 0, 1])], to: target)) { error in
            XCTAssertEqual(error as? PartUSDZ.Failure, .empty)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path), "no file with a piece missing")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), [], "and no scratch left")
    }

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

    /// #840, the exact crash input: sliver triangles from the merged mesh a Blender pass wrote beside David's Pink snap-lid
    /// box 3MF (tris 5332, 5406, 5532, 34219, 34294 of `current/model.stl`) and his Guitar pick (tris 11562, 11718), byte
    /// for byte (STL corners, little-endian Float32). Each cross product is about 1e-20, so its squared length is subnormal:
    /// `simd_normalize` overflowed to `(nan, nan, ±inf)` and writing that normal (`Int64(NaN)`, PartUSDZ.swift:82) trapped.
    static let slivers = [
        "c45f0d42cdcc8e42c33b8533d82e0d42cdcc8e42802f8e33b4240d42cdcc8e428f0a9033",
        "66669a4231ac6dc250656b3666669a42b0b86dc2b0706b3666669a4246bb6dc20b736b36",
        "5fae0e4266668c4263d3d3336cb80e4266668c4255fcd133efe80e4266668c42e51bc933",
        "b4240d42cdcc8e428f0a9033d82e0d42cdcc8e42802f8e33c45f0d42cdcc8e42c33b8533",
        "66669a4246bb6dc20b736b3666669a42b0b86dc2b0706b3666669a4231ac6dc250656b36",
        "0ba8a53f9b96cbbe9a99193f33c9a53ffb73c8be9a99193f5aeaa53f5b51c5be9a99193f",
        "8610fa3f0a841a3e9a99193fd00bfb3f06991a3e9a99193f1907fc3f02ae1a3e9a99193f",
    ].map(triangle)

    /// Whether a USD layer writes a number that isn't one (`nan`, `inf`), as a word (never `assetInfo`).
    static func notANumber(_ layer: String) -> Bool {
        layer.range(of: #"(?<![A-Za-z])-?(nan|inf|infinity)(?![A-Za-z])"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Three corners from 36 hex-encoded bytes (9 little-endian Float32s), as an STL record stores them.
    static func triangle(_ hex: String) -> PartUSDZ.Triangle {
        var bytes = [UInt8](); var index = hex.startIndex
        while index < hex.endIndex { let next = hex.index(index, offsetBy: 2); bytes.append(UInt8(hex[index..<next], radix: 16) ?? 0); index = next }
        let f: [Float] = (0..<9).map { i -> Float in
            var bits: UInt32 = 0
            for k in 0..<4 { bits |= UInt32(bytes[i * 4 + k]) << UInt32(8 * k) }
            return Float(bitPattern: bits)
        }
        return (SIMD3(f[0], f[1], f[2]), SIMD3(f[3], f[4], f[5]), SIMD3(f[6], f[7], f[8]))
    }

    /// #840: the pink box's slivers beside a real part write a real USDZ. A sliver keeps its true normal (worked in
    /// `Double`), and no number in the layer is NaN or infinite.
    func testThePinkSnapLidBoxsSliverTrianglesWriteAUSDZInsteadOfCrashing() throws {
        let folder = try folder()
        let layer = folder.appendingPathComponent("layer.usda")
        let kept = try PartUSDZ.usda(Self.box() + Self.slivers, srgb: [0.96, 0.33, 0.49], to: layer)
        let stage = { (p: SIMD3<Float>) in SIMD3(p.x, p.z, -p.y) * 0.001 }
        let normals = Self.slivers.compactMap { STLMesh.faceNormal(stage($0.0), stage($0.1), stage($0.2)) }
        XCTAssertGreaterThanOrEqual(normals.count, 5, "a sliver with an area keeps its true normal; one exactly on a line has none")
        XCTAssertEqual(kept, Self.box().count + normals.count, "every triangle with a normal is written")
        for n in normals {
            XCTAssertEqual(simd_length(n), 1, accuracy: 0.001)
            XCTAssertEqual(simd_reduce_max(simd_abs(n)), 1, accuracy: 0.001, "a flat sliver on the lid faces straight along an axis")
        }
        XCTAssertFalse(Self.notANumber(try String(contentsOf: layer, encoding: .utf8)), "every number written is finite")
        let target = folder.appendingPathComponent("model.f5547c.ar.usdz")
        try PartUSDZ.write(Self.box() + Self.slivers, srgb: [0.96, 0.33, 0.49], to: target)
        XCTAssertTrue(PartUSDZ.isUSDZ(target))
    }

    /// #840, the sweep: no triangle the writer can be handed stops the app. Each odd triangle, alone and beside a real part:
    /// the writer either writes a USDZ whose numbers are all finite or says there is nothing to show.
    func testNoTriangleCanStopTheWriter() throws {
        let folder = try folder()
        let big = Float.greatestFiniteMagnitude, tiny = Float.leastNonzeroMagnitude
        let odd: [String: PartUSDZ.Triangle] = [
            "nan": (SIMD3(.nan, 0, 0), SIMD3(1, 0, 0), SIMD3(0, 1, 0)),
            "infinity": (SIMD3(.infinity, 0, 0), SIMD3(1, 0, 0), SIMD3(0, 1, 0)),
            "largest float": (SIMD3(big, 0, 0), SIMD3(-big, big, 0), SIMD3(0, -big, big)),
            "1e30 mm": (SIMD3(1e30, 0, 0), SIMD3(0, 1e30, 0), SIMD3(0, 0, 1e30)),
            "1e16 mm (past Int64 at 1e6 per metre)": (SIMD3(1e16, 0, 0), SIMD3(0, 1e16, 0), SIMD3(0, 0, 1e16)),
            "subnormal corners": (SIMD3(tiny, 0, 0), SIMD3(0, tiny, 0), SIMD3(0, 0, tiny)),
            "one point": (SIMD3(5, 5, 5), SIMD3(5, 5, 5), SIMD3(5, 5, 5)),
            "a line": (SIMD3(0, 0, 0), SIMD3(1, 1, 1), SIMD3(2, 2, 2)),
            "a sliver at 1e-6 mm": (SIMD3(35, 71, 0), SIMD3(35.5, 71, 1e-6), SIMD3(36, 71, 0)),
            "a sliver at 1e-9 mm": (SIMD3(35, 71, 0), SIMD3(35.5, 71, 1e-9), SIMD3(36, 71, 0)),
            "a speck": (SIMD3(0, 0, 0), SIMD3(1e-20, 0, 0), SIMD3(0, 1e-20, 0)),
        ]
        for (name, triangle) in odd {
            for triangles in [[triangle], Self.box() + [triangle]] {
                let target = folder.appendingPathComponent("\(UUID().uuidString).usdz")
                do {
                    try PartUSDZ.write(triangles, srgb: [0.5, 0.5, 0.5], to: target)
                    XCTAssertTrue(PartUSDZ.isUSDZ(target), name)
                } catch {
                    XCTAssertEqual(error as? PartUSDZ.Failure, .empty, "\(name): \(error)")
                }
                let layer = folder.appendingPathComponent("\(UUID().uuidString).usda")
                if (try? PartUSDZ.usda(triangles, srgb: [.nan, .infinity, -1], to: layer)) ?? 0 > 0 {
                    XCTAssertFalse(Self.notANumber(try String(contentsOf: layer, encoding: .utf8)), "\(name): every number written is finite")
                }
            }
        }
    }

    /// Review R4 on #843: the cleanup deletes only the writer's own scratch names, the current ones and the bare
    /// `ar-<UUID>` crashed builds left; never a served file, a part's AR file, or a near miss.
    func testOnlyTheWritersScratchNamesAreScratch() {
        let id = UUID().uuidString
        for name in ["\(PartUSDZ.scratchPrefix)\(id).usda", "\(PartUSDZ.scratchPrefix)\(id).usdz", "ar-\(id).usda", "ar-\(id).usdz"] {
            XCTAssertTrue(PartUSDZ.isScratch(name), name)
        }
        for name in ["model.neutral.ar.usdz", "v1794096120479-current_model.f5547c.ar.usdz", "ar-\(id).stl", "ar-notauuid.usda",
                     "ar-\(id.dropLast()).usda", "xar-\(id).usda", "ar-\(id)-1.usda", "scan_scan.usdz", "ar-.usda", "\(PartUSDZ.scratchPrefix).usdz"] {
            XCTAssertFalse(PartUSDZ.isScratch(name), name)
        }
    }

    func testNothingToDrawWritesNothing() throws {
        let target = try folder().appendingPathComponent("empty.usdz")
        XCTAssertThrowsError(try PartUSDZ.write([], srgb: [1, 1, 1], to: target))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    }
}
#endif
