import XCTest
import Foundation
@testable import ControlKit

/// PRD §4's state table, as the Mac says it. When CounterpartKit lands these move with the words.
private func object(_ fields: [String: Any]) -> StmObject {
    var json: [String: Any] = ["id": "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11", "createdAtMs": 1, "updatedAtMs": 1,
                               "state": "new", "photos": [], "passes": [], "directory": "/tmp/object"]
    json.merge(fields) { $1 }
    return try! JSONDecoder().decode(StmObject.self, from: JSONSerialization.data(withJSONObject: json))
}
private let readyFields: [String: Any] = [
    "scan": "scan.usdz", "state": "ready",
    "passes": [["startedAtMs": 1, "endedAtMs": 2, "status": "done"]],
    "current": ["model": "current/model.stl", "renders": ["current/renders/front.png"], "sizeMm": [48.2, 50.4, 53.6],
                "summary": "Added the two eyes."],
]
private func ready(_ fields: [String: Any] = [:]) -> StmObject { object(readyFields.merging(fields) { $1 }) }

final class ObjectWordsTests: XCTestCase {
    func testNamesAProjectByItsGeneratedTitleThenItsRequest() {
        XCTAssertEqual(object(["title": "Mic mount", "instructions": "Something that holds this mic."]).words.title, "Mic mount")
        XCTAssertEqual(object(["title": "  ", "instructions": "A hook for a 25 mm tube. It should hold a cup."]).words.title,
                       "A hook for a 25 mm tube")
        XCTAssertEqual(object(["scan": "scan.usdz"]).words.title, "Copy of your scan")
        XCTAssertEqual(object(["photos": ["a.jpg"]]).words.title, "Project from your photos")
        XCTAssertEqual(object([:]).words.title, "New project")
        XCTAssertEqual(object(["instructions": "a bracket, 3 mm thick, with two holes, for the shelf"]).words.title,
                       "a bracket, 3 mm thick, with two holes")
        let long = object(["instructions": "A replacement knob for the bathroom cabinet that matches the others exactly"]).words.title
        XCTAssertEqual(long, "A replacement knob for the bathroom cabinet that matches…")
    }

