import XCTest

private actor FakeNearby: NearbyCompanion {
    var enabled = true
    var items: [[String: Any]] = []
    var answerError: Error?
    var statusError: Error?
    var listError: Error?
    func failStatus(with error: Error?) { statusError = error }
    func failList(with error: Error?) { listError = error }
    func remove(id: String) { items.removeAll { $0["id"] as? String == id } }
    private(set) var listCalls = 0
    private(set) var answers: [(String, Bool)] = []
    func set(enabled: Bool) { self.enabled = enabled }
    func add(id: String, name: String = "David's iPhone", code: String = "482913", expiresAt: Double) {
        items.append(["id": id, "deviceName": name, "code": code, "expiresAt": expiresAt])
    }
    func failAnswers(with error: Error) { answerError = error }

    func nearbyPairingEnabled() async throws -> Bool {
        if let statusError { throw statusError }
        return enabled
    }
    func nearbyRequests() async throws -> [ControlNearbyRequest] {
        listCalls += 1
        if let listError { throw listError }
        return try JSONDecoder().decode([ControlNearbyRequest].self, from:JSONSerialization.data(withJSONObject:items))
    }
    func answerNearby(_ id: String, allow: Bool) async throws {
        answers.append((id, allow))
        if let answerError { throw answerError }
        items.removeAll { $0["id"] as? String == id }
    }
}

@MainActor final class NearbyModelTests: XCTestCase {
    private let soon = (Date().timeIntervalSince1970 + 120) * 1000

    func testListsOnlyWhileNearbyPairingIsOn() async {
        let companion = FakeNearby()
        await companion.set(enabled:false)
        await companion.add(id:"a", expiresAt:soon)
        let model = NearbyModel(companion:companion)
        let idle = await model.poll()
        XCTAssertEqual(idle, 30)
        let quietCalls = await companion.listCalls
        XCTAssertEqual(quietCalls, 0)
        XCTAssertTrue(model.requests.isEmpty)
        await companion.set(enabled:true)
        let active = await model.poll()
        XCTAssertEqual(active, 2)
        XCTAssertEqual(model.requests.map(\.id), ["a"])
        XCTAssertEqual(NearbyModel.format(model.requests[0].code), "482 913")
    }

    func testExpiredRequestsAreNotShown() async {
        let companion = FakeNearby()
        await companion.add(id:"old", expiresAt:(Date().timeIntervalSince1970 - 1) * 1000)
        await companion.add(id:"new", expiresAt:soon)
        let model = NearbyModel(companion:companion)
        await model.poll()
        XCTAssertEqual(model.requests.map(\.id), ["new"])
    }

    func testAllowAnswersOnceAndRemovesTheCard() async {
        let companion = FakeNearby()
        await companion.add(id:"a", expiresAt:soon)
        let model = NearbyModel(companion:companion)
        await model.poll()
        await model.answer(model.requests[0], allow:true)
        let answers = await companion.answers
        XCTAssertEqual(answers.map(\.0), ["a"])
        XCTAssertEqual(answers.map(\.1), [true])
        XCTAssertTrue(model.requests.isEmpty)
        XCTAssertTrue(model.answering.isEmpty)
    }

    /// not-found: the request expired or was answered elsewhere. Drop the card and list again.
    func testNotFoundDropsTheCardAndListsAgain() async {
        let companion = FakeNearby()
        await companion.add(id:"a", expiresAt:soon)
        let model = NearbyModel(companion:companion)
        await model.poll()
        await companion.failAnswers(with:ControlRemoteError(code:"not-found", message:"gone"))
        let before = await companion.listCalls
        await model.answer(model.requests[0], allow:true)
        let after = await companion.listCalls
        XCTAssertEqual(after, before + 1)
        XCTAssertNil(model.problem)
    }

    /// A timeout has an unknown outcome: list again and say so, but never resend.
    func testTimeoutListsAgainWithoutResending() async {
        let companion = FakeNearby()
        await companion.add(id:"a", expiresAt:soon)
        let model = NearbyModel(companion:companion)
        await model.poll()
        await companion.failAnswers(with:ControlClientError.timedOut)
        await model.answer(model.requests[0], allow:true)
        let answers = await companion.answers
        XCTAssertEqual(answers.count, 1)
        XCTAssertNotNil(model.problem)
        XCTAssertEqual(model.requests.map(\.id), ["a"], "still listed by the companion, so the user can answer again")
    }

    /// The companion may still be starting: ask again in 2 s, not 30.
    func testUnreachableCompanionIsAskedAgainSoon() async {
        let companion = FakeNearby()
        await companion.failStatus(with:ControlClientError.unavailable)
        let model = NearbyModel(companion:companion)
        let delay = await model.poll()
        XCTAssertEqual(delay, 2)
        await companion.failStatus(with:nil)
        await companion.add(id:"a", expiresAt:soon)
        await model.poll()
        XCTAssertEqual(model.requests.map(\.id), ["a"])
    }

    /// A failed read isn't an empty list: the card stays while the phone is still waiting.
    func testFailedListKeepsTheCards() async {
        let companion = FakeNearby()
        await companion.add(id:"a", expiresAt:soon)
        let model = NearbyModel(companion:companion)
        await model.poll()
        await companion.failList(with:ControlClientError.timedOut)
        await model.poll()
        XCTAssertEqual(model.requests.map(\.id), ["a"])
    }

    /// An answer's error belongs to its own card and goes away with that request.
    func testProblemStaysWithItsRequestAndClearsWhenItGoes() async {
        let companion = FakeNearby()
        await companion.add(id:"a", expiresAt:soon)
        await companion.add(id:"b", expiresAt:soon)
        let model = NearbyModel(companion:companion)
        await model.poll()
        await companion.failAnswers(with:ControlClientError.timedOut)
        await model.answer(model.requests[0], allow:true)
        XCTAssertEqual(model.problem?.requestID, "a")
        await companion.remove(id:"a")
        await model.poll()
        XCTAssertNil(model.problem)
        XCTAssertEqual(model.requests.map(\.id), ["b"])
    }
}
