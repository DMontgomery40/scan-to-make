import Foundation
import AgentKit

public typealias ModelAccessChoice = AgentKit.ModelAccessChoice
public typealias ModelAPIProvider = AgentKit.ModelAPIProvider
public typealias ModelKeychain = AgentKit.ModelKeychain
public typealias ModelAccessError = AgentKit.ModelAccessError

public struct ModelAccessSnapshot: Decodable, Sendable, Equatable {
    public let revision: UUID
    public let choice: ModelAccessChoice
    public let check: ModelAccessCheck?
    public var connected: Bool { check?.revision == revision && check?.state == .connected }
}

public struct ModelAccessCheck: Decodable, Sendable, Equatable {
    public enum State: String, Decodable, Sendable { case checking, connected, failed, skipped }
    public enum Outcome: String, Decodable, Sendable {
        case authFailed = "auth-failed", needsGUISession = "needs-gui-session", cliOutdated = "cli-outdated", timedOut = "timed-out"
        case cancelled, failed, skipped
    }
    public let id: UUID
    public let revision: UUID
    public let state: State
    public let outcome: Outcome?
}

public extension ControlClient {
    func modelAccess() async throws -> ModelAccessSnapshot { try await call("modelAccess.get") }
    /// Construct a choice with a fresh UUID, call ModelKeychain.save(key, for: choice),
    /// then submit that same choice. The Keychain binding is immutable.
    /// On timeout the mutation outcome is unknown: refresh before deleting any
    /// key reference. Keep the old item until active jobs using it have finished.
    func setModelAccess(_ choice: ModelAccessChoice, expectedRevision: UUID) async throws -> ModelAccessSnapshot {
        let value = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(choice))
        return try await call("modelAccess.set", ["expectedRevision": .string(expectedRevision.uuidString), "choice": value])
    }
    /// Returns immediately. Poll modelAccess() while the returned check is in
    /// progress; only a matching-revision connected result proves the tiny call.
    func checkModelAccess(revision: UUID) async throws -> ModelAccessSnapshot {
        try await call("modelAccess.check", ["revision": .string(revision.uuidString)])
    }
}
