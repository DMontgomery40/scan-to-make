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
    private var confirmation: [String: Any] { [
        "id": "question-1", "message": "Check the printer.\nConfirm **each** item before continuing.",
        "expiresAtMs": 1000, "supported": true,
        "fields": [["name": "plate_clear", "title": "Build plate is clear", "description": "Remove the previous print.", "required": true],
                   ["name": "watch", "title": "Watch the first layer", "required": false]]
    ] }

    func testPrinterConfirmationPreservesTheQuestionAndReplacesLegacyPlateAction() throws {
        let project = ready(["state": "printing", "plate": ["noCamera": true, "photo": true], "printConfirmation": confirmation])
        let question = try XCTUnwrap(project.printConfirmation)
        XCTAssertEqual(question.message, "Check the printer.\nConfirm **each** item before continuing.")
        XCTAssertEqual(question.fields.first?.description, "Remove the previous print.")
        XCTAssertEqual(ObjectWords(project).status, "Your printer needs your confirmation.")
        XCTAssertTrue(ObjectWords(project).busy)
        XCTAssertTrue(ObjectWords(project).actions.isEmpty, "a camera/legacy plate answer cannot answer the MCP question")
        XCTAssertNil(ready().printConfirmation, "older companion responses still decode")
    }

    func testPrinterConfirmationRequiresExplicitChecksAndCurrentQuestion() throws {
        let question = try XCTUnwrap(ready(["printConfirmation": confirmation]).printConfirmation)
        XCTAssertFalse(question.canAccept([:], atMs: 999))
        XCTAssertFalse(question.canAccept(["plate_clear": false], atMs: 999))
        XCTAssertTrue(question.canAccept(["plate_clear": true], atMs: 999))
        XCTAssertFalse(question.canAccept(["plate_clear": true], atMs: 1000))
        XCTAssertNil(question.response(confirmationId: "old", action: .accept, content: ["plate_clear": true], atMs: 999))
        XCTAssertNil(question.response(confirmationId: question.id, action: .accept, content: [:], atMs: 999))
        let accepted = try XCTUnwrap(question.response(confirmationId: question.id, action: .accept,
                                                       content: ["plate_clear": true, "unrelated": true], atMs: 999))
        XCTAssertEqual(accepted.answer.content, ["plate_clear": true, "watch": false])
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(accepted)) as? [String: Any])
        XCTAssertEqual(json["confirmationId"] as? String, question.id)
        XCTAssertEqual((json["answer"] as? [String: Any])?["action"] as? String, "accept")
        XCTAssertNil(question.response(confirmationId: question.id, action: .cancel, content: [:], atMs: 1000))
    }

    func testUnknownPrinterSchemaCanOnlyBeCancelled() throws {
        var unknown = confirmation
        unknown["supported"] = false
        let question = try XCTUnwrap(ready(["printConfirmation": unknown]).printConfirmation)
        XCTAssertFalse(question.canAccept(["plate_clear": true], atMs: 999))
        XCTAssertNil(question.response(confirmationId: question.id, action: .accept, content: ["plate_clear": true], atMs: 999))
        let cancelled = try XCTUnwrap(question.response(confirmationId: question.id, action: .cancel, content: ["plate_clear": true], atMs: 999))
        XCTAssertEqual(cancelled.answer.action, .cancel)
        XCTAssertNil(cancelled.answer.content)
    }

    func testMediaVersionIgnoresProgressAndChangesWhenAPassFinishes() {
        var project = ready()
        let original = project.mediaVersion
        project.state = .touchingUp
        project.passes.append(.init(startedAtMs: 3))
        for update in 4...20 {
            project.updatedAtMs = Double(update)
            project.progress = "Working on the model in Blender."
            project.passes[1].activityCount = update
            XCTAssertEqual(project.mediaVersion, original, "progress must not invalidate unchanged model/render files")
        }
        project.passes[1].endedAtMs = 21
        project.passes[1].status = "done"
        XCTAssertEqual(project.mediaVersion, 21, "a completed pass replaces the same model/render paths")
        project.updatedAtMs = 22
        project.state = .printing
        XCTAssertEqual(project.mediaVersion, 21)
        project.passes.append(.init(startedAtMs: 23, endedAtMs: 24, status: "failed"))
        XCTAssertEqual(project.mediaVersion, 24, "a failed pass can still save a new checkpoint")
    }

    func testMediaVersionForDraftsAndLegacyProjectsUsesCreationTime() {
        var project = object(["current": current, "updatedAtMs": 1000])
        XCTAssertEqual(project.mediaVersion, project.createdAtMs)
        project.updatedAtMs = 2000
        project.photos.append("new-photo.heic")
        XCTAssertEqual(project.mediaVersion, project.createdAtMs, "a new filename downloads without expiring other files")
    }

    func testTitles() {
        XCTAssertEqual(ObjectWords.title(object(["instructions": "A hook for a handle, 25 mm tube. It should hold a cup."])), "A hook for a handle, 25 mm tube")
        XCTAssertEqual(ObjectWords.title(object(["instructions": "A 40 mm cube with a 10 mm round hole straight through the middle."])), "A 40 mm cube with a 10 mm round hole…")
        XCTAssertEqual(ObjectWords.title(object(["scan": "scan.usdz"])), "Copy of your scan")
        XCTAssertEqual(ObjectWords.title(object([:])), "Unfinished project")
    }

    /// A handheld scan (KAN-210): photos arrive, the Mac rebuilds them and says how far it is.
    func testHandheldScan() {
        let sent = object(["capture": ["0000.heic", "0001.heic"]])
        XCTAssertEqual(ObjectWords.title(sent), "Copy of your scan")
        XCTAssertEqual(ObjectWords.sent(sent), "A scan")
        XCTAssertEqual(ObjectWords(sent).status, "Draft saved. Finish sending to begin.")
        XCTAssertEqual(ObjectWords(object(["capture": ["0000.heic"], "state": "touching-up", "progress": "Finding the object in your photos (3 of 90)."])).status,
                       "Finding the object in your photos (3 of 90). You can leave this project and return to it while your Mac works.")
        XCTAssertEqual(ObjectWords(object(["capture": ["0000.heic"], "scan": "scan.usdz", "state": "touching-up"])).status,
                       "Touching up your scan. You can leave this project and return to it while your Mac works.")
        let old = object(["capture": ["0000.heic"], "state": "failed",
                          "failure": "Holding it up to scan needs macOS 27 on your Mac. Scanning by walking around it still works."])
        XCTAssertEqual(ObjectWords(old).status, "Holding it up to scan needs macOS 27 on your Mac. Scanning by walking around it still works.")
    }

    func testEveryStateInPlainWords() {
        XCTAssertEqual(ObjectWords(object(["scan": "scan.usdz"])).status, "Draft saved. Finish sending to begin.")
        XCTAssertEqual(ObjectWords(object([:])).status, "Waiting for a scan or photos.")
        XCTAssertEqual(ObjectWords(object(["scan": "scan.usdz", "state": "touching-up"])).status,
                       "Touching up your scan. You can leave this project and return to it while your Mac works.")
        XCTAssertEqual(ObjectWords(object(["instructions": "A hook", "state": "touching-up"])).status,
                       "Making it. You can leave this project and return to it while your Mac works.")
        XCTAssertEqual(ObjectWords(ready(["state": "touching-up", "passes": [["startedAtMs": 1], ["startedAtMs": 3, "note": "thicker"]]])).status,
                       "Making your changes. You can leave this project and return to it while your Mac works.")
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
        XCTAssertEqual(ObjectWords(object(["state": "failed", "failure": "Blender is not open on your Mac."])).actions, [.retry, .correct])
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
        XCTAssertEqual(ObjectWords(object(["state": "something-new"])).status, "Update Counterpart to see this one.")
    }
}
