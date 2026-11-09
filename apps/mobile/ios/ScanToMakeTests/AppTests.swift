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

    func testAProjectThumbnailIsTheRealObjectBeforeAnyRender() {
        var project = Project(id: "p", createdAtMs: 1, updatedAtMs: 2, state: .ready,
                              photos: ["bottle.jpg"], capture: ["0001.heic"],
                              current: Project.Result(model: "current/model.stl", renders: ["renders/overview.png"]))
        XCTAssertEqual(project.thumbnailPath, "photos/bottle.jpg")
        project.photos = []
        XCTAssertEqual(project.thumbnailPath, "capture/0001.heic")
        project.capture = nil
        XCTAssertEqual(project.thumbnailPath, "renders/overview.png")
    }

    func testActivityPictureRefreshReturnsWhileTheMacIsStillUnreachable() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let transport = WaitingPictureMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: transport)
        let mac = MacConnection(client: CompanionClient(pairing: pairing, transport: transport))
        let pictures = ActivityPictures(store: PrintActivityThumbnails(folder: folder))
        let project = Project(id: UUID().uuidString.lowercased(), createdAtMs: 1, updatedAtMs: 2,
                              state: .printing, photos: ["bottle.jpg"])
        let returned = expectation(description: "reconcile can apply progress without LAN artwork")
        let refresh = Task { await pictures.refresh([project], mac: mac); returned.fulfill() }
        await transport.waitForDownload()
        await fulfillment(of: [returned], timeout: 0.5)
        XCTAssertEqual(PrintActivityThumbnails(folder: folder).artwork(for: project.id), .mark)
        await transport.finish()
        await refresh.value
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

    func testPrinterRefreshKeepsCopyActionsAfterTheCanonicalProfileChanges() async throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let fixtures = root.appendingPathComponent("packages/contracts/fixtures")
        let mac = try CopyCatalogMac(packages: Data(contentsOf: fixtures.appendingPathComponent("mcp-profile-copies.json")),
                                     printers: Data(contentsOf: fixtures.appendingPathComponent("mcp-profile-printers.json")))
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        store.macCapabilities = ["mcpCopies", "mcpUpdates"]
        await store.loadMCPCopies()
        XCTAssertEqual(store.mcpCopies?.first?.uses.first?.printerId, "current")
        await mac.selectOtherProfile()
        // The same refresh used after choosing another MCP and by the printer screen.
        await store.loadPrinters()
        let selected = try XCTUnwrap(store.catalog?.defaultDestinationId)
        XCTAssertEqual(selected, "other-profile")
        let uses = store.mcpCopies?.first?.uses.filter { $0.printerId == selected }
        XCTAssertEqual(uses?.count, 1, "the new canonical printer retains its software row")
        XCTAssertEqual(uses?.first?.canMove, true, "its explicit move action remains available")
    }

    func testRemoteDeletionEvictsProjectAndRejectsOlderReplies() async throws {
        let mac = SettingsMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        let project = Project(id: "d79d4c15-d786-461c-b76e-ec687c8e2dad", createdAtMs: 1, updatedAtMs: 2, state: .ready)
        store.replace(project, ticket: store.startRequest())
        let older = store.startRequest()
        let event = try JSONDecoder().decode(CounterpartEvent.self, from: Data(#"{"v":1,"seq":1,"id":"event","at":"2026-11-02T19:52:31Z","type":"project.deleted","projectId":"d79d4c15-d786-461c-b76e-ec687c8e2dad","title":"Removed","body":"","notify":"none"}"#.utf8))
        await store.receive(event)
        XCTAssertNil(store.project("d79d4c15-d786-461c-b76e-ec687c8e2dad"))
        XCTAssertTrue(mac.requests.isEmpty, "a deleted project cannot be fetched")
        XCTAssertFalse(store.replace(project, ticket: older), "a request begun before deletion cannot resurrect the project")
    }

    func testMissingProjectRemovesCachedCopyButTransientFailureKeepsIt() async {
        let mac = SettingsMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        let project = Project(id: "d79d4c15-d786-461c-b76e-ec687c8e2dad", createdAtMs: 1, updatedAtMs: 2, state: .ready)
        store.replace(project, ticket: store.startRequest())
        mac.answers = false
        let offline = await store.reload(project.id)
        XCTAssertEqual(offline?.code, "unreachable")
        XCTAssertNotNil(store.project(project.id), "an offline Mac is not evidence of deletion")
        mac.answers = true
        let missing = await store.reload(project.id)
        XCTAssertEqual(missing?.code, "not-found")
        XCTAssertNil(store.project(project.id), "confirmed absence must reach the unavailable UI")
    }

    func testProjectReloadReportsLostConnectionAndRecoversWhenTheMacAnswers() async {
        let mac = SettingsMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        store.reachable = true
        mac.answers = false
        _ = await store.reload("d79d4c15-d786-461c-b76e-ec687c8e2dad")
        XCTAssertEqual(store.reachable, false, "a detail refresh that cannot reach the Mac must update Settings too")
        XCTAssertEqual(store.error?.code, "unreachable")
        mac.answers = true
        _ = await store.reload("d79d4c15-d786-461c-b76e-ec687c8e2dad")
        XCTAssertEqual(store.reachable, true, "even a confirmed 404 proves the Mac answered")
        XCTAssertNil(store.error, "the connection error clears once the Mac answers again")
    }

    func testFailedEventPollDoesNotReportConnectedWhileResyncIsStillWaiting() async {
        let mac = ResyncMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        let following = Task { await store.follow() }
        await mac.waitForRefresh()
        XCTAssertNil(store.reachable, "a retry signal is not a successful response from the Mac")
        following.cancel()
        await mac.finishRefresh()
        await following.value
    }

    func testOlderMissingReplyCannotReplaceANewerProjectOrItsErrorState() async throws {
        let mac = DelayedMissingProjectMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        let pending = Task { await store.reload("21fe17ec-1ee1-4a60-b24d-c0a8f74879b1") }
        await mac.waitForRequest()
        let project = Project(id: "21fe17ec-1ee1-4a60-b24d-c0a8f74879b1", createdAtMs: 1, updatedAtMs: 2, state: .ready)
        store.replace(project, ticket: store.startRequest())
        await mac.finish()
        let failure = await pending.value
        XCTAssertEqual(failure, .cancelled, "an obsolete absence must not appear as a current fetch failure")
        XCTAssertEqual(store.project(project.id), project)
    }

    func testRemovingOlderPairingsNeverRevokesTheRequestingPhone() async throws {
        let mac = SettingsMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        let model = MacSettingsModel(store: store)
        let current = try XCTUnwrap(model.deviceId)
        let older = "bcb48dc1-50c8-4ca9-924b-eaf9639f7c32"
        let bytes = try JSONSerialization.data(withJSONObject: [
            ["deviceId": current, "current": true, "legacy": true],
            ["deviceId": older, "legacy": true],
        ])
        model.devices = try JSONDecoder().decode([CompanionDevice].self, from: bytes)
        await model.remove([current, older])
        XCTAssertFalse(mac.requests.contains("DELETE /v1/devices/\(current)"), "a legacy current phone must remain paired")
        XCTAssertTrue(mac.requests.contains("DELETE /v1/devices/\(older)"), "the other older pairing is still removed")
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

/// An unreachable event feed whose resulting project refresh has not answered yet.
private actor ResyncMac: HTTPTransport {
    private var refresh: CheckedContinuation<HTTPReply, Error>?
    private var waiting: CheckedContinuation<Void, Never>?
    func waitForRefresh() async {
        if refresh != nil { return }
        await withCheckedContinuation { waiting = $0 }
    }
    func finishRefresh() {
        refresh?.resume(throwing: TransportError("cancelled")); refresh = nil
    }
    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        guard request.url?.path == "/v1/objects" else { throw TransportError("network") }
        return try await withCheckedThrowingContinuation {
            refresh = $0
            waiting?.resume(); waiting = nil
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
        if request.httpMethod == "DELETE", request.url?.path.hasPrefix("/v1/devices/") == true { return json(["removed": true]) }
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

/// Holds the actual HTTP 404 until a newer project response has reached the store.
private actor DelayedMissingProjectMac: HTTPTransport {
    private var reply: CheckedContinuation<HTTPReply, Never>?
    private var requested: CheckedContinuation<Void, Never>?
    func waitForRequest() async {
        if reply != nil { return }
        await withCheckedContinuation { requested = $0 }
    }
    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        await withCheckedContinuation {
            reply = $0
            requested?.resume(); requested = nil
        }
    }
    func finish() {
        reply?.resume(returning: HTTPReply(status: 404, body: Data(#"{"error":{"code":"not-found","message":"Object not found"}}"#.utf8)))
        reply = nil
    }
}


/// Changes only identity in the shared contract fixtures, as choosing the other MCP does on the host.
private actor CopyCatalogMac: HTTPTransport {
    private let package: Data
    private let printers: Data
    private var selected = "current"
    init(packages: Data, printers: Data) { self.package = packages; self.printers = printers }
    func selectOtherProfile() { selected = "other-profile" }
    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        var result: [String: Any]
        if request.url?.path == "/v1/printers/mcps" {
            var package = try XCTUnwrap(JSONSerialization.jsonObject(with: package) as? [String: Any])
            var uses = try XCTUnwrap(package["uses"] as? [[String: Any]])
            uses[0]["printerId"] = selected; package["uses"] = uses
            result = ["packages": [package]]
        } else if request.url?.path == "/v1/objects/printers" {
            result = try XCTUnwrap(JSONSerialization.jsonObject(with: printers) as? [String: Any])
            var destinations = try XCTUnwrap(result["destinations"] as? [[String: Any]])
            destinations[0]["id"] = selected; result["destinations"] = destinations
            result["defaultDestinationId"] = selected
        } else { throw TransportError("network") }
        return HTTPReply(status: 200, body: try JSONSerialization.data(withJSONObject: result))
    }
}

private actor WaitingPictureMac: HTTPTransport {
    private var download: CheckedContinuation<HTTPReply, Error>?
    private var waiting: CheckedContinuation<Void, Never>?
    func waitForDownload() async {
        if download != nil { return }
        await withCheckedContinuation { waiting = $0 }
    }
    func finish() { download?.resume(throwing: TransportError("network")); download = nil }
    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        try await withCheckedThrowingContinuation {
            download = $0; waiting?.resume(); waiting = nil
        }
    }
}
