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
        let terms = Self.searchTerms(query)
        guard !terms.isEmpty else { return true }
        let text = searchValues(additional: additional).joined(separator: "\n")
        return terms.allSatisfy { Self.find($0, in: text) != nil }
    }

    /// Why a search found this project, when its title doesn't say (first look U10, Nov 10: "holder" listed "3D scan
    /// platform" with nothing to show it was a plate named "Phone Holder"). The first searched value holding a word the
    /// title lacks, cut to a short line around it, with every searched word in it marked. Nil when the title says it all.
    public func searchSnippet(_ query: String, additional: [String] = []) -> SearchSnippet? {
        let terms = Self.searchTerms(query)
        let title = ProjectWords.title(self)
        guard let missing = terms.first(where: { Self.find($0, in: title) == nil }) else { return nil }
        for value in searchValues(additional: additional).dropFirst() {
            let line = value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
            guard let hit = Self.find(missing, in: line) else { continue }
            return SearchSnippet(line: line, around: hit, terms: terms)
        }
        return nil
    }

    static func searchTerms(_ query: String) -> [String] { query.split(whereSeparator: \.isWhitespace).map(String.init) }
    static func find(_ term: String, in text: String, range: Range<String.Index>? = nil) -> Range<String.Index>? {
        text.range(of: term, options: [.caseInsensitive, .diacriticInsensitive], range: range, locale: .current)
    }

    /// Every value a search reads, the title first.
    private func searchValues(additional: [String]) -> [String] {
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
        return values
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

/// A search result's reason: a short line from the project with the searched words marked.
public struct SearchSnippet: Equatable, Sendable {
    public var text: String
    /// Character offsets of each searched word in `text`.
    public var marks: [Range<Int>]

    public init(text: String, marks: [Range<Int>]) { self.text = text; self.marks = marks }

    /// About 30 characters before the hit and 70 after, cut at spaces, with an ellipsis where it was cut.
    init(line: String, around hit: Range<String.Index>, terms: [String], before: Int = 30, after: Int = 70) {
        var start = line.index(hit.lowerBound, offsetBy: -before, limitedBy: line.startIndex) ?? line.startIndex
        var end = line.index(hit.upperBound, offsetBy: after, limitedBy: line.endIndex) ?? line.endIndex
        if start > line.startIndex, let space = line[start..<hit.lowerBound].firstIndex(of: " ") { start = line.index(after: space) }
        if end < line.endIndex, let space = line[hit.upperBound..<end].lastIndex(of: " ") { end = space }
        let body = String(line[start..<end])
        let text = (start > line.startIndex ? "…" : "") + body + (end < line.endIndex ? "…" : "")
        var marks: [Range<Int>] = []
        for term in terms {
            var from = text.startIndex
            while let found = Project.find(term, in: text, range: from..<text.endIndex) {
                marks.append(text.distance(from: text.startIndex, to: found.lowerBound)..<text.distance(from: text.startIndex, to: found.upperBound))
                from = found.upperBound
            }
        }
        self.text = text
        self.marks = marks.sorted { $0.lowerBound < $1.lowerBound }
    }

    /// The line with its searched words in bold, for a `Text`.
    public var attributed: AttributedString {
        var result = AttributedString(text)
        for mark in marks {
            let lower = result.index(result.startIndex, offsetByCharacters: mark.lowerBound)
            let upper = result.index(result.startIndex, offsetByCharacters: mark.upperBound)
            result[lower..<upper].inlinePresentationIntent = .stronglyEmphasized
        }
        return result
    }
}
