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
        let selected = try await mac.choosePrinterMcp("current", backend: "mcp-3d-printer-server")
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
