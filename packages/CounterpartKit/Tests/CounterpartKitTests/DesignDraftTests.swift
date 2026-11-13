import XCTest
@testable import CounterpartKit

/// #788: a code design pass that ended with no final run keeps its last valid run as a draft. The same fixture as the
/// contracts, Mac, Android and Linux (packages/contracts/fixtures/project-draft.json).
final class DesignDraftTests: XCTestCase {
    private func doc() throws -> [String: Any] { try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("project-draft.json")) as? [String: Any]) }
    private func project(_ name: String) throws -> (Project, [String: Any]) {
        let entry = try XCTUnwrap((try doc()["projects"] as? [String: Any])?[name] as? [String: Any])
        return (try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: entry["project"]!)), entry)
    }

    func testTheLineAndThePrintNoteAreTheContracts() throws {
        let doc = try doc()
        XCTAssertEqual(Project.DesignDraft.line, doc["line"] as? String)
        XCTAssertEqual(Project.DesignDraft.printNote, doc["printNote"] as? String)
        XCTAssertEqual(Project.DesignDraft.collapseAfter, doc["collapseAfter"] as? Int)
    }

    func testARoundFourDraftKeepsTheMCPsReasonsAsGivenAndCollapsesThem() throws {
        let (project, entry) = try project("round4")
        let draft = try XCTUnwrap(project.current?.draft)
        XCTAssertEqual(draft.reasons, entry["reasons"] as? [String], "word for word")
        XCTAssertTrue(draft.collapses)
        XCTAssertEqual(draft.shown(expanded: false), Array(draft.reasons.prefix(2)))
        XCTAssertEqual(draft.shown(expanded: true), draft.reasons)
        XCTAssertEqual(project.versions?.last?.result.draft, draft, "the sealed design is the same draft")
        XCTAssertEqual(project.showingDesign(project.versions?.last?.id).current?.draft, draft)
        let words = ProjectWords(project)
        XCTAssertEqual(words.phase, .ready, "Print and Ask for changes stay")
        XCTAssertEqual(words.line, Project.DesignDraft.line, "never presented as finished")
        XCTAssertTrue(words.actions.contains(.correct))
        XCTAssertEqual(try JSONDecoder().decode(Project.self, from: JSONEncoder().encode(project)).current?.draft, draft)
    }

    func testAnOlderMCPsDraftHasTheLineAndNoReasons() throws {
        let (project, _) = try project("older")
        let draft = try XCTUnwrap(project.current?.draft)
        XCTAssertEqual(draft.reasons, [])
        XCTAssertFalse(draft.collapses)
        var plain = project; plain.status = nil
        XCTAssertEqual(ProjectWords(plain).line, Project.DesignDraft.line, "an older Mac's own line aside, Kit says it too")
    }

    func testAFinishedDesignIsNoDraftAndBadReasonsAreLeftOut() throws {
        let (finished, _) = try project("finished")
        XCTAssertNil(finished.current?.draft)
        XCTAssertTrue(ProjectWords(finished).line.hasPrefix("Ready to print"))
        let odd = try JSONDecoder().decode(Project.DesignDraft.self, from: Data(#"{"reasons": ["Model the desk.", 3, "  ", null]}"#.utf8))
        XCTAssertEqual(odd.reasons, ["Model the desk."])
        XCTAssertEqual(try JSONDecoder().decode(Project.DesignDraft.self, from: Data(#"{"reasons": "not a list"}"#.utf8)).reasons, [])
    }
}
