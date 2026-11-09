import XCTest
import CoreGraphics
import ModelIO
import AppKit
@testable import HandheldKit

final class HandheldKitTests: XCTestCase {
    /// A synthetic photo keeps its depth in metres and its focal length, and loads with no gravity.
    func testPhotoDepthRoundTrip() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("handheldkit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let w = 64, h = 48
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.6, green: 0.4, blue: 0.2, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        var metres = [Float](repeating: 0.8, count: 32 * 24)
        for y in 8..<16 { for x in 10..<22 { metres[y * 32 + x] = 0.25 } }
        let url = dir.appendingPathComponent("0000.heic")
        try writePhoto(ctx.makeImage()!, depth: DepthImage(width: 32, height: 24, metres: metres),
                       camera: PhotoCamera(focalPixels: 50), to: url)

        let depth = try XCTUnwrap(embeddedDepth(in: url))
        XCTAssertEqual(depth.width, 32); XCTAssertEqual(depth.height, 24)
        XCTAssertEqual(depth.metres[12 * 32 + 15], 0.25, accuracy: 0.001)
        XCTAssertEqual(depth.metres[0], 0.8, accuracy: 0.001)

        let sample = try loadSample(url)
        XCTAssertNil(sample.gravity)
        XCTAssertNotNil(sample.depthDataMap)
        let exif = try XCTUnwrap(sample.metadata["{Exif}"] as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(exif["FocalLength"] as? Double), 50 * 9.30 / 64, accuracy: 0.01)
    }

    /// A mirrored photo set would rebuild a mirror-image part: the samples mode refuses mirrored orientations.
    func testMirroredOrientations() throws {
        XCTAssertEqual((1...8).filter { isMirrored(orientation: $0) }, [2, 4, 5, 7])
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("handheldkit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let ctx = CGContext(data: nil, width: 8, height: 6, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        for tag in [1, 5, 6] {
            let url = dir.appendingPathComponent("\(tag).heic")
            try writePhoto(ctx.makeImage()!, depth: nil, camera: PhotoCamera(focalPixels: 6, orientation: UInt32(tag)), to: url)
            XCTAssertEqual(orientation(of: try loadSample(url)), tag)
        }
    }

    func testMaskHelpers() {
        var mask = GrayImage(width: 20, height: 10)
        for y in 2..<8 { for x in 2..<8 { mask[x, y] = 255 } }       // big blob
        mask[15, 5] = 255                                               // speck
        XCTAssertEqual(mask.components().count, 2)
        XCTAssertEqual(mask.keepingComponent(containing: nil).onCount, 36)
        XCTAssertEqual(mask.keepingComponent(containing: (15, 5)).onCount, 1)
        let deepest = mask.deepestInteriorPoint()!
        XCTAssertTrue((4...5).contains(deepest.x) && (4...5).contains(deepest.y))
        XCTAssertEqual(mask.dilated(by: 1).onCount, 8 * 8 + 9)
        let box = mask.keepingComponent(containing: nil).bounds(scaledTo: (20, 10), grownBy: 0)!
        XCTAssertEqual(box.minX, 0.1, accuracy: 1e-9); XCTAssertEqual(box.width, 0.3, accuracy: 1e-9)
    }

