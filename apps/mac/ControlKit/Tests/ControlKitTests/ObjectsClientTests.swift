import XCTest
import Foundation
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
    private func confirmation(_ overrides: [String: Any] = [:]) throws -> StmObject.PrintConfirmation {
        let fields: [String: Any] = ["id":"q1", "message":"Check the actual printer.\nKeep all checks.", "expiresAtMs":2000,
            "supported":true, "fields":[["name":"bed_clear", "title":"The bed is clear", "description":"Look at the entire plate.", "required":true],
                                        ["name":"optional_check", "title":"Optional check", "required":false]]]
        return try JSONDecoder().decode(StmObject.PrintConfirmation.self, from:JSONSerialization.data(withJSONObject:fields.merging(overrides) { $1 }))
    }

    func testConfirmationDecodesOriginalMessageAndDraftRequiresActualChecks() throws {
        let question = try confirmation()
        let decoded = try JSONDecoder().decode(StmObject.self, from:JSONSerialization.data(withJSONObject:ready.merging([
            "printConfirmation": ["id":"q1", "message":question.message, "expiresAtMs":2000, "fields":[], "supported":false]
        ]) { $1 }))
        XCTAssertEqual(decoded.printConfirmation?.message, "Check the actual printer.\nKeep all checks.")
        XCTAssertEqual(question.fields[0].description, "Look at the entire plate.")
        var draft = PrintConfirmationDraft(question)
        XCTAssertTrue(draft.values.isEmpty)
        XCTAssertNil(draft.answer(for:question, at:1000))
        draft.values = ["bed_clear":true, "not_in_schema":true]
        XCTAssertEqual(draft.answer(for:question, at:1000)?.content, ["bed_clear":true, "optional_check":false])
        XCTAssertNil(draft.answer(for:question, at:2000), "Expired questions cannot be accepted")
        let next = try confirmation(["id":"q2"])
        XCTAssertNil(draft.answer(for:next, at:1000), "Answers cannot transfer to a replacement question")
        XCTAssertNil(PrintConfirmationDraft(next).answer(for:next, at:1000), "A new question starts unchecked")
        XCTAssertNil(draft.answer(for:try confirmation(["supported":false]), at:1000))
    }

    func testConfirmationTransportPreservesExactQuestionAndBooleanAnswers() async throws {
        for action in [PrintConfirmationAnswer.Action.accept, .decline, .cancel] {
            let answer = PrintConfirmationAnswer(action:action, content:action == .accept ? ["bed_clear":true, "optional_check":false] : nil)
            let server = try UnixFixture { request in
                XCTAssertEqual(request["method"] as? String, "objects.answerPrintConfirmation")
                let params = request["params"] as! [String: Any]
                XCTAssertEqual(Set(params.keys), ["id", "confirmationId", "answer"])
                XCTAssertEqual(params["id"] as? String, id)
                XCTAssertEqual(params["confirmationId"] as? String, "exact-pending-question")
                let sent = params["answer"] as! [String: Any]
                XCTAssertEqual(sent["action"] as? String, action.rawValue)
                XCTAssertEqual(sent["content"] as? [String: Bool], answer.content)
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
        let legacy = try JSONDecoder().decode(StmObject.self, from: JSONSerialization.data(withJSONObject: ready))
        XCTAssertNil(legacy.passes[0].activityCount)
        var object = ready
        object["passes"] = [["startedAtMs": 1, "status": "done", "activityCount": 200], ["startedAtMs": 2, "activityCount": 0]]
        let metadata = try JSONDecoder().decode(StmObject.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(metadata.passes[0].activityCount, 200)
        XCTAssertEqual(metadata.passes[1].activityCount, 0)
        XCTAssertNil(metadata.passes[0].activity)
    }

    func testListSendsNoParamsAndReadsEveryObject() async throws {
        let server = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "objects.list")
            XCTAssertEqual((request["params"] as? [String: Any])?.count, 0, "the server's params are a strict empty object")
            let fresh: [String: Any] = ["id": UUID().uuidString.lowercased(), "createdAtMs": 2, "updatedAtMs": 2, "state": "new",
                                        "instructions": "A hook", "directory": "/tmp/x"]
            let future: [String: Any] = ["id": UUID().uuidString.lowercased(), "createdAtMs": 1, "updatedAtMs": 1, "state": "archived",
                                         "photos": [], "passes": [], "directory": "/tmp/y"]
            return [try reply(request, result: ["objects": [fresh, ready, future]])]
        }
        let objects = try await ControlClient(socketPath: server.path).objects()
        XCTAssertEqual(objects.count, 3, "one object in a state this app doesn't know must not hide the others")
        XCTAssertEqual(objects[0].state, .new)
        XCTAssertEqual(objects[0].photos, [], "missing lists read as empty")
        XCTAssertEqual(objects[0].passes, [])
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
        let decoded = try JSONDecoder().decode(StmObject.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(decoded.modelURL?.path, folder + "/current/model.stl")
        XCTAssertEqual(decoded.renderURLs.map(\.path), [folder + "/current/renders/front.png"])
        XCTAssertEqual(decoded.platePhotoURL?.path, folder + "/plate.jpg")
        object["plate"] = ["item": "a printed part"]
        let noPhoto = try JSONDecoder().decode(StmObject.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(noPhoto.platePhotoURL, "the plate photo exists only while plate.photo is true")
    }

    func testEachActionSendsExactlyItsParams() async throws {
        typealias Call = (method: String, params: [String: AnyHashable], run: (ControlClient) async throws -> StmObject)
        let calls: [Call] = [
            ("objects.get", ["id": id], { try await $0.object(id) }),
            ("objects.start", ["id": id], { try await $0.startObject(id) }),
            ("objects.correct", ["id": id, "note": "the clip is 3 mm thicker"], { try await $0.correctObject(id, note: "the clip is 3 mm thicker") }),
            ("objects.answerCloseup", ["id": id, "bestGuess": true], { try await $0.answerCloseup(id, bestGuess: true) }),
            ("objects.print", ["id": id], { try await $0.printObject(id) }),
            ("objects.print", ["id": id, "checked": true], { try await $0.printObject(id, checked: true) }),
            ("objects.answerPlate", ["id": id], { try await $0.answerPlate(id) }),
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
