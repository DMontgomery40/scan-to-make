import XCTest

/// One companion's objects, as the control socket serves them.
private actor FakeObjects: ObjectsCompanion {
    var items: [[String: Any]] = []
    var listError: Error?
    var actionError: Error?
    private(set) var calls: [String] = []
    private(set) var confirmationAnswer: PrintConfirmationAnswer?
    func set(_ items: [[String: Any]]) { self.items = items }
    func failList(with error: Error?) { listError = error }
    func failActions(with error: Error?) { actionError = error }

    private func decode(_ item: [String: Any]) throws -> StmObject {
        try JSONDecoder().decode(StmObject.self, from:JSONSerialization.data(withJSONObject:item))
    }
    private func change(_ id: String, _ call: String, _ fields: [String: Any]) throws -> StmObject {
        calls.append(call)
        if let actionError { throw actionError }
        guard let index = items.firstIndex(where: { $0["id"] as? String == id }) else { throw ControlRemoteError(code:"not-found", message:"gone") }
        items[index].merge(fields) { $1 }
        return try decode(items[index])
    }
    func objects() async throws -> [StmObject] {
        calls.append("list")
        if let listError { throw listError }
        return try items.map(decode)
    }
    func correct(_ id: String, note: String) async throws -> StmObject { try change(id, "correct:\(note)", ["state": "touching-up"]) }
    func answerCloseup(_ id: String, bestGuess: Bool) async throws -> StmObject { try change(id, "closeup:\(bestGuess)", ["state": "touching-up"]) }
    func print(_ id: String, checked: Bool) async throws -> StmObject { try change(id, "print:\(checked)", ["state": "printing"]) }
    func answerPlate(_ id: String) async throws -> StmObject { try change(id, "plate", ["plate": NSNull()]) }
    func answerPrintConfirmation(_ id: String, confirmationId: String, answer: PrintConfirmationAnswer) async throws -> StmObject {
        confirmationAnswer = answer
        return try change(id, "confirmation:\(confirmationId):\(answer.action.rawValue)", ["printConfirmation":NSNull()])
    }
    func start(_ id: String) async throws -> StmObject { try change(id, "start", ["state": "touching-up"]) }
    func delete(_ id: String) async throws {
        calls.append("delete:\(id)")
        if let actionError { throw actionError }
        guard let index = items.firstIndex(where: { $0["id"] as? String == id }) else { throw ControlRemoteError(code:"not-found", message:"gone") }
        items.remove(at:index)
    }
}

private func item(_ id: String, _ state: String, _ fields: [String: Any] = [:]) -> [String: Any] {
    ["id": id, "createdAtMs": 1, "updatedAtMs": 1, "state": state, "photos": [], "passes": [], "directory": "/tmp/\(id)",
     "current": ["model": "current/model.stl", "renders": []]].merging(fields) { $1 }
}

@MainActor final class ObjectsModelTests: XCTestCase {
    func testConfirmationRejectsStaleIncompleteAndPlateOnlyAnswers() async {
        let companion = FakeObjects()
        var question: [String: Any] = ["id":"q1", "message":"Check the actual printer.", "expiresAtMs":Date().timeIntervalSince1970 * 1000 + 60_000,
            "supported":true, "fields":[["name":"bed_clear", "title":"Bed is clear", "required":true]]]
        await companion.set([item("a", "printing", ["printConfirmation":question, "plate":["noCamera":true]])])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        let plate = await model.perform(.plateClear, on:"a")
        let incomplete = await model.answerPrintConfirmation("a", confirmationId:"q1", answer:.init(action:.accept))
        XCTAssertFalse(plate)
        XCTAssertFalse(incomplete)
        question["id"] = "q2"
        await companion.set([item("a", "printing", ["printConfirmation":question])])
        await model.refresh()
        let stale = await model.answerPrintConfirmation("a", confirmationId:"q1", answer:.init(action:.accept, content:["bed_clear":true]))
        XCTAssertFalse(stale)
        let before = await companion.calls
        XCTAssertFalse(before.contains { $0.hasPrefix("confirmation:") || $0 == "plate" })
        let accepted = await model.answerPrintConfirmation("a", confirmationId:"q2", answer:.init(action:.accept, content:["bed_clear":true]))
        XCTAssertTrue(accepted)
        let calls = await companion.calls
        XCTAssertEqual(calls.last, "confirmation:q2:accept")
        let answer = await companion.confirmationAnswer
        XCTAssertEqual(answer?.content, ["bed_clear":true])
        XCTAssertNil(model.selected?.printConfirmation)
    }

