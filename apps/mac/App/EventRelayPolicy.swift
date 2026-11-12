import Foundation
import CloudKit
import CounterpartKit
#if canImport(ControlKit)
import ControlKit
#endif

// The rules the event relay (PRD §8.8) follows, kept apart from the I/O so each one is tested on its own.

/// Where the relay reads from next. It survives restarts; a log that was pruned or recreated moves it to the
/// companion's own `next`, so the relay never stalls behind a cursor the log can't serve.
struct EventCursor {
    let defaults: UserDefaults
    static let key = "events.cursor"
    var value: Int? {
        get { defaults.object(forKey: Self.key) as? Int }
        nonmutating set { if let newValue { defaults.set(newValue, forKey: Self.key) } else { defaults.removeObject(forKey: Self.key) } }
    }

    /// The cursor after a page. `resync` is true when the projects must be read again (log pruned or recreated).
    static func advance(from cursor: Int, page: EventsPage) -> (cursor: Int, resync: Bool) {
        if page.reset == true || page.next < cursor { return (page.next, true) }
        return (max(cursor, page.next), page.truncated == true)
    }
}

/// Which events become a Mac notification. Within ten minutes of happening: by the switches in Settings.
/// Older (the Mac was asleep, or Counterpart wasn't running): only a terminal event that still stands, once.
enum CatchUp {
    static let window: TimeInterval = 10 * 60
    /// The events that can still matter after the fact (PRD §8.8).
    static let terminal: Set<String> = ["print.done", "print.failed", "pass.ready", "pass.ask"]

    /// - Parameters:
    ///   - later: the types of later events for the same project in the same read, oldest first.
    ///   - state: the project's state now, when known (`ready`, `needs-closeup`, …).
    static func shouldNotify(_ event: CounterpartEvent, now: Date, prefs: NotificationPrefs, alreadyNotified: Bool,
                             later: [String], state: String?) -> Bool {
        guard event.notify != "none", !alreadyNotified,
              prefs.shouldNotify(type: event.type, progress: event.data?.progress) else { return false }
        let age = event.date.map { now.timeIntervalSince($0) } ?? .infinity
        if age <= window { return true }
        guard terminal.contains(event.type), later.isEmpty else { return false }
        switch event.type {
        case "pass.ready": return state == nil || state == "ready"
        case "pass.ask": return state == nil || state == "needs-closeup"
        default: return true
        }
    }
}

/// Remembers which events were shown, so a restart or a re-read never shows one twice. Keeps the newest 500.
struct NotifiedEvents {
    let defaults: UserDefaults
    static let key = "events.notified"
    func contains(_ id: String) -> Bool { (defaults.stringArray(forKey: Self.key) ?? []).contains(id) }
    func insert(_ id: String) {
        var ids = defaults.stringArray(forKey: Self.key) ?? []
        guard !ids.contains(id) else { return }
        ids.append(id)
        defaults.set(Array(ids.suffix(500)), forKey: Self.key)
    }
}

/// The off-LAN mirror's write rate (PRD §8.8): every event upserts its project, but a print's upserts are capped at
/// one per 60 s unless its state changed.
struct UpsertGate {
    static let interval: TimeInterval = 60
    private var last: [String: (at: Date, state: String)] = [:]

    mutating func allow(projectId: String, printId: String?, state: String, now: Date) -> Bool {
        guard let printId else { return true }
        let key = projectId + "|" + printId
        if let previous = last[key], previous.state == state, now.timeIntervalSince(previous.at) < Self.interval { return false }
        last[key] = (now, state)
        return true
    }
}

/// Commands from the phone through CloudKit (PRD §9.3): only from this user's own private database, and only while
/// they are fresh. Freshness is judged by the server's creation time, never a time the phone wrote.
enum CommandFreshness {
    static let window: TimeInterval = 10 * 60
    static func isFresh(created: Date?, now: Date) -> Bool {
        guard let created else { return false }
        let age = now.timeIntervalSince(created)
        return age <= window && age >= -60 // a minute of clock difference, never the future
    }
}

