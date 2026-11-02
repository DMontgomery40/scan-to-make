import XCTest
@testable import CounterpartKit

final class ProjectPrintDefaultsTests: XCTestCase {
    private let history: [String: Any] = ["bundleId": "previous", "destinationId": "old-printer",
        "settings": ["quality": "fine", "strength": "strong", "copies": 2, "colour": ["amsSlot": 3]]]

    func testExplicitPrinterProfileColourNeverRestoresHistoricalTray() {
        let saved = project(["print": history, "settings": ["printDefaults": ["quality": "draft"]]])
        let defaults = saved.resolvedPrintDefaults(destinationId: "old-printer")
        XCTAssertNil(defaults.colour, "choosing Printer profile clears the tray even on the previous printer")
        XCTAssertEqual(defaults.quality, "draft")
        XCTAssertNil(defaults.copies, "a saved default set replaces history as a whole")
        let profile = project(["print": history, "settings": ["printDefaults": [:]]])
        XCTAssertEqual(profile.resolvedPrintDefaults(destinationId: "old-printer"), PrintSettings())
    }

    func testHistoryColourBelongsOnlyToItsEffectivePrinter() {
        let legacy = project(["print": history])
        XCTAssertEqual(legacy.resolvedPrintDefaults(destinationId: "old-printer").colour, .object(["amsSlot": .number(3)]))
        let changed = legacy.resolvedPrintDefaults(destinationId: "new-printer")
        XCTAssertNil(changed.colour, "saving another setting after a printer change must not persist the old tray")
        XCTAssertEqual(changed.quality, "fine")
        XCTAssertEqual(changed.strength, "strong")
        XCTAssertEqual(changed.copies, 2)
        XCTAssertNil(legacy.resolvedPrintDefaults(destinationId: nil).colour, "an unknown default printer is not a match")
    }

    func testLegacyDestinationRecordAndExplicitSavedColourRemainUsable() {
        var old = history; old["destinationId"] = nil; old["destination"] = ["id": "old-printer", "name": "Old printer"]
        XCTAssertNotNil(project(["print": old]).resolvedPrintDefaults(destinationId: "old-printer").colour)
        let selected = project(["print": history, "printerDestinationId": "new-printer",
                                "settings": ["printDefaults": ["colour": ["amsSlot": 1]]]])
        XCTAssertEqual(selected.resolvedPrintDefaults(destinationId: "new-printer").colour, .object(["amsSlot": .number(1)]))
    }
}