    func testCorruptExactDepthCannotSilentlyFallBackToEmbeddedDepth() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let image = dir.appendingPathComponent("0000.heic")
        XCTAssertNil(try exactDepth(for: image))
        let ctx = CGContext(data: nil, width: 64, height: 48, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(gray: 0.5, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
        try writePhoto(ctx.makeImage()!, depth: DepthImage(width: 32, height: 24, metres: Array(repeating: 0.4, count: 32 * 24)),
                       camera: PhotoCamera(focalPixels: 50), to: image)
        XCTAssertNotNil(try loadSample(image).depthDataMap)
        let invalid = try PropertyListSerialization.data(fromPropertyList: ["schemaVersion": 0], format: .binary, options: 0)
        try invalid.write(to: dir.appendingPathComponent("0000.depth.plist"))
        XCTAssertThrowsError(try exactDepth(for: image))
        XCTAssertThrowsError(try loadSample(image))
    }

    /// A triangle with an index outside the mesh is dropped whole; the triangles after it keep their own corners.
    func testABadIndexDropsItsWholeTriangleOnly() {
        XCTAssertEqual(wholeTriangles([0, 1, 2, 3, 9, 4, 4, 5, 6, 7], vertexCount: 8), [[0, 1, 2], [4, 5, 6]])
        XCTAssertEqual(wholeTriangles([0, 1], vertexCount: 8), [])
        XCTAssertEqual(wholeTriangles([0, 1, -1], vertexCount: 8), [])
    }

    /// A Y-up model in metres becomes the STL a project keeps: millimetres, Z up, centred, resting on z = 0.
    func testSTLIsInMillimetresWithEveryTriangle() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("handheldkit-stl-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        // A box 40 wide, 20 tall (Y up) and 10 deep, in metres the way PhotogrammetrySession writes, moved off the origin.
        let box = MDLMesh(boxWithExtent: [0.04, 0.02, 0.01], segments: [1, 1, 1], inwardNormals: false,
                          geometryType: .triangles, allocator: nil)
        box.transform = MDLTransform(matrix: matrix_float4x4(columns: ([1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0.5, 0.3, -0.2, 1])))
        let asset = MDLAsset(); asset.add(box)
        let model = dir.appendingPathComponent("box.obj")
        try asset.export(to: model)
        let stl = dir.appendingPathComponent("box.stl")
        let summary = try writeSTL(model: model, to: stl)
        XCTAssertEqual(summary.triangles, 12)
        XCTAssertEqual(summary.sizeMm.x, 40, accuracy: 0.01)
        XCTAssertEqual(summary.sizeMm.y, 10, accuracy: 0.01)
        XCTAssertEqual(summary.sizeMm.z, 20, accuracy: 0.01, "its height is on Z, as a slicer expects")
        let bytes = try Data(contentsOf: stl)
        XCTAssertEqual(bytes.count, 84 + 12 * 50)
        XCTAssertEqual(bytes.subdata(in: 80..<84).withUnsafeBytes { $0.load(as: UInt32.self) }, 12)
        var low = SIMD3<Float>(repeating: .infinity), high = SIMD3<Float>(repeating: -.infinity)
        for t in 0..<12 { for k in 0..<3 {
            let p = bytes.subdata(in: (84 + t * 50 + 12 + k * 12)..<(84 + t * 50 + 24 + k * 12)).withUnsafeBytes { SIMD3($0.load(fromByteOffset: 0, as: Float.self), $0.load(fromByteOffset: 4, as: Float.self), $0.load(fromByteOffset: 8, as: Float.self)) }
            low = simd_min(low, p); high = simd_max(high, p)
        } }
        XCTAssertEqual(low.z, 0, accuracy: 0.001, "it rests on the bed")
        XCTAssertEqual(low.x + high.x, 0, accuracy: 0.001); XCTAssertEqual(low.y + high.y, 0, accuracy: 0.001)
        // Faces still point outwards after the turn: the first facet's stored normal agrees with its winding.
        let floats = bytes.subdata(in: 84..<132).withUnsafeBytes { raw in (0..<12).map { raw.load(fromByteOffset: $0 * 4, as: Float.self) } }
        let n = SIMD3(floats[0], floats[1], floats[2]), a = SIMD3(floats[3], floats[4], floats[5])
        let b = SIMD3(floats[6], floats[7], floats[8]), c = SIMD3(floats[9], floats[10], floats[11])
        let centre = (a + b + c) / 3
        XCTAssertGreaterThan(simd_dot(n, centre - SIMD3(0, 0, 10)), 0, "the normal points away from the box's centre")
        XCTAssertThrowsError(try writeSTL(model: dir.appendingPathComponent("missing.usdz"), to: dir.appendingPathComponent("x.stl")))

        // The project page's picture of it: drawn, not just the stage's background.
        let picture = dir.appendingPathComponent("overview.png")
        try renderOverview(model: model, to: picture, pixels: 300)
        let image = try XCTUnwrap(NSBitmapImageRep(data: try Data(contentsOf: picture)))
        XCTAssertEqual(image.pixelsWide, 300)
        let corner = image.colorAt(x: 2, y: 2)!, middle = image.colorAt(x: 150, y: 150)!
        XCTAssertGreaterThan(abs(middle.brightnessComponent - corner.brightnessComponent), 0.05, "the box shows on the stage")
    }

    // MARK: Removing what it stood on (SupportCut)

    /// A box from `low` to `high`, each face split into squares of about `step` mm, corners shared, outward winding.
    private func box(_ low: SIMD3<Float>, _ high: SIMD3<Float>, step: Float = 5) -> [SIMD3<Float>] {
        var out: [SIMD3<Float>] = []
        func grid(_ origin: SIMD3<Float>, _ u: SIMD3<Float>, _ v: SIMD3<Float>) {
            let nu = max(1, Int((simd_length(u) / step).rounded(.up))), nv = max(1, Int((simd_length(v) / step).rounded(.up)))
            func p(_ i: Int, _ j: Int) -> SIMD3<Float> { origin + u * Float(i) / Float(nu) + v * Float(j) / Float(nv) }
            for i in 0..<nu { for j in 0..<nv { out += [p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j), p(i + 1, j + 1), p(i, j + 1)] } }
        }
        let d = high - low
        let x = SIMD3<Float>(d.x, 0, 0), y = SIMD3<Float>(0, d.y, 0), z = SIMD3<Float>(0, 0, d.z)
        grid(low, y, x); grid(low + z, x, y)                     // bottom (down), top (up)
        grid(low, x, z); grid(low + y, z, x)                     // front, back
        grid(low, z, y); grid(low + x, y, z)                     // left, right
        return out
    }

