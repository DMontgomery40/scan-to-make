import Foundation

/// The printer MCP's connection choices, as reported by `counterpart_print_route` on either backend.
public struct PrinterPrintRoute: Decodable, Equatable, Sendable {
    public struct Option: Decodable, Equatable, Identifiable, Sendable {
        public let id: String
        public let label: String
        public let available: Bool
        public let reason: String?
        public let controls: String?
    }
    public let route: String
    public let mode: String
    public let type: String
    public let choices: [String]
    public let options: [Option]?

    /// Older MCPs report only ids; newer ones supply their own labels and availability.
    public func label(_ id: String) -> String {
        if let option = options?.first(where: { $0.id == id }) { return option.label }
        switch id { case "lan": return "Local network"; case "cloud": return "Bambu Cloud"; case "developer": return "Local network, Developer Mode"; default: return id }
    }
    public func available(_ id: String) -> Bool { options?.first(where: { $0.id == id })?.available ?? true }
}

public struct PrinterMCPSelection: Decodable, Sendable {
    public let destinationId: String
    public let destinations: [PrinterDestination]
    public let defaultDestinationId: String
    public var catalog: PrinterCatalog { PrinterCatalog(destinations: destinations, defaultDestinationId: defaultDestinationId) }
}

public extension CompanionClient {
    /// Reads or changes the same MCP-owned connection as Mac Settings; no second copy is kept on the phone.
    func printerPrintRoute(_ destinationId: String, route: String? = nil) async throws -> PrinterPrintRoute? {
        struct Reply: Decodable { let route: PrinterPrintRoute? }
        guard Pattern("[A-Za-z0-9_-]{1,256}").matches(destinationId), route.map({ Pattern("[a-z][a-z0-9_-]{0,31}").matches($0) }) ?? true else {
            throw CompanionError(code: "invalid-request", message: "That printer connection isn't valid.")
        }
        let reply = try await request(route == nil ? "GET" : "POST", "/v1/objects/printers/\(destinationId)/route",
                                      json: route.map { ["route": $0] }, as: Reply.self, timeout: 35)
        return reply.route
    }

    /// Changes the existing preference for a printer available through both installed MCPs.
    func choosePrinterMcp(_ destinationId: String, backend: String) async throws -> PrinterMCPSelection {
        guard Pattern("[A-Za-z0-9_-]{1,256}").matches(destinationId), ["bambu-printer-mcp", "mcp-3d-printer-server"].contains(backend) else {
            throw CompanionError(code: "invalid-request", message: "That printer MCP isn't valid.")
        }
        return try await request("POST", "/v1/objects/printers/\(destinationId)/mcp", json: ["backend": backend], as: PrinterMCPSelection.self, timeout: 40)
    }
}
