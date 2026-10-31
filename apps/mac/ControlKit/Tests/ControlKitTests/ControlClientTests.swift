import XCTest
import Foundation
import Darwin
@testable import ControlKit

private final class UnixFixture {
    let path = "/tmp/stm-control-\(UUID().uuidString).sock"
    private let descriptor: Int32
    init(_ handler: @escaping ([String: Any]) throws -> [Data]) throws {
        descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw ControlClientError.unavailable }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bytes = path.utf8CString
        withUnsafeMutablePointer(to: &address.sun_path) { target in
            target.withMemoryRebound(to: CChar.self, capacity: 104) { pointer in
                bytes.withUnsafeBufferPointer { pointer.update(from: $0.baseAddress!, count: $0.count) }
            }
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, listen(descriptor, 4) == 0 else { Darwin.close(descriptor); throw ControlClientError.unavailable }
        let fd = descriptor
        DispatchQueue.global().async {
            let client = accept(fd, nil, nil)
            guard client >= 0 else { return }
            defer { Darwin.close(client) }
            var one: Int32 = 1
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            var request = Data(), buffer = [UInt8](repeating: 0, count: 4096)
            while !request.contains(10) {
                let count = Darwin.read(client, &buffer, buffer.count)
                if count <= 0 { return }
                request.append(contentsOf: buffer.prefix(count))
            }
            do {
                let value = try JSONSerialization.jsonObject(with: request) as! [String: Any]
                for chunk in try handler(value) {
                    let complete = chunk.withUnsafeBytes { bytes -> Bool in
                        var offset = 0
                        while offset < bytes.count {
                            let count = Darwin.write(client, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                            if count <= 0 { return false }; offset += count
                        }
                        return true
                    }
                    if !complete { return }
                }
                // Graceful EOF: keep the read side alive until the client has
                // consumed the response, rather than racing it with a reset.
                shutdown(client, SHUT_WR)
                while Darwin.read(client, &buffer, buffer.count) > 0 {}
            } catch { return }
        }
    }
    deinit { shutdown(descriptor, SHUT_RDWR); Darwin.close(descriptor); unlink(path) }
}
private func reply(_ request: [String: Any], result: Any) throws -> Data {
    var data = try JSONSerialization.data(withJSONObject: ["v": 1, "id": request["id"]!, "result": result])
    data.append(10); return data
}
private let status: [String: Any] = ["protocolVersion": 1, "companionVersion": "0.1.0", "transport": "lan", "pairedDeviceCount": 3,
    "capabilities": ["capture": true, "cleanup": false, "printerHandoff": true]]

final class ControlClientTests: XCTestCase {
    func testModelChoiceSetUsesReferenceOnlyAndCAS() async throws {
        let revision = UUID(), reference = UUID()
        let server = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "modelAccess.set")
            let params = request["params"] as! [String: Any]
            XCTAssertEqual(params["expectedRevision"] as? String, revision.uuidString)
            let choice = params["choice"] as! [String: Any]
            XCTAssertEqual(Set(choice.keys), ["kind", "provider", "model", "keychainRef"])
            XCTAssertEqual(choice["keychainRef"] as? String, reference.uuidString)
            return [try reply(request, result: ["revision": UUID().uuidString, "choice": choice, "check": NSNull()])]
        }
        let result = try await ControlClient(socketPath: server.path).setModelAccess(.api(provider: .openai, model: "gpt-6-astra", keychainRef: reference), expectedRevision: revision)
        XCTAssertFalse(result.connected); XCTAssertNil(result.check); withExtendedLifetime(server) {}
    }
    func testModelCheckIsRevisionBound() async throws {
        let revision = UUID()
        let server = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "modelAccess.check")
            XCTAssertEqual((request["params"] as? [String: String])?["revision"], revision.uuidString)
            return [try reply(request, result: ["revision": revision.uuidString, "choice": ["kind": "codex-cli"],
                "check": ["id": UUID().uuidString, "revision": UUID().uuidString, "state": "connected"]])]
        }
        let result = try await ControlClient(socketPath: server.path).checkModelAccess(revision: revision)
        XCTAssertFalse(result.connected); withExtendedLifetime(server) {}
    }

    func testMissingEndpointIsUnavailableBeforeAnyRequestIsSent() async throws {
        let client = try ControlClient(socketPath: "/tmp/stm-absent-\(UUID().uuidString).sock", timeout: 1)
        do { try await client.removeDevice(UUID().uuidString); XCTFail("Missing endpoint accepted") }
        catch { XCTAssertEqual(error as? ControlClientError, .unavailable) }
    }
    func testUnixSocketStatusWithFragmentedReply() async throws {
        let server = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "status.get")
            XCTAssertEqual((request["params"] as? [String: Any])?.count, 0)
            let data = try reply(request, result: status)
            return [Data(data.prefix(7)), Data(data.dropFirst(7))]
        }
        let value = try await ControlClient(socketPath: server.path).status()
        XCTAssertEqual(value.pairedDeviceCount, 3); XCTAssertTrue(value.capabilities.printerHandoff)
        withExtendedLifetime(server) {}
    }
    func testPairingRemainsPrivateAndLetsServerChooseRetainedLogin() async throws {
        let secret = String(repeating: "a", count: 32)
        let server = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "pairing.create")
            XCTAssertEqual((request["params"] as? [String: Any])?.count, 0)
            return [try reply(request, result: ["version": 1, "baseUrl": "https://fixture.test", "code": secret,
                "qrPayload": "scantomake://pair?v=1&c=\(secret)", "expiresAt": 1800000000000])]
        }
        let value = try await ControlClient(socketPath: server.path).createPairing()
        XCTAssertEqual(value.code, secret); XCTAssertFalse(String(describing: value).contains(secret))
        XCTAssertFalse(String(reflecting: value).contains(secret)); withExtendedLifetime(server) {}
    }
    func testWrongCorrelationVersionAndAmbiguousReplyAreRejected() async throws {
        for variant in 0..<4 {
            let server = try UnixFixture { request in
                if variant == 3 { return [Data("truncated".utf8)] }
                var response: [String: Any] = ["v": 1, "id": request["id"]!, "result": status]
                if variant == 0 { response["id"] = UUID().uuidString }
                if variant == 1 { response["v"] = 2 }
                if variant == 2 { response["error"] = ["code": "unavailable", "message": "Unavailable"] }
                var data = try JSONSerialization.data(withJSONObject: response); data.append(10); return [data]
            }
            do { _ = try await ControlClient(socketPath: server.path).status(); XCTFail("Invalid reply accepted") }
            catch {
                if variant == 3 { XCTAssertTrue([ControlClientError.invalidResponse, .unavailable].contains(error as? ControlClientError ?? .cancelled)) }
                else { XCTAssertEqual(error as? ControlClientError, .invalidResponse) }
            }
            withExtendedLifetime(server) {}
        }
    }
    func testDeadlineDoesNotRetryMutation() async throws {
        let received = expectation(description: "one mutation received"); received.assertForOverFulfill = true
        let server = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "devices.remove"); received.fulfill()
            usleep(200000); return []
        }
        do { try await ControlClient(socketPath: server.path, timeout: 0.05).removeDevice(UUID().uuidString); XCTFail("No deadline") }
        catch { XCTAssertEqual(error as? ControlClientError, .timedOut) }
        await fulfillment(of: [received], timeout: 1)
        withExtendedLifetime(server) {}
    }
    func testCancellationClosesPendingRequest() async throws {
        let received = expectation(description: "request received")
        let server = try UnixFixture { _ in received.fulfill(); usleep(200000); return [] }
        let client = try ControlClient(socketPath: server.path)
        let task = Task { try await client.status() }
        await fulfillment(of: [received], timeout: 1); task.cancel()
        do { _ = try await task.value; XCTFail("Cancellation ignored") }
        catch { XCTAssertEqual(error as? ControlClientError, .cancelled) }
        withExtendedLifetime(server) {}
    }
    func testRemoteErrorsAndConfirmationAnswerKeepTheirContract() async throws {
        let id = UUID().uuidString
        let server = try UnixFixture { request in
            XCTAssertEqual(request["method"] as? String, "confirmations.answer")
            let params = request["params"] as! [String: Any]
            XCTAssertEqual(params["id"] as? String, id)
            let answer = params["answer"] as! [String: Any]
            XCTAssertEqual(answer["action"] as? String, "accept")
            XCTAssertEqual((answer["content"] as? [String: Any])?["confirmed"] as? Bool, true)
            var data = try JSONSerialization.data(withJSONObject: ["v": 1, "id": request["id"]!, "error": ["code": "not-found", "message": "No longer pending"]]); data.append(10); return [data]
        }
        do { try await ControlClient(socketPath: server.path).answerConfirmation(id, answer: .accept(["confirmed": .bool(true)])); XCTFail("Missing remote error") }
        catch { XCTAssertEqual((error as? ControlRemoteError)?.code, "not-found") }
        withExtendedLifetime(server) {}
    }
    func testLimitsRejectNetworkEndpointsAndLargePayloads() async throws {
        for path in ["http://localhost", "localhost:9077", "/tmp/\0bad", "/" + String(repeating: "a", count: 104)] {
            XCTAssertThrowsError(try ControlClient(socketPath: path))
        }
        let client = try ControlClient(socketPath: "/tmp/not-connected.sock")
        do { try await client.answerConfirmation(UUID().uuidString, answer: .accept(["text": .string(String(repeating: "a", count: 65536))])); XCTFail("Oversized request accepted") }
        catch { XCTAssertEqual(error as? ControlClientError, .oversizedRequest) }
    }
    func testOversizedResponseIsRejected() async throws {
        let server = try UnixFixture { _ in [Data(repeating: 32, count: 8 * 1024 * 1024 + 1)] }
        do { _ = try await ControlClient(socketPath: server.path).status(); XCTFail("Oversized reply accepted") }
        catch { XCTAssertEqual(error as? ControlClientError, .invalidResponse) }
        withExtendedLifetime(server) {}
    }
}