    /// A flat round plate: top and bottom fans in rings about `step` mm apart, and its rim.
    private func disc(radius: Float, top: Float, thickness: Float, step: Float = 5, segments: Int = 72) -> [SIMD3<Float>] {
        var out: [SIMD3<Float>] = []
        let rings = max(1, Int((radius / step).rounded(.up)))
        func p(_ ring: Int, _ k: Int, _ z: Float) -> SIMD3<Float> {
            let r = radius * Float(ring) / Float(rings), a = Float(k % segments) / Float(segments) * 2 * .pi
            return SIMD3(r * cos(a), r * sin(a), z)
        }
        for (z, up) in [(top, true), (top - thickness, false)] {
            for ring in 0..<rings { for k in 0..<segments {
                let a = p(ring, k, z), b = p(ring + 1, k, z), c = p(ring + 1, k + 1, z), d = p(ring, k + 1, z)
                out += up ? [a, b, c, a, c, d] : [a, c, b, a, d, c]
            } }
        }
        for k in 0..<segments {
            let a = p(rings, k, top - thickness), b = p(rings, k + 1, top - thickness), c = p(rings, k + 1, top), d = p(rings, k, top)
            out += [a, b, c, a, c, d]
        }
        return out
    }

    private func size(_ corners: [SIMD3<Float>]) -> SIMD3<Float> {
        corners.reduce(SIMD3<Float>(repeating: -.infinity), simd_max) - corners.reduce(SIMD3<Float>(repeating: .infinity), simd_min)
    }

    /// Tilted a few degrees, as a scan's up rarely matches the surface exactly.
    private func tilted(_ corners: [SIMD3<Float>], degrees: Float = 3) -> [SIMD3<Float>] {
        let turn = simd_quatf(angle: degrees * .pi / 180, axis: simd_normalize(SIMD3<Float>(1, 0.4, 0)))
        return corners.map { turn.act($0) }
    }

