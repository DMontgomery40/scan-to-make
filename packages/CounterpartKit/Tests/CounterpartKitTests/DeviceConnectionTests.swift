import XCTest
@testable import CounterpartKit

final class DeviceConnectionTests: XCTestCase {
    func testEveryPhoneDeviceListUsesRequestPresenceNotFreshCredentials() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        for (age, expected) in [(nil, false), (Optional(0.0), true), (299.0, true), (300.0, false), (900.0, false), (-1.0, false)] {
            var row: [String: Any] = ["deviceId": "d", "lastRefreshedAt": now.ISO8601Format()]
            if let age { row["lastSeenAt"] = now.addingTimeInterval(-age).ISO8601Format() }
            let device = try JSONDecoder().decode(CompanionDevice.self, from: JSONSerialization.data(withJSONObject: row))
            XCTAssertEqual(device.connectedNow(at: now), expected)
        }
        XCTAssertFalse(DeviceConnection.connected(lastSeenAt: now, legacy: true, now: now))
        XCTAssertFalse(DeviceConnection.connected(lastSeenAt: Date(timeIntervalSince1970: .infinity), legacy: false, now: now))
    }
}
