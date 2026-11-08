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
    /// start timed out (print.uncertain), and that locked all six plates. The doubt stays on plate 1 alone. The projects
    /// are the shared fixture the companion's own tests check (packages/contracts/fixtures/six-plate-unconfirmed.json).
    func testAnUnconfirmedSendLeavesEveryPlateChoosableAndOnlyItsPlateAsksForACheck() throws {
        struct Rig: Decodable { let unconfirmed, switched, back, cancelled: Project }
        let rig = try JSONDecoder().decode(Rig.self, from: Data(contentsOf: repoRoot.appending(path: "packages/contracts/fixtures/six-plate-unconfirmed.json")))
        XCTAssertTrue(rig.unconfirmed.canSelectPlate)
        XCTAssertTrue(rig.unconfirmed.printNeedsCheck)
        XCTAssertEqual(rig.unconfirmed.plates?.first?.statusText, "Check print result")
        XCTAssertTrue(ProjectWords(rig.unconfirmed).actions.contains(.printChecked))
        // Plate 4 chosen: it prints without the check, and every plate stays choosable.
        XCTAssertTrue(rig.switched.canSelectPlate)
        XCTAssertEqual(rig.switched.selectedPlate?.name, "Background Board")
        XCTAssertFalse(rig.switched.printNeedsCheck)
        XCTAssertFalse(ProjectWords(rig.switched).actions.contains(.printChecked))
        // Back on Screws: Print asks again, in words about that plate.
        XCTAssertTrue(rig.back.printNeedsCheck)
        XCTAssertTrue(ProjectWords(rig.back).actions.contains(.printChecked))
        XCTAssertTrue(rig.back.uncertainPrintWords.contains("Screws"))
        // This older record has no explicit dispatch outcome: preserve its existing display and check.
        XCTAssertEqual(rig.cancelled.plates?.first?.status, "unknown")
        XCTAssertFalse(rig.cancelled.printNeedsCheck)
        // A running print still locks the plates.
        var printing = rig.switched; printing.state = .printing
        XCTAssertFalse(printing.canSelectPlate)
    }
    func testPlateSelectionUsesCaptureImportPermission() {
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/objects/00000000-0000-4000-8000-000000000001/plate-selection"), "captures:import")
    }
    func testARecordedPlateDoesNotClaimItWasJustSentToAPrinter() throws {
        let project = try JSONDecoder().decode(Project.self, from: Data(#"{"id":"p","createdAtMs":1,"updatedAtMs":2,"state":"printed","plates":[{"id":"h:0","fileIndex":0,"plateIndex":0,"name":"Base","fileName":"rig.3mf","selected":true,"sliced":false,"status":"printed","completedAtMs":2}]}"#.utf8))
        XCTAssertEqual(ProjectWords(project).phase, .printed)
        XCTAssertEqual(ProjectWords(project).status, "Printed")
    }
    func testPrintedElsewhereUsesCaptureImportPermission() {
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/objects/00000000-0000-4000-8000-000000000001/plate-printed"), "captures:import")
    }
    func testOlderCompanionDoesNotInventPlates() throws {
        let project = try JSONDecoder().decode(Project.self, from: Data(#"{"id":"p","createdAtMs":1,"updatedAtMs":2,"state":"ready"}"#.utf8))
        XCTAssertNil(project.plates)
        XCTAssertFalse(project.canSelectPlate)
    }
}
