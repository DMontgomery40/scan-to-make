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
    /// A print's words are the companion's, as they are: getting ready shows no percent (the printer's raw progress
    /// is 3% before it prints anything), and a stopped print says only what the printer said.
    func testAPrintsWordsAreTheCompanionsAsTheyAre() {
        let live: [String: Any] = ["print": ["bundleId": "b", "live": ["source": "counterpart", "state": "printing", "job": ["progress": 3]]]]
        let preparing = ready(["state": "printing"].merging(live) { $1 }.merging(status("preparing", "Getting ready · Heating")) { $1 })
        XCTAssertEqual(preparing.words.status, "Getting ready · Heating")
        XCTAssertNil(preparing.words.progress, "no bar while it is getting ready")
        XCTAssertFalse(preparing.words.status.contains("3%"))
        let printing = ready(["state": "printing"].merging(live) { $1 }.merging(status("printing", "Printing on P1S · 42% · 38 min left")) { $1 })
        XCTAssertEqual(printing.words.status, "Printing on P1S · 42% · 38 min left")
        let stopped = ready(["state": "failed", "failure": "The printer stopped: Print aborted (0300-4000)."]
            .merging(live) { $1 }.merging(status("failed", "The printer stopped: Print aborted (0300-4000).")) { $1 })
        XCTAssertEqual(stopped.words.status, "The printer stopped: Print aborted (0300-4000).")
        XCTAssertTrue(stopped.words.actions.contains(.print), "Print Again")
        XCTAssertTrue(printing.words.printRunning)
        var dispatched = live
        dispatched["print"] = ["bundleId": "b", "printId": "p1", "dispatchedAt": "2026-11-02T07:00:00Z", "monitor": ["phase": "starting"]]
        let gettingReady = ready(["state": "printing"].merging(dispatched) { $1 }.merging(status("preparing", "Getting ready · Heating")) { $1 })
        XCTAssertTrue(gettingReady.words.printRunning, "dispatched and getting ready: Pause and Stop as while printing")
        XCTAssertFalse(preparing.words.printRunning, "not dispatched yet: nothing to pause")
        var slicing = live
        slicing["print"] = ["bundleId": "b", "printId": "p1"]
        let tapped = ready(["state": "printing"].merging(slicing) { $1 }.merging(status("preparing", "Preparing print…")) { $1 })
        XCTAssertFalse(tapped.words.printRunning, "a printId is set at the tap, while it still slices and sends")
        XCTAssertFalse(stopped.words.printRunning)
    }

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
        let new = object(["scan": "scan.usdz"].merging(status("sending", "Sending to your Mac")) { $1 }).words
        XCTAssertEqual(new.stage, .sending, "once its files arrive, a new project is as the companion says")
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

    /// A phone's draft (9038b931: new, no files, unchanged for hours) is not "Sending to your Mac" under Now. The
    /// companion keeps no upload session, so the rule is what reached this Mac and whether files are arriving now.
    func testANewProjectWithNothingSentOrArrivingIsADraftOutsideNow() {
        let sending = status("sending", "Sending to your Mac")
        let draft = object(sending).words
        XCTAssertTrue(ObjectWords.isDraft(object(sending)))
        XCTAssertEqual(draft.stage, .draft)
        XCTAssertEqual(draft.group, .drafts)
        XCTAssertEqual(draft.status, "Draft from your iPhone · nothing sent yet")
        XCTAssertFalse(draft.busy, "no spinner and no keeping the Mac awake for a draft")
        XCTAssertFalse(draft.stage.isRunning)
        XCTAssertEqual(draft.actions, [])
        // Its age changes nothing: only files arriving or arrived make it a send.
        XCTAssertEqual(object(sending.merging(["createdAtMs": 1, "updatedAtMs": Date().timeIntervalSince1970 * 1000]) { $1 }).words.stage, .draft)
        // The first file is arriving: the companion says so on the control socket, and it is a send under Now.
        let arriving = object(sending.merging(["progress": "Receiving files from your iPhone"]) { $1 }).words
        XCTAssertEqual(arriving.stage, .sending)
        XCTAssertEqual(arriving.group, .now)
        XCTAssertEqual(arriving.status, "Sending to your Mac")
        // Any file that reached the Mac makes it a send: a scan, photos, an in-hand capture or its depth.
        for files in [["scan": "scan.usdz"], ["photos": ["a.jpg"]], ["capture": ["0001.jpg"]], ["captureDepth": ["0001.depth.plist"]]] as [[String: Any]] {
            let sent = object(sending.merging(files) { $1 })
            XCTAssertFalse(ObjectWords.isDraft(sent), "\(files)")
            XCTAssertEqual(sent.words.group, .now, "\(files)")
        }
        // Only a new project can be a draft.
        XCTAssertFalse(ObjectWords.isDraft(ready()))
        XCTAssertEqual(ProjectGroup.drafts.title, "Drafts")
        XCTAssertTrue(ProjectGroup.drafts < .archived && ProjectGroup.printed < .drafts, "Drafts sit after Printed, before Archived")
    }

    func testEveryStageHasOneSidebarSection() {
        let states = ["new", "touching-up", "needs-closeup", "ready", "printing", "printed", "sent", "failed", "archived"]
        for state in states { XCTAssertTrue(ProjectGroup.allCases.contains(ready(["state": state]).words.group), state) }
        XCTAssertEqual(object(["state": "archived"]).words.group, .now)
        XCTAssertEqual(object(["state": "failed"]).words.group, .needsYou)
        XCTAssertEqual(ObjectWords.group(.draft), .drafts)
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
        XCTAssertNil(PrintSettings().params["copies"], "untouched Copies: the printer profile's own count")
        XCTAssertEqual(PrintSettings(copies: 1).params["copies"], .number(1), "one picked overrides a profile set to three")
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
        XCTAssertEqual(PrintSettings.lastSlot(.material("petg"), lastPrinter: "x1c", printer: "a1", in: spools), 3,
                       "the material it was sliced for, on any printer, never the PLA suggestion")
        XCTAssertNil(PrintSettings.lastSlot(.material("ASA"), lastPrinter: "x1c", printer: "x1c", in: spools), "nothing loaded matches")
        let petg = try JSONDecoder().decode(Project.Print.self, from: Data(#"{"bundleId":"b","settings":{"colour":{"material":"PETG"}}}"#.utf8))
        XCTAssertEqual(PrintSettings(last: petg).colour, .material("PETG"))
    }

    /// Copies are per printer (KAN-214 PR 8b): an MCP without `slice_stl` repetitions doesn't say `copies`.
    func testCopiesAreAPrintersOwnCapability() throws {
        let with = try JSONDecoder().decode(PrinterCapabilities.self, from: Data(#"{"progress":true,"camera":"none","filaments":"ams","pause":true,"resume":true,"cancel":true,"quality":true,"strength":true,"copies":true}"#.utf8))
        XCTAssertEqual(with.copies, true)
        let without = try JSONDecoder().decode(PrinterCapabilities.self, from: Data(#"{"progress":true,"camera":"none","filaments":"none","pause":false,"resume":false,"cancel":false,"quality":false,"strength":false}"#.utf8))
        XCTAssertNil(without.copies)
    }

    func testTheEstimateAndSuggestedTrayDecodeFromTheCompanion() throws {
        let estimate = try JSONDecoder().decode(PrintEstimate.self, from: Data("""
        {"destinationId":"current","quality":"standard","strength":"standard","seconds":4320,"grams":22.4,"layers":212,
         "layerHeightMm":0.2,"infillPercent":15,"wallLoops":2,"slicedAt":"2026-11-01T12:00:00Z"}
        """.utf8))
        XCTAssertEqual(estimate.layers, 212)
        XCTAssertNil(estimate.slicerWarning)
        // KAN-224: Bambu Studio's warning comes through word for word; Print stays on.
        let words = "It seems object clean_flat.stl has floating cantilever. Please re-orient the object or enable support generation."
        let warned = try JSONDecoder().decode(PrintEstimate.self, from: Data(#"{"destinationId":"current","quality":"standard","strength":"standard","seconds":2575,"slicerWarning":"\#(words)","slicedAt":"2026-11-02T10:00:00Z"}"#.utf8))
        XCTAssertEqual(warned.slicerWarning, words)
        // Studio's refusal holds Print with its own words; any other failure leaves Print on.
        let refusal = "Found 3 empty layers.\nPlease re-orient the object or enable support generation."
        XCTAssertEqual(EstimateOutcome(error: ControlRemoteError(code: "slicer-error", message: refusal)), .refused(refusal))
        XCTAssertTrue(EstimateOutcome(error: ControlRemoteError(code: "slicer-error", message: refusal)).holdsPrint)
        let unavailable = EstimateOutcome(error: ControlRemoteError(code: "conflict", message: "Estimates are unavailable for this printer."))
        XCTAssertEqual(unavailable, .unavailable("Estimates are unavailable for this printer."))
        XCTAssertFalse(unavailable.holdsPrint, "an estimate that's merely unavailable never blocks printing")
        XCTAssertFalse(EstimateOutcome(error: ControlClientError.timedOut).holdsPrint)
        XCTAssertFalse(EstimateOutcome(error: ControlRemoteError(code: "slicer-error", message: " ")).holdsPrint, "no words, no hold")
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
