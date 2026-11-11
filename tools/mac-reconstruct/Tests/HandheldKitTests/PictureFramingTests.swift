import XCTest
import AppKit
import CoreGraphics
import simd
@testable import HandheldKit

final class PictureFramingTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("picture-framing-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    // MARK: - Synthetic 3MF Helpers

    private func boxObject(
        id: Int,
        name: String,
        lo: SIMD3<Double>,
        hi: SIMD3<Double>,
        transform: simd_double4x4 = matrix_identity_double4x4
    ) -> String {
        let corners: [SIMD3<Double>] = [
            SIMD3(lo.x, lo.y, lo.z), SIMD3(hi.x, lo.y, lo.z), SIMD3(hi.x, hi.y, lo.z), SIMD3(lo.x, hi.y, lo.z),
            SIMD3(lo.x, lo.y, hi.z), SIMD3(hi.x, lo.y, hi.z), SIMD3(hi.x, hi.y, hi.z), SIMD3(lo.x, hi.y, hi.z)
        ].map { p in
            let q = transform * SIMD4<Double>(p.x, p.y, p.z, 1.0)
            return SIMD3<Double>(q.x, q.y, q.z)
        }
        let verts = corners.map { String(format: "<vertex x=\"%.4f\" y=\"%.4f\" z=\"%.4f\"/>", $0.x, $0.y, $0.z) }.joined()
        let tris = [
            (0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
            (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5),
            (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)
        ].map { "<triangle v1=\"\($0.0)\" v2=\"\($0.1)\" v3=\"\($0.2)\"/>" }.joined()
        return "<object id=\"\(id)\" name=\"\(name)\" type=\"model\"><mesh><vertices>\(verts)</vertices><triangles>\(tris)</triangles></mesh></object>"
    }

    private func writeThreeMF(_ name: String, objectsXML: String, buildIds: [Int]) throws -> URL {
        let root = folder.appendingPathComponent(name + "-pkg")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("3D"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("_rels"), withIntermediateDirectories: true)
        let contentTypes = "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/></Types>"
        let rels = "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Target=\"/3D/3dmodel.model\" Id=\"rel0\" Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\"/></Relationships>"
        let items = buildIds.map { "<item objectid=\"\($0)\"/>" }.joined()
        let model = "<?xml version=\"1.0\"?><model unit=\"millimeter\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\"><resources>\(objectsXML)</resources><build>\(items)</build></model>"
        try contentTypes.write(to: root.appendingPathComponent("[Content_Types].xml"), atomically: true, encoding: .utf8)
        try rels.write(to: root.appendingPathComponent("_rels/.rels"), atomically: true, encoding: .utf8)
        try model.write(to: root.appendingPathComponent("3D/3dmodel.model"), atomically: true, encoding: .utf8)

        let out = folder.appendingPathComponent(name + ".3mf")
        let zip = Process()
        zip.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
        zip.currentDirectoryURL = root
        zip.arguments = ["-qr", out.path, "."]
        try zip.run()
        zip.waitUntilExit()
        XCTAssertEqual(zip.terminationStatus, 0)
        return out
    }

    private struct SilhouetteMetrics {
        var fill: Double
        var widthFraction: Double
        var heightFraction: Double
        var centerX: Double
        var centerY: Double
        var areaFraction: Double
    }

    private func measureSilhouette(pictureURL: URL, size: Int, lightStage: Bool, diffThreshold: Int = 14) throws -> SilhouetteMetrics {
        let cg = try XCTUnwrap(NSImage(contentsOf: pictureURL)?.cgImage(forProposedRect: nil, context: nil, hints: nil))
        XCTAssertEqual(cg.width, size)
        XCTAssertEqual(cg.height, size)

        var fg = [UInt8](repeating: 0, count: size * size * 4)
        let fgCtx = try XCTUnwrap(CGContext(data: &fg, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
                                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        fgCtx.draw(cg, in: CGRect(x: 0, y: 0, width: size, height: size))

        let stageCtx = try XCTUnwrap(stage(size, light: lightStage))
        let stageCG = try XCTUnwrap(stageCtx.makeImage())
        var bg = [UInt8](repeating: 0, count: size * size * 4)
        let bgCtx = try XCTUnwrap(CGContext(data: &bg, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
                                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        bgCtx.draw(stageCG, in: CGRect(x: 0, y: 0, width: size, height: size))

        var minX = size, maxX = -1, minY = size, maxY = -1
        var count = 0
        for y in 0..<size {
            for x in 0..<size {
                let o = (y * size + x) * 4
                let dr = abs(Int(fg[o]) - Int(bg[o]))
                let dg = abs(Int(fg[o + 1]) - Int(bg[o + 1]))
                let db = abs(Int(fg[o + 2]) - Int(bg[o + 2]))
                if max(dr, max(dg, db)) >= diffThreshold {
                    if x < minX { minX = x }
                    if x > maxX { maxX = x }
                    if y < minY { minY = y }
                    if y > maxY { maxY = y }
                    count += 1
                }
            }
        }
        guard maxX >= minX, maxY >= minY else {
            return SilhouetteMetrics(fill: 0, widthFraction: 0, heightFraction: 0, centerX: 0, centerY: 0, areaFraction: 0)
        }
        let wf = Double(maxX - minX + 1) / Double(size)
        let hf = Double(maxY - minY + 1) / Double(size)
        let cx = (Double(minX + maxX) * 0.5 + 0.5) / Double(size)
        let cy = (Double(minY + maxY) * 0.5 + 0.5) / Double(size)
        let af = Double(count) / Double(size * size)
        return SilhouetteMetrics(fill: max(wf, hf), widthFraction: wf, heightFraction: hf, centerX: cx, centerY: cy, areaFraction: af)
    }

    // MARK: - Tests

    /// Outline fills 78–86% of the frame and is centred within 3% across flat, tall, L-shaped, and multi-object plate shapes.
    func testOutlineFills78To86PercentAndStaysCentredWithin3PercentAcrossShapes() throws {
        let flat = try writeThreeMF(
            "flat",
            objectsXML: boxObject(id: 1, name: "base", lo: SIMD3(-60, -45, 0), hi: SIMD3(60, 45, 8)) +
                        boxObject(id: 2, name: "rim", lo: SIMD3(-60, 35, 8), hi: SIMD3(60, 45, 16)),
            buildIds: [1, 2]
        )
        let tall = try writeThreeMF(
            "tall",
            objectsXML: boxObject(id: 1, name: "tower", lo: SIMD3(80, -50, 0), hi: SIMD3(106, -24, 112)),
            buildIds: [1]
        )
        let lShape = try writeThreeMF(
            "l-shape",
            objectsXML: boxObject(id: 1, name: "arm", lo: SIMD3(0, 0, 0), hi: SIMD3(95, 28, 22)) +
                        boxObject(id: 2, name: "leg", lo: SIMD3(0, 0, 0), hi: SIMD3(26, 75, 68)),
            buildIds: [1, 2]
        )
        let multiPlate = try writeThreeMF(
            "plate",
            objectsXML: boxObject(id: 1, name: "holder", lo: SIMD3(75, 145, 0), hi: SIMD3(175, 180, 62)) +
                        boxObject(id: 2, name: "ring-1", lo: SIMD3(12, 72, 0), hi: SIMD3(82, 106, 10)) +
                        boxObject(id: 3, name: "ring-2", lo: SIMD3(92, 72, 0), hi: SIMD3(162, 106, 10)) +
                        boxObject(id: 4, name: "ring-3", lo: SIMD3(172, 72, 0), hi: SIMD3(242, 106, 10)),
            buildIds: [1, 2, 3, 4]
        )

        let cases: [(String, URL, Bool, NSColor?)] = [
            ("flat-dark", flat, false, nil),
            ("flat-light", flat, true, NSColor(srgbRed: 0.08, green: 0.08, blue: 0.09, alpha: 1)),
            ("tall-dark", tall, false, nil),
            ("l-shape-dark", lShape, false, NSColor(srgbRed: 0.95, green: 0.33, blue: 0.49, alpha: 1)),
            ("l-shape-light", lShape, true, nil),
            ("plate-dark", multiPlate, false, nil),
            ("plate-light", multiPlate, true, NSColor(srgbRed: 0.36, green: 0.40, blue: 0.48, alpha: 1))
        ]

        let px = 360
        for (label, url, useLight, tint) in cases {
            let out = folder.appendingPathComponent("\(label).png")
            var spec = PictureSpec()
            spec.model = url
            spec.zUp = true
            spec.tint = tint
            spec.lightStage = useLight
            spec.pixels = px
            try renderPicture(spec, to: out)

            let m = try measureSilhouette(pictureURL: out, size: px, lightStage: useLight)
            XCTAssertGreaterThanOrEqual(m.fill, 0.78, "\(label) fill \(m.fill) < 0.78")
            XCTAssertLessThanOrEqual(m.fill, 0.86, "\(label) fill \(m.fill) > 0.86")
            XCTAssertLessThanOrEqual(abs(m.centerX - 0.5), 0.03, "\(label) centerX \(m.centerX) off centre")
            XCTAssertLessThanOrEqual(abs(m.centerY - 0.5), 0.03, "\(label) centerY \(m.centerY) off centre")
        }
    }

    /// A thin flat part (0.7 mm pick/sheet) is never drawn edge-on whether lying flat, standing on edge, or tilted in 3D.
    func testThinFlatPartIsNeverEdgeOn() throws {
        let flatSheet = try writeThreeMF(
            "thin-flat",
            objectsXML: boxObject(id: 1, name: "pick-flat", lo: SIMD3(-17, -15, 0), hi: SIMD3(17, 15, 0.7)),
            buildIds: [1]
        )
        let verticalSheet = try writeThreeMF(
            "thin-vertical",
            objectsXML: boxObject(id: 1, name: "pick-vert", lo: SIMD3(-17, -0.35, 0), hi: SIMD3(17, 0.35, 30)),
            buildIds: [1]
        )
        let q = simd_quatd(angle: 42.0 * .pi / 180.0, axis: simd_normalize(SIMD3<Double>(0.7, 0.5, 0.3)))
        let rot = simd_double4x4(q)
        let tiltedSheet = try writeThreeMF(
            "thin-tilted",
            objectsXML: boxObject(id: 1, name: "pick-tilt", lo: SIMD3(-17, -15, -0.35), hi: SIMD3(17, 15, 0.35), transform: rot),
            buildIds: [1]
        )

        let px = 320
        for (label, url) in [("flat", flatSheet), ("vertical", verticalSheet), ("tilted", tiltedSheet)] {
            let out = folder.appendingPathComponent("thin-\(label).png")
            var spec = PictureSpec()
            spec.model = url
            spec.zUp = true
            spec.tint = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 1) // #000000 black PLA guitar pick
            spec.pixels = px
            try renderPicture(spec, to: out)

            let m = try measureSilhouette(pictureURL: out, size: px, lightStage: true)
            XCTAssertGreaterThanOrEqual(m.fill, 0.78, "\(label) fill \(m.fill)")
            XCTAssertLessThanOrEqual(m.fill, 0.86, "\(label) fill \(m.fill)")
            XCTAssertGreaterThan(min(m.widthFraction, m.heightFraction), 0.38, "\(label) minor projection \(min(m.widthFraction, m.heightFraction)) would be edge-on")
            XCTAssertGreaterThan(m.areaFraction, 0.22, "\(label) visible face area \(m.areaFraction) shows broadside face, never edge-on")
        }
    }

    /// A black spool and even an older explicit light-stage request never turn the picture pale.
    func testDarkFilamentAndLegacyLightRequestKeepTheStageDark() throws {
        let model = try writeThreeMF("always-dark", objectsXML: boxObject(id: 1, name: "part",
            lo: SIMD3(0, 0, 0), hi: SIMD3(40, 30, 20)), buildIds: [1])
        XCTAssertFalse(wantsLightStage(.black))
        for requested in [Optional<Bool>.none, false, true] {
            var spec = PictureSpec()
            spec.model = model; spec.zUp = true; spec.tint = .black; spec.lightStage = requested; spec.pixels = 128
            let out = folder.appendingPathComponent("dark-\(String(describing: requested)).png")
            try renderPicture(spec, to: out)
            let cg = try XCTUnwrap(NSImage(contentsOf: out)?.cgImage(forProposedRect: nil, context: nil, hints: nil))
            var bytes = [UInt8](repeating: 0, count: 128 * 128 * 4)
            let context = try XCTUnwrap(CGContext(data: &bytes, width: 128, height: 128, bitsPerComponent: 8, bytesPerRow: 128 * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(cg, in: CGRect(x: 0, y: 0, width: 128, height: 128))
            XCTAssertLessThan(bytes[0], 64, "red backdrop stays dark")
            XCTAssertLessThan(bytes[1], 64, "green backdrop stays dark")
            XCTAssertLessThan(bytes[2], 64, "blue backdrop stays dark")
        }
    }

    /// Rendering the same file twice produces byte-for-byte identical PNG output so companion picture hashes stay stable.
    func testDeterministicByteForByteOutput() throws {
        let model = try writeThreeMF(
            "det",
            objectsXML: boxObject(id: 1, name: "a", lo: SIMD3(0, 0, 0), hi: SIMD3(40, 30, 25)) +
                        boxObject(id: 2, name: "b", lo: SIMD3(55, 5, 0), hi: SIMD3(85, 35, 12)),
            buildIds: [1, 2]
        )
        let outA = folder.appendingPathComponent("a.png")
        let outB = folder.appendingPathComponent("b.png")
        var spec = PictureSpec()
        spec.model = model
        spec.zUp = true
        spec.pixels = 360
        try renderPicture(spec, to: outA)
        try renderPicture(spec, to: outB)
        XCTAssertEqual(try Data(contentsOf: outA), try Data(contentsOf: outB))
    }

    /// High-polygon multi-part 3MF stays fast and well within the time bound.
    func testHighPolygonMultiMeshRendersWithinTimeBound() throws {
        // Build a 60x60 grid sphere/dome mesh (~7,200 tris) placed 10 times = 72,000 placed triangles.
        let nx = 60, ny = 60
        var vXML = String()
        vXML.reserveCapacity((nx + 1) * (ny + 1) * 44)
        for iy in 0...ny {
            for ix in 0...nx {
                let x = Double(ix) * 0.5
                let y = Double(iy) * 0.5
                let z = 4.0 * sin(Double(ix) * 0.15) * cos(Double(iy) * 0.15) + 5.0
                vXML += String(format: "<vertex x=\"%.2f\" y=\"%.2f\" z=\"%.2f\"/>", x, y, z)
            }
        }
        var tXML = String()
        tXML.reserveCapacity(nx * ny * 2 * 42)
        for iy in 0..<ny {
            for ix in 0..<nx {
                let v0 = iy * (nx + 1) + ix
                let v1 = v0 + 1
                let v2 = v0 + (nx + 1)
                let v3 = v2 + 1
                tXML += "<triangle v1=\"\(v0)\" v2=\"\(v1)\" v3=\"\(v3)\"/><triangle v1=\"\(v0)\" v2=\"\(v3)\" v3=\"\(v2)\"/>"
            }
        }
        // Close bottom + sides simply so bounds are crisp; placed 10 times in build.
        let obj = "<object id=\"1\" name=\"patch\" type=\"model\"><mesh><vertices>\(vXML)</vertices><triangles>\(tXML)</triangles></mesh></object>"
        var buildItems = ""
        for k in 0..<10 {
            let tx = Double(k % 5) * 36.0
            let ty = Double(k / 5) * 36.0
            buildItems += "<item objectid=\"1\" transform=\"1 0 0 0 1 0 0 0 1 \(tx) \(ty) 0\"/>"
        }
        let root = folder.appendingPathComponent("perf-pkg")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("3D"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("_rels"), withIntermediateDirectories: true)
        try "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/></Types>"
            .write(to: root.appendingPathComponent("[Content_Types].xml"), atomically: true, encoding: .utf8)
        try "<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Target=\"/3D/3dmodel.model\" Id=\"rel0\" Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\"/></Relationships>"
            .write(to: root.appendingPathComponent("_rels/.rels"), atomically: true, encoding: .utf8)
        try "<?xml version=\"1.0\"?><model unit=\"millimeter\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\"><resources>\(obj)</resources><build>\(buildItems)</build></model>"
            .write(to: root.appendingPathComponent("3D/3dmodel.model"), atomically: true, encoding: .utf8)
        let modelURL = folder.appendingPathComponent("perf.3mf")
        let zip = Process()
        zip.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
        zip.currentDirectoryURL = root
        zip.arguments = ["-qr", modelURL.path, "."]
        try zip.run()
        zip.waitUntilExit()

        let out = folder.appendingPathComponent("perf.png")
        var spec = PictureSpec()
        spec.model = modelURL
        spec.zUp = true
        spec.pixels = 720
        let t0 = CFAbsoluteTimeGetCurrent()
        try renderPicture(spec, to: out)
        let elapsed = CFAbsoluteTimeGetCurrent() - t0
        XCTAssertLessThan(elapsed, 4.0, "72k-triangle multi-part 3MF rendered in \(elapsed)s")
    }
}
