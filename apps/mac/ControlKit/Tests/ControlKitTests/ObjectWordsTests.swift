import XCTest
import Foundation
@testable import ControlKit

/// The same cases as the phone's `objectsModel.test.ts` (KAN-204), so both apps say the same thing.
private func object(_ fields: [String: Any]) -> StmObject {
    var json: [String: Any] = ["id": "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11", "createdAtMs": 1, "updatedAtMs": 1,
                               "state": "new", "photos": [], "passes": [], "directory": "/tmp/object"]
    json.merge(fields) { $1 }
    return try! JSONDecoder().decode(StmObject.self, from: JSONSerialization.data(withJSONObject: json))
}
private let readyFields: [String: Any] = [
    "scan": "scan.usdz", "state": "ready",
    "passes": [["startedAtMs": 1, "endedAtMs": 2, "status": "done"]],
    "current": ["model": "current/model.stl", "renders": ["current/renders/front.png"], "sizeMm": [61.6, 75.2, 49.4],
                "summary": "Added the two eyes."],
]
private func ready(_ fields: [String: Any] = [:]) -> StmObject { object(readyFields.merging(fields) { $1 }) }
private let waitLine = " You can leave this project and return to it while your Mac works."

final class ObjectWordsTests: XCTestCase {
    func testNamesAnObjectByItsInstructionsOrAsACopyOfAScan() {
        XCTAssertEqual(object(["instructions": "A hook for a 25 mm tube. It should hold a cup."]).words.title,
                       "A hook for a 25 mm tube")
        XCTAssertEqual(object(["scan": "scan.usdz"]).words.title, "Copy of your scan")
        XCTAssertEqual(object([:]).words.title, "Unfinished project")
        XCTAssertEqual(object(["instructions": "   "]).words.title, "Unfinished project")
        XCTAssertEqual(object(["instructions": "a bracket, 3 mm thick, with two holes, for the shelf"]).words.title,
                       "a bracket, 3 mm thick, with two holes", "two clauses at most; a comma before a number isn't a clause")
        XCTAssertEqual(object(["instructions": "A wall bracket\nfor the router"]).words.title, "A wall bracket")
        let long = object(["instructions": "A replacement knob for the bathroom cabinet that matches the others exactly"]).words.title
        XCTAssertEqual(long, "A replacement knob for the bathroom cabinet that matches…")
        XCTAssertLessThanOrEqual(long.count, 60)
    }

    func testSaysWhatIsHappeningInPlainWordsForEveryState() {
        XCTAssertEqual(object(["scan": "scan.usdz"]).words.status, "Draft saved. Continue on your iPhone.")
        XCTAssertEqual(object(["photos": ["one.heic"]]).words.status, "Draft saved. Continue on your iPhone.")
        XCTAssertEqual(object(["instructions": "A hook"]).words.status, "Draft saved. Continue on your iPhone.",
                       "nothing has arrived from the phone yet")
        XCTAssertEqual(object(["scan": "scan.usdz", "state": "touching-up"]).words.status, "Touching up your scan." + waitLine)
        XCTAssertEqual(object(["instructions": "A hook", "state": "touching-up"]).words.status, "Making it." + waitLine)
        let correcting = ready(["state": "touching-up",
                                "passes": [["startedAtMs": 1, "endedAtMs": 2, "status": "done"], ["startedAtMs": 3, "note": "thicker"]]])
        XCTAssertEqual(correcting.words.status, "Making your changes." + waitLine)
        XCTAssertEqual(ready().words.status, "Ready to print")
        XCTAssertEqual(ready(["state": "printing"]).words.status, "Preparing print…")
        XCTAssertEqual(ready(["state": "printed"]).words.status, "Print request accepted")
    }

    func testAsksForACloseUpInOneSentenceAndOffersTheGuess() {
        let words = ready(["state": "needs-closeup", "question": ["closeup": "the clip on the left side"]]).words
        XCTAssertEqual(words.status, "Can you send me a close-up of the clip on the left side? I can't see what's happening there.")
        XCTAssertEqual(words.actions, [.bestGuess], "the Mac has no camera step in v1: photos come from the iPhone")
        XCTAssertEqual(words.headline, "Need a close-up of the clip on the left side")
        XCTAssertEqual(ready(["state": "needs-closeup"]).words.status,
                       "Can you send me a close-up of the part I missed? I can't see what's happening there.")
    }

    func testShowsThePlateOnlyWhenSomethingIsOnItWithTheOverride() {
        let blocked = ready(["state": "printing", "plate": ["item": "a printed part", "photo": true]]).words
        XCTAssertEqual(blocked.status, "Looks like there's a printed part on your plate. Can you take it off first?")
        XCTAssertEqual(blocked.actions, [.plateClear])
        XCTAssertEqual(ready(["state": "printing", "plate": [:]]).words.status,
                       "Looks like there's something on your plate. Can you take it off first?")
        let noCamera = ready(["state": "printing", "plate": ["noCamera": true, "item": "ignored"]]).words
        XCTAssertEqual(noCamera.status, "Check the plate is clear.")
        XCTAssertEqual(noCamera.actions, [.plateClear])
        XCTAssertEqual(ready(["state": "printing"]).words.actions, [])
    }

