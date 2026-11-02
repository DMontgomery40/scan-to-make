import XCTest
@testable import CounterpartKit

/// KAN-217 state fix: reads applied in the order they started, and the one Ask-for-changes rule.
final class ProjectStateTests: XCTestCase {
    private let id = "2f0a0229-1b2c-4d5e-8f90-0a1b2c3d4e5f"
    private let current: [String: Any] = ["model": "current/model.stl", "renders": [], "sizeMm": [40, 30, 20]]
    private func stove(_ state: String, _ more: [String: Any] = [:]) -> Project {
        project(["id": id, "state": state, "current": current, "passes": [["startedAtMs": 1, "endedAtMs": 2, "status": "done"]]].merging(more) { $1 })
    }

    /// The Stove gap filler: `pass.ready`, then `pass.started` 182 ms later. Each triggers a read; the first read
    /// answers last. The project must end up working, not "Ready to print".
    func testReadyThenStartedEndsWorkingEvenWhenTheFirstReadAnswersLast() async throws {
        final class Shown: @unchecked Sendable {
            let lock = NSLock(); var reads = ProjectReads(); var project: Project?
            func start() -> Int { lock.withLock { reads.start() } }
            func answer(_ p: Project, _ ticket: Int) { lock.withLock { if reads.accept(p.id, ticket) { project = p } } }
        }
        let shown = Shown()
        let ready = stove("ready"), working = stove("touching-up", ["passes": [["startedAtMs": 1, "endedAtMs": 2, "status": "done"], ["startedAtMs": 3]]])
        let afterReady = shown.start()                                  // pass.ready → GET
        try await Task.sleep(for: .milliseconds(182))
        let afterStarted = shown.start()                                // pass.started → GET
        async let slow: Void = { try? await Task.sleep(for: .milliseconds(300)); shown.answer(ready, afterReady) }()
        async let fast: Void = { try? await Task.sleep(for: .milliseconds(20)); shown.answer(working, afterStarted) }()
        _ = await (slow, fast)
        let words = ProjectWords(try XCTUnwrap(shown.project))
        XCTAssertEqual(words.phase, .working, "the later read wins")
        XCTAssertEqual(words.phase.label, ProjectPhase.working.label)
        XCTAssertNotEqual(words.status, "Ready to print")
    }

    /// A list that started before a project's own read never puts the older copy back.
    func testAnOlderListKeepsTheNewerRead() {
        var reads = ProjectReads()
        let list = reads.start()
        let read = reads.start()
        XCTAssertTrue(reads.accept(id, read))
        let merged = reads.merge([stove("ready")], ticket: list, current: [stove("touching-up")])
        XCTAssertEqual(merged.first?.state, .touchingUp)
        let later = reads.start()
        XCTAssertEqual(reads.merge([stove("printed")], ticket: later, current: merged).first?.state, .printed, "a later list wins")
    }

    /// Ask for changes: open whenever there's a model, waiting during a pass or a print; closed without a model and
    /// while the Mac asks for a close-up.
    func testOneRuleForAskForChanges() {
        for state in ["ready", "printed", "sent", "confirmed", "failed"] {
            XCTAssertTrue(ProjectWords(stove(state)).canCorrect, state)
            XCTAssertFalse(ProjectWords(stove(state)).correctionWaits, state)
        }
        XCTAssertTrue(ProjectWords(stove("printed", ["settings": ["status": "needs-changes"]])).canCorrect)
        for state in ["touching-up", "printing"] {
            XCTAssertTrue(ProjectWords(stove(state)).canCorrect, state)
            XCTAssertTrue(ProjectWords(stove(state)).correctionWaits, "\(state): it waits for the step")
        }
        XCTAssertFalse(ProjectWords(stove("needs-closeup", ["question": ["closeup": "the underside"]])).canCorrect, "the Ask card is the action")
        XCTAssertFalse(ProjectWords(project(["id": id, "state": "new", "instructions": "A hook"])).canCorrect, "no model yet")
        XCTAssertFalse(ProjectWords(project(["id": id, "state": "failed", "failure": "x"])).canCorrect, "failed without a model")
    }

    /// A change during a pass waits, goes in when the pass ends, and the Mac's "wait" refusal queues it.
    func testAChangeWaitsForTheStepAndGoesInAfter() {
        var queue = CorrectionQueue()
        queue.add("Make the lip 2 mm taller", for: id)
        queue.add("  ", for: id)
        XCTAssertNil(queue.due(stove("touching-up")), "the pass is running")
        XCTAssertNil(queue.due(stove("printing")), "the print is running")
        XCTAssertEqual(queue.due(stove("ready")), "Make the lip 2 mm taller", "pass.ready: it goes in")
        queue.add("And round the corners", for: id)
        queue.sent("Make the lip 2 mm taller", for: id)
        XCTAssertEqual(queue.pending(id), "And round the corners", "a change added meanwhile keeps waiting")
        queue.sent("And round the corners", for: id)
        XCTAssertNil(queue.pending(id))
        XCTAssertTrue(CorrectionQueue.waits(CompanionError(code: "invalid-state", message: "Wait until the current step finishes.")))
        XCTAssertFalse(CorrectionQueue.waits(.unreachable))
    }
}
