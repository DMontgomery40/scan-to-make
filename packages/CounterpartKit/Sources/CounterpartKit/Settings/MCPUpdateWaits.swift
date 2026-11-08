import Foundation

/// PRD §8.10: an MCP update that says it is waiting, then hears nothing more. The companion ends every wait within a
/// minute with an event (a send, slice or design still going ends it with a sentence). Past `limit` that event went
/// missing (a companion restart, a dropped connection), so the owner shows `unheard` and offers Update again rather
/// than waiting forever. One clock for the Mac, iPhone and iPad.
@MainActor public final class MCPUpdateWaits {
    public static let unheard = "Counterpart didn’t say whether this updated. Try Update again."
    /// How long a wait may go without word from the companion.
    public var limit: Duration
    private var clocks: [String: UUID] = [:]

    public init(limit: Duration = .seconds(90)) { self.limit = limit }

    /// Call on every change of an install's state. A wait starts (or starts again) its clock; any other state stops it.
    /// `expire` runs once `limit` passes with no other change for that install; it should check the install still waits.
    public func note(_ mcpId: String, waiting: Bool, expire: @escaping @MainActor () -> Void) {
        guard waiting else { clocks[mcpId] = nil; return }
        let clock = UUID(), limit = limit
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
