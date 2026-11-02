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

    override func serviceExtensionTimeWillExpire() { work?.cancel(); finish() }

    private func finish(_ updated: UNNotificationContent? = nil) {
        lock.lock()
        let completion = handler, content = updated ?? original
        handler = nil; original = nil
        lock.unlock()
        if let completion, let content { completion(content) }
    }
}
