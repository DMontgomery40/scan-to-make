import Foundation

/// The printer MCP's own confirmation, in rows (PRD §5.5, screens/phone-confirm.jpg). bambu-printer-mcp asks
/// "Start a checked print on P1S (serial)? Nozzles: 0.4 mm. Materials: PLA. Peak targets: …. File SHA-256: ….
/// Confirm the physical spool labels and that the build plate is clear." followed by any warnings. The rows
/// are read from that message; anything not recognised stays as its own words, and the full message is
/// always one tap away. Another MCP's message is shown as it is.
public struct ConfirmationWords: Equatable, Sendable {
    public struct Fact: Equatable, Sendable {
        public var symbol: String
        public var label: String
        public var value: String
    }

    /// "Start a checked print on P1S?", without the serial number.
    public var question: String?
    public var facts: [Fact]
    /// What to look at on the printer: "The spool labels match PLA", "The build plate is clear".
    public var checks: [String]
    /// Sentences the rows don't cover (warnings about a previous job, nozzles without a chip…), as written.
    public var notes: [String]

    public init(message: String, fileName: String? = nil) {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        var rest = text
        var facts: [Fact] = []
        var checks: [String] = []
        func take(_ pattern: String) -> [String]? {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let match = regex.firstMatch(in: rest, range: NSRange(rest.startIndex..., in: rest)) else { return nil }
            let groups = (1..<match.numberOfRanges).map { i in Range(match.range(at: i), in: rest).map { String(rest[$0]) } ?? "" }
            if let whole = Range(match.range, in: rest) { rest.removeSubrange(whole) }
            return groups
        }
        if let q = take(#"^(Start a checked print on [^?(]+?)\s*(?:\([^)]*\))?\?\s*"#) { question = q[0] + "?" } else { question = nil }
        if let n = take(#"Nozzles: ([^.]+(?:\.\d+[^.]*)*?) mm\.\s*"#) {
            facts.append(Fact(symbol: "circle.circle", label: "Nozzle", value: n[0] + " mm"))
        }
        var materials: String?
        if let m = take(#"Materials: ([^.]+)\.\s*"#) {
            materials = m[0]
            facts.append(Fact(symbol: "cylinder.fill", label: "Material", value: m[0]))
        }
        if let t = take(#"Peak targets: nozzle (\d+(?:\.\d+)?)°C, bed (\d+(?:\.\d+)?)°C(?:, chamber (\d+(?:\.\d+)?)°C)?\.\s*"#) {
            var value = "Nozzle \(t[0]) °C · bed \(t[1]) °C"
            if t.count > 2, let chamber = Double(t[2]), chamber > 0 { value += " · chamber \(t[2]) °C" }
            facts.append(Fact(symbol: "flame.fill", label: "Peak", value: value))
        }
        if let f = take(#"File SHA-256: ([0-9a-fA-F]{8,})\.\s*"#) {
            let hash = f[0]
            let short = hash.count > 10 ? "\(hash.prefix(4))…\(hash.suffix(4))" : hash
            facts.append(Fact(symbol: "doc.fill", label: "File", value: [fileName, short].compactMap { $0 }.joined(separator: " · ")))
        }
        if take(#"Confirm the physical spool labels and that the build plate is clear\.\s*"#) != nil {
            checks.append(materials.map { "The spool labels match \($0)" } ?? "The spool labels match")
            checks.append("The build plate is clear")
        }
        self.facts = facts
        self.checks = checks
        // Whatever wasn't read into rows stays in its own words (all of it, for another MCP's message).
        let leftover = rest.trimmingCharacters(in: .whitespacesAndNewlines)
        notes = leftover.isEmpty ? [] : [leftover]
    }

    /// True when the message was read into rows; otherwise show it as written.
    public var isStructured: Bool { question != nil || !facts.isEmpty }
}