    func testUnsupportedAndExpiredConfirmationCanBeCanceledButNotAccepted() async {
        let companion = FakeObjects()
        await companion.set([item("a", "printing", ["printConfirmation":["id":"q", "message":"Unknown form", "expiresAtMs":1, "supported":false, "fields":[]]])])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        let accepted = await model.answerPrintConfirmation("a", confirmationId:"q", answer:.init(action:.accept, content:[:]))
        XCTAssertFalse(accepted)
        let canceled = await model.answerPrintConfirmation("a", confirmationId:"q", answer:.init(action:.cancel))
        XCTAssertTrue(canceled)
        let calls = await companion.calls
        XCTAssertEqual(calls.last, "confirmation:q:cancel")
    }

    func testReadsQuicklyOnlyWhileSomethingIsBusy() async {
        let companion = FakeObjects()
        await companion.set([item("a", "ready"), item("b", "printed")])
        let model = ObjectsModel(companion:companion)
        let idle = await model.refresh()
        XCTAssertEqual(idle, ObjectsModel.idleDelay)
        XCTAssertEqual(model.availability, .ready)
        XCTAssertEqual(model.selection, "a", "the newest object is shown first")
        await companion.set([item("c", "touching-up"), item("a", "ready")])
        let busy = await model.refresh()
        XCTAssertEqual(busy, 3)
        XCTAssertEqual(model.selection, "a", "a new object doesn't take over the page")
    }

    func testObjectsNotSetUpReadsAsOneStateNotAnError() async {
        let companion = FakeObjects()
        await companion.failList(with:ControlRemoteError(code:"unavailable", message:"The requested capability is unavailable"))
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        XCTAssertEqual(model.availability, .notSetUp)
        // A companion from before objects refuses the method itself; it answered, so it is running.
        await companion.failList(with:ControlRemoteError(code:"invalid-request", message:"Invalid local control request"))
        for _ in 0..<3 { await model.refresh() }
        XCTAssertEqual(model.availability, .notSetUp)
    }

    func testAMissingCompanionIsReportedOnlyAfterAFewTries() async {
        let companion = FakeObjects()
        await companion.set([item("a", "ready")])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        await companion.failList(with:ControlClientError.unavailable)
        await model.refresh(); await model.refresh()
        XCTAssertEqual(model.availability, .ready, "a restart shouldn't flash an error")
        XCTAssertEqual(model.objects.count, 1)
        await model.refresh()
        XCTAssertEqual(model.availability, .notRunning)
    }

    func testAnUncertainPrintIsSentWithCheckedAndTheResultShowsAtOnce() async {
        let companion = FakeObjects()
        await companion.set([item("a", "failed", ["print": ["bundleId": "b", "uncertain": true]])])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        XCTAssertEqual(model.selected?.words.actions.first, .printChecked)
        let sent = await model.perform(.printChecked, on:"a")
        XCTAssertTrue(sent)
        XCTAssertEqual(model.selected?.state, .printing)
        XCTAssertTrue(model.working.isEmpty)
        let calls = await companion.calls
        XCTAssertEqual(calls.last, "print:true")
    }

