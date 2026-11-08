import UserNotifications
import CloudKit
import CounterpartKit

/// Fetches the Mac's event frame from the owner's private database. Expiry always delivers the
/// original alert; one completion gate prevents a late network reply from delivering it twice.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?
    private var work: Task<Void, Never>?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        lock.lock(); handler = contentHandler; original = request.content; lock.unlock()
        guard let notification = CKNotification(fromRemoteNotificationDictionary: request.content.userInfo) as? CKQueryNotification,
              let id = notification.recordID,
              let content = request.content.mutableCopy() as? UNMutableNotificationContent else { finish(); return }
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
                if let project = record["projectId"] as? String, (record["type"] as? String)?.hasPrefix("print.") == true {
                    await Self.storeActivityPicture(project: project, database: database, zone: id.zoneID)
                }
                if let source = (record["frame"] as? CKAsset)?.fileURL {
                    let target = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).jpg")
                    try FileManager.default.copyItem(at: source, to: target)
                    if let attachment = try? UNNotificationAttachment(identifier: "frame", url: target) { content.attachments = [attachment] }
                    else { try? FileManager.default.removeItem(at: target) }
                }
            } catch { /* A missing frame must never hide the alert. */ }
            self?.finish(content)
        }
    }

    /// The Live Activity shows the project's picture, which its widget can only read from the App Group
    /// (PRD §9.4). A print event can arrive for an activity the Mac started or updated by push while the app
    /// never ran, so save the Mac's project render here too. Best effort: the activity falls back to the mark.
    private static func storeActivityPicture(project: String, database: CKDatabase, zone: CKRecordZone.ID) async {
        guard let store = PrintActivityThumbnails.shared() else { return }
        let recordID = CKRecord.ID(recordName: project, zoneID: zone)
        guard let result = try? await database.records(for: [recordID], desiredKeys: ["thumbnail", "updatedAt"])[recordID],
              let record = try? result.get(),
              let file = (record["thumbnail"] as? CKAsset)?.fileURL else { return }
        let updated = (record["updatedAt"] as? Date) ?? record.modificationDate ?? Date(timeIntervalSince1970: 0)
        store.store(imageAt: file, projectId: project, version: updated.timeIntervalSince1970 * 1000, source: "cloud")
    }

    override func serviceExtensionTimeWillExpire() { work?.cancel(); finish() }

    private func finish(_ updated: UNNotificationContent? = nil) {
        lock.lock()
        let completion = handler, content = updated ?? original
        handler = nil; original = nil
        lock.unlock()
        if let completion, let content { completion(content) }
    }
}
