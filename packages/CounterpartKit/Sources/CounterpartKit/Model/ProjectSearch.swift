import Foundation

extension Project {
    /// The same name limit as the companion; trimming never changes the saved request.
    public static func validName(_ value: String) -> Bool {
        let name = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return !name.isEmpty && name.utf16.count <= 120 && !name.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
    }

    /// Each word can match a different field: a title, follow-up, reply, Ask, printer or material.
    /// Values are searched, never JSON keys. Extra values supply the current printer's catalog name.
    public func matchesSearch(_ query: String, additional: [String] = []) -> Bool {
        let terms = query.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !terms.isEmpty else { return true }
        let encoded = (try? JSONEncoder().encode(self)).flatMap(JSONValue.object(from:)) ?? [:]
        let values = encoded.filter { $0.key != "directory" }.values.flatMap(Self.searchValues)
        let text = (values + [ProjectWords.title(self)] + additional).joined(separator: "\n")
        return terms.allSatisfy { text.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive], locale: .current) != nil }
    }

    private static func searchValues(_ value: JSONValue) -> [String] {
        switch value {
        case .string(let text): return [text]
        case .number(let number): return [number.formatted(.number.grouping(.never))]
        case .array(let values): return values.flatMap(searchValues)
        case .object(let values): return values.values.flatMap(searchValues)
        default: return []
        }
    }
}
