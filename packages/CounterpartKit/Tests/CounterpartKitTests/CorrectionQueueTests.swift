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

    func testAnUnconfirmedSendStaysPausedAcrossLaunchesUntilExplicitRetry() {
        var queue = CorrectionQueue(notes: ["mount": "Widen it"])
        queue.fail("mount", message: "Connection lost after sending")
        XCTAssertNil(queue.due(project(.ready)), "A completed pass must not cause an automatic duplicate send")
        queue = CorrectionQueue(saved: queue.saved)
        XCTAssertNil(queue.due(project(.ready)))
        XCTAssertEqual(queue.pending("mount"), "Widen it")
        queue.retry("mount")
        XCTAssertEqual(queue.due(project(.ready)), "Widen it")
    }

    func testPersistenceReadsBothOldAndNewQueueFormats() {
        let old = CorrectionQueue(saved: ["mount": "Widen it"])
        XCTAssertEqual(old.due(project(.ready)), "Widen it")
        var new = CorrectionQueue(saved: ["mount": ["Widen it", "Then round it"]])
        new.sent("Widen it", for: "mount")
        XCTAssertEqual(new.pending("mount"), "Then round it")
        XCTAssertEqual(CorrectionQueue(saved: new.entries).pending("mount"), "Then round it")
    }

    // Nov 10, "Guitar pick": one note recorded twice, 98 seconds apart, each copy starting a design pass.
    func testOneNoteKeepsOneIdAcrossTriesAndIntoTheQueue() {
        var attempts = NoteAttempts()
        let first = attempts.id(for: "Thicker walls", in: "mount")
        XCTAssertEqual(attempts.id(for: "Thicker walls", in: "mount"), first, "a second try at the same note")
        XCTAssertNotEqual(attempts.id(for: "Thicker walls", in: "other"), first, "another project's note")
        let changed = attempts.id(for: "Thicker walls, 3 mm", in: "mount")
        XCTAssertNotEqual(changed, first, "changed words are a new note")
        attempts.settled("mount")
        XCTAssertNotEqual(attempts.id(for: "Thicker walls, 3 mm", in: "mount"), changed, "the same words after a send that worked")
        // A note is its words and its attachments (train #499 review, F8): the same words with other photos are a
        // new note, or the Mac would treat them as a repeat and the photos would never attach.
        var withPhotos = NoteAttempts()
        let one = withPhotos.id(for: "See the photos I added.", photos: ["a.jpg"], in: "mount")
        XCTAssertEqual(withPhotos.id(for: "See the photos I added.", photos: ["a.jpg"], in: "mount"), one, "the same note again")
        let two = withPhotos.id(for: "See the photos I added.", photos: ["a.jpg", "b.jpg"], in: "mount")
        XCTAssertNotEqual(two, one, "a photo added")
        XCTAssertNotEqual(withPhotos.id(for: "See the photos I added.", photos: ["b.jpg"], in: "mount"), two, "another photo")
        XCTAssertNotEqual(withPhotos.id(for: "See the photos I added.", in: "mount"), one, "no photos")
        XCTAssertNotNil(first.range(of: "^[A-Za-z0-9-]{8,64}$", options: .regularExpression), "the Mac accepts this id")

        // The step was still running, so the note waits: the saved copy keeps the id the first try used.
        var queue = CorrectionQueue()
        queue.add("Thicker walls", for: "mount", messageId: first)
        queue.add("And a chamfer", for: "mount")
        XCTAssertEqual(queue.dueId("mount"), first)
        let restored = CorrectionQueue(saved: queue.saved)
        XCTAssertEqual(restored.dueId("mount"), first, "the id survives a relaunch")
        queue.sent("Thicker walls", for: "mount")
        XCTAssertNotNil(queue.dueId("mount"))
        XCTAssertNotEqual(queue.dueId("mount"), first)
        XCTAssertNil(queue.dueId("other"))
    }
}
