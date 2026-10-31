import Combine
import Foundation

/// One invitation shared by independently owned presentations. The refresh task
/// belongs to the session, so cancelling a popover's view task cannot stop it.
@MainActor open class PairingSession: ObservableObject {
    @Published public private(set) var invitation: PairingInvitation?
    @Published public private(set) var failure: Error?
    @Published public private(set) var working = false
    private var viewers: Set<UUID> = []
    private var refreshTask: Task<Void, Never>?
    private var cachedInvitation: PairingInvitation?
    private let now: () -> Date
    private let refreshInterval: Duration

    public init(now: @escaping () -> Date = Date.init, refreshInterval: Duration = .seconds(1)) {
        self.now = now
        self.refreshInterval = refreshInterval
    }

    open func mintInvitation() async throws -> PairingInvitation {
        throw AgentError.invalidInvitation
    }

    open func ensureCompanionReady() async throws {}
    open func isInvitationActive(_ invitation: PairingInvitation) async throws -> Bool { true }

    public func presentPairing(_ viewer: UUID) async {
        guard viewers.insert(viewer).inserted else { return }
        if refreshTask == nil {
            let interval = refreshInterval
            refreshTask = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for:interval) } catch { return }
                    await self?.refreshIfNeeded()
                }
            }
        }
        await preparePairing()
    }

    public func hidePairing(_ viewer: UUID) {
        viewers.remove(viewer)
        guard viewers.isEmpty else { return }
        refreshTask?.cancel()
        refreshTask = nil
        invitation = nil
        failure = nil
    }

    private func refreshIfNeeded() async {
        guard !viewers.isEmpty, let invitation,
              invitation.expiresAt <= now().timeIntervalSince1970 * 1000 else { return }
        await preparePairing()
    }

    public func preparePairing() async {
        guard !working, !viewers.isEmpty else { return }
        working = true
        invitation = nil
        failure = nil
        defer { working = false }
        do {
            // Readiness must be checked even when reusing a code: an activation
            // marker or cached QR does not prove that the listener is running.
            try await ensureCompanionReady()
            let next: PairingInvitation
            if let cachedInvitation,
               cachedInvitation.expiresAt > now().timeIntervalSince1970 * 1000,
               try await isInvitationActive(cachedInvitation) {
                next = cachedInvitation
            } else {
                // Never supersede an active code. Consumed codes are already
                // removed; createPairing prunes expired codes before minting.
                next = try await mintInvitation()
                cachedInvitation = next
            }
            guard !viewers.isEmpty else { return }
            invitation = next
        } catch {
            guard !viewers.isEmpty else { return }
            failure = error
        }
    }

    deinit { refreshTask?.cancel() }
}
