import Foundation
import AppKit
import CloudKit
import ImageIO
import UniformTypeIdentifiers
#if canImport(ControlKit)
import ControlKit
#endif

/// The phone's view of this Mac away from home (PRD §8.8, §9.3, §12; docs/protocols/cloudkit.md): `CounterpartEvent`
/// and `CounterpartProject` records in the user's private database (zone `Counterpart`, container
/// `iCloud.com.scantomake.counterpart`), the `CounterpartCommand` records the phone writes back, and the phone's Live
/// Activity tokens in `CounterpartDevice` records. Everything stays in the user's own iCloud.
///
/// Nothing is lost to a bad moment: an event or project that iCloud refuses waits in a queue that survives restarts,
/// and a command's result waits until iCloud has it. A build without the iCloud entitlement (unsigned, a test variant,
/// or before the container exists) never touches CloudKit: constructing a container it isn't entitled to would stop the app.
@MainActor final class CloudSync {
    static let containerId = "iCloud.com.scantomake.counterpart"
    static let zoneId = CKRecordZone.ID(zoneName: "Counterpart", ownerName: CKCurrentUserDefaultName)
    static let subscriptionId = "mac-zone"

    enum Status: Equatable { case off(String), starting, on, failed(String) }
    private(set) var status: Status = CloudSync.entitled ? .starting : .off("This build of Counterpart isn't signed for iCloud.")
    private var database: CKDatabase?
    private var zoneReady = false
    private var subscribed = false
    private var runCommand: ((PhoneCommand, [String]) async -> (Bool, String))?
    private var fetching = false
    private var fetchAgain = false
    private let defaults = UserDefaults.standard
    /// Live Activity tokens the phone sent through iCloud while away from home, by device. Kept with the zone's
    /// change token, so a restart (which reads only what changed since) still has them.
    private(set) var deviceTokens: LiveActivityTokens = UserDefaults.standard.data(forKey: "cloud.deviceTokens")
        .flatMap { try? JSONDecoder().decode(LiveActivityTokens.self, from: $0) } ?? LiveActivityTokens() {
        didSet { defaults.set(try? JSONEncoder().encode(deviceTokens), forKey: "cloud.deviceTokens") }
    }
    private var lastRead: Date?
    private var readFailed = false
    private var flushing = false
    private var flushAgain = false

    /// Whether this build carries the container in its iCloud entitlement.
    nonisolated static var entitled: Bool {
        guard let task = SecTaskCreateFromSelf(nil),
              let value = SecTaskCopyValueForEntitlement(task, "com.apple.developer.icloud-container-identifiers" as CFString, nil) else { return false }
        return (value as? [String])?.contains(containerId) == true
    }

    func start(runCommand: @escaping (PhoneCommand, [String]) async -> (Bool, String)) {
        self.runCommand = runCommand
        guard Self.entitled else { return }
        database = CKContainer(identifier: Self.containerId).privateCloudDatabase
        NSApp.registerForRemoteNotifications()
        Task {
            await prepare()
            fetchCommands()
        }
    }

    /// The zone, then the zone subscription; each is retried until it exists.
    private func prepare() async {
        guard let database else { return }
        if !zoneReady {
            do {
                let result = try await database.modifyRecordZones(saving: [CKRecordZone(zoneID: Self.zoneId)], deleting: [])
                if case .failure(let error)? = result.saveResults[Self.zoneId] { throw error }
                zoneReady = true
            } catch { status = .failed(Self.sentence(error)); return }
        }
        if !subscribed {
            // One content-available push for any change in the zone: commands and the phone's device tokens.
            let subscription = CKRecordZoneSubscription(zoneID: Self.zoneId, subscriptionID: Self.subscriptionId)
            let info = CKSubscription.NotificationInfo()
            info.shouldSendContentAvailable = true
            subscription.notificationInfo = info
            do {
                let result = try await database.modifySubscriptions(saving: [subscription], deleting: [])
                if case .failure(let error)? = result.saveResults[Self.subscriptionId] { throw error }
                subscribed = true
            } catch { status = .failed(Self.sentence(error)); return }
        }
        if case .starting = status { status = .on }
    }

    static func sentence(_ error: Error) -> String {
        switch (error as? CKError)?.code {
        case .notAuthenticated?: return "Sign in to iCloud on this Mac to reach your phone away from home."
        case .quotaExceeded?: return "Your iCloud storage is full."
        case .networkUnavailable?, .networkFailure?: return "iCloud can't be reached right now. Counterpart catches up when it can."
        default: return "iCloud didn't accept an update. Counterpart tries again."
        }
    }

