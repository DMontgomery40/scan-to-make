import XCTest
@testable import CounterpartKit

private let current: [String: Any] = ["model": "current/model.stl", "renders": ["current/renders/1_overview.png"], "sizeMm": [61.6, 75.2, 49.4], "summary": "Added the two eyes."]
private func ready(_ more: [String: Any] = [:]) -> Project {
    project(["scan": "scan.usdz", "state": "ready", "passes": [["startedAtMs": 1, "endedAtMs": 2, "status": "done"]], "current": current].merging(more) { $1 })
}

/// The words every surface uses. Ported unchanged from the iPhone app's ObjectWordsTests, plus the PRD §4
/// phases and the companion's own status line.
final class ProjectWordsTests: XCTestCase {
    private var confirmation: [String: Any] { [
        "id": "question-1", "message": "Check the printer.\nConfirm **each** item before continuing.",
        "expiresAtMs": 1000, "supported": true,
        "fields": [["name": "plate_clear", "title": "Build plate is clear", "description": "Remove the previous print.", "required": true],
                   ["name": "watch", "title": "Watch the first layer", "required": false]]
    ] }

    func testPrinterConfirmationPreservesTheQuestionAndReplacesLegacyPlateAction() throws {
        let p = ready(["state": "printing", "plate": ["noCamera": true, "photo": true], "printConfirmation": confirmation])
        let question = try XCTUnwrap(p.printConfirmation)
        XCTAssertEqual(question.message, "Check the printer.\nConfirm **each** item before continuing.")
        XCTAssertEqual(question.fields.first?.description, "Remove the previous print.")
        XCTAssertEqual(ProjectWords(p).status, "Your printer needs your confirmation.")
        XCTAssertTrue(ProjectWords(p).busy)
        XCTAssertTrue(ProjectWords(p).actions.isEmpty, "a camera/legacy plate answer cannot answer the MCP question")
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
        var p = ready()
        let original = p.mediaVersion
        p.state = .touchingUp
        p.passes.append(.init(startedAtMs: 3))
        for update in 4...20 {
            p.updatedAtMs = Double(update)
            p.progress = "Working on the model in Blender."
            p.passes[1].activityCount = update
            XCTAssertEqual(p.mediaVersion, original, "progress must not invalidate unchanged model/render files")
        }
        p.passes[1].endedAtMs = 21
        p.passes[1].status = "done"
        XCTAssertEqual(p.mediaVersion, 21, "a completed pass replaces the same model/render paths")
        p.updatedAtMs = 22
        p.state = .printing
        XCTAssertEqual(p.mediaVersion, 21)
        p.passes.append(.init(startedAtMs: 23, endedAtMs: 24, status: "failed"))
        XCTAssertEqual(p.mediaVersion, 24, "a failed pass can still save a new checkpoint")
    }

    func testMediaVersionForDraftsAndLegacyProjectsUsesCreationTime() {
        var p = project(["current": current, "updatedAtMs": 1000])
        XCTAssertEqual(p.mediaVersion, p.createdAtMs)
        p.updatedAtMs = 2000
        p.photos.append("new-photo.heic")
        XCTAssertEqual(p.mediaVersion, p.createdAtMs, "a new filename downloads without expiring other files")
    }

    func testTitles() {
        XCTAssertEqual(ProjectWords.title(project(["instructions": "A hook for a handle, 25 mm tube. It should hold a cup."])), "A hook for a handle, 25 mm tube")
        XCTAssertEqual(ProjectWords.title(project(["instructions": "A 40 mm cube with a 10 mm round hole straight through the middle."])), "A 40 mm cube with a 10 mm round hole…")
        XCTAssertEqual(ProjectWords.title(project(["scan": "scan.usdz"])), "Copy of your scan")
        XCTAssertEqual(ProjectWords.title(project([:])), "Unfinished project")
        XCTAssertEqual(ProjectWords.title(project(["instructions": "A hook", "title": "Mic mount"])), "Mic mount", "the generated title wins")
        XCTAssertEqual(ProjectWords.title(project(["instructions": "A hook", "title": "  "])), "A hook")
    }

    func testHandheldScan() {
        let sent = project(["capture": ["0000.heic", "0001.heic"]])
        XCTAssertEqual(ProjectWords.title(sent), "Copy of your scan")
        XCTAssertEqual(ProjectWords.sent(sent), "A scan")
        XCTAssertEqual(ProjectWords(sent).status, "Draft saved. Finish sending to begin.")
        XCTAssertEqual(ProjectWords(project(["capture": ["0000.heic"], "state": "touching-up", "progress": "Finding the object in your photos (3 of 90)."])).status,
                       "Finding the object in your photos (3 of 90). You can leave this project and return to it while your Mac works.")
        XCTAssertEqual(ProjectWords(project(["capture": ["0000.heic"], "scan": "scan.usdz", "state": "touching-up"])).status,
                       "Touching up your scan. You can leave this project and return to it while your Mac works.")
        let old = project(["capture": ["0000.heic"], "state": "failed",
                           "failure": "Holding it up to scan needs macOS 27 on your Mac. Scanning by walking around it still works."])
        XCTAssertEqual(ProjectWords(old).status, "Holding it up to scan needs macOS 27 on your Mac. Scanning by walking around it still works.")
    }

