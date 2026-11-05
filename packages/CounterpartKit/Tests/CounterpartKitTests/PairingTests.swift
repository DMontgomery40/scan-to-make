import XCTest
import Security
@testable import CounterpartKit

/// Pairing links, records, pins and nearby crypto. The link vectors and the nearby test vector are read from
/// packages/contracts/fixtures by path, so the Swift and TypeScript implementations can't drift apart.
final class PairingLinkTests: XCTestCase {
    func testEveryVectorTheTypeScriptParserAnswers() throws {
        let url = repoRoot.appending(path: "packages/contracts/fixtures/pairing-link-vectors.json")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let cases = try XCTUnwrap(object["cases"] as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 100)
        for item in cases {
            let link = try XCTUnwrap(item["link"] as? String)
            let now = (item["now"] as? NSNumber).map { Int64(truncating: $0) }
            let context = "\(link) now=\(now.map(String.init) ?? "-")"
            do {
                let parsed = try PairingLink.parse(link, now: now)
                let expected = try XCTUnwrap(item["parsed"] as? [String: Any], "Swift accepted what TS refused: \(context) (\(item["error"] ?? ""))")
                switch parsed {
                case let .v1(baseUrl, code, expiresAt, pin):
                    XCTAssertEqual(expected["version"] as? Int, 1, context)
                    XCTAssertEqual(expected["baseUrl"] as? String, baseUrl, context)
                    XCTAssertEqual(expected["code"] as? String, code, context)
                    XCTAssertEqual((expected["expiresAt"] as? NSNumber)?.int64Value, expiresAt, context)
                    XCTAssertEqual(expected["certificateSha256"] as? String, pin, context)
                case let .v2(addresses, code, expiresAt, key, name):
                    XCTAssertEqual(expected["version"] as? Int, 2, context)
                    XCTAssertEqual(expected["addresses"] as? [String], addresses, context)
                    XCTAssertEqual(expected["code"] as? String, code, context)
                    XCTAssertEqual((expected["expiresAt"] as? NSNumber)?.int64Value, expiresAt, context)
                    XCTAssertEqual(expected["publicKeySha256"] as? String, key, context)
                    XCTAssertEqual(expected["name"] as? String, name, context)
                }
            } catch let error as PairingLinkError {
                XCTAssertEqual(item["error"] as? String, error.rawValue, "Swift refused (\(error.rawValue)) what TS answered: \(context)")
            }
        }
    }