/// A command the phone wrote, as the Mac runs it: the control method that already does the job, and its params.
struct PhoneCommand: Equatable {
    let id: String
    let type: String
    let projectId: String
    let payload: [String: JSONValue]

    /// Run after this one succeeds: Needs Changes answered away from home carries its words in the `status` record
    /// (`{status: "needs-changes", note}`), sent as a change once the status is set. One record keeps the order;
    /// commands from iCloud run concurrently.
    var followUp: PhoneCommand? {
        guard type == "status", payload["status"] == .string("needs-changes"), case .string(let note)? = payload["note"],
              !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return PhoneCommand(id: id + "-note", type: "correct", projectId: projectId, payload: ["note": .string(note)])
    }

    /// The control method and parameters, or nil for a type this Mac doesn't run (`refusal` says why).
    /// - Parameters:
    ///   - acceptsText: the companion takes a typed answer to an Ask (`capabilities.structuredPasses`).
    ///   - printSettings: the companion takes quality, strength and colour (`capabilities.printSettings`).
    func call(photos: [String] = [], uploadedPhotoNames: [String] = [], acceptsText: Bool = false, printSettings: Bool = false) -> (method: String, params: [String: JSONValue])? {
        var params: [String: JSONValue] = ["id": .string(projectId)]
        switch type {
        case "print":
            if let checked = payload["checked"] { params["checked"] = checked }
            let settings = ["quality", "strength", "colour"].compactMap { key in payload[key].map { (key, $0) } }
            if printSettings {
                for (key, value) in settings { params[key] = value }
            } else if !settings.allSatisfy({ Self.isDefault($0.1, for: $0.0) }) {
                // An older companion refuses the whole request with them, and a print at other settings than the ones
                // chosen is never sent. Standard quality and strength and an automatic colour are what it prints anyway.
                return nil
            }
            return ("objects.print", params)
        case "correct":
            guard case .string(let note)? = payload["note"], !note.isEmpty else { return nil }
            params["note"] = .string(note)
            params["photoNames"] = .array([]) // only photos imported with this command, never the pending pool
            if !photos.isEmpty { params["photos"] = .array(photos.map(JSONValue.string)) }
            return ("objects.correct", params)
        case "answerAsk":
            // A typed answer needs a companion that takes one (an older one refuses the whole request); without it,
            // photos or an explicit best guess still answer, and a typed answer alone can't be sent.
            let text = acceptsText ? payload["text"] : nil
            if payload["text"] != nil, text == nil, photos.isEmpty, payload["bestGuess"] == nil { return nil }
            guard !photos.isEmpty || text != nil || payload["bestGuess"] == .bool(true) else { return nil }
            if let text { params["text"] = text }
            params["bestGuess"] = payload["bestGuess"] ?? .bool(false)
            params["photoNames"] = .array(uploadedPhotoNames.map(JSONValue.string))
            return ("objects.answerCloseup", params)
        case "confirm":
            guard let confirmation = payload["confirmationId"], let answer = payload["answer"] else { return nil }
            params["confirmationId"] = confirmation
            params["answer"] = answer
            return ("objects.answerPrintConfirmation", params)
        case "status":
            // "Did it fit?" answered from the phone's notification (It Works, Needs Changes): the same Project
            // Settings call the Mac's own card makes (`objects.settings.set {id, status}`, PRD §5.4).
            guard case .string(let status)? = payload["status"], ["works", "needs-changes"].contains(status) else { return nil }
            params["status"] = .string(status)
            return ("objects.settings.set", params)
        case "pause": return ("objects.pausePrint", params)
        case "resume": return ("objects.resumePrint", params)
        case "cancel": return ("objects.cancelPrint", params)
        default: return nil
        }
    }

