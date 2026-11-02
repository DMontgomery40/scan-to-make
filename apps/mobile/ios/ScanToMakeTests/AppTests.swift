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

    /// Print Another starts on the tray this phone last printed with, on that printer only.
    func testPrintAnotherRemembersTheTrayPerPrinter() {
        let id = UUID().uuidString.lowercased()
        XCTAssertNil(LastTray.slot(id, destinationId: "current"))
        LastTray.save(id, destinationId: "current", slot: 2)
        XCTAssertEqual(LastTray.slot(id, destinationId: "current"), 2)
        XCTAssertNil(LastTray.slot(id, destinationId: "mcp-garage"), "another printer's trays are its own")
        LastTray.save(id, destinationId: "current", slot: 254)
        XCTAssertEqual(LastTray.slot(id, destinationId: "current"), 254)
    }

    func testRequestedSendSurvivesANewerDraftRefreshButNotAPairingReset() throws {
        let store = AppModel(store: Fixtures.store()).projects
        let draft = Project(id: "draft", createdAtMs: 1, updatedAtMs: 2, state: .new)
        let sendTicket = store.startRequest()
        var refreshed = draft; refreshed.title = "Newer title"
        store.replace(refreshed, ticket: store.startRequest())
        let send = try XCTUnwrap(store.prepareDraftSend(draft, ticket: sendTicket))
        XCTAssertEqual(send.state, .new, "a rejected UI snapshot must still send the requested files")
        XCTAssertEqual(send.title, "Newer title", "presentation keeps the newer refresh")
        XCTAssertTrue(store.requestIsCurrent(sendTicket))
        store.reset()
        XCTAssertNil(store.prepareDraftSend(draft, ticket: sendTicket), "a previous Mac must not receive the send")
        XCTAssertFalse(store.requestIsCurrent(sendTicket))
        XCTAssertTrue(store.projects.isEmpty)
    }

    func testRequestedSendOpensAnAlreadyStartedProjectWithoutUploadingAgain() throws {
        let store = AppModel(store: Fixtures.store()).projects
        let draft = Project(id: "draft", createdAtMs: 1, updatedAtMs: 2, state: .new)
        let sendTicket = store.startRequest()
        var started = draft; started.state = .touchingUp
        store.replace(started, ticket: store.startRequest())
        XCTAssertEqual(try XCTUnwrap(store.prepareDraftSend(draft, ticket: sendTicket)).state, .touchingUp)
        store.replace(draft, ticket: store.startRequest())
        XCTAssertEqual(try XCTUnwrap(store.prepareDraftSend(started, ticket: sendTicket)).state, .touchingUp,
                       "the draft response may itself prove Start succeeded even when its display ticket is old")
    }

    /// Codex on #218: a refused AI choice keeps its reason and isn't tested; a read that works clears a failed read,
    /// but not a refusal.
    func testMacSettingsKeepARefusalAndDropAFailedReadOnceTheMacAnswers() async {
        let mac = SettingsMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        let model = MacSettingsModel(store: store)

        mac.answers = false
        await model.load()
        XCTAssertNotNil(model.problem, "a failed read says so")
        mac.answers = true
        await model.load()
        XCTAssertNil(model.problem, "the Mac answers again: the old failure goes")
        XCTAssertEqual(model.settings?.ai?.choice?.kind, "claude-code")

        mac.refuseAI = true
        await model.chooseAI("codex-cli")
        XCTAssertEqual(model.problem, SettingsMac.refusal)
        XCTAssertFalse(mac.requests.contains("POST /v1/settings/ai/test"), "a refused choice isn't tested")
        await model.load()
        XCTAssertEqual(model.problem, SettingsMac.refusal, "a read keeps the refusal on screen")

        mac.refuseAI = false
        await model.chooseAI("codex-cli")
        XCTAssertNil(model.problem)
        XCTAssertTrue(mac.requests.contains("POST /v1/settings/ai/test"), "an accepted choice is tested")
    }
}

/// A Mac that serves settings, can stop answering, and can refuse an AI choice.
private final class SettingsMac: HTTPTransport, @unchecked Sendable {
    static let refusal = "The AI choice changed on another device. Choose again."
    private let lock = NSLock()
    private var _answers = true, _refuseAI = false, _requests: [String] = []
    var answers: Bool { get { lock.withLock { _answers } } set { lock.withLock { _answers = newValue } } }
    var refuseAI: Bool { get { lock.withLock { _refuseAI } } set { lock.withLock { _refuseAI = newValue } } }
    var requests: [String] { lock.withLock { _requests } }

    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        let line = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
        let (answers, refuseAI) = lock.withLock { _requests.append(line); return (_answers, _refuseAI) }
        guard answers else { throw URLError(.cannotConnectToHost) }
        func json(_ value: Any, _ status: Int = 200) -> HTTPReply { HTTPReply(status: status, body: (try? JSONSerialization.data(withJSONObject: value)) ?? Data()) }
        let settings: [String: Any] = ["milestones": "50", "ai": ["revision": "r1", "choice": ["kind": "claude-code"], "check": ["state": "connected"]]]
        switch line {
        case "GET /v1/settings": return json(["settings": settings])
        case "PATCH /v1/settings":
            if refuseAI { return json(["error": ["code": "revision-changed", "message": Self.refusal]], 409) }
            return json(["settings": ["milestones": "50", "ai": ["revision": "r2", "choice": ["kind": "codex-cli"], "check": ["state": "connected"]]]])
        case "POST /v1/settings/ai/test": return json(["check": ["state": "checking"]], 202)
        case "GET /v1/devices": return json(["devices": []])
        default: return json(["error": ["code": "not-found", "message": "Not found"]], 404)
        }
    }
}
