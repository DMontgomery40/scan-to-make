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
