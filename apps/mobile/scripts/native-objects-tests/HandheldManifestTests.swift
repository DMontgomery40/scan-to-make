import Foundation

typealias RCTPromiseResolveBlock = (Any?) -> Void
typealias RCTPromiseRejectBlock = (String?, String?, Error?) -> Void
// MAC_ERROR
// PROMISE

struct StmObject: Decodable { let id: String }
struct CheckFailure: Error { let message: String }
func check(_ value: Bool, _ message: String) throws {
    if !value { throw CheckFailure(message: message) }
}

@MainActor final class FixtureBridge {
    var reply: Any?
    var failure: MacError?
    func sendHandheld(_ options: NSDictionary, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
        if let failure { reject(failure.code, failure.message, nil) }
        else { resolve(reply) }
    }
}

@MainActor final class MacConnection {
    let bridge: FixtureBridge?
    var requests: [(method: String, path: String, json: [String: Any]?)] = []
    init(_ bridge: FixtureBridge) { self.bridge = bridge }
    private struct ObjectReply: Decodable { let object: StmObject }
    private func request<T: Decodable>(_ method: String, _ path: String, _ json: [String: Any]? = nil, as type: T.Type) async throws -> T {
        requests.append((method, path, json))
        return try JSONDecoder().decode(T.self, from: Data(#"{"object":{"id":"started"}}"#.utf8))
    }
    // REQUIRE
    // CAPTURE_MANIFEST
    // START
    // SEND_HANDHELD
}

@main struct HandheldManifestTests {
    @MainActor static func run() async throws {
        let bridge = FixtureBridge()
        let connection = MacConnection(bridge)
        let valid: [String: Any] = ["version": 1, "images": ["0000.heic", "0007.heic"], "depthRequired": true]
        let malformed: [Any?] = [
            nil, [:], ["captureManifest": [:]],
            ["captureManifest": ["version": 2, "images": ["0000.heic"], "depthRequired": true]],
            ["captureManifest": ["version": true, "images": ["0000.heic"], "depthRequired": true]],
            ["captureManifest": ["version": 1, "images": [], "depthRequired": true]],
            ["captureManifest": ["version": 1, "images": ["0000.heic"]]],
            ["captureManifest": ["version": 1, "images": ["0000.heic"], "depthRequired": 1]],
            ["captureManifest": ["version": 1, "images": ["0007.heic", "0000.heic"], "depthRequired": true]],
            ["captureManifest": ["version": 1, "images": ["0000.heic", "0000.heic"], "depthRequired": true]],
            ["captureManifest": ["version": 1, "images": ["0000.HEIC"], "depthRequired": true]],
            ["captureManifest": ["version": 1, "images": ["0000.heic\n"], "depthRequired": true]],
            ["captureManifest": ["version": 1, "images": ["../0000.heic"], "depthRequired": true]],
            ["captureManifest": ["version": 1, "images": ["00000.heic"], "depthRequired": true]],
            ["captureManifest": ["version": 1, "images": (0...10000).map { String(format: "%04d.heic", $0) }, "depthRequired": true]],
        ]
        for (index, reply) in malformed.enumerated() {
            bridge.reply = reply
            do {
                _ = try await connection.sendHandheld("object-id")
                throw CheckFailure(message: "malformed or missing bridge manifest \(index) must prevent start")
            } catch let error as MacError {
                try check(error.code == "invalid-response", "malformed manifest has an explicit transport error")
            }
            try check(connection.requests.isEmpty, "invalid manifest emits no start request")
        }

        bridge.reply = ["photosSent": 2, "captureManifest": valid]
        let object = try await connection.sendHandheld("object-id")
        try check(object.id == "started" && connection.requests.count == 1, "valid completed upload starts once")
        let request = connection.requests[0]
        try check(request.method == "POST" && request.path == "/v1/objects/object-id/start", "completion goes to the object start route")
        try check((request.json as NSDictionary?)?.isEqual(to: ["captureManifest": valid]) == true, "start receives the complete unchanged manifest")

        connection.requests.removeAll()
        bridge.reply = ["photosSent": 1, "captureManifest": ["version": 1, "images": ["0002.heic"], "depthRequired": false]]
        _ = try await connection.sendHandheld("legacy-id")
        try check(((connection.requests[0].json?["captureManifest"] as? [String: Any])?["depthRequired"] as? Bool) == false, "legacy completion retains explicit false")

        connection.requests.removeAll()
        bridge.failure = MacError(code: "upload-failed", message: "fixture transport stopped")
        do {
            _ = try await connection.sendHandheld("object-id")
            throw CheckFailure(message: "failed upload cannot start reconstruction")
        } catch let error as MacError {
            try check(error.code == "upload-failed", "upload failure preserved")
        }
        try check(connection.requests.isEmpty, "failed upload emits no start request")
        _ = try await connection.start("other-flow")
        try check(connection.requests.count == 1 && connection.requests[0].json == nil, "other start callers preserve empty optional payload")
    }

    static func main() async {
        do {
            try await run()
            print("NATIVE_HANDHELD_MANIFEST_PASS fail-closed validation, exact start payload, legacy false, upload failure and unchanged other starts")
        } catch {
            print("FAIL \(error)")
            exit(1)
        }
    }
}
