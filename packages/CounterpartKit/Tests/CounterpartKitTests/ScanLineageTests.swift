import XCTest
@testable import CounterpartKit

/// "Make something else from this scan" (design §3.3): which projects offer it, and what both pages say about where a
/// scan came from. The cases are `Fixtures/scan-lineage.json`, read by the Android suite too: the same lines everywhere.
final class ScanLineageTests: XCTestCase {
    private struct Cases { let document: [String: Any]; let projects: [String: Project] }
    private func cases() throws -> Cases {
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("scan-lineage.json")) as? [String: Any])
        let raw = try XCTUnwrap(document["projects"] as? [String: [String: Any]])
        return Cases(document: document, projects: try raw.mapValues { try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: $0)) })
    }
    private func pick(_ keys: Any?, _ projects: [String: Project]) throws -> [Project] {
        try (keys as? [String] ?? []).map { try XCTUnwrap(projects[$0], "no project \($0) in the fixture") }
    }

    func testTheWordsAreTheSameEverywhere() throws {
        let words = try XCTUnwrap(try cases().document["words"] as? [String: String])
        XCTAssertEqual(ScanLineage.action, words["action"])
        XCTAssertEqual(ScanLineage.fitChoice, words["fitChoice"])
        XCTAssertEqual(ScanLineage.copyChoice, words["copyChoice"])
        XCTAssertEqual(ScanLineage.useExisting, words["useExisting"])
    }

    func testEveryProjectTheMacHasAScanForOffersItWhateverItsKind() throws {
        let c = try cases()
        let rows = try XCTUnwrap(c.document["canMakeFromScan"] as? [[String: Any]])
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let project = try XCTUnwrap(c.projects[row["project"] as? String ?? ""])
            XCTAssertEqual(project.canMakeFromScan, row["expected"] as? Bool, row["why"] as? String ?? "")
        }
    }

    func testBothPagesSayWhereTheScanCameFromAndWhatElseWasMade() throws {
        let c = try cases()
        let rows = try XCTUnwrap(c.document["lineage"] as? [[String: Any]])
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let name = row["name"] as? String ?? ""
            let project = try XCTUnwrap(c.projects[row["project"] as? String ?? ""], name)
            let lineage = ScanLineage(project, in: try pick(row["among"], c.projects))
            XCTAssertEqual(lineage.fromLine, row["fromLine"] as? String, name)
            XCTAssertEqual(lineage.from?.exists, row["fromExists"] as? Bool, name)
            XCTAssertEqual(lineage.madeLine, row["madeLine"] as? String, name)
            XCTAssertEqual(lineage.made.map(\.id), row["made"] as? [String] ?? [], name)
        }
    }

    func testNewOffersEveryScanTheMacHasNewestFirst() throws {
        let c = try cases()
        let scans = try XCTUnwrap(c.document["scans"] as? [String: Any])
        XCTAssertEqual(ScanLineage.scans(in: try pick(scans["among"], c.projects)).map(\.id), scans["expected"] as? [String])
        let line = ScanLineage.scannedLine(project(["state": "ready", "scan": "scan.usdz", "createdAtMs": 1_762_243_200_000]),
                                           locale: Locale(identifier: "en_US"), timeZone: TimeZone(identifier: "America/Denver")!)
        XCTAssertEqual(line, "scanned Nov 4")
    }

    func testTheRequestAsksForTheChosenKindWithTheWordsAndAFitsSizeChoice() throws {
        let fit = CompanionClient.makeFromScanBody(kind: "fit", instructions: " a belt case for it ", fit: ProjectFit(sizeSource: .scan, measured: []))
        XCTAssertEqual(fit["kind"] as? String, "fit")
        XCTAssertEqual(fit["instructions"] as? String, "a belt case for it")
        XCTAssertNotNil(fit["fit"])
        let copy = CompanionClient.makeFromScanBody(kind: "copy", instructions: "", fit: ProjectFit(sizeSource: .scan, measured: []))
        XCTAssertEqual(copy["kind"] as? String, "copy")
        XCTAssertNil(copy["instructions"]); XCTAssertNil(copy["fit"], "only a fit says how its size is settled")
    }

    /// The client refuses a path it has no scope for ("That request isn't allowed", seen on David's real data, Nov 11).
    func testTheRouteNeedsTheScopeNewAlreadyUses() {
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/objects/6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01/make-from-scan"), "captures:import")
    }

    func testMakingFromAScanIsASheetThatHoldsWork() {
        var nav = ProjectsNavigation()
        nav.open("src")
        nav.present(.newFromScan("src"))
        XCTAssertEqual(nav.sheet, .newFromScan("src"))
        XCTAssertTrue(nav.sheetHoldsWork, "a notification must not throw away the words typed for it")
        nav.apply(.printers)
        XCTAssertEqual(nav.sheet, .newFromScan("src"))
    }
}
