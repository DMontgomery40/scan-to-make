import XCTest
import simd
@testable import CounterpartKit

/// #840: whatever bytes arrive as a project's STL, reading them never stops the app. The stage and the part's AR file both
/// read through `STLMesh`; what can't be read is no triangles, and the caller shows nothing or its one sentence.
final class STLMeshTests: XCTestCase {
    typealias Triangle = STLMesh.Triangle

    static func binary(_ triangles: [Triangle], header count: UInt32? = nil, trailing: Int = 0) -> Data {
        var data = Data(count: 80)
        var n = (count ?? UInt32(triangles.count)).littleEndian
        data.append(Data(bytes: &n, count: 4))
        for t in triangles {
            var record = [Float](repeating: 0, count: 3) + [t.0.x, t.0.y, t.0.z, t.1.x, t.1.y, t.1.z, t.2.x, t.2.y, t.2.z]
            record = record.map { Float(bitPattern: $0.bitPattern.littleEndian) }
            record.withUnsafeBytes { data.append(contentsOf: $0) }
            data.append(contentsOf: [0, 0])
        }
        data.append(Data(count: trailing))
        return data
    }

    static let one: Triangle = (SIMD3(0, 0, 0), SIMD3(10, 0, 0), SIMD3(0, 10, 0))
    static let two: Triangle = (SIMD3(0, 0, 5), SIMD3(10, 0, 5), SIMD3(0, 10, 5))

    func testABinaryAndAnASCIISTLRead() {
        XCTAssertEqual(STLMesh.triangles(Self.binary([Self.one, Self.two])).count, 2)
        let ascii = "solid part\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 10 0 0\n   vertex 0 10 0\n  endloop\n endfacet\nendsolid part\n"
        XCTAssertEqual(STLMesh.triangles(Data(ascii.utf8)).count, 1, "a short ASCII STL (under 84 bytes of binary header) still reads")
    }

    /// The sweep: every odd file the Mac could send, or the cache could hold, as a project's STL.
    func testNoBytesStopTheReader() throws {
        let threeMF = Data([0x50, 0x4B, 0x03, 0x04] + [UInt8](repeating: 0x41, count: 600))
        let cases: [(String, Data, Int)] = [
            ("nothing", Data(), 0),
            ("one byte", Data([0x73]), 0),
            ("83 bytes", Data(count: 83), 0),
            ("a header and no triangles", Self.binary([]), 0),
            ("a header saying 4 billion", Self.binary([Self.one], header: .max), 1),
            ("a header saying more than it holds", Self.binary([Self.one, Self.two], header: 9), 2),
            ("a header saying fewer than it holds", Self.binary([Self.one, Self.two], header: 1), 0),
            ("a cut-off last triangle", Self.binary([Self.one, Self.two]).dropLast(7), 1),
            ("trailing bytes", Self.binary([Self.one], trailing: 13), 1),
            ("a 3MF under an STL's name", threeMF, 0),
            ("\"solid\" and nothing else", Data("solid".utf8), 0),
            ("ASCII with words where numbers go", Data("solid x\nvertex a b c\nvertex 1 2\nvertex 1 2 3 4\nendsolid".utf8), 0),
            ("ASCII with two corners", Data("solid x\nvertex 0 0 0\nvertex 1 0 0\nendsolid".utf8), 0),
            ("ASCII with nan and inf", Data("solid x\nvertex nan 0 0\nvertex 1 0 0\nvertex 0 1 0\nvertex inf 0 0\nvertex 1 0 0\nvertex 0 1 0\nendsolid".utf8), 0),
            ("a NaN corner", Self.binary([(SIMD3(.nan, 0, 0), SIMD3(1, 0, 0), SIMD3(0, 1, 0)), Self.one]), 1),
            ("an infinite corner", Self.binary([(SIMD3(.infinity, 0, 0), SIMD3(1, 0, 0), SIMD3(0, 1, 0))]), 0),
            ("random bytes", Data((0..<5_000).map { UInt8(truncatingIfNeeded: $0 &* 2_654_435_761 >> 7) }), 0),
        ]
        for (name, data, expected) in cases {
            let triangles = STLMesh.triangles(data)
            if expected >= 0 { XCTAssertEqual(triangles.count, expected, name) }
            XCTAssertTrue(triangles.allSatisfy { STLMesh.finite($0.0) && STLMesh.finite($0.1) && STLMesh.finite($0.2) }, "\(name): only finite corners")
            #if canImport(ModelIO)
            if #available(iOS 18, macOS 15, *) {
                // And on to the AR file: a USDZ or "nothing to show", never a crash.
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: folder) }
                let target = folder.appendingPathComponent("model.neutral.ar.usdz")
                do { try PartUSDZ.write(triangles, srgb: [0.5, 0.5, 0.5], to: target); XCTAssertTrue(PartUSDZ.isUSDZ(target), name) }
                catch { XCTAssertEqual(error as? PartUSDZ.Failure, .empty, "\(name): \(error)") }
            }
            #endif
        }
    }

    /// Review R1 on #843: a real 3MF (a deflated zip of a sphere's model XML) and a stored-entry zip, under an STL's name,
    /// are no triangles and no AR file: before, the reader salvaged thousands of invented triangles from their bytes.
    func testAZipIsNeverReadAsAnSTL() throws {
        for name in ["stl-reader-deflated.3mf", "stl-reader-stored.zip"] {
            let data = try fixture(name)
            XCTAssertEqual(Array(data.prefix(4)), [0x50, 0x4B, 0x03, 0x04], "\(name) is a real zip")
            XCTAssertEqual(STLMesh.triangles(data).count, 0, name)
            #if canImport(ModelIO)
            if #available(iOS 18, macOS 15, *) {
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: folder) }
                XCTAssertThrowsError(try PartUSDZ.write(STLMesh.triangles(data), srgb: [1, 1, 1], to: folder.appendingPathComponent("x.usdz")), name)
            }
            #endif
        }
        // A real binary STL cut short is still read (a download stopped partway), and never a zip whose header lies.
        let cut = Self.binary([Self.one, Self.two]).dropLast(7)
        XCTAssertEqual(STLMesh.triangles(Data(cut)).count, 1)
    }

    /// The normal the stage and the AR file share: none for a point, a line or a corner that isn't a number.
    func testAFaceNormalIsAUnitVectorOrNone() {
        XCTAssertEqual(STLMesh.faceNormal([0, 0, 0], [1, 0, 0], [0, 1, 0]), [0, 0, 1])
        XCTAssertNil(STLMesh.faceNormal([5, 5, 5], [5, 5, 5], [5, 5, 5]))
        XCTAssertNil(STLMesh.faceNormal([0, 0, 0], [1, 1, 1], [2, 2, 2]))
        XCTAssertNil(STLMesh.faceNormal([.nan, 0, 0], [1, 0, 0], [0, 1, 0]))
        XCTAssertNil(STLMesh.faceNormal([.infinity, 0, 0], [1, 0, 0], [0, 1, 0]))
        XCTAssertEqual(STLMesh.faceNormal([0, 0, 0], [1e-20, 0, 0], [0, 1e-20, 0]), [0, 0, 1], "a speck still faces its way")
        let big = Float.greatestFiniteMagnitude
        XCTAssertNotNil(STLMesh.faceNormal([big, 0, 0], [-big, big, 0], [0, -big, big]), "worked in Double, the largest floats don't overflow")
    }
}
