import Foundation
import Security
#if canImport(ControlKit)
import ControlKit
#endif

/// The Live Activity relay client (PRD §8.8, services/relay/docs.md). On by default in production-signed builds
/// (David, Nov 8); a choice made in Settings wins. One push in flight per token; while one is in flight only the newest state waits behind it.
/// An end or a pause is never dropped: after a 429 it is sent again once the wait is over, and when the relay can't be
/// reached it is sent again with a growing wait (`RelayRetry`).
@MainActor final class LiveActivityRelay {
    static let enabledKey = "relay.enabled"
    static let urlKey = "relay.url"
    static let defaultURL = "https://counterpart.dtmont.com/relay/v1"

    /// This build's APNs environment (`com.apple.developer.aps-environment`): "production" in Developer ID releases.
    nonisolated static let apsEnvironment: String? = {
        guard let task = SecTaskCreateFromSelf(nil) else { return nil }
        return SecTaskCopyValueForEntitlement(task, "com.apple.developer.aps-environment" as CFString, nil) as? String
    }()
    nonisolated static var enabledByDefault: Bool { RelayDefault.enabled(stored: nil, apsEnvironment: apsEnvironment) }

    var enabled: Bool {
        RelayDefault.enabled(stored: UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool, apsEnvironment: Self.apsEnvironment)
    }
    var endpoint: URL? {
        let text = UserDefaults.standard.string(forKey: Self.urlKey) ?? Self.defaultURL
        guard let url = URL(string: text), url.scheme == "https" else { return nil }
        return url.appendingPathComponent("live-activity")
    }