    /// Upload an Ask's assets first and select only the names returned for those exact uploads.
    /// Validation happens before uploading; a failed upload never dispatches an incomplete answer.
    func preparedCall(photos: [String], acceptsText: Bool, printSettings: Bool,
                      addPhoto: (String) async throws -> String) async throws -> (method: String, params: [String: JSONValue])? {
        guard let initial = call(photos: photos, acceptsText: acceptsText, printSettings: printSettings) else { return nil }
        guard type == "answerAsk" else { return initial }
        var uploaded: [String] = []
        for photo in photos { uploaded.append(try await addPhoto(photo)) }
        return call(photos: photos, uploadedPhotoNames: uploaded, acceptsText: acceptsText, printSettings: printSettings)
    }

    /// Why `call` returned nil, in words for the phone.
    var refusal: String {
        switch type {
        case "answerAsk": return payload["text"] != nil ? "Your Mac can't take a typed answer yet. Send a photo, or choose Best Guess."
            : "This answer has no photos or words. Choose photos, answer in words, or use Best Guess."
        case "print": return "Your Mac can't print with those settings yet. Update Counterpart on your Mac, or print at standard settings."
        default: return "This Mac doesn't run \(type) commands."
        }
    }

    private static func isDefault(_ value: JSONValue, for key: String) -> Bool {
        switch key {
        case "quality", "strength": return value == .string("standard")
        case "colour": return value == .object(["auto": .bool(true)])
        default: return false
        }
    }
}

/// The Live Activity relay's request (services/relay/docs.md). `endsAt` is seconds since 2001 (ActivityKit's
/// `Date` coding); `staleDate` is Unix seconds.
struct LiveActivityPush: Encodable, Equatable {
    struct Attributes: Encodable, Equatable { var projectId: String; var printId: String; var title: String; var printerName: String }
    struct ContentState: Encodable, Equatable {
        var state: String
        var progress: Double
        var layer: Int
        var totalLayers: Int
        var endsAt: Double
        var stage: String
        var problem: String?
    }
    struct Alert: Encodable, Equatable { var title: String; var body: String; var sound: String? }
    enum Kind: String, Encodable { case start, update, end }

    var token: String
    var kind: Kind
    /// The milestone event this push's alert announces (never sent): if the alert can't go out promptly, the Mac writes
    /// that event to CloudKit instead, so the phone still gets it as a notification.
    var alertEventId: String?
    var alertDeviceId: String?
    /// The state's priority before an optional milestone alert raised it; never sent.
    var unalertedPriority: Int?
    var attributes: Attributes?
    var contentState: ContentState
    var staleDate: Int?
    var priority: Int
    var alert: Alert?

    private enum CodingKeys: String, CodingKey { case token, kind, attributes, contentState, staleDate, priority, alert }

    static let states: Set<String> = ["idle", "preparing", "printing", "paused", "finished", "failed", "cancelled", "offline", "busy"]

