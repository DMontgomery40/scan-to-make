import XCTest
@testable import CounterpartKit

final class PrinterSettingsClientTests: XCTestCase {
    func testPrinterSettingsUseExistingPrintAndSettingsPermissions() {
        XCTAssertEqual(CompanionClient.scope("GET", "/v1/objects/printers/current/route"), "printer-handoff:use")
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/objects/printers/current/route"), "printer-handoff:use")
        XCTAssertEqual(CompanionClient.scope("POST", "/v1/objects/printers/current/mcp"), "projects:write")
        XCTAssertNil(CompanionClient.scope("GET", "/v1/objects/printers/current/mcp"))
        XCTAssertNil(CompanionClient.scope("DELETE", "/v1/objects/printers/current/route"))
    }

    private func client(_ transport: FakeTransport) throws -> CompanionClient {
        let store = PairingStore(store: MemoryStore(), defaults: UserDefaults(suiteName: UUID().uuidString)!)
        try store.save(v2Record(), notify: false)
        return CompanionClient(pairing: PairingClient(store: store, transport: transport), transport: transport)
    }

    func testMcpReportedConnectionsAndCanonicalMcpSwitchReachThePhone() async throws {
        let fake = FakeTransport { request, _ in
            if request.url?.path.hasSuffix("/mcp") == true {
                return json(200, ["destinationId": "generic", "defaultDestinationId": "generic", "destinations": [["id": "generic", "name": "P1S", "backend": "mcp-3d-printer-server", "source": "mcp-profile"]]])
            }
            return json(200, ["route": ["route": "cloud", "mode": "bambu_network", "type": "cloud", "choices": ["lan", "cloud", "new-route"],
                "options": [["id": "new-route", "label": "A connection from the MCP", "available": false, "reason": "Set it up on your Mac."]]]])
        }
        let mac = try client(fake)
        let reported = try await mac.printerPrintRoute("current", route: "cloud")
        let route = try XCTUnwrap(reported)
        XCTAssertEqual(route.label("new-route"), "A connection from the MCP")
        XCTAssertFalse(route.available("new-route"))
        XCTAssertEqual(route.label("lan"), "Local network", "older MCP choices remain readable")
        let selected = try await mac.choosePrinterMcpWithCatalog("current", backend: "mcp-3d-printer-server")
        XCTAssertEqual(selected.catalog.destination(selected.destinationId)?.backend, "mcp-3d-printer-server")
        XCTAssertEqual(fake.calls.map { $0.request.httpMethod }, ["POST", "POST"])
        let bodies = try fake.calls.map { try JSONSerialization.jsonObject(with: XCTUnwrap($0.request.httpBody)) as? [String: String] }
        XCTAssertEqual(bodies, [["route": "cloud"], ["backend": "mcp-3d-printer-server"]])
    }

    func testPrinterSettingsRejectPathInjectionAndKeepTheMacRefusal() async throws {
        let fake = FakeTransport { _, _ in json(409, ["error": ["code": "invalid-state", "message": "This printer is printing. Change it when the print finishes."]]) }
        let mac = try client(fake)
        for id in ["../current", "current/route", ""] {
            do { _ = try await mac.printerPrintRoute(id); XCTFail("unsafe id") } catch let error as CompanionError { XCTAssertEqual(error.code, "invalid-request") }
        }
        do { _ = try await mac.printerPrintRoute("current", route: "../cloud"); XCTFail() } catch let error as CompanionError { XCTAssertEqual(error.code, "invalid-request") }
        XCTAssertTrue(fake.calls.isEmpty)
        do { _ = try await mac.printerPrintRoute("current", route: "cloud"); XCTFail() }
        catch let error as CompanionError { XCTAssertEqual(error.message, "This printer is printing. Change it when the print finishes.") }
    }
}

