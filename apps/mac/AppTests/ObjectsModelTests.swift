import XCTest

/// One companion's objects, as the control socket serves them.
private actor FakeObjects: ObjectsCompanion {
    var items: [[String: Any]] = []
    var listError: Error?
    var actionError: Error?
    private(set) var calls: [String] = []
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
}

private func item(_ id: String, _ state: String, _ fields: [String: Any] = [:]) -> [String: Any] {
    ["id": id, "createdAtMs": 1, "updatedAtMs": 1, "state": state, "photos": [], "passes": [], "directory": "/tmp/\(id)",
     "current": ["model": "current/model.stl", "renders": []]].merging(fields) { $1 }
}

@MainActor final class ObjectsModelTests: XCTestCase {
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
        XCTAssertEqual(model.problem, .init(id:"a", text:"That can't be done right now."))
        let after = await companion.calls
        XCTAssertEqual(after.last, "list", "a refusal reads the object again to show where it is now")
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

    func testErrorSentencesNeverDumpTheError() {
        for error: Error in [ControlRemoteError(code:"internal", message:"stack trace"), ControlClientError.invalidResponse,
                             ControlClientError.timedOut, ControlClientError.unavailable, ControlRemoteError(code:"not-found", message:"x")] {
            let text = ObjectsModel.sentence(for:error)
            XCTAssertFalse(text.contains("stack") || text.contains("Error") || text.contains("companion"), text)
            XCTAssertTrue(text.hasSuffix("."), text)
        }
    }
}
