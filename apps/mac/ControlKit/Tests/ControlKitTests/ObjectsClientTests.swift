import XCTest
import Foundation
import struct CounterpartKit.Project
import struct CounterpartKit.PrintConfirmationResponse
@testable import ControlKit
import struct CounterpartKit.CodeEngineStatus

private let id = "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11"
private let folder = "/Users/someone/Library/Application Support/Scan to Make/capture/objects/\(id)"
private let ready: [String: Any] = [
    "id": id, "createdAtMs": 1_800_000_000_000, "updatedAtMs": 1_800_000_000_500, "state": "ready",
    "scan": "scan.usdz", "photos": ["one.heic", "two.heic"],
    "passes": [["startedAtMs": 1, "endedAtMs": 2, "status": "done", "summary": "Added the clip.", "seconds": 140]],
    "current": ["model": "current/model.stl", "renders": ["current/renders/front.png", "current/renders/side.png"],
                "sizeMm": [61.6, 75.2, 49.4], "summary": "Added the clip."],
    "directory": folder,
    // A newer companion may add fields; they must not break the app.
    "printSettings": ["layer": 0.2],
]
private func objectReply(_ request: [String: Any], _ object: [String: Any] = ready) throws -> Data {
    try reply(request, result: ["object": object])
}
private func failure(_ request: [String: Any], _ code: String) throws -> Data {
    var data = try JSONSerialization.data(withJSONObject: ["v": 1, "id": request["id"]!, "error": ["code": code, "message": "fixture"]])
    data.append(10); return data
}

