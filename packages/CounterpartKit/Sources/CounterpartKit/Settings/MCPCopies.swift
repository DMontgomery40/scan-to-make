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
        /// It runs Counterpart's own copy (a companion from before Nov 6 doesn't say: its `canMove` does).
        public let managed: Bool?
        /// The companion's sentence: which copy, its version, and whether it's older than Counterpart's.
        let sentence: String?
        public var id: String { destinationId }
        enum CodingKeys: String, CodingKey { case destinationId, printerId, printer, mcpId, kind, path, version, canMove, managed, sentence = "words" }
        public var words: String {
            if let sentence { return sentence }
            let source = managed ?? !canMove ? "Counterpart’s copy" : kind == "app" ? "Counterpart’s older copy" + (path.map { " at " + $0 } ?? "") : "your copy" + (path.map { " at " + $0 } ?? "")
            return "\(printer) uses \(source) (\(version ?? "version unknown"))."
        }
    }
    /// One Move to Counterpart's updated copy, named by its printers, MCP and the copy they leave.
    public struct Move: Decodable, Sendable, Equatable { public let mcpId: String; public let title: String }
    public let package: String
    public let label: String
    public let appMcpId: String
    public let appCopy: Copy?
    public let uses: [Usage]
    let listedMoves: [Move]?
    public var id: String { package }
    enum CodingKeys: String, CodingKey { case package, label, appMcpId, appCopy, uses, listedMoves = "moves" }

    /// The Moves in the order their printers are listed (never by id), each with a title that tells it from the others.
    public var moves: [Move] {
        if let listedMoves { return listedMoves }
        var seen = Set<String>()
        return uses.filter { $0.canMove && seen.insert($0.mcpId).inserted }.map { first in
            let printers = uses.filter { $0.mcpId == first.mcpId }.map(\.printer).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
            let from = first.kind == "app" ? "Counterpart’s older copy" + (first.path.map { " at " + $0 } ?? "") : first.path.map { "your copy at " + $0 } ?? "your copy"
            return Move(mcpId: first.mcpId, title: "Move \(printers.joined(separator: ", ")) (\(label), \(from)) to Counterpart’s updated copy")
        }
    }
    public var moveIDs: [String] { moves.map(\.mcpId) }
    public func moveTitle(_ id: String) -> String { moves.first { $0.mcpId == id }?.title ?? "Move to Counterpart’s updated copy" }
}
