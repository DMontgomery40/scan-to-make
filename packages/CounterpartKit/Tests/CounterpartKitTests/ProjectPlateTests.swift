import XCTest
@testable import CounterpartKit

final class ProjectPlateTests: XCTestCase {
    func testPlatesDecodeAndKeepCompletionSeparateFromLastAttempt() throws {
        let json = #"{"id":"p","createdAtMs":1,"updatedAtMs":2,"state":"ready","plates":[{"id":"hash:0","fileIndex":0,"plateIndex":0,"name":"Base","fileName":"rig.3mf","selected":false,"sliced":false,"status":"failed","completedAtMs":10},{"id":"hash:1","fileIndex":0,"plateIndex":1,"name":"Arm","fileName":"rig.3mf","selected":true,"sliced":false,"status":"not-printed"}]}"#
        let project = try JSONDecoder().decode(Project.self, from: Data(json.utf8))
        XCTAssertEqual(project.plates?.count, 2)
        XCTAssertEqual(project.completedPlateCount, 1)
        XCTAssertEqual(project.selectedPlate?.name, "Arm")
        XCTAssertEqual(project.plates?.first?.statusText, "Reprint failed · printed before")
        XCTAssertTrue(project.canSelectPlate)
        var busy = project; busy.state = .printing
        XCTAssertFalse(busy.canSelectPlate)
    }
    /// David, Nov 6: "i can't select which plate to print in the app i can see them but i can't click on them". Plate 1's
    /// start timed out (print.uncertain), and that locked all six plates. The doubt stays on plate 1 alone.
    func testAnUnconfirmedSendLeavesEveryPlateChoosableAndOnlyItsPlateAsksForACheck() throws {
        let rows = (0..<6).map { i in #"{"id":"h:\#(i)","fileIndex":0,"plateIndex":\#(i),"name":"P\#(i + 1)","fileName":"rig.3mf","selected":\#(i == 0),"sliced":false,"status":"\#(i == 0 ? "unknown" : "not-printed")"}"# }
        let json = #"{"id":"p","createdAtMs":1,"updatedAtMs":2,"state":"failed","kind":"published","current":{"model":"original/rig.3mf","renders":[]},"print":{"bundleId":"b","uncertain":true},"plates":[\#(rows.joined(separator: ","))]}"#
        var project = try JSONDecoder().decode(Project.self, from: Data(json.utf8))
        XCTAssertTrue(project.canSelectPlate)
        XCTAssertTrue(project.printNeedsCheck)
        XCTAssertEqual(project.plates?.first?.statusText, "Check print result")
        // Another plate chosen: the companion drops the print record and keeps plate 1 "unknown".
        project.print = nil; project.state = .ready
        for i in project.plates!.indices { project.plates![i].selected = i == 3 }
        XCTAssertTrue(project.canSelectPlate)
        XCTAssertFalse(project.printNeedsCheck)
        XCTAssertFalse(ProjectWords(project).actions.contains(.printChecked))
        // Back on plate 1: Print asks again, in words about that plate.
        for i in project.plates!.indices { project.plates![i].selected = i == 0 }
        XCTAssertTrue(project.printNeedsCheck)
        XCTAssertTrue(ProjectWords(project).actions.contains(.printChecked))
        XCTAssertTrue(project.uncertainPrintWords.contains("P1"))
        // A send it could not follow is the same, and a printing project still locks the plates.
        project.plates![0].status = "sent"
        XCTAssertTrue(project.printNeedsCheck)
        project.state = .printing
        XCTAssertFalse(project.canSelectPlate)
    }
    func testPlateSelectionUsesCaptureImportPermission() {
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/objects/00000000-0000-4000-8000-000000000001/plate-selection"), "captures:import")
    }
    func testOlderCompanionDoesNotInventPlates() throws {
        let project = try JSONDecoder().decode(Project.self, from: Data(#"{"id":"p","createdAtMs":1,"updatedAtMs":2,"state":"ready"}"#.utf8))
        XCTAssertNil(project.plates)
        XCTAssertFalse(project.canSelectPlate)
    }
}