    func testEveryStateHasItsPRDWordsAndOneSidebarGroup() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func words(_ o: StmObject) -> ObjectWords { ObjectWords(o, now: now) }
        XCTAssertEqual(words(object([:])).status, "Sending to your Mac")
        XCTAssertEqual(words(object([:])).group, .now)
        XCTAssertEqual(words(object(["state": "touching-up"])).status, "Your Mac is working")
        XCTAssertEqual(words(object(["state": "touching-up", "progress": "Matching your photos…"])).status, "Matching your photos")
        let estimated = object(["state": "touching-up", "progress": "Getting Blender ready",
                                "passes": [["startedAtMs": 1, "estimate": ["remainingSec": 230, "endsAtMs": (now.timeIntervalSince1970 + 230) * 1000],
                                            "stages": [["id": "building", "words": "Building the model", "startedAtMs": 1, "endedAtMs": 2, "typicalSec": 60],
                                                       ["id": "working", "words": "Matching your photos", "startedAtMs": 2, "typicalSec": 200]]]]])
        XCTAssertEqual(words(estimated).status, "Matching your photos · about 4 min", "the running stage's words, then the time left")
        XCTAssertEqual(words(ready()).status, "Ready to print · 48 × 50 × 54 mm")
        XCTAssertEqual(words(ready()).group, .ready)
        XCTAssertEqual(words(ready(["state": "printing"])).status, "Getting the print ready")
        XCTAssertEqual(words(ready(["state": "printing"])).stage, .preparing)
        let printing = ready(["state": "printing", "print": ["bundleId": "b", "destination": ["id": "p", "name": "P1S"],
                              "printerStatus": ["state": "RUNNING", "checkedAtMs": 1, "percent": 42, "remainingMinutes": 38]]])
        XCTAssertEqual(words(printing).status, "Printing on P1S · 42% · 38 min left")
        XCTAssertEqual(words(printing).progress, 0.42)
        XCTAssertEqual(words(printing).group, .now)
        let monitor: [String: Any] = ["bundleId": "b", "destination": ["id": "p", "name": "P1S"], "monitor": ["phase": "ended", "endState": "done"]]
        let printed = ready(["state": "printed", "updatedAtMs": (now.timeIntervalSince1970 - 86_400) * 1000, "print": monitor])
        XCTAssertEqual(words(printed).status, "Printed yesterday")
        XCTAssertEqual(words(printed).group, .printed)
        XCTAssertEqual(words(ready(["state": "printed", "updatedAtMs": now.timeIntervalSince1970 * 1000, "print": monitor])).status, "Printed today")
        // Before the print monitor, `printed` only meant the printer took the job.
        let sent = ready(["state": "printed", "updatedAtMs": now.timeIntervalSince1970 * 1000, "print": ["bundleId": "b", "destination": ["id": "p", "name": "P1S"]]])
        XCTAssertEqual(words(sent).status, "Sent to P1S today")
        XCTAssertEqual(words(sent).capsule, "Sent to the printer", "the capsule never says Printed for a job nobody watched finish")
        XCTAssertEqual(words(sent).stage, .sent)
        XCTAssertEqual(words(sent).group, .printed)
        let followless = ready(["state": "sent", "print": ["bundleId": "b", "destination": ["id": "p", "name": "Garage MK4"]]])
        XCTAssertEqual(words(followless).status, "Sent to Garage MK4 · Counterpart can't follow this print")
        XCTAssertEqual(words(followless).stage, .sent)
        XCTAssertFalse(words(followless).busy, "terminal: nothing to wait for")
        XCTAssertEqual(words(sent).subtitle(request: nil), "Sent to the printer")
        XCTAssertEqual(words(printed).capsule, "Printed")
        let running = ready(["state": "printed", "updatedAtMs": now.timeIntervalSince1970 * 1000, "print": ["bundleId": "b", "destination": ["id": "p", "name": "P1S"],
                             "printerStatus": ["state": "RUNNING", "checkedAtMs": 1, "percent": 12, "remainingMinutes": 50]]])
        XCTAssertEqual(words(running).status, "Sent to P1S today",
                       "the printer's report isn't tied to this job, so it never makes an old project look like it's printing")
    }

    func testTheCompanionsOwnStatusLineWinsOnceServed() {
        let served = ready(["state": "printing", "status": ["phase": "printing", "text": "Printing on Bambu Lab P1S · 42% · 1 h 5 min left",
                                                              "symbol": "printer.fill", "tint": "green"]]).words
        XCTAssertEqual(served.status, "Printing on Bambu Lab P1S · 42% · 1 h 5 min left")
        XCTAssertEqual(served.stage, .printing)
        let future = ready(["status": ["phase": "archived", "text": "Archived"]]).words
        XCTAssertEqual(future.stage, .ready, "an unknown phase keeps the app's own reading")
        let live = ready(["state": "printing", "print": ["bundleId": "b", "destination": ["id": "p", "name": "P1S"],
                          "live": ["source": "counterpart", "observedAt": "2026-11-01T10:00:00Z", "state": "paused",
                                   "job": ["name": "mic", "progress": 61.4, "remainingSec": 1500], "problems": []]]]).words
        XCTAssertEqual(live.status, "Paused on P1S · 61% · 25 min left")
        let ask = ready(["state": "needs-closeup", "question": ["closeup": "old"],
                         "ask": ["id": "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a12", "question": "Needs a close-up of the underside",
                                 "answers": ["camera", "best-guess"], "status": "open", "askedAtMs": 1]]).words
        XCTAssertEqual(ask.question, "Needs a close-up of the underside")
    }

    func testNothingFallsOutOfTheSidebar() {
        let states = ["new", "touching-up", "needs-closeup", "ready", "printing", "printed", "sent", "failed", "archived"]
        for state in states { XCTAssertTrue(ProjectGroup.allCases.contains(ready(["state": state]).words.group), state) }
        XCTAssertEqual(object(["state": "archived"]).words.group, .now)
        XCTAssertEqual(object(["state": "failed"]).words.group, .needsYou)
        XCTAssertEqual(Set(ProjectStage.allCases.map(ObjectWords.group)), Set(ProjectGroup.allCases))
    }

    func testNeedsYouAsksOneSpecificQuestion() {
        let closeup = ready(["state": "needs-closeup", "question": ["closeup": "the underside"]]).words
        XCTAssertEqual(closeup.status, "Needs a close-up of the underside")
        XCTAssertEqual(closeup.stage, .needsYou)
        XCTAssertEqual(closeup.group, .needsYou)
        XCTAssertEqual(closeup.actions, [.bestGuess])
        XCTAssertEqual(closeup.subtitle(request: "Copy this plush. Include the bottom."),
                       "Needs you · Needs a close-up of the underside · copy this plush")
        let plate = ready(["state": "printing", "plate": ["item": "a printed part", "photo": true]]).words
        XCTAssertEqual(plate.status, "Getting the print ready")
        XCTAssertEqual(plate.actions, [])
        XCTAssertEqual(plate.group, .now)
        XCTAssertEqual(ready(["state": "printing", "plate": ["noCamera": true]]).words.status, "Getting the print ready")
        let confirm = ready(["state": "printing", "print": ["bundleId": "b", "destination": ["id": "p", "name": "P1S"]],
                             "printConfirmation": ["id": "q", "message": "Check.", "expiresAtMs": 2000, "fields": [], "supported": true]]).words
        XCTAssertEqual(confirm.status, "P1S needs a yes before printing")
        XCTAssertEqual(confirm.actions, [], "the confirmation itself is answered, never Plate clear")
        XCTAssertTrue(confirm.busy)
    }

    func testAReadyProjectPrintsOrTakesChanges() {
        XCTAssertEqual(ready().words.actions, [.print, .correct])
        XCTAssertEqual(ready().words.size, "48 × 50 × 54 mm")
        XCTAssertEqual(ObjectWords.formatSize([10.4, 20.5, 3]), "10 × 21 × 3 mm")
        XCTAssertEqual(ObjectWords.formatMinutes(72), "1 h 12 min")
        XCTAssertEqual(ready(["title": "Mic mount"]).words.subtitle(request: "Something that holds the mic. Both are in the photos."),
                       "Ready to print · something that holds the mic", "the size has its own capsule")
    }

    func testAFailureSaysWhatHappenedAndWhatToDo() {
        let touchUp = object(["scan": "scan.usdz", "state": "failed", "failure": "blender is not open on your Mac."]).words
        XCTAssertEqual(touchUp.status, "Blender is not open on your Mac · Try again")
        XCTAssertEqual(touchUp.actions, [.retry, .correct])
        XCTAssertEqual(ready(["state": "failed", "failure": "The printer is busy."]).words.status,
                       "The printer is busy · Print again or ask for changes")
        XCTAssertEqual(object(["state": "failed", "failure": "  "]).words.status, "Something went wrong on your Mac · Try again")
    }

    func testAPrintThatMayHaveStartedIsSentAgainOnlyAfterTheUserChecks() {
        let uncertain = ready(["state": "failed", "failure": "The printer may have started this print.",
                               "print": ["bundleId": "b1", "uncertain": true]]).words
        XCTAssertEqual(uncertain.actions, [.printChecked, .correct])
        XCTAssertEqual(ready(["print": ["bundleId": "b1"]]).words.actions, [.print, .correct])
    }

    func testBusyStatesKeepThePageUpToDate() {
        XCTAssertFalse(object([:]).words.busy)
        XCTAssertTrue(object(["state": "touching-up"]).words.busy)
        XCTAssertTrue(ready(["state": "printing"]).words.busy)
        XCTAssertFalse(ready().words.busy)
        XCTAssertFalse(ready(["state": "needs-closeup"]).words.busy)
    }

    func testDecodesTheFieldsTheCompanionIsAddingWithoutRequiringThem() {
        let o = ready(["current": ["model": "m.stl", "renders": [],
                                   "changes": [["tag": "added", "text": "Cup"], ["tag": "estimated", "text": "Pole", "toleranceMm": 0.5]]],
                       "print": ["bundleId": "b", "printId": "p1", "events": [["atMs": 1, "message": "Started"]]]])
        XCTAssertEqual(o.current?.changes.map(\.tag), ["added", "estimated"])
        XCTAssertEqual(o.print?.events?.first?.message, "Started")
        XCTAssertEqual(ready(["current": ["model": "m.stl", "renders": [], "changes": "garbled"]]).current?.changes, [],
                       "a bad optional never hides the project")
        XCTAssertEqual(ready(["scan": "scan.usdz"]).scanURL?.path, "/tmp/object/scan/scan.usdz")
    }

    func testCopyNeverNamesTheMachinery() {
        let all = [object([:]), object(["state": "touching-up"]), ready(), ready(["state": "printing", "plate": ["noCamera": true]]),
                   ready(["state": "needs-closeup"]), object(["state": "failed"]), object(["state": "archived"])]
        for words in all.map(\.words) {
            for text in [words.title, words.status, words.stage.label] {
                for banned in ["companion", "MCP", "job"] { XCTAssertFalse(text.localizedCaseInsensitiveContains(banned), text) }
            }
        }
    }
}

