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

    /// Nov 5, caliper card 1f1c5515: "It shouldn't have changed a single thing about the physical print". A file whose
    /// printer MCP says it prints with its own settings (a designer's 3MF) starts at Standard, which sends nothing.
    func testADesignersFileStartsAtItsOwnSettingsNotTheLastPrints() {
        let file: [String: Any] = ["model": "current/model.3mf", "renders": [], "ownSettings": true]
        let designer = project(["print": history, "current": file])
        XCTAssertTrue(designer.printsWithOwnSettings)
        let defaults = designer.resolvedPrintDefaults(destinationId: "old-printer")
        XCTAssertNil(defaults.quality, "the last print's Fine never carries over")
        XCTAssertNil(defaults.strength, "the last print's Strong never carries over")
        XCTAssertEqual(defaults.copies, 2, "copies and the spool still follow the last print")
        XCTAssertEqual(defaults.colour, .object(["amsSlot": .number(3)]))
        let saved = project(["settings": ["printDefaults": ["quality": "draft", "strength": "max"]], "current": file])
        XCTAssertEqual(saved.resolvedPrintDefaults(destinationId: nil), PrintSettings(), "saved defaults don't override the designer either")
        var unknown = file; unknown["ownSettings"] = nil
        XCTAssertEqual(project(["print": history, "current": unknown]).resolvedPrintDefaults(destinationId: "old-printer").strength, "strong",
                       "an MCP that doesn't say: the last print's settings, as before")
    }

    func testLegacyDestinationRecordAndExplicitSavedColourRemainUsable() {
        var old = history; old["destinationId"] = nil; old["destination"] = ["id": "old-printer", "name": "Old printer"]
        XCTAssertNotNil(project(["print": old]).resolvedPrintDefaults(destinationId: "old-printer").colour)
        let selected = project(["print": history, "printerDestinationId": "new-printer",
                                "settings": ["printDefaults": ["colour": ["amsSlot": 1]]]])
        XCTAssertEqual(selected.resolvedPrintDefaults(destinationId: "new-printer").colour, .object(["amsSlot": .number(1)]))
    }
}
