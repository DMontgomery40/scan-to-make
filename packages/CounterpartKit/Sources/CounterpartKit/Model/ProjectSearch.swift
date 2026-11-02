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
        var values = [ProjectWords.title(self)] + additional
        values += [instructions, progress, failure, kind, completion?.note, pendingFollowup,
                   question?.closeup, ask?.question, status?.text, outcome].compactMap { $0 }
        values += (messages ?? []).map(\.text)
        for pass in passes {
            values += [pass.note, pass.summary, pass.engine].compactMap { $0 }
            values += (pass.stages ?? []).map(\.words)
            values += (pass.activity ?? []).map(\.text)
        }
        values += [current?.summary, current?.engine].compactMap { $0 }
        values += (current?.changes ?? []).map(\.text)
        if let size = current?.sizeMm { values += size.map { $0.formatted(.number.grouping(.never)) } }
        values += [print?.destination?.name, print?.jobName, print?.printerStatus?.job,
                   print?.live?.job?.name, print?.live?.job?.stage, print?.live?.activeFilament?.material,
                   print?.live?.activeFilament?.color, printConfirmation?.message].compactMap { $0 }
        values += (print?.events ?? []).map(\.message)
        values += (print?.live?.problems ?? []).map(\.message)
        if let settings = print?.settings, let bytes = try? JSONEncoder().encode(settings), let json = JSONValue.object(from: bytes) {
            values += json.values.flatMap(Self.searchValues)
        }
        if let credit = credit?.object {
            values += ["title", "designer", "site", "licence", "url"].compactMap { credit[$0] }.flatMap(Self.searchValues)
        }
        let files = photos + (capture ?? []) + (self.files.map(Self.searchValues) ?? [])
        values += files.map { URL(fileURLWithPath: $0).lastPathComponent }
        let text = values.joined(separator: "\n")
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