    func testEveryStateInPlainWords() {
        XCTAssertEqual(ProjectWords(project(["scan": "scan.usdz"])).status, "Draft saved. Finish sending to begin.")
        XCTAssertEqual(ProjectWords(project([:])).status, "Waiting for a scan or photos.")
        XCTAssertEqual(ProjectWords(project(["scan": "scan.usdz", "state": "touching-up"])).status,
                       "Touching up your scan. You can leave this project and return to it while your Mac works.")
        XCTAssertEqual(ProjectWords(project(["instructions": "A hook", "state": "touching-up"])).status,
                       "Making it. You can leave this project and return to it while your Mac works.")
        XCTAssertEqual(ProjectWords(ready(["state": "touching-up", "passes": [["startedAtMs": 1], ["startedAtMs": 3, "note": "thicker"]]])).status,
                       "Making your changes. You can leave this project and return to it while your Mac works.")
        XCTAssertEqual(ProjectWords(ready()).status, "Ready to print")
        XCTAssertEqual(ProjectWords(ready(["state": "printing"])).status, "Preparing print…")
        XCTAssertEqual(ProjectWords(ready(["state": "printed"])).status, "Print request accepted")
        XCTAssertEqual(ProjectWords(project(["state": "failed"])).status, "Something went wrong on your Mac.")
    }

    func testActionsFollowTheState() {
        XCTAssertEqual(ProjectWords(ready()).actions, [.print, .correct])
        XCTAssertEqual(ProjectWords(project(["state": "needs-closeup", "question": ["closeup": "the underside"]])).actions, [.openCamera, .attachPhotos, .bestGuess])
        XCTAssertEqual(ProjectWords(project(["state": "needs-closeup", "question": ["closeup": "the underside"]])).status,
                       "Can you send me a close-up of the underside? I can't see what's happening there.")
        XCTAssertEqual(ProjectWords(ready(["state": "printing", "plate": ["item": "a spool", "photo": true]])).status, "Preparing print…")
        XCTAssertEqual(ProjectWords(ready(["state": "printing", "plate": ["noCamera": true]])).actions, [])
        XCTAssertEqual(ProjectWords(ready(["state": "failed", "failure": "x", "print": ["bundleId": "b", "uncertain": true]])).actions, [.printChecked, .correct])
        XCTAssertEqual(ProjectWords(project(["state": "failed", "failure": "Blender is not open on your Mac."])).actions, [.retry, .correct])
        XCTAssertEqual(ProjectWords(project(["scan": "scan.usdz"])).actions, [.finishSending])
        XCTAssertTrue(ProjectWords(ready(["state": "printing"])).busy)
        XCTAssertFalse(ProjectWords(ready()).busy)
    }

    func testSizeIsWholeMillimetres() {
        XCTAssertEqual(ProjectWords(ready()).size, "62 × 75 × 49 mm")
        XCTAssertNil(ProjectWords(project([:])).size)
    }

    func testWhatWasSent() {
        XCTAssertEqual(ProjectWords.sent(project(["scan": "scan.usdz", "photos": Array(repeating: "a.jpg", count: 24)])), "A scan and 24 photos")
        XCTAssertEqual(ProjectWords.sent(project(["photos": ["a.jpg"]])), "1 photo")
        XCTAssertEqual(ProjectWords.sent(project(["instructions": "A hook"])), "Just the description")
    }

    /// A plate the camera reported isn't a prompt to clear it (main ac44431): the print is still being prepared.
    func testPlateReportsDontAskYouToClearThePlate() {
        let reported = ProjectWords(ready(["state": "printing", "plate": ["item": "a spool", "photo": true]]))
        XCTAssertEqual(reported.status, "Preparing print…")
        XCTAssertEqual(reported.phase, .preparing)
        XCTAssertEqual(reported.actions, [])
        XCTAssertEqual(ProjectWords(ready(["state": "printing", "plate": ["noCamera": true]])).actions, [])
    }

    func testUnknownStatesFromANewerMacStillDecode() {
        XCTAssertEqual(ProjectWords(project(["state": "something-new"])).status, "Update Counterpart to see this one.")
        XCTAssertEqual(ProjectWords(project(["state": "something-new"])).phase, .unknown)
    }