    func testPendingPrintConfirmationReplacesPlateOnlyAction() {
        for supported in [true, false] {
            let words = ready(["state":"printing", "plate":["noCamera":true, "photo":true],
                "printConfirmation":["id":"q", "message":"Check the printer.", "expiresAtMs":2000, "fields":[], "supported":supported]]).words
            XCTAssertEqual(words.status, "Waiting for your print confirmation.")
            XCTAssertEqual(words.tone, .accent)
            XCTAssertEqual(words.actions, [])
            XCTAssertTrue(words.busy, "Keep polling while the human confirmation is pending")
        }
    }

    func testAReadyObjectPrintsOrTakesCorrectionsWithItsLidarSize() {
        let words = ready().words
        XCTAssertEqual(words.actions, [.print, .correct])
        XCTAssertEqual(words.size, "62 × 75 × 49 mm, ready to print")
        XCTAssertEqual(ObjectWords.formatSize([10.4, 20.5, 3]), "10 × 21 × 3 mm")
        XCTAssertNil(object(["state": "touching-up"]).words.size)
        XCTAssertEqual(ready(["state": "printed"]).words.actions, [.print, .correct])
    }

    func testAFailureSaysWhyAndOffersWhatFixesIt() {
        let touchUp = object(["scan": "scan.usdz", "state": "failed", "failure": "Blender is not open on your Mac."]).words
        XCTAssertEqual(touchUp.status, "Blender is not open on your Mac.")
        XCTAssertEqual(touchUp.actions, [.retry, .correct], "a touch-up that failed with no model can start again")
        let print = ready(["state": "failed", "failure": "The printer is busy."]).words
        XCTAssertEqual(print.status, "The printer is busy.")
        XCTAssertEqual(print.actions, [.print, .correct])
        XCTAssertEqual(object(["state": "failed"]).words.status, "Something went wrong on your Mac.")
        XCTAssertEqual(object(["state": "failed", "failure": "  "]).words.status, "Something went wrong on your Mac.")
    }

    func testAPrintThatMayHaveStartedIsSentAgainOnlyAfterTheUserChecks() {
        let uncertain = ready(["state": "failed", "failure": "The printer may have started this print. Check the printer before printing again.",
                               "print": ["bundleId": "b1", "uncertain": true]]).words
        XCTAssertEqual(uncertain.actions, [.printChecked, .correct], "a plain Print would be refused")
        XCTAssertEqual(uncertain.headline, "The printer may have started this print.")
        XCTAssertEqual(ready(["print": ["bundleId": "b1", "uncertain": true]]).words.actions, [.printChecked, .correct])
        XCTAssertEqual(ready(["print": ["bundleId": "b1"]]).words.actions, [.print, .correct])
    }

    func testBusyStatesAreMarkedSoThePageKeepsItselfUpToDate() {
        XCTAssertFalse(object([:]).words.busy)
        XCTAssertTrue(object(["state": "touching-up"]).words.busy)
        XCTAssertTrue(ready(["state": "printing"]).words.busy)
        XCTAssertFalse(ready().words.busy)
        XCTAssertFalse(ready(["state": "needs-closeup"]).words.busy)
    }

    func testCardsShowTheFirstSentence() {
        XCTAssertEqual(object(["scan": "scan.usdz", "state": "touching-up"]).words.headline, "Touching up your scan.")
        XCTAssertEqual(ready(["state": "printing", "plate": ["item": "a printed part"]]).words.headline,
                       "Looks like there's a printed part on your plate.")
        XCTAssertEqual(ready().words.headline, "Ready to print")
        XCTAssertEqual(object(["state": "new", "scan": "scan.usdz"]).words.headline, "Draft saved.")
        XCTAssertEqual(object(["state": "new"]).words.headline, "Draft saved.")
    }

    func testAStateThisAppDoesNotKnowAsksForAnUpdate() {
        let words = object(["state": "archived"]).words
        XCTAssertEqual(words.status, "Update Counterpart to see this one.")
        XCTAssertEqual(words.actions, [])
        XCTAssertFalse(words.busy)
    }

    func testCopyNeverNamesTheMachinery() {
        let all = [object([:]), object(["state": "touching-up"]), ready(), ready(["state": "printing", "plate": ["noCamera": true]]),
                   ready(["state": "needs-closeup"]), object(["state": "failed"]), object(["state": "archived"])]
        for words in all.map(\.words) {
            for text in [words.title, words.status, words.headline] {
                for banned in ["companion", "MCP", "job"] { XCTAssertFalse(text.localizedCaseInsensitiveContains(banned), text) }
            }
        }
    }
}