    /// The push for an event, or nil when the event isn't one the Live Activity shows.
    static func make(for event: CounterpartEvent, token: String, title: String, now: Date) -> LiveActivityPush? {
        let kind: Kind
        var priority = 5
        switch event.type {
        case "print.started": kind = .start; priority = 10
        // A milestone moves the activity like any status; its alert is added only by `MilestoneAlert` (sent once,
        // never replayed by `LiveActivityRecovery`).
        case "print.status", "print.resumed", "print.first-layer", "print.milestone": kind = .update
        case "print.paused": kind = .update; priority = 10
        // #630: the activity shows the line (data.problems); CloudKit owns the alert with its frame.
        case "print.check": kind = .update; priority = 10
        // A print the printer never started ends its activity too, or it stays at 0% "Waiting for an update".
        case "print.done", "print.failed", "print.cancelled", "print.not-started": kind = .end; priority = 10
        default: return nil
        }
        // Push-to-start requires an alert. Muted projects can still update an activity started on the phone.
        if kind == .start && event.notify == "none" { return nil }
        let data = event.data
        let fallbackState: String
        switch event.type {
        case "print.done": fallbackState = "finished"
        case "print.failed", "print.not-started": fallbackState = "failed"
        case "print.cancelled": fallbackState = "cancelled"
        case "print.paused": fallbackState = "paused"
        case "print.started": fallbackState = "preparing"
        default: fallbackState = "printing"
        }
        // The terminal event belongs to this print; its last printer report may still say preparing/printing.
        let state = kind == .end ? fallbackState : data?.state.flatMap { states.contains($0) ? $0 : nil } ?? fallbackState
        let ends = data?.endsAt.flatMap(CounterpartEvent.parse)
            ?? data?.remainingSec.map { now.addingTimeInterval($0) } ?? now
        let content = ContentState(state: state, progress: min(100, max(0, kind == .end && state == "finished" ? 100 : data?.progress ?? 0)),
                                   layer: data?.layer ?? 0, totalLayers: data?.totalLayers ?? 0,
                                   endsAt: ends.timeIntervalSinceReferenceDate.rounded(), stage: clip(data?.stage ?? "", 80),
                                   problem: data?.problems?.first.map { clip($0.message, 200) })
        let name = clip(event.printerName ?? "Your printer", 80)
        var push = LiveActivityPush(token: token.lowercased(), kind: kind, attributes: nil, contentState: content,
                                    staleDate: kind == .end ? nil : Int(ends.addingTimeInterval(10 * 60).timeIntervalSince1970), priority: priority, alert: nil)
        if kind == .start, let printId = event.printId, let projectId = event.projectId {
            let shortTitle = clip(title, 80)
            push.attributes = Attributes(projectId: projectId, printId: printId, title: shortTitle, printerName: name)
            push.alert = alert(title: "\(shortTitle) is printing", body: "On \(name)")
        } else if kind == .start {
            return nil
        }
        // CloudKit owns the pause, done and problem alerts with their camera frames; an update/end alert here would be a
        // second banner for the same event. Progress milestones alert on the activity instead (`MilestoneAlert`).
        return push
    }

    /// A newer update replaces an older one but keeps its milestone alert, so the alert isn't lost behind a status.
    /// An end drops it: the "done" or problem notification follows.
    static func carryingAlert(of older: LiveActivityPush?, into newer: LiveActivityPush) -> LiveActivityPush {
        guard let older, older.alertEventId != nil, newer.alertEventId == nil, newer.kind == .update else { return newer }
        var push = newer
        push.unalertedPriority = newer.priority
        push.alert = older.alert; push.alertEventId = older.alertEventId; push.alertDeviceId = older.alertDeviceId; push.priority = 10
        return push
    }

    /// Title and body, 200 Unicode scalars together, no control characters.
    static func alert(title: String, body: String, sound: String? = nil) -> Alert {
        let cleanTitle = clip(title, 120)
        let room = max(0, 200 - cleanTitle.unicodeScalars.count)
        return Alert(title: cleanTitle, body: clip(body, room), sound: sound)
    }

    static func clip(_ text: String, _ limit: Int) -> String {
        let clean = String(String.UnicodeScalarView(text.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : $0 }))
        guard clean.unicodeScalars.count > limit else { return clean }
        return String(String.UnicodeScalarView(clean.unicodeScalars.prefix(max(0, limit - 1)))) + "…"
    }
}

/// A start can reach a locked phone before its update token reaches the Mac. Retain the latest state
/// so late tokens still receive progress or an end, including after a companion restart. No tokens are stored here.
struct LiveActivityRecovery {
    private struct Entry: Codable { var event: CounterpartEvent; var title: String }
    private static let key = "relay.latestPrintEvents"
    private let defaults: UserDefaults
    private var entries: [String: Entry]
    private var queued: Set<String> = []