    /// Plain words for Settings: what the relay last said.
    private(set) var lastResult = "Off"
    private var inFlight: Set<String> = []
    private var waiting: [String: LiveActivityPush] = [:]
    private var dead: Set<String> = []
    private var pausedUntil: Date?
    /// Sends in a row that couldn't reach the relay, per token.
    private var failures: [String: Int] = [:]
    private var recovery = LiveActivityRecovery(defaults: .standard)
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        return URLSession(configuration: configuration)
    }()

    /// Tokens come from the companion (the phone on the LAN) and from iCloud (`CounterpartDevice`, the phone away).
    func deliver(_ event: CounterpartEvent, title: String, client: ControlClient, cloudTokens: LiveActivityTokens) async {
        guard enabled, endpoint != nil, event.type.hasPrefix("print.") else { return }
        recovery.record(event, title: title, now: Date())
        let local = (try? await client.liveActivityTokens()) ?? LiveActivityTokens()
        let candidates = event.type == "print.started" ? (local.pushToStart + cloudTokens.pushToStart).map(\.token) : []
        for token in Set(candidates.map { $0.lowercased() }) where !dead.contains(token) {
            guard let push = LiveActivityPush.make(for: event, token: token, title: title, now: Date()) else { continue }
            enqueue(push)
        }
        recover(local: local, cloud: cloudTokens)
    }

    /// Called each long-poll cycle even with no new events: the phone may only now have registered its token.
    func recover(client: ControlClient, cloudTokens: LiveActivityTokens) async {
        guard enabled, endpoint != nil else { return }
        let local = (try? await client.liveActivityTokens()) ?? LiveActivityTokens()
        recover(local: local, cloud: cloudTokens)
    }

    private func recover(local: LiveActivityTokens, cloud: LiveActivityTokens) {
        for push in recovery.pushes(tokens: local.activities + cloud.activities, now: Date()) where !dead.contains(push.token) { enqueue(push) }
    }

    private var tokenPausedUntil: [String: Date] = [:]

    private func enqueue(_ push: LiveActivityPush) {
        // While the relay asked to wait, keep the newest state (an end always wins) and send it when the wait is over.
        let until = [pausedUntil, tokenPausedUntil[push.token]].compactMap { $0 }.max()
        if let until, Date() < until {
            if waiting[push.token]?.kind != .end || push.kind == .end { waiting[push.token] = push }
            scheduleFlush(at: until)
            return
        }
        if inFlight.contains(push.token) {
            // Keep the newest; an end always wins over an update.
            if waiting[push.token]?.kind != .end || push.kind == .end { waiting[push.token] = push }
            return
        }
        inFlight.insert(push.token)
        Task { await send(push) }
    }

    private var flushAt: Date?
    /// Sends what waited once the earliest wait is over; anything still waiting schedules the next flush.
    private func scheduleFlush(at date: Date) {
        if let flushAt, flushAt <= date { return }
        flushAt = date
        Task {
            try? await Task.sleep(for: .seconds(max(1, date.timeIntervalSinceNow)))
            guard flushAt == date else { return }
            flushAt = nil
            let now = Date()
            if let pausedUntil, pausedUntil <= now { self.pausedUntil = nil }
            tokenPausedUntil = tokenPausedUntil.filter { $0.value > now }
            let ready = waiting.filter { inFlight.contains($0.key) == false }
            for token in ready.keys { waiting[token] = nil }
            for push in ready.values { enqueue(push) }
        }
    }

    /// Keeps a push that couldn't go to be sent after the wait. Anything waiting arrived while it was in flight, so it
    /// is newer and wins, except that an end always wins over an update.
    private func keep(_ push: LiveActivityPush) {
        if let newer = waiting[push.token], !(push.kind == .end && newer.kind != .end) { return }
        waiting[push.token] = push
    }

    private func send(_ push: LiveActivityPush) async {
        defer {
            inFlight.remove(push.token)
            if let next = waiting.removeValue(forKey: push.token) { enqueue(next) }
        }
        guard enabled, let endpoint, let body = try? JSONEncoder().encode(push) else { return }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        guard let (data, response) = try? await session.data(for: request), let http = response as? HTTPURLResponse else {
            // Offline or the relay is down: an end has no later update to repair the phone's Live Activity, so keep
            // it (unless something newer waits) and send it again after a growing wait.
            let count = (failures[push.token] ?? 0) + 1
            if let wait = RelayRetry.delay(failures: count, kind: push.kind) {
                failures[push.token] = count
                let until = Date().addingTimeInterval(wait)
                tokenPausedUntil[push.token] = max(until, tokenPausedUntil[push.token] ?? until)
                keep(push)
                scheduleFlush(at: until)
                lastResult = "The relay couldn't be reached; trying again soon."
            } else {
                failures[push.token] = nil
                lastResult = "The relay couldn't be reached."
            }
            return
        }
        failures[push.token] = nil
        let retry = Double(http.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 60
        switch http.statusCode {
        case 200:
            lastResult = "Working"
        case 410:
            dead.insert(push.token) // the phone sends a new token, or updates the activity itself
            lastResult = "A phone's Live Activity ended."
        case 429:
            // Wait as long as the relay says (a daily limit can mean hours), keep the newest state for this token (an
            // end always wins), and send it once the wait is over. A network-wide limit pauses every token.
            let scope = (try? JSONDecoder().decode([String: JSONValue].self, from: data))?["scope"]?.string ?? "token-interval"
            let until = Date().addingTimeInterval(max(retry, 1))
            if scope.hasPrefix("token") || scope == "apns" { tokenPausedUntil[push.token] = until } else { pausedUntil = until }
            keep(push)
            scheduleFlush(at: until)
            lastResult = "Waiting: the relay asked to slow down."
        case 503:
            let error = (try? JSONDecoder().decode([String: JSONValue].self, from: data))?["error"]?.string
            if error == "not_configured" {
                pausedUntil = Date().addingTimeInterval(retry > 0 ? retry : 3600)
                lastResult = "The relay has no APNs key yet. Your phone's Live Activity catches up when you open Counterpart."
            } else {
                pausedUntil = Date().addingTimeInterval(min(max(retry, 1), 900))
                lastResult = "The relay is busy; trying again soon."
            }
            // Keep this state (unless a newer one is already waiting) and send it after the wait.
            keep(push)
            if let pausedUntil { scheduleFlush(at: pausedUntil) }
        default:
            lastResult = "The relay refused an update (\(http.statusCode))."
        }
    }
}