    /// Called on every relay cycle: retry what iCloud refused, and run the daily sweep when it's due.
    func tick(projects: [String: StmObject]) async {
        guard database != nil else { return }
        await prepare()
        await retryPending(projects: projects)
        await flushResults()
        await sweepIfDue()
        // Pushes can be late or lost: read the zone at least once a minute, and soon after a failed read.
        if readFailed || lastRead.map({ Date().timeIntervalSince($0) > 60 }) ?? true { fetchCommands() }
    }

    // MARK: Events and projects

    private struct Pending: Codable { var event: CounterpartEvent; var frame: String? }
    private var pendingEvents: [Pending] {
        get { defaults.data(forKey: "cloud.pendingEvents").flatMap { try? JSONDecoder().decode([Pending].self, from: $0) } ?? [] }
        set { defaults.set(try? JSONEncoder().encode(Array(newValue.suffix(500))), forKey: "cloud.pendingEvents") }
    }
    private var pendingProjects: Set<String> {
        get { Set(defaults.stringArray(forKey: "cloud.pendingProjects") ?? []) }
        set { defaults.set(Array(newValue), forKey: "cloud.pendingProjects") }
    }

    /// Saves the event, or keeps it to try again.
    func save(_ event: CounterpartEvent, frame: URL?) async {
        guard database != nil else { return }
        if await !write(event, frame: frame) { pendingEvents.append(Pending(event: event, frame: frame?.path)) }
    }

    private func write(_ event: CounterpartEvent, frame: URL?) async -> Bool {
        guard let database else { return false }
        await prepare()
        let record = CKRecord(recordType: "CounterpartEvent", recordID: CKRecord.ID(recordName: event.id, zoneID: Self.zoneId))
        record["eventId"] = event.id
        record["seq"] = event.seq
        record["type"] = event.type
        record["projectId"] = event.projectId
        record["printId"] = event.printId
        record["title"] = event.title
        record["body"] = event.body
        record["notify"] = event.notify
        record["progress"] = event.data?.progress
        record["remainingSec"] = event.data?.remainingSec
        record["confirmationId"] = event.data?.confirmationId
        record["expiresAt"] = event.data?.expiresAt.flatMap(CounterpartEvent.parse)
        record["createdAt"] = event.date ?? Date()
        var temporary: URL?
        if let frame, let jpeg = Self.frameJPEG(frame) {
            temporary = jpeg
            record["frame"] = CKAsset(fileURL: jpeg)
        }
        defer { if let temporary { try? FileManager.default.removeItem(at: temporary) } }
        do {
            try Self.check(try await database.modifyRecords(saving: [record], deleting: [], savePolicy: .allKeys))
            remember(event: event.id, at: event.date ?? Date())
            if case .failed = status { status = .on }
            return true
        } catch {
            status = .failed(Self.sentence(error))
            return false
        }
    }

    /// Upserts each project's summary, or keeps its id to send again with whatever it is by then.
    func mirror(_ projects: [StmObject]) async {
        guard database != nil, !projects.isEmpty else { return }
        pendingProjects.formUnion(await upsert(projects))
    }

    private func retryPending(projects: [String: StmObject]) async {
        let events = pendingEvents
        if !events.isEmpty {
            var left: [Pending] = []
            for item in events where await !write(item.event, frame: item.frame.map(URL.init(fileURLWithPath:))) { left.append(item) }
            pendingEvents = left
        }
        let ids = pendingProjects
        if !ids.isEmpty {
            let current = ids.compactMap { projects[$0] }
            // Gone from the Mac: nothing to send. The rest stay only if they failed again.
            pendingProjects = current.isEmpty ? [] : await upsert(current)
        }
    }

