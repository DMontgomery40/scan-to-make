import Foundation

extension Project {
    /// One Ask-for-changes rule for both clients, including an initial pass before it has a model.
    public var canAskForChanges: Bool {
        (current != nil || state == .touchingUp) && state != .new && state != .needsCloseup && openAsk == nil
    }
    public var changesWait: Bool { state == .touchingUp || state == .printing || printConfirmation != nil }
}

/// A saved follow-up waits until the current pass or print finishes. The companion keeps any photos.
/// Adapted from KAN-217's parked queue, with whole messages and no loss of text added during a send.
public struct CorrectionQueue: Equatable, Sendable {
    public private(set) var entries: [String: [String]]
    public init(notes: [String: String] = [:]) { self.entries = notes.mapValues { [$0] } }
    public init(saved: [String: Any]?) {
        entries = (saved ?? [:]).compactMapValues { value in
            if let messages = value as? [String] { return messages.isEmpty ? nil : messages }
            if let message = value as? String { return [message] } // previous app's single-note queue
            return nil
        }
    }
    public func pending(_ id: String) -> String? { entries[id]?.joined(separator: "\n") }
    public mutating func add(_ text: String, for id: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        entries[id, default: []].append(text)
    }
    public func due(_ project: Project) -> String? {
        guard project.canAskForChanges, !project.changesWait, project.current != nil else { return nil }
        // Preserve each whole message: truncation could turn mixed intent into a success report.
        return entries[project.id]?.first
    }
    public mutating func sent(_ text: String, for id: String) {
        guard entries[id]?.first == text else { return }
        entries[id]?.removeFirst()
        if entries[id]?.isEmpty == true { entries[id] = nil }
    }
    public mutating func remove(_ id: String) { entries[id] = nil }
    public static func waits(_ error: CompanionError) -> Bool {
        error.code == "invalid-state" && error.message == "Wait until the current step finishes."
    }
}
