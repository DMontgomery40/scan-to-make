import XCTest
import CoreGraphics
@testable import HandheldKit

/// The rig backdrop key (BackdropKey): David's lime panel on the Nov 14 DAD scan, and the cases that must not be keyed.
final class BackdropKeyTests: XCTestCase {
    /// A 120×80 photo: the panel's colour on the right half, a black letter and the wood base on the left, measured
    /// colours from the Nov 14 photos. Depth (60×40): the letter and base at 0.17 m, the panel at `panelDepth`.
    private func scene(panel: (CGFloat, CGFloat, CGFloat), panelDepth: Float, panelWidth: Int = 60) throws -> (CVPixelBuffer, DepthImage) {
        let w = 120, h = 80
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(red: 166/255, green: 139/255, blue: 116/255, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))  // plate
        ctx.setFillColor(CGColor(red: panel.0/255, green: panel.1/255, blue: panel.2/255, alpha: 1))
        ctx.fill(CGRect(x: w - panelWidth, y: 0, width: panelWidth, height: h))
        ctx.setFillColor(CGColor(red: 35/255, green: 27/255, blue: 18/255, alpha: 1)); ctx.fill(CGRect(x: 50, y: 20, width: 30, height: 40))   // letter, overlapping the panel
        ctx.setFillColor(CGColor(red: 152/255, green: 119/255, blue: 82/255, alpha: 1)); ctx.fill(CGRect(x: 10, y: 60, width: 100, height: 10)) // wood base
        var metres = [Float](repeating: 0.17, count: 60 * 40)
        for y in 0..<40 { for x in (60 - panelWidth / 2)..<60 { metres[y * 60 + x] = panelDepth } }
        for y in 10..<30 { for x in 25..<40 { metres[y * 60 + x] = 0.17 } }   // the letter in front of the panel
        return (try pixelBuffer(from: ctx.makeImage()!), DepthImage(width: 60, height: 40, metres: metres))
    }

    // CGContext rows run bottom-up; GrayImage row 0 is the buffer's top row.
    private func kept(_ frame: BackdropKey.Frame, _ x: Int, _ yFromBottom: Int) -> Bool { frame.keep[x, frame.keep.height - 1 - yFromBottom] > 127 }

    func testTheRigsLimePanelIsKeyedOutAndTheObjectKept() throws {
        for lime in [(160.0, 147.0, 31.0), (202.0, 211.0, 67.0), (0.0, 255.0, 0.0)] {   // warm light, daylight, a classic green screen
            let (image, depth) = try scene(panel: (lime.0, lime.1, lime.2), panelDepth: 0.41)
            let frame = try BackdropKey.key(image: image, depth: depth)
            XCTAssertTrue(frame.isBackdrop, "\(lime)")
            XCTAssertFalse(kept(frame, 100, 40), "panel \(lime)")
            XCTAssertTrue(kept(frame, 65, 40), "letter \(lime)")
            XCTAssertTrue(kept(frame, 100, 65), "wood base \(lime)")
            XCTAssertTrue(kept(frame, 20, 40), "plate \(lime)")
            XCTAssertTrue(kept(frame, 81, 40), "the letter's edge stays on the letter \(lime)")
            XCTAssertFalse(kept(frame, 84, 40), "the key starts a few pixels out \(lime)")
        }
    }

    func testAYellowOrGreenObjectWithNothingBehindItIsNeverKeyed() throws {
        let (image, depth) = try scene(panel: (160, 147, 31), panelDepth: 0.19)   // the colour is part of the object
        let frame = try BackdropKey.key(image: image, depth: depth)
        XCTAssertFalse(frame.isBackdrop)
        XCTAssertEqual(frame.keep.onCount, frame.keep.width * frame.keep.height)
    }

    func testAStrayPatchOfTheColourIsNotABackdrop() throws {
        let (image, depth) = try scene(panel: (160, 147, 31), panelDepth: 0.41, panelWidth: 1)   // a tape measure's edge
        XCTAssertFalse(try BackdropKey.key(image: image, depth: depth).isBackdrop)
    }

    func testWithoutDepthNothingIsKeyed() throws {
        let (image, _) = try scene(panel: (160, 147, 31), panelDepth: 0.41)
        XCTAssertFalse(try BackdropKey.key(image: image, depth: nil).isBackdrop)
    }

    func testTheColourTestOnMeasuredPixels() {
        XCTAssertTrue(BackdropKey.isBackdrop(r: 159, g: 147, b: 31))    // panel, warm
        XCTAssertTrue(BackdropKey.isBackdrop(r: 202, g: 211, b: 67))    // panel, daylight
        XCTAssertFalse(BackdropKey.isBackdrop(r: 152, g: 119, b: 82))   // wood base
        XCTAssertFalse(BackdropKey.isBackdrop(r: 35, g: 27, b: 18))     // black letter
        XCTAssertFalse(BackdropKey.isBackdrop(r: 166, g: 139, b: 116))  // grey plate
        XCTAssertFalse(BackdropKey.isBackdrop(r: 230, g: 230, b: 225))  // white label
    }
}
