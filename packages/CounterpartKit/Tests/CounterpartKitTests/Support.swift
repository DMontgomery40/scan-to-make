import Foundation
import XCTest
@testable import CounterpartKit

/// The repository root, from this file's path (packages/CounterpartKit/Tests/CounterpartKitTests/).
let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

func fixture(_ name: String) throws -> Data {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: nil), "missing fixture \(name)")
    return try Data(contentsOf: url)
}

/// A project from a JSON fragment on top of a minimal draft.
func project(_ json: [String: Any]) -> Project {
    let base: [String: Any] = ["id": "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11", "createdAtMs": 1, "updatedAtMs": 2, "state": "new", "photos": [], "passes": []]
    let data = try! JSONSerialization.data(withJSONObject: base.merging(json) { $1 })
    return try! JSONDecoder().decode(Project.self, from: data)
}

/// A transport that answers from a closure and records what it was asked.
final class FakeTransport: HTTPTransport, @unchecked Sendable {
    struct Call { var request: URLRequest; var trust: TrustPolicy }
    private let lock = NSLock()
    private(set) var calls: [Call] = []
    var answer: (URLRequest, TrustPolicy) throws -> HTTPReply

    init(_ answer: @escaping (URLRequest, TrustPolicy) throws -> HTTPReply) { self.answer = answer }

    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        lock.lock(); calls.append(Call(request: request, trust: trust)); lock.unlock()
        return try answer(request, trust)
    }

    var paths: [String] { lock.lock(); defer { lock.unlock() }; return calls.map { ($0.request.url?.absoluteString ?? "") } }
}

func json(_ status: Int = 200, _ value: Any) -> HTTPReply {
    HTTPReply(status: status, body: try! JSONSerialization.data(withJSONObject: value))
}

let deviceId = "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a99"
let token = String(repeating: "t", count: 43)
let keyPin = String(repeating: "ab", count: 32)
let scopes = ["generation:health", "projects:read", "projects:write", "captures:read", "captures:import", "printer-handoff:use"]

/// A valid v2 record: three addresses, a public-key pin.
func v2Record(active: String? = nil, expiresAt: Double = Date().timeIntervalSince1970 * 1000 + 10 * 86_400_000) -> PairingRecord {
    var fields: [String: JSONValue] = [
        "baseUrl": .string("https://192.168.68.123:9077"),
        "addresses": .array(["https://192.168.68.123:9077", "https://davids-mac-mini.local:9077", "https://100.101.102.103:9077"].map(JSONValue.string)),
        "publicKeySha256": .string(keyPin), "deviceId": .string(deviceId), "token": .string(token),
        "protocolVersion": .string("0.1.0"), "expiresAt": .number(expiresAt), "scopes": .array(scopes.map(JSONValue.string)),
    ]
    if let active { fields["activeUrl"] = .string(active) }
    return PairingRecord(fields: fields)
}
