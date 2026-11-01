import Foundation
import Combine
import AgentKit
#if canImport(ControlKit)
import ControlKit
#endif

/// What the Allow card needs from the companion: local-control's status, nearby.list and nearby.answer.
protocol NearbyCompanion: Sendable {
    func nearbyPairingEnabled() async throws -> Bool
    func nearbyRequests() async throws -> [ControlNearbyRequest]
    func answerNearby(_ id: String, allow: Bool) async throws
}

/// The control socket. A fresh client per call, so a missing socket fails that call, not the model.
struct SocketNearby: NearbyCompanion {
    let path: String
    func nearbyPairingEnabled() async throws -> Bool { try await ControlClient(socketPath:path).status().capabilities.nearbyPairing }
    func nearbyRequests() async throws -> [ControlNearbyRequest] { try await ControlClient(socketPath:path).nearbyRequests() }
    func answerNearby(_ id: String, allow: Bool) async throws { try await ControlClient(socketPath:path).answerNearby(id, allow:allow) }
}

/// Phones nearby that are waiting for Allow (journey.md §3.4, MAC-5). The list is polled only while the
/// companion says nearby pairing is on; requests expire two minutes after they start.
@MainActor final class NearbyModel: ObservableObject {
    /// A failed answer, shown on that request's card until the request is answered or gone.
    struct Problem: Equatable { let requestID: String, text: String }
    @Published private(set) var requests: [ControlNearbyRequest] = []
    @Published private(set) var answering: Set<String> = []
    @Published private(set) var problem: Problem?
    private let companion: any NearbyCompanion
    private let now: () -> Date
    private var loop: Task<Void, Never>?
    /// nil until the companion has answered; only its own "false" turns the cards off.
    private var enabled: Bool?
    private var pollsSinceStatus = 0
    private var failures = 0

    init(companion: any NearbyCompanion, now: @escaping () -> Date = Date.init) {
        self.companion = companion
        self.now = now
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let delay = await self?.poll() else { return }
                try? await Task.sleep(for:.seconds(delay))
            }
        }
    }

    /// One step, returning the seconds until the next. The capability is read every 30 s and the list
    /// every 2 s while it is on. A failed read isn't an answer: cards stay until they expire, and the
    /// companion is asked again soon (it may still be starting).
    @discardableResult func poll() async -> Double {
        if enabled != true || pollsSinceStatus >= 15 {
            pollsSinceStatus = 0
            do {
                enabled = try await companion.nearbyPairingEnabled()
                failures = 0
            } catch {
                failures += 1
                show(requests)
                return failures < 15 ? 2 : 10
            }
        }
        pollsSinceStatus += 1
        guard enabled == true else { requests = []; problem = nil; return 30 }
        await list()
        return 2
    }

    func list() async {
        do { show(try await companion.nearbyRequests()) }
        catch { show(requests) }
    }

    /// Shows unexpired requests, and drops a problem whose request has gone.
    private func show(_ items: [ControlNearbyRequest]) {
        let nowMs = now().timeIntervalSince1970 * 1000
        requests = items.filter { $0.expiresAt > nowMs }
        if let problem, !requests.contains(where: { $0.id == problem.requestID }) { self.problem = nil }
    }

    /// Allow pairs only this phone. A request that is gone (expired, or answered elsewhere) just
    /// disappears. After a timeout the outcome is unknown, so list again and never resend.
    func answer(_ request: ControlNearbyRequest, allow: Bool) async {
        guard !answering.contains(request.id) else { return }
        answering.insert(request.id)
        if problem?.requestID == request.id { problem = nil }
        do {
            try await companion.answerNearby(request.id, allow:allow)
            requests.removeAll { $0.id == request.id }
        } catch let error as ControlRemoteError where error.code == "not-found" {
            requests.removeAll { $0.id == request.id }
        } catch {
            problem = Problem(requestID:request.id, text:"That didn't reach Counterpart. If the phone is still waiting, try again.")
        }
        await list()
        answering.remove(request.id)
    }

    /// "482913" → "482 913", as the phone shows it.
    nonisolated static func format(_ code: String) -> String {
        code.count == 6 ? code.prefix(3) + " " + code.suffix(3) : code
    }
}