final class ObjectsClientTests: XCTestCase {
    func testBlenderRepairUsesCompanionStatusAndActions() async throws {
        let server = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "blender.update")
            return [try reply(request, result: ["blender": ["state": "updating", "message": "Updating…", "canUpdate": false]])]
        }
        let status = try await ControlClient(socketPath: server.path).blenderAddon(.update)
        XCTAssertTrue(status.isWorking)
        XCTAssertFalse(status.canUpdate)
        withExtendedLifetime(server) {}
    }

    func testTheCodeDesignEngineRowReadsAndSetsUpThroughTheCompanion() async throws {
        for (action, expected) in [(CodeEngineStatus.Action.status, "not-set-up"), (.setup, "setting-up")] {
            let server = try UnixFixture { request in
                XCTAssertEqual(request["method"] as? String, "cad." + action.rawValue)
                return [try reply(request, result: ["cad": action == .setup
                    ? ["state": "setting-up", "message": "Setting up… 0 s so far.", "seconds": 0, "canSetUp": false]
                    : ["state": "not-set-up", "message": "Not set up yet.", "server": "bambu-printer-mcp", "canSetUp": true]])]
            }
            let status = try await ControlClient(socketPath: server.path).codeEngine(action)
            XCTAssertEqual(status?.state, expected)
            XCTAssertEqual(status?.canSetUp, Optional(action == .status))
            withExtendedLifetime(server) {}
        }
    }

    func testInitialFileUploadDoesNotClaimMessageOwnership() async throws {
        let server = try UnixFixture { request in
            XCTAssertNil((request["params"] as? [String: Any])?["forMessage"])
            return [try objectReply(request)]
        }
        _ = try await ControlClient(socketPath: server.path).addFile(id, kind: "photos", path: "/tmp/retry.jpg")
        withExtendedLifetime(server) {}
    }

    func testPhotoUploadUsesItsReceiptInsteadOfOtherPendingProjectPhotos() async throws {
        let server = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "objects.addFile")
            XCTAssertEqual((request["params"] as? [String: Any])?["path"] as? String, "/tmp/answer.jpg")
            XCTAssertEqual((request["params"] as? [String: Any])?["forMessage"] as? Bool, true)
            return [try reply(request, result: ["object": ready.merging(["photos": ["queued.jpg", "answer-2.jpg", "later.jpg"]]) { $1 }, "photoName": "answer-2.jpg"])]
        }
        let name = try await ControlClient(socketPath: server.path).addPhotoFile(id, path: "/tmp/answer.jpg", forMessage: true)
        XCTAssertEqual(name, "answer-2.jpg")
        let old = try UnixFixture { request in [try objectReply(request)] }
        do { _ = try await ControlClient(socketPath: old.path).addPhotoFile(id, path: "/tmp/answer.jpg"); XCTFail("No guessing from the project's photos") }
        catch let error as ControlRemoteError { XCTAssertEqual(error.code, "not-supported") }
        withExtendedLifetime((server, old)) {}
    }

    func testDuplicateAndExplicitPrintDefaultsReachTheControlSocket() async throws {
        let duplicate = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "objects.duplicate")
            XCTAssertEqual((request["params"] as? [String: String])?["id"], id)
            return [try objectReply(request)]
        }
        _ = try await ControlClient(socketPath: duplicate.path).duplicateObject(id)
        let printer = try UnixFixture { request in
            let params = request["params"] as! [String: Any]
            XCTAssertEqual(params["quality"] as? String, "standard")
            XCTAssertEqual(params["strength"] as? String, "standard")
            return [try objectReply(request)]
        }
        _ = try await ControlClient(socketPath: printer.path).printObject(id, checked: false, settings: .init(), overrideDefaults: true)
        withExtendedLifetime((duplicate, printer)) {}
    }

    func testFilamentChoiceRoundTripsToThePrintRequest() async throws {
        let choice: [String: Any] = ["slot":1, "colour":"#FEC600", "material":"PLA", "name":"Yellow PLA", "filamentId":"GFA00", "destinationId":"p1s"]
        let inventory = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "objects.filaments")
            return [try reply(request, result:["filaments":[choice]])]
        }
        let filament = try await ControlClient(socketPath:inventory.path).filaments(id)[0]
        XCTAssertEqual(filament.colour, "#FEC600")
        let print = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "objects.print")
            let params = request["params"] as! [String: Any]
            XCTAssertEqual(params["checked"] as? Bool, true)
            XCTAssertEqual((params["filament"] as? [String: Any])?.mapValues { $0 as! AnyHashable }, choice.mapValues { $0 as! AnyHashable })
            return [try objectReply(request)]
        }
        _ = try await ControlClient(socketPath:print.path).printObject(id, checked:true, filament:filament)
        withExtendedLifetime((inventory, print)) {}
    }

    func testColourMappingDecodesAndChosenSpoolsReachThePrintRequestInOrder() async throws {
        let black: [String: Any] = ["slot":0, "colour":"#000000", "material":"PETG", "name":"Black PETG", "filamentId":"GFG00", "destinationId":"p1s"]
        let yellow: [String: Any] = ["slot":1, "colour":"#FEC600", "material":"PLA", "name":"Yellow PLA", "filamentId":"GFA00", "destinationId":"p1s"]
        let server = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "objects.colourMapping")
            return [try reply(request, result:[
                "filaments":[["index":1, "name":"body", "colour":"#111111", "slot":0, "distance":0.04],
                             ["index":2, "name":"letters", "colour":"#FFD200", "material":"PLA", "slot":1, "distance":0.02]],
                "trays":[black, yellow]])]
        }
        let mapping = try await ControlClient(socketPath:server.path).colourMapping(id)
        XCTAssertEqual(mapping.filaments.map(\.slot), [0, 1])
        XCTAssertEqual(mapping.filaments[1].material, "PLA")
        XCTAssertEqual(mapping.trays.map(\.slot), [0, 1])
        let print = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "objects.print")
            let params = request["params"] as! [String: Any]
            XCTAssertEqual(params["expectedPlate"] as? String, "0:2")
            let spools = params["filaments"] as! [[String: Any]]
            XCTAssertEqual(spools.map { $0["slot"] as! Int }, [1, 0], "the person's order, not the suggestion's")
            XCTAssertEqual(spools[0].mapValues { $0 as! AnyHashable }, yellow.mapValues { $0 as! AnyHashable })
            return [try objectReply(request)]
        }
        _ = try await ControlClient(socketPath:print.path).printObject(id, checked:false, settings:PrintSettings(), filaments:[mapping.trays[1], mapping.trays[0]], expectedPlate:"0:2")
        withExtendedLifetime((server, print)) {}
    }

    /// Regression (Nov 4 one-trunk audit): a multi-colour 3MF keeps one spool row per part on the Mac print sheet,
    /// each starting on its nearest loaded spool, and Print stays off until every part has one.
    func testMultiColourModelKeepsOneSpoolRowPerPartOnTheMacPrintSheet() throws {
        let tray = { (slot: Int, colour: String) in try JSONDecoder().decode(PrinterFilament.self, from: JSONSerialization.data(withJSONObject:
            ["slot":slot, "colour":colour, "material":"PLA", "name":"PLA \(colour)", "filamentId":"GFA00", "destinationId":"p1s"])) }
        let trays = [try tray(0, "#000000"), try tray(1, "#FEC600"), try tray(254, "#FFFFFF")]
        let mapping = ColourMapping(filaments: [ModelColourFilament(index: 1, name: "body", colour: "#111111", slot: 0, distance: 0.04),
                                                ModelColourFilament(index: 2, name: "letters", colour: "#FFD200", slot: 1, distance: 0.12)],
                                    trays: trays, modelVersion: "pick-3mf-v7")
        XCTAssertEqual(mapping.filaments.map(\.name), ["body", "letters"], "one row per part, in the model's order")
        XCTAssertEqual(mapping.suggestedSlots, [1: 0, 2: 1], "each part starts on its nearest loaded spool")
        XCTAssertEqual(mapping.spools(slots: mapping.suggestedSlots)?.map(\.slot), [0, 1])
        XCTAssertNil(mapping.spools(slots: [1: 0]), "a part without a spool keeps Print off")
        XCTAssertEqual(mapping.spools(slots: [1: 1, 2: 0])?.map(\.slot), [1, 0], "the person's swap, not the suggestion")
        XCTAssertNil(ColourMapping(filaments: [], trays: trays).spools(slots: [:]), "a one-colour model has no per-part rows")
    }

    /// PRD §8.0 item 7: the printer MCP proposes each colour's spool and names it; the sheet shows its words.
    func testTheSheetShowsTheMCPsSpoolNamesFeedsAndNotes() throws {
        let tray = { (slot: Int, label: String, name: String, feed: String) in try JSONDecoder().decode(PrinterFilament.self, from: JSONSerialization.data(withJSONObject:
            ["slot":slot, "colour":"#FFFFFF", "material":"PLA", "name":name, "filamentId":"GFA00", "destinationId":"p1s", "label":label, "feed":feed])) }
        let trays = [try tray(0, "A1", "Black PLA Basic", "ams"), try tray(1, "A2", "Sunflower Yellow PLA Basic", "ams"), try tray(254, "External", "Jade White PLA Basic", "external")]
        XCTAssertEqual(trays[1].title, "A2 · Sunflower Yellow PLA Basic", "the MCP's label and name, never \"A2 · PLA PLA Basic PLA #FEC600\"")
        let mapping = ColourMapping(filaments: [ModelColourFilament(index: 1, name: "body", colour: "#000000", slot: 0, verdict: "same-colour"),
                                                ModelColourFilament(index: 2, name: "markings", colour: "#FFFFFF", slot: 1, verdict: "closest",
                                                                    note: "White is loaded on External, but one print feeds from one source. Closest here: A2 Sunflower Yellow PLA Basic.")],
                                    trays: trays)
        XCTAssertEqual(mapping.note(mapping.filaments[1], slots: [1: 0, 2: 1]), mapping.filaments[1].note, "the MCP's note while its proposal stands")
        XCTAssertNil(mapping.note(mapping.filaments[1], slots: [1: 0, 2: 254]), "the person's own choice is no longer the MCP's proposal")
        XCTAssertTrue(mapping.mixesFeeds(slots: [1: 0, 2: 254]), "the MCP's feeds, not slot numbers")
        XCTAssertFalse(mapping.mixesFeeds(slots: [1: 0, 2: 1]))
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(trays[1])) as! [String: Any]
        XCTAssertEqual(Set(encoded.keys), ["slot", "colour", "material", "name", "filamentId", "destinationId"], "Print sends back only the identity the companion checks")
    }
    private func confirmation(_ overrides: [String: Any] = [:]) throws -> Project.PrintConfirmation {
        let fields: [String: Any] = ["id":"q1", "message":"Check the actual printer.\nKeep all checks.", "expiresAtMs":2000,
            "supported":true, "fields":[["name":"spool_loaded", "title":"The spool is loaded", "description":"Check the AMS slot.", "required":true],
                                        ["name":"optional_check", "title":"Optional check", "required":false]]]
        return try JSONDecoder().decode(Project.PrintConfirmation.self, from:JSONSerialization.data(withJSONObject:fields.merging(overrides) { $1 }))
    }

    func testConfirmationDecodesOriginalMessageAndDraftRequiresActualChecks() throws {
        let question = try confirmation()
        let decoded = try JSONDecoder().decode(Project.self, from:JSONSerialization.data(withJSONObject:ready.merging([
            "printConfirmation": ["id":"q1", "message":question.message, "expiresAtMs":2000, "fields":[], "supported":false]
        ]) { $1 }))
        XCTAssertEqual(decoded.printConfirmation?.message, "Check the actual printer.\nKeep all checks.")
        XCTAssertEqual(question.fields[0].description, "Check the AMS slot.")
        var draft = PrintConfirmationDraft(question)
        XCTAssertEqual(draft.values, ["spool_loaded":.bool(false), "optional_check":.bool(false)], "every check starts unticked")
        XCTAssertNil(draft.answer(question, at:1000))
        draft.values["spool_loaded"] = .bool(true)
        draft.values["not_in_schema"] = .bool(true)
        XCTAssertEqual(draft.answer(question, at:1000)?.content, ["spool_loaded":.bool(true), "optional_check":.bool(false)])
        XCTAssertNil(draft.answer(question, at:2000), "Expired questions cannot be accepted")
        let next = try confirmation(["id":"q2"])
        XCTAssertNil(draft.answer(next, at:1000), "Answers cannot transfer to a replacement question")
        XCTAssertNil(PrintConfirmationDraft(next).answer(next, at:1000), "A new question starts unchecked")
        XCTAssertNil(draft.answer(try confirmation(["supported":false]), at:1000))
    }

    func testEveryElicitationFieldTypeIsShownAndChecked() throws {
        let question = try confirmation(["id":"q9", "fields":[
            ["name":"ok", "title":"The spool is loaded", "required":true],
            ["name":"nozzle", "title":"Nozzle", "type":"string", "enum":["0.4", "0.6"], "enumNames":["0.4 mm", "0.6 mm"], "required":true],
            ["name":"note", "title":"Note", "type":"string", "maxLength":10],
            ["name":"temp", "title":"Bed temperature", "type":"integer", "minimum":40, "maximum":110, "default":60, "required":true],
            ["name":"flow", "title":"Flow", "type":"number", "minimum":0.5, "maximum":1.5],
            ["name":"mail", "title":"Email me", "type":"string", "format":"email"]]])
        XCTAssertTrue(question.isRenderable)
        XCTAssertEqual(question.fields[1].displayName(of:"0.6"), "0.6 mm")
        var draft = PrintConfirmationDraft(question)
        XCTAssertEqual(draft.text["temp"], "60", "the printer's own default fills a number")
        XCTAssertNil(draft.answer(question, at:1000), "a required check and a required choice are still empty")
        draft.values["ok"] = .bool(true)
        draft.values["nozzle"] = .string("0.6")
        draft.text["temp"] = "60.5"
        XCTAssertEqual(draft.problem(question.fields[3]), "A whole number.")
        draft.text["temp"] = "120"
        XCTAssertEqual(draft.problem(question.fields[3]), "At most 110.")
        XCTAssertNil(draft.answer(question, at:1000))
        draft.text["temp"] = "oops"
        XCTAssertNil(draft.answer(question, at:1000), "an unreadable entry never lets the default go in its place")
        draft.text["temp"] = ""
        XCTAssertNil(draft.answer(question, at:1000), "an emptied required field isn't answered by its default")
        draft.text["temp"] = "65"
        draft.text["flow"] = "abc"
        XCTAssertEqual(draft.problem(question.fields[4]), "A number.")
        draft.text["flow"] = "0.95"
        draft.text["note"] = "far too long a note"
        XCTAssertEqual(draft.problem(question.fields[2]), "At most 10 characters.")
        draft.text["note"] = ""
        draft.text["mail"] = "nobody"
        XCTAssertEqual(draft.problem(question.fields[5]), "An email address.")
        draft.text["mail"] = "me@example.com"
        XCTAssertEqual(draft.answer(question, at:1000)?.content,
                       ["ok":.bool(true), "nozzle":.string("0.6"), "temp":.number(65), "flow":.number(0.95), "mail":.string("me@example.com")],
                       "typed as asked; an empty optional field is left out")

        let unknown = try confirmation(["fields":[["name":"f", "title":"F", "type":"array", "required":false]]])
        XCTAssertFalse(unknown.isRenderable, "a type this Mac can't show is never guessed at")
        XCTAssertNil(PrintConfirmationDraft(unknown).answer(unknown, at:1000))
    }

    func testConfirmationTransportPreservesExactQuestionAndBooleanAnswers() async throws {
        for action in [PrintConfirmationResponse.Action.accept, .decline, .cancel] {
            let answer = PrintConfirmationAnswer(action:action, content:action == .accept ? ["spool_loaded":.bool(true), "temp":.number(60), "nozzle":.string("0.6")] : nil)
            let server = try UnixFixture { request in
                XCTAssertEqual(request["method"] as? String, "objects.answerPrintConfirmation")
                let params = request["params"] as! [String: Any]
                XCTAssertEqual(Set(params.keys), ["id", "confirmationId", "answer"])
                XCTAssertEqual(params["id"] as? String, id)
                XCTAssertEqual(params["confirmationId"] as? String, "exact-pending-question")
                let sent = params["answer"] as! [String: Any]
                XCTAssertEqual(sent["action"] as? String, action.rawValue)
                XCTAssertEqual(sent["content"] as? [String: AnyHashable], action == .accept ? ["spool_loaded":true, "temp":60.0, "nozzle":"0.6"] : nil)
                XCTAssertEqual(sent.count, action == .accept ? 2 : 1)
                return [try objectReply(request)]
            }
            _ = try await ControlClient(socketPath:server.path).answerPrintConfirmation(id, confirmationId:"exact-pending-question", answer:answer)
            withExtendedLifetime(server) {}
        }
    }

    func testPassActivityLoadsSeparatelyByObjectAndIndex() async throws {
        let server = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "objects.passActivity")
            let params = request["params"] as! [String: Any]
            XCTAssertEqual(params["id"] as? String, id)
            XCTAssertEqual(params["index"] as? Int, 7)
            XCTAssertEqual(params.count, 2)
            return [try reply(request, result: ["activity": [["atMs": 120, "kind": "message", "text": "Checking the reference."]]])]
        }
        let activity = try await ControlClient(socketPath: server.path).passActivity(id, index: 7)
        XCTAssertEqual(activity.count, 1)
        XCTAssertEqual(activity[0].atMs, 120)
        XCTAssertEqual(activity[0].kind, "message")
        XCTAssertEqual(activity[0].text, "Checking the reference.")
        withExtendedLifetime(server) {}
    }

    func testPassActivityCountsDecodeWithoutInlineMessagesAndRemainOptionalForOlderCompanions() throws {
        let legacy = try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: ready))
        XCTAssertNil(legacy.passes[0].activityCount)
        var object = ready
        object["passes"] = [["startedAtMs": 1, "status": "done", "activityCount": 200], ["startedAtMs": 2, "activityCount": 0]]
        let metadata = try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(metadata.passes[0].activityCount, 200)
        XCTAssertEqual(metadata.passes[1].activityCount, 0)
        XCTAssertNil(metadata.passes[0].activity)
    }

    func testListSendsNoParamsAndReadsEveryObject() async throws {
        let server = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "objects.list")
            XCTAssertEqual((request["params"] as? [String: Any])?.count, 0, "the server's params are a strict empty object")
            let fresh: [String: Any] = ["id": UUID().uuidString.lowercased(), "createdAtMs": 2, "updatedAtMs": 2, "state": "new",
                                        "instructions": "A hook", "photos": [], "passes": [], "directory": "/tmp/x"]
            let future: [String: Any] = ["id": UUID().uuidString.lowercased(), "createdAtMs": 1, "updatedAtMs": 1, "state": "archived",
                                         "photos": [], "passes": [], "directory": "/tmp/y"]
            let broken: [String: Any] = ["id": UUID().uuidString.lowercased(), "state": "ready", "current": ["model": 7]]
            return [try reply(request, result: ["objects": [fresh, broken, ready, future]])]
        }
        let objects = try await ControlClient(socketPath: server.path).objects()
        XCTAssertEqual(objects.count, 3, "an object this app can't read, or one in a state it doesn't know, never hides the others")
        XCTAssertEqual(objects[0].state, .new)
        XCTAssertEqual(objects[0].instructions, "A hook")
        XCTAssertEqual(objects[1].state, .ready)
        XCTAssertEqual(objects[1].current?.sizeMm, [61.6, 75.2, 49.4])
        XCTAssertEqual(objects[1].passes.first?.summary, "Added the clip.")
        XCTAssertEqual(objects[1].directory, folder)
        XCTAssertEqual(objects[2].state, .unknown)
        withExtendedLifetime(server) {}
    }

    func testBlenderOpensTheMergedMeshOfAMultiColour3MF() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("controlkit-blender-\(UUID().uuidString)", isDirectory: true)
        let current = root.appendingPathComponent("current", isDirectory: true)
        try FileManager.default.createDirectory(at: current, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("3mf".utf8).write(to: current.appendingPathComponent("model.3mf"))
        func project(model: String) throws -> Project {
            var object = ready
            object["directory"] = root.path
            object["current"] = ["model": model, "renders": []]
            return try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: object))
        }
        let designed = try project(model: "current/model.3mf")
        XCTAssertEqual(designed.modelURL?.path, current.appendingPathComponent("model.3mf").path, "printing keeps the 3MF")
        XCTAssertNil(designed.blenderModelURL, "no merged mesh saved yet: nothing honest to send Blender")
        try Data("stl".utf8).write(to: current.appendingPathComponent("model.stl"))
        XCTAssertEqual(designed.blenderModelURL?.path, current.appendingPathComponent("model.stl").path, "Blender gets the merged STL beside the 3MF")
        let plain = try project(model: "current/model.stl")
        XCTAssertEqual(plain.blenderModelURL?.path, current.appendingPathComponent("model.stl").path, "an STL model opens itself")
    }

    func testTheThumbnailIsTheRealObjectBeforeAnyRender() throws {
        var object = ready
        object["photos"] = ["bottle.jpg"]
        object["capture"] = ["0001.heic"]
        object["current"] = ["model": "current/model.stl", "renders": ["current/renders/overview.png"]]
        var decoded = try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(decoded.thumbnailURL?.path, folder + "/photos/bottle.jpg")
        decoded.photos = []
        XCTAssertEqual(decoded.thumbnailURL?.path, folder + "/capture/0001.heic")
        decoded.capture = nil
        XCTAssertEqual(decoded.thumbnailURL?.path, folder + "/current/renders/overview.png")
    }

    func testFilesResolveInsideTheObjectFolderOnly() throws {
        var object = ready
        object["current"] = ["model": "current/model.stl", "renders": ["current/renders/front.png", "../../elsewhere.png", "/etc/hosts", ""]]
        let decoded = try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(decoded.modelURL?.path, folder + "/current/model.stl")
        XCTAssertEqual(decoded.renderURLs.map(\.path), [folder + "/current/renders/front.png"])
    }

    func testEachActionSendsExactlyItsParams() async throws {
        typealias Call = (method: String, params: [String: AnyHashable], run: (ControlClient) async throws -> Project)
        let calls: [Call] = [
            ("objects.get", ["id": id], { try await $0.object(id) }),
            ("objects.start", ["id": id], { try await $0.startObject(id) }),
            ("objects.correct", ["id": id, "note": "the clip is 3 mm thicker"], { try await $0.correctObject(id, note: "the clip is 3 mm thicker") }),
            ("objects.answerCloseup", ["id": id, "bestGuess": true, "photoNames": [String]()], { try await $0.answerCloseup(id, bestGuess: true) }),
            ("objects.print", ["id": id], { try await $0.printObject(id) }),
            ("objects.print", ["id": id, "checked": true], { try await $0.printObject(id, checked: true) }),
        ]
        for call in calls {
            let server = try UnixFixture { request in
                XCTAssertEqual(request["method"] as? String, call.method)
                let params = request["params"] as! [String: Any]
                XCTAssertEqual(params.mapValues { $0 as! AnyHashable }, call.params, call.method)
                return [try objectReply(request)]
            }
            let object = try await call.run(ControlClient(socketPath: server.path))
            XCTAssertEqual(object.id, id, call.method)
            XCTAssertEqual(object.current?.renders.count, 2)
            withExtendedLifetime(server) {}
        }
    }

    func testDeleteSendsOnlyTheIdAndNeedsTheCompanionToSayDeleted() async throws {
        let server = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "objects.delete")
            XCTAssertEqual((request["params"] as! [String: Any]).mapValues { $0 as! AnyHashable }, ["id": id])
            return [try reply(request, result: ["deleted": true])]
        }
        try await ControlClient(socketPath: server.path).deleteObject(id)
        withExtendedLifetime(server) {}

        let refused = try UnixFixture { request in [try failure(request, "not-found")] }
        do { try await ControlClient(socketPath: refused.path).deleteObject(id); XCTFail("No refusal") }
        catch { XCTAssertEqual((error as? ControlRemoteError)?.code, "not-found") }
        withExtendedLifetime(refused) {}
    }

    func testRefusalsKeepTheirCodes() async throws {
        for code in ["unavailable", "conflict", "not-found"] {
            let server = try UnixFixture { request in [try failure(request, code)] }
            do { _ = try await ControlClient(socketPath: server.path).printObject(id); XCTFail("No refusal for \(code)") }
            catch { XCTAssertEqual((error as? ControlRemoteError)?.code, code) }
            withExtendedLifetime(server) {}
        }
    }

    func testRepliesAreAwaitedAsLongAsTheCompanionMayTake() {
        XCTAssertEqual(ControlClient.timeout(for: "objects.estimate"), 640, "the companion slices for up to 630 s")
        XCTAssertEqual(ControlClient.timeout(for: "objects.addFile"), 130, "the companion keeps a model file for up to 120 s")
        for action in [PrintControl.pause, .resume, .cancel] {
            XCTAssertEqual(ControlClient.timeout(for: action.method), 740, "\(action.method) waits up to 730 s on the companion (the printer's question)")
        }
        XCTAssertEqual(ControlClient.timeout(for: "objects.print"), 30)
    }

    /// Both MCPs word each connection since Nov 3 (lan, cloud, developer); an older MCP sends only choices.
    func testPrintRouteDecodesTheMCPsOwnOptionsAndOlderReplies() throws {
        let current: [String: Any] = ["route": "developer", "mode": "lan_mqtt_ftps", "type": "lan", "choices": ["lan", "cloud", "developer"], "savedTo": NSNull(),
            "options": [["id": "lan", "label": "Local network", "available": true, "controls": "Refused on firmware with authorization control."],
                        ["id": "cloud", "label": "Bambu Cloud", "available": false, "reason": "Needs FULU's BambuNetwork bridge."],
                        ["id": "developer", "label": "Local network, Developer Mode", "available": true, "controls": "Pause, Resume and Stop go straight to the printer."]]]
        let route = try JSONDecoder().decode(PrintRoute.self, from: JSONSerialization.data(withJSONObject: current))
        XCTAssertEqual(route.route, "developer")
        XCTAssertEqual(route.options?.map(\.label), ["Local network", "Bambu Cloud", "Local network, Developer Mode"])
        XCTAssertEqual(route.options?[1].reason, "Needs FULU's BambuNetwork bridge.")
        XCTAssertEqual(route.options?[2].controls, "Pause, Resume and Stop go straight to the printer.")
        let older = try JSONDecoder().decode(PrintRoute.self, from: JSONSerialization.data(withJSONObject:
            ["route": "lan", "mode": "bambu_network", "type": "lan", "choices": ["lan", "cloud"], "savedTo": "/Users/x/.env"]))
        XCTAssertNil(older.options)
        XCTAssertEqual(older.choices, ["lan", "cloud"])
    }
}