/// Add Printer on the iPhone and iPad (PRD §6.1): the companion's own answers (the same fixture its route test and Android
/// read), the Mac's wire form, and the permissions the Mac's settings routes use.
final class PrinterSetupClientTests: XCTestCase {
    private func client(_ transport: FakeTransport) throws -> CompanionClient {
        let store = PairingStore(store: MemoryStore(), defaults: UserDefaults(suiteName: UUID().uuidString)!)
        try store.save(v2Record(), notify: false)
        return CompanionClient(pairing: PairingClient(store: store, transport: transport), transport: transport)
    }

    func testDiscoveryCheckObtainAndAddGoThroughTheCompanionsSetupCalls() async throws {
        let answers = try JSONSerialization.jsonObject(with: Data(contentsOf: repoRoot.appending(path: "packages/contracts/fixtures/printer-setup-phone.json"))) as! [String: Any]
        let fake = FakeTransport { request, _ in
            let body = try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
            switch request.url!.path {
            case "/v1/printers/setup/discover": return json(200, answers["discover"]!)
            case "/v1/printers/setup/check": return json(200, answers["check"]!)
            case "/v1/printers/setup/obtain": return json(200, answers[body?["session"] == nil ? "obtainPending" : "obtainApproved"]!)
            case "/v1/printers/setup/add": return json(200, answers["add"]!)
            default: return json(404, ["error": ["code": "not-found"]])
            }
        }
        let mac = try client(fake)
        let found = try await mac.discoverPrinters()
        let p1s = try XCTUnwrap(found.found.first { $0.serial == "01P00A451601106" })
        let bambu = try XCTUnwrap(found.options.types.first { $0.printerType == p1s.printerType })
        XCTAssertEqual(bambu.secret?.label, "Access code", "the MCP's own words")
        XCTAssertEqual(bambu.field("serial")?.hint, "On the printer: Settings → Device")
        XCTAssertEqual(found.options.model(forSerial: "01P00A451601106"), "p1s", "the MCP's serial table")
        var form = PrinterForm()
        form.printerType = p1s.printerType; form.backend = p1s.backend; form.host = p1s.host!; form.serial = p1s.serial!; form.model = p1s.model; form.secret = "12345678"
        let checked = try await mac.checkPrinter(form)
        XCTAssertTrue(checked.reached)
        let added = try await mac.addPrinter(form)
        XCTAssertEqual(added.destinationId, "profile-p-9f2c4e")
        var octo = PrinterForm(); octo.printerType = "octoprint"; octo.backend = "mcp-3d-printer-server"; octo.host = "octopi.local"; octo.port = "80"
        let obtain = try XCTUnwrap(ObtainControl(options: found.options, form: octo))
        XCTAssertEqual(obtain.label, "Approve in OctoPrint")
        let last = try await obtainSetupValue(octo, field: obtain.field, step: { try await mac.obtainSetupValue($0, field: $1, session: $2) }, shown: { _ in })
        XCTAssertEqual(last.value, "OCTO-KEY-FROM-APPROVAL")
        let bodies = try fake.calls.map { try JSONSerialization.jsonObject(with: $0.request.httpBody ?? Data("{}".utf8)) as! [String: Any] }
        XCTAssertEqual(bodies[1]["printer"] as? [String: String], ["backend": "bambu-printer-mcp", "printerType": "bambu", "host": "192.168.1.42",
                                                                   "serial": "01P00A451601106", "model": "p1s", "secret": "12345678"], "the Mac's PrinterFormSchema form")
        XCTAssertEqual(bodies[4]["session"] as? String, "0b6b8a52-6f1e-4c5a-9d43-4c1c3f6a2e10")
        for path in ["discover", "check", "obtain", "add"] {
            XCTAssertEqual(CompanionClient.scope("POST", "/v1/printers/setup/" + path), "projects:write")
            XCTAssertNil(CompanionClient.scope("GET", "/v1/printers/setup/" + path))
        }
        XCTAssertNil(CompanionClient.scope("POST", "/v1/printers/setup/install"))
    }
}
