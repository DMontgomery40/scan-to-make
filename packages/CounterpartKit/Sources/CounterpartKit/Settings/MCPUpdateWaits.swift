import Foundation

/// PRD §8.10: an MCP update that hears nothing more from the companion. Every update the companion accepts ends with an
/// `mcp.update.*` event within its own bounds; past them that event went missing (a companion restart, a dropped
/// connection), so the owner shows `unheard` and offers Update again rather than waiting forever. One clock for the
/// Mac, iPhone and iPad; Android (`AppState`) and Linux (`domain.ts`) keep the same limits and sentence.
@MainActor public final class MCPUpdateWaits {
    public static let unheard = "Counterpart didn’t say whether this updated. Try Update again."
    /// Where an install's update is.
    public enum Phase: Sendable { case waiting, started }
    /// A wait for Counterpart's own work: the companion waits up to 60 s for it (IN_FLIGHT_WAIT_MS), then admits the
    /// update after one claim and one bounded npm lookup, ~97 s at most before `started`.
    public var waitingLimit: Duration
    /// An update under way: three install steps of up to 10 minutes each (MCP_UPDATE_TIMEOUT_MS, a checkout's pull,
    /// `npm ci` and build) plus the MCP's restart and connect.
    public var startedLimit: Duration
    private var clocks: [String: UUID] = [:]

    public init(waitingLimit: Duration = .seconds(120), startedLimit: Duration = .seconds(35 * 60)) {
        self.waitingLimit = waitingLimit; self.startedLimit = startedLimit
    }

    /// Call on every change of an install's state. Waiting or started starts (or starts again) that phase's clock; any
    /// other state stops it. `expire` runs once the limit passes with no other change for that install; it should check
    /// the install is still waiting or updating.
    public func note(_ mcpId: String, _ phase: Phase?, expire: @escaping @MainActor () -> Void) {
        guard let phase else { clocks[mcpId] = nil; return }
        let clock = UUID(), limit = phase == .waiting ? waitingLimit : startedLimit
        clocks[mcpId] = clock
        Task { [weak self] in
            try? await Task.sleep(for: limit)
            guard let self, self.clocks[mcpId] == clock else { return }
            self.clocks[mcpId] = nil
            expire()
        }
    }

    /// Stops every clock (another Mac was paired, say).
    public func forget() { clocks = [:] }
}
