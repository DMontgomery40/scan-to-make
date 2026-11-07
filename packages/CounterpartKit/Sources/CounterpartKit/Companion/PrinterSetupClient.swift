import Foundation

/// Add printer… on the iPhone and iPad: the Mac's own `printers.discover`, `.check`, `.obtain`, and `.add`,
/// over `/v1/printers/setup/*` (objects-api.md). The companion and the MCPs do the work; the phone sends the form.
public extension CompanionClient {
    /// Printers the MCPs found, and every MCP's setup fields. The companion gives discovery 15 s.
    func discoverPrinters() async throws -> PrinterDiscovery {
        try await setupCall("discover", body: [String: String](), as: PrinterDiscovery.self, timeout: 25)
    }

    /// Asks the printer through its MCP for its status (and a camera picture where it has one). Never prints.
    func checkPrinter(_ form: PrinterForm) async throws -> PrinterCheckResult {
        struct Reply: Decodable { let check: PrinterCheckResult }
        return try await setupCall("check", body: ["printer": form], as: Reply.self, timeout: 70).check
    }

    func addPrinter(_ form: PrinterForm) async throws -> PrinterAdded {
        try await setupCall("add", body: ["printer": form], as: PrinterAdded.self, timeout: 40)
    }

    /// One `printers.obtain` step: starts without `session`; with it, waits about 20 s for the person's answer.
    func obtainSetupValue(_ form: PrinterForm, field: String, session: String? = nil) async throws -> ObtainStep {
        var body = ["backend": form.backend, "printerType": form.printerType, "host": form.host.trimmingCharacters(in: .whitespaces), "field": field]
        if let port = form.port, !port.isEmpty { body["port"] = port }
        if let session { body["session"] = session }
        return try await setupCall("obtain", body: body, as: ObtainStep.self, timeout: 70)
    }


    private func setupCall<Body: Encodable, T: Decodable>(_ method: String, body: Body, as type: T.Type, timeout: TimeInterval) async throws -> T {
        let path = "/v1/printers/setup/" + method
        let data = try JSONEncoder().encode(body)
        guard data.count <= 16 * 1024 else { throw CompanionError.transport("invalid-request") }
        return try Self.decode(try await send("POST", path, body: data, timeout: timeout), path: path, as: type)
    }
}
