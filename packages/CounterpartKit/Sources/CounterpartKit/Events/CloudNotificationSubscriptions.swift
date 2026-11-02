import CloudKit

/// Server-side alerts use the Mac's event text; the phone reconciles records separately when it wakes.
public enum CloudNotificationSubscriptions {
    public static let zoneID = CKRecordZone.ID(zoneName: CounterpartIdentifiers.cloudKitZone, ownerName: CKCurrentUserDefaultName)

    public enum Availability: Equatable { case allowed, unknown, savedOptOut }

    /// CloudKit query subscriptions belong to the account, not this device. A phone must
    /// never remove shared subscriptions because its own choices or an older reply differ.
    public static func availability(settings: CompanionSettings?, localChoices: [Bool]) -> Availability {
        if localChoices.contains(false) { return .savedOptOut }
        guard let notifications = settings?.notifications else { return .unknown }
        return notifications.devices.values.contains { $0.values.contains(false) } ? .savedOptOut : .allowed
    }

    public static func alertsAllowed(settings: CompanionSettings?, localChoices: [Bool]) -> Bool {
        availability(settings: settings, localChoices: localChoices) == .allowed
    }

    public static func changes(settings: CompanionSettings?, localChoices: [Bool]) -> (saving: [CKSubscription], deleting: [String]) {
        let subscriptions = make()
        let enabled = alertsAllowed(settings: settings, localChoices: localChoices)
        return (enabled ? subscriptions : subscriptions.filter { $0.subscriptionID == "proj-silent" }, [])
    }

    public static func make() -> [CKSubscription] {
        let groups = CloudKitRecords.subscriptions + [
            (id: "ev-started", types: ["print.started"], category: "PROGRESS"),
            (id: "ev-stopped", types: ["print.cancelled", "print.sent"], category: "DONE"),
            (id: "ev-software", types: ["mcp.update.done", "mcp.update.failed"], category: "SOFTWARE"),
        ]
        var subscriptions: [CKSubscription] = groups.map { group in
            let subscription = CKQuerySubscription(recordType: CloudKitRecords.event,
                predicate: NSPredicate(format: "type IN %@", group.types), subscriptionID: group.id, options: .firesOnRecordCreation)
            subscription.zoneID = zoneID
            let info = CKSubscription.NotificationInfo()
            info.titleLocalizationKey = "%1$@"; info.titleLocalizationArgs = ["title"]
            info.alertLocalizationKey = "%1$@"; info.alertLocalizationArgs = ["body"]
            info.category = group.category; info.soundName = "default"
            info.shouldSendMutableContent = true; info.shouldSendContentAvailable = true
            // CloudKit allows at most three extra fields. The service extension fetches the full
            // event for its frame and presentation; these preserve routing if that fetch fails.
            info.desiredKeys = ["eventId", "projectId", "type"]
            // Do not share a constant collapse ID across different prints. The extension groups
            // delivered alerts by project using threadIdentifier.
            subscription.notificationInfo = info
            return subscription
        }
        let project = CKQuerySubscription(recordType: CloudKitRecords.project, predicate: NSPredicate(value: true),
            subscriptionID: "proj-silent", options: [.firesOnRecordCreation, .firesOnRecordUpdate, .firesOnRecordDeletion])
        project.zoneID = zoneID
        let info = CKSubscription.NotificationInfo(); info.shouldSendContentAvailable = true
        project.notificationInfo = info; subscriptions.append(project)
        return subscriptions
    }
}
