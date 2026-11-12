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
    /// One Move to Counterpart's updated copy, named by its printers, MCP and the copy they leave. #775's companion
    /// adds `printers` (each once), `words` (the row's one line) and `reason` (why it isn't kept current, Q9).
    public struct Move: Decodable, Sendable, Equatable {
        public let mcpId: String; public let title: String
        public var printers: [String]? = nil; public var words: String? = nil; public var reason: String? = nil
    }
    public let package: String
    public let label: String
    public let appMcpId: String
    public let appCopy: Copy?
    public let uses: [Usage]
    let listedMoves: [Move]?
    /// The copy Check and Add run (Counterpart's when it has one).
    public let version: String?
    /// #775: the printers that use it, each once; a newer published version Update installs; npm said nothing is newer.
    /// A companion from before #775 sends none of them.
    let usedBy: [String]?
    let available: String?
    let upToDate: Bool?
    public var id: String { package }
    enum CodingKeys: String, CodingKey { case package, label, appMcpId, appCopy, uses, version, usedBy, available, upToDate, listedMoves = "moves" }

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

    /// Settings → Printer software's row (#775), from the companion's fields. `printerId` narrows it to one printer's page.
    public func row(printerId: String? = nil) -> PrinterSoftwareRow {
        let mine = moves.filter { move in printerId == nil || uses.contains { $0.printerId == printerId && $0.mcpId == move.mcpId } }
        let others = mine.map { move -> PrinterSoftwareRow.Other in
            let on = uses.filter { $0.mcpId == move.mcpId }
            let printers = move.printers ?? PrinterSoftwareRow.once(on.map { ($0.printerId, $0.printer) })
            let words = move.words ?? on.first.map { PrinterSoftwareRow.otherCopy(printers, earlier: $0.kind == "app", version: $0.version) } ?? move.title
            return PrinterSoftwareRow.Other(mcpId: move.mcpId, label: label, printers: printers, words: words, reason: move.reason)
        }
        return PrinterSoftwareRow(name: label, version: appCopy?.version ?? version,
                                  status: available.flatMap { appCopy == nil ? nil : .available($0) } ?? (upToDate == true ? .upToDate : nil),
                                  update: available != nil && appCopy != nil ? appMcpId : nil,
                                  usedBy: PrinterSoftwareRow.usedBy(usedBy ?? PrinterSoftwareRow.once(uses.map { ($0.printerId, $0.printer) })),
                                  others: others)
    }
}

/// One printer MCP in Settings → Printer software (#775), the same on iPhone, iPad and Mac: its name and version, "Up to date"
/// or "<version> available" with one Update, the printers that use it (each once), and, only when a printer runs another
/// copy, one line and one "Use Counterpart’s" for it. No "Counterpart’s copy" on the usual path.
public struct PrinterSoftwareRow: Equatable, Sendable {
    public enum Status: Equatable, Sendable {
        case upToDate, available(String)
        public var words: String { switch self { case .upToDate: "Up to date"; case .available(let version): "\(version) available" } }
    }
    public struct Other: Equatable, Sendable {
        public let mcpId: String
        let label: String
        public let printers: [String]
        /// "P1S runs your own copy (1.1.80)".
        public let words: String
        let reason: String?
        public var button: String { "Use Counterpart’s" }
        /// Two printers' buttons never read the same: each names its MCP, printers and copy.
        public var accessibilityLabel: String {
            let copy = words.hasPrefix(PrinterSoftwareRow.listed(printers) + " ") ? String(words.dropFirst(PrinterSoftwareRow.listed(printers).count + 1)).replacingOccurrences(of: #"^runs? "#, with: "", options: .regularExpression) : words
            return "Use Counterpart’s \(label) for \(PrinterSoftwareRow.listed(printers)) instead of \(copy)"
        }
        /// Under the button, only in this case: why it isn't kept current, and that the person's copy stays.
        public var footnote: String { [reason, PrinterSoftwareRow.leftAlone].compactMap { $0 }.joined(separator: " ") }
    }
    public let name: String
    public let version: String?
    public let status: Status?
    /// The install Update updates (Counterpart's copy), only when a newer version is published.
    public let update: String?
    /// "Used by P1S", or "No printer uses it yet".
    public let usedBy: String
    public let others: [Other]
    public init(name: String, version: String?, status: Status?, update: String?, usedBy: String, others: [Other]) {
        self.name = name; self.version = version; self.status = status; self.update = update; self.usedBy = usedBy; self.others = others
    }

    public static let leftAlone = "Your own copy is left as it is."
    /// Every word the row shows, for tests.
    public var allWords: String { ([name, version, status?.words, usedBy] + others.flatMap { [$0.words, $0.button, $0.footnote] }).compactMap { $0 }.joined(separator: "\n") }
    public static func usedBy(_ printers: [String]) -> String { printers.isEmpty ? "No printer uses it yet" : "Used by " + listed(printers) }
    /// "P1S", "P1S and X1C", "P1S, X1C and A1".
    public static func listed(_ names: [String]) -> String {
        names.count > 1 ? names.dropLast().joined(separator: ", ") + " and " + names.last! : names.first ?? ""
    }
    /// Each printer once by its id (a companion without ids passes the name), in listed order.
    public static func once(_ printers: [(id: String, name: String)]) -> [String] {
        var seen = Set<String>()
        return printers.filter { seen.insert($0.id).inserted }.map(\.name)
    }
    /// A companion from before #775: the same line the companion now sends.
    public static func otherCopy(_ printers: [String], earlier: Bool, version: String?) -> String {
        "\(listed(printers)) \(printers.count > 1 ? "run" : "runs") \(earlier ? "an earlier copy" : "your own copy")" + (version.map { " (\($0))" } ?? "")
    }
}
