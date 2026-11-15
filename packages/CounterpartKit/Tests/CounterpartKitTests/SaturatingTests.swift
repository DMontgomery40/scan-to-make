import XCTest
@testable import CounterpartKit

/// #840 (review of #843): a number from the companion never traps the app when it becomes a whole number.
final class SaturatingTests: XCTestCase {
    static let absurd: [Double] = [.nan, .infinity, -.infinity, 1e300, -1e300, 9.3e18, -9.3e18, .greatestFiniteMagnitude, 9e16, -9e16]

    func testAWholeNumberFromAnyDoubleNeverTraps() {
        XCTAssertEqual(Int(saturating: 41.9), 41)
        XCTAssertEqual(Int(saturating: -41.9), -41)
        XCTAssertEqual(Int(saturating: .nan), 0)
        XCTAssertEqual(Int(saturating: .infinity), .max)
        XCTAssertEqual(Int(saturating: -.infinity), .min)
        XCTAssertEqual(Int(saturating: 1e300), .max)
        XCTAssertEqual(Int(saturating: 9_223_372_036_854_775_807), .max)
        XCTAssertEqual(Int(saturating: -9_223_372_036_854_775_808), .min)
    }

    /// Every formatter and form that turns the companion's numbers into words, fed values no real print has.
    func testTheCompanionsNumbersBecomeWordsWithoutATrap() {
        let now = Date()
        for value in Self.absurd {
            _ = Format.duration(value); _ = Format.about(value); _ = Format.grams(value); _ = Format.percent(value)
            _ = Format.temperature(value)
            _ = AskSizesForm.text(value)
            if !value.isNaN {
                // A time the Mac sent, any distance from now: `updated` and `ago` converted it unchecked.
                let date = Date(timeIntervalSince1970: value)
                _ = Format.updated(date, now: now); _ = Format.ago(date, now: now)
                _ = Format.when(Date(timeIntervalSince1970: max(-1e15, min(1e15, value))), now: now)
            }
        }
        XCTAssertEqual(AskSizesForm.text(12), "12")
        XCTAssertEqual(AskSizesForm.text(12.345), "12.35")
        XCTAssertEqual(AskSizesForm.text(.nan), "")
        XCTAssertEqual(AskSizesForm.text(9e16), "9e+16", "an absurd size is written as it came, not converted")
    }
}
