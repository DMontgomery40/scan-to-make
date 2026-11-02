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

    func testAnEstimateShowsOnlyForItsOwnSettings() throws {
        var state = EstimateState()
        let estimate = try JSONDecoder().decode(SliceEstimate.self, from: Data(#"{"destinationId":"current","quality":"standard","strength":"standard","seconds":4320,"grams":22,"layers":212}"#.utf8))
        let fallback = Project.PrintEstimate(seconds: 999, grams: 9)
        state.start("1#current#standard#standard")
        XCTAssertEqual(state.shown(for: "1#current#standard#standard", fallback: fallback), .pending, "slicing: never the pass's old numbers")
        state.finish("1#current#standard#standard", estimate)
        XCTAssertEqual(state.shown(for: "1#current#standard#standard", fallback: fallback), .ready(seconds: 4320, grams: 22, layers: 212))
        XCTAssertEqual(state.shown(for: "1#current#fine#standard", fallback: fallback), .pending, "other settings: pending, not the last slice")
        state.start("1#current#fine#standard")
        state.finish("1#current#standard#standard", estimate)
        XCTAssertEqual(state.shown(for: "1#current#fine#standard", fallback: fallback), .pending, "a late reply for old settings never lands")
        state.fail("1#current#fine#standard", "The printer's slicer stopped.")
        XCTAssertEqual(state.shown(for: "1#current#fine#standard", fallback: fallback), .failed("The printer's slicer stopped."))
        XCTAssertEqual(state.shown(for: "2#current#fine#standard", fallback: fallback), .pending, "a new model is a new slice")
        var older = EstimateState()
        older.start("1#current#standard#standard")
        older.unsupported("1#current#standard#standard")
        XCTAssertEqual(older.shown(for: "1#current#standard#standard", fallback: fallback), .ready(seconds: 999, grams: 9, layers: nil), "an older Mac keeps the pass's estimate")
    }

    /// QA on cf2e99a: a paired phone must always reach Home. Every combination the first-run gate can see.
    func testAPairedPhoneAlwaysShowsHome() {
        func step(paired: Bool, welcomed: Bool, justPaired: Bool = false, undecided: Bool? = nil, asked: Bool = false, hold: Bool = false) -> FirstRunStep {
            FirstRunStep.step(statusKnown: true, paired: paired, holdPairing: hold, welcomed: welcomed, justPaired: justPaired,
                              notificationsUndecided: undecided, askedNotifications: asked)
        }
        // Paired, Welcome never seen (an upgraded phone), with the permission check unanswered, undecided or decided.
        for undecided in [nil, true, false] as [Bool?] {
            XCTAssertEqual(step(paired: true, welcomed: false, undecided: undecided), .home)
            XCTAssertEqual(step(paired: true, welcomed: true, undecided: undecided), .home)
        }
        // Not paired, fresh: Welcome, then Find your Mac.
        XCTAssertEqual(step(paired: false, welcomed: false), .welcome)
        XCTAssertEqual(step(paired: false, welcomed: true), .pair)
        // Just paired here: the notifications question once, if the system hasn't asked; then Home.
        XCTAssertEqual(step(paired: true, welcomed: true, hold: true), .pair, "the success screen holds for a moment")
        XCTAssertEqual(step(paired: true, welcomed: true, justPaired: true, undecided: true), .notify)
        XCTAssertEqual(step(paired: true, welcomed: true, justPaired: true, undecided: nil), .home, "never waits on the check")
        XCTAssertEqual(step(paired: true, welcomed: true, justPaired: true, undecided: true, asked: true), .home)
        XCTAssertEqual(step(paired: true, welcomed: true, justPaired: true, undecided: false), .home)
        // Unknown status: loading, only until the Keychain is read.
        XCTAssertEqual(FirstRunStep.step(statusKnown: false, paired: false, holdPairing: false, welcomed: false, justPaired: false,
                                         notificationsUndecided: nil, askedNotifications: false), .loading)
    }

    /// The canned Mac (fixtures) is paired, so it shows Home with no -CounterpartScreen; a fresh store shows Welcome.
    func testFixturesShowHomeAndAFreshPhoneShowsWelcome() {
        let fixtures = AppModel(store: Fixtures.store())
        XCTAssertFalse(fixtures.needsMac)
        XCTAssertEqual(FirstRunStep.step(statusKnown: fixtures.status != nil, paired: !fixtures.needsMac, holdPairing: false, welcomed: false,
                                         justPaired: false, notificationsUndecided: true, askedNotifications: false), .home)
        let fresh = AppModel(store: MemoryStore())
        XCTAssertEqual(FirstRunStep.step(statusKnown: fresh.status != nil, paired: !fresh.needsMac, holdPairing: false, welcomed: false,
                                         justPaired: false, notificationsUndecided: nil, askedNotifications: false), .welcome)
    }
}

