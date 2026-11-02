import XCTest
@testable import CounterpartKit

final class CorrectionQueueTests: XCTestCase {
    private func project(_ state: Project.State, model: Bool = true) -> Project {
        Project(id: "mount", createdAtMs: 1, updatedAtMs: 2, state: state,
                current: model ? .init(model: "current/model.stl", renders: []) : nil)
    }

    func testBothAppsAllowWritingDuringPassOrPrintButSendOnlyAfterItFinishes() {
        var queue = CorrectionQueue()
        queue.add("Widen the hole", for: "mount")
        for state in [Project.State.touchingUp, .printing] {
            XCTAssertTrue(project(state).canAskForChanges)
            XCTAssertTrue(project(state).changesWait)
            XCTAssertNil(queue.due(project(state)))
        }
        XCTAssertTrue(project(.touchingUp, model: false).canAskForChanges)
        XCTAssertEqual(queue.due(project(.ready)), "Widen the hole")
        XCTAssertFalse(project(.needsCloseup).canAskForChanges)
        XCTAssertNil(queue.due(project(.failed, model: false)))
    }

    func testMessagesStayWholeAndNewMessagesAddedDuringASendStayQueued() {
        var queue = CorrectionQueue()
        let first = "It works. " + String(repeating: " ", count: 4100) + "But make it wider."
        queue.add(first, for: "mount")
        XCTAssertEqual(queue.due(project(.ready)), first, "Never classify a truncated success-only prefix")
        queue.add("Change the colour", for: "mount")
        queue.sent(first, for: "mount")
        XCTAssertEqual(queue.due(project(.ready)), "Change the colour")
        queue.sent("a stale reply", for: "mount")
        XCTAssertEqual(queue.pending("mount"), "Change the colour")
        queue.sent("Change the colour", for: "mount")
        XCTAssertNil(queue.pending("mount"))
    }

    func testPersistenceReadsBothOldAndNewQueueFormats() {
        let old = CorrectionQueue(saved: ["mount": "Widen it"])
        XCTAssertEqual(old.due(project(.ready)), "Widen it")
        var new = CorrectionQueue(saved: ["mount": ["Widen it", "Then round it"]])
        new.sent("Widen it", for: "mount")
        XCTAssertEqual(new.pending("mount"), "Then round it")
        XCTAssertEqual(CorrectionQueue(saved: new.entries).pending("mount"), "Then round it")
    }
}
