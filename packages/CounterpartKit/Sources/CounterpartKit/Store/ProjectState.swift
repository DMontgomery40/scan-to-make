import Foundation

/// Applies project reads in the order they were asked for (KAN-217 state fix). David's Stove gap filler:
/// `pass.ready` at 06:32:46.301, then `pass.started` for his follow-up 182 ms later. Both events trigger a
/// fresh `GET /v1/objects/<id>`; if the first read answers last, its "ready" must not replace the second's
/// "working". Every read takes a ticket when it starts; a reply is shown only if no later-started read for
/// that project has been shown already. A list read takes one ticket for all of its projects.
public struct ProjectReads: Sendable {
    private var issued = 0
    private var shown: [String: Int] = [:]
    public init() {}

    /// The ticket for a read starting now.
    public mutating func start() -> Int { issued += 1; return issued }

    /// Whether a reply to the read with `ticket` is newer than what's shown for `projectId`; if so it's recorded.
    public mutating func accept(_ projectId: String, _ ticket: Int) -> Bool {
        guard ticket > (shown[projectId] ?? 0) else { return false }
        shown[projectId] = ticket
        return true
    }

    /// The projects of a list read: each the list's copy unless a later-started read of it is already shown.
    public mutating func merge(_ listed: [Project], ticket: Int, current: [Project]) -> [Project] {
        listed.map { project in accept(project.id, ticket) ? project : (current.first { $0.id == project.id } ?? project) }
    }

    /// A new Mac: nothing shown yet.
    public mutating func reset() { shown = [:] }
}

/// Changes you asked for while the Mac or the printer is busy (PRD §5.4). Ask for changes is open whenever
/// the project has a model (`ProjectWords.canCorrect`); during a pass or a print the change waits here, text
/// kept, and goes in when that step ends (`due`). Photos go to the Mac at once: it keeps them for the next pass.
public struct CorrectionQueue: Codable, Equatable, Sendable {
    public private(set) var notes: [String: String]
    public init(notes: [String: String] = [:]) { self.notes = notes }

    public func pending(_ projectId: String) -> String? { notes[projectId] }

    /// Adds a change; several wait as one, in the order you wrote them.
    public mutating func add(_ text: String, for projectId: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        notes[projectId] = [notes[projectId], text].compactMap { $0 }.joined(separator: "\n")
    }

    /// The waiting change to send now: only once the project can take one (the step it waited for ended).
    public func due(_ project: Project) -> String? {
        guard let note = notes[project.id], ProjectWords(project).canCorrect, !ProjectWords(project).correctionWaits else { return nil }
        return note
    }

    /// `text` reached the Mac: it leaves the queue; anything added meanwhile keeps waiting.
    public mutating func sent(_ text: String, for projectId: String) {
        guard let now = notes[projectId] else { return }
        if now == text { notes[projectId] = nil }
        else if now.hasPrefix(text + "\n") { notes[projectId] = String(now.dropFirst(text.count + 1)) }
    }

    /// The Mac's "Wait until the current step finishes" (409 `invalid-state`): queue it, it isn't an error.
    public static func waits(_ error: CompanionError) -> Bool { error.code == "invalid-state" }
}

extension ProjectWords {
    /// Whether Ask for changes is open (the one rule both apps use): the project has a model, and it isn't
    /// waiting on a close-up (the Ask card is the action there) or still a draft.
    public var canCorrect: Bool { hasModel && !asksForCloseup }

    /// A change written now waits for the step in progress (a pass or a print) and goes in when it ends.
    public var correctionWaits: Bool { stepRunning }
}
