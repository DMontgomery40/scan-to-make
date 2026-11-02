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

    /// scan-to-make-dc: a project deleted on the Mac stayed on Home, because every event only re-read its project
    /// (KAN-214 #249 `project.deleted`). It leaves Home, and other projects' events still re-read them.
    func testAProjectDeletedOnTheMacLeavesHome() async throws {
        let mac = EventsMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        func project(_ id: String, _ title: String) throws -> Project {
            try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: EventsMac.object(id, title)))
        }
        store.projects = [try project(EventsMac.deleted, "Stove gap filler"), try project(EventsMac.kept, "Mic mount")]
        store.queue(note: "Make the lip thicker", for: EventsMac.deleted)

        let following = Task { await store.follow() }
        defer { following.cancel() }
        let deadline = Date().addingTimeInterval(10)
        while store.projects.contains(where: { $0.id == EventsMac.deleted }) || store.projects.first?.title != "Mic mount v2", Date() < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(store.projects.map(\.id), [EventsMac.kept], "the deleted project left Home; the other stayed")
        XCTAssertEqual(store.projects.first?.title, "Mic mount v2", "another project's event still re-reads it")
        XCTAssertTrue(store.deleted.contains(EventsMac.deleted), "a page open on it says it was deleted")
        XCTAssertNil(store.queuedNotes[EventsMac.deleted], "a change waiting for it is dropped")
        XCTAssertFalse(mac.requests.contains("GET /v1/objects/\(EventsMac.deleted)"), "nothing is read for a deleted project")
        // A read that was already in flight when it was deleted doesn't put it back on Home.
        store.replace(try project(EventsMac.deleted, "Stove gap filler"))
        XCTAssertEqual(store.projects.map(\.id), [EventsMac.kept])
    }
}

/// A Mac whose event log holds an update to one project and the deletion of another, then waits.
private final class EventsMac: HTTPTransport, @unchecked Sendable {
    static let deleted = "2f0a0229-1111-4000-8000-000000000001", kept = "6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01"
    private let lock = NSLock()
    private var _requests: [String] = []
    var requests: [String] { lock.withLock { _requests } }

    static func object(_ id: String, _ title: String) -> [String: Any] {
        ["id": id, "createdAtMs": 1, "updatedAtMs": 2, "state": "ready", "title": title, "photos": [], "passes": []]
    }
    private static func event(_ seq: Int, _ type: String, _ id: String, data: [String: Any]? = nil) -> [String: Any] {
        var event: [String: Any] = ["v": 1, "seq": seq, "id": "00000000-0000-4000-8000-0000000000\(seq)", "at": "2026-11-02T05:05:00.000Z",
                                    "type": type, "projectId": id, "title": "T", "body": "B", "notify": "none"]
        if let data { event["data"] = data }
        return event
    }

    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        let line = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
        lock.withLock { _requests.append(line) }
        func json(_ value: Any, _ status: Int = 200) -> HTTPReply { HTTPReply(status: status, body: (try? JSONSerialization.data(withJSONObject: value)) ?? Data()) }
        let after = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "after" }?.value }.flatMap(Int.init)
        switch line {
        case "GET /v1/events" where after == 0: return json(["events": [], "next": 20, "latest": 20])
        case "GET /v1/events" where after == 20:
            return json(["events": [Self.event(21, "project.updated", Self.kept), Self.event(22, "project.deleted", Self.deleted, data: ["by": "mac"])],
                         "next": 22, "latest": 22])
        case "GET /v1/events":
            try await Task.sleep(for: .seconds(30))   // the long poll waits; the test cancels it
            return json(["events": [], "next": 22, "latest": 22])
        case "GET /v1/objects/\(Self.kept)": return json(["object": Self.object(Self.kept, "Mic mount v2")])
        case "GET /healthz": return json(["status": "ok", "protocolVersion": "0.1.0"])
        default: return json(["error": ["code": "not-found", "message": "Not found"]], 404)
        }
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
