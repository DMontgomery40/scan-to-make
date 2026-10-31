import XCTest
@testable import AgentKit

final class LocalNetworkAccessTests: XCTestCase {
    func testBackgroundAndOfflineLaunchDoNotConsumeForegroundAttempt() {
        var gate = LocalNetworkProbeGate()
        XCTAssertFalse(gate.begin(isForeground:false,hasLAN:true))
        XCTAssertFalse(gate.begin(isForeground:true,hasLAN:false))
        XCTAssertTrue(gate.begin(isForeground:true,hasLAN:true))
        XCTAssertFalse(gate.begin(isForeground:true,hasLAN:true))
        XCTAssertFalse(gate.begin(isForeground:false,hasLAN:true))
    }
}