    /// Title, state, words, the open question, print progress, and the thumbnail only when it changed. Returns the ids
    /// that weren't saved, to send again.
    private func upsert(_ projects: [StmObject]) async -> Set<String> {
        guard let database else { return Set(projects.map(\.id)) }
        await prepare()
        var temporary: [URL] = []
        defer { temporary.forEach { try? FileManager.default.removeItem(at: $0) } }
        var thumbnails: [String: String] = [:]
        let records: [CKRecord] = projects.map { project in
            let words = project.words
            let record = CKRecord(recordType: "CounterpartProject", recordID: CKRecord.ID(recordName: project.id, zoneID: Self.zoneId))
            record["projectId"] = project.id
            record["title"] = words.title
            record["state"] = words.stage.rawValue
            record["stateText"] = words.status
            record["updatedAt"] = Date(timeIntervalSince1970: project.updatedAtMs / 1000)
            record["openAsk"] = words.group == .needsYou ? words.question : nil
            // The printer MCP's own question, whole, so the phone away from home can answer it (`confirm` needs its
            // exact id and every required field). Cleared once it is answered or gone.
            let confirmation = project.printConfirmation
            record["confirmationId"] = confirmation?.id
            record["confirmationMessage"] = confirmation?.message
            record["confirmationExpiresAt"] = confirmation.map { Date(timeIntervalSince1970: $0.expiresAtMs / 1000) }
            record["confirmationSupported"] = confirmation.map { $0.supported ? 1 : 0 }
            record["confirmationFields"] = confirmation.flatMap { MirroredConfirmation.fieldsJSON($0.fields) }
            if let print = project.print {
                record["printId"] = print.printId
                record["printerName"] = print.destination?.name
                record["printState"] = print.live?.state ?? print.printerStatus?.state
                record["progress"] = print.live?.job?.progress ?? print.printerStatus?.percent
                record["remainingSec"] = print.live?.job?.remainingSec ?? print.printerStatus?.remainingMinutes.map { $0 * 60 }
                record["endsAt"] = print.live?.endsAt.flatMap(CounterpartEvent.parse)
            }
            if let render = project.renderURLs.first, let version = Self.version(render), defaults.string(forKey: "cloud.thumb.\(project.id)") != version,
               let jpeg = Self.frameJPEG(render, longEdge: 640) {
                temporary.append(jpeg)
                record["thumbnail"] = CKAsset(fileURL: jpeg)
                thumbnails[project.id] = version
            }
            return record
        }
        var failed: Set<String> = []
        // CloudKit takes at most 400 records a request.
        for chunk in stride(from: 0, to: records.count, by: 200).map({ Array(records[$0..<min($0 + 200, records.count)]) }) {
            do {
                // `.changedKeys` leaves the last thumbnail in place when this upsert doesn't carry one.
                let result = try await database.modifyRecords(saving: chunk, deleting: [], savePolicy: .changedKeys)
                for (id, outcome) in result.saveResults {
                    switch outcome {
                    case .success: if let version = thumbnails[id.recordName] { defaults.set(version, forKey: "cloud.thumb.\(id.recordName)") }
                    case .failure(let error): failed.insert(id.recordName); status = .failed(Self.sentence(error))
                    }
                }
            } catch {
                failed.formUnion(chunk.map(\.recordID.recordName))
                status = .failed(Self.sentence(error))
            }
        }
        return failed
    }

    /// `modifyRecords` returns normally when a single record fails; its results say so. Throws the first failure. A
    /// delete of a record that is already gone counts as done.
    private static func check(_ result: (saveResults: [CKRecord.ID: Result<CKRecord, Error>], deleteResults: [CKRecord.ID: Result<Void, Error>])) throws {
        for outcome in result.saveResults.values { if case .failure(let error) = outcome { throw error } }
        for outcome in result.deleteResults.values {
            if case .failure(let error) = outcome, (error as? CKError)?.code != .unknownItem { throw error }
        }
    }

