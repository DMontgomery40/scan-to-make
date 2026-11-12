import XCTest
@testable import CounterpartKit

final class DesignHistoryTests: XCTestCase {
    func testPrintedAndReadyAreBothTrueAndAnEarlierDesignHasOnlyItsOwnFiles() throws {
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("project-versions.json")) as? [String: Any])
        let project = try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: raw["project"]!))
        let expected = try XCTUnwrap(raw["expected"] as? [String: Any])
        let history = DesignHistory(project)
        XCTAssertEqual(ProjectWords.phase(project), .ready)
        XCTAssertEqual(ProjectWords(project).line, expected["line"] as? String)
        XCTAssertEqual(history.have.map(\.id), expected["have"] as? [String])
        XCTAssertEqual(history.earlier.map(\.id), expected["earlier"] as? [String])
        let printed = try XCTUnwrap(history.have.first)
        XCTAssertEqual(printed.outcome, "works")
        let view = project.showingDesign(printed.id)
        XCTAssertEqual(view.current?.model, printed.result.model)
        XCTAssertEqual(view.picture, printed.picture)
        XCTAssertEqual(view.current?.sizeMm, [60, 40, 20])
        XCTAssertEqual(view.print?.destination?.name, "Workshop printer")
        XCTAssertNotEqual(view.current?.model, project.current?.model)
        XCTAssertEqual(ProjectGallery(project: view).first?.drawing, .model(printed.result.model))
        XCTAssertEqual(try JSONDecoder().decode(Project.self, from: JSONEncoder().encode(project)).versions, project.versions)
        XCTAssertEqual(history.sealedLine(passStartedAtMs: 1), nil)
    }

    private func versions() throws -> Project {
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("project-versions.json")) as? [String: Any])
        return try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: raw["project"]!))
    }

    /// #616's own complaint, the other way round: what David marked Done must not move back to Ready because the
    /// print that made it Done isn't in the records (the Vernier caliper has one design and no print attempts).
    func testDoneStaysDoneWhateverThePrintRecordsSay() throws {
        var project = try versions()
        project.state = .confirmed; project.outcome = "works"
        project.versions![2].outcome = "works"
        XCTAssertEqual(ProjectWords.phase(project), .confirmed)
        XCTAssertNil(DesignHistory(project).line)
        // The pink box: its newest design answered It works, with only a failed attempt on record.
        project.prints!.append(.init(id: "failed", versionId: project.versions![2].id, startedAtMs: 1793990000000, bundleId: "b",
                                     monitor: .init(phase: "ended", endState: "failed")))
        XCTAssertEqual(ProjectWords.phase(project), .confirmed)
        XCTAssertEqual(DesignHistory(project).have.map(\.id), [project.versions![2].id, project.versions![0].id])
        // One design and nothing else: the page and the list read exactly as before.
        project.versions = [project.versions![2]]; project.prints = []
        XCTAssertFalse(DesignHistory(project).showsSections)
        XCTAssertEqual(ProjectWords.phase(project), .confirmed)
    }

    func testTheMacsWordsWinAndActivityNamesTheSealingPass() throws {
        var project = try versions()
        project.status = .init(phase: "ready", text: "New one ready · printed Nov 4", symbol: "checkmark.seal", tint: "accent")
        XCTAssertEqual(ProjectWords(project).line, "New one ready · printed Nov 4")
        project.versions![1].passStartedAtMs = 1793836000000
        XCTAssertEqual(DesignHistory(project).sealedLine(passStartedAtMs: 1793836000000), "This became the \(DesignHistory.date(project.versions![1].sealedAtMs)) design")
        XCTAssertNil(DesignHistory(project).sealedLine(passStartedAtMs: 5))
        // A multi-part design (the pink box's decorated lid) is drawn from the merged STL sealed beside its 3MF.
        XCTAssertEqual(Project.versionMesh("versions/abc/touched.3mf"), "versions/abc/model.stl")
        XCTAssertEqual(Project.versionMesh("versions/abc/touched.stl"), "versions/abc/touched.stl")
    }
}
