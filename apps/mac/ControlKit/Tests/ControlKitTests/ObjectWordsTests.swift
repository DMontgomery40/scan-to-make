import XCTest
import Foundation
import struct CounterpartKit.ProjectWords
import enum CounterpartKit.Format
import struct CounterpartKit.Project
@testable import ControlKit

/// PRD §4's state table, as the Mac says it: CounterpartKit's shared words, plus the Mac's sections and actions.
private func object(_ fields: [String: Any]) -> Project {
    var json: [String: Any] = ["id": "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11", "createdAtMs": 1, "updatedAtMs": 1,
                               "state": "new", "photos": [], "passes": [], "directory": "/tmp/object"]
    json.merge(fields) { $1 }
    return try! JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: json))
}
private let readyFields: [String: Any] = [
    "scan": "scan.usdz", "state": "ready",
    "passes": [["startedAtMs": 1, "endedAtMs": 2, "status": "done"]],
    "current": ["model": "current/model.stl", "renders": ["current/renders/front.png"], "sizeMm": [48.2, 50.4, 53.6],
                "summary": "Added the two eyes."],
]
private func ready(_ fields: [String: Any] = [:]) -> Project { object(readyFields.merging(fields) { $1 }) }
private func status(_ phase: String, _ text: String) -> [String: Any] { ["status": ["phase": phase, "text": text, "symbol": "", "tint": "secondary"]] }

final class ObjectWordsTests: XCTestCase {
    func testTheWordsAreTheSharedOnes() {
        // The same object read as CounterpartKit's model gives the phone's words, so the Mac says the same thing.
        let o = ready(["title": "Mic mount"])
        let shared = ProjectWords(o, printerName: nil)
        XCTAssertEqual(o.words.title, shared.title)
        XCTAssertEqual(o.words.status, shared.line)
        XCTAssertEqual(o.words.stage, shared.phase)
        XCTAssertEqual(o.directory, "/tmp/object", "the Mac's folder, from the control socket")
    }

    func testNamesAProjectByItsGeneratedTitleThenItsRequest() {
        XCTAssertEqual(object(["title": "Mic mount", "instructions": "Something that holds this mic."]).words.title, "Mic mount")
        XCTAssertEqual(object(["title": "  ", "instructions": "A hook for a 25 mm tube. It should hold a cup."]).words.title,
                       "A hook for a 25 mm tube")
        XCTAssertEqual(object(["scan": "scan.usdz"]).words.title, "Copy of your scan")
    }

    func testTheCompanionsOwnStatusLineWins() {
        let served = ready(["state": "printing"].merging(status("printing", "Printing on Bambu Lab P1S · 42% · 1 h 5 min left")) { $1 }).words
        XCTAssertEqual(served.status, "Printing on Bambu Lab P1S · 42% · 1 h 5 min left")
        XCTAssertEqual(served.stage, .printing)
        XCTAssertEqual(served.group, .now)
        let new = object(status("sending", "Sending to your Mac")).words
        XCTAssertEqual(new.stage, .sending, "this Mac never sends files itself, so a new project is as the companion says")
        XCTAssertEqual(new.status, "Sending to your Mac")
        let future = ready(status("archived", "Archived")).words
        XCTAssertEqual(future.stage, .ready, "an unknown phase keeps the shared reading of the state")
        let sent = ready(["state": "sent", "print": ["bundleId": "b", "destination": ["id": "p", "name": "P1S"]]]
            .merging(status("sent", "Sent to P1S · Counterpart can't follow this print")) { $1 }).words
        XCTAssertEqual(sent.stage, .sent)
        XCTAssertEqual(sent.group, .printed)
        XCTAssertFalse(sent.busy, "terminal: nothing to wait for")
        XCTAssertEqual(sent.subtitle(request: nil), ProjectStage.sent.label)
    }

