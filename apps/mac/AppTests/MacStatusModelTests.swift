import XCTest

/// Scan to Make on this Mac, as the control socket and its settings file answer.
private actor FakeMac: MacStatusSource {
    var running = true
    var phones: [[String: Any]] = []
    var removeError: Error?
    private(set) var removed: [String] = []
    nonisolated let host: String?
    init(host: String?) { self.host = host }
    func set(running: Bool) { self.running = running }
    func set(phones: [[String: Any]]) { self.phones = phones }
    func failRemove(with error: Error?) { removeError = error }

    func status() async throws -> ControlStatus {
        guard running else { throw ControlClientError.unavailable }
        let json: [String: Any] = ["protocolVersion": 1, "companionVersion": "0.4.2", "transport": "lan", "pairedDeviceCount": phones.count,
                                   "capabilities": ["capture": true, "cleanup": true, "printerHandoff": true]]
        return try JSONDecoder().decode(ControlStatus.self, from:JSONSerialization.data(withJSONObject:json))
    }
    func devices() async throws -> [ControlDevice] {
        guard running else { throw ControlClientError.unavailable }
        return try phones.map { try JSONDecoder().decode(ControlDevice.self, from:JSONSerialization.data(withJSONObject:$0)) }
    }
    func removeDevice(_ id: String) async throws {
        if let removeError { throw removeError }
        removed.append(id)
        phones.removeAll { $0["deviceId"] as? String == id }
    }
    nonisolated func address() -> String? { host }
}

private func phone(_ id: String, _ name: String, pairedAt: Double = 1_700_000_000_000) -> [String: Any] {
    ["deviceId": id, "deviceName": name, "scopes": ["capture"], "pairedAt": pairedAt, "lastRefreshedAt": pairedAt,
     "expiresAt": pairedAt + 1, "pairedVia": ["transport": "lan", "login": "lan"]]
}

@MainActor final class MacStatusModelTests: XCTestCase {
    func testRunningShowsThePairedIPhonesAndTheAddress() async {
        let mac = FakeMac(host:"192.168.1.20:9077")
        await mac.set(phones:[phone("a", "David’s iPhone")])
        let model = MacStatusModel(source:mac)
        XCTAssertEqual(model.connection, .checking)
        await model.refresh()
        XCTAssertEqual(model.connection, .running)
        XCTAssertEqual(model.devices.map(\.deviceName), ["David’s iPhone"])
        XCTAssertEqual(model.address, "192.168.1.20:9077")
    }

    func testNotRunningWhenNothingAnswersAndForgetsWhatItShowed() async {
        let mac = FakeMac(host:nil)
        await mac.set(phones:[phone("a", "iPhone")])
        let model = MacStatusModel(source:mac)
        await model.refresh()
        await mac.set(running:false)
        await model.refresh()
        XCTAssertEqual(model.connection, .notRunning)
        XCTAssertEqual(model.devices.count, 0, "a list it can't read again isn't shown as if it were current")
        XCTAssertNil(model.address)
    }

    func testRemoveTakesTheIPhoneOffTheList() async {
        let mac = FakeMac(host:nil)
        await mac.set(phones:[phone("a", "iPhone"), phone("b", "iPad")])
        let model = MacStatusModel(source:mac)
        await model.refresh()
        let removed = await model.remove("a")
        XCTAssertTrue(removed)
        XCTAssertEqual(model.devices.map(\.deviceId), ["b"])
        let calls = await mac.removed
        XCTAssertEqual(calls, ["a"])
    }

    func testARemoveThatFailsKeepsTheIPhoneAndSaysSo() async {
        let mac = FakeMac(host:nil)
        await mac.set(phones:[phone("a", "iPhone")])
        let model = MacStatusModel(source:mac)
        await model.refresh()
        await mac.failRemove(with:ControlClientError.timedOut)
        let removed = await model.remove("a")
        XCTAssertFalse(removed)
        XCTAssertEqual(model.devices.map(\.deviceId), ["a"])
        XCTAssertEqual(model.problem, "That iPhone couldn’t be removed. Try again.")
    }
}
