import XCTest
@testable import CounterpartKit

final class SmallMeasurementTests: XCTestCase {
    func testThinDesignedPartsKeepTheirDimensions() {
        XCTAssertEqual(Format.size([27, 30.6, 0.6]), "27 × 30.6 × 0.6 mm")
        XCTAssertEqual(Format.size([48, 50, 54]), "48 × 50 × 54 mm")
    }
    func testPositiveFilamentEstimatesDoNotRoundToZero() {
        XCTAssertEqual(Format.grams(0.49), "0.5 g")
        XCTAssertEqual(Format.grams(0.01), "<0.1 g")
        XCTAssertEqual(Format.grams(0), "0.0 g")
    }
}
