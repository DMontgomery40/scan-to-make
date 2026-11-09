import Foundation
import OSLog
import Security
#if canImport(ControlKit)
import ControlKit
#endif

/// The Live Activity relay client (PRD §8.8, services/relay/docs.md). On by default in production-signed builds
/// (David, Nov 8); a choice made in Settings wins. One push in flight per token.
/// Statuses coalesce; distinct milestone alerts wait in order and their decisions survive a restart.
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
        RelayDefault.enabled(stored: defaults.object(forKey: Self.enabledKey) as? Bool, apsEnvironment: Self.apsEnvironment)
    }
    /// CloudKit delivery is confirmed before the durable fallback leaves the outbox.
    var undelivered: ((CounterpartEvent) async -> Bool)?
    private let defaults: UserDefaults
    private let alerted: AlertedMilestones
    private var milestones: MilestoneDeliveries
    private var queuedMilestones: Set<String> = []
    private var fallbackInFlight: Set<String> = []
    var endpoint: URL? {
        let text = defaults.string(forKey: Self.urlKey) ?? Self.defaultURL
        guard let url = URL(string: text), url.scheme == "https" else { return nil }
        return url.appendingPathComponent("live-activity")
    }
    private(set) var lastResult = "Off"
    private var inFlight: Set<String> = []
    // Statuses coalesce; distinct milestone alerts retain their order for each token.
    private var waiting: [String: [LiveActivityPush]] = [:]
    private var dead: Set<String> = []
    private var pausedUntil: Date?
    private var tokenPausedUntil: [String: Date] = [:]
    private var failures: [String: Int] = [:]
    private var recovery: LiveActivityRecovery
    private let session: URLSession
    private let now: () -> Date
    private var phoneChoices: [String: [String: Bool]] = [:]
    private var flushAt: Date?
    private var flushTask: Task<Void, Never>?
    private static let logger = Logger(subsystem: "com.scantomake.mac", category: "MilestoneDelivery")

    init(defaults: UserDefaults = .standard, session: URLSession? = nil, now: @escaping () -> Date = Date.init) {
        self.defaults = defaults
        self.now = now
        self.alerted = AlertedMilestones(defaults: defaults)
        self.milestones = MilestoneDeliveries(defaults: defaults)
        self.recovery = LiveActivityRecovery(defaults: defaults)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        self.session = session ?? URLSession(configuration: configuration)
    }
    deinit { flushTask?.cancel() }

    func deliver(_ event: CounterpartEvent, title: String, client: ControlClient, cloudTokens: LiveActivityTokens) async {
        let local = (try? await client.liveActivityTokens()) ?? LiveActivityTokens()
        deliver(event, title: title, local: local, cloudTokens: cloudTokens)
    }

    func deliver(_ event: CounterpartEvent, title: String, local: LiveActivityTokens, cloudTokens: LiveActivityTokens) {
        guard enabled, endpoint != nil, event.type.hasPrefix("print.") else { return }
        recovery.record(event, title: title, now: Date())
        let candidates = event.type == "print.started" ? (local.pushToStart + cloudTokens.pushToStart).map(\.token) : []
        for token in Set(candidates.map { $0.lowercased() }) where !dead.contains(token) {
            if let push = LiveActivityPush.make(for: event, token: token, title: title, now: Date()) { enqueue(push) }
        }
        recover(local: local, cloud: cloudTokens)
    }

    /// Choose one transport before any push. The full paired-device list includes phones whose token
    /// has not arrived yet, unlike a union of push-to-start tokens alone.
    func alertMilestone(_ event: CounterpartEvent, title: String, client: ControlClient, cloudTokens: LiveActivityTokens) async -> Bool {
        guard MilestoneAlert.types.contains(event.type) else { return false }
        let local = (try? await client.liveActivityTokens()) ?? LiveActivityTokens()
        let devices = try? await client.devices()
        let settings = try? await client.companionSettings()
        return alertMilestone(event, title: title, local: local, cloudTokens: cloudTokens,
                              pairedDeviceIds: devices.map { Set($0.map(\.deviceId)) }, phoneChoices: settings?.notificationsDevices)
    }

    func alertMilestone(_ event: CounterpartEvent, title: String, local: LiveActivityTokens, cloudTokens: LiveActivityTokens,
                        pairedDeviceIds: Set<String>? = nil, phoneChoices: [String: [String: Bool]]? = [:]) -> Bool {
        if let phoneChoices { self.phoneChoices = phoneChoices }
        // A pending decision must be resumed even if Settings changed or the token disappeared.
        if alerted.contains(event.id) { return true }
        if milestones.entries[event.id] != nil { resumeMilestones(local: local, cloud: cloudTokens); return true }
        guard let phoneChoices, enabled, endpoint != nil,
              let activities = MilestoneAlert.tokens(for: event, relayOn: true, local: local, cloud: cloudTokens,
                                                     dead: dead, pairedDeviceIds: pairedDeviceIds) else { return false }
        // Preserve the existing CloudKit preference path when any paired recipient opted out.
        let knownDevices = (pairedDeviceIds ?? []).union(activities.map(\.deviceId))
        guard !knownDevices.contains(where: { phoneChoices[$0]?[event.type] == false }) else { return false }
        let soon = Date().addingTimeInterval(30)
        if let pausedUntil, pausedUntil > soon { return false }
        if activities.contains(where: { (tokenPausedUntil[$0.token.lowercased()] ?? .distantPast) > soon }) { return false }
        milestones.begin(event, title: title, devices: activities.map(\.deviceId), now: now())
        resumeMilestones(local: local, cloud: cloudTokens)
        return true
    }

    func recover(client: ControlClient, cloudTokens: LiveActivityTokens) async {
        if let settings = try? await client.companionSettings(), let choices = settings.notificationsDevices { phoneChoices = choices }
        let local = (try? await client.liveActivityTokens()) ?? LiveActivityTokens()
        recover(local: local, cloud: cloudTokens)
    }

    func recover(local: LiveActivityTokens, cloud: LiveActivityTokens) {
        resumeMilestones(local: local, cloud: cloud)
        guard enabled, endpoint != nil else { return }
        for push in recovery.pushes(tokens: local.activities + cloud.activities, now: Date()) where !dead.contains(push.token) { enqueue(push) }
    }

    private func resumeMilestones(local: LiveActivityTokens, cloud: LiveActivityTokens) {
        for entry in milestones.entries.values.sorted(by: { $0.event.seq < $1.event.seq }) {
            if entry.complete { decide(entry.event.id); continue }
            for (device, outcome) in entry.outcomes where outcome == .pending {
                let key = entry.event.id + "|" + device
                guard !queuedMilestones.contains(key) else { continue }
                guard enabled, endpoint != nil else {
                    milestones.resolve(entry.event.id, device: device, outcome: .failed)
                    decide(entry.event.id); continue
                }
                let candidates = (local.activities + cloud.activities).filter { $0.deviceId == device && $0.printId == entry.event.printId }
                guard let token = candidates.max(by: { $0.updatedAt < $1.updatedAt })?.token else {
                    // Dismissed activities remove their tokens permanently. Allow registrations to
                    // catch up briefly, then finish this recipient rather than stranding the outbox.
                    if now().timeIntervalSince(entry.firstQueuedAt ?? entry.event.date ?? .distantPast) >= 30 {
                        milestones.resolve(entry.event.id, device: device, outcome: .failed)
                        decide(entry.event.id)
                    }
                    continue
                }
                if phoneChoices[device]?[entry.event.type] == false || dead.contains(token.lowercased()) {
                    milestones.resolve(entry.event.id, device: device, outcome: .failed)
                    decide(entry.event.id); continue
                }
                guard let push = MilestoneAlert.push(for: entry.event, token: token, title: entry.title, now: Date(), deviceId: device) else { continue }
                queuedMilestones.insert(key)
                enqueue(push)
            }
        }
    }

    private func resolved(_ push: LiveActivityPush, _ outcome: MilestoneDeliveries.Outcome) {
        guard let id = push.alertEventId, let device = push.alertDeviceId else { return }
        queuedMilestones.remove(id + "|" + device)
        milestones.resolve(id, device: device, outcome: outcome)
        decide(id)
    }

    private func decide(_ id: String) {
        guard let entry = milestones.entries[id], entry.complete else { return }
        if entry.hasSuccess {
            // CloudKit is account-wide. A miss is preferable to notifying successful devices twice.
            for (device, outcome) in entry.outcomes where outcome == .failed {
                Self.logger.notice("Milestone \(id, privacy: .public) missed device \(device, privacy: .public)")
            }
            alerted.insert(id)
            milestones.remove(id)
        } else {
            milestones.useFallback(id)
            guard let undelivered, !fallbackInFlight.contains(id) else { return }
            fallbackInFlight.insert(id)
            Task {
                let delivered = await undelivered(entry.event)
                fallbackInFlight.remove(id)
                if delivered { alerted.insert(id); milestones.remove(id) }
            }
        }
    }

    private func until(_ token: String) -> Date? { [pausedUntil, tokenPausedUntil[token]].compactMap { $0 }.max() }

    private func enqueue(_ push: LiveActivityPush) {
        if let until = until(push.token), Date() < until {
            queue(push); scheduleFlush(at: until); return
        }
        if inFlight.contains(push.token) { queue(push); return }
        inFlight.insert(push.token)
        Task { await send(push) }
    }

    private func queue(_ push: LiveActivityPush, retry: Bool = false) {
        var pending = waiting[push.token] ?? []
        if push.kind == .end {
            for old in pending { resolved(old, .failed) }
            pending = [push]
        } else if pending.contains(where: { $0.kind == .end }) {
            resolved(push, .failed)
            return
        } else if push.alertEventId != nil {
            // A retry goes in front of newer milestones. A status can update its content, never its identity.
            if let index = pending.firstIndex(where: { $0.alertEventId == push.alertEventId }) { pending[index] = push }
            else if retry, let newest = pending.first, newest.alertEventId == nil {
                pending[0] = LiveActivityPush.carryingAlert(of: push, into: newest)
            } else if retry { pending.insert(push, at: 0) }
            else { pending.append(push) }
        } else if retry, !pending.isEmpty {
            // The waiting state arrived while this request was in flight; never replace it with
            // this older state, including after the older milestone loses its alert.
            return
        } else if !pending.isEmpty {
            pending[pending.count - 1] = LiveActivityPush.carryingAlert(of: pending.last, into: push)
        } else { pending.append(push) }
        waiting[push.token] = pending
    }

    private func drain(_ token: String) {
        guard !inFlight.contains(token), var pending = waiting[token], !pending.isEmpty else { return }
        if let until = until(token), Date() < until { scheduleFlush(at: until); return }
        let next = pending.removeFirst()
        waiting[token] = pending.isEmpty ? nil : pending
        enqueue(next)
    }

    private func scheduleFlush(at date: Date) {
        if let flushAt, flushAt <= date { return }
        flushAt = date
        flushTask?.cancel()
        flushTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0.01, date.timeIntervalSinceNow)))
            guard !Task.isCancelled, let self, self.flushAt == date else { return }
            self.flushAt = nil
            for token in Array(self.waiting.keys) { self.drain(token) }
        }
    }

    private func withoutAlert(_ push: LiveActivityPush) -> LiveActivityPush {
        // Starts require their own alert, and pauses/ends keep their original priority. Only a
        // milestone's optional alert participates in the fallback decision.
        guard push.alertEventId != nil else { return push }
        resolved(push, .failed)
        var plain = push
        plain.alert = nil; plain.alertEventId = nil; plain.alertDeviceId = nil; plain.priority = 5
        return plain
    }

    private func send(_ push: LiveActivityPush) async {
        defer { inFlight.remove(push.token); drain(push.token) }
        guard enabled, let endpoint, let body = try? JSONEncoder().encode(push) else { resolved(push, .failed); return }
        let attempt: Int
        if let id = push.alertEventId, let device = push.alertDeviceId {
            attempt = milestones.attempt(id, device: device)
            guard attempt <= 3 else { resolved(push, .failed); return }
        } else { attempt = 0 }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        guard let (data, response) = try? await session.data(for: request), let http = response as? HTTPURLResponse else {
            let count = (failures[push.token] ?? 0) + 1
            if let wait = RelayRetry.delay(failures: count, kind: push.kind) {
                failures[push.token] = count
                let until = Date().addingTimeInterval(wait)
                tokenPausedUntil[push.token] = max(until, tokenPausedUntil[push.token] ?? until)
                queue(attempt > 0 && attempt >= 3 ? withoutAlert(push) : push, retry: true)
                scheduleFlush(at: until)
                lastResult = "The relay couldn't be reached; trying again soon."
            } else {
                failures[push.token] = nil; _ = withoutAlert(push)
                lastResult = "The relay couldn't be reached."
            }
            return
        }
        failures[push.token] = nil
        let retry = Double(http.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 60
        switch http.statusCode {
        case 200:
            resolved(push, .succeeded)
            lastResult = "Working"
        case 410:
            dead.insert(push.token); _ = withoutAlert(push)
            lastResult = "A phone's Live Activity ended."
        case 429:
            let scope = (try? JSONDecoder().decode([String: JSONValue].self, from: data))?["scope"]?.string ?? "token-interval"
            let until = Date().addingTimeInterval(max(retry, 1))
            if scope.hasPrefix("token") || scope == "apns" { tokenPausedUntil[push.token] = until } else { pausedUntil = until }
            queue(retry <= 30 && scope == "token-interval" && attempt < 3 ? push : withoutAlert(push), retry: true)
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
            // A short busy response is retryable just like the token-interval limit. Keep
            // its milestone pending until the bounded attempts finish; an unconfigured
            // relay or a long wait still resolves this recipient promptly.
            let retryMilestone = error != "not_configured" && retry <= 30 && attempt > 0 && attempt < 3
            queue(retryMilestone ? push : withoutAlert(push), retry: true)
            if let pausedUntil { scheduleFlush(at: pausedUntil) }
        default:
            _ = withoutAlert(push)
            lastResult = "The relay refused an update (\(http.statusCode))."
        }
    }
}
