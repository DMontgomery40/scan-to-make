import XCTest
@testable import CounterpartKit

final class LayerPauseTests: XCTestCase {
    func testPrintSendsChosenLayerPausesOnceInOrder() {
        let choice = PrintChoice(colour: nil, pauseBeforeLayers: [12, 2, 12, 0, 1, -5])
        XCTAssertEqual(choice.body["pauseBeforeLayers"] as? [Int], [2, 12])
        XCTAssertNil(PrintChoice(colour: nil).body["pauseBeforeLayers"], "Ordinary prints remain compatible with older companions")
    }
}
