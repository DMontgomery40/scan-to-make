import XCTest
@testable import CounterpartKit

final class ProjectConversationTests: XCTestCase {
    func testRepliesInterleaveWithMessagesAndPhotosKeepTheirKnownOwner() throws {
        let bytes = Data(#"{"id":"mount","createdAtMs":1,"updatedAtMs":9000000,"state":"confirmed","instructions":"Make a mount","photos":["first.jpg","finished.jpg","old.jpg"],"requestPhotos":["first.jpg"],"messages":[{"id":"change","text":"Widen it","atMs":30,"photos":[]},{"id":"done","text":"DONE","atMs":8000000,"photos":["finished.jpg"]}],"completion":{"messageId":"done","note":"DONE","atMs":8000000,"previousStatus":"printed"},"passes":[{"startedAtMs":2,"endedAtMs":20,"summary":"Made it."},{"startedAtMs":30,"endedAtMs":40,"messageId":"change","note":"Widen it","summary":"Widened it.\n\n**Check** the fit."}]}"#.utf8)
        let project = try JSONDecoder().decode(Project.self, from: bytes)
        let chat = ProjectConversation(project: project)
        XCTAssertEqual(chat.entries.map(\.text), ["Make a mount", "Made it.", "Widen it", "Widened it.\n\n**Check** the fit.", "DONE"])
        XCTAssertEqual(chat.entries.first?.photos, ["photos/first.jpg"])
        XCTAssertEqual(chat.entries.last?.photos, ["photos/finished.jpg"])
        XCTAssertEqual(chat.entries.last?.status, "Marked Done")
        XCTAssertEqual(chat.entries.map(\.showsTime), [true, false, false, false, true])
        XCTAssertEqual(chat.entries[3].firstParagraph, "Widened it.")
        XCTAssertTrue(chat.entries[3].canExpand)
        XCTAssertEqual(chat.otherPhotos, ["photos/old.jpg"], "Never assign historical photos to the original request")
    }

    func testPendingAndQueuedMessagesAppearOnceAndUnknownTimesAreNotInvented() {
        var project = Project(id: "mount", createdAtMs: 1, updatedAtMs: 500, state: .ready, photos: ["old.jpg"])
        project.pendingFollowup = "DONE"
        let queued = [CorrectionQueue.Message(text: "DONE", atMs: 200), CorrectionQueue.Message(text: "Another change", photos: [], atMs: nil)]
        let chat = ProjectConversation(project: project, queued: queued)
        XCTAssertEqual(chat.entries.map(\.text), ["DONE", "Another change"])
        XCTAssertEqual(chat.entries.map(\.status), ["Message saved", "Waiting to send"])
        XCTAssertTrue(chat.entries.allSatisfy { $0.atMs == nil })
        XCTAssertEqual(chat.otherPhotos, ["photos/old.jpg"])
    }

    func testQueuedPhotosStayWithEachMessageAfterRelaunch() {
        var project = Project(id: "mount", createdAtMs: 1, updatedAtMs: 2, state: .ready)
        project.pendingPhotos = ["one.jpg"]
        var queue = CorrectionQueue()
        queue.add("First change", for: project.id, photos: queue.availablePhotos(project))
        project.pendingPhotos = ["one.jpg", "two.jpg"]
        queue.add("Second change", for: project.id, photos: queue.availablePhotos(project))
        queue = CorrectionQueue(saved: queue.saved)
        XCTAssertEqual(queue.messages[project.id]?.map(\.photos), [["one.jpg"], ["two.jpg"]])
        XCTAssertEqual(ProjectConversation(project: project, queued: queue.messages[project.id] ?? []).entries.map(\.photos), [["photos/one.jpg"], ["photos/two.jpg"]])
    }
}