    private static func version(_ url: URL) -> String? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else { return nil }
        return "\(url.lastPathComponent)#\((attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)#\(attributes[.size] ?? 0)"
    }

    /// A JPEG at most `longEdge` px on its long edge and about 300 KB, made with ImageIO into a temporary file.
    nonisolated static func frameJPEG(_ source: URL, longEdge: Int = 1280, budget: Int = 300_000) -> URL? {
        guard let image = CGImageSourceCreateWithURL(source as CFURL, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(image, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: longEdge] as CFDictionary) else { return nil }
        let target = FileManager.default.temporaryDirectory.appendingPathComponent("counterpart-\(UUID().uuidString).jpg")
        for quality in [0.8, 0.65, 0.5, 0.35] {
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(destination, thumbnail, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { return nil }
            if data.length <= budget || quality == 0.35 {
                return (try? (data as Data).write(to: target)) != nil ? target : nil
            }
        }
        return nil
    }

    // MARK: The daily sweep

    /// Event records this Mac wrote, with when, so the sweep needs no server-side query index.
    private func remember(event id: String, at date: Date) {
        var written = defaults.dictionary(forKey: "cloud.events") as? [String: Double] ?? [:]
        written[id] = date.timeIntervalSince1970
        defaults.set(written, forKey: "cloud.events")
    }

    /// Once a day while the app runs: delete event records older than 7 days, and commands older than a day.
    func sweepIfDue(now: Date = Date()) async {
        guard let database, now.timeIntervalSince1970 - defaults.double(forKey: "cloud.sweptAt") > 86_400 else { return }
        var written = defaults.dictionary(forKey: "cloud.events") as? [String: Double] ?? [:]
        let old = written.filter { now.timeIntervalSince1970 - $0.value > 7 * 86_400 }.map(\.key)
        let commands = (defaults.dictionary(forKey: "cloud.commands") as? [String: Double] ?? [:])
            .filter { now.timeIntervalSince1970 - $0.value > 86_400 }.map(\.key)
        let ids = (old + commands).map { CKRecord.ID(recordName: $0, zoneID: Self.zoneId) }
        guard !ids.isEmpty else { defaults.set(now.timeIntervalSince1970, forKey: "cloud.sweptAt"); return }
        // Only records whose delete went through (or were already gone) are forgotten; the rest are tried next time.
        var deleted: Set<String> = []
        var complete = true
        for chunk in stride(from: 0, to: ids.count, by: 300).map({ Array(ids[$0..<min($0 + 300, ids.count)]) }) {
            do {
                let result = try await database.modifyRecords(saving: [], deleting: chunk)
                for (id, outcome) in result.deleteResults {
                    switch outcome {
                    case .success: deleted.insert(id.recordName)
                    case .failure(let error) where (error as? CKError)?.code == .unknownItem: deleted.insert(id.recordName)
                    case .failure(let error): complete = false; status = .failed(Self.sentence(error))
                    }
                }
            } catch { complete = false; status = .failed(Self.sentence(error)) }
        }
        for id in old where deleted.contains(id) { written.removeValue(forKey: id) }
        defaults.set(written, forKey: "cloud.events")
        var seen = defaults.dictionary(forKey: "cloud.commands") as? [String: Double] ?? [:]
        for id in commands where deleted.contains(id) { seen.removeValue(forKey: id) }
        defaults.set(seen, forKey: "cloud.commands")
        if complete { defaults.set(now.timeIntervalSince1970, forKey: "cloud.sweptAt") } // else tried again on the next tick
    }

    // MARK: Commands and device tokens from the phone (PRD §8.8, §9.3)

    /// On launch, on wake and on each push: read what changed in the zone since last time. A request that arrives
    /// while a read is running makes it read once more before it stops.
    func fetchCommands() {
        guard database != nil else { return }
        guard !fetching else { fetchAgain = true; return }
        fetching = true
        Task {
            repeat {
                fetchAgain = false
                await readChanges()
            } while fetchAgain
            fetching = false
        }
    }

    private func readChanges() async {
        guard let database else { return }
        await prepare()
        let tokenKey = "cloud.zoneToken"
        let token = defaults.data(forKey: tokenKey).flatMap { try? NSKeyedUnarchiver.unarchivedObject(ofClass: CKServerChangeToken.self, from: $0) }
        do {
            var since = token
            var more = true
            while more {
                let changes = try await database.recordZoneChanges(inZoneWith: Self.zoneId, since: since)
                var missed = false
                for (_, result) in changes.modificationResultsByID {
                    guard case .success(let modification) = result else { missed = true; continue }
                    switch modification.record.recordType {
                    case "CounterpartCommand":
                        // Claimed here, once; run apart from the reader, so a command that waits (a pause the printer
                        // asks to confirm) never holds back the next one (the phone's answer to that confirmation).
                        if let photos = claim(modification.record) {
                            let record = modification.record
                            Task { await self.run(record, photos: photos) }
                        }
                    case "CounterpartDevice": take(device: modification.record)
                    default: break
                    }
                }
                // A record that couldn't be read keeps the token where it was, so the next read sees it again.
                if missed { readFailed = true; return }
                since = changes.changeToken
                more = changes.moreComing
                if let since, let data = try? NSKeyedArchiver.archivedData(withRootObject: since, requiringSecureCoding: true) {
                    defaults.set(data, forKey: tokenKey)
                }
            }
            lastRead = Date()
            readFailed = false
        } catch {
            if (error as? CKError)?.code == .changeTokenExpired { defaults.removeObject(forKey: tokenKey) }
            status = .failed(Self.sentence(error))
            readFailed = true
        }
    }

    /// `CounterpartDevice` (docs/protocols/cloudkit.md): the phone's push-to-start token and its activities' tokens.
    private func take(device record: CKRecord) {
        let device = record["deviceId"] as? String ?? record.recordID.recordName
        let updated = ISO8601DateFormatter().string(from: record.modificationDate ?? Date())
        var pushToStart = deviceTokens.pushToStart.filter { $0.deviceId != device }
        var activities = deviceTokens.activities.filter { $0.deviceId != device }
        if let token = record["pushToStartToken"] as? String, !token.isEmpty {
            pushToStart.append(.init(deviceId: device, token: token, updatedAt: updated))
        }
        for pair in record["activityTokens"] as? [String] ?? [] {
            let parts = pair.split(separator: ":", maxSplits: 1).map(String.init)
            if parts.count == 2 { activities.append(.init(printId: parts[0], deviceId: device, token: parts[1], updatedAt: updated)) }
        }
        deviceTokens = LiveActivityTokens(pushToStart: pushToStart, activities: activities)
    }

    /// Claims a new command, once ever, and copies its photos before CloudKit removes its downloads. Nil when the
    /// command was already claimed or already has a result.
    private func claim(_ record: CKRecord) -> [String]? {
        guard record["status"] as? String == nil else { return nil }
        var seen = defaults.dictionary(forKey: "cloud.commands") as? [String: Double] ?? [:]
        guard seen[record.recordID.recordName] == nil else { return nil }
        seen[record.recordID.recordName] = (record.creationDate ?? Date()).timeIntervalSince1970
        defaults.set(seen, forKey: "cloud.commands")
        return (record["photos"] as? [CKAsset] ?? []).compactMap(\.fileURL).compactMap(Self.keep).map(\.path)
    }

    /// Runs a claimed command. Its results are written in order through the one serialized writer.
    private func run(_ record: CKRecord, photos: [String]) async {
        guard CommandFreshness.isFresh(created: record.creationDate, now: Date()) else {
            photos.forEach { try? FileManager.default.removeItem(atPath: $0) }
            await result(record.recordID.recordName, status: "failed", message: "This was more than 10 minutes old, so your Mac didn't run it.")
            return
        }
        let payload = (record["payload"] as? String).flatMap { try? JSONDecoder().decode([String: JSONValue].self, from: Data($0.utf8)) } ?? [:]
        let command = PhoneCommand(id: record.recordID.recordName, type: record["type"] as? String ?? "",
                                   projectId: record["projectId"] as? String ?? "", payload: payload)
        await result(record.recordID.recordName, status: "running", message: "")
        let (ok, message) = await runCommand?(command, photos) ?? (false, "Counterpart isn't running.")
        await result(record.recordID.recordName, status: ok ? "done" : "failed", message: message)
    }

    /// CloudKit removes its downloaded asset files; the companion copies photos itself, so keep a copy until then.
    nonisolated private static func keep(_ url: URL) -> URL? {
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("counterpart-command-\(UUID().uuidString)-\(url.lastPathComponent)")
        return (try? FileManager.default.copyItem(at: url, to: copy)) != nil ? copy : nil
    }

    // A command's result is kept until iCloud has it, and written again on the next tick: never by running it again.
    private var pendingResults: [String: [String: String]] {
        get { defaults.dictionary(forKey: "cloud.pendingResults") as? [String: [String: String]] ?? [:] }
        set { defaults.set(newValue, forKey: "cloud.pendingResults") }
    }

    private func result(_ name: String, status: String, message: String) async {
        pendingResults[name] = ["status": status, "message": message]
        await flushResults()
    }

    /// One drain at a time; a result is cleared only if it is still the one that was written (a later `done` is never
    /// overwritten by an earlier `running`).
    private func flushResults() async {
        guard let database else { return }
        guard !flushing else { flushAgain = true; return }
        flushing = true
        defer { flushing = false }
        repeat {
            flushAgain = false
            for (name, value) in pendingResults {
                do {
                    let record = try await database.record(for: CKRecord.ID(recordName: name, zoneID: Self.zoneId))
                    record["status"] = value["status"]
                    record["message"] = value["message"]
                    try Self.check(try await database.modifyRecords(saving: [record], deleting: [], savePolicy: .changedKeys))
                    if pendingResults[name] == value { pendingResults[name] = nil } else { flushAgain = true }
                } catch where (error as? CKError)?.code == .unknownItem {
                    pendingResults[name] = nil // the phone already removed it
                } catch {
                    status = .failed(Self.sentence(error))
                    return
                }
            }
        } while flushAgain
    }
}
