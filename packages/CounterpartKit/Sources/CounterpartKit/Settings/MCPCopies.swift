import Foundation

/// The companion's on-disk copies and every effective printer profile, including non-selected MCPs.
public struct MCPPackageCopies: Decodable, Sendable, Identifiable {
    public struct Copy: Decodable, Sendable { public let version: String? }
    public struct Usage: Decodable, Sendable, Identifiable {
        public let destinationId: String
        public let printerId: String
        public let printer: String
        public let mcpId: String
        public let kind: String
        public let path: String?
        public let version: String?
        public let canMove: Bool
        public var id: String { destinationId }
        public var words: String {
            let source = kind == "app" ? "Counterpart’s copy" : "your copy" + (path.map { " at " + $0 } ?? "")
            return "\(printer) uses \(source) (\(version ?? "version unknown"))."
        }
    }
    public let package: String
    public let label: String
    public let appMcpId: String
    public let appCopy: Copy?
    public let uses: [Usage]
    public var id: String { package }
    public var moveIDs: [String] { Array(Set(uses.filter(\.canMove).map(\.mcpId))).sorted() }
    public func moveTitle(_ id: String) -> String {
        "Move " + Array(Set(uses.filter { $0.mcpId == id }.map(\.printer))).sorted().joined(separator: ", ") + " to Counterpart’s updated copy"
    }
}
