import XCTest

/// PRD §5.9 and docs/protocols/settings.md: the companion keeps every setting, and the Mac applies what changes it.
final class CompanionSettingsTests: XCTestCase {
    func testTheDocumentsShapeReads() throws {
        let json = #"""
        {"milestones":"25-50-75",
         "notifications":{"mac":{"pass.ready":true,"print.milestone":false,"mcp.update.failed":true},"devices":{"d1":{"pass.ready":true}}},
         "general":{"openAtLogin":true,"showInDock":false,"keepAwake":true},
         "ai":{"revision":"r","choice":{"kind":"claude-code"},"check":{"id":"c","revision":"r","state":"failed","outcome":"needs-gui-session"}},
         "fusion":{"state":"connected","message":"Fusion is connected."},
         "somethingNewer":{"x":1}}
        """#
        let settings = try JSONDecoder().decode(CompanionSettings.self, from: Data(json.utf8))
        XCTAssertEqual(settings.milestones, "25-50-75")
        XCTAssertEqual(settings.notificationsMac?["mcp.update.failed"], true)
        XCTAssertEqual(settings.general, .init(openAtLogin: true, showInDock: false, keepAwake: true))
        XCTAssertEqual(settings.aiCheckOutcome, "needs-gui-session")
        XCTAssertEqual(settings.fusion?.state, "connected")
    }

    func testAnOlderCompanionLeavesTheMacsOwnSettings() throws {
        let settings = try JSONDecoder().decode(CompanionSettings.self, from: Data(#"{"milestones":"50"}"#.utf8))
        XCTAssertNil(settings.general, "General stays this Mac's own")
        XCTAssertNil(settings.notificationsMac, "and so do the notification switches")
        let garbled = try JSONDecoder().decode(CompanionSettings.self, from: Data(#"{"milestones":"50","general":"on","notifications":[]}"#.utf8))
        XCTAssertNil(garbled.general, "a section this app can't read is left alone, never guessed")
    }

    func testTheCompanionsSwitchesDecideMacNotifications() throws {
        let prefs = NotificationPrefs(defaults: try XCTUnwrap(UserDefaults(suiteName: "kan220-settings-\(UUID().uuidString)")))
        XCTAssertTrue(prefs.shouldNotify(type: "pass.ready"), "this Mac's own defaults before the companion keeps them")
        prefs.types = ["pass.ready": false, "print.milestone": true, "mcp.update.failed": true]
        XCTAssertFalse(prefs.shouldNotify(type: "pass.ready"), "changed on the phone, followed here")
        XCTAssertTrue(prefs.shouldNotify(type: "print.milestone", progress: 60))
        XCTAssertTrue(prefs.shouldNotify(type: "mcp.update.failed"))
        XCTAssertFalse(prefs.shouldNotify(type: "print.someday"), "a type the companion hasn't listed is off on the Mac")
        XCTAssertEqual(MacNotificationTypes.ordered.count, 17)
        XCTAssertEqual(MacNotificationTypes.ordered.first?.type, "pass.ready")
    }

    func testSparseStoredChoicesKeepMacDefaultsAndExplicitFalse() throws {
        let prefs = NotificationPrefs(defaults: try XCTUnwrap(UserDefaults(suiteName: "settings-sparse-\(UUID().uuidString)")))
        prefs.types = [:]
        XCTAssertTrue(prefs.shouldNotify(type: "pass.ready"))
        XCTAssertFalse(prefs.shouldNotify(type: "print.milestone"))
        prefs.types = ["pass.ready": false]
        XCTAssertFalse(prefs.shouldNotify(type: "pass.ready"))
    }

    func testGeneralMigrationUsesCurrentMacStateOnlyForUnownedValues() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "settings-general-\(UUID().uuidString)"))
        let empty = CompanionSettings(milestones: "50", notificationsMac: [:], general: .init(openAtLogin: nil, showInDock: nil, keepAwake: nil))
        let current = ["openAtLogin": false, "showInDock": false, "keepAwake": true]
        let patch = SettingsMigration.patch(defaults: defaults, companion: empty, currentGeneral: current)
        XCTAssertEqual(patch["general"], .object(current.mapValues(JSONValue.bool)))
        let owned = CompanionSettings(milestones: "50", notificationsMac: [:], general: .init(openAtLogin: false, showInDock: false, keepAwake: false))
        XCTAssertNil(SettingsMigration.patch(defaults: defaults, companion: owned, currentGeneral: ["openAtLogin": true, "showInDock": true, "keepAwake": true])["general"])
        defaults.set(["pass.ready": false, "future.event": false], forKey: NotificationPrefs.typesKey)
        XCTAssertEqual(SettingsMigration.patch(defaults: defaults, companion: empty)["notifications"], .object(["mac": .object(["pass.ready": .bool(false), "future.event": .bool(false)])]))
    }

    func testTurningOffCancelsPendingRegistrationWithoutTouchingUnknownServices() {
        XCTAssertEqual(LoginRegistrationAction.resolve(on: false, status: .requiresApproval), .unregister)
        XCTAssertEqual(LoginRegistrationAction.resolve(on: true, status: .requiresApproval), .approvalRequired)
        XCTAssertEqual(LoginRegistrationAction.resolve(on: false, status: .enabled), .unregister)
        XCTAssertEqual(LoginRegistrationAction.resolve(on: true, status: .enabled), .none)
        XCTAssertEqual(LoginRegistrationAction.resolve(on: false, status: .notRegistered), .none)
        XCTAssertEqual(LoginRegistrationAction.resolve(on: true, status: .notRegistered), .register)
        XCTAssertEqual(LoginRegistrationAction.resolve(on: false, status: .notFound), .unavailable)
        XCTAssertEqual(LoginRegistrationAction.resolve(on: true, status: .notFound), .unavailable)
    }

    func testGeneralSnapshotKeepsPendingRegistrationAndLeavesUnknownStatusUnowned() {
        XCTAssertEqual(SettingsMigration.currentGeneral(loginStatus: .requiresApproval, showInDock: false, keepAwake: true)["openAtLogin"], true)
        XCTAssertEqual(SettingsMigration.currentGeneral(loginStatus: .enabled, showInDock: false, keepAwake: true)["openAtLogin"], true)
        XCTAssertEqual(SettingsMigration.currentGeneral(loginStatus: .notRegistered, showInDock: false, keepAwake: true)["openAtLogin"], false)
        XCTAssertNil(SettingsMigration.currentGeneral(loginStatus: .notFound, showInDock: false, keepAwake: true)["openAtLogin"])
    }

    func testPendingLoginApprovalPreservesTheSavedRequestWithoutOverridingAnOptOut() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "settings-pending-login-\(UUID().uuidString)"))
        defaults.set(false, forKey: "openAtLoginOff") // enabled by the person, system approval still pending
        let unowned = CompanionSettings(general: .init())
        XCTAssertEqual(SettingsMigration.patch(defaults: defaults, companion: unowned, currentGeneral: ["openAtLogin": false])["general"], .object(["openAtLogin": .bool(true)]))
        let optedOut = CompanionSettings(general: .init(openAtLogin: false))
        XCTAssertNil(SettingsMigration.patch(defaults: defaults, companion: optedOut, currentGeneral: ["openAtLogin": false])["general"])
    }

    func testThisMacsOwnChoicesGoUpTheFirstTime() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "kan220-migrate-\(UUID().uuidString)"))
        let keeps = CompanionSettings(milestones: "50", notificationsMac: ["pass.ready": true], general: .init(openAtLogin: true, showInDock: true, keepAwake: true))
        XCTAssertTrue(SettingsMigration.patch(defaults: defaults, companion: keeps).isEmpty, "nothing changed here: nothing to carry over")
        defaults.set(true, forKey: "openAtLoginOff")
        defaults.set(false, forKey: "showInDock")
        NotificationPrefs(defaults: defaults).set(.ready, false)
        NotificationPrefs(defaults: defaults).progress = .quarters
        let patch = SettingsMigration.patch(defaults: defaults, companion: keeps)
        XCTAssertEqual(patch["general"], .object(["openAtLogin": .bool(false), "showInDock": .bool(false)]))
        XCTAssertEqual(patch["notifications"], .object(["mac": .object(["pass.ready": .bool(false), "print.milestone": .bool(true)])]))
        defaults.set(["pass.ready": true], forKey: NotificationPrefs.typesKey)
        let optedOut = CompanionSettings(milestones: "50", notificationsMac: ["pass.ready": false])
        XCTAssertEqual(SettingsMigration.patch(defaults: defaults, companion: optedOut)["notifications"], .object(["mac": .object(["print.milestone": .bool(true)])]))
        XCTAssertTrue(SettingsMigration.patch(defaults: defaults, companion: CompanionSettings(milestones: "50")).isEmpty,
                      "an older companion that keeps neither gets nothing")
    }
    @MainActor func testPhoneFusionClaimsOnceWithoutBlockingEventReader() async throws {
        var claims = 0, installs = 0, reports = 0
        var finish: CheckedContinuation<(Bool, String?), Never>?
        let started = expectation(description: "Setup started")
        let completed = expectation(description: "Completion sent")
        let bridge = PhoneFusionSetup(report: { reports += 1 }, claim: { _ in claims += 1; return "request-one" }, install: {
            installs += 1
            return await withCheckedContinuation { finish = $0; started.fulfill() }
        }, complete: { id, ok, message in
            XCTAssertEqual(id, "request-one"); XCTAssertTrue(ok); XCTAssertNil(message)
            completed.fulfill()
        })
        await bridge.refresh()
        await fulfillment(of: [started], timeout: 2)
        await bridge.refresh()
        XCTAssertEqual(claims, 1); XCTAssertEqual(installs, 1); XCTAssertEqual(reports, 2)
        finish?.resume(returning: (true, nil))
        await fulfillment(of: [completed], timeout: 2)
    }

    @MainActor func testNoClaimNeverRunsFusionAndPrivateDiagnosticsStayOnMac() async {
        var installs = 0
        let bridge = PhoneFusionSetup(report: {}, claim: { _ in nil }, install: { installs += 1; return (true, nil) }, complete: { _, _, _ in XCTFail("No request") })
        await bridge.refresh()
        XCTAssertEqual(installs, 0)
        XCTAssertFalse(FusionSetup.Status.unreachable("PRIVATE_TOKEN /private/path").phoneMessage?.contains("PRIVATE") ?? true)
        XCTAssertFalse(FusionSetup.Status.notConnected("PRIVATE_TOKEN").phoneMessage?.contains("PRIVATE") ?? true)
    }

    @MainActor func testPhoneFusionRetriesLostCompletionWithoutReinstalling() async {
        var attempts = 0, installs = 0, claims = 0
        let first = expectation(description: "Completion transport failed")
        let bridge = PhoneFusionSetup(report: {}, claim: { _ in claims += 1; return claims == 1 ? "request" : nil }, install: {
            installs += 1; return (true, nil)
        }, complete: { id, ok, _ in
            XCTAssertEqual(id, "request"); XCTAssertTrue(ok)
            attempts += 1
            if attempts == 1 { first.fulfill(); throw URLError(.cannotConnectToHost) }
        })
        await bridge.refresh()
        await fulfillment(of: [first], timeout: 2)
        await bridge.refresh()
        XCTAssertEqual(attempts, 2, "The saved result must be retried after a transient socket failure")
        XCTAssertEqual(installs, 1); XCTAssertEqual(claims, 1)
        await bridge.refresh()
        XCTAssertEqual(attempts, 2, "An acknowledged completion is not sent again")
    }

    @MainActor func testPhoneFusionDropsOnlyExplicitlyStaleCompletion() async throws {
        var attempts = 0, installs = 0, claims = 0
        let first = expectation(description: "Completion rejected as stale")
        let conflict = try JSONDecoder().decode(ControlRemoteError.self, from: Data(#"{"code":"conflict","message":"Stale request"}"#.utf8))
        let bridge = PhoneFusionSetup(report: {}, claim: { _ in claims += 1; return claims == 1 ? "old-request" : nil }, install: {
            installs += 1; return (true, nil)
        }, complete: { _, _, _ in attempts += 1; first.fulfill(); throw conflict })
        await bridge.refresh()
        await fulfillment(of: [first], timeout: 2)
        await bridge.refresh()
        XCTAssertEqual(attempts, 1); XCTAssertEqual(installs, 1)
        XCTAssertEqual(claims, 2, "A stale completion does not block future request claims")
    }

    @MainActor func testPhoneFusionRetriesClaimWithOneInstanceIdentity() async {
        var owners: [String] = [], installs = 0
        let completed = expectation(description: "Recovered claim completes")
        let bridge = PhoneFusionSetup(report: {}, claim: { owner in
            owners.append(owner)
            if owners.count == 1 { throw URLError(.networkConnectionLost) }
            return "recovered-request"
        }, install: { installs += 1; return (true, nil) }, complete: { id, _, _ in
            XCTAssertEqual(id, "recovered-request"); completed.fulfill()
        })
        await bridge.refresh()
        XCTAssertEqual(installs, 0)
        await bridge.refresh()
        await fulfillment(of: [completed], timeout: 2)
        XCTAssertEqual(owners.count, 2); XCTAssertEqual(Set(owners).count, 1)
        XCTAssertNotNil(UUID(uuidString: owners[0])); XCTAssertEqual(installs, 1)
    }

}
