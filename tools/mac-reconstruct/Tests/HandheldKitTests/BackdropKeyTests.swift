import XCTest
import CoreGraphics
import AppKit
@testable import HandheldKit

/// The rig backdrop key (BackdropKey): David's lime panel on the Nov 14 DAD scan, and the cases that must not be keyed.
final class BackdropKeyTests: XCTestCase {
    /// A 120×80 photo: the panel's colour on the right half, a black letter and the wood base on the left, measured
    /// colours from the Nov 14 photos. Depth (60×40): the letter and base at 0.17 m, the panel at `panelDepth`.
    private func scene(panel: (CGFloat, CGFloat, CGFloat), panelDepth: Float, panelWidth: Int = 60,
                       greenPart: Bool = false, counter: Bool = false, background: Background = .panel) throws -> (CVPixelBuffer, DepthImage) {
        let w = 120, h = 80
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(red: 166/255, green: 139/255, blue: 116/255, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))  // plate
        ctx.setFillColor(CGColor(red: panel.0/255, green: panel.1/255, blue: panel.2/255, alpha: 1))
        ctx.fill(CGRect(x: w - panelWidth, y: 0, width: panelWidth, height: h))
        var seed: UInt32 = 12345
        func random() -> CGFloat { seed = seed &* 1_664_525 &+ 1_013_904_223; return CGFloat(seed >> 8) / CGFloat(1 << 24) }
        switch background {
        case .panel: break
        case .unevenlyLit:   // one paint, lit brighter on one side: the same hue throughout
            for x in (w - panelWidth)..<w {
                let light = 0.6 + 0.4 * CGFloat(x - (w - panelWidth)) / CGFloat(panelWidth)
                ctx.setFillColor(CGColor(red: panel.0 * light / 255, green: panel.1 * light / 255, blue: panel.2 * light / 255, alpha: 1))
                ctx.fill(CGRect(x: x, y: 0, width: 1, height: h))
            }
        case .lawn:   // many greens and yellow-greens, light and shade, a brown patch here and there
            for bx in stride(from: w - panelWidth, to: w, by: 4) {
                for by in stride(from: 0, to: h, by: 4) {
                    let brown = random() < 0.25
                    let colour = NSColor(hue: brown ? 0.08 : 0.2 + 0.2 * random(), saturation: 0.45 + 0.45 * random(),
                                         brightness: brown ? 0.3 : 0.3 + 0.5 * random(), alpha: 1)
                    ctx.setFillColor(colour.cgColor); ctx.fill(CGRect(x: bx, y: by, width: 4, height: 4))
                }
            }
        case .leaves:   // one green, but speckled with dark gaps pixel by pixel, never a solid surface
            for x in (w - panelWidth)..<w {
                for y in 0..<h where random() < 0.4 {
                    ctx.setFillColor(CGColor(red: 0.1, green: 0.12, blue: 0.08, alpha: 1)); ctx.fill(CGRect(x: x, y: y, width: 1, height: 1))
                }
            }
        }
        ctx.setFillColor(CGColor(red: 35/255, green: 27/255, blue: 18/255, alpha: 1)); ctx.fill(CGRect(x: 50, y: 20, width: 30, height: 40))   // letter, overlapping the panel
        ctx.setFillColor(CGColor(red: 152/255, green: 119/255, blue: 82/255, alpha: 1)); ctx.fill(CGRect(x: 10, y: 60, width: 100, height: 10)) // wood base
        if counter {   // the panel seen through a hole in the letter, too small for the depth map: it reads the letter's 0.17 m
            ctx.setFillColor(CGColor(red: panel.0/255, green: panel.1/255, blue: panel.2/255, alpha: 1)); ctx.fill(CGRect(x: 58, y: 34, width: 8, height: 8))
        }
        if greenPart {   // a part of the object in the panel's own colour, at the object's depth (0.17 m)
            ctx.setFillColor(CGColor(red: panel.0/255, green: panel.1/255, blue: panel.2/255, alpha: 1)); ctx.fill(CGRect(x: 10, y: 20, width: 20, height: 20))
        }
        var metres = [Float](repeating: 0.17, count: 60 * 40)
        for y in 0..<40 { for x in (60 - panelWidth / 2)..<60 { metres[y * 60 + x] = panelDepth } }
        for y in 10..<30 { for x in 25..<40 { metres[y * 60 + x] = 0.17 } }   // the letter in front of the panel
        return (try pixelBuffer(from: ctx.makeImage()!), DepthImage(width: 60, height: 40, metres: metres))
    }

    enum Background { case panel, unevenlyLit, lawn, leaves }

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

    /// Review of #793 (Codex P1): the panel and a green part of the object in one photo. The photo shows a backdrop; the
    /// object's green, a region big enough to measure at 0.17 m, stays, and the panel at 0.41 m goes.
    func testAGreenPartOfTheObjectStaysWhenThePanelIsInTheSamePhoto() throws {
        let (image, depth) = try scene(panel: (160, 147, 31), panelDepth: 0.41, greenPart: true)
        let frame = try BackdropKey.key(image: image, depth: depth)
        XCTAssertTrue(frame.isBackdrop)
        XCTAssertTrue(kept(frame, 20, 30), "the object's own green")
        XCTAssertTrue(kept(frame, 12, 22) && kept(frame, 28, 38), "all of it, to its corners")
        XCTAssertFalse(kept(frame, 100, 40), "the panel")
        XCTAssertTrue(kept(frame, 65, 40), "the letter")
    }

    /// The panel seen through a letter's counter reads at the letter's depth (the LiDAR can't resolve a hole a few cells
    /// wide; per-pixel depth closed the A's counters on David's Nov 8 scan). A region of the colour that small is keyed.
    func testThePanelSeenThroughACounterTooSmallForTheDepthIsStillKeyed() throws {
        let (image, depth) = try scene(panel: (160, 147, 31), panelDepth: 0.41, counter: true)
        let frame = try BackdropKey.key(image: image, depth: depth)
        XCTAssertTrue(frame.isBackdrop)
        XCTAssertFalse(kept(frame, 61, 37), "the counter is open")
        XCTAssertTrue(kept(frame, 55, 37), "the letter round it stays")
    }

    /// Review of #793: the key is for a deliberate backdrop, not for whatever green is behind a scan. A walk-around on a
    /// lawn or in front of a hedge, both well behind the object, never turns it on; a panel lit unevenly still does.
    func testTexturedGreenBehindAWalkAroundNeverKeysAFlatPanelDoes() throws {
        for background in [Background.lawn, .leaves] {
            let (image, depth) = try scene(panel: (110, 170, 40), panelDepth: 0.9, background: background)
            let frame = try BackdropKey.key(image: image, depth: depth)
            XCTAssertGreaterThan(frame.share, BackdropKey.minimumShare, "\(background): plenty of the colour")
            XCTAssertFalse(frame.isBackdrop, "\(background): fill \(frame.fill), hue spread \(frame.hueSpread)")
            XCTAssertEqual(frame.keep.onCount, frame.keep.width * frame.keep.height, "\(background): nothing keyed")
        }
        let (image, depth) = try scene(panel: (160, 147, 31), panelDepth: 0.41, background: .unevenlyLit)
        let frame = try BackdropKey.key(image: image, depth: depth)
        XCTAssertTrue(frame.isBackdrop, "fill \(frame.fill), hue spread \(frame.hueSpread)")
        XCTAssertFalse(kept(frame, 100, 40))
    }

    /// Review of #801 (F2): a deep lime crate, no backdrop. Its far face is 0.3 m behind its front edge, which used to be
    /// enough to call it a backdrop and key the crate's own back away. Its border meets its own walls and the table at
    /// about its own depth, with nothing in front: never a backdrop.
    func testADeepObjectOfTheColourWithNoBackdropIsNeverKeyed() throws {
        let w = 120, h = 80, dw = 60, dh = 40
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(red: 166/255, green: 139/255, blue: 116/255, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.setFillColor(CGColor(red: 160/255, green: 170/255, blue: 40/255, alpha: 1)); ctx.fill(CGRect(x: 40, y: 20, width: 60, height: 50))
        // Depth rows top to bottom (cell row 0 is the image's top): the crate (cell rows 5…29, x 20…49) from 0.5 m at its
        // far top edge to 0.2 m at its near bottom edge; the table below it carries on from 0.2 m to 0.15 m; the room
        // either side and above, 1.5 m away.
        var metres = [Float](repeating: 1.5, count: dw * dh)
        for y in 5..<30 { for x in 20..<50 { metres[y * dw + x] = 0.5 - 0.3 * Float(y - 5) / 24 } }
        for y in 30..<dh { for x in 0..<dw { metres[y * dw + x] = 0.2 - 0.05 * Float(y - 30) / 9 } }
        let frame = try BackdropKey.key(image: try pixelBuffer(from: ctx.makeImage()!), depth: DepthImage(width: dw, height: dh, metres: metres))
        XCTAssertGreaterThan(frame.panelShare, 0.2, "one big, flat region of the colour")
        XCTAssertGreaterThanOrEqual((frame.backdropDepth ?? 0) - (frame.nearestDepth ?? 1), BackdropKey.minimumGap, "deep enough to pass the old test")
        XCTAssertFalse(frame.isBackdrop, "front step \(String(describing: frame.frontStep))")
        XCTAssertEqual(frame.keep.onCount, frame.keep.width * frame.keep.height, "the crate keeps its back")
    }

    /// Review of #801 (F5): the object mask on a synthetic keyed photo. The panel's area and the room outside Vision's
    /// foreground go; the object's body stays; a 3-pixel wire on it, thinner than the opening, goes with the panel's
    /// rim (the trade-off the opening makes); no foreground at all gives no mask.
    func testTheObjectMaskKeepsTheObjectAndDropsThinLeftovers() {
        let w = 120, h = 80
        var keep = GrayImage(width: w, height: h, fill: 255)
        for y in 0..<h { for x in 70..<w { keep[x, y] = 0 } }             // the keyed panel, right side
        for y in 0..<h { keep[70, y] = 255; keep[71, y] = 255 }           // its rim, left by the key's edge allowance
        var foreground = GrayImage(width: w, height: h)
        for y in 20..<60 { for x in 20..<100 { foreground[x, y] = 255 } } // the object and the panel behind it
        for y in 5..<20 { for x in 40..<43 { foreground[x, y] = 255 } }   // a wire 3 pixels thick standing on it
        let mask = BackdropKey.objectMask(keep: keep, foreground: foreground)!
        XCTAssertEqual(mask[40, 40], 255, "the object's body")
        XCTAssertEqual(mask[90, 40], 0, "the panel")
        XCTAssertEqual(mask[71, 40], 0, "the panel's rim")
        XCTAssertEqual(mask[10, 40], 0, "the room outside the foreground")
        XCTAssertEqual(mask[41, 10], 0, "a feature thinner than 2 × cleanup + 1 pixels goes too")
        XCTAssertNil(BackdropKey.objectMask(keep: keep, foreground: GrayImage(width: w, height: h)), "no foreground, no mask")
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
