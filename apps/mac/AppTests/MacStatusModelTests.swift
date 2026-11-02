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
        XCTAssertEqual(model.problem, "That phone couldn’t be removed. Try again.")
    }

    func testRePairingLeavesOneRowAndRemoveTakesEveryPairingInIt() async {
        let mac = FakeMac(host:nil)
        // Six legacy "My phone" pairings from before stable identity (each unused since the next paired), and one iPad.
        var phones = (0..<6).map { phone("p\($0)", $0 == 2 ? " my phone " : "My phone", pairedAt:1_700_000_000_000 + Double($0) * 1000) }
        phones.append(phone("ipad", "David's iPad Pro", pairedAt:1_600_000_000_000))
        await mac.set(phones:phones)
        let model = MacStatusModel(source:mac)
        await model.refresh()
        let groups = model.groups
        XCTAssertEqual(groups.count, 2, "re-pairing never shows a second row")
        XCTAssertEqual(groups[0].primary.deviceId, "p5", "the newest pairing speaks for the row")
        XCTAssertEqual(groups[0].older, 5)
        XCTAssertEqual(groups[1].kind, "iPad")
        let older = await model.remove(Array(groups[0].ids.dropFirst()))
        XCTAssertTrue(older)
        let gone = await mac.removed
        XCTAssertEqual(Set(gone), Set((0..<5).map { "p\($0)" }), "older pairings go only when asked for, and only they go")
        XCTAssertEqual(model.groups.map(\.id), ["p5", "ipad"])
    }

    func testTwoPhonesThatShareANameAndAreBothInUseKeepTheirOwnRows() {
        let base = 1_700_000_000_000.0
        let older = ControlDevice(deviceId:"a", deviceName:"iPhone", pairedAt:base, lastRefreshedAt:base + 5_000, expiresAt:0, lastSeenAt:base + 9_000)
        let newer = ControlDevice(deviceId:"b", deviceName:"iPhone", pairedAt:base + 1_000, lastRefreshedAt:base + 2_000, expiresAt:0)
        let groups = DeviceGroup.groups([older, newer])
        XCTAssertEqual(groups.count, 2, "the older phone was used after the newer one paired: it is a second phone")
        XCTAssertTrue(groups.allSatisfy { $0.older == 0 }, "removing one never revokes the other")
        let iPad = ControlDevice(deviceId:"c", deviceName:"iPhone", pairedAt:base - 1_000, lastRefreshedAt:base - 900, expiresAt:0, model:"iPad16,3")
        let phone = ControlDevice(deviceId:"d", deviceName:"iPhone", pairedAt:base, lastRefreshedAt:base, expiresAt:0, model:"iPhone18,2")
        XCTAssertEqual(DeviceGroup.groups([iPad, phone]).count, 2, "different hardware is never folded together")
    }

    func testOlderPairingsFromBeforeStableIdentityAreListedApartAndNeverConnected() throws {
        let now = Date().timeIntervalSince1970 * 1000
        let phone = ControlDevice(deviceId:"real", deviceName:"David's iPhone", pairedAt:now - 86_400_000, lastRefreshedAt:now, expiresAt:0,
                                  model:"iPhone18,2", lastSeenAt:now - 1_000, legacy:false)
        let old = (0..<6).map { ControlDevice(deviceId:"old\($0)", deviceName:"David's iPhone", pairedAt:now - Double(10 + $0) * 86_400_000,
                                              lastRefreshedAt:now - 1_000, expiresAt:0, lastSeenAt:now - 1_000, legacy:true) }
        let unmarked = ControlDevice(deviceId:"plain", deviceName:"iPad", pairedAt:now, lastRefreshedAt:now, expiresAt:0)
        let all = [phone] + old + [unmarked]
        let groups = DeviceGroup.groups(all.filter { $0.legacy != true })
        XCTAssertEqual(Set(groups.map(\.id)), ["real", "plain"], "a companion that doesn't mark them keeps every row as before")
        XCTAssertTrue(groups.allSatisfy { $0.older == 0 }, "older pairings never fold into the real phone's row")
        let legacyRow = DeviceGroup(primary:old[0], ids:["old0"])
        XCTAssertFalse(legacyRow.connectedNow(at:Date()), "never shown as connected, however recently it was refreshed")
        XCTAssertFalse(legacyRow.detail(at:Date()).contains("connected"))
        let decoded = try JSONDecoder().decode([ControlDevice].self, from:Data(#"""
        [{"deviceId":"a","deviceName":"x","scopes":[],"pairedAt":1,"lastRefreshedAt":1,"expiresAt":1,"pairedVia":{"transport":"lan","login":"lan"},"legacy":true},
         {"deviceId":"b","deviceName":"y","scopes":[],"pairedAt":1,"lastRefreshedAt":1,"expiresAt":1,"pairedVia":{"transport":"lan","login":"lan"}}]
        """#.utf8))
        XCTAssertEqual(decoded.map(\.legacy), [true, nil])
    }

    func testARowSaysConnectedOnlyOnARecentRequest() throws {
        let now = Date(timeIntervalSince1970:1_800_000_000)
        func device(seen: Double?, model: String? = "iPhone18,2") -> DeviceGroup {
            DeviceGroup(primary:ControlDevice(deviceId:"d", deviceName:"David's iPhone 18 Pro", pairedAt:(now.timeIntervalSince1970 - 2 * 86_400) * 1000,
                                              lastRefreshedAt:(now.timeIntervalSince1970 - 3 * 86_400) * 1000, expiresAt:0, model:model,
                                              lastSeenAt:seen.map { (now.timeIntervalSince1970 - $0) * 1000 }), ids:["d"])
        }
        XCTAssertTrue(device(seen:60).detail(at:now).hasPrefix("iPhone · connected now · paired "))
        XCTAssertTrue(device(seen:86_400).detail(at:now).hasPrefix("iPhone · last seen yesterday"))
        XCTAssertFalse(device(seen:nil).connectedNow(at:now), "a token refresh alone is not a connection")
        XCTAssertEqual(device(seen:60, model:"iPad16,3").kind, "iPad")
    }

    func testNotificationDefaultsFollowTheMacColumnAndProgressIsOff() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName:"kan220-notify-\(UUID().uuidString)"))
        let prefs = NotificationPrefs(defaults:defaults)
        for type in ["pass.ready", "pass.ask", "print.done", "print.failed", "print.paused", "print.not-started",
                     "print.confirm", "pass.failed"] {
            XCTAssertTrue(prefs.shouldNotify(type:type), type)
        }
        for type in ["plate.blocked", "print.first-layer", "print.unreachable", "print.status", "print.started", "pass.started", "pass.stage",
                     "print.resumed", "print.cancelled", "print.preparing", "something.new"] {
            XCTAssertFalse(prefs.shouldNotify(type:type), type)
        }
        XCTAssertFalse(prefs.shouldNotify(type:"print.milestone", progress:50), "progress is off on the Mac by default")
        prefs.progress = .quarters
        XCTAssertTrue(prefs.shouldNotify(type:"print.milestone", progress:75))
        XCTAssertTrue(prefs.shouldNotify(type:"print.milestone", progress:60), "the shared setting decided which milestones exist")
        XCTAssertEqual(ProgressNotifications.quarters.milestones, "25-50-75")
        XCTAssertEqual(ProgressNotifications(milestones:"every-10"), .every10)
        XCTAssertNil(ProgressNotifications.off.milestones, "Off on the Mac never turns the phone's milestones off")
        XCTAssertNil(ProgressNotifications(milestones:"off"), "the phone turned them off: there is no level to show")
        prefs.set(.done, false)
        XCTAssertFalse(prefs.shouldNotify(type:"print.done"))
    }
}
