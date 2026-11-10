import XCTest
@testable import CounterpartKit

/// PRD §5.4 One main action (board U17). The table is `Fixtures/main-actions.json`, read by the Android and Linux
/// suites too: the same decision on every layout.
final class PageActionsTests: XCTestCase {
    private struct Row { let number: Int; let name: String; let sending: Bool; let project: Project; let main: String?; let others: [String]; let printWords: String?; let printPlace: String?; let printNote: String? }

    private func rows() throws -> [Row] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/main-actions.json")
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try (document["rows"] as? [[String: Any]] ?? []).map { row in
            let expected = try XCTUnwrap(row["expected"] as? [String: Any])
            let project = try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: try XCTUnwrap(row["project"])))
            return Row(number: row["row"] as? Int ?? 0, name: row["name"] as? String ?? "", sending: row["sending"] as? Bool ?? false, project: project,
                       main: expected["main"] as? String, others: expected["others"] as? [String] ?? [],
                       printWords: expected["printWords"] as? String, printPlace: expected["printPlace"] as? String, printNote: expected["printNote"] as? String)
        }
    }

    func testEveryStateHasItsOneMainActionAndSaysWherePrintingGoes() throws {
        let rows = try rows()
        XCTAssertEqual(Set(rows.map(\.number)), Set(1...16), "one row at least for each state of the table")
        for row in rows {
            let page = ProjectWords(row.project, sending: row.sending).page
            XCTAssertEqual(page.main?.rawValue, row.main, "\(row.name): main")
            XCTAssertEqual(page.others.map { "\($0)" }, row.others, "\(row.name): others")
            XCTAssertEqual(page.printWords, row.printWords, "\(row.name): what printing is called")
            XCTAssertEqual(page.printPlace?.rawValue, row.printPlace, "\(row.name): where printing goes")
            XCTAssertEqual(page.printNote, row.printNote, "\(row.name): what would be printed")
        }
    }

    /// The rule the table follows, held for every row: one lead, each action once, Print filled only when it leads,
    /// and never in the bar when a card already offers it.
    func testAnActionAppearsOnceAndPrintIsFilledOnlyWhenItLeads() throws {
        for row in try rows() {
            let words = ProjectWords(row.project, sending: row.sending)
            let page = words.page
            XCTAssertEqual(Set(page.others.map { "\($0)" }).count, page.others.count, "\(row.name): an action twice")
            let prints = page.others.filter { $0 == .print || $0 == .printChecked }
            XCTAssertEqual(page.printWords != nil, page.printIsMain || !prints.isEmpty, "\(row.name): printing is named exactly when it is offered")
            XCTAssertFalse(page.printIsMain && !prints.isEmpty, "\(row.name): Print leads and is also listed")
            XCTAssertEqual(page.printPlace != nil, page.printWords != nil, row.name)
            if let main = page.main { XCTAssertFalse(page.others.map { "\($0)" }.contains(main.rawValue), "\(row.name): the lead is listed again") }
        }
        // The pair the capture showed (row 14): Try Again leads; the earlier result prints from the card, once, under
        // its true name; the bar keeps Ask for changes and no Print.
        let stopped = try XCTUnwrap(try rows().first { $0.name == "pass-stopped-earlier-result" })
        let page = ProjectWords(stopped.project).page
        XCTAssertEqual(page.main, .retry)
        XCTAssertEqual(page.printWords, "Print the last version")
        XCTAssertFalse(page.printInBar)
        XCTAssertFalse(page.printIsMain)
    }
}
