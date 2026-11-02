import XCTest
@testable import CounterpartKit

final class CloudPairingTests: XCTestCase {
    let macID = "11111111-1111-4111-8111-111111111111"
    func mac(expires: Date = Date().addingTimeInterval(600), addresses: String = #"[{"kind":"lan","host":"192.168.1.2","port":9077},{"kind":"mdns","host":"mac.local","port":9077}]"#) throws -> CloudMac {
        try XCTUnwrap(CloudMac(id: macID, name: "My Mac", addressesJSON: addresses, publicKeySha256: keyPin,
                              enrolmentToken: String(repeating: "E", count: 43), expiresAt: expires))
    }
    func testCloudRecordValidationAndExpiry() throws {
        let valid = try mac()
        XCTAssertEqual(valid.addresses, ["https://192.168.1.2:9077", "https://mac.local:9077"])
        XCTAssertTrue(valid.isCurrent())
        XCTAssertFalse(try mac(expires: Date().addingTimeInterval(-1)).isCurrent())
        for host in ["evil.example", "mac.local/path", "mac.local@evil.example", ""] {
            XCTAssertNil(CloudMac(id: macID, name: "Mac", addressesJSON: "[{\"kind\":\"lan\",\"host\":\"\(host)\",\"port\":9077}]",
                                  publicKeySha256: keyPin, enrolmentToken: String(repeating: "E", count: 43), expiresAt: Date().addingTimeInterval(600)))
        }
    }
    func testEnrollmentPinsEachAddressAndUsesTheStableInstallationKey() async throws {
        let store = PairingStore(store: MemoryStore())
        let fake = FakeTransport { request, trust in
            guard case .pending(let pending) = trust else { throw PairingError(.invalidInvitation) }
            XCTAssertEqual(pending.publicKeySha256, keyPin)
            if request.url?.host == "192.168.1.2" { throw TransportError("network") }
            return json(200, ["deviceId": deviceId, "token": token, "protocolVersion": "0.1.0", "scopes": scopes,
                              "expiresAt": Date().addingTimeInterval(30 * 86400).timeIntervalSince1970 * 1000,
                              "publicKeySha256": String(repeating: "cd", count: 32), "baseUrl": "https://evil.example"])
        }
        let client = PairingClient(store: store, transport: fake)
        let result = try await client.enrol(try mac(), deviceName: "My iPhone")
        XCTAssertEqual(result.state, .paired)
        XCTAssertEqual(result.baseUrl, "https://mac.local:9077")
        let request = try XCTUnwrap(fake.calls.last?.request)
        XCTAssertEqual(request.url?.path, "/v1/pair/icloud")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody!) as? [String: String])
        XCTAssertEqual(body["installId"], try store.installationKey())
        XCTAssertEqual(body["macId"], macID)
        XCTAssertEqual(body["enrolmentToken"], String(repeating: "E", count: 43))
        XCTAssertEqual(try store.read()?.publicKeySha256, keyPin)
    }
    func testExpiredCloudTokenDoesNotReachTheNetwork() async throws {
        let fake = FakeTransport { _, _ in XCTFail("expired token sent"); return json(401, [:]) }
        let client = PairingClient(store: PairingStore(store: MemoryStore()), transport: fake)
        do { _ = try await client.enrol(try mac(expires: Date().addingTimeInterval(-1)), deviceName: "Phone"); XCTFail() }
        catch { XCTAssertEqual((error as? PairingError)?.code, .expiredInvitation) }
        XCTAssertTrue(fake.calls.isEmpty)
    }
    func testAutomaticEnrollmentNeverReplacesAWorkingPairing() async throws {
        let store = PairingStore(store: MemoryStore())
        try store.save(v2Record(), notify: false)
        let fake = FakeTransport { _, _ in XCTFail("paired phone reenrolled"); return json(401, [:]) }
        do { _ = try await PairingClient(store: store, transport: fake).enrol(try mac(), deviceName: "Phone"); XCTFail() }
        catch { XCTAssertEqual((error as? PairingError)?.code, .busy) }
        XCTAssertTrue(fake.calls.isEmpty)
    }
}
