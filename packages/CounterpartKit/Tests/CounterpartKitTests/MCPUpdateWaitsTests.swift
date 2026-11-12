import XCTest
@testable import CounterpartKit

/// PRD §8.10: an update the companion never finishes (its event went missing) expires on every Apple layout, waiting or
/// started, so Update comes back instead of staying disabled. Any other word about that install first stops the clock.
@MainActor final class MCPUpdateWaitsTests: XCTestCase {
    func testAWaitThatHearsNothingExpiresAndAnyOtherWordStopsItsClock() async throws {
        let waits = MCPUpdateWaits(waitingLimit: .milliseconds(50), startedLimit: .seconds(60))
        var expired: [String] = []
        waits.note("unheard", .waiting) { expired.append("unheard") }
        waits.note("heard", .waiting) { expired.append("heard") }
        waits.note("heard", nil) { expired.append("heard (stopped)") }
        waits.note("again", .waiting) { expired.append("again (first)") }
        waits.note("again", .waiting) { expired.append("again") }
        waits.note("started", .waiting) { expired.append("started (as a wait)") }
        waits.note("started", .started) { expired.append("started") }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(expired.sorted(), ["again", "unheard"], "a wait expires once, from its latest start; a word in between stops it; a start has its own, longer clock")
        XCTAssertEqual(MCPUpdateWaits.unheard, "Counterpart didn’t say whether this updated. Try Update again.")
    }

    func testAnUpdateThatStartedAndNeverFinishedExpiresOnItsOwnClock() async throws {
        let waits = MCPUpdateWaits(waitingLimit: .seconds(60), startedLimit: .milliseconds(50))
        var expired: [String] = []
        waits.note("stuck", .started) { expired.append("stuck") }
        waits.note("finished", .started) { expired.append("finished") }
        waits.note("finished", nil) { expired.append("finished (stopped)") }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(expired, ["stuck"])
    }

    func testTheLimitsComeFromTheCompanionsOwnBounds() {
        let waits = MCPUpdateWaits()
        XCTAssertEqual(waits.waitingLimit, .seconds(120), "60 s for Counterpart's work, one claim and one npm lookup: ~97 s")
        XCTAssertEqual(waits.startedLimit, .seconds(35 * 60), "three 10-minute install steps plus the restart")
    }

    func testForgettingStopsEveryClock() async throws {
        let waits = MCPUpdateWaits(waitingLimit: .milliseconds(50), startedLimit: .milliseconds(50))
        var expired = false
        waits.note("a", .waiting) { expired = true }
        waits.note("b", .started) { expired = true }
        waits.forget()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(expired)
    }
}
