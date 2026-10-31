import XCTest
import AgentKit

/// One companion, as on a real Mac: modelAccess.set needs the current revision and a stale one conflicts.
private actor FakeCompanion: ModelAccessCompanion {
    private(set) var revision = UUID()
    private(set) var choice: ModelAccessChoice = .none
    private(set) var submitted: [ModelAccessChoice] = []
    private var conflicts = 0
    private var down = false
    func injectConflicts(_ count: Int) { conflicts = count }
    func goDown() { down = true }

    func modelAccess() async throws -> ModelAccessSnapshot { try snapshot(check:nil) }
    func setModelAccess(_ choice: ModelAccessChoice, expectedRevision: UUID) async throws -> ModelAccessSnapshot {
        if down { throw ControlClientError.unavailable }
        if conflicts > 0 { conflicts -= 1; revision = UUID(); throw ControlRemoteError(code:"conflict", message:"stale revision") }
        guard expectedRevision == revision else { throw ControlRemoteError(code:"conflict", message:"stale revision") }
        self.choice = choice
        revision = UUID()
        submitted.append(choice)
        return try snapshot(check:nil)
    }
    func checkModelAccess(revision: UUID) async throws -> ModelAccessSnapshot {
        guard revision == self.revision else { throw ControlRemoteError(code:"conflict", message:"stale revision") }
        return try snapshot(check:"connected")
    }
    private func snapshot(check state: String?) throws -> ModelAccessSnapshot {
        var json: [String: Any] = ["revision": revision.uuidString,
                                   "choice": try JSONSerialization.jsonObject(with:JSONEncoder().encode(choice))]
        json["check"] = state.map { ["id": UUID().uuidString, "revision": revision.uuidString, "state": $0] } ?? NSNull()
        return try JSONDecoder().decode(ModelAccessSnapshot.self, from:JSONSerialization.data(withJSONObject:json))
    }
}

@MainActor final class ModelAccessModelTests: XCTestCase {
    /// The consent bug: setup still shows "none" after Settings turned AI on; skipping must turn it off again.
    func testSkipTurnsOffAIChosenInAnotherWindow() async throws {
        let companion = FakeCompanion()
        let setup = ModelAccessModel(companion:companion)
        let settings = ModelAccessModel(companion:companion)
        await setup.refresh()
        await settings.refresh()
        let chose = await settings.choose(.claudeCode)
        XCTAssertTrue(chose)
        XCTAssertEqual(setup.snapshot?.choice, ModelAccessChoice.none, "setup's snapshot is stale on purpose")
        let skipped = await setup.skipAI()
        XCTAssertTrue(skipped)
        let current = await companion.choice
        XCTAssertEqual(current, ModelAccessChoice.none)
        XCTAssertEqual(setup.snapshot?.choice, ModelAccessChoice.none)
    }

    /// Skipping submits "none" even when the companion already holds it, so the confirmation is fresh.
    func testSkipAlwaysSubmitsNone() async throws {
        let companion = FakeCompanion()
        let setup = ModelAccessModel(companion:companion)
        await setup.refresh()
        let skipped = await setup.skipAI()
        XCTAssertTrue(skipped)
        let submitted = await companion.submitted
        XCTAssertEqual(submitted, [ModelAccessChoice.none])
    }

    func testSkipRetriesAfterARevisionConflict() async throws {
        let companion = FakeCompanion()
        let setup = ModelAccessModel(companion:companion)
        await companion.injectConflicts(1)
        let skipped = await setup.skipAI()
        XCTAssertTrue(skipped)
        let current = await companion.choice
        XCTAssertEqual(current, ModelAccessChoice.none)
        XCTAssertNil(setup.problem)
    }

    /// When the companion can't confirm, setup must stay open and say so.
    func testSkipFailsWithoutConfirmation() async throws {
        let companion = FakeCompanion()
        let setup = ModelAccessModel(companion:companion)
        let settings = ModelAccessModel(companion:companion)
        await settings.refresh()
        _ = await settings.choose(.claudeCode)
        await companion.goDown()
        let skipped = await setup.skipAI()
        XCTAssertFalse(skipped)
        XCTAssertNotNil(setup.problem)
        let current = await companion.choice
        XCTAssertEqual(current, ModelAccessChoice.claudeCode)
    }
}
