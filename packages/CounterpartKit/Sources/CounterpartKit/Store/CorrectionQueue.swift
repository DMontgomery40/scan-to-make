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
    public struct Message: Codable, Equatable, Identifiable, Sendable {
        public var id: String
        public var text: String
        /// Nil for a queue migrated from a version that did not save the time.
        public var atMs: Double?
        public var photos: [String]?
        public init(text: String, photos: [String]? = nil, atMs: Double? = Date().timeIntervalSince1970 * 1000) {
            self.id = UUID().uuidString; self.text = text; self.photos = photos; self.atMs = atMs
        }
    }
    public private(set) var messages: [String: [Message]] = [:]
    public var entries: [String: [String]] { messages.mapValues { $0.map(\.text) } }
    public private(set) var failures: [String: String] = [:]
    public init(notes: [String: String] = [:]) { messages = notes.mapValues { [Message(text: $0, atMs: nil)] } }
    public init(saved: [String: Any]?) {
        failures = saved?["failures"] as? [String: String] ?? [:]
        if let data = saved?["messageData"] as? Data, let value = try? JSONDecoder().decode([String: [Message]].self, from: data) {
            messages = value
        } else {
            let values = saved?["messages"] as? [String: Any] ?? saved ?? [:]
            messages = values.compactMapValues { value in
                if let texts = value as? [String] { return texts.isEmpty ? nil : texts.map { Message(text: $0, atMs: nil) } }
                if let text = value as? String { return [Message(text: text, atMs: nil)] }
                return nil
            }
        }
    }
    public var saved: [String: Any] { ["version": 2, "messageData": (try? JSONEncoder().encode(messages)) ?? Data(), "failures": failures] }
    public mutating func fail(_ id: String, message: String) { failures[id] = message }
    public mutating func retry(_ id: String) { failures[id] = nil }
    public func pending(_ id: String) -> String? { entries[id]?.joined(separator: "\n") }
    public mutating func add(_ text: String, for id: String, photos: [String]? = nil) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        messages[id, default: []].append(Message(text: text, photos: photos))
    }
    /// Newly uploaded photos that have not already been claimed by an earlier local message.
    public func availablePhotos(_ project: Project) -> [String]? {
        guard let pending = project.pendingPhotos else { return nil }
        let claimed = Set((messages[project.id] ?? []).flatMap { $0.photos ?? [] })
        return pending.filter { !claimed.contains($0) }
    }
    public func due(_ project: Project) -> String? {
        guard project.canAskForChanges, !project.changesWait, project.current != nil, failures[project.id] == nil else { return nil }
        // Preserve each whole message: truncation could turn mixed intent into a success report.
        return entries[project.id]?.first
    }
    public mutating func sent(_ text: String, for id: String) {
        guard entries[id]?.first == text else { return }
        failures[id] = nil
        messages[id]?.removeFirst()
        if messages[id]?.isEmpty == true { messages[id] = nil }
    }
    public mutating func remove(_ id: String) { messages[id] = nil; failures[id] = nil }
    public static func waits(_ error: CompanionError) -> Bool {
        error.code == "invalid-state" && error.message == "Wait until the current step finishes."
    }
}
