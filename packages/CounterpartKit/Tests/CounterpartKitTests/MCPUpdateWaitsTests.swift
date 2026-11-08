import XCTest
@testable import CounterpartKit

/// PRD §8.10: a wait the companion never ends (its event went missing) expires on every Apple layout, so Update comes
/// back instead of staying disabled. Any other word about that install first stops the clock.
@MainActor final class MCPUpdateWaitsTests: XCTestCase {
    func testAWaitThatHearsNothingExpiresAndAnyOtherWordStopsItsClock() async throws {
        let waits = MCPUpdateWaits(limit: .milliseconds(50))
        var expired: [String] = []
        waits.note("unheard", waiting: true) { expired.append("unheard") }
        waits.note("heard", waiting: true) { expired.append("heard") }
        waits.note("heard", waiting: false) { expired.append("heard (stopped)") }
        waits.note("again", waiting: true) { expired.append("again (first)") }
        waits.note("again", waiting: true) { expired.append("again") }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(expired.sorted(), ["again", "unheard"], "a wait expires once, from its latest start; a word in between stops it")
        XCTAssertEqual(MCPUpdateWaits.unheard, "Counterpart didn’t say whether this updated. Try Update again.")
        XCTAssertEqual(MCPUpdateWaits().limit, .seconds(90), "the companion ends every wait within a minute")
    }

    func testForgettingStopsEveryClock() async throws {
        let waits = MCPUpdateWaits(limit: .milliseconds(50))
        var expired = false
        waits.note("a", waiting: true) { expired = true }
        waits.forget()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(expired)
    }
}