    init(defaults: UserDefaults) {
        self.defaults = defaults
        entries = defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([String: Entry].self, from: $0) } ?? [:]
    }

    mutating func record(_ event: CounterpartEvent, title: String, now: Date) {
        guard let id = event.printId,
              event.type == "print.started" || LiveActivityPush.make(for: event, token: "aa", title: title, now: now) != nil else { return }
        // A retry replaces this project's previous print. Keep its end until its token arrives too.
        if event.type == "print.started", let project = event.projectId {
            for (oldID, entry) in entries where oldID != id && entry.event.projectId == project {
                guard LiveActivityPush.make(for: entry.event, token: "aa", title: entry.title, now: now)?.kind != .end else { continue }
                entries[oldID]?.event = CounterpartEvent(seq: event.seq, id: "superseded:\(event.id):\(oldID)", at: event.at,
                    type: "print.cancelled", projectId: project, printId: oldID, printerName: entry.event.printerName,
                    title: entry.event.title, body: "A newer print replaced this one.", notify: "none")
            }
        }
        // A late status must not turn a terminal print back into an active surface.
        if let previous = entries[id], LiveActivityPush.make(for: previous.event, token: "aa", title: previous.title, now: now)?.kind == .end { return }
        entries[id] = Entry(event: event, title: title)
        entries = entries.filter { now.timeIntervalSince($0.value.event.date ?? .distantPast) < 24 * 60 * 60 }
        entries = Dictionary(uniqueKeysWithValues: entries.sorted { ($0.value.event.date ?? .distantPast) > ($1.value.event.date ?? .distantPast) }.prefix(256).map { ($0.key, $0.value) })
        defaults.set(try? JSONEncoder().encode(entries), forKey: Self.key)
        // One event/token pair is queued once per process. LiveActivityRelay owns network retries.
        queued = queued.filter { key in entries.values.contains { key.hasSuffix("|" + $0.event.id) } }
    }

    mutating func pushes(tokens: [LiveActivityTokens.Activity], now: Date) -> [LiveActivityPush] {
        var pushes: [LiveActivityPush] = []
        for token in tokens {
            guard let entry = entries[token.printId], now.timeIntervalSince(entry.event.date ?? .distantPast) < 24 * 60 * 60 else { continue }
            let key = token.token.lowercased() + "|" + entry.event.id
            guard !queued.contains(key) else { continue }
            guard var push = LiveActivityPush.make(for: entry.event, token: token.token, title: entry.title, now: now) else { continue }
            if push.kind == .start {
                // This is an existing activity's update token, never the push-to-start token.
                push.kind = .update; push.attributes = nil; push.alert = nil; push.priority = 5
            }
            queued.insert(key)
            pushes.append(push)
        }
        return pushes
    }
}

/// Whether the relay is on (David, Nov 8: on by default in production-signed Mac builds). A choice made in Settings
/// always wins. Development-signed builds stay off by default: their phones' tokens are Sandbox ones, which the production
/// relay would reject (and deny for 30 days).
enum RelayDefault {
    static func enabled(stored: Bool?, apsEnvironment: String?) -> Bool { stored ?? (apsEnvironment == "production") }
}

/// David, Nov 8: while a print's Live Activity is running, its progress milestones (first layer, 50%, …) arrive as an
/// alert on the activity (`update(_:alertConfiguration:)`; the relay's APNs `alert`) instead of a separate notification.
/// Pauses, problems and "done" stay notifications (CloudKit, with their camera frames). A milestone is a separate
/// notification when the relay is off or any known paired device lacks this print's activity. Once activity
/// delivery is chosen, account-wide CloudKit fallback is allowed only when every recipient failed.
enum MilestoneAlert {
    static let types: Set<String> = ["print.first-layer", "print.milestone"]

