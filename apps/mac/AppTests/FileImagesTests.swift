import XCTest
import ImageIO
import UniformTypeIdentifiers

/// PRD §9.6: pictures are decoded at the size they are shown, upright, and the cache is limited by bytes.
final class FileImagesTests: XCTestCase {
    func testTheDecodeSizeRoundsUpToAStep() {
        XCTAssertEqual(FileImages.step(0), 0, "not measured yet: nothing is decoded")
        XCTAssertEqual(FileImages.step(52), 128, "a 26 pt thumbnail at 2x")
        XCTAssertEqual(FileImages.step(600), 1024)
        XCTAssertEqual(FileImages.step(9000), 4096)
    }

    func testAPhotoIsDecodedSmallAndUpright() throws {
        // A 2000 × 1000 JPEG whose EXIF says "rotate 90°", as an iPhone portrait photo does.
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("photo-\(UUID().uuidString).jpg")
        defer { try? FileManager.default.removeItem(at: url) }
        let context = try XCTUnwrap(CGContext(data: nil, width: 2000, height: 1000, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(CGColor(red: 0.9, green: 0.5, blue: 0.2, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 2000, height: 1000))
        let image = try XCTUnwrap(context.makeImage())
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: 6] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))

        let decoded = try XCTUnwrap(FileImages.decode(url, maxPixels: 256, scale: 2))
        let cg = try XCTUnwrap(decoded.image.cgImage(forProposedRect: nil, context: nil, hints: nil))
        XCTAssertEqual(max(cg.width, cg.height), 256, "the shown size, not the camera's")
        XCTAssertLessThan(cg.width, cg.height, "turned upright")
        XCTAssertEqual(decoded.image.size.height, 128, "points at 2x")
        XCTAssertLessThanOrEqual(decoded.bytes, 256 * 256 * 4, "a few hundred KB, where the full photo is tens of MB")
    }
}