    func testInvitationsFromLinksAndTheOlderJSON() throws {
        let now: Int64 = 1_800_000_000_000
        let code = String(repeating: "A", count: 32)
        let v2 = "scantomake://pair?v=2&c=\(code)&e=\(now + 1000)&k=\(keyPin)&a=https%3A%2F%2F192.168.1.2%3A9077&a=https%3A%2F%2Fmac.local%3A9077&n=Mac"
        let invitation = try PairingInvitation.parse("  \(v2)\n", now: now)
        XCTAssertEqual(invitation.baseUrl, "https://192.168.1.2:9077")
        XCTAssertEqual(invitation.addresses, ["https://192.168.1.2:9077", "https://mac.local:9077"])
        XCTAssertEqual(invitation.name, "Mac")
        XCTAssertTrue(invitation.isLocal)

        let pin = String(repeating: "0f", count: 32)
        let json = #"{"version":1,"baseUrl":"https://192.168.1.20:9077","code":"\#(code)","expiresAt":\#(now + 1000),"certificateSha256":"\#(pin)"}"#
        let legacy = try PairingInvitation.parse(json, now: now)
        XCTAssertEqual(legacy.certificateSha256, pin)
        XCTAssertEqual(legacy.baseUrl, "https://192.168.1.20:9077")
        XCTAssertThrowsError(try PairingInvitation.parse(json, now: now + 1000)) { XCTAssertEqual($0 as? PairingLinkError, .expired) }
        // Unpinned JSON must name Tailscale Serve.
        let unpinned = #"{"version":1,"baseUrl":"https://192.168.1.20:9077","code":"\#(code)","expiresAt":\#(now + 1000)}"#
        XCTAssertThrowsError(try PairingInvitation.parse(unpinned, now: now)) { XCTAssertEqual($0 as? PairingLinkError, .invalid) }
        let tailscale = #"{"version":1,"baseUrl":"https://mac.tail1234.ts.net","code":"\#(code)","expiresAt":\#(now + 1000)}"#
        XCTAssertNil(try PairingInvitation.parse(tailscale, now: now).certificateSha256)
        XCTAssertThrowsError(try PairingInvitation.parse("hello", now: now)) { XCTAssertEqual($0 as? PairingLinkError, .invalid) }
        XCTAssertThrowsError(try PairingInvitation.parse(#"{"version":2}"#, now: now)) { XCTAssertEqual($0 as? PairingLinkError, .invalid) }
    }
}

final class PairingRecordTests: XCTestCase {
    func testAddressRules() {
        XCTAssertEqual(CompanionAddress.pinnedBaseURL("https://192.168.1.20:9077/", pin: keyPin)?.absoluteString, "https://192.168.1.20:9077")
        XCTAssertNotNil(CompanionAddress.pinnedBaseURL("https://mac.local", pin: keyPin))
        XCTAssertNotNil(CompanionAddress.pinnedBaseURL("https://mac:9077", pin: keyPin))
        XCTAssertNotNil(CompanionAddress.pinnedBaseURL("https://[fd00::1]:9077", pin: keyPin))
        XCTAssertNil(CompanionAddress.pinnedBaseURL("https://mac.example.com", pin: keyPin), "a private certificate only works where ATS's local exemption applies")
        XCTAssertNil(CompanionAddress.pinnedBaseURL("http://192.168.1.20:9077", pin: keyPin))
        XCTAssertNil(CompanionAddress.pinnedBaseURL("https://192.168.1.20:9077/path", pin: keyPin))
        XCTAssertNil(CompanionAddress.pinnedBaseURL("https://user@192.168.1.20", pin: keyPin))
        XCTAssertNil(CompanionAddress.pinnedBaseURL("https://192.168.1.20", pin: "nope"))
        XCTAssertEqual(CompanionAddress.companionBaseURL("https://mac.tail1234.ts.net/")?.absoluteString, "https://mac.tail1234.ts.net")
        XCTAssertNil(CompanionAddress.companionBaseURL("https://mac.tail1234.ts.net:8443"))
        XCTAssertNil(CompanionAddress.companionBaseURL("https://192.168.1.20"))
        XCTAssertNil(CompanionAddress.companionBaseURL("http://127.0.0.1:9078"), "fixtures are simulator-only")
        XCTAssertNil(CompanionAddress.pinnedAddresses([], pin: keyPin))
        XCTAssertNil(CompanionAddress.pinnedAddresses(["https://mac.local", "https://MAC.local"], pin: keyPin))
        XCTAssertNil(CompanionAddress.pinnedAddresses(["https://mac.local/"], pin: keyPin))
        XCTAssertEqual(CompanionAddress.pinnedAddresses((1...8).map { "https://10.0.0.\($0)" }, pin: keyPin)?.count, 8)
        XCTAssertNil(CompanionAddress.pinnedAddresses((1...9).map { "https://10.0.0.\($0)" }, pin: keyPin))
        XCTAssertTrue(CompanionAddress.tryNext(after: "network"))
        XCTAssertTrue(CompanionAddress.tryNext(after: "certificate-changed"))
        XCTAssertFalse(CompanionAddress.tryNext(after: "unauthorized"))
    }

    func testRecordValidation() {
        XCTAssertTrue(v2Record().isValid)
        XCTAssertTrue(v2Record(active: "https://100.101.102.103:9077").isValid)
        XCTAssertFalse(v2Record(active: "https://10.9.9.9:9077").isValid, "activeUrl must be one of the Mac's addresses")
        var record = v2Record()
        record.fields["certificateSha256"] = .string(keyPin)
        XCTAssertFalse(record.isValid, "a v2 record never carries a certificate pin")
        record = v2Record(); record.fields["protocolVersion"] = .string("0.2.0"); XCTAssertFalse(record.isValid)
        record = v2Record(); record.fields["token"] = .string("short"); XCTAssertFalse(record.isValid)
        record = v2Record(); record.fields["deviceId"] = .string("not-a-uuid"); XCTAssertFalse(record.isValid)
        record = v2Record(); record.fields["scopes"] = .array([.string("projects:read"), .string("captures:import")]); XCTAssertFalse(record.isValid, "generation:health is required")
        record = v2Record(); record.fields["scopes"] = .array([.string("generation:health"), .string("generation:health")]); XCTAssertFalse(record.isValid)
        record = v2Record(); record.fields["scopes"] = .array([.string("generation:health"), .string("everything")]); XCTAssertFalse(record.isValid)
        record = v2Record(); record.fields["expiresAt"] = .number(0); XCTAssertFalse(record.isValid)
        // A v1 record: one pinned address, no list.
        let v1 = PairingRecord(fields: ["baseUrl": .string("https://192.168.1.20:9077"), "certificateSha256": .string(keyPin), "deviceId": .string(deviceId),
                                        "token": .string(token), "protocolVersion": .string("0.1.0"), "expiresAt": .number(1), "scopes": .array(scopes.map(JSONValue.string))])
        XCTAssertTrue(v1.isValid)
        var listed = v1; listed.fields["addresses"] = .array([.string("https://192.168.1.20:9077")])
        XCTAssertFalse(listed.isValid, "an address list needs a public-key pin")
    }

    func testAttemptOrderAndSamePairing() {
        XCTAssertEqual(v2Record().attemptOrder, ["https://192.168.68.123:9077", "https://davids-mac-mini.local:9077", "https://100.101.102.103:9077"])
        XCTAssertEqual(v2Record(active: "https://100.101.102.103:9077").attemptOrder,
                       ["https://100.101.102.103:9077", "https://192.168.68.123:9077", "https://davids-mac-mini.local:9077"])
        XCTAssertEqual(v2Record(active: "https://100.101.102.103:9077").requestBaseURL?.absoluteString, "https://100.101.102.103:9077")
        XCTAssertTrue(v2Record().isSamePairing(as: v2Record(active: "https://100.101.102.103:9077")), "another address is the same pairing")
        XCTAssertTrue(v2Record().isSamePairing(as: v2Record(expiresAt: 99)), "a renewed expiry is the same pairing")
        var other = v2Record(); other.fields["token"] = .string(String(repeating: "u", count: 43))
        XCTAssertFalse(v2Record().isSamePairing(as: other))
        XCTAssertFalse(v2Record().isSamePairing(as: nil))
    }

    func testStatusNeverHoldsTheToken() {
        let status = PairingStatus(v2Record(active: "https://100.101.102.103:9077"))
        XCTAssertEqual(status.state, .paired)
        XCTAssertEqual(status.host, "100.101.102.103")
        XCTAssertFalse(String(describing: status).contains(token))
        XCTAssertEqual(PairingStatus(v2Record(expiresAt: 5)).state, .expired)
        XCTAssertEqual(PairingStatus(nil).state, .disconnected)
    }
}

final class TrustTests: XCTestCase {
    private struct Certificates: Decodable {
        struct One: Decodable { var certificate: String; var certificateSha256: String; var publicKeySha256: String }
        var rsa: One; var ec: One
    }

    func testSubjectPublicKeyInfoMatchesOpenSSL() throws {
        let certs = try JSONDecoder().decode(Certificates.self, from: fixture("certificates.json"))
        for one in [certs.rsa, certs.ec] {
            let der = try fixture(one.certificate)
            XCTAssertEqual(CompanionTrust.publicKeySha256(certificate: der), one.publicKeySha256)
            XCTAssertEqual(Hex.sha256(der), one.certificateSha256)
            // Every truncation is refused, never read past its end.
            for cut in stride(from: 0, to: der.count, by: 37) { _ = CompanionTrust.subjectPublicKeyInfo(der.prefix(cut)) }
        }
        XCTAssertNil(CompanionTrust.subjectPublicKeyInfo(Data()))
        XCTAssertNil(CompanionTrust.subjectPublicKeyInfo(Data([0x30, 0x84, 0xff, 0xff, 0xff, 0xff])))
    }

    func testPinnedTrustNeedsTheKeyOnItsOwnHostAndPort() throws {
        let certs = try JSONDecoder().decode(Certificates.self, from: fixture("certificates.json"))
        let der = try fixture(certs.ec.certificate)
        var record = v2Record()
        record.fields["publicKeySha256"] = .string(certs.ec.publicKeySha256)
        XCTAssertTrue(CompanionTrust.accepts(record: record, host: "192.168.68.123", port: 9077, leafCertificate: der))
        XCTAssertTrue(CompanionTrust.accepts(record: record, host: "192.168.68.123".uppercased(), port: 9077, leafCertificate: der))
        XCTAssertFalse(CompanionTrust.accepts(record: record, host: "192.168.68.124", port: 9077, leafCertificate: der), "another host")
        XCTAssertFalse(CompanionTrust.accepts(record: record, host: "192.168.68.123", port: 9078, leafCertificate: der), "another port")
        XCTAssertFalse(CompanionTrust.accepts(record: record, host: "192.168.68.123", port: 9077, leafCertificate: try fixture(certs.rsa.certificate)), "another key")
        XCTAssertFalse(CompanionTrust.accepts(record: record, host: "192.168.68.123", port: 9077, leafCertificate: nil))
        // v1: the whole certificate.
        let v1 = PairingRecord(fields: ["baseUrl": .string("https://192.168.1.20"), "certificateSha256": .string(certs.rsa.certificateSha256)])
        XCTAssertTrue(CompanionTrust.accepts(record: v1, host: "192.168.1.20", port: 0, leafCertificate: try fixture(certs.rsa.certificate)), "port 0 means 443")
        XCTAssertFalse(CompanionTrust.accepts(record: v1, host: "192.168.1.20", port: 0, leafCertificate: der))
    }

    func testNearbyVectorFromTheContract() throws {
        let url = repoRoot.appending(path: "packages/contracts/fixtures/nearby-pairing-v1.json")
        let vector = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: String])
        let s = try XCTUnwrap(Hex.bytes(vector["publicKeySha256"]!))
        let key = try XCTUnwrap(NearbyCrypto.bytes(vector["key"]))
        let nonce = try XCTUnwrap(NearbyCrypto.bytes(vector["nonce"]))
        XCTAssertEqual(NearbyCrypto.commit(key: key).map(NearbyCrypto.base64URL), vector["commit"])
        XCTAssertEqual(NearbyCrypto.code(publicKeySha256: s, key: key, nonce: nonce), vector["code"])
        XCTAssertEqual(NearbyCrypto.base64URL(key), vector["key"])
        XCTAssertNil(NearbyCrypto.bytes(String(vector["key"]!.dropLast()) + "B"), "non-canonical base64url is refused")
        XCTAssertNil(NearbyCrypto.bytes("short"))
        XCTAssertNil(NearbyCrypto.commit(key: Data(count: 31)))
        XCTAssertEqual(NearbyCrypto.display("482913"), "482 913")
    }