    /// The activity tokens to alert, or nil when the milestone goes as a notification instead.
    static func tokens(for event: CounterpartEvent, relayOn: Bool, local: LiveActivityTokens, cloud: LiveActivityTokens,
                       dead: Set<String>, pairedDeviceIds: Set<String>? = nil) -> [LiveActivityTokens.Activity]? {
        guard relayOn, types.contains(event.type), event.notify != "none", let printId = event.printId else { return nil }
        // Select one current token per device. LAN and CloudKit can contain different generations.
        var newest: [String: LiveActivityTokens.Activity] = [:]
        for activity in local.activities + cloud.activities where activity.printId == printId {
            if let old = newest[activity.deviceId], old.updatedAt >= activity.updatedAt { continue }
            newest[activity.deviceId] = activity
        }
        let activities = newest.values.filter { !dead.contains($0.token.lowercased()) }
        guard !activities.isEmpty else { return nil }
        let registered = Set((local.pushToStart + cloud.pushToStart).map(\.deviceId))
            .union((local.activities + cloud.activities).map(\.deviceId))
        let devices: Set<String>
        if let pairedDeviceIds { devices = pairedDeviceIds.union(registered) }
        else {
            // An unavailable device list cannot prove a multi-device account is fully covered.
            guard registered.count == 1 else { return nil }
            devices = registered
        }
        guard devices.isSubset(of: Set(activities.map(\.deviceId))) else { return nil }
        return activities.sorted { $0.deviceId < $1.deviceId }
    }

    /// The update that moves the activity to the milestone and alerts with the notification's own words. Priority 10:
    /// Apple sends an alerting update at once. A passive milestone (the first layer) lights the screen without a sound.
    static func push(for event: CounterpartEvent, token: String, title: String, now: Date, deviceId: String? = nil) -> LiveActivityPush? {
        guard types.contains(event.type), var push = LiveActivityPush.make(for: event, token: token, title: title, now: now) else { return nil }
        push.unalertedPriority = push.priority
        push.priority = 10
        push.alert = LiveActivityPush.alert(title: event.title, body: event.body, sound: event.notify == "passive" ? nil : "default")
        push.alertEventId = event.id
        push.alertDeviceId = deviceId
        return push
    }
}

/// A durable outbox, written before acknowledging the event cursor. The transport and recipient devices
/// are fixed for a milestone; no tokens are persisted. Results and retry counts survive process restarts.
struct MilestoneDeliveries {
    enum Outcome: String, Codable { case pending, succeeded, failed }
    struct Entry: Codable {
        var event: CounterpartEvent
        var title: String
        var outcomes: [String: Outcome]
        var attempts: [String: Int] = [:]
        var fallback = false
        var firstQueuedAt: Date?
        var complete: Bool { !outcomes.values.contains(.pending) }
        var hasSuccess: Bool { outcomes.values.contains(.succeeded) }
    }
    private static let key = "relay.pendingMilestones"
    private let defaults: UserDefaults
    private(set) var entries: [String: Entry]
    init(defaults: UserDefaults) {
        self.defaults = defaults
        entries = defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([String: Entry].self, from: $0) } ?? [:]
    }
    mutating func begin(_ event: CounterpartEvent, title: String, devices: [String], now: Date) {
        guard entries[event.id] == nil else { return }
        entries[event.id] = Entry(event: event, title: title, outcomes: Dictionary(uniqueKeysWithValues: devices.map { ($0, .pending) }), firstQueuedAt: now)
        save()
    }
    mutating func attempt(_ id: String, device: String) -> Int {
        let count = (entries[id]?.attempts[device] ?? 0) + 1
        entries[id]?.attempts[device] = count; save()
        return count
    }
    mutating func resolve(_ id: String, device: String, outcome: Outcome) {
        guard entries[id]?.outcomes[device] == .pending else { return }
        entries[id]?.outcomes[device] = outcome; save()
    }
    mutating func useFallback(_ id: String) { entries[id]?.fallback = true; save() }
    mutating func remove(_ id: String) { entries[id] = nil; save() }
    private func save() { defaults.set(try? JSONEncoder().encode(entries), forKey: Self.key) }
}

