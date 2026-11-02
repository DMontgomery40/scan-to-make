import XCTest
import Foundation
import struct CounterpartKit.Project
import struct CounterpartKit.PrintConfirmationResponse
@testable import ControlKit

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
    private func confirmation(_ overrides: [String: Any] = [:]) throws -> Project.PrintConfirmation {
        let fields: [String: Any] = ["id":"q1", "message":"Check the actual printer.\nKeep all checks.", "expiresAtMs":2000,
            "supported":true, "fields":[["name":"bed_clear", "title":"The bed is clear", "description":"Look at the entire plate.", "required":true],
                                        ["name":"optional_check", "title":"Optional check", "required":false]]]
        return try JSONDecoder().decode(Project.PrintConfirmation.self, from:JSONSerialization.data(withJSONObject:fields.merging(overrides) { $1 }))
    }

    func testConfirmationDecodesOriginalMessageAndDraftRequiresActualChecks() throws {
        let question = try confirmation()
        let decoded = try JSONDecoder().decode(Project.self, from:JSONSerialization.data(withJSONObject:ready.merging([
            "printConfirmation": ["id":"q1", "message":question.message, "expiresAtMs":2000, "fields":[], "supported":false]
        ]) { $1 }))
        XCTAssertEqual(decoded.printConfirmation?.message, "Check the actual printer.\nKeep all checks.")
        XCTAssertEqual(question.fields[0].description, "Look at the entire plate.")
        var draft = PrintConfirmationDraft(question)
        XCTAssertEqual(draft.values, ["bed_clear":.bool(false), "optional_check":.bool(false)], "every check starts unticked")
        XCTAssertNil(draft.answer(question, at:1000))
        draft.values["bed_clear"] = .bool(true)
        draft.values["not_in_schema"] = .bool(true)
        XCTAssertEqual(draft.answer(question, at:1000)?.content, ["bed_clear":.bool(true), "optional_check":.bool(false)])
        XCTAssertNil(draft.answer(question, at:2000), "Expired questions cannot be accepted")
        let next = try confirmation(["id":"q2"])
        XCTAssertNil(draft.answer(next, at:1000), "Answers cannot transfer to a replacement question")
        XCTAssertNil(PrintConfirmationDraft(next).answer(next, at:1000), "A new question starts unchecked")
        XCTAssertNil(draft.answer(try confirmation(["supported":false]), at:1000))
    }

    func testEveryElicitationFieldTypeIsShownAndChecked() throws {
        let question = try confirmation(["id":"q9", "fields":[
            ["name":"ok", "title":"The bed is clear", "required":true],
            ["name":"plate", "title":"Plate", "type":"string", "enum":["textured", "smooth"], "enumNames":["Textured PEI", "Smooth PEI"], "required":true],
            ["name":"note", "title":"Note", "type":"string", "maxLength":10],
            ["name":"temp", "title":"Bed temperature", "type":"integer", "minimum":40, "maximum":110, "default":60, "required":true],
            ["name":"flow", "title":"Flow", "type":"number", "minimum":0.5, "maximum":1.5],
            ["name":"mail", "title":"Email me", "type":"string", "format":"email"]]])
        XCTAssertTrue(question.isRenderable)
        XCTAssertEqual(question.fields[1].displayName(of:"smooth"), "Smooth PEI")
        var draft = PrintConfirmationDraft(question)
        XCTAssertEqual(draft.text["temp"], "60", "the printer's own default fills a number")
        XCTAssertNil(draft.answer(question, at:1000), "a required check and a required choice are still empty")
        draft.values["ok"] = .bool(true)
        draft.values["plate"] = .string("smooth")
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
                       ["ok":.bool(true), "plate":.string("smooth"), "temp":.number(65), "flow":.number(0.95), "mail":.string("me@example.com")],
                       "typed as asked; an empty optional field is left out")

        let unknown = try confirmation(["fields":[["name":"f", "title":"F", "type":"array", "required":false]]])
        XCTAssertFalse(unknown.isRenderable, "a type this Mac can't show is never guessed at")
        XCTAssertNil(PrintConfirmationDraft(unknown).answer(unknown, at:1000))
    }

    func testConfirmationTransportPreservesExactQuestionAndBooleanAnswers() async throws {
        for action in [PrintConfirmationResponse.Action.accept, .decline, .cancel] {
            let answer = PrintConfirmationAnswer(action:action, content:action == .accept ? ["bed_clear":.bool(true), "temp":.number(60), "plate":.string("smooth")] : nil)
            let server = try UnixFixture { request in
                XCTAssertEqual(request["method"] as? String, "objects.answerPrintConfirmation")
                let params = request["params"] as! [String: Any]
                XCTAssertEqual(Set(params.keys), ["id", "confirmationId", "answer"])
                XCTAssertEqual(params["id"] as? String, id)
                XCTAssertEqual(params["confirmationId"] as? String, "exact-pending-question")
                let sent = params["answer"] as! [String: Any]
                XCTAssertEqual(sent["action"] as? String, action.rawValue)
                XCTAssertEqual(sent["content"] as? [String: AnyHashable], action == .accept ? ["bed_clear":true, "temp":60.0, "plate":"smooth"] : nil)
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

    func testFilesResolveInsideTheObjectFolderOnly() throws {
        var object = ready
        object["current"] = ["model": "current/model.stl", "renders": ["current/renders/front.png", "../../elsewhere.png", "/etc/hosts", ""]]
        object["plate"] = ["item": "a printed part", "photo": true]
        let decoded = try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(decoded.modelURL?.path, folder + "/current/model.stl")
        XCTAssertEqual(decoded.renderURLs.map(\.path), [folder + "/current/renders/front.png"])
        XCTAssertEqual(decoded.platePhotoURL?.path, folder + "/plate.jpg")
        object["plate"] = ["item": "a printed part"]
        let noPhoto = try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(noPhoto.platePhotoURL, "the plate photo exists only while plate.photo is true")
    }

    func testEachActionSendsExactlyItsParams() async throws {
        typealias Call = (method: String, params: [String: AnyHashable], run: (ControlClient) async throws -> Project)
        let calls: [Call] = [
            ("objects.get", ["id": id], { try await $0.object(id) }),
            ("objects.start", ["id": id], { try await $0.startObject(id) }),
            ("objects.correct", ["id": id, "note": "the clip is 3 mm thicker"], { try await $0.correctObject(id, note: "the clip is 3 mm thicker") }),
            ("objects.answerCloseup", ["id": id, "bestGuess": true], { try await $0.answerCloseup(id, bestGuess: true) }),
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
        XCTAssertEqual(ControlClient.timeout(for: "objects.estimate"), 190, "the companion slices for up to 180 s")
        for action in [PrintControl.pause, .resume, .cancel] {
            XCTAssertEqual(ControlClient.timeout(for: action.method), 140, "\(action.method) runs for up to 130 s on the companion")
        }
        XCTAssertEqual(ControlClient.timeout(for: "objects.print"), 30)
    }
}
