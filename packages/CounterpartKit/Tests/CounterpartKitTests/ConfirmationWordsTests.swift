import XCTest
@testable import CounterpartKit

/// bambu-printer-mcp's confirmPrintPreflight message (src/printers/bambu.ts), read into the confirm sheet's rows.
final class ConfirmationWordsTests: XCTestCase {
    let bambu = "Start a checked print on P1S (01P00A451200123)? Nozzles: 0.4 mm. Materials: PLA. Peak targets: nozzle 220°C, bed 55°C, chamber 0°C. "
        + "File SHA-256: 4f9c0b1e2d3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9012e21a. Confirm the physical spool labels and that the build plate is clear."

    func testBambuMessageBecomesRows() {
        let words = ConfirmationWords(message: bambu, fileName: "mic-mount.3mf")
        XCTAssertEqual(words.question, "Start a checked print on P1S?")
        XCTAssertEqual(words.facts.map(\.label), ["Nozzle", "Material", "Peak", "File"])
        XCTAssertEqual(words.facts.map(\.value), ["0.4 mm", "PLA", "Nozzle 220 °C · bed 55 °C", "mic-mount.3mf · 4f9c…e21a"])
        XCTAssertEqual(words.checks, ["The spool labels match PLA", "The build plate is clear"])
        XCTAssertEqual(words.notes, [])
        XCTAssertTrue(words.isStructured)
    }

    func testWarningsAfterTheChecksStayInTheirOwnWords() {
        let warning = " The printer reports FINISH: remove the previous part and debris before confirming."
        let words = ConfirmationWords(message: bambu + warning)
        XCTAssertEqual(words.notes, ["The printer reports FINISH: remove the previous part and debris before confirming."])
        XCTAssertEqual(words.facts.last?.value, "4f9c…e21a", "no file name: just the hash")
    }

    func testTwoNozzlesAndAWarmChamber() {
        let words = ConfirmationWords(message: "Start a checked print on H2D (x)? Nozzles: 0.4, 0.6 mm. Materials: PLA, PETG. Peak targets: nozzle 250°C, bed 70°C, chamber 45°C.")
        XCTAssertEqual(words.facts.map(\.value), ["0.4, 0.6 mm", "PLA, PETG", "Nozzle 250 °C · bed 70 °C · chamber 45 °C"])
    }

    func testAnotherMCPsMessageIsShownAsWritten() {
        let words = ConfirmationWords(message: "Heat the bed and start job cube.gcode?")
        XCTAssertFalse(words.isStructured)
        XCTAssertEqual(words.notes, ["Heat the bed and start job cube.gcode?"])
        XCTAssertEqual(words.checks, [])
    }
}
