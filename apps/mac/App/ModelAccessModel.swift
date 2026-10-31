import Foundation
import Combine
import AgentKit
#if canImport(ControlKit)
import ControlKit
#endif

/// What the AI settings need from the companion: local-control's modelAccess.get/set/check.
protocol ModelAccessCompanion: Sendable {
    func modelAccess() async throws -> ModelAccessSnapshot
    func setModelAccess(_ choice: ModelAccessChoice, expectedRevision: UUID) async throws -> ModelAccessSnapshot
    func checkModelAccess(revision: UUID) async throws -> ModelAccessSnapshot
}

/// The control socket. A fresh client per call, so a missing socket fails that call, not the model.
struct SocketModelAccess: ModelAccessCompanion {
    let path: String
    func modelAccess() async throws -> ModelAccessSnapshot { try await ControlClient(socketPath:path).modelAccess() }
    func setModelAccess(_ choice: ModelAccessChoice, expectedRevision: UUID) async throws -> ModelAccessSnapshot {
        try await ControlClient(socketPath:path).setModelAccess(choice, expectedRevision:expectedRevision)
    }
    func checkModelAccess(revision: UUID) async throws -> ModelAccessSnapshot {
        try await ControlClient(socketPath:path).checkModelAccess(revision:revision)
    }
}

extension ModelAccessChoice {
    /// The plain name shown to the user.
    var displayName: String {
        switch self {
        case .none: return "No AI"
        case .claudeCode: return "Claude Code"
        case .codexCLI: return "Codex"
        case let .api(provider, _, _): return provider == .anthropic ? "Anthropic" : "OpenAI"
        case let .endpoint(url, _, _): return url.host ?? "your endpoint"
        }
    }
    var usesLogin: Bool { self == .claudeCode || self == .codexCLI }
    var isAPIKey: Bool { if case .api = self { return true }; return false }
    var isEndpoint: Bool { if case .endpoint = self { return true }; return false }
}

/// Holds the companion's snapshot and applies choices. A key exists here only while it is saved.
@MainActor final class ModelAccessModel: ObservableObject {
    enum Status: Equatable { case idle, checking, connected, failed(String) }
    @Published private(set) var snapshot: ModelAccessSnapshot?
    @Published private(set) var unavailable = false
    @Published private(set) var saving = false
    @Published private(set) var problem: String?
    /// A check the companion should have settled by now; shown as a timeout the user can retry.
    @Published private var stalled: UUID?
    private let companion: any ModelAccessCompanion
    private var pollTask: Task<Void, Never>?

    init(companion: any ModelAccessCompanion) { self.companion = companion }
    convenience init(socketPath: String) { self.init(companion:SocketModelAccess(path:socketPath)) }

    func refresh() async {
        do {
            snapshot = try await companion.modelAccess()
            unavailable = false
            follow()
        } catch {
            unavailable = true
        }
    }

    var status: Status {
        guard let snapshot, snapshot.choice != .none else { return .idle }
        guard let check = snapshot.check, check.revision == snapshot.revision else { return .idle }
        switch check.state {
        case .checking: return stalled == snapshot.revision ? .failed(Self.failureText(.timedOut, snapshot.choice)) : .checking
        case .connected: return .connected
        case .skipped: return .idle
        case .failed: return check.outcome == .cancelled ? .idle : .failed(Self.failureText(check.outcome, snapshot.choice))
        }
    }

    /// True once the companion holds this choice.
    @discardableResult func choose(_ choice: ModelAccessChoice) async -> Bool { await apply(choice, secret:nil) }

    func useKey(provider: ModelAPIProvider, model: String, key: String) async {
        await apply(.api(provider:provider, model:model.trimmingCharacters(in:.whitespaces), keychainRef:UUID()),
                    secret:key.trimmingCharacters(in:.whitespacesAndNewlines))
    }

    func useEndpoint(address: String, model: String, key: String) async {
        let secret = key.trimmingCharacters(in:.whitespacesAndNewlines)
        guard let url = URL(string:address.trimmingCharacters(in:.whitespaces)) else {
            problem = "Check the address. It starts with http:// or https://."; return
        }
        await apply(.endpoint(url:url, model:model.trimmingCharacters(in:.whitespaces), keychainRef:secret.isEmpty ? nil : UUID()),
                    secret:secret.isEmpty ? nil : secret)
    }