    // MARK: PRD §4 phases

    func testPhasesFollowThePRDTable() {
        XCTAssertEqual(ProjectWords(project([:])).phase, .draft)
        XCTAssertEqual(ProjectWords(project(["scan": "scan.usdz"])).phase, .draft, "a send cut short is a draft until this phone sends again")
        XCTAssertEqual(ProjectWords(project(["scan": "scan.usdz"]), sending: true).phase, .sending)
        XCTAssertEqual(ProjectWords(project(["scan": "scan.usdz"]), sending: true).status, "Sending to your Mac. Keep the app open until it finishes.")
        XCTAssertEqual(ProjectWords(project(["state": "touching-up"])).phase, .working)
        XCTAssertEqual(ProjectWords(project(["state": "needs-closeup"])).phase, .needsYou)
        XCTAssertEqual(ProjectWords(ready()).phase, .ready)
        XCTAssertEqual(ProjectWords(ready(["state": "printing"])).phase, .preparing, "printing starts only when the printer reports our job")
        XCTAssertEqual(ProjectWords(ready(["state": "printed"])).phase, .printed)
        XCTAssertEqual(ProjectWords(project(["state": "failed"])).phase, .failed)
        for phase in ProjectPhase.allCases { XCTAssertFalse(phase.symbol.isEmpty); XCTAssertFalse(phase.label.isEmpty) }
    }

    func testCardLines() {
        XCTAssertEqual(ProjectWords(ready()).line, "Ready to print · 62 × 75 × 49 mm")
        XCTAssertEqual(ProjectWords(ready(["state": "printed"])).line, "Sent to your printer", "no claim it printed without the monitor's word")
        let printed = ready(["state": "printed", "print": ["bundleId": "b", "destination": ["id": "current", "name": "P1S"],
                                                         "monitor": ["phase": "ended", "endState": "done", "endedAt": "2026-10-30T09:00:00Z"]]])
        XCTAssertEqual(ProjectWords(printed).status, "Printed")
        XCTAssertTrue(ProjectWords(printed, now: ISO.date("2026-11-01T09:00:00Z")!).line.hasPrefix("Printed "))
        XCTAssertEqual(ProjectWords(project(["state": "needs-closeup", "question": ["closeup": "the underside"]])).line, "Needs you · a close-up of the underside")
    }

    func testTheMacsOwnStatusLineWins() {
        let p = ready(["status": ["phase": "ready", "text": "Ready to print · 48 × 50 × 54 mm", "symbol": "checkmark.seal", "tint": "accent"]])
        XCTAssertEqual(ProjectWords(p).line, "Ready to print · 48 × 50 × 54 mm")
        let printing = ready(["state": "printing", "status": ["phase": "printing", "text": "Printing on P1S · 42% · 38 min left", "symbol": "printer.fill", "tint": "green"]])
        XCTAssertEqual(ProjectWords(printing).phase, .printing)
        XCTAssertEqual(ProjectWords(printing).line, "Printing on P1S · 42% · 38 min left")
    }

    func testLivePrintWords() throws {
        let data = try fixture("objects.json")
        struct List: Decodable { var objects: [Project] }
        let objects = try JSONDecoder().decode(List.self, from: data).objects
        let printing = try XCTUnwrap(objects.first { $0.state == .printing })
        // The fixture has no `status`, so the phone writes the line from `print.live`.
        XCTAssertEqual(ProjectWords(printing).phase, .printing)
        XCTAssertEqual(ProjectWords(printing).line, "Printing on P1S · 42% · 38 min left")
    }

    func testWorkProgressFromStagesAndEstimate() throws {
        let now = Date(timeIntervalSince1970: 1_761_990_300)
        let p = project(["state": "touching-up", "passes": [["startedAtMs": 1_761_990_150_000,
            "stages": [["id": "preparing", "words": "Getting Blender ready", "startedAtMs": 1_761_990_150_000, "endedAtMs": 1_761_990_160_000, "typicalSec": 12],
                       ["id": "working", "words": "Matching your photos", "startedAtMs": 1_761_990_160_000, "typicalSec": 240]],
            "estimate": ["remainingSec": 220, "endsAtMs": 1_761_990_420_000]]]])
        let work = WorkProgress(p, now: now)
        XCTAssertEqual(work.stage, "Matching your photos")
        XCTAssertEqual(work.step, 2)
        XCTAssertEqual(work.remainingSec, 120)
        XCTAssertNotNil(work.fraction)
        XCTAssertEqual(ProjectWords.workingLine(p, fallback: "Making it", now: now), "Matching your photos · about 2 min")
        XCTAssertNil(WorkProgress(project(["state": "touching-up", "passes": [["startedAtMs": 1]]])).fraction, "no stages, no made-up progress")
    }
}