    func testNearbyTrustOnFirstUse() throws {
        let certs = try JSONDecoder().decode(Certificates.self, from: fixture("certificates.json"))
        let ec = try fixture(certs.ec.certificate), rsa = try fixture(certs.rsa.certificate)
        let base = URL(string: "https://192.168.1.5:9077")!
        let first = try XCTUnwrap(NearbyCrypto.trust(host: "192.168.1.5", port: 9077, leafCertificate: ec, base: base, seen: nil))
        XCTAssertEqual(Hex.string(first), certs.ec.publicKeySha256)
        XCTAssertNotNil(NearbyCrypto.trust(host: "192.168.1.5", port: 9077, leafCertificate: ec, base: base, seen: first))
        XCTAssertNil(NearbyCrypto.trust(host: "192.168.1.5", port: 9077, leafCertificate: rsa, base: base, seen: first), "only the first key after that")
        XCTAssertNil(NearbyCrypto.trust(host: "192.168.1.6", port: 9077, leafCertificate: ec, base: base, seen: nil))
    }
}

final class PairingStoreTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "counterpart-tests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    func testTheKeychainItemsAreTheOnesEveryVersionUsed() {
        let query = KeychainStore.query("current")
        XCTAssertEqual(query[kSecAttrService as String] as? String, "org.scantomake.companion.v1")
        XCTAssertEqual(query[kSecAttrAccount as String] as? String, "current")
        XCTAssertEqual(query[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(query[kSecAttrSynchronizable as String] as? Bool, false)
        XCTAssertNil(query[kSecAttrAccessGroup as String], "no access group: the app's default group, so an installed app upgrades in place")
    }

    func testReadsARecordAnEarlierAppWrote() throws {
        // As CompanionPairing.mm stored it: NSJSONSerialization, integers, no sorted keys.
        let legacy = #"{"deviceId":"\#(deviceId)","token":"\#(token)","protocolVersion":"0.1.0","expiresAt":4102444800000,"scopes":["generation:health","projects:read","captures:import","printer-handoff:use"],"baseUrl":"https://192.168.68.123:9077","publicKeySha256":"\#(keyPin)","addresses":["https://192.168.68.123:9077","https://100.101.102.103:9077"],"activeUrl":"https://100.101.102.103:9077","label":"kept"}"#
        let memory = MemoryStore(["current": Data(legacy.utf8)])
        let store = PairingStore(store: memory, defaults: defaults())
        let record = try XCTUnwrap(try store.read())
        XCTAssertEqual(record.requestBaseURL?.absoluteString, "https://100.101.102.103:9077")
        XCTAssertEqual(try store.status().state, .paired)
        try store.save(record, notify: false)
        let back = try XCTUnwrap(try store.read())
        XCTAssertEqual(back, record, "a field this version doesn't use survives a write")
        XCTAssertEqual(back.fields["label"], .string("kept"))
        XCTAssertEqual(back.fields["expiresAt"], .number(4_102_444_800_000))
    }

    func testAnUnreadableRecordIsAnErrorNotAnEmptyPairing() {
        let store = PairingStore(store: MemoryStore(["current": Data("{\"baseUrl\":1}".utf8)]), defaults: defaults())
        XCTAssertThrowsError(try store.read())
        let locked = MemoryStore(); locked.failReads = true
        XCTAssertThrowsError(try PairingStore(store: locked, defaults: defaults()).read())
        XCTAssertNil(try PairingStore(store: MemoryStore(), defaults: defaults()).read())
    }

    func testInstallationKeyIsStableAndDeviceNamesAreDistinct() throws {
        let memory = MemoryStore(), d = defaults()
        let store = PairingStore(store: memory, defaults: d, systemName: { "iPhone" })
        let key = try store.installationKey()
        XCTAssertEqual(key.count, 43)
        XCTAssertEqual(try store.installationKey(), key)
        let suffix = String(Hex.sha256(Data(key.utf8)).prefix(4)).uppercased()
        XCTAssertEqual(try store.deviceName(), "iPhone (\(suffix))")
        XCTAssertEqual(try PairingStore(store: memory, defaults: d, systemName: { "David's iPhone" }).deviceName(), "David's iPhone")
        XCTAssertEqual(try store.setDeviceName("  Kitchen phone "), "Kitchen phone")
        XCTAssertEqual(try store.deviceName(), "Kitchen phone")
        XCTAssertThrowsError(try store.setDeviceName("   "))
        XCTAssertThrowsError(try store.setDeviceName(String(repeating: "x", count: 81)))
        // A damaged installation key is an error, never silently replaced (that would duplicate this phone on the Mac).
        let damaged = PairingStore(store: MemoryStore(["installation": Data("short".utf8)]), defaults: d)
        XCTAssertThrowsError(try damaged.installationKey())
    }
}

final class PairingWordsTests: XCTestCase {
    /// The connect screens say "connect", never "pair" (docs/design/messaging.md): a first-time user
    /// has never been told what pairing is, so every failure message must read without it.
    func testNoConnectMessageSaysPair() {
        let codes: [PairingError.Code] = [.invalidInvitation, .expiredInvitation, .unsupportedInvitation,
            .unauthorized, .forbidden, .rateLimited, .certificateChanged, .certificate, .wrongHost,
            .network, .timeout, .unavailable, .secureStorage, .pairingRequired, .pairingChanged,
            .invalidResponse, .invalidDeviceName, .nearbyDenied, .nearbyExpired, .localNetwork,
            .cancelled, .busy]
        for code in codes {
            XCTAssertFalse(PairingWords.message(code).lowercased().contains("pair"), "\(code): \(PairingWords.message(code))")
        }
        XCTAssertFalse(PairingWords.expired.lowercased().contains("pair"))
        XCTAssertFalse(PairingWords.unreachable.lowercased().contains("pair"))
        XCTAssertFalse(PairingWords.failure(NSError(domain: "test", code: 1)).lowercased().contains("pair"))
    }
}
