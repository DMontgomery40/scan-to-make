import XCTest
import CloudKit
@testable import CounterpartKit

final class CloudNotificationTests: XCTestCase {
    func testExistingOptOutsPauseSharedAlertsAndUnknownPreferencesDoNotEnableThem() {
        XCTAssertFalse(CloudNotificationSubscriptions.alertsAllowed(settings: nil, localChoices: []))
        XCTAssertFalse(CloudNotificationSubscriptions.alertsAllowed(settings: .init(), localChoices: []))
        let defaults = CompanionSettings(notifications: .init())
        XCTAssertTrue(CloudNotificationSubscriptions.alertsAllowed(settings: defaults, localChoices: [true]))
        XCTAssertFalse(CloudNotificationSubscriptions.alertsAllowed(settings: defaults, localChoices: [false]))
        let selective = CompanionSettings(notifications: .init(devices: ["other-phone": ["print.done": false]]))
        XCTAssertFalse(CloudNotificationSubscriptions.alertsAllowed(settings: selective, localChoices: [true]))
    }
    func testPhoneMigrationPreservesEveryExplicitOptOutWithoutOverwritingStoredFalse() throws {
        let name = "notification-migration-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let settings = CompanionSettings(notifications: .init(devices: ["phone": ["pass.ready": false]]))
        XCTAssertNil(PhoneNotificationMigration.patch(settings: settings, deviceId: "phone", defaults: defaults))
        defaults.set(true, forKey: "CounterpartNotify.ready")
        defaults.set(false, forKey: "CounterpartNotify.problem")
        defaults.set(false, forKey: "CounterpartNotify.live")
        let patch = try XCTUnwrap(PhoneNotificationMigration.patch(settings: settings, deviceId: "phone", defaults: defaults))
        let notification = try XCTUnwrap(patch["notifications"] as? [String: [String: [String: Bool]]])
        XCTAssertEqual(notification["devices"]?["phone"], ["pass.failed": false, "print.failed": false, "print.not-started": false, "live-activity": false])
        XCTAssertNil(PhoneNotificationMigration.patch(settings: .init(), deviceId: "phone", defaults: defaults), "older companions cannot accept this patch")
    }

    func testActualBackendSettingsResponseEnablesReadyAndLegacyUnknownDoesNotDeleteSubscriptions() throws {
        struct Reply: Decodable { let settings: CompanionSettings }
        let url = try XCTUnwrap(Bundle.module.url(forResource: "notification-settings", withExtension: "json", subdirectory: "Fixtures"))
        let settings = try JSONDecoder().decode(Reply.self, from: Data(contentsOf: url)).settings
        XCTAssertTrue(settings.phoneNotifies("pass.ready", deviceId: "phone"))
        XCTAssertEqual(CloudNotificationSubscriptions.availability(settings: settings, localChoices: [true]), .allowed)
        let enabled = CloudNotificationSubscriptions.changes(settings: settings, localChoices: [true])
        XCTAssertTrue(enabled.saving.contains { $0.subscriptionID == "ev-ready" })
        XCTAssertTrue(enabled.deleting.isEmpty)
        for old in [nil, CompanionSettings()] {
            let unknown = CloudNotificationSubscriptions.changes(settings: old, localChoices: [true])
            XCTAssertFalse(unknown.saving.contains { $0.subscriptionID == "ev-ready" })
            XCTAssertTrue(unknown.deleting.isEmpty, "missing old fields must never delete shared subscriptions")
        }
        let optedOut = CompanionSettings(notifications: .init(devices: ["other-phone": ["print.done": false]]))
        XCTAssertEqual(CloudNotificationSubscriptions.availability(settings: optedOut, localChoices: [true]), .savedOptOut)
        let gated = CloudNotificationSubscriptions.changes(settings: optedOut, localChoices: [true])
        XCTAssertFalse(gated.saving.contains { $0.subscriptionID == "ev-ready" })
        XCTAssertTrue(gated.deleting.isEmpty, "one phone must not delete another phone's shared subscriptions")
        XCTAssertEqual(CloudNotificationSubscriptions.availability(settings: settings, localChoices: [false]), .savedOptOut)
    }

    func testSubscriptionsCoverEveryNotificationTypeAndCarryTheRoutingFields() throws {
        let subscriptions = CloudNotificationSubscriptions.make()
        let events = subscriptions.compactMap { $0 as? CKQuerySubscription }.filter { $0.recordType == CloudKitRecords.event }
        // CloudKit copies predicates through secure coding, which disables local evaluation. These
        // are our own constant predicates, so permit evaluation only in this contract test.
        let predicates = events.map(\.predicate)
        predicates.forEach { $0.allowEvaluation() }
        for type in SettingsSchema.notificationTypes {
            XCTAssertEqual(predicates.filter { $0.evaluate(with: ["type": type.id]) }.count, 1, "\(type.id) needs exactly one category")
        }
        for event in events {
            XCTAssertTrue(event.querySubscriptionOptions.contains(.firesOnRecordCreation))
            XCTAssertEqual(event.zoneID?.zoneName, CounterpartIdentifiers.cloudKitZone)
            let info = try XCTUnwrap(event.notificationInfo)
            XCTAssertTrue(info.shouldSendMutableContent)
            XCTAssertTrue(info.shouldSendContentAvailable)
            XCTAssertTrue(info.desiredKeys?.contains("eventId") == true)
            XCTAssertTrue(info.desiredKeys?.contains("projectId") == true)
            XCTAssertTrue(info.desiredKeys?.contains("type") == true)
            XCTAssertLessThanOrEqual(info.desiredKeys?.count ?? 0, 3, "CloudKit rejects notification payloads requesting more than three fields")
            XCTAssertEqual(info.titleLocalizationKey, "%1$@")
            XCTAssertEqual(info.titleLocalizationArgs, ["title"])
            XCTAssertEqual(info.alertLocalizationKey, "%1$@")
            XCTAssertEqual(info.alertLocalizationArgs, ["body"])
            XCTAssertNil(info.collapseIDKey, "separate prints must not share one constant collapse ID")
            XCTAssertNotNil(info.category)
        }
        XCTAssertNotNil(subscriptions.first { $0.subscriptionID == "proj-silent" })
    }
}