final class PrintSettingsTests: XCTestCase {
    func testStandardSendsNothingSoTheMCPPresetDecides() {
        XCTAssertEqual(PrintSettings().params, [:], "nothing to send: the MCP's preset and own defaults")
        let chosen = PrintSettings(quality: .fine, strength: .max, colour: .amsSlot(2)).params
        XCTAssertEqual(chosen["quality"], .string("fine"))
        XCTAssertEqual(chosen["strength"], .string("max"))
        XCTAssertEqual(chosen["colour"], .object(["amsSlot": .number(2)]))
        XCTAssertNil(chosen["plateCheck"], "no plate prompt: the printer MCP's own confirmation is the check")
        XCTAssertEqual(PrintSettings(colour: .auto).params["colour"], .object(["auto": .bool(true)]), "the user kept the preselection")
        XCTAssertEqual(PrintSettings(colour: .external).params["colour"], .object(["external": .bool(true)]))
    }

    func testTheEstimateAndSuggestedTrayDecodeFromTheCompanion() throws {
        let estimate = try JSONDecoder().decode(PrintEstimate.self, from: Data("""
        {"destinationId":"current","quality":"standard","strength":"standard","seconds":4320,"grams":22.4,"layers":212,
         "layerHeightMm":0.2,"infillPercent":15,"wallLoops":2,"slicedAt":"2026-11-01T12:00:00Z"}
        """.utf8))
        XCTAssertEqual(estimate.layers, 212)
        let trays = try JSONDecoder().decode([PrinterFilament].self, from: Data("""
        [{"slot":0,"colour":"#141414","material":"PLA","name":"Black","filamentId":"GFA00","destinationId":"current","suggested":true},
         {"slot":254,"colour":"#FFFFFF","material":"PETG","name":"White","filamentId":"GFG00","destinationId":"current"}]
        """.utf8))
        XCTAssertEqual(trays.map(\.suggested), [true, nil])
        XCTAssertTrue(trays[1].external)
        let status = try JSONDecoder().decode(ControlStatus.self, from: Data("""
        {"protocolVersion":1,"companionVersion":"0.2.0","transport":"lan","pairedDeviceCount":1,
         "capabilities":{"capture":true,"cleanup":true,"printerHandoff":true,"objectsCreate":true,"printSettings":true}}
        """.utf8))
        XCTAssertTrue(status.capabilities.printSettings)
        XCTAssertFalse(status.capabilities.printControl, "a flag the companion doesn't send is off")
    }
}
