import ActivityKit
import UIKit
import CounterpartKit

/// Starts locally only in the foreground. Background pushes may update existing activities during
/// their granted runtime; continuous delivery comes from the Mac's APNs relay once configured.
@MainActor final class MobileActivities {
    private weak var app: AppModel?
    private var started = false
    private var watched: Set<String> = []
    private var ignored: Set<String> = []
    private var activityForPrint: [String: String] = [:]
    private var tokens: [String: String] = [:]
    private var removed = Set(UserDefaults.standard.stringArray(forKey: "CounterpartEndedPrintActivities") ?? []) {
        didSet { UserDefaults.standard.set(Array(removed), forKey: "CounterpartEndedPrintActivities") }
    }
    private var startToken: String?
    private var publishing = false
    private var publishAgain = false
    private var lastPublished: String?
    private var dismissed = Set(UserDefaults.standard.stringArray(forKey: "CounterpartDismissedPrintActivities") ?? [])
    private var boundDevice = UserDefaults.standard.string(forKey: "CounterpartActivityDevice")

    func attach(_ app: AppModel) {
        #if DEBUG
        guard Fixtures.folder == nil else { return }
        #endif
        self.app = app
        guard let device = try? app.pairing.store.read()?.deviceId else { return }
        if let boundDevice, boundDevice != device {
            tokens = [:]; removed = []; lastPublished = nil; watched = []; activityForPrint = [:]
            for activity in Activity<PrintAttributes>.activities {
                ignored.insert(activity.id)
                Task { await activity.end(nil, dismissalPolicy: .immediate) }
            }
        }
        boundDevice = device; UserDefaults.standard.set(device, forKey: "CounterpartActivityDevice")
        guard !started else { Task { await publish() }; return }
        started = true
        for activity in Activity<PrintAttributes>.activities { watch(activity) }
        Task { [weak self] in
            for await activity in Activity<PrintAttributes>.activityUpdates { self?.watch(activity) }
        }
        Task { [weak self] in
            for await token in Activity<PrintAttributes>.pushToStartTokenUpdates {
                self?.startToken = Self.hex(token)
                await self?.publish()
            }
        }
    }

    func reconcile(_ snapshots: [PrintActivitySnapshot], mayStart: Bool) async {
        guard let app, !app.needsMac, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        for snapshot in snapshots {
            let content = ActivityContent(state: snapshot.content, staleDate: snapshot.observedAt.addingTimeInterval(5 * 60))
            if let activity = Activity<PrintAttributes>.activities.first(where: { $0.attributes.printId == snapshot.attributes.printId }) {
                if snapshot.content.terminal {
                    await activity.end(content, dismissalPolicy: .after(Date().addingTimeInterval(4 * 60 * 60)), timestamp: snapshot.observedAt)
                    tokens[snapshot.attributes.printId] = nil; removed.insert(snapshot.attributes.printId)
                } else { await activity.update(content, timestamp: snapshot.observedAt) }
            } else if snapshot.shouldStart(foreground: mayStart && UIApplication.shared.applicationState == .active, dismissed: dismissed) {
                // The system can refuse when disabled, at capacity, or when the app loses foreground.
                // Printing remains independent of the activity's availability.
                if let activity = try? Activity.request(attributes: snapshot.attributes, content: content, pushType: .token) { watch(activity) }
            }
        }
        Task { await publish() }
    }

    private func watch(_ activity: Activity<PrintAttributes>) {
        let print = activity.attributes.printId
        guard !ignored.contains(activity.id), !watched.contains(activity.id) else { return }
        // A remote start can race the foreground start for the same print. Keep one surface and one
        // update token, and respect a prior dismissal even if its remote start arrived late.
        if dismissed.contains(print) || activityForPrint[print].map({ $0 != activity.id }) == true {
            ignored.insert(activity.id)
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
            return
        }
        watched.insert(activity.id); activityForPrint[print] = activity.id
        let owner = boundDevice
        if let token = activity.pushToken { tokens[print] = Self.hex(token) }
        Task { [weak self] in
            for await token in activity.pushTokenUpdates {
                guard self?.boundDevice == owner else { break }
                guard activity.activityState == .active || activity.activityState == .stale else { break }
                self?.tokens[print] = Self.hex(token); self?.removed.remove(print)
                await self?.publish()
            }
        }
        Task { [weak self] in
            for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
                guard self?.boundDevice == owner else { break }
                self?.tokens[print] = nil; self?.removed.insert(print)
                self?.activityForPrint[print] = nil
                self?.dismissed.insert(print)
                if let self { UserDefaults.standard.set(Array(self.dismissed.sorted().suffix(256)), forKey: "CounterpartDismissedPrintActivities") }
                await self?.publish(); break
            }
        }
    }

    /// Serializes complete token snapshots, retries failures on the next foreground/data update,
    /// and never logs tokens. LAN registration is authenticated; CloudKit stays in the private zone.
    func publish() async {
        guard let app, !app.needsMac, let device = try? app.pairing.store.read()?.deviceId else { return }
        guard startToken != nil || !tokens.isEmpty || !removed.isEmpty else { return }
        guard !publishing else { publishAgain = true; return }
        publishing = true
        defer {
            publishing = false
            if publishAgain { Task { await publish() } }
        }
        func sameDevice() -> Bool { (try? app.pairing.store.read()?.deviceId) == device }
        repeat {
            publishAgain = false
            guard sameDevice() else { lastPublished = nil; return }
            let current = tokens, forgotten = removed, push = startToken
            let signature = device + (push ?? "") + current.sorted { $0.key < $1.key }.map { $0.key + $0.value }.joined()
            if lastPublished == signature, forgotten.isEmpty { continue }
            var sent = true
            if let push { do { try await app.companion.registerLiveActivity(pushToStart: push) } catch { sent = false } }
            for (id, token) in current {
                guard sameDevice() else { lastPublished = nil; return }
                do { try await app.companion.registerLiveActivity(printId: id, token: token) } catch { sent = false }
            }
            for id in forgotten {
                guard sameDevice() else { lastPublished = nil; return }
                do { try await app.companion.registerLiveActivity(printId: id, token: nil); removed.remove(id) }
                catch { sent = false }
            }
            guard sameDevice() else { lastPublished = nil; return }
            let cloudSent = await app.cloud.saveActivityTokens(device: device, pushToStart: push, activities: current)
            if sent || cloudSent { lastPublished = signature }
        } while publishAgain
    }

    private static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
}
