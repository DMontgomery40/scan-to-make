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
}
