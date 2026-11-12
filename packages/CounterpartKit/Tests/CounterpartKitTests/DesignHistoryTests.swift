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

    /// The hanger's Nov 4 design on David's Mac: three attempts kept only as frame folders, ends unknown. It went to the
    /// printer, so it never reads "Not printed yet", and on the stage it is "Sent to your printer", not "Ready to print".
    func testADesignWhosePrintsEndedUnknownIsNeverCalledUnprinted() throws {
        var project = try versions()
        let middle = project.versions![1]
        project.prints = (1...3).map { .init(id: "frames-\($0)", versionId: middle.id, startedAtMs: 1793791652751 + Double($0), bundleId: "frames-\($0)") }
        let history = DesignHistory(project)
        XCTAssertNil(history.printedAt(middle))
        XCTAssertEqual(history.printedLine(middle), "Sent to the printer 3 times · how they ended wasn’t kept")
        XCTAssertEqual(project.showingDesign(middle.id).state, .sent)
        XCTAssertEqual(ProjectWords.phase(project.showingDesign(middle.id)), .sent)
        // Attempts that all ended without printing: said plainly, and the design is ready to try again.
        project.prints = [.init(id: "failed", versionId: middle.id, startedAtMs: 1, bundleId: "b", monitor: .init(phase: "ended", endState: "failed"))]
        XCTAssertEqual(DesignHistory(project).printedLine(middle), "Not printed · 1 try didn’t finish")
        XCTAssertEqual(project.showingDesign(middle.id).state, .ready)
    }

    /// Train 11-12b review (Codex P2): the camera check (#630) saw nothing coming out and the firmware then said done.
    /// The earlier design is not "Printed · Did it fit?": its line keeps the MCP's warning, and it isn't in What you have.
    func testAPrintTheCameraFlaggedIsNeverAPrintedDesign() throws {
        var project = try versions()
        let middle = project.versions![1]
        let words = "Nothing is coming out of the nozzle."
        project.prints = [.init(id: "flagged", versionId: middle.id, startedAtMs: 1793791652751, bundleId: "b",
                                monitor: .init(phase: "ended", endState: "done", endedAt: "2026-11-07T22:00:00Z", checkSent: true, checkMessage: words))]
        let history = DesignHistory(project)
        XCTAssertNil(history.printedAt(middle))
        XCTAssertFalse(history.have.contains { $0.id == middle.id })
        XCTAssertEqual(history.printedLine(middle), "The printer says it finished · \(words)")
        XCTAssertNotEqual(history.outcomeLine(middle), "Did it fit?")
        // The companion's record decodes with its check fields.
        let monitor = try JSONDecoder().decode(Project.PrintMonitor.self, from: Data(#"{"phase":"ended","endState":"done","checkSent":true,"checkMessage":"Nothing is coming out of the nozzle."}"#.utf8))
        XCTAssertEqual(monitor.checkSent, true); XCTAssertEqual(monitor.checkMessage, words); XCTAssertFalse(monitor.printedOut)
        // The same print without the flag is a print.
        project.prints![0].monitor?.checkSent = nil
        XCTAssertNotNil(DesignHistory(project).printedAt(middle))
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

    /// #769, David (Nov 12, build 202611121212): "Already printed items no longer have explore in 3D or AR, some do actually
    /// but some don't". His records: a sealed design is `versions/<id>/touched.stl` or `touched.3mf` (never `model.stl`, which
    /// this fixture used to say), and a multi-part design's model is `current/model.3mf` with its merged `current/model.stl`
    /// beside it. Every design on the stage, the newest or one opened from history, turns in 3D and offers AR from its own mesh.
    func testEveryPrintedDesignOnTheStageTurnsInThreeDAndOffersARFromItsOwnMesh() throws {
        var project = try versions()
        let history = DesignHistory(project)
        let printed = try XCTUnwrap(history.have.first), wider = try XCTUnwrap(history.earlier.first)
        XCTAssertTrue(printed.result.model.hasSuffix("/touched.stl"), "the fixture is shaped like David's records")
        XCTAssertTrue(wider.result.model.hasSuffix("/touched.3mf"), "the fixture is shaped like David's records")

        // A printed earlier design sealed as touched.stl: its own file, in 3D and in AR.
        let one = try XCTUnwrap(ProjectGallery(project: project.showingDesign(printed.id)).first)
        XCTAssertEqual(one.drawing, .model("versions/\(printed.id)/touched.stl"))
        XCTAssertEqual(project.showingDesign(printed.id).partMesh, "versions/\(printed.id)/touched.stl")
        XCTAssertEqual(one.arMesh, "versions/\(printed.id)/touched.stl", "an earlier design offers AR (it never did: the chip took only model.stl)")

        // A sealed multi-part design (touched.3mf): the merged STL sealed beside it, neutral until the MCPs report its parts' colours (#645).
        let lid = try XCTUnwrap(ProjectGallery(project: project.showingDesign(wider.id)).first)
        XCTAssertEqual(lid.drawing, .model("versions/\(wider.id)/model.stl"), "a 3MF design is drawn, not only pictured")
        XCTAssertEqual(lid.colour, .neutral)
        XCTAssertEqual(lid.arMesh, "versions/\(wider.id)/model.stl")

        // The newest design is a multi-part 3MF (Pink snap-lid box, Caliper card logo, Guitar pick): its merged current/model.stl.
        project.current?.model = "current/model.3mf"
        let box = try XCTUnwrap(ProjectGallery(project: project).first)
        XCTAssertEqual(box.drawing, .model("current/model.stl"))
        XCTAssertEqual(project.partMesh, "current/model.stl")
        XCTAssertEqual(box.colour, .neutral)
        XCTAssertEqual(box.arMesh, "current/model.stl")

        // A one-colour STL newest still draws the page's own model.
        project.current?.model = "current/model.stl"
        XCTAssertEqual(project.partMesh, "model.stl")
        XCTAssertEqual(ProjectGallery(project: project).first?.arMesh, "model.stl")

        // A designer's published 3MF has no merged mesh: its picture, and no AR from it.
        project.kind = "published"; project.current?.model = "original/abc-lid.3mf"
        XCTAssertNil(project.partMesh)
        XCTAssertEqual(ProjectGallery(project: project).first?.drawing, .picture(""))
        XCTAssertNil(ProjectGallery(project: project).first?.arMesh)
    }
}
