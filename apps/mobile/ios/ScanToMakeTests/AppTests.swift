import XCTest
import CounterpartKit
@testable import ScanToMake

/// App-level checks that need the app target: links, routes and the pairing screen's starting state.
@MainActor final class AppTests: XCTestCase {
    func testAPairingLinkIsTakenOnceEvenWhenAColdStartDeliversItTwice() {
        let app = AppModel(store: MemoryStore())
        let link = URL(string: "scantomake://pair?v=2&c=\(String(repeating: "A", count: 32))&e=9999999999999&k=\(String(repeating: "ab", count: 32))&a=https%3A%2F%2F192.168.1.2%3A9077")!
        app.open(link)
        XCTAssertEqual(app.pendingLink, link.absoluteString)
        app.pendingLink = nil
        app.open(link)
        XCTAssertNil(app.pendingLink, "the same link within 2 s is the cold-start repeat")
    }

    func testWithoutAPairingFindYourMacComesFirst() {
        let app = AppModel(store: MemoryStore())
        XCTAssertEqual(app.status?.state, .disconnected)
        XCTAssertTrue(app.needsMac)
    }

    func testRoutesFromLinks() {
        let app = AppModel(store: MemoryStore())
        app.open(URL(string: "counterpart://project/6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01")!)
        XCTAssertEqual(app.route, .project("6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"))
        app.open(notification: ["projectId": "p", "type": "pass.ready"], action: "PRINT")
        XCTAssertEqual(app.route, .print("p"))
    }
}