/// Milestones whose recipient decision (or confirmed CloudKit fallback) completed. Keeps the newest 200.
struct AlertedMilestones {
    let defaults: UserDefaults
    static let key = "relay.alertedMilestones"
    func contains(_ id: String) -> Bool { (defaults.stringArray(forKey: Self.key) ?? []).contains(id) }
    func insert(_ id: String) {
        var ids = defaults.stringArray(forKey: Self.key) ?? []
        guard !ids.contains(id) else { return }
        ids.append(id)
        defaults.set(Array(ids.suffix(200)), forKey: Self.key)
    }
}

/// How long to wait before resending when the relay cannot be reached. An end keeps trying for about an hour;
/// starts and updates are soon replaced by newer state.
enum RelayRetry {
    static func delay(failures: Int, kind: LiveActivityPush.Kind) -> TimeInterval? {
        guard failures >= 1, failures <= (kind == .end ? 10 : 3) else { return nil }
        return min(900, 15 * pow(2, Double(failures - 1)))
    }
}

/// The printer MCP's confirmation as `CounterpartProject` carries it (docs/protocols/cloudkit.md): the phone away from
/// home answers it with `confirm`, which needs its exact id and every required field.
enum MirroredConfirmation {
    /// `[{name, title, description?, required}]`, as JSON text.
    static func fieldsJSON(_ fields: [Project.PrintConfirmation.Field]) -> String? {
        let list: [[String: JSONValue]] = fields.map { field in
            var item: [String: JSONValue] = ["name": .string(field.name), "title": .string(field.title), "required": .bool(field.required)]
            if let description = field.description { item["description"] = .string(description) }
            return item
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return (try? encoder.encode(list)).flatMap { String(data: $0, encoding: .utf8) }
    }
}

/// Whether a `print.started` may still start a Live Activity: only while that same print is still running. After a
/// restart the log replays starts for prints that have since ended, and an activity started then would never end.
enum LiveActivityStart {
    static func stillRunning(_ event: CounterpartEvent, project: Project?) -> Bool {
        guard let project, let printId = event.printId, project.print?.printId == printId, project.state == .printing else { return false }
        return project.print?.monitor?.phase != "ended"
    }
}

/// The `CounterpartMac` record (PRD §5.10, docs/protocols/cloudkit.md): this Mac, published so a phone on the same
/// Apple Account finds it and enrols by itself. Rewritten on launch, whenever the addresses change, and every 5 minutes
/// while the app runs (each write carries a fresh enrolment token).
enum MacPublication {
    static let interval: TimeInterval = 5 * 60

    /// The record's fields. `addresses` is JSON text: `[{kind, host, port?}]`, in the order the phone should try them.
    static func fields(_ enrolment: ICloudEnrolment, name: String, now: Date) -> [String: CKRecordValueProtocol] {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let addresses = (try? encoder.encode(enrolment.addresses)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        var fields: [String: CKRecordValueProtocol] = [
            "macId": enrolment.macId, "name": name, "addresses": addresses, "spkiSha256": enrolment.spkiSha256,
            "enrolmentToken": enrolment.token, "updatedAt": now,
        ]
        if let expires = enrolment.expiresAtDate { fields["tokenExpiresAt"] = expires }
        return fields
    }

    /// Whether to write it now: never written, 5 minutes since, the addresses changed, or the token runs out within
    /// the next interval.
    static func isDue(lastWritten: Date?, lastAddresses: String?, addresses: String, tokenExpires: Date?, now: Date) -> Bool {
        guard let lastWritten else { return true }
        if addresses != lastAddresses { return true }
        if let tokenExpires, tokenExpires.timeIntervalSince(now) < interval { return true }
        return now.timeIntervalSince(lastWritten) >= interval
    }
}
