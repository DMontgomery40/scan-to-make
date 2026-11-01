import XCTest
import CoreGraphics
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
}