    func testEveryStageHasOneSidebarSection() {
        let states = ["new", "touching-up", "needs-closeup", "ready", "printing", "printed", "sent", "failed", "archived"]
        for state in states { XCTAssertTrue(ProjectGroup.allCases.contains(ready(["state": state]).words.group), state) }
        XCTAssertEqual(object(["state": "archived"]).words.group, .now)
        XCTAssertEqual(object(["state": "failed"]).words.group, .needsYou)
        XCTAssertEqual(ObjectWords.group(.draft), .now)
        XCTAssertTrue(Set(ProjectStage.allCases.map(ObjectWords.group)).isSubset(of: Set(ProjectGroup.allCases)))
        let done = ready(["state": "confirmed", "status": ["phase": "confirmed", "text": "It works", "symbol": "checkmark.circle.fill", "tint": "green"]]).words
        XCTAssertTrue(done.done)
        XCTAssertEqual(done.group, .done, "the person said it works: Done, with the ✓")
        XCTAssertEqual(done.capsule, "Done")
        XCTAssertEqual(done.status, "It works")
        XCTAssertTrue(done.actions.contains(.print), "a Done project can be printed again")
        XCTAssertFalse(ready(["state": "printed"]).words.done)
        XCTAssertEqual(ProjectStage.needsYou.rawValue, "needs-you", "the companion's phase, the phone's and CloudKit's")
    }

    func testPrintingShowsTheLiveProgress() {
        let live = ready(["state": "printing", "print": ["bundleId": "b", "printId": "p1", "destination": ["id": "p", "name": "P1S"],
                          "monitor": ["phase": "watching"],
                          "live": ["source": "counterpart", "observedAt": "2026-11-01T10:00:00Z", "state": "printing",
                                   "job": ["name": "mic", "progress": 61.4, "remainingSec": 1500], "problems": []]]]).words
        XCTAssertEqual(live.stage, .printing)
        XCTAssertEqual(live.progress ?? 0, 0.614, accuracy: 0.001)
        XCTAssertTrue(live.status.hasPrefix("Printing on P1S"), live.status)
        XCTAssertTrue(live.busy)
        let preparing = ready(["state": "printing"]).words
        XCTAssertEqual(preparing.stage, .preparing, "printing only once the printer reports our job")
        XCTAssertNil(preparing.progress)
    }

    func testNeedsYouAsksOneSpecificQuestion() {
        let closeup = ready(["state": "needs-closeup", "question": ["closeup": "the underside"]]).words
        XCTAssertEqual(closeup.stage, .needsYou)
        XCTAssertEqual(closeup.group, .needsYou)
        XCTAssertEqual(closeup.question, "Can you send me a close-up of the underside? I can't see what's happening there.")
        XCTAssertEqual(closeup.actions, [.bestGuess], "the camera and photo answers are the phone's")
        let ask = ready(["state": "needs-closeup", "question": ["closeup": "old"],
                         "ask": ["id": "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a12", "question": "How thick is the pole?",
                                 "answers": ["camera", "best-guess", "text"], "status": "open", "askedAtMs": 1]]).words
        XCTAssertEqual(ask.question, "How thick is the pole?")
        let confirm = ready(["state": "printing", "print": ["bundleId": "b", "destination": ["id": "p", "name": "P1S"]],
                             "printConfirmation": ["id": "q", "message": "Check.", "expiresAtMs": 2000, "fields": [], "supported": true]]).words
        XCTAssertEqual(confirm.question, "P1S needs a yes before printing")
        XCTAssertEqual(confirm.stage, .needsYou, "the printer asking for a yes needs the person, also without the companion's phase")
        XCTAssertEqual(confirm.group, .needsYou)
        XCTAssertEqual(confirm.actions, [], "the confirmation itself is answered")
        XCTAssertTrue(confirm.busy)
    }

    func testAReadyProjectPrintsOrTakesChanges() {
        XCTAssertEqual(ready().words.actions, [.print, .correct])
        XCTAssertEqual(ready().words.size, "48 × 50 × 54 mm")
        XCTAssertEqual(ObjectWords.formatMinutes(72), Format.duration(72 * 60))
        XCTAssertEqual(ready(["title": "Mic mount"]).words.subtitle(request: "Something that holds the mic. Both are in the photos."),
                       "Ready to print · something that holds the mic")
    }

    func testAFailureOffersTheWayBack() {
        XCTAssertEqual(object(["scan": "scan.usdz", "state": "failed", "failure": "Blender is not open on your Mac."]).words.actions, [.retry, .correct])
        XCTAssertEqual(ready(["state": "failed", "failure": "The printer is busy."]).words.actions, [.print, .correct])
        XCTAssertEqual(ready(["state": "failed", "failure": "The printer is busy."]).words.group, .needsYou)
    }

