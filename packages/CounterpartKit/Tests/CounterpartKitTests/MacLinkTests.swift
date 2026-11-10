import XCTest
@testable import CounterpartKit

final class MacLinkTests: XCTestCase {
    private let pairing = CompanionError(code: "pairing-changed", message: "Connect to your Mac again.")
    private let refusal = CompanionError(code: "invalid-state", message: "That project is printing.")

    func testNothingIsClaimedBeforeTheFirstAnswer() {
        let link = MacLink.checking
        XCTAssertNil(link.reachable)
        XCTAssertNil(link.problem)
    }

    func testEveryStateFromEveryEvent() {
        let states: [MacLink] = [.checking, .connected, .notAnswering, .needsPairing(pairing)]
        for start in states {
            var link = start
            link.answered()
            XCTAssertEqual(link, .connected, "\(start): a reply is an answer")
            link = start
            link.failed(.unreachable)
            XCTAssertEqual(link, .notAnswering, "\(start): one request the Mac didn't answer says so at once")
            link = start
            link.failed(pairing)
            XCTAssertEqual(link, .needsPairing(pairing), "\(start)")
            link = start
            link.failed(refusal)
            XCTAssertEqual(link, .connected, "\(start): a refusal still proves the Mac is there")
        }
    }

    func testWhatEachStateSays() {
        XCTAssertEqual(MacLink.connected.reachable, true)
        XCTAssertNil(MacLink.connected.problem)
        XCTAssertEqual(MacLink.notAnswering.reachable, false)
        XCTAssertEqual(MacLink.notAnswering.problem, .unreachable)
        XCTAssertNil(MacLink.needsPairing(pairing).reachable, "pairing is the problem, not reachability")
        XCTAssertEqual(MacLink.needsPairing(pairing).problem, pairing)
    }
}
