import XCTest
import AppKit
import simd
@testable import HandheldKit

/// Nov 10: a 3MF with four objects (the bottle holder and three fit rings, `e4d404f2`) had no picture, and David couldn't
/// tell what the project was. The 3MF standard alone draws it: objects, components in other parts, transforms, units
/// and the colours the materials extension gives.
final class ThreeMFTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("threemf-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: folder) }

    /// A box mesh `size` millimetres a side, with its lowest corner at `origin`.
    private func box(_ id: Int, _ name: String, origin: (Double, Double, Double) = (0, 0, 0), size: Double = 10, extra: String = "") -> String {
        let (x, y, z) = origin
        let v = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
            .map { "<vertex x=\"\(x + Double($0.0) * size)\" y=\"\(y + Double($0.1) * size)\" z=\"\(z + Double($0.2) * size)\"/>" }.joined()
        let t = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
            .map { "<triangle v1=\"\($0.0)\" v2=\"\($0.1)\" v3=\"\($0.2)\"/>" }.joined()
        return "<object id=\"\(id)\" name=\"\(name)\" type=\"model\" \(extra)><mesh><vertices>\(v)</vertices><triangles>\(t)</triangles></mesh></object>"
    }

    /// A 3MF package from its parts, zipped by the system's `zip` as any 3MF tool would.
    private func package(_ name: String, _ parts: [String: String]) throws -> URL {
        let root = folder.appendingPathComponent(name + "-parts")
        var all = parts
        all["[Content_Types].xml"] = "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/></Types>"
        all["_rels/.rels"] = all["_rels/.rels"] ?? "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Target=\"/3D/3dmodel.model\" Id=\"rel0\" Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\"/></Relationships>"
        for (path, text) in all {
            let file = root.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try text.write(to: file, atomically: true, encoding: .utf8)
        }
        let out = folder.appendingPathComponent(name + ".3mf")
        let zip = Process()
        zip.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
        zip.currentDirectoryURL = root
        zip.arguments = ["-qr", out.path, "."]
        try zip.run(); zip.waitUntilExit()
        XCTAssertEqual(zip.terminationStatus, 0)
        return out
    }

    private func model(_ resources: String, build: String, unit: String = "millimeter", extra: String = "") -> String {
        "<?xml version=\"1.0\"?><model unit=\"\(unit)\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\" \(extra)><resources>\(resources)</resources><build>\(build)</build></model>"
    }

    private func bounds(_ model: ThreeMF) -> (SIMD3<Float>, SIMD3<Float>) {
        let all = model.meshes.flatMap(\.positions)
        return (all.reduce(SIMD3(repeating: .infinity)) { simd_min($0, $1) }, all.reduce(SIMD3(repeating: -.infinity)) { simd_max($0, $1) })
    }

    /// The shape of the code engine's test plates: several named objects, each a build item, no metadata at all.
    func testEveryObjectOnAPlainMultiObjectPlateIsDrawn() throws {
        let url = try package("plain", ["3D/3dmodel.model": model(
            box(1, "holder", size: 40) + box(2, "ring-1", origin: (50, 0, 0)) + box(3, "ring-2", origin: (70, 0, 0)) + box(4, "ring-3", origin: (90, 0, 0)),
            build: "<item objectid=\"1\"/><item objectid=\"2\"/><item objectid=\"3\"/><item objectid=\"4\"/>")])
        let read = try ThreeMF.read(url)
        XCTAssertEqual(read.meshes.map(\.name), ["holder", "ring-1", "ring-2", "ring-3"])
        XCTAssertEqual(read.meshes.map(\.triangles.count), [12, 12, 12, 12])
        let (low, high) = bounds(read)
        XCTAssertEqual(low, SIMD3(0, 0, 0)); XCTAssertEqual(high, SIMD3(100, 40, 40))
        XCTAssertTrue(read.meshes.allSatisfy { $0.colours.allSatisfy { $0 == nil } }, "no colours in the file: none invented")
        // Drawn on the stage: something other than the stage's own gradient in the middle of the picture.
        let picture = folder.appendingPathComponent("plain.png")
        var spec = PictureSpec(); spec.model = url; spec.zUp = true; spec.pixels = 256
        try renderPicture(spec, to: picture)
        let image = try XCTUnwrap(NSImage(contentsOf: picture)?.cgImage(forProposedRect: nil, context: nil, hints: nil))
        XCTAssertEqual(image.width, 256)
        XCTAssertGreaterThan(try drawnPixels(image), 1500, "the objects are drawn, not an empty stage")
    }

    /// Components kept in another model part (production extension), placed by transforms, in centimetres, with the
    /// colours the materials extension gives (an object's default and a triangle's own).
    func testComponentsInOtherPartsTransformsUnitsAndColoursFollowTheStandard() throws {
        let parts = model(
            "<basematerials id=\"9\"><base name=\"red\" displaycolor=\"#FF0000\"/><base name=\"blue\" displaycolor=\"#0000FFFF\"/></basematerials>"
            + box(1, "body", size: 1, extra: "pid=\"9\" pindex=\"0\""),
            build: "", unit: "centimeter")
        let root = model(
            "<object id=\"5\" name=\"assembly\" type=\"model\"><components>"
            + "<component objectid=\"1\" p:path=\"/3D/Objects/parts.model\" transform=\"1 0 0 0 1 0 0 0 1 0 0 0\"/>"
            + "<component objectid=\"1\" p:path=\"/3D/Objects/parts.model\" transform=\"1 0 0 0 1 0 0 0 1 20 0 0\"/>"
            + "</components></object>",
            build: "<item objectid=\"5\" transform=\"1 0 0 0 1 0 0 0 1 100 50 0\"/>",
            extra: "xmlns:p=\"http://schemas.microsoft.com/3dmanufacturing/production/2015/06\"")
        let url = try package("parts", ["3D/3dmodel.model": root, "3D/Objects/parts.model": parts])
        let read = try ThreeMF.read(url)
        XCTAssertEqual(read.meshes.count, 2, "the component twice, from its own part")
        let (low, high) = bounds(read)
        // A 1 cm box (its part's own units), placed at 0 and 20 mm (a component moves in the units of the model that places
        // it), the whole moved by (100, 50) mm.
        XCTAssertEqual(low, SIMD3(100, 50, 0)); XCTAssertEqual(high, SIMD3(130, 60, 10))
        XCTAssertEqual(read.meshes[0].colours.first ?? nil, SIMD4(1, 0, 0, 1), "the object's default colour")
    }

    func testATriangleColourGroupAndABrokenFileAreHandled() throws {
        let coloured = box(1, "two-tone").replacingOccurrences(of: "<triangle v1=\"0\" v2=\"2\" v3=\"1\"/>", with: "<triangle v1=\"0\" v2=\"2\" v3=\"1\" pid=\"7\" p1=\"0\"/>")
        let url = try package("group", ["3D/3dmodel.model": model(
            "<m:colorgroup id=\"7\"><m:color color=\"#00FF00\"/></m:colorgroup>" + coloured, build: "<item objectid=\"1\"/>",
            extra: "xmlns:m=\"http://schemas.microsoft.com/3dmanufacturing/material/2015/02\"")])
        let read = try ThreeMF.read(url)
        XCTAssertEqual(read.meshes[0].colours[0], SIMD4(0, 1, 0, 1))
        XCTAssertNil(read.meshes[0].colours[1] ?? nil, "the other triangles: the spool's colour or neutral")
        let empty = try package("empty", ["3D/3dmodel.model": model(box(1, "unplaced"), build: "")])
        XCTAssertThrowsError(try ThreeMF.read(empty), "nothing in the build: nothing to draw")
        let notZip = folder.appendingPathComponent("not.3mf")
        try Data("not a zip".utf8).write(to: notZip)
        XCTAssertThrowsError(try ThreeMF.read(notZip))
    }

    /// Pixels clearly off the stage's gradient (the stage is dark grey-blue; a drawn part is lit grey).
    private func drawnPixels(_ image: CGImage) throws -> Int {
        let width = image.width, height = image.height
        var data = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(data: &data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return stride(from: 0, to: data.count, by: 4).filter { Int(data[$0]) + Int(data[$0 + 1]) + Int(data[$0 + 2]) > 3 * 90 }.count
    }
}
