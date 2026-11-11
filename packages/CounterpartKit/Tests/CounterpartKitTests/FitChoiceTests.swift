import XCTest
@testable import CounterpartKit

final class FitChoiceTests: XCTestCase {
    func testKeptScanDefaultsToItsOwnSize() {
        let choice = FitChoice()
        XCTAssertEqual(choice.source, .scan)
        XCTAssertNil(choice.missing)
        XCTAssertEqual(choice.fit, ProjectFit(sizeSource: .scan))
        XCTAssertEqual(ProjectFit.SizeSource.allCases.map(\.label), ["Look up", "I measured", "Use scan"])
    }

    func testMeasuredSizeNeedsEveryTypedSideToBeValid() {
        var choice = FitChoice(source: .measured)
        XCTAssertNotNil(choice.missing)
        XCTAssertNil(choice.fit)
        choice.longest = "115,5"
        XCTAssertNil(choice.missing)
        XCTAssertEqual(choice.fit?.measured, [.init(id: "longest", label: "longest side", mm: 115.5)])
        for invalid in ["wide", "0", "-1", "10001", "inf", "nan"] {
            choice.middle = invalid
            XCTAssertNotNil(choice.missing, invalid)
        }
        choice.middle = "28"
        XCTAssertNil(choice.missing)
        choice.source = .lookup
        XCTAssertEqual(choice.fit, ProjectFit(sizeSource: .lookup), "measurements are sent only for I measured")
    }
}
