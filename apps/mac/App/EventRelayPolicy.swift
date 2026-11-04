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
    var attributes: Attributes?
    var contentState: ContentState
    var staleDate: Int?
    var priority: Int
    var alert: Alert?

    static let states: Set<String> = ["idle", "preparing", "printing", "paused", "finished", "failed", "cancelled", "offline", "busy"]

    /// The push for an event, or nil when the event isn't one the Live Activity shows.
    static func make(for event: CounterpartEvent, token: String, title: String, now: Date) -> LiveActivityPush? {
        let kind: Kind
        var priority = 5
        switch event.type {
        case "print.started": kind = .start; priority = 10
        case "print.status", "print.resumed": kind = .update
        case "print.paused": kind = .update; priority = 10
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
        let state = data?.state.flatMap { states.contains($0) ? $0 : nil } ?? fallbackState
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
        } else if event.notify != "none" && (event.type == "print.paused" || (kind == .end && event.type != "print.not-started")) {
            // "Didn't start" already alerts on its own (handoff item 9: one owner per alert); its activity just ends.
            push.alert = alert(title: event.title, body: event.body, sound: kind == .end ? "default" : nil)
        }
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

/// How long to wait before sending a push again when the relay couldn't be reached, or nil to stop trying. An end has
/// no later update to repair the phone's Live Activity, so it keeps trying for about an hour; a start or an update is
/// soon replaced by the next one.
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