    func testCorrectionsAreTrimmedAndRefusalsSayOneSentence() async {
        let companion = FakeObjects()
        await companion.set([item("a", "ready")])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        await model.perform(.correct, on:"a", note:"  the clip is missing \n")
        let calls = await companion.calls
        XCTAssertEqual(calls.last, "correct:the clip is missing")
        await companion.failActions(with:ControlRemoteError(code:"conflict", message:"The requested operation conflicts with current state"))
        let refused = await model.perform(.print, on:"a")
        XCTAssertFalse(refused)
        XCTAssertEqual(model.problem, .init(id:"a", text:"That can't be done right now."), "an older Mac's generic refusal")
        await companion.failActions(with:ControlRemoteError(code:"conflict", message:"There is no model to print yet."))
        _ = await model.perform(.print, on:"a")
        XCTAssertEqual(model.problem, .init(id:"a", text:"There is no model to print yet."), "the Mac's own plain sentence")
        let after = await companion.calls
        XCTAssertEqual(after.last, "list", "a refusal reads the object again to show where it is now")
    }

    func testAFailedTouchUpStartsAgain() async {
        let companion = FakeObjects()
        await companion.set([item("b", "failed", ["failure": "Blender is not open on your Mac.", "current": NSNull()])])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        let started = await model.perform(.retry, on:"b")
        XCTAssertTrue(started)
        let calls = await companion.calls
        XCTAssertEqual(calls.last, "start")
    }

    func testPollingFollowsTheWindow() async {
        let model = ObjectsModel(companion:FakeObjects())
        model.setVisible(true)
        XCTAssertTrue(model.isPolling)
        model.setVisible(false)
        XCTAssertFalse(model.isPolling)
        model.wake()
        XCTAssertFalse(model.isPolling, "focusing a closed window doesn't start reading")
    }

    func testAnASCIIOrBinarySTLStandsUprightInMetres() throws {
        // A 100 mm box, Z-up in millimetres as slicers write it.
        let s: Float = 50, v: [SIMD3<Float>] = [[-s,-s,-s],[s,-s,-s],[s,s,-s],[-s,s,-s],[-s,-s,s],[s,-s,s],[s,s,s],[-s,s,s]]
        let faces = [(0,2,1),(0,3,2),(4,5,6),(4,6,7),(0,1,5),(0,5,4),(2,3,7),(2,7,6),(1,2,6),(1,6,5),(0,4,7),(0,7,3)]
        var ascii = "solid cube\n"
        for (a, b, c) in faces {
            ascii += "facet normal 0 0 0\nouter loop\n"
            for i in [a, b, c] { ascii += "vertex \(v[i].x) \(v[i].y) \(v[i].z + 50)\n" }
            ascii += "endloop\nendfacet\n"
        }
        let fromText = try XCTUnwrap(ModelMesh.stl(Data((ascii + "endsolid cube\n").utf8)))
        XCTAssertEqual(fromText.triangleCount, 12)
        XCTAssertEqual(fromText.bounds.min.y, 0, accuracy: 1e-6, "Z-up 0…100 mm becomes Y-up 0…0.1 m")
        XCTAssertEqual(fromText.bounds.max.y, 0.1, accuracy: 1e-6)
        var binary = Data(count: 80)
        binary.append(contentsOf: withUnsafeBytes(of: UInt32(faces.count).littleEndian, Array.init))
        for (a, b, c) in faces {
            let values: [Float] = [0, 0, 0] + [v[a], v[b], v[c]].flatMap { [$0.x, $0.y, $0.z + 50] }
            for value in values {
                binary.append(contentsOf: withUnsafeBytes(of: value.bitPattern.littleEndian, Array.init))
            }
            binary.append(contentsOf: [0, 0])
        }
        let fromBinary = try XCTUnwrap(ModelMesh.stl(binary))
        XCTAssertEqual(fromBinary.positions, fromText.positions, "both encodings read the same triangles")
        XCTAssertNil(ModelMesh.stl(Data("not a model".utf8)))
        XCTAssertNil(ModelMesh.stl(binary.dropLast(10)), "a truncated binary file is refused, not half drawn")
    }

