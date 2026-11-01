import XCTest
@testable import ObjectsCore

private func object(_ json: [String: Any]) -> StmObject {
    let base: [String: Any] = ["id": "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11", "createdAtMs": 1, "updatedAtMs": 2, "state": "new", "photos": [], "passes": []]
    let data = try! JSONSerialization.data(withJSONObject: base.merging(json) { $1 })
    return try! JSONDecoder().decode(StmObject.self, from: data)
}
private let current: [String: Any] = ["model": "current/model.stl", "renders": ["current/renders/1_overview.png"], "sizeMm": [61.6, 75.2, 49.4], "summary": "Added the two eyes."]
private func ready(_ more: [String: Any] = [:]) -> StmObject {
    object(["scan": "scan.usdz", "state": "ready", "passes": [["startedAtMs": 1, "endedAtMs": 2, "status": "done"]], "current": current].merging(more) { $1 })
}

final class ObjectWordsTests: XCTestCase {
    func testTitles() {
        XCTAssertEqual(ObjectWords.title(object(["instructions": "A hook for a handle, 25 mm tube. It should hold a cup."])), "A hook for a handle, 25 mm tube")
        XCTAssertEqual(ObjectWords.title(object(["instructions": "A 40 mm cube with a 10 mm round hole straight through the middle."])), "A 40 mm cube with a 10 mm round hole…")
        XCTAssertEqual(ObjectWords.title(object(["scan": "scan.usdz"])), "Copy of your scan")
        XCTAssertEqual(ObjectWords.title(object([:])), "Something new")
    }

    func testEveryStateInPlainWords() {
        XCTAssertEqual(ObjectWords(object(["scan": "scan.usdz"])).status, "Sending to your Mac…")
        XCTAssertEqual(ObjectWords(object([:])).status, "Waiting for a scan or photos.")
        XCTAssertEqual(ObjectWords(object(["scan": "scan.usdz", "state": "touching-up"])).status,
                       "Touching up your scan. This can take a few minutes. We'll let you know when it's ready.")
        XCTAssertEqual(ObjectWords(object(["instructions": "A hook", "state": "touching-up"])).status,
                       "Making it. This can take a few minutes. We'll let you know when it's ready.")
        XCTAssertEqual(ObjectWords(ready(["state": "touching-up", "passes": [["startedAtMs": 1], ["startedAtMs": 3, "note": "thicker"]]])).status,
                       "Making your changes. This can take a few minutes. We'll let you know when it's ready.")
        XCTAssertEqual(ObjectWords(ready()).status, "Ready to print")
        XCTAssertEqual(ObjectWords(ready(["state": "printing"])).status, "Printing")
        XCTAssertEqual(ObjectWords(ready(["state": "printed"])).status, "Printed")
        XCTAssertEqual(ObjectWords(object(["state": "failed"])).status, "Something went wrong on your Mac.")
    }

    func testActionsFollowTheState() {
        XCTAssertEqual(ObjectWords(ready()).actions, [.print, .correct])
        XCTAssertEqual(ObjectWords(object(["state": "needs-closeup", "question": ["closeup": "the underside"]])).actions, [.openCamera, .attachPhotos, .bestGuess])
        XCTAssertEqual(ObjectWords(object(["state": "needs-closeup", "question": ["closeup": "the underside"]])).status,
                       "Can you send me a close-up of the underside? I can't see what's happening there.")
        XCTAssertEqual(ObjectWords(ready(["state": "printing", "plate": ["item": "a spool", "photo": true]])).status,
                       "Looks like there's a spool on your plate. Can you take it off first?")
        XCTAssertEqual(ObjectWords(ready(["state": "printing", "plate": ["noCamera": true]])).actions, [.plateClear])
        XCTAssertEqual(ObjectWords(ready(["state": "failed", "failure": "x", "print": ["bundleId": "b", "uncertain": true]])).actions, [.printChecked, .correct])
        XCTAssertEqual(ObjectWords(object(["state": "failed", "failure": "Blender is not open on your Mac."])).actions, [.retry])
        XCTAssertEqual(ObjectWords(object(["scan": "scan.usdz"])).actions, [.finishSending])
        XCTAssertTrue(ObjectWords(ready(["state": "printing"])).busy)
        XCTAssertFalse(ObjectWords(ready()).busy)
    }

    func testSizeIsWholeMillimetres() {
        XCTAssertEqual(ObjectWords(ready()).size, "62 × 75 × 49 mm")
        XCTAssertNil(ObjectWords(object([:])).size)
    }

    func testWhatWasSent() {
        XCTAssertEqual(ObjectWords.sent(object(["scan": "scan.usdz", "photos": Array(repeating: "a.jpg", count: 24)])), "A scan and 24 photos")
        XCTAssertEqual(ObjectWords.sent(object(["photos": ["a.jpg"]])), "1 photo")
        XCTAssertEqual(ObjectWords.sent(object(["instructions": "A hook"])), "Just the description")
    }

    func testUnknownStatesFromANewerMacStillDecode() {
        XCTAssertEqual(ObjectWords(object(["state": "something-new"])).status, "Update Scan to Make to see this one.")
    }
}
