import XCTest
@testable import CounterpartKit

final class ProjectSearchTests: XCTestCase {
    func testEveryTermCanMatchADifferentField() throws {
        let data = Data(#"{"id":"internal-identity-4921","createdAtMs":1740123456789,"updatedAtMs":1740123456790,"state":"ready","title":"Café mount","instructions":"Fits a kitchen rail","passes":[{"startedAtMs":1,"endedAtMs":2,"note":"Make the flange narrower","summary":"Added a reinforced gusset"}],"current":{"model":"current/model.stl","renders":[],"changes":[{"tag":"changed","text":"Chamfered the corner"}]},"ask":{"id":"q","question":"Which fastener fits?","answers":["text"],"status":"answered"},"print":{"bundleId":"b","destination":{"id":"p","name":"Workshop P1S"},"settings":{"quality":"fine","colour":{"material":"PETG"}}},"credit":{"designer":"Kass 3D","title":"Scan rig"},"directory":"/private/hidden-folder"}"#.utf8)
        let project = try JSONDecoder().decode(Project.self, from: data)
        for query in ["cafe flange", "reinforced", "chamfered", "fastener", "Workshop fine", "PETG", "Kass rig", "  cafe\n kitchen  "] {
            XCTAssertTrue(project.matchesSearch(query), query)
        }
        XCTAssertTrue(project.matchesSearch("cafe office", additional: ["Office printer"]))
        XCTAssertFalse(project.matchesSearch("cafe titanium"))
        XCTAssertFalse(project.matchesSearch("hidden-folder"))
        XCTAssertFalse(project.matchesSearch("1740123456789"))
        XCTAssertFalse(project.matchesSearch("internal-identity-4921"))
        XCTAssertFalse(project.matchesSearch("current/model.stl"))
        XCTAssertFalse(project.matchesSearch("startedAtMs"), "JSON field names are not project content")
        XCTAssertTrue(project.matchesSearch(" \n "))
    }

    func testCompletionReportIsSearchableAndUndoOnlyAppearsForItsOwnOutcome() throws {
        let data = Data(#"{"id":"mount","createdAtMs":1,"updatedAtMs":2,"state":"confirmed","completion":{"note":"Mounted and working","atMs":2,"previousStatus":"printed"}}"#.utf8)
        var project = try JSONDecoder().decode(Project.self, from: data)
        XCTAssertEqual(project.completionUndoStatus, .printed)
        XCTAssertTrue(project.matchesSearch("mounted"))
        project.completion?.undone = true
        XCTAssertNil(project.completionUndoStatus)
        project.completion?.undone = false
        project.state = .touchingUp
        XCTAssertNil(project.completionUndoStatus)
    }

    func testNameValidationMatchesTheCompanion() {
        XCTAssertTrue(Project.validName("  Desk mount  "))
        XCTAssertTrue(Project.validName(String(repeating: "a", count: 120)))
        XCTAssertFalse(Project.validName(" \n "))
        XCTAssertFalse(Project.validName(String(repeating: "a", count: 121)))
        XCTAssertFalse(Project.validName("bad\u{0}name"))
        XCTAssertFalse(Project.validName(String(repeating: "🖨", count: 61)))
    }
}
