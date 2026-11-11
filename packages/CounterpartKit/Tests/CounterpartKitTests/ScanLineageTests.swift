import XCTest
@testable import CounterpartKit

/// "Make something else from this scan" (design §3.3): which projects offer it, and what both pages say about where a
/// scan came from. The Android (`ScanLineageTest`) and Linux (`domain.test.ts`) ports check the same lines.
final class ScanLineageTests: XCTestCase {
    private let leatherman = project(["id": "src", "title": "Leatherman Wave+ replica", "kind": "copy", "state": "ready", "scan": "scan.usdz", "createdAtMs": 1_000])
    private func made(_ id: String, _ title: String, at ms: Double) -> Project {
        project(["id": id, "title": title, "kind": "fit", "state": "ready", "scan": "scan.usdz", "createdAtMs": ms, "scanFrom": ["id": "src", "title": "Leatherman Wave+ replica"]])
    }

    func testEveryProjectTheMacHasAScanForOffersItWhateverItsKind() {
        XCTAssertTrue(leatherman.canMakeFromScan, "a copy's scan can become a fit: the Leatherman")
        XCTAssertTrue(project(["state": "ready", "kind": "fit", "scan": "scan.usdz"]).canMakeFromScan)
        XCTAssertFalse(project(["state": "new", "capture": ["0001.heic"]]).canMakeFromScan, "a scan still on its way isn't one the Mac has")
        XCTAssertFalse(project(["state": "ready", "kind": "fit", "instructions": "A hook"]).canMakeFromScan)
        XCTAssertEqual(ScanLineage.action, "Make something else from this scan")
        XCTAssertEqual(ScanLineage.fitChoice, "Make something that fits this")
        XCTAssertEqual(ScanLineage.copyChoice, "Copy this object")
    }

    func testBothPagesSayWhereTheScanCameFrom() {
        let belt = made("belt", "Belt case", at: 2_000), clip = made("clip", "Pocket clip", at: 3_000)
        let all = [leatherman, belt, clip]
        XCTAssertEqual(ScanLineage(belt, in: all).fromLine, "Uses the scan from “Leatherman Wave+ replica”")
        XCTAssertEqual(ScanLineage(belt, in: all).from?.exists, true)
        XCTAssertNil(ScanLineage(leatherman, in: all).fromLine)
        XCTAssertEqual(ScanLineage(leatherman, in: [leatherman, belt]).madeLine, "Also made from this scan: “Belt case”")
        XCTAssertEqual(ScanLineage(leatherman, in: all).madeLine, "Also made from this scan: 2 projects")
        XCTAssertEqual(ScanLineage(leatherman, in: all).made.map(\.id), ["clip", "belt"], "newest first")
        XCTAssertNil(ScanLineage(belt, in: all).madeLine)
    }

    func testARenamedSourceReadsByItsNameNowAndADeletedOneSaysSo() {
        var renamed = leatherman; renamed.title = "Leatherman Wave+"
        let belt = made("belt", "Belt case", at: 2_000)
        XCTAssertEqual(ScanLineage(belt, in: [renamed, belt]).fromLine, "Uses the scan from “Leatherman Wave+”")
        let gone = ScanLineage(belt, in: [belt])
        XCTAssertEqual(gone.fromLine, "Uses the scan from “Leatherman Wave+ replica”, since deleted")
        XCTAssertEqual(gone.from?.exists, false, "nothing to open")
    }

    func testNewOffersEveryScanTheMacHasNewestFirst() {
        let belt = made("belt", "Belt case", at: 2_000)
        let words = project(["id": "w", "state": "ready", "instructions": "A hook", "createdAtMs": 5_000])
        XCTAssertEqual(ScanLineage.scans(in: [leatherman, words, belt]).map(\.id), ["belt", "src"])
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
