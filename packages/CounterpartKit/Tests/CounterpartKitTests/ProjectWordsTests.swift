import XCTest
@testable import CounterpartKit

private let current: [String: Any] = ["model": "current/model.stl", "renders": ["current/renders/1_overview.png"], "sizeMm": [61.6, 75.2, 49.4], "summary": "Added the two eyes."]
private func ready(_ more: [String: Any] = [:]) -> Project {
    project(["scan": "scan.usdz", "state": "ready", "passes": [["startedAtMs": 1, "endedAtMs": 2, "status": "done"]], "current": current].merging(more) { $1 })
}

/// The words every surface uses. Ported unchanged from the iPhone app's ObjectWordsTests, plus the PRD §4
/// phases and the companion's own status line.
final class ProjectWordsTests: XCTestCase {
    func testWorkStartUsesEarliestPassNotAnOldPhoneDraft() {
        let oldDraft = project(["createdAtMs": 1, "passes": [["startedAtMs": 900], ["startedAtMs": 500]]])
        XCTAssertEqual(oldDraft.workStartedAt, Date(timeIntervalSince1970: 0.5))
        XCTAssertNil(project(["createdAtMs": 1, "passes": []]).workStartedAt)
        XCTAssertEqual(project(["createdAtMs": 1, "passes": [["startedAtMs": 10, "status": "failed"]]]).workStartedAt,
                       Date(timeIntervalSince1970: 0.01), "a failed first pass still started work")
    }

    func testTheAppsFollowTheCompanionsDecidedKind() {
        // The companion sends passKind as kind; scans or captures no longer make the app guess "copy".
        XCTAssertFalse(project(["kind": "fit", "scan": "reference.usdz", "capture": ["reference.heic"]]).usesCopyWorkflow)
        XCTAssertTrue(project(["kind": "copy", "scan": "scan.usdz"]).usesCopyWorkflow)
        XCTAssertFalse(project(["kind": "published"]).usesCopyWorkflow)
        XCTAssertFalse(project(["kind": "fit", "instructions": "A guitar pick that says Vivi"]).usesCopyWorkflow)
    }

    private var confirmation: [String: Any] { [
        "id": "question-1", "message": "Check the printer.\nConfirm **each** item before continuing.",
        "expiresAtMs": 1000, "supported": true,
        "fields": [["name": "spools", "title": "The spools match", "description": "Check the loaded filament.", "required": true],
                   ["name": "watch", "title": "Watch the first layer", "required": false]]
    ] }

    func testPrinterConfirmationPreservesTheQuestion() throws {
        let p = ready(["state": "printing", "printConfirmation": confirmation])
        let question = try XCTUnwrap(p.printConfirmation)
        XCTAssertEqual(question.message, "Check the printer.\nConfirm **each** item before continuing.")
        XCTAssertEqual(question.fields.first?.description, "Check the loaded filament.")
        XCTAssertEqual(ProjectWords(p).status, "Your printer needs your confirmation.")
        XCTAssertTrue(ProjectWords(p).busy)
        XCTAssertTrue(ProjectWords(p).actions.isEmpty, "only the sheet answers the MCP question")
        XCTAssertNil(ready().printConfirmation, "older companion responses still decode")
    }

