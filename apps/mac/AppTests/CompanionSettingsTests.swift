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
        XCTAssertEqual(MacNotificationTypes.ordered.count, 16)
        XCTAssertEqual(MacNotificationTypes.ordered.first?.type, "pass.ready")
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
        XCTAssertTrue(SettingsMigration.patch(defaults: defaults, companion: CompanionSettings(milestones: "50")).isEmpty,
                      "an older companion that keeps neither gets nothing")
    }
}