    /// An object (60 × 30 × 40 mm) on a plain flat table: the table goes, the object stays, standing on z = 0.
    func testTheTableItStoodOnIsRemoved() throws {
        let object = box(SIMD3(-30, -15, 0), SIMD3(30, 15, 40))
        let table = box(SIMD3(-150, -150, -18), SIMD3(150, 150, 0), step: 10)
        let cut = try XCTUnwrap(removeSupport(tilted(object + table)))
        let s = size(cut.corners)
        XCTAssertEqual(s.x, 60, accuracy: 1.5); XCTAssertEqual(s.y, 30, accuracy: 1.5)
        XCTAssertEqual(s.z, 39.5, accuracy: 0.6, "cut 0.5 mm above the table")
        XCTAssertEqual(cut.cut.tiltDegrees, 3, accuracy: 0.5)
        XCTAssertEqual(cut.corners.map(\.z).min() ?? -1, 0, accuracy: 0.01, "stands on z = 0")
    }

    /// The same object on a round plate (any platform): the plate goes.
    func testTheRoundPlateItStoodOnIsRemoved() throws {
        let object = box(SIMD3(-30, -15, 0), SIMD3(30, 15, 40))
        let cut = try XCTUnwrap(removeSupport(tilted(object + disc(radius: 100, top: 0, thickness: 8), degrees: 5)))
        let s = size(cut.corners)
        XCTAssertEqual(s.x, 60, accuracy: 1.5); XCTAssertEqual(s.y, 30, accuracy: 1.5)
        XCTAssertEqual(s.z, 39.5, accuracy: 0.6)
    }

    /// A sign with nothing under it (a 180 × 30 × 25 mm plank, letters 160 × 10 × 70 mm on top): the plank's top is an
    /// upward step under the letters, not a support, so nothing is cut.
    func testAnObjectsOwnStepIsNotASupport() {
        let plank = box(SIMD3(-90, -15, 0), SIMD3(90, 15, 25))
        let letters = box(SIMD3(-80, -5, 25), SIMD3(80, 5, 95))
        XCTAssertNil(removeSupport(plank + letters))
        XCTAssertNil(removeSupport(tilted(plank + letters)))
    }

    /// Nothing flat at the bottom (an upright cylinder-ish object with no support) is left alone too.
    func testNoSupportNoCut() {
        XCTAssertNil(removeSupport(box(SIMD3(-20, -20, 0), SIMD3(20, 20, 60))))
    }

    /// `writeSTL(removeSupport:)` reports the cut and writes the object alone.
    func testSTLWithTheSupportRemoved() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("handheldkit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        // Written Y up in millimetres, as Apple's USDZ is (Model I/O reads an STL as Y up), read back through Model I/O.
        let corners = (box(SIMD3(-30, -15, 0), SIMD3(30, 15, 40)) + disc(radius: 100, top: 0, thickness: 8)).map { SIMD3($0.x, $0.z, -$0.y) }
        var data = Data(count: 80)
        var count = UInt32(corners.count / 3).littleEndian
        data.append(Data(bytes: &count, count: 4))
        for t in 0..<(corners.count / 3) {
            var floats = [Float](repeating: 0, count: 3) + [corners[3 * t], corners[3 * t + 1], corners[3 * t + 2]].flatMap { [$0.x, $0.y, $0.z] }
            data.append(Data(bytes: &floats, count: 48)); data.append(contentsOf: [0, 0])
        }
        let input = dir.appendingPathComponent("in.stl"), output = dir.appendingPathComponent("out.stl")
        try data.write(to: input)
        let summary = try writeSTL(model: input, to: output, metresPerUnit: 0.001, removeSupport: true)
        XCTAssertNotNil(summary.support)
        XCTAssertLessThan(summary.sizeMm.x, 62); XCTAssertLessThan(summary.sizeMm.y, 62)
        let plain = try writeSTL(model: input, to: output, metresPerUnit: 0.001)
        XCTAssertNil(plain.support)
        XCTAssertGreaterThan(plain.sizeMm.x, 190, "without the flag the plate stays")
    }
}

