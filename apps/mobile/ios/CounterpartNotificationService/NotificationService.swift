import UserNotifications
import CloudKit
import CounterpartKit

/// Fetches the Mac's event frame from the owner's private database. Expiry always delivers the
/// best enriched alert; one completion gate prevents a late network reply from delivering it twice.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?
    private var work: Task<Void, Never>?
    private var pictureFetch: CKFetchRecordsOperation?
    private var pictureDeadline: DispatchWorkItem?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        lock.lock(); handler = contentHandler; original = request.content; lock.unlock()
        guard let notification = CKNotification(fromRemoteNotificationDictionary: request.content.userInfo) as? CKQueryNotification,
              let id = notification.recordID,
              let content = request.content.mutableCopy() as? UNMutableNotificationContent else { finish(); return }
        // One subscription carries one category for several types (ev-problem, ev-stopped); the buttons follow the
        // event's own type (PRD §9.1). Set before the fetch, so an expired fetch still delivers the right buttons.
        if let type = notification.recordFields?["type"] as? String, let category = NotificationActions.category(for: type) {
            content.categoryIdentifier = category.rawValue
            content.userInfo["type"] = type
        }
        lock.lock(); original = content.copy() as? UNNotificationContent ?? original; lock.unlock()
        work = Task { [weak self] in
            do {
                let database = CKContainer(identifier: CounterpartIdentifiers.cloudKitContainer).privateCloudDatabase
                let record = try await database.record(for: id)
                guard !Task.isCancelled else { return }
                if let title = record["title"] as? String { content.title = title }
                if let body = record["body"] as? String { content.body = body }
                if let project = record["projectId"] as? String { content.threadIdentifier = project }
                let notify = record["notify"] as? String
                content.interruptionLevel = notify == "timeSensitive" ? .timeSensitive : notify == "passive" ? .passive : .active
                content.relevanceScore = notify == "timeSensitive" ? 1 : 0.5
                if notify == "passive" { content.sound = nil }
                for key in ["eventId", "projectId", "printId", "type"] {
                    if let value = record[key] as? String { content.userInfo[key] = value }
                }
                if let type = record["type"] as? String, let category = NotificationActions.category(for: type) { content.categoryIdentifier = category.rawValue }
                self?.remember(content)
                if let source = (record["frame"] as? CKAsset)?.fileURL {
                    let target = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).jpg")
                    try FileManager.default.copyItem(at: source, to: target)
                    if let attachment = try? UNNotificationAttachment(identifier: "frame", url: target) { content.attachments = [attachment] }
                    else { try? FileManager.default.removeItem(at: target) }
                }
                // Preserve the event's words, interruption level and camera frame before optional I/O.
                self?.remember(content)
                if let project = record["projectId"] as? String, (record["type"] as? String)?.hasPrefix("print.") == true {
                    self?.storeActivityPicture(project: project, database: database, zone: id.zoneID)
                    return
                }
            } catch { /* A missing frame must never hide the alert. */ }
            self?.finish(content)
        }
    }

    private func remember(_ content: UNNotificationContent) {
        lock.lock(); if handler != nil { original = content.copy() as? UNNotificationContent }; lock.unlock()
    }

    /// CloudKit already mirrors the real-object-first project picture (photo, scan frame, render).
    /// Give this optional asset at most two seconds after enrichment, well inside the extension's
    /// 30-second total budget. Cancellation never waits on a stalled CloudKit completion.
    private func storeActivityPicture(project: String, database: CKDatabase, zone: CKRecordZone.ID) {
        guard let store = PrintActivityThumbnails.shared() else { finish(); return }
        let recordID = CKRecord.ID(recordName: project, zoneID: zone)
        let operation = CKFetchRecordsOperation(recordIDs: [recordID])
        operation.desiredKeys = ["thumbnail", "updatedAt"]
        operation.configuration.timeoutIntervalForRequest = 2
        operation.configuration.timeoutIntervalForResource = 2
        operation.perRecordResultBlock = { [weak operation] _, result in
            guard operation?.isCancelled == false, let record = try? result.get(),
                  let file = (record["thumbnail"] as? CKAsset)?.fileURL else { return }
            let updated = (record["updatedAt"] as? Date) ?? record.modificationDate ?? Date(timeIntervalSince1970: 0)
            store.store(imageAt: file, projectId: project, version: updated.timeIntervalSince1970 * 1000, source: "cloud")
        }
        operation.fetchRecordsResultBlock = { [weak self] _ in self?.finish() }
        let deadline = DispatchWorkItem { [weak self] in self?.finish() }
        lock.lock()
        guard handler != nil else { lock.unlock(); return }
        pictureFetch = operation; pictureDeadline = deadline
        lock.unlock()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 2, execute: deadline)
        database.add(operation)
    }

    override func serviceExtensionTimeWillExpire() { work?.cancel(); finish() }

    private func finish(_ updated: UNNotificationContent? = nil) {
        lock.lock()
        let completion = handler, content = updated ?? original
        let fetch = pictureFetch, deadline = pictureDeadline
        handler = nil; original = nil; pictureFetch = nil; pictureDeadline = nil
        lock.unlock()
        deadline?.cancel(); fetch?.cancel()
        if let completion, let content { completion(content) }
    }
}
