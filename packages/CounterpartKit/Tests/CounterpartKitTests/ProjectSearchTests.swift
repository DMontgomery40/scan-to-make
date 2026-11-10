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

    /// First look U10 (Nov 10): "holder" listed "3D scan platform" and "AirPods Max desk hanger" with no reason. A result
    /// whose title lacks a searched word says where it matched, with the words marked; one whose title has them says nothing.
    func testAResultShowsWhereItMatchedWhenTheTitleDoesnt() throws {
        let long = "okay the main holder is actually terrible cause the ridge of teh rails holds it too high and it wobbles when I take the headphones off"
        let data = Data(#"{"id":"a","createdAtMs":1,"updatedAtMs":2,"state":"ready","title":"AirPods Max desk hanger","passes":[],"messages":[{"id":"m","text":"\#(long)","atMs":1,"photos":[]}]}"#.utf8)
        let project = try JSONDecoder().decode(Project.self, from: data)
        XCTAssertTrue(project.matchesSearch("holder"))
        let snippet = try XCTUnwrap(project.searchSnippet("holder"))
        XCTAssertTrue(snippet.text.contains("main holder is actually terrible"), snippet.text)
        XCTAssertLessThan(snippet.text.count, 120, "a short line, not the whole message")
        XCTAssertTrue(snippet.text.hasSuffix("…"))
        let marked = snippet.marks.map { mark in
            String(snippet.text[snippet.text.index(snippet.text.startIndex, offsetBy: mark.lowerBound)..<snippet.text.index(snippet.text.startIndex, offsetBy: mark.upperBound)])
        }
        XCTAssertEqual(marked.first?.lowercased(), "holder")
        XCTAssertNotNil(snippet.attributed.runs.first { $0.inlinePresentationIntent == .stronglyEmphasized })
        XCTAssertEqual(snippet.matchedWords, ["holder"], "what VoiceOver hears as the match")
        // The title has it: no line.
        XCTAssertNil(project.searchSnippet("desk"))
        XCTAssertNil(project.searchSnippet(""))
        // Two words, one in the title: the line is about the other.
        XCTAssertTrue(try XCTUnwrap(project.searchSnippet("airpods ridge")).text.contains("ridge"))
    }
}