    /// "Continue without AI" must reach the companion even when this model's snapshot is stale:
    /// another window may have turned AI on. Read the current revision, submit "none", and retry
    /// on a conflict. True only once the companion confirms "none".
    func skipAI() async -> Bool {
        guard !saving else { return false }
        saving = true
        problem = nil
        defer { saving = false }
        for _ in 0..<3 {
            do {
                let current = try await companion.modelAccess()
                snapshot = current
                unavailable = false
                let next = try await companion.setModelAccess(.none, expectedRevision:current.revision)
                snapshot = next
                follow()
                if next.choice == .none { return true }
            } catch let error as ControlRemoteError where error.code == "conflict" {
                continue
            } catch {
                break
            }
        }
        await refresh()
        problem = "That didn't save. Try again."
        return false
    }

    func checkAgain() async {
        guard let snapshot, snapshot.choice != .none else { return }
        do {
            self.snapshot = try await companion.checkModelAccess(revision:snapshot.revision)
            follow()
        } catch {
            await refresh()
        }
    }

    /// Save the key first, bound to this exact choice, then submit the same choice (ControlKit's contract).
    @discardableResult private func apply(_ choice: ModelAccessChoice, secret: String?) async -> Bool {
        guard !saving else { return false }
        if snapshot == nil { await refresh() }
        guard let current = snapshot else { return false }
        saving = true
        problem = nil
        defer { saving = false }
        do {
            try choice.validate()
            if let secret { try ModelKeychain().save(secret, for:choice) }
        } catch {
            problem = Self.saveText(error, choice); return false
        }
        do {
            snapshot = try await companion.setModelAccess(choice, expectedRevision:current.revision)
        } catch {
            // A conflict, or a deadline after sending: look at what the companion has now.
            await refresh()
            if snapshot?.choice != choice { problem = "That didn't save. Try again." }
            // The new key is unused only if we saw the current setting and it isn't ours.
            if let reference = choice.keychainReference, !unavailable, snapshot?.choice.keychainReference != reference {
                try? ModelKeychain().remove(reference)
            }
            return snapshot?.choice == choice
        }
        // Saved. A failed check request only leaves it unchecked; Check connection retries it.
        if choice != .none, let saved = snapshot {
            if let next = try? await companion.checkModelAccess(revision:saved.revision) { snapshot = next }
        }
        follow()
        return true
    }

    /// Poll until the check settles or the choice changes. The companion settles every check within
    /// about 160 s (a 150 s deadline plus forced termination); past 200 s it shows as a timeout.
    private func follow() {
        pollTask?.cancel()
        guard let watched = snapshot, watched.check?.revision == watched.revision, watched.check?.state == .checking else { return }
        stalled = nil
        pollTask = Task { [weak self] in
            for _ in 0..<200 {
                try? await Task.sleep(for:.seconds(1))
                guard !Task.isCancelled, let self else { return }
                guard let next = try? await self.companion.modelAccess() else { continue }
                // A newer choice may have landed while this read was in flight.
                guard !Task.isCancelled, self.snapshot?.revision == watched.revision else { return }
                self.snapshot = next
                if next.revision != watched.revision || next.check?.state != .checking { return }
            }
            guard !Task.isCancelled, let self, self.snapshot?.revision == watched.revision else { return }
            self.stalled = watched.revision
        }
    }

    static func failureText(_ outcome: ModelAccessCheck.Outcome?, _ choice: ModelAccessChoice) -> String {
        let name = choice.displayName
        switch outcome {
        case .authFailed?:
            if choice.usesLogin { return "Sign in to \(name) on this Mac, then check again." }
            return choice.isEndpoint ? "That address turned the key down." : "That key didn't work."
        case .needsGUISession?: return "\(name) only works while you're logged in at this Mac."
        case .cliOutdated?: return "Update \(name) on this Mac, then check again."
        case .timedOut?: return "\(name) didn't answer in time."
        default:
            if choice.usesLogin { return "Couldn't run \(name) on this Mac. Is it installed?" }
            return choice.isEndpoint ? "Couldn't reach that address." : "Couldn't reach \(name)."
        }
    }

    static func saveText(_ error: Error, _ choice: ModelAccessChoice) -> String {
        switch error as? ModelAccessError {
        case .invalidSecret?: return "That key doesn't look right."
        case .invalidChoice?: return choice.isEndpoint ? "Check the address and the model name." : "Check the model name."
        case .credentialLocked?: return "Unlock your Mac's keychain, then try again."
        default: return "Couldn't save the key in your keychain."
        }
    }

    deinit { pollTask?.cancel() }
}