    func testPrinterConfirmationRequiresExplicitChecksAndCurrentQuestion() throws {
        let question = try XCTUnwrap(ready(["printConfirmation": confirmation]).printConfirmation)
        XCTAssertFalse(question.canAccept([:], atMs: 999))
        XCTAssertFalse(question.canAccept(["spools": false], atMs: 999))
        XCTAssertTrue(question.canAccept(["spools": true], atMs: 999))
        XCTAssertFalse(question.canAccept(["spools": true], atMs: 1000))
        XCTAssertNil(question.response(confirmationId: "old", action: .accept, content: ["spools": true], atMs: 999))
        XCTAssertNil(question.response(confirmationId: question.id, action: .accept, content: [:], atMs: 999))
        let accepted = try XCTUnwrap(question.response(confirmationId: question.id, action: .accept,
                                                       content: ["spools": true, "unrelated": true], atMs: 999))
        XCTAssertEqual(accepted.answer.content, ["spools": true, "watch": false])
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(accepted)) as? [String: Any])
        XCTAssertEqual(json["confirmationId"] as? String, question.id)
        XCTAssertEqual((json["answer"] as? [String: Any])?["action"] as? String, "accept")
        XCTAssertNil(question.response(confirmationId: question.id, action: .cancel, content: [:], atMs: 1000))
    }

    func testUnknownPrinterSchemaCanOnlyBeCancelled() throws {
        var unknown = confirmation
        unknown["supported"] = false
        let question = try XCTUnwrap(ready(["printConfirmation": unknown]).printConfirmation)
        XCTAssertFalse(question.canAccept(["spools": true], atMs: 999))
        XCTAssertNil(question.response(confirmationId: question.id, action: .accept, content: ["spools": true], atMs: 999))
        let cancelled = try XCTUnwrap(question.response(confirmationId: question.id, action: .cancel, content: ["spools": true], atMs: 999))
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
        XCTAssertEqual(ProjectWords(project([:])).status, "Add photos or a scan.")
        XCTAssertEqual(ProjectWords(project(["scan": "scan.usdz", "state": "touching-up"])).status,
                       "Touching up your scan. You can leave this project and return to it while your Mac works.")
        XCTAssertEqual(ProjectWords(project(["instructions": "A hook", "state": "touching-up"])).status,
                       "Making it. You can leave this project and return to it while your Mac works.")
        XCTAssertEqual(ProjectWords(ready(["state": "touching-up", "passes": [["startedAtMs": 1], ["startedAtMs": 3, "note": "thicker"]]])).status,
                       "Making your changes. You can leave this project and return to it while your Mac works.")
        XCTAssertEqual(ProjectWords(ready()).status, "Ready to print")
        XCTAssertEqual(ProjectWords(ready(["state": "printing"])).status, "Preparing print…")
        // The companion's status while the printer MCP sends the file (counterpart/1 upload progress).
        XCTAssertEqual(ProjectWords(ready(["state": "printing", "progress": "Sending to the printer… 62%"])).status, "Sending to the printer… 62%")
        XCTAssertEqual(ProjectWords(ready(["state": "printed"])).status, "Print request accepted")
        XCTAssertEqual(ProjectWords(project(["state": "failed"])).status, "Something went wrong on your Mac.")
    }

    func testActionsFollowTheState() {
        XCTAssertEqual(ProjectWords(ready()).actions, [.print, .correct])
        XCTAssertEqual(ProjectWords(project(["state": "needs-closeup", "question": ["closeup": "the underside"]])).actions, [.openCamera, .attachPhotos, .bestGuess])
        XCTAssertEqual(ProjectWords(project(["state": "needs-closeup", "question": ["closeup": "the underside"]])).status,
                       "Can you send me a close-up of the underside? I can't see what's happening there.")
        XCTAssertEqual(ProjectWords(ready(["state": "printing"])).status, "Preparing print…")
        XCTAssertEqual(ProjectWords(ready(["state": "printing"])).actions, [])
        XCTAssertEqual(ProjectWords(ready(["state": "failed", "failure": "x", "print": ["bundleId": "b", "uncertain": true]])).actions, [.printChecked, .correct])
        XCTAssertEqual(ProjectWords(project(["state": "failed", "failure": "Blender is not open on your Mac."])).actions, [.retry, .correct])
        XCTAssertEqual(ProjectWords(project(["scan": "scan.usdz"])).actions, [.finishSending])
        XCTAssertTrue(ProjectWords(ready(["state": "printing"])).busy)
        XCTAssertFalse(ProjectWords(ready()).busy)
    }

    func testCappedRetryUsesActualPublicProjectJSONWithoutPassActivity() throws {
        struct Row: Decodable {
            var name: String
            var expected: Project
            var retry: Bool
            var checkedPrint: Bool
        }
        let rows = try JSONDecoder().decode([Row].self, from: fixture("capped-projects.json"))
        for row in rows {
            XCTAssertTrue(row.expected.passes.allSatisfy { $0.activity == nil }, row.name)
            let words = ProjectWords(row.expected)
            if row.name.hasPrefix("limit-") {
                XCTAssertEqual(words.status, row.expected.failure, row.name)
                XCTAssertFalse(words.line.lowercased().contains("cancelled"), row.name)
            }
            let actions = words.actions
            XCTAssertEqual(actions.contains(.retry), row.retry, row.name)
            XCTAssertTrue(actions.contains(.correct), row.name)
            XCTAssertTrue(actions.contains(row.checkedPrint ? .printChecked : .print), row.name)
        }
    }

    func testSizeKeepsTenthsOfAMillimetre() {
        XCTAssertEqual(ProjectWords(ready()).size, "61.6 × 75.2 × 49.4 mm")
        XCTAssertNil(ProjectWords(project([:])).size)
    }

    func testWhatWasSent() {
        XCTAssertEqual(ProjectWords.sent(project(["scan": "scan.usdz", "photos": Array(repeating: "a.jpg", count: 24)])), "A scan and 24 photos")
        XCTAssertEqual(ProjectWords.sent(project(["photos": ["a.jpg"]])), "1 photo")
        XCTAssertEqual(ProjectWords.sent(project(["instructions": "A hook"])), "Just the description")
    }

    /// An older companion still sends a `plate` object. It's ignored: the project decodes, nothing asks about it,
    /// and the print is still being prepared.
    func testAnOlderCompanionsPlateObjectIsIgnored() throws {
        let older = ready(["state": "printing", "plate": ["item": "a spool", "noCamera": true, "photo": true]])
        XCTAssertEqual(older.id, ready().id)
        XCTAssertEqual(ProjectWords(older).status, "Preparing print…")
        XCTAssertEqual(ProjectWords(older).phase, .preparing)
        XCTAssertEqual(ProjectWords(older).actions, [])
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(older)) as? [String: Any])
        XCTAssertNil(encoded["plate"], "never kept or sent back")
        // An odd value of any type decodes too.
        XCTAssertEqual(ProjectWords(ready(["state": "printing", "plate": "blocked"])).phase, .preparing)
    }

    func testUnknownStatesFromANewerMacStillDecode() {
        XCTAssertEqual(ProjectWords(project(["state": "something-new"])).status, "Update Counterpart to see this one.")
        XCTAssertEqual(ProjectWords(project(["state": "something-new"])).phase, .unknown)
    }

    // MARK: PRD §4 phases

    func testAScanStillOnlyOnThisPhoneCanBeSentFromItsProject() {
        let words = ProjectWords(project([:]), localScan: true)
        XCTAssertEqual(words.status, "Scan saved on this phone. Send it to your Mac to begin.")
        XCTAssertEqual(words.line, "Scan saved · send to your Mac")
        XCTAssertEqual(words.actions, [.finishSending])
        XCTAssertEqual(words.title, "Scanned object")
    }

    func testSavedDraftDoesNotLookLikeAnActiveUploadAndThePhoneCanStillShowSending() {
        let idle = project(["status": ["phase": "draft", "text": "Add photos or a scan", "symbol": "square.and.pencil", "tint": "secondary"]])
        XCTAssertEqual(ProjectWords(idle).phase, .draft)
        XCTAssertEqual(ProjectWords(idle).line, "Add photos or a scan")
        XCTAssertFalse(ProjectWords(idle).busy)
        XCTAssertFalse(ProjectWords(idle).phase.isRunning)
        XCTAssertEqual(ProjectWords(idle, sending: true).phase, .sending)
        XCTAssertTrue(ProjectWords(idle, sending: true).busy)
        XCTAssertEqual(ProjectWords(idle, sending: true).line, "Sending to your Mac")
    }

    func testPhasesFollowThePRDTable() {
        XCTAssertEqual(ProjectWords(project([:])).phase, .draft)
        XCTAssertEqual(ProjectWords(project(["scan": "scan.usdz"])).phase, .draft, "a send cut short is a draft until this phone sends again")
        XCTAssertEqual(ProjectWords(project(["scan": "scan.usdz"]), sending: true).phase, .sending)
        XCTAssertEqual(ProjectWords(project(["scan": "scan.usdz"]), sending: true).status, "Sending to your Mac. Keep the app open until it finishes.")
        XCTAssertEqual(ProjectWords(project(["state": "touching-up"])).phase, .working)
        XCTAssertEqual(ProjectWords(project(["state": "needs-closeup"])).phase, .needsYou)
        XCTAssertEqual(ProjectWords(ready()).phase, .ready)
        XCTAssertEqual(ProjectWords(ready(["state": "printing"])).phase, .preparing, "printing starts only when the printer reports our job")
        XCTAssertEqual(ProjectWords(ready(["state": "printed"])).phase, .sent, "accepted isn't printed until the monitor says so")
        XCTAssertEqual(ProjectWords(ready(["state": "printed", "print": ["bundleId": "b", "monitor": ["phase": "ended", "endState": "done"]]])).phase, .printed)
        XCTAssertEqual(ProjectWords(project(["state": "failed"])).phase, .failed)
        // KAN-214 #199: a print Counterpart can't follow ends at `sent`; no "done" follows.
        let sent = ready(["state": "sent", "print": ["bundleId": "b", "uncertain": true, "fileBase": "mic-mount", "destination": ["id": "current", "name": "Ender 3"],
                                                      "monitor": ["phase": "ended", "endState": "sent"]]])
        XCTAssertEqual(ProjectWords(sent).phase, .sent)
        XCTAssertEqual(ProjectWords(sent).line, "Sent to Ender 3 · Counterpart can't follow this print")
        XCTAssertFalse(ProjectWords(sent).busy)
        XCTAssertEqual(ProjectWords(sent).actions, [.printChecked, .correct], "it may be printing, so Print asks first (checked: true); changes still work")
        let connect = ready(["state": "sent", "print": ["bundleId": "b", "uncertain": true, "sentVia": "bambu-connect"]])
        XCTAssertEqual(ProjectWords(connect).line, "Finish on your Mac: press Print in Bambu Connect")
        // A status without its symbol or tint still decodes, and the Mac's phase and words win.
        let told = ready(["state": "sent", "status": ["phase": "sent", "text": "Sent to Ender 3 · Counterpart can't follow this print"]])
        XCTAssertEqual(ProjectWords(told).phase, .sent)
        XCTAssertEqual(ProjectPhase.sent.symbol, "paperplane")
        for phase in ProjectPhase.allCases { XCTAssertFalse(phase.symbol.isEmpty); XCTAssertFalse(phase.label.isEmpty) }
    }

    /// "Did it fit?" after a finished print (PRD §5.4): It works confirms it; Needs changes asks for changes.
    func testAFinishedPrintAsksDidItFitAndConfirmedIsDone() {
        let finished = ready(["state": "printed", "print": ["bundleId": "b", "monitor": ["phase": "ended", "endState": "done", "endedAt": "2026-10-31T09:00:00Z"]]])
        XCTAssertEqual(Array(ProjectWords(finished).actions.prefix(2)), [.itWorks, .needsChanges])
        XCTAssertEqual(ProjectWords.outcomeQuestion(finished), "Did it fit?")
        var published = finished; published.kind = "published"
        XCTAssertEqual(ProjectWords.outcomeQuestion(published), "Did it come out right?")
        XCTAssertFalse(ProjectWords(ready(["state": "printed"])).actions.contains(.itWorks), "only a print the monitor saw finish")
        let confirmed = ready(["state": "confirmed", "print": ["bundleId": "b", "monitor": ["phase": "ended", "endState": "done", "endedAt": "2026-10-31T09:00:00Z"]]])
        let words = ProjectWords(confirmed, now: ISO.date("2026-11-01T12:00:00Z")!)
        XCTAssertEqual(words.phase, .confirmed)
        XCTAssertEqual(words.phase.symbol, "checkmark.circle.fill")
        XCTAssertEqual(words.phase.label, "Done")
        XCTAssertEqual(words.line, "Done · it works")
        XCTAssertFalse(words.actions.contains(.itWorks))
    }

    /// The status you set (Project Settings): Works is Done once nothing runs; an answered card isn't asked again;
    /// an unknown status from a newer Mac changes nothing; Archived is only a flag.
    func testTheStatusYouSetDecidesDone() {
        let ended: [String: Any] = ["bundleId": "b", "monitor": ["phase": "ended", "endState": "done", "endedAt": "2026-10-31T09:00:00Z"]]
        XCTAssertEqual(ProjectWords(ready(["settings": ["status": "works"]])).phase, .confirmed, "printed elsewhere, marked Works by hand")
        XCTAssertEqual(ProjectWords(ready(["settings": ["status": "works"]])).line, "Done · it works")
        let stale = ready(["settings": ["status": "works"], "status": ["phase": "ready", "text": "Ready to print", "symbol": "", "tint": "accent"]])
        XCTAssertEqual(ProjectWords(stale).line, "Done · it works", "never Done with the Mac's Ready words beside it")
        let mac = ready(["state": "confirmed", "settings": ["status": "works"], "status": ["phase": "confirmed", "text": "It works", "symbol": "checkmark.circle.fill", "tint": "green"]])
        XCTAssertEqual(ProjectWords(mac).phase, .confirmed)
        XCTAssertEqual(ProjectWords(mac).line, "It works", "the Mac's own words for Works")
        XCTAssertEqual(ProjectWords(ready(["state": "printed", "print": ended, "outcome": "works"])).phase, .confirmed, "the older outcome field")
        XCTAssertEqual(ProjectWords(ready(["state": "touching-up", "settings": ["status": "works"]])).phase, .working, "a new pass runs: not Done")
        let changes = ProjectWords(ready(["state": "printed", "print": ended, "settings": ["status": "needs-changes"]]))
        XCTAssertEqual(changes.phase, .printed)
        XCTAssertFalse(changes.actions.contains(.itWorks), "answered: not asked again")
        let newer = ready(["state": "printed", "print": ended, "settings": ["status": "something-new", "copies": 3]])
        XCTAssertNil(newer.projectStatus)
        XCTAssertEqual(Array(ProjectWords(newer).actions.prefix(2)), [.itWorks, .needsChanges])
        XCTAssertFalse(ProjectWords(ready(["state": "printed", "print": ended, "settings": ["status": "archived"]])).actions.contains(.itWorks))
        XCTAssertTrue(ProjectWords(ready(["state": "printed", "print": ended, "settings": ["status": "printed"]])).actions.contains(.itWorks))
        XCTAssertTrue(ready(["settings": ["status": "archived"]]).isArchived)
        XCTAssertEqual(ProjectWords(ready(["settings": ["status": "archived"]])).phase, .ready)
        XCTAssertEqual(ProjectWords(ready(["settings": "odd"])).phase, .ready, "an odd settings value decodes")
        XCTAssertEqual(ProjectStatus.choices.map(\.label), ["Not printed", "Printed", "Done", "Needs changes"], "Archive is apart")
        // A reprint the Mac can't follow (sent, uncertain) isn't Done, whatever was said about the last one.
        let resent = ready(["state": "sent", "settings": ["status": "works"], "outcome": "works", "print": ["bundleId": "b2", "uncertain": true, "sentVia": "bambu-connect"]])
        XCTAssertEqual(ProjectWords(resent).phase, .sent)
        XCTAssertEqual(ProjectWords(ready(["settings": ["status": "works"], "print": ["bundleId": "b", "uncertain": true]])).phase, .ready, "an uncertain print isn't Done")
        // Done prints another with no uncertain-print check.
        let doneUncertain = ready(["state": "confirmed", "settings": ["status": "works"], "print": ["bundleId": "b", "uncertain": true]])
        XCTAssertEqual(ProjectWords(doneUncertain).actions, [.print, .correct])
        // Archive is apart from the status: a Done project archived stays Done, and Unarchive knows what was under it.
        let archivedDone = ready(["state": "confirmed", "settings": ["status": "archived"], "outcome": "works", "archived": true])
        XCTAssertTrue(archivedDone.isArchived)
        XCTAssertEqual(ProjectWords(archivedDone).phase, .confirmed)
        XCTAssertEqual(archivedDone.statusUnderneath, .works)
        XCTAssertEqual(ready(["state": "printed", "outcome": "needs-changes", "archived": true]).statusUnderneath, .needsChanges)
        XCTAssertEqual(ready(["state": "sent", "archived": true]).statusUnderneath, .printed)
        XCTAssertEqual(ready(["archived": true]).statusUnderneath, .notPrinted)
        // Where the Mac keeps archive apart, the status itself is what's under it.
        XCTAssertEqual(ready(["state": "printed", "settings": ["status": "needs-changes", "archived": true]]).statusUnderneath, .needsChanges)
        XCTAssertEqual(ready(["settings": ["status": "works", "archived": true]]).statusUnderneath, .works)
        // A Mac with the archive setting says so itself.
        XCTAssertFalse(ready(["settings": ["status": "works", "archived": false], "archived": true]).isArchived)
        XCTAssertTrue(ready(["settings": ["status": "works", "archived": true]]).isArchived)
    }

    /// KAN-214 #237: a print on the printer getting ready (dispatched, monitor starting or watching) belongs on the
    /// Printing screen; slicing or sending (not yet dispatched) stays on the project page.
    func testAPrintGettingReadyOnThePrinterIsWatchable() {
        let preparing: [String: Any] = ["phase": "preparing", "text": "Getting ready · Heating", "symbol": "printer", "tint": "accent"]
        let sent = ready(["state": "printing", "status": preparing,
                          "print": ["bundleId": "b", "printId": "p", "dispatchedAt": "2026-11-02T08:00:00Z", "monitor": ["phase": "starting"]]])
        XCTAssertTrue(ProjectWords.watchable(sent, phase: ProjectWords(sent).phase))
        let tapped = ready(["state": "printing", "status": preparing, "print": ["bundleId": "b", "printId": "p"]])
        XCTAssertFalse(ProjectWords.watchable(tapped, phase: ProjectWords(tapped).phase), "Print tapped, still slicing or sending")
        XCTAssertEqual(ProjectWords(sent).line, "Getting ready · Heating", "the Mac's words, no percent")
    }

    func testCardLines() {
        XCTAssertEqual(ProjectWords(ready()).line, "Ready to print · 61.6 × 75.2 × 49.4 mm")
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

    /// In a list grouped by phase the row shows the Mac's detail, never its section's heading again (David's iPad,
    /// Nov 10: "Needs you · Kroger doesn't publi…" under Needs you, "Ready to print · 68.4 × 34.6 × 149…" under Ready).
    func testARowUnderItsHeadingShowsOnlyWhatDiffers() throws {
        func project(_ status: String) throws -> Project {
            try JSONDecoder().decode(Project.self, from: Data(#"{"id":"p","createdAtMs":1,"updatedAtMs":2,"state":"ready","photos":[],"passes":[],"status":\#(status)}"#.utf8))
        }
        let asking = try project(#"{"phase":"needs-you","text":"Needs you · Can you confirm these sizes?","detail":"Can you confirm these sizes?","symbol":"hand.raised","tint":"orange"}"#)
        XCTAssertEqual(ProjectWords.row(asking, line: "Needs you · Can you confirm these sizes?"), "Can you confirm these sizes?")
        let ready = try project(#"{"phase":"ready","text":"Ready to print · 68.4 × 34.6 × 149.2 mm","detail":"68.4 × 34.6 × 149.2 mm","symbol":"checkmark.seal","tint":"accent"}"#)
        XCTAssertEqual(ProjectWords.row(ready, line: "Ready to print · 68.4 × 34.6 × 149.2 mm"), "68.4 × 34.6 × 149.2 mm")
        // An older Mac, or a line that is already only what differs: the line as it is.
        let failed = try project(#"{"phase":"failed","text":"The printer stopped.","symbol":"exclamationmark.triangle","tint":"red"}"#)
        XCTAssertEqual(ProjectWords.row(failed, line: "The printer stopped."), "The printer stopped.")
        XCTAssertEqual(ProjectWords.row(try project(#"{"phase":"ready","text":"Ready to print","detail":"  ","symbol":"","tint":"accent"}"#), line: "Ready to print"), "Ready to print")
    }

    /// How a pass ended is the Mac's own words on every client; an older Mac's status is worded here, with the
    /// spelling it really sends (`needs_closeup`, never `needs-closeup`).
    func testAPassEndsInTheMacsWords() throws {
        func pass(_ json: String) throws -> Project.Pass { try JSONDecoder().decode(Project.Pass.self, from: Data(json.utf8)) }
        XCTAssertEqual(try pass(#"{"startedAtMs":1,"endedAtMs":2,"status":"capped","words":"Stopped at the 120 tool-call limit"}"#).endingWords, "Stopped at the 120 tool-call limit")
        XCTAssertNil(try pass(#"{"startedAtMs":1,"status":"done","words":"Finished"}"#).endingWords, "a running pass has not ended")
        XCTAssertEqual(try pass(#"{"startedAtMs":1,"endedAtMs":2,"status":"needs_closeup"}"#).endingWords, "Asked you a question")
        XCTAssertEqual(try pass(#"{"startedAtMs":1,"endedAtMs":2,"status":"done"}"#).endingWords, "Finished")
        XCTAssertEqual(try pass(#"{"startedAtMs":1,"endedAtMs":2}"#).endingWords, "Finished")
        XCTAssertEqual(try pass(#"{"startedAtMs":1,"endedAtMs":2,"status":"needs_file"}"#).endingWords, "Needs File")
    }

    /// A pass that stopped to ask, or stopped short, must never read as all green ticks (seen on real data Nov 10:
    /// a failed pass and a pass waiting on a question each showed three ticks), and a change says what was asked.
    func testAPassSaysHowItLeftThingsAndWhatItWasAsked() throws {
        func pass(_ json: String) throws -> Project.Pass { try JSONDecoder().decode(Project.Pass.self, from: Data(json.utf8)) }
        XCTAssertNil(try pass(#"{"startedAtMs":1,"status":"failed"}"#).ending, "still running")
        for (status, ending) in [("done", Project.Pass.Ending.finished), ("unchanged", .finished), ("needs_closeup", .asked), ("needs_file", .asked),
                                 ("capped", .stopped), ("failed", .stopped), ("interrupted", .stopped)] {
            XCTAssertEqual(try pass(#"{"startedAtMs":1,"endedAtMs":2,"status":"\#(status)"}"#).ending, ending, status)
        }
        XCTAssertEqual(try pass(#"{"startedAtMs":1,"endedAtMs":2}"#).ending, .finished)
        XCTAssertEqual(try pass(#"{"startedAtMs":1,"endedAtMs":2,"trigger":"changes","note":"  make it thicker "}"#).requestedChange, "make it thicker")
        XCTAssertNil(try pass(#"{"startedAtMs":1,"endedAtMs":2,"trigger":"ask-answer","note":"Answer to \"Q?\": yes"}"#).requestedChange, "an answer is not a change")
        XCTAssertNil(try pass(#"{"startedAtMs":1,"endedAtMs":2,"trigger":"new"}"#).requestedChange)
        // Every trigger the Mac writes: a note sent with photos is still the person's change (train #499 review, F5).
        for (trigger, shown) in [("changes", true), ("late-photos", true), ("ask-answer", false), ("new", false), ("something-later", false)] {
            let change = try pass(#"{"startedAtMs":1,"endedAtMs":2,"trigger":"\#(trigger)","note":"see the photos"}"#).requestedChange
            XCTAssertEqual(change, shown ? "see the photos" : nil, trigger)
        }
        XCTAssertEqual(try pass(#"{"startedAtMs":1,"endedAtMs":2,"note":"from an older Mac"}"#).requestedChange, "from an older Mac")
    }
}
