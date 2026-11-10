import XCTest
import CoreGraphics
@testable import CounterpartKit

/// David, Nov 9: the question's picture was a 64-point square with an unreadable box, captioned "The highlighted part is
/// what I can't see." under a size question that boxed the whole bottle.
final class AskPictureTests: XCTestCase {
    func testTheCaptionNeverClaimsWhatTheMacCannotSee() {
        let bottle = Project.Ask(id: "a", question: "Can you confirm the size?", photo: "asks/a.jpg",
                                 region: .init(x: 0.42, y: 0.3, width: 0.28, height: 0.34), answers: ["text"])
        XCTAssertEqual(AskPicture.caption(bottle), "The outlined part is what this question is about.")
        XCTAssertEqual(AskPicture.caption(Project.Ask(id: "a", question: "q", photo: "asks/a.jpg", answers: [])), "The picture that goes with this question.")
        XCTAssertEqual(AskPicture.caption(Project.Ask(id: "a", question: "q", answers: [])), "Your project’s picture. No picture came with this question.")
        for caption in [AskPicture.caption(bottle), AskPicture.caption(nil)] {
            XCTAssertFalse(caption.localizedCaseInsensitiveContains("can't see") || caption.localizedCaseInsensitiveContains("can’t see"))
        }
    }

    func testARegionOutsideThePictureIsClampedOrDropped() {
        let edge = try! XCTUnwrap(Project.Region(x: -0.1, y: 0.5, width: 0.3, height: 0.8).clamped)
        XCTAssertEqual([edge.x, edge.y, edge.width, edge.height].map { ($0 * 1000).rounded() }, [0, 500, 200, 500])
        XCTAssertNil(Project.Region(x: 1.2, y: 0, width: 0.3, height: 0.3).clamped)
        XCTAssertNil(Project.Region(x: .nan, y: 0, width: 0.3, height: 0.3).clamped)
    }

    /// The full-screen picture keeps its size, dims outside the region and leaves the region's middle untouched.
    func testTheMarkedPictureDimsOutsideTheRegionOnly() throws {
        let width = 400, height = 300
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let photo = try XCTUnwrap(context.makeImage())
        let marked = try XCTUnwrap(AskPicture.marked(photo, region: .init(x: 0.42, y: 0.3, width: 0.28, height: 0.34)))
        XCTAssertEqual([marked.width, marked.height], [width, height])
        func red(_ x: Int, _ yFromTop: Int) throws -> UInt8 {
            let data = try XCTUnwrap(marked.dataProvider?.data as Data?)
            return data[yFromTop * marked.bytesPerRow + x * 4]
        }
        XCTAssertGreaterThan(try red(Int(0.56 * Double(width)), Int(0.47 * Double(height))), 250, "the region's middle is untouched")
        XCTAssertLessThan(try red(20, 20), 140, "outside the region is dimmed")
        XCTAssertLessThan(try red(200, 280), 140, "below the region too (top-left origin)")
    }
}
