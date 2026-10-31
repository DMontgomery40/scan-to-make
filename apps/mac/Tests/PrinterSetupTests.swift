import XCTest
@testable import AgentKit

private struct PrinterCredentials: PrinterCredentialStore {
    let saved: PrinterCredential
    func read(_ reference: UUID) throws -> PrinterCredential { saved }
}
final class PrinterSetupTests: XCTestCase {
    private func choice() -> PrinterSetupChoice {
        PrinterSetupChoice(kind: .bambu, printer_host: "192.168.1.4", bambu_serial: "EXAMPLE123", bambu_model: "p1s", keychainRef: UUID(), connection_mode: "lan_mqtt_ftps")
    }
    func testRejectsDestinationAndEnvironmentOverrides() throws {
        let saved = choice(), store = PrinterCredentials(saved: try PrinterCredential(choice: saved, secret: "fixture-code"))
        let env = try PrinterWorkerEnvironment.make(choice: saved, base: [:], credentials: store)
        XCTAssertEqual(env["BAMBU_TOKEN"], "fixture-code"); XCTAssertEqual(env["PRINTER_HOST"], saved.printer_host)
        var attacks = [PrinterSetupChoice]()
        var changed = saved; changed.printer_host = "attacker.example"; attacks.append(changed)
        changed = saved; changed.bambu_serial = "OTHER"; attacks.append(changed)
        changed = saved; changed.bambu_model = "p1p"; attacks.append(changed)
        changed = saved; changed.connection_mode = "bambu_connect"; attacks.append(changed)
        changed = saved; changed.slicer_path = "/evil"; attacks.append(changed)
        changed = saved; changed.blender_mcp_command = "/evil"; attacks.append(changed)
        changed = saved; changed.keychainRef = UUID(); attacks.append(changed)
        attacks.append(PrinterSetupChoice(kind: .other, printer_host: saved.printer_host, printer_type: "octoprint", keychainRef: saved.keychainRef))
        for item in attacks { XCTAssertThrowsError(try PrinterWorkerEnvironment.make(choice: item, base: [:], credentials: store)) }
        for key in ["PATH","HOME","NODE_OPTIONS","PRINTER_HOST","STM_PRINTER_SERVER","BAMBU_NETWORK_BRIDGE_COMMAND"] {
            XCTAssertThrowsError(try PrinterWorkerEnvironment.make(choice: saved, base: [key: "attacker"], credentials: store))
        }
        XCTAssertFalse(String(describing: store.saved).contains("fixture-code"))
    }
    func testCopyRetainsDestinationAndBindsNewSettings() throws {
        let old = choice(), credential = try PrinterCredential(choice: old, secret: "fixture-code")
        var next = old; next.keychainRef = UUID(); next.connection_mode = "bambu_connect"; next.slicer_path = "/Applications/Slicer.app/Contents/MacOS/slicer"
        let copied = try credential.copied(from: old, to: next)
        XCTAssertEqual(try PrinterWorkerEnvironment.make(choice: next, base: [:], credentials: PrinterCredentials(saved: copied))["BAMBU_TOKEN"], "fixture-code")
        XCTAssertThrowsError(try credential.copied(from: old, to: old))
        next.printer_host = "attacker.example"
        XCTAssertThrowsError(try credential.copied(from: old, to: next))
    }
    func testOtherPrinterBindingIncludesPortAndType() throws {
        let saved = PrinterSetupChoice(kind: .other, printer_host: "printer.local", printer_type: "klipper", printer_port: "7125", keychainRef: UUID())
        let store = PrinterCredentials(saved: try PrinterCredential(choice: saved, secret: "fixture-code"))
        var changed = saved; changed.printer_port = "80"
        XCTAssertThrowsError(try PrinterWorkerEnvironment.make(choice: changed, base: [:], credentials: store))
        changed = saved; changed.printer_type = "octoprint"
        XCTAssertThrowsError(try PrinterWorkerEnvironment.make(choice: changed, base: [:], credentials: store))
    }
    func testOtherSlicerIsBoundAndForwarded() throws {
        let saved = PrinterSetupChoice(kind: .other, printer_host: "printer.local", printer_type: "klipper", keychainRef: UUID(), slicer_path: "/Applications/PrusaSlicer.app/Contents/MacOS/PrusaSlicer", slicer_type: "prusaslicer")
        let store = PrinterCredentials(saved: try PrinterCredential(choice: saved, secret: "fixture-code"))
        let env = try PrinterWorkerEnvironment.make(choice: saved, base: [:], credentials: store)
        XCTAssertEqual(env["SLICER_PATH"], saved.slicer_path); XCTAssertEqual(env["SLICER_TYPE"], "prusaslicer")
        var changed = saved; changed.slicer_type = "cura"
        XCTAssertThrowsError(try PrinterWorkerEnvironment.make(choice: changed, base: [:], credentials: store))
        changed = saved; changed.slicer_path = "/evil"
        XCTAssertThrowsError(try PrinterWorkerEnvironment.make(choice: changed, base: [:], credentials: store))
    }
    func testSharedChoiceValidation() throws {
        struct Fixture: Decodable { let choice: PrinterSetupChoice; let valid: Bool }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: root.appendingPathComponent("packages/contracts/fixtures/printer-setup.json")))
        for fixture in fixtures {
            if fixture.valid { XCTAssertNoThrow(try fixture.choice.validate()) }
            else { XCTAssertThrowsError(try fixture.choice.validate()) }
        }
    }
    func testRealKeychainBindingIsImmutable() throws {
        guard ProcessInfo.processInfo.environment["STM_TEST_KEYCHAIN"] == "1" else { throw XCTSkip("Opt-in GUI login session check") }
        let value = choice(), keychain = PrinterKeychain(); defer { try? keychain.remove(value.keychainRef!) }
        try keychain.save("fixture-code", for: value)
        XCTAssertThrowsError(try keychain.save("replacement", for: value))
        XCTAssertEqual(try PrinterWorkerEnvironment.make(choice: value, base: [:], credentials: keychain)["BAMBU_TOKEN"], "fixture-code")
    }
}
