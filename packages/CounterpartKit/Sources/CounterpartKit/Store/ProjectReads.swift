import Foundation

/// A slow snapshot must never replace a newer project. Adapted from the parked KAN-217 state fix,
/// including creations, deletion and connection reset while an older list request is in flight.
public struct ProjectReads: Sendable {
    private var issued = 0
    private var resetAt = 0
    private var shown: [String: Int] = [:]
    public init() {}
    public mutating func start() -> Int { issued += 1; return issued }

    public mutating func accept(_ id: String, ticket: Int) -> Bool {
        guard ticket > resetAt, ticket > (shown[id] ?? 0) else { return false }
        shown[id] = ticket
        return true
    }

    public mutating func merge(_ listed: [Project], ticket: Int, current: [Project]) -> [Project] {
        guard ticket > resetAt else { return current }
        let existing = Dictionary(uniqueKeysWithValues: current.map { ($0.id, $0) })
        let listedIDs = Set(listed.map(\.id))
        let retained = current.filter { !listedIDs.contains($0.id) && (shown[$0.id] ?? 0) > ticket }
        return retained + listed.compactMap { project in
            if accept(project.id, ticket: ticket) { return project }
            // Missing from current means it was deleted after this read began.
            return existing[project.id]
        }
    }

    public mutating func remove(_ id: String) { shown[id] = start() }
    public mutating func reset() { resetAt = start(); shown = [:] }
}