    func testAPrintThatMayHaveStartedIsSentAgainOnlyAfterTheUserChecks() {
        let uncertain = ready(["state": "failed", "failure": "The printer may have started this print.",
                               "print": ["bundleId": "b1", "uncertain": true]]).words
        XCTAssertEqual(uncertain.actions, [.printChecked, .correct])
        XCTAssertEqual(ready(["print": ["bundleId": "b1"]]).words.actions, [.print, .correct])
    }

    func testBusyStatesKeepThePageUpToDate() {
        XCTAssertTrue(object(["state": "touching-up"]).words.busy)
        XCTAssertTrue(ready(["state": "printing"]).words.busy)
        XCTAssertFalse(ready().words.busy)
        XCTAssertFalse(ready(["state": "needs-closeup"]).words.busy)
    }

    func testDecodesTheFieldsTheCompanionIsAddingWithoutRequiringThem() {
        let o = ready(["current": ["model": "m.stl", "renders": [],
                                   "changes": [["tag": "added", "text": "Cup"], ["tag": "estimated", "text": "Pole", "toleranceMm": 0.5]]],
                       "print": ["bundleId": "b", "printId": "p1", "events": [["atMs": 1, "message": "Started"]]]])
        XCTAssertEqual(o.current?.changes?.map(\.tag), ["added", "estimated"])
        XCTAssertEqual(o.print?.events?.first?.message, "Started")
        XCTAssertEqual(ready(["scan": "scan.usdz"]).scanURL?.path, "/tmp/object/scan/scan.usdz")
        XCTAssertNil(ready(["directory": "relative"]).modelURL, "only an absolute folder on this Mac")
        XCTAssertNil(ready(["current": ["model": "../outside.stl", "renders": []]]).modelURL, "never a file outside the folder")
    }

    func testCopyNeverNamesTheMachinery() {
        let all = [object([:]), object(["state": "touching-up"]), ready(), ready(["state": "printing"]),
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
        XCTAssertEqual(PrintSettings(colour: .auto).params["colour"], .object(["auto": .bool(true)]), "the user kept the preselection")
        XCTAssertEqual(PrintSettings(colour: .external).params["colour"], .object(["external": .bool(true)]))
    }

    /// Print Another (PRD §5.4) opens with what the last print was sent with.
    func testPrintAnotherStartsFromTheLastPrintsSettings() throws {
        let last = try JSONDecoder().decode(Project.Print.self, from: Data("""
        {"bundleId":"b","destinationId":"x1c","settings":{"quality":"fine","strength":"max","colour":{"amsSlot":3}}}
        """.utf8))
        let settings = PrintSettings(last: last)
        XCTAssertEqual(settings.quality, .fine)
        XCTAssertEqual(settings.strength, .max)
        XCTAssertEqual(settings.colour, .amsSlot(3))
        XCTAssertEqual(PrintSettings(last: nil), PrintSettings(), "a first print starts at Standard")
        let spools = [PrinterFilament(slot: 1, colour: "#fff", material: "PLA", name: "White", filamentId: "a", destinationId: "x1c", suggested: true),
                      PrinterFilament(slot: 3, colour: "#000", material: "PETG", name: "Black", filamentId: "b", destinationId: "x1c"),
                      PrinterFilament(slot: 254, colour: "#f00", material: "TPU", name: "Red", filamentId: "c", destinationId: "x1c")]
        XCTAssertEqual(PrintSettings.lastSlot(.amsSlot(3), lastPrinter: "x1c", printer: "x1c", in: spools), 3)
        XCTAssertEqual(PrintSettings.lastSlot(.external, lastPrinter: "x1c", printer: "x1c", in: spools), 254)
        XCTAssertNil(PrintSettings.lastSlot(.amsSlot(3), lastPrinter: "x1c", printer: "a1", in: spools), "slots belong to their printer")
        XCTAssertNil(PrintSettings.lastSlot(.amsSlot(4), lastPrinter: "x1c", printer: "x1c", in: spools), "that spool is gone")
        XCTAssertNil(PrintSettings.lastSlot(.auto, lastPrinter: "x1c", printer: "x1c", in: spools), "the suggestion again")
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
