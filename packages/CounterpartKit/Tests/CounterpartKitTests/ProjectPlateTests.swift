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
    func testPlateSelectionUsesCaptureImportPermission() {
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/objects/00000000-0000-4000-8000-000000000001/plate-selection"), "captures:import")
    }
    func testOlderCompanionDoesNotInventPlates() throws {
        let project = try JSONDecoder().decode(Project.self, from: Data(#"{"id":"p","createdAtMs":1,"updatedAtMs":2,"state":"ready"}"#.utf8))
        XCTAssertNil(project.plates)
        XCTAssertFalse(project.canSelectPlate)
    }
}
