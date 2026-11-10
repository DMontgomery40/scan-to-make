import XCTest
@testable import CounterpartKit

/// Every Mac setting on the phone (PRD §5.9, docs/protocols/settings.md), the Mac's printer MCP updates
/// (PRD §8.10) and the phone's name on requests.
final class SettingsTests: XCTestCase {
    let full = #"""
    {"settings":{"milestones":"25-50-75",
      "notifications":{"mac":{"pass.ready":true,"print.milestone":false,"print.teleported":true},"devices":{"dev-1":{"print.started":false}}},
      "general":{"openAtLogin":true,"showInDock":false,"keepAwake":true},
      "ai":{"revision":"r1","choice":{"kind":"claude-code"},"check":{"id":"c","revision":"r1","state":"failed","outcome":"needs-gui-session"}},
      "fusion":{"state":"not-set-up","message":"Not set up. Set Up installs the Fusion add-in."},
      "cad":{"state":"ready","message":"Ready. New designs and scan cleanups use it.","server":"bambu-printer-mcp","canSetUp":true,"result":{"ok":true,"message":"CAD is ready."}},
      "somethingNew":{"x":1}}}
    """#

    func testEverySettingDecodesAndAnOlderMacStillReads() throws {
        struct Reply: Decodable { var settings: CompanionSettings }
        let s = try JSONDecoder().decode(Reply.self, from: Data(full.utf8)).settings
        XCTAssertTrue(s.isFull)
        XCTAssertEqual(s.milestones, "25-50-75")
        XCTAssertFalse(s.phoneNotifies("print.started", deviceId: "dev-1"))
        XCTAssertTrue(s.phoneNotifies("pass.ready", deviceId: "dev-1"), "not stored: the phone default (on)")
        XCTAssertFalse(s.macNotifies("print.milestone"))
        XCTAssertFalse(s.macNotifies("print.cancelled"), "not stored: the Mac default (off)")
        XCTAssertEqual(s.general?["showInDock"], false)
        XCTAssertEqual(s.ai?.check?.outcome, "needs-gui-session")
        XCTAssertEqual(s.fusion?.state, "not-set-up")
        XCTAssertEqual(s.cad?.state, "ready")
        XCTAssertEqual(s.cad?.result, CodeEngineStatus.Result(ok: true, message: "CAD is ready."))
        XCTAssertEqual(s.cad?.server, "bambu-printer-mcp")
        let older = try JSONDecoder().decode(Reply.self, from: Data(#"{"settings":{"milestones":"50"}}"#.utf8)).settings
        XCTAssertFalse(older.isFull, "an older Mac serves only milestones")
        XCTAssertTrue(SettingsSchema.defaultValue("print.new-thing", mac: false), "an unknown type is on for the phone")
        XCTAssertFalse(SettingsSchema.defaultValue("print.new-thing", mac: true), "and off for the Mac")
    }

    func testPatchesNameOnlyWhatChanges() throws {
        func json(_ patch: [String: Any]) throws -> String {
            String(data: try JSONSerialization.data(withJSONObject: patch, options: .sortedKeys), encoding: .utf8)!
        }
        XCTAssertEqual(try json(SettingsPatch.phoneNotification("print.done", false, deviceId: "dev-1")), #"{"notifications":{"devices":{"dev-1":{"print.done":false}}}}"#)
        XCTAssertEqual(try json(SettingsPatch.macNotification("pass.ready", true)), #"{"notifications":{"mac":{"pass.ready":true}}}"#)
        XCTAssertEqual(try json(SettingsPatch.general("keepAwake", false)), #"{"general":{"keepAwake":false}}"#)
        XCTAssertEqual(try json(SettingsPatch.ai(kind: "codex-cli", expectedRevision: "r1")), #"{"ai":{"choice":{"kind":"codex-cli"},"expectedRevision":"r1"}}"#)
        XCTAssertEqual(SettingsSchema.aiKinds.filter(\.fromPhone).map(\.kind), ["none", "claude-code", "codex-cli"])
        XCTAssertEqual(SettingsSchema.notificationTypes.count, 16)
        XCTAssertFalse(SettingsSchema.notificationTypes.contains { $0.id == "plate.blocked" })
    }

    func testDevicesAndMCPUpdates() throws {
        struct Devices: Decodable { var devices: [CompanionDevice] }
        let devices = try JSONDecoder().decode(Devices.self, from: Data(#"{"devices":[{"deviceId":"a","deviceName":"David's iPhone","current":true,"scopes":["projects:read"]},{"deviceId":"b","legacy":true}]}"#.utf8)).devices
        XCTAssertEqual(devices.map(\.deviceId), ["a", "b"])
        XCTAssertEqual(devices[1].legacy, true)
        let destination = try JSONDecoder().decode(PrinterDestination.self, from: Data(#"{"id":"current","name":"P1S","backend":"bambu-printer-mcp","source":"current","mcpId":"m1","capabilities":{"progress":true,"layers":true,"camera":"bambu-tcp","filaments":"ams","pause":true,"resume":true,"cancel":true,"quality":true,"strength":true,"server":{"name":"bambu-printer-mcp","version":"1.4.2"},"update":{"message":"Update bambu-printer-mcp.","latestVersion":"1.5.0"}}}"#.utf8))
        XCTAssertEqual(destination.mcpId, "m1")
        XCTAssertEqual(destination.updateWords, "1.4.2 → 1.5.0")
        XCTAssertTrue(PrinterDestination.isOlder("1.4.9", than: "1.4.10"))
        XCTAssertFalse(PrinterDestination.isOlder("1.5.0", than: "1.5"))
        var current = destination
        current.capabilities?.update?.latestVersion = "1.4.2"
        XCTAssertNil(current.updateWords, "Update shows only when the installed version is behind")
        let update = try JSONDecoder().decode(MCPUpdate.self, from: Data(#"{"mcpId":"m1","state":"unresolved","found":"a git checkout"}"#.utf8))
        XCTAssertEqual(update.found, "a git checkout")
    }

    func testTheRoutesNeedTheirScopes() {
        XCTAssertEqual(CompanionClient.scope("GET", "/v1/devices"), "projects:read")
        XCTAssertEqual(CompanionClient.scope("DELETE", "/v1/devices/6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"), "projects:write")
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/settings/ai/test"), "projects:write")
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/settings/fusion/setup"), "projects:write")
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/settings/cad/setup"), "projects:write")
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/printers/mcp/m1/update"), "projects:write")
        XCTAssertEqual(CompanionClient.scope("GET", "/v1/objects/printers/current/route"), "printer-handoff:use")
        XCTAssertEqual(CompanionClient.scope("PUT", "/v1/objects/printers/current/route"), "projects:write")
        XCTAssertEqual(CompanionClient.scope("PUT", "/v1/objects/printers/mcp-1a2b/mcp"), "projects:write")
        XCTAssertNil(CompanionClient.scope("GET", "/v1/objects/printers/current/mcp"))
    }

    func testTheDeviceNameIsEncodedAsEncodeURIComponentDoes() {
        XCTAssertEqual(CompanionClient.encodeURIComponent("David’s iPhone"), "David%E2%80%99s%20iPhone")
        XCTAssertEqual(CompanionClient.encodeURIComponent("Kid's iPad (2)"), "Kid's%20iPad%20(2)")
    }
}