    func testTheSidebarGroupsEveryProjectAndStartsAtTheTop() async {
        let companion = FakeObjects()
        await companion.set([item("p", "printed"), item("r", "ready"), item("n", "needs-closeup"), item("w", "touching-up"),
                             item("f", "failed"), item("x", "archived")])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        XCTAssertEqual(model.groups.map(\.group), [.now, .needsYou, .ready, .printed])
        XCTAssertEqual(model.groups.map { $0.objects.map(\.id) }, [["w", "x"], ["n", "f"], ["r"], ["p"]])
        XCTAssertEqual(model.ordered.count, 6, "no project falls out of the sidebar")
        XCTAssertEqual(model.selection, "w", "the first row in the sidebar is shown first")
    }

    func testANewProjectWaitsForACompanionThatCanStartOne() async {
        let model = ObjectsModel(companion:FakeObjects())
        await model.refresh()
        let refused = await model.startProject(instructions:"A hook", files:[])
        XCTAssertEqual(refused, ObjectsModel.createUnavailable, "an older companion: say so, never fail silently")
        XCTAssertEqual(ObjectsModel.fileKind(URL(fileURLWithPath:"/a/b.HEIC")), "photos")
        XCTAssertEqual(ObjectsModel.fileKind(URL(fileURLWithPath:"/a/b.3mf")), "scan")
        XCTAssertNil(ObjectsModel.fileKind(URL(fileURLWithPath:"/a/b.pdf")))
    }

    func testErrorSentencesNeverDumpTheError() {
        for error: Error in [ControlRemoteError(code:"internal", message:"stack trace"), ControlClientError.invalidResponse,
                             ControlClientError.timedOut, ControlClientError.unavailable, ControlRemoteError(code:"not-found", message:"x")] {
            let text = ObjectsModel.sentence(for:error)
            XCTAssertFalse(text.contains("stack") || text.contains("Error") || text.contains("companion"), text)
            XCTAssertTrue(text.hasSuffix("."), text)
        }
    }

    func testDeleteRemovesTheObjectAndShowsTheNextOne() async {
        let companion = FakeObjects()
        await companion.set([item("a", "ready"), item("b", "printed"), item("c", "failed")])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        model.selection = "b"
        let deleted = await model.delete("b")
        XCTAssertTrue(deleted)
        XCTAssertEqual(model.objects.map(\.id), ["a", "c"])
        XCTAssertEqual(model.selection, "c", "the page moves to the next object, not back to the top")
        let calls = await companion.calls
        XCTAssertTrue(calls.contains("delete:b"))
        await model.refresh()
        XCTAssertEqual(model.objects.map(\.id), ["a", "c"], "it stays gone after the next read")
    }

    func testDeletingTheLastObjectSelectsTheOneBefore() async {
        let companion = FakeObjects()
        await companion.set([item("a", "ready"), item("b", "printed")])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        model.selection = "b"
        _ = await model.delete("b")
        XCTAssertEqual(model.selection, "a")
        _ = await model.delete("a")
        XCTAssertNil(model.selection)
        XCTAssertTrue(model.objects.isEmpty)
    }

    func testADeleteThatFailsKeepsTheObjectAndSaysWhy() async {
        let companion = FakeObjects()
        await companion.set([item("a", "ready"), item("b", "printing")])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        model.selection = "b"
        await companion.failActions(with:ControlRemoteError(code:"conflict", message:"This is printing. Delete it once the print is done."))
        let deleted = await model.delete("b")
        XCTAssertFalse(deleted)
        XCTAssertEqual(model.objects.map(\.id), ["a", "b"])
        XCTAssertEqual(model.selection, "b")
        XCTAssertEqual(model.problem, ObjectsModel.Problem(id:"b", text:"This is printing. Delete it once the print is done."))
    }
}
