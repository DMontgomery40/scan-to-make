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
    }
}
