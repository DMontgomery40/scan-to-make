import XCTest
import QuickLook
import UniformTypeIdentifiers
import RealityKit
import CounterpartKit
@testable import ScanToMake

/// App-level checks that need the app target: links, routes and the pairing screen's starting state.
@MainActor final class AppTests: XCTestCase {
    func testDemandQueuedWhileInactiveStartsWhenTheSceneActivates() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".usdz")
        try Data([1]).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let downloaded = expectation(description: "queued scan starts after activation")
        var calls = 0
        let models = ModelFiles { _, _ in calls += 1; downloaded.fulfill(); return file }
        let project = Project(id: "queued-scan", createdAtMs: 0, updatedAtMs: 1, state: .ready, scan: "scan.usdz")
        models.setActive(false)
        models.want(project, "scan/scan.usdz")
        XCTAssertEqual(calls, 0)
        models.setActive(true)
        guard await waited([downloaded], "unstarted scan demand is recovered") else { return }
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(models.file(project, "scan/scan.usdz"), file)
    }

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

    /// David, Nov 10: "of ALL THE OPTIONS ... the photograph including everything in it is by far the worst". A project's
    /// picture is the object alone on the stage, as the Mac drew it, else a render; never a photo or a scan frame.
    func testAProjectPictureIsTheObjectAloneNeverAPhotoOfTheRoom() {
        var project = Project(id: "p", createdAtMs: 1, updatedAtMs: 2, state: .ready,
                              photos: ["bottle.jpg"], capture: ["0001.heic"],
                              current: Project.Result(model: "current/model.stl", renders: ["renders/overview.png"]))
        XCTAssertEqual(project.thumbnailPath, "renders/overview.png", "until the Mac draws it: the render, not the photo")
        project.picture = "pictures/part-0123456789abcdef.png"
        XCTAssertEqual(project.thumbnailPath, "pictures/part-0123456789abcdef.png")
        project.picture = nil; project.current = nil
        XCTAssertNil(project.thumbnailPath, "nothing drawn yet: the placeholder, never the room")
    }

    func testActivityPictureRefreshReturnsWhileTheMacIsStillUnreachable() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let transport = WaitingPictureMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: transport)
        let mac = MacConnection(client: CompanionClient(pairing: pairing, transport: transport))
        let pictures = ActivityPictures(store: PrintActivityThumbnails(folder: folder))
        // A print's picture is the project's own: the object alone, as the Mac drew it (PRD §5.1), never a photo.
        var project = Project(id: UUID().uuidString.lowercased(), createdAtMs: 1, updatedAtMs: 2, state: .printing,
                              photos: ["bottle.jpg"], current: Project.Result(model: "current/model.stl", renders: []))
        project.picture = "pictures/part-0123456789abcdef.png"
        let returned = expectation(description: "reconcile can apply progress without LAN artwork")
        let refresh = Task { await pictures.refresh([project], mac: mac); returned.fulfill() }
        let asked = await transport.waitForDownload()
        XCTAssertTrue(asked, "the Live Activity asks the Mac for the project's picture")
        let requested = await transport.requested
        XCTAssertEqual(requested.count, 1)
        XCTAssertTrue(requested.first?.hasSuffix("/pictures/part-0123456789abcdef.png") == true, "the Mac's picture, not \(requested)")
        let back = await waited([returned], "the refresh returns while the Mac has not answered")
        XCTAssertEqual(PrintActivityThumbnails(folder: folder).artwork(for: project.id), .mark, "the mark until the picture arrives")
        await transport.finish()
        if back { await refresh.value }
    }

    /// A print whose project has only photos and nothing the Mac drew or rendered (in practice it can't print yet: a
    /// print has a model, so a render or the Mac's picture). Decided, not discovered: the Live Activity shows the
    /// Counterpart mark and asks the Mac for nothing; never the photo with its room (David, Nov 10).
    func testAPrintWithOnlyPhotosShowsTheMarkAndFetchesNothing() async {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let transport = WaitingPictureMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: transport)
        let mac = MacConnection(client: CompanionClient(pairing: pairing, transport: transport))
        let pictures = ActivityPictures(store: PrintActivityThumbnails(folder: folder))
        let project = Project(id: UUID().uuidString.lowercased(), createdAtMs: 1, updatedAtMs: 2, state: .printing,
                              photos: ["bottle.jpg"], capture: ["0001.heic"])
        XCTAssertNil(project.thumbnailPath)
        await pictures.refresh([project], mac: mac)
        let asked = await transport.waitForDownload(within: 0.3)
        XCTAssertFalse(asked, "nothing to fetch: never the photo")
        let requested = await transport.requested
        XCTAssertEqual(requested, [])
        XCTAssertEqual(PrintActivityThumbnails(folder: folder).artwork(for: project.id), .mark)
    }

    /// Nov 10, the Wall holder: its 15 MB scan took four minutes to reach David's phone and the stage stayed empty. The
    /// download belongs to the store: the page leaving doesn't stop it, coming back doesn't start a second one, and it
    /// lands for whoever looks next.
    func testAModelDownloadOutlivesThePageThatAskedAndRunsOnce() async throws {
        let gate = DownloadGate()
        let files = ModelFiles { _, _ in try await gate.wait() }
        let project = Project(id: "p", createdAtMs: 1, updatedAtMs: 2, state: .ready, scan: "scan.usdz")
        let page = Task { @MainActor in files.want(project, "scan/phone-preview.usdz") }
        await page.value
        page.cancel() // the page closes
        XCTAssertEqual(files.fetch(project, "scan/phone-preview.usdz"), .loading)
        files.want(project, "scan/phone-preview.usdz") // and opens again while it comes
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data("usdz".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        await gate.open(file)
        let landed = await until(patience) { await MainActor.run { files.file(project, "scan/phone-preview.usdz") != nil } }
        XCTAssertTrue(landed, "it lands with nobody waiting for it")
        files.want(project, "scan/phone-preview.usdz")
        let calls = await gate.calls
        XCTAssertEqual(calls, 1, "one download, however often the page asks")
    }

    /// A dropped link tries again by itself; a download that still fails says so and Try Again starts it over; a file
    /// too large for the phone is not asked for again.
    func testADroppedLinkTriesAgainAndAFailureOffersTryAgain() async {
        let counter = Counter()
        let project = Project(id: "p", createdAtMs: 1, updatedAtMs: 2, state: .ready, scan: "scan.usdz")
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("model-\(UUID().uuidString).stl")
        let files = ModelFiles { _, path in
            let n = await counter.next()
            if path == "scan/scan.usdz" { throw CompanionError(code: "file-too-large", message: "This file is too large for this phone.") }
            if n <= 3 { throw CompanionError(code: "network", message: "Your Mac stopped answering.") }
            return file
        }
        files.pauses = [Duration.zero, Duration.zero]
        files.want(project, "model.stl")
        let failed = await until(patience) { await MainActor.run { files.fetch(project, "model.stl") == .failed } }
        XCTAssertTrue(failed, "three tries, then it says so")
        let tries = await counter.value
        XCTAssertEqual(tries, 3)
        files.retry(project, "model.stl")
        let ready = await until(patience) { await MainActor.run { files.file(project, "model.stl") == file } }
        XCTAssertTrue(ready, "Try Again starts it over")
        files.want(project, "scan/scan.usdz")
        let large = await until(patience) { await MainActor.run { files.fetch(project, "scan/scan.usdz") == .tooLarge } }
        XCTAssertTrue(large)
        files.want(project, "scan/scan.usdz"); files.retry(project, "scan/scan.usdz")
        let after = await counter.value
        XCTAssertEqual(after, 5, "a refusal for size is final: one ask")
    }

    func testForegroundAndLinkRecoveryRetryDemandAndLateOldResultCannotPublish() async throws {
        let gate = HeldDownload(), counter = Counter()
        let project = Project(id: "p", createdAtMs: 1, updatedAtMs: 2, state: .ready)
        let old = FileManager.default.temporaryDirectory.appendingPathComponent("old-model.stl")
        let current = FileManager.default.temporaryDirectory.appendingPathComponent("new-model.stl")
        let files = ModelFiles { _, _ in
            let call = await counter.next()
            if call == 1 { return await gate.wait() }
            if call == 2 { throw CompanionError(code: "device-locked", message: "Unlock your iPhone.") }
            return current
        }
        files.pauses = []
        files.want(project, "model.stl")
        let started = await until(patience) { await counter.value == 1 }
        XCTAssertTrue(started)
        files.setActive(false)
        XCTAssertEqual(files.fetch(project, "model.stl"), .failed)
        files.setActive(true)
        let locked = await until(patience) { await MainActor.run { files.fetch(project, "model.stl") == .failed } }
        XCTAssertTrue(locked)
        files.recover() // link restored / protected data became available
        let ready = await until(patience) { await MainActor.run { files.file(project, "model.stl") == current } }
        XCTAssertTrue(ready)
        await gate.open(old)
        await Task.yield()
        XCTAssertEqual(files.file(project, "model.stl"), current, "The abandoned generation cannot overwrite a recovered file")
    }

    /// Review F5 on #525: this phone's own limit met mid-transfer is a size refusal like the Mac's, said as one, not
    /// retried three times and shown as "not here yet".
    func testAFileOverThePhonesLimitIsTooLargeNotFailed() async {
        let counter = Counter()
        let project = Project(id: "p", createdAtMs: 1, updatedAtMs: 2, state: .ready, scan: "scan.usdz")
        let files = ModelFiles { _, _ in _ = await counter.next(); throw CompanionError(code: "too-large", message: "Too large.") }
        files.pauses = [Duration.zero, Duration.zero]
        files.want(project, "scan/scan.usdz")
        let large = await until(patience) { await MainActor.run { files.fetch(project, "scan/scan.usdz") == .tooLarge } }
        XCTAssertTrue(large)
        let asked = await counter.value
        XCTAssertEqual(asked, 1)
        // Review of #527 part 4, S3: through the client the phone's own limit arrives as `payload-too-large`
        // (CompanionError.transport); that too is a size refusal, asked once.
        let streamed = Counter()
        let over = ModelFiles { _, _ in _ = await streamed.next(); throw CompanionError(code: "payload-too-large", message: "That file is too large to send.") }
        over.pauses = [Duration.zero, Duration.zero]
        over.want(project, "scan/scan.usdz")
        let overLarge = await until(patience) { await MainActor.run { over.fetch(project, "scan/scan.usdz") == .tooLarge } }
        XCTAssertTrue(overLarge, "payload-too-large is too large: \(String(describing: over.fetch(project, "scan/scan.usdz")))")
        let overAsked = await streamed.value
        XCTAssertEqual(overAsked, 1, "not streamed three times")
    }

    /// Review F4 on #525: while the stage's picture loads it shows the project's list picture when this phone has it.
    func testTheStageFindsTheListsPictureAtAnySize() {
        let project = Project(id: "p", createdAtMs: 1, updatedAtMs: 2, state: .ready)
        XCTAssertNil(ImageMemory.shared.anySize(project, "pictures/part-0123456789abcdef.png"))
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { $0.fill(CGRect(x: 0, y: 0, width: 4, height: 4)) }
        ImageMemory.shared.store(image, ImageMemory.key(project, "pictures/part-0123456789abcdef.png", 300))
        XCTAssertTrue(ImageMemory.shared.anySize(project, "pictures/part-0123456789abcdef.png") === image)
        XCTAssertNil(ImageMemory.shared.anySize(project, nil))
        // #720: a Mac picture is named by what it draws, so a newer project version finds it decoded already.
        let later = Project(id: "p", createdAtMs: 9_000, updatedAtMs: 9_001, state: .ready)
        XCTAssertNotEqual(later.mediaVersion, project.mediaVersion)
        XCTAssertTrue(ImageMemory.shared.anySize(later, "pictures/part-0123456789abcdef.png") === image)
        // A render is per version: the last one decoded stands in while the newer version's comes.
        ImageMemory.shared.store(image, ImageMemory.key(project, "renders/front.png", 300), project: "p", path: "renders/front.png")
        XCTAssertTrue(ImageMemory.shared.anySize(later, "renders/front.png") === image)
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

    /// #720, on the device: a newer project version with the same model bytes asks the Mac with the kept file's tag, gets 304,
    /// and keeps the same file. The bytes come once.
    func testAnUnchangedModelIsNotDownloadedTwiceOnThisDevice() async throws {
        let mac = TaggedMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let base = FileManager.default.temporaryDirectory.appending(path: "tagged-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        let library = OnDeviceLibrary(base: base.appending(path: "library"))
        library.use(mac: "m")
        let keep = OnDeviceLibrary.Keep.chosen
        OnDeviceLibrary.Keep.chosen = .models
        defer { OnDeviceLibrary.Keep.chosen = keep }
        let client = CompanionClient(pairing: pairing, transport: mac, cache: base.appending(path: "cache"), library: library)
        func project(_ ended: Int) throws -> Project {
            try JSONDecoder().decode(Project.self, from: Data(#"{"id":"d79d4c15-d786-461c-b76e-ec687c8e2dad","createdAtMs":1,"updatedAtMs":2,"state":"ready","kind":"fit","photos":[],"passes":[{"startedAtMs":1,"endedAtMs":\#(ended),"status":"done"}],"current":{"model":"current/model.stl","renders":[]}}"#.utf8))
        }
        let first = try await client.download(project(1000), "model.stl")
        let second = try await client.download(project(2000), "model.stl")
        XCTAssertEqual(first, second, "the same file on disk, so its mesh and still are reused")
        XCTAssertEqual(mac.bodies, 1, "the model's bytes came once")
        XCTAssertEqual(mac.tags, [nil, "\"m1\""])
    }

    // MARK: The library's fill (review of #741)

    private func filler(_ mac: FileMac) -> (LibraryFiller, OnDeviceLibrary, URL) {
        let base = FileManager.default.temporaryDirectory.appending(path: "fill-\(UUID().uuidString)")
        let library = OnDeviceLibrary(base: base.appending(path: "library"))
        library.use(mac: "m")
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let client = CompanionClient(pairing: pairing, transport: mac, cache: base.appending(path: "cache"), library: library)
        return (LibraryFiller(client: client, watchesLink: false), library, base)
    }
    private func keptProject(_ id: String = "d79d4c15-d786-461c-b76e-ec687c8e2dad") throws -> Project {
        try JSONDecoder().decode(Project.self, from: Data(#"{"id":"\#(id)","createdAtMs":1,"updatedAtMs":2,"state":"ready","kind":"fit","photos":[],"passes":[{"startedAtMs":1,"endedAtMs":1000,"status":"done"}],"current":{"model":"current/model.stl","renders":[]},"picture":"pictures/part-0123456789abcdef.png","pictures":{"part":"pictures/part-0123456789abcdef.png"}}"#.utf8))
    }

    /// P1: the Mac's list is the truth even when it is empty (every project deleted): every kept file goes. A saved list
    /// that is empty never prunes.
    func testAnEmptyListFromTheMacLetsEveryKeptFileGoAndASavedOneDoesNot() throws {
        let (filler, library, base) = filler(FileMac())
        defer { try? FileManager.default.removeItem(at: base) }
        let file = base.appending(path: "arrived"); try Data("png".utf8).write(to: file)
        try library.commit(file, project: "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11", name: "pictures/a.png", version: 1, file: "a.png")
        filler.fill([], fromMac: false)
        XCTAssertNotNil(library.latest(project: "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11", name: "pictures/a.png"), "a saved empty list prunes nothing")
        filler.fill([], fromMac: true)
        XCTAssertNil(library.latest(project: "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11", name: "pictures/a.png"), "the Mac's empty list: the deleted project's files go")
    }

    /// P2: a model queued on an unmetered link is not started once the link is metered (5G through David's tunnel); its
    /// picture still comes, and the model is released to be queued again on Wi-Fi.
    func testAQueuedModelWaitsWhenTheLinkTurnsMetered() async throws {
        let keep = OnDeviceLibrary.Keep.chosen
        OnDeviceLibrary.Keep.chosen = .models
        defer { OnDeviceLibrary.Keep.chosen = keep }
        let mac = FileMac()
        let (filler, _, base) = filler(mac)
        defer { try? FileManager.default.removeItem(at: base) }
        filler.linkChanged(expensive: false, constrained: false)
        filler.fill([try keptProject()], fromMac: true)
        XCTAssertTrue(filler.pending.contains { $0.contains("#model.stl#") }, "queued on Wi-Fi: \(filler.pending)")
        filler.linkChanged(expensive: true, constrained: false)
        for _ in 0..<50 where filler.isFilling { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertFalse(filler.isFilling)
        XCTAssertFalse(mac.paths.contains { $0.hasSuffix("/model.stl") }, "no model fetched on the metered link: \(mac.paths)")
        XCTAssertTrue(mac.paths.contains { $0.contains("/pictures/") }, "pictures come on any link: \(mac.paths)")
        XCTAssertFalse(filler.pending.contains { $0.contains("#model.stl#") }, "released, to be queued again on Wi-Fi")
    }

    /// P2: Clear releases what was queued, so the next list queues those files again.
    func testClearReleasesWhatWasQueued() throws {
        let keep = OnDeviceLibrary.Keep.chosen
        OnDeviceLibrary.Keep.chosen = .models
        defer { OnDeviceLibrary.Keep.chosen = keep }
        let (filler, _, base) = filler(FileMac())
        defer { try? FileManager.default.removeItem(at: base) }
        let project = try keptProject()
        filler.fill([project], fromMac: true)
        XCTAssertFalse(filler.pending.isEmpty)
        filler.clear()
        XCTAssertTrue(filler.pending.isEmpty, "Clear leaves no queued key behind: \(filler.pending)")
        filler.fill([project], fromMac: true)
        XCTAssertFalse(filler.pending.isEmpty, "the next list queues them again")
    }

    /// Review of #777: a stage's load that failed starts again on the next appear (as `.task` did before #769), never from
    /// `body` in a loop; one that is running or worked is never started twice for the same model.
    func testAFailedStageLoadStartsAgainOnAppearButAGoodOneNever() {
        let kick = BodyKick()
        XCTAssertTrue(kick.claim("a"), "body starts a new model")
        XCTAssertFalse(kick.claimOnAppear("a"), "the appear after it: running, not started twice")
        kick.failed("a")
        XCTAssertFalse(kick.claim("a"), "a failure that redraws body doesn't start it again")
        XCTAssertTrue(kick.claimOnAppear("a"), "the next appear starts the failed load again")
        XCTAssertFalse(kick.claimOnAppear("a"), "once")
        // Worked (never marked failed): refused on every appear.
        XCTAssertTrue(kick.claim("b"))
        XCTAssertFalse(kick.claimOnAppear("b")); XCTAssertFalse(kick.claim("b"))
        // A failure reported for an older model doesn't release the newer one.
        kick.failed("a")
        XCTAssertFalse(kick.claimOnAppear("b"))
    }

    /// P1: a gallery switch never shows the previous entry's picture: a kept picture counts only for its own key, also
    /// after the new entry's fetch failed.
    func testAGalleryEntryNeverShowsAnotherEntrysPicture() {
        let plate1 = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { $0.fill(CGRect(x: 0, y: 0, width: 4, height: 4)) }
        let kept = (key: "p#renders/plate_1.png#1200", image: plate1)
        let key2 = "p#renders/plate_2.png#1200"
        func decide(_ load: PictureLoad<UIImage>, kept: (key: String, image: UIImage)?) -> StagePicture.Shows {
            StagePicture.decide(still: .picture("renders/plate_2.png"), key: key2, load: load, memory: nil, kept: kept, earlier: nil,
                                libraryHas: false, missing: nil, unavailableLine: "No picture of this plate came with the file.")
        }
        var load = PictureLoad<UIImage>()
        load.start(key2, cached: nil)
        guard case .loading(nil) = decide(load, kept: kept) else { return XCTFail("plate 2 while it comes: never plate 1's picture") }
        load.decoded(nil, for: key2)
        guard case .notAvailable = decide(load, kept: kept) else { return XCTFail("plate 2 failed: says so, never shows plate 1") }
        guard case .shown(let shown) = decide(load, kept: (key2, plate1)), shown === plate1 else { return XCTFail("its own kept picture shows") }
    }

    /// #799: Settings → Share Diagnostics… gathers only what this phone keeps and makes the ZIP on the device itself (the
    /// system's `.forUploading` archiver). The pairing's token, pin and device id are handed to the redactor by value, and
    /// the Mac's name never leaves. The contents and every redaction rule are checked in CounterpartKit `PhoneDiagnosticsTests`.
    func testShareDiagnosticsGathersThePhonesStateAndMakesAZIPOnTheDevice() async throws {
        let mac = SettingsMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        let record = try XCTUnwrap(try pairing.store.read())
        let token = try XCTUnwrap(record.token), pin = try XCTUnwrap(record.publicKeySha256), device = try XCTUnwrap(record.deviceId)
        store.error = CompanionError(code: "unreachable", message: "No answer to \(token) for \(device)")
        store.link = .notAnswering

        let diagnostics = DiagnosticsShare.gather(store: store, cloud: MobileCloud())
        XCTAssertTrue(Set([token, pin, device]).isSubset(of: Set(diagnostics.secrets)), "the phone's own secrets go by value")
        XCTAssertEqual(diagnostics.pairing.state, "paired")
        XCTAssertEqual(diagnostics.pairing.link, "not answering")
        XCTAssertEqual(diagnostics.pairing.address, "https, IPv4 address")
        XCTAssertTrue(diagnostics.pairing.certificatePinned)
        XCTAssertEqual(diagnostics.errors.first, "Projects: unreachable: No answer to \(token) for \(device)")
        XCTAssertFalse(diagnostics.about.build.isEmpty)
        XCTAssertTrue(diagnostics.about.system.contains("OS"), diagnostics.about.system)
        XCTAssertEqual(diagnostics.trace, MediaTrace.shared.url)

        let folder = FileManager.default.temporaryDirectory.appending(path: "diagnostics-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let zip = try diagnostics.makeZIP(in: folder)
        XCTAssertEqual(zip.lastPathComponent, PhoneDiagnostics.fileName())
        let bytes = try Data(contentsOf: zip)
        XCTAssertEqual(Array(bytes.prefix(4)), [0x50, 0x4B, 0x03, 0x04], "a ZIP")
        // Entry names are stored as they are, so they can be read without unzipping.
        let names = String(decoding: bytes, as: UTF8.self)
        for name in ["about.txt", "pairing.json", "errors.txt", "drafts.json", "notes.txt"] {
            XCTAssertTrue(names.contains("Counterpart Phone Diagnostics ") && names.contains(name), name)
        }

        // The path the share sheet takes: the FileRepresentation itself (main-actor gather, detached ZIP, SentTransferredFile).
        let shared = try await DiagnosticsShare(store: store, cloud: MobileCloud()).exported(as: .zip)
        XCTAssertEqual(Array(shared.prefix(4)), [0x50, 0x4B, 0x03, 0x04], "the share sheet gets a ZIP")
        let sharedNames = String(decoding: shared, as: UTF8.self)
        for name in ["about.txt", "pairing.json", "notes.txt"] { XCTAssertTrue(sharedNames.contains(name), name) }
        XCTAssertFalse(sharedNames.contains(token), "the shared ZIP's names carry no token")
    }

    /// #720: a launch into one project's page reads that project alone, before (or without) the list. That one project is
    /// not the Mac's list, so the library must not take every other project as deleted and let its files go.
    func testOneProjectReadAloneIsNotTheMacsListForTheLibrary() {
        let mac = SettingsMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        let project = Project(id: "d79d4c15-d786-461c-b76e-ec687c8e2dad", createdAtMs: 1, updatedAtMs: 2, state: .ready)
        XCTAssertTrue(store.replace(project, ticket: store.startRequest()))
        XCTAssertEqual(store.projects.map(\.id), [project.id])
        XCTAssertFalse(store.listedFromMac, "one project read alone never prunes the library")
        let library = OnDeviceLibrary(base: FileManager.default.temporaryDirectory.appending(path: "prune-\(UUID().uuidString)"))
        library.use(mac: "m")
        let other = "0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11"
        let file = FileManager.default.temporaryDirectory.appending(path: "kept-\(UUID().uuidString)")
        try? Data("png".utf8).write(to: file)
        _ = try? library.commit(file, project: other, name: "pictures/a.png", version: 1, file: "a.png")
        let filler = LibraryFiller(client: CompanionClient(pairing: pairing, transport: mac, library: library))
        filler.fill(store.projects, fromMac: store.listedFromMac)
        XCTAssertNotNil(library.latest(project: other, name: "pictures/a.png"), "another project's kept picture stays")
        try? FileManager.default.removeItem(at: library.base)
    }

    /// PRD §8.10: an update the Mac said waits, whose finishing event never came, stops claiming to wait and lets Update
    /// and Move be pressed again; word from the Mac before then (it started) is kept as it is.
    func testAWaitThatNeverHearsBackBecomesASentenceAndUpdateComesBack() async throws {
        let mac = SettingsMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        store.mcpWaits.waitingLimit = .milliseconds(50)
        func event(_ type: String, _ mcpId: String) throws -> CounterpartEvent {
            try JSONDecoder().decode(CounterpartEvent.self, from: Data(#"{"v":1,"seq":1,"id":"e","at":"2026-11-07T19:52:31Z","type":"\#(type)","title":"t","body":"","notify":"none","data":{"mcpId":"\#(mcpId)"}}"#.utf8))
        }
        await store.receive(try event("mcp.update.waiting", "mcp-0000000000000001"))
        let reply = try JSONDecoder().decode(MCPUpdate.self, from: Data(#"{"mcpId":"mcp-0000000000000002","state":"waiting"}"#.utf8))
        store.recordMCPUpdate("mcp-0000000000000002", MCPUpdateProgress(reply))
        XCTAssertEqual(store.mcpUpdates["mcp-0000000000000002"]?.isRunning, true, "Update and Move are held while it waits")
        await store.receive(try event("mcp.update.started", "mcp-0000000000000002"))
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(store.mcpUpdates["mcp-0000000000000001"], .unheard)
        XCTAssertEqual(store.mcpUpdates["mcp-0000000000000001"]?.words, "Counterpart didn’t say whether this updated. Try Update again.")
        XCTAssertEqual(store.mcpUpdates["mcp-0000000000000001"]?.isRunning, false, "Update and Move can be pressed again")
        XCTAssertEqual(store.mcpUpdates["mcp-0000000000000002"]?.state, "started", "an update that started is left alone")
        // An update under way has its own, longer clock (35 min: the companion's three install steps and the restart).
        XCTAssertEqual(store.mcpWaits.startedLimit, .seconds(35 * 60))
        store.mcpWaits.startedLimit = .milliseconds(50)
        await store.receive(try event("mcp.update.started", "mcp-0000000000000002"))
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(store.mcpUpdates["mcp-0000000000000002"], .unheard, "a start that never finishes says so too")
        XCTAssertEqual(store.mcpUpdates["mcp-0000000000000002"]?.isRunning, false)
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
        store.link = .connected
        mac.answers = false
        _ = await store.reload("d79d4c15-d786-461c-b76e-ec687c8e2dad")
        XCTAssertEqual(store.link, .notAnswering, "a detail refresh that cannot reach the Mac must update Settings too")
        XCTAssertEqual(store.reachable, false)
        XCTAssertEqual(store.error?.code, "unreachable")
        mac.answers = true
        _ = await store.reload("d79d4c15-d786-461c-b76e-ec687c8e2dad")
        XCTAssertEqual(store.reachable, true, "even a confirmed 404 proves the Mac answered")
        XCTAssertNil(store.error, "the connection error clears once the Mac answers again")
    }

    /// A project refresh reports every failure to the link, not only "didn't answer": pairing lost on a refresh must
    /// not leave Settings saying "Connected now", and a refusal ends a stale "isn't answering".
    func testAProjectRefreshThatFailsForAnyReasonUpdatesTheLink() async {
        let mac = RefusingMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        store.link = .connected
        mac.status = 401; mac.code = "pairing-changed"
        let lost = await store.reload("d79d4c15-d786-461c-b76e-ec687c8e2dad")
        XCTAssertEqual(lost?.needsPairing, true)
        guard case .needsPairing = store.link else { return XCTFail("pairing lost on a refresh: \(store.link)") }
        XCTAssertEqual(store.error?.needsPairing, true)
        store.link = .notAnswering; store.error = .unreachable
        mac.status = 409; mac.code = "invalid-state"
        _ = await store.reload("d79d4c15-d786-461c-b76e-ec687c8e2dad")
        XCTAssertEqual(store.link, .connected, "a refusal proves the Mac is there")
        XCTAssertNil(store.error)
    }

    /// Home's line and banner and Settings' row read one value, so they can't say different things; and a request the
    /// Mac refused is that request's own problem (a refused delete once cleared a banner that was showing).
    func testARefusedRequestIsNotAConnectionProblemAndAConnectionProblemIsNotClearedByOne() {
        let mac = SettingsMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        XCTAssertEqual(store.link, .checking)
        store.requestFailed(.unreachable)
        XCTAssertEqual(store.link, .notAnswering)
        XCTAssertEqual(store.error, .unreachable)
        XCTAssertEqual(store.reachable, false)
        // The Mac answers, with a refusal: it is there, and the banner goes.
        store.requestFailed(CompanionError(code: "invalid-state", message: "That project is printing."))
        XCTAssertEqual(store.link, .connected)
        XCTAssertNil(store.error)
        // A list error that isn't about the connection stays through someone else's refused request.
        let broken = CompanionError(code: "invalid-response", message: "Your Mac sent something this app can't read.")
        store.error = broken
        store.requestFailed(CompanionError(code: "not-found", message: "That project is gone."))
        XCTAssertEqual(store.error, broken)
        let again = CompanionError(code: "pairing-changed", message: "Connect to your Mac again.")
        store.requestFailed(again)
        XCTAssertEqual(store.link, .needsPairing(again))
        XCTAssertEqual(store.error, again)
    }

    func testFailedEventPollDoesNotReportConnectedWhileResyncIsStillWaiting() async {
        let mac = ResyncMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        let stopped = expectation(description: "following stops once cancelled")
        let following = Task { await store.follow(); stopped.fulfill() }
        let refreshing = await mac.waitForRefresh()
        XCTAssertTrue(refreshing, "the failed poll asks for the projects again")
        XCTAssertNil(store.reachable, "a retry signal is not a successful response from the Mac")
        following.cancel()
        await mac.finishRefresh()
        _ = await waited([stopped], "following stops once cancelled")
    }

    func testOlderMissingReplyCannotReplaceANewerProjectOrItsErrorState() async throws {
        let mac = DelayedMissingProjectMac()
        let pairing = PairingClient(store: PairingStore(store: Fixtures.store()), transport: mac)
        let store = ProjectsStore(mac: MacConnection(client: CompanionClient(pairing: pairing, transport: mac)), pairing: pairing)
        let answered = expectation(description: "the older reload answers")
        let pending = Task { let failure = await store.reload("21fe17ec-1ee1-4a60-b24d-c0a8f74879b1"); answered.fulfill(); return failure }
        let asked = await mac.waitForRequest()
        XCTAssertTrue(asked, "the reload asks the Mac")
        let project = Project(id: "21fe17ec-1ee1-4a60-b24d-c0a8f74879b1", createdAtMs: 1, updatedAtMs: 2, state: .ready)
        store.replace(project, ticket: store.startRequest())
        await mac.finish()
        guard await waited([answered], "the older reload answers") else { return }
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
    /// True once the refresh is asked for; false after `seconds`.
    func waitForRefresh(within seconds: Double = patience) async -> Bool {
        await until(seconds) { await self.refresh != nil }
    }
    func finishRefresh() {
        refresh?.resume(throwing: TransportError("cancelled")); refresh = nil
    }
    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        guard request.url?.path == "/v1/objects" else { throw TransportError("network") }
        return try await withCheckedThrowingContinuation { refresh = $0 }
    }
}

/// A Mac that serves settings, can stop answering, and can refuse an AI choice.
/// A Mac that answers every file with a few bytes and records what was asked for (review of #741).
private final class FileMac: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _paths: [String] = []
    var paths: [String] { lock.withLock { _paths } }
    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        lock.withLock { _paths.append(request.url?.path ?? "") }
        return HTTPReply(status: 200, body: Data("file".utf8))
    }
}

/// A Mac that tags its model `"m1"` and answers 304 to a request that has it (#720).
private final class TaggedMac: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _bodies = 0, _tags: [String?] = []
    var bodies: Int { lock.withLock { _bodies } }
    var tags: [String?] { lock.withLock { _tags } }
    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        let tag = request.value(forHTTPHeaderField: "If-None-Match")
        return lock.withLock {
            _tags.append(tag)
            if tag == "\"m1\"" { return HTTPReply(status: 304, body: Data(), headers: ["ETag": "\"m1\""]) }
            _bodies += 1
            return HTTPReply(status: 200, body: Data("solid".utf8), headers: ["ETag": "\"m1\""])
        }
    }
}

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
    /// True once the reload is asked for; false after `seconds`.
    func waitForRequest(within seconds: Double = patience) async -> Bool {
        await until(seconds) { await self.reply != nil }
    }
    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        await withCheckedContinuation { reply = $0 }
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
    private(set) var requested: [String] = []
    /// True once a download is asked for; false after `seconds`.
    func waitForDownload(within seconds: Double = patience) async -> Bool {
        await until(seconds) { await self.download != nil }
    }
    func finish() { download?.resume(throwing: TransportError("network")); download = nil }
    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        requested.append(request.url?.path ?? "")
        return try await withCheckedThrowingContinuation { download = $0 }
    }
}

/// Every wait in this file ends (Nov 10: one waited 41 minutes on a download that never started and held the lane):
/// a wrong assumption fails in seconds.
private let patience: Double = 5

/// Checks `condition` every 10 ms until it holds or `seconds` pass; whether it held.
private func until(_ seconds: Double, _ condition: @Sendable () async -> Bool) async -> Bool {
    let end = ContinuousClock.now.advanced(by: .milliseconds(Int(seconds * 1000)))
    while await !condition() {
        if ContinuousClock.now >= end { return false }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return true
}

/// Waits at most `patience` for the expectations, failing the test (not hanging it) when they don't come.
@MainActor private func waited(_ expectations: [XCTestExpectation], _ what: String,
                               file: StaticString = #filePath, line: UInt = #line) async -> Bool {
    let result = await XCTWaiter().fulfillment(of: expectations, timeout: patience)
    if result != .completed { XCTFail("\(what): not within \(Int(patience)) s (\(result.rawValue))", file: file, line: line) }
    return result == .completed
}

/// A Mac that answers every request with one refusal.
private final class RefusingMac: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _status = 409, _code = "invalid-state"
    var status: Int { get { lock.withLock { _status } } set { lock.withLock { _status = newValue } } }
    var code: String { get { lock.withLock { _code } } set { lock.withLock { _code = newValue } } }

    func send(_ request: URLRequest, trust: TrustPolicy, limit: Int, resourceTimeout: TimeInterval) async throws -> HTTPReply {
        let (status, code) = lock.withLock { (_status, _code) }
        let body: [String: Any] = ["error": ["code": code, "message": "Refused."]]
        return HTTPReply(status: status, body: (try? JSONSerialization.data(withJSONObject: body)) ?? Data())
    }
}

/// A download that waits until the test lets it finish, counting how often it was asked.
private actor DownloadGate {
    private(set) var calls = 0
    private var opened: URL?
    func wait() async throws -> URL {
        calls += 1
        let end = ContinuousClock.now.advanced(by: .seconds(patience))
        while opened == nil, ContinuousClock.now < end { try await Task.sleep(for: .milliseconds(10)) }
        guard let opened else { throw CompanionError(code: "timeout", message: "Timed out.") }
        return opened
    }
    func open(_ url: URL) { opened = url }
}

private actor Counter {
    private(set) var value = 0
    func next() -> Int { value += 1; return value }
}


/// Ignores task cancellation so an old transfer can deliberately finish after recovery.
private actor HeldDownload {
    private var continuation: CheckedContinuation<URL, Never>?
    func wait() async -> URL { await withCheckedContinuation { continuation = $0 } }
    func open(_ url: URL) { continuation?.resume(returning: url); continuation = nil }
}

/// Nov 11 (David: AR "doesn't work on non-scanned items, never has"): the part's AR file was a Reality file named `.usdz`.
@MainActor final class ARModelTests: XCTestCase {
    /// A binary STL box, millimetres, Z up, its corner at the origin.
    static func boxSTL(_ size: SIMD3<Float> = [146, 40, 20]) -> Data {
        let c: [SIMD3<Float>] = (0..<8).map { i in SIMD3(Float(i & 1), Float((i >> 1) & 1), Float((i >> 2) & 1)) * size }
        let faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]
        let triangles = faces.flatMap { f in [[c[f[0]], c[f[1]], c[f[2]]], [c[f[0]], c[f[2]], c[f[3]]]] }
        var data = Data(count: 80)
        withUnsafeBytes(of: UInt32(triangles.count).littleEndian) { data.append(contentsOf: $0) }
        for t in triangles {
            for v in [SIMD3<Float>(0, 0, 0)] + t { for x in [v.x, v.y, v.z] { withUnsafeBytes(of: x.bitPattern.littleEndian) { data.append(contentsOf: $0) } } }
            data.append(contentsOf: [0, 0])
        }
        return data
    }

    /// The file AR Quick Look gets is the USDZ its name says, Quick Look can preview it, it is the part at true size in
    /// its spool's colour, and the Reality file an earlier build wrote beside it is gone.
    func testAPartsARFileIsARealUSDZThatQuickLookOpensAtTrueSize() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let stl = folder.appendingPathComponent("model.stl")
        try Self.boxSTL().write(to: stl)
        let stale = folder.appendingPathComponent("model.ff8800.usdz")
        try await ModelEntity(mesh: .generateBox(size: 0.1), materials: [SimpleMaterial()]).write(to: stale)
        XCTAssertFalse(PartUSDZ.isUSDZ(stale), "what the app used to write")

        let made = await ARModel.usdz(fromSTL: stl, tint: "#FF8800")
        let url = try XCTUnwrap(made)
        XCTAssertEqual(url.lastPathComponent, "model.ff8800.ar.usdz")
        XCTAssertTrue(PartUSDZ.isUSDZ(url), "a USD layer first in the zip, by its bytes")
        XCTAssertEqual(UTType(filenameExtension: url.pathExtension), .usdz)
        #if targetEnvironment(simulator)
        // The iOS 27.2 simulator answered false here for this file (Nov 11, iPhone 17 Pro and iPad Pro 13): not yet known
        // whether the simulator's Quick Look has no 3D previewer or the file is refused. A real device must answer true.
        print("ar.canPreview simulator:", QLPreviewController.canPreview(url as NSURL))
        #else
        XCTAssertTrue(QLPreviewController.canPreview(url as NSURL))
        #endif
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path), "the old Reality file is removed, never reused")
        let bounds = try await Entity(contentsOf: url).visualBounds(relativeTo: nil)
        XCTAssertEqual(bounds.extents.x, 0.146, accuracy: 0.0005, "146 mm, in metres")
        XCTAssertEqual(bounds.extents.y, 0.020, accuracy: 0.0005, "STL Z is up")
        XCTAssertEqual(bounds.min.y, 0, accuracy: 0.0005, "it rests on the surface")
        // Asked again, the file is reused, not rewritten.
        let again = await ARModel.usdz(fromSTL: stl, tint: "#FF8800")
        XCTAssertEqual(again, url)
        XCTAssertEqual(ARModel.target(forSTL: stl, tint: nil).lastPathComponent, "model.neutral.ar.usdz")
    }

    /// #606 (audit 2026-11-11 §1): writing the AR file has a deadline. Work that ignores cancellation, as Model I/O's
    /// conversion does, ends the wait at the deadline instead of leaving "Preparing AR…" up for good; work that finishes
    /// in time gives its result; a cancelled caller is let go at once.
    func testPreparingARStopsAtItsDeadlineEvenWhenTheWorkNeverListens() async throws {
        let stuck = Task.detached { () throws -> Int in Thread.sleep(forTimeInterval: 4); return 1 }
        let start = ContinuousClock.now
        do { _ = try await ARModel.bounded(stuck, deadline: .milliseconds(200)); XCTFail("the deadline should have ended it") }
        catch { XCTAssertTrue(error is ARModel.Deadline, "\(error)") }
        XCTAssertLessThan(ContinuousClock.now - start, .seconds(2), "it never waits for the stuck work")
        XCTAssertTrue(stuck.isCancelled, "the work is told to stop")

        let quick = Task.detached { () throws -> Int in 7 }
        let value = try await ARModel.bounded(quick, deadline: .seconds(5))
        XCTAssertEqual(value, 7)

        let slow = Task.detached { () throws -> Int in Thread.sleep(forTimeInterval: 4); return 1 }
        let waiter = Task { try await ARModel.bounded(slow, deadline: .seconds(30)) }
        try await Task.sleep(for: .milliseconds(100))
        let cancelledAt = ContinuousClock.now
        waiter.cancel()
        do { _ = try await waiter.value; XCTFail("a cancelled caller gets no result") } catch { XCTAssertTrue(error is CancellationError, "\(error)") }
        XCTAssertLessThan(ContinuousClock.now - cancelledAt, .seconds(2))
    }

    // MARK: A scan stopped after it kept photos (#791)

    private func draft(_ run: String, _ status: String, project: String = "dad") -> [String: Any] {
        ["runID": run, "status": status, "origin": ["projectId": project]]
    }

    /// David, Nov 14: 68 photos, Done never enabled (only 2 from above), Stop, and the Mac got a project with no scan:
    /// "where the fuck is the scan then ?". A stopped run that kept photos is the project's scan, to send.
    func testAStoppedScanThatKeptPhotosIsTheProjectsScanToSend() {
        let stopped = "3b072103-c190-41b9-8158-03177424d0c5"
        let kept = MacConnection.keptScan(for: "dad", drafts: [draft(stopped, "stopped")], active: nil) { _ in 68 }
        XCTAssertEqual(kept, .stopped(run: stopped, photos: 68))
        for status in ["failed", "interrupted"] {
            XCTAssertEqual(MacConnection.keptScan(for: "dad", drafts: [draft(stopped, status)], active: nil) { _ in 12 },
                           .stopped(run: stopped, photos: 12), status)
        }
    }

    /// Newest run first, as the store lists them: a finished scan after a stopped one wins, a stopped one after a
    /// finished one wins, a stopped run with no photos is passed over, the run still capturing and other projects' runs
    /// don't count.
    func testTheNewestRunThatKeptSomethingIsTheOneSent() {
        let a = "aaaaaaaa-0000-4000-8000-000000000001", b = "bbbbbbbb-0000-4000-8000-000000000002"
        XCTAssertEqual(MacConnection.keptScan(for: "dad", drafts: [draft(b, "ready"), draft(a, "stopped")], active: nil) { _ in 9 },
                       .finished(run: b))
        XCTAssertEqual(MacConnection.keptScan(for: "dad", drafts: [draft(b, "stopped"), draft(a, "ready")], active: nil) { _ in 9 },
                       .stopped(run: b, photos: 9))
        XCTAssertEqual(MacConnection.keptScan(for: "dad", drafts: [draft(b, "stopped"), draft(a, "ready")], active: nil) { $0 == b ? 0 : 9 },
                       .finished(run: a))
        XCTAssertNil(MacConnection.keptScan(for: "dad", drafts: [draft(b, "stopped")], active: b) { _ in 9 })
        XCTAssertNil(MacConnection.keptScan(for: "dad", drafts: [draft(b, "stopped", project: "other")], active: nil) { _ in 9 })
        XCTAssertNil(MacConnection.keptScan(for: "dad", drafts: [draft("Not-A-UUID", "stopped")], active: nil) { _ in 9 })
    }

    /// Send on a stopped scan, cut short (the app closed mid-upload): on relaunch its project page finishes the send
    /// from the same kept photos, as it does for a finished scan (review of #795).
    func testASendCutShortResumesForAStoppedScanToo() {
        let stopped = "3b072103-c190-41b9-8158-03177424d0c5"
        let kept = MacConnection.keptScan(for: "dad", drafts: [draft(stopped, "stopped")], active: nil) { _ in 68 }
        XCTAssertTrue(MacConnection.resumesSend(handheldFinished: false, kept: kept))
        XCTAssertTrue(MacConnection.resumesSend(handheldFinished: false, kept: .finished(run: stopped)))
        XCTAssertTrue(MacConnection.resumesSend(handheldFinished: true, kept: nil))
        XCTAssertFalse(MacConnection.resumesSend(handheldFinished: false, kept: nil), "nothing on this phone to send")
    }

    /// Review of #795: a stray stopped scan (1–19 photos) is attached but not named to the Mac until Send, so Remove can
    /// take it off; removed, it is never sent and an older finished scan, if any, is the project's again. Enough photos
    /// are named at once. Kept, a small one is still what Send sends.
    func testASmallStoppedScanWaitsForSendAndCanBeRemoved() {
        let small = "cccccccc-0000-4000-8000-000000000003", older = "dddddddd-0000-4000-8000-000000000004"
        XCTAssertFalse(MacConnection.declaresAtOnce(.stopped(run: small, photos: 2)))
        XCTAssertTrue(MacConnection.declaresAtOnce(.stopped(run: small, photos: 68)))
        XCTAssertFalse(MacConnection.declaresAtOnce(.finished(run: small)), "a finished scan goes with its own upload")
        XCTAssertFalse(MacConnection.declaresAtOnce(nil))
        XCTAssertEqual(MacConnection.keptScan(for: "dad", drafts: [draft(small, "stopped")], active: nil) { _ in 2 },
                       .stopped(run: small, photos: 2), "kept, Send sends it")
        XCTAssertNil(MacConnection.keptScan(for: "dad", drafts: [draft(small, "stopped")], active: nil, removed: [small]) { _ in 2 },
                     "removed: the project designs from the words")
        XCTAssertEqual(MacConnection.keptScan(for: "dad", drafts: [draft(small, "stopped"), draft(older, "ready")], active: nil,
                                              removed: [small]) { _ in 2 }, .finished(run: older))
    }

    /// Review of #795: Stop on the project page sends only the run it just stopped. A capture that kept no photos
    /// finds the older stopped run still there, and must not send it again in its place.
    func testStopWithNoPhotosNeverResendsAnOlderStoppedScan() {
        let a = "aaaaaaaa-0000-4000-8000-000000000001", b = "bbbbbbbb-0000-4000-8000-000000000002"
        XCTAssertNil(MacConnection.justStopped(before: .stopped(run: a, photos: 30), after: .stopped(run: a, photos: 30)))
        XCTAssertEqual(MacConnection.justStopped(before: .stopped(run: a, photos: 30), after: .stopped(run: b, photos: 25)), 25)
        XCTAssertEqual(MacConnection.justStopped(before: nil, after: .stopped(run: b, photos: 3)), 3)
        XCTAssertNil(MacConnection.justStopped(before: nil, after: .finished(run: b)))
        XCTAssertNil(MacConnection.justStopped(before: .finished(run: a), after: nil))
    }

    /// Review of #801 (F4): the newest run decides. A newest stopped run that kept no photos, or was removed, never
    /// hands Send or resume an older stopped run it superseded; only an older finished scan.
    func testTheNewestStoppedRunDecidesNeverAnOlderStoppedOne() {
        let newest = "eeeeeeee-0000-4000-8000-000000000005", older = "ffffffff-0000-4000-8000-000000000006"
        let finished = "aaaaaaaa-0000-4000-8000-000000000001"
        XCTAssertNil(MacConnection.keptScan(for: "dad", drafts: [draft(newest, "stopped"), draft(older, "stopped")], active: nil) {
            $0 == newest ? 0 : 40 }, "no photos in the newest: the older stop isn't sent instead")
        XCTAssertNil(MacConnection.keptScan(for: "dad", drafts: [draft(newest, "stopped"), draft(older, "stopped")], active: nil,
                                            removed: [newest]) { _ in 40 }, "removed newest: nor here")
        XCTAssertEqual(MacConnection.keptScan(for: "dad", drafts: [draft(newest, "stopped"), draft(older, "stopped"), draft(finished, "ready")],
                                              active: nil, removed: [newest]) { _ in 40 }, .finished(run: finished), "an older finished scan still counts")
    }

    /// Review of #801 (regression watcher on 63a78f4c): once a run is declared, the phone and the Mac agree on it. A
    /// 68-photo stop the Mac was told about stays the project's scan when a newer capture keeps no photos or is removed,
    /// so Send sends it and the draft is never stranded; an older stop that was never declared still isn't sent; a newer
    /// 20-photo stop is declared in its place.
    func testADeclaredScanStaysTheProjectsScanUntilANewerOneIsDeclared() throws {
        let declared = "3b072103-c190-41b9-8158-03177424d0c5", newer = "eeeeeeee-0000-4000-8000-000000000005"
        let drafts = [draft(newer, "stopped"), draft(declared, "stopped")]
        XCTAssertEqual(MacConnection.keptScan(for: "dad", drafts: drafts, active: nil, declared: declared) { $0 == newer ? 0 : 68 },
                       .stopped(run: declared, photos: 68), "a newer stop with no photos: the declared scan, which Send sends")
        XCTAssertEqual(MacConnection.keptScan(for: "dad", drafts: drafts, active: nil, removed: [newer], declared: declared) { $0 == newer ? 5 : 68 },
                       .stopped(run: declared, photos: 68), "a newer stop removed: the same")
        XCTAssertNil(MacConnection.keptScan(for: "dad", drafts: drafts, active: nil) { $0 == newer ? 0 : 12 },
                     "an older stop never declared (under 20) under an empty newer one: nothing, as before")
        XCTAssertEqual(MacConnection.keptScan(for: "dad", drafts: drafts, active: nil, declared: declared) { $0 == newer ? 30 : 68 },
                       .stopped(run: newer, photos: 30), "a newer stop with photos is the project's scan")

        let defaults = try XCTUnwrap(UserDefaults(suiteName: "declared-\(UUID().uuidString)"))
        MacConnection.setDeclaredRun(project: "dad", run: declared, defaults)
        MacConnection.setDeclaredRun(project: "dad", run: newer, defaults)
        XCTAssertEqual(MacConnection.declaredRuns(defaults), ["dad": newer], "a newer declared run replaces it")
    }

    /// Review of #801 (F1): a stopped scan's declare is recorded and retried until the Mac acknowledges it. The first try
    /// fails (the Mac is asleep): it stays. The next succeeds: it's done. A run no longer the project's kept scan, one
    /// with too few photos, and one the Mac refuses are dropped without retrying forever.
    func testAStoppedScansDeclareIsRetriedUntilTheMacHasIt() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "declares-\(UUID().uuidString)"))
        let run = "3b072103-c190-41b9-8158-03177424d0c5", other = "bbbbbbbb-0000-4000-8000-000000000002"
        var kept: [String: MacConnection.KeptScan] = ["dad": .stopped(run: run, photos: 68)]
        var declared: [String] = []
        MacConnection.setPendingDeclare(project: "dad", run: run, defaults)

        await MacConnection.retryDeclares(defaults, kept: { kept[$0] }, declare: { _, _ in throw CompanionError.unreachable })
        XCTAssertEqual(MacConnection.pendingDeclares(defaults), ["dad": run], "the Mac didn't answer: kept for next time")
        await MacConnection.retryDeclares(defaults, kept: { kept[$0] }, declare: { project, run in declared.append("\(project) \(run)"); return true })
        XCTAssertEqual(declared, ["dad \(run)"])
        XCTAssertEqual(MacConnection.pendingDeclares(defaults), [:], "acknowledged")
        XCTAssertEqual(MacConnection.declaredRuns(defaults), ["dad": run], "and recorded as the run the Mac has")

        MacConnection.setPendingDeclare(project: "dad", run: run, defaults)
        kept["dad"] = .stopped(run: other, photos: 30)
        await MacConnection.retryDeclares(defaults, kept: { kept[$0] }, declare: { _, _ in XCTFail("superseded: not declared"); return false })
        XCTAssertEqual(MacConnection.pendingDeclares(defaults), [:])

        MacConnection.setPendingDeclare(project: "dad", run: run, defaults)
        kept["dad"] = .stopped(run: run, photos: 5)
        await MacConnection.retryDeclares(defaults, kept: { kept[$0] }, declare: { _, _ in XCTFail("too few: waits for Send"); return false })
        XCTAssertEqual(MacConnection.pendingDeclares(defaults), [:])

        MacConnection.setPendingDeclare(project: "dad", run: run, defaults)
        kept["dad"] = .stopped(run: run, photos: 68)
        await MacConnection.retryDeclares(defaults, kept: { kept[$0] }, declare: { _, _ in
            throw CompanionError(code: "invalid-state", message: "The scan can only be added before the touch-up starts.") })
        XCTAssertEqual(MacConnection.pendingDeclares(defaults), [:], "the Mac refused: the project has moved on")

        // Review of #819 (F5): a Mac that can't rebuild from photos isn't told, so the run is never recorded as its scan,
        // and Remove later has nothing to forget there (it never asks that Mac to update).
        MacConnection.setPendingDeclare(project: "dad", run: run, defaults)
        MacConnection.setDeclaredRun(project: "dad", run: run, defaults)  // as recordStoppedDeclare leaves it
        await MacConnection.retryDeclares(defaults, kept: { kept[$0] }, declare: { _, _ in false })
        XCTAssertEqual(MacConnection.pendingDeclares(defaults), [:])
        XCTAssertNil(MacConnection.declaredRuns(defaults)["dad"], "not the scan that Mac waits for")
        XCTAssertNil(MacConnection.macRun("dad", defaults))
        try await MacConnection.removeStoppedScan(project: "dad", run: run, defaults, forget: { _, _ in
            throw CompanionError(code: "needs-update", message: "Update Counterpart on your Mac to remove a scan it already knows about.") })
        XCTAssertTrue(MacConnection.removedStoppedScans(defaults).contains(run), "Remove goes through")
    }

    /// A new scan clears a stopped one's line and its Remove (regression watcher on e8de25fe): a 12-photo stop offers
    /// Remove; once a scan finishes in its place, `scan-use-remove` is gone and the line with it. 20 or more offer it too
    /// (David, Nov 15).
    func testANewScanClearsAStoppedScansRemove() {
        var stop = NewObjectView.ScanStop()
        XCTAssertNil(stop.removableRun, "no scan, no Remove")
        stop.stopped(run: "run12", photos: 12)
        XCTAssertEqual(stop.removableRun, "run12", "a few photos: Remove takes this run off")
        XCTAssertEqual(stop.photos, 12)
        stop.clear()  // what every path that attaches a finished scan does
        XCTAssertNil(stop.removableRun, "Remove isn't shown beside the finished scan")
        XCTAssertNil(stop.photos, "nor the stopped line")
        stop.stopped(run: "run68", photos: 68)
        XCTAssertEqual(stop.removableRun, "run68", "enough photos can be taken off too")
        XCTAssertEqual(stop.photos, 68)
    }

    /// David, Nov 15 ("are you kidding me"): a 68-photo stop the Mac was told about could never be taken off. Remove now
    /// takes it off the phone at once, and the Mac forgets it: then, or when it next answers (review of #819, F1). Only
    /// a Mac too old to forget a scan it was told about keeps it, and says to update (F5).
    func testRemoveTakesAStoppedScanOffAndTheMacForgetsIt() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "remove-\(UUID().uuidString)"))
        let run = "3b072103-c190-41b9-8158-03177424d0c5"
        let mac = FakeMac()
        let told = try await MacConnection.declare(project: "dad", run: run, defaults, forget: mac.forget, declare: mac.declare(run))
        XCTAssertTrue(told)
        MacConnection.setDeclaredRun(project: "dad", run: run, defaults)
        mac.away = true
        try await MacConnection.removeStoppedScan(project: "dad", run: run, defaults, forget: mac.forget)
        XCTAssertTrue(MacConnection.removedStoppedScans(defaults).contains(run), "the Mac is away: Remove still goes through")
        XCTAssertEqual(MacConnection.pendingForgets(defaults), ["dad": [run]], "and the forget waits for the Mac")
        XCTAssertEqual(mac.declared, run)
        XCTAssertEqual(MacConnection.declaredRuns(defaults), [:], "no longer the scan the Mac waits for")
        XCTAssertEqual(MacConnection.acknowledgedRuns(defaults), [:])
        mac.away = false
        await MacConnection.retryForgets(defaults, forget: mac.forget)
        XCTAssertNil(mac.declared, "the Mac answered and forgot it: its draft can start from its words")
        XCTAssertEqual(MacConnection.pendingForgets(defaults), [:])
        XCTAssertEqual(mac.heard, ["declare \(run)", "forget \(run)"])

        // Declared while the Mac was asleep, never acknowledged: the declare may have landed, so it's forgotten too.
        let pending = "bbbbbbbb-0000-4000-8000-000000000002"
        MacConnection.setPendingDeclare(project: "hook", run: pending, defaults)
        try await MacConnection.removeStoppedScan(project: "hook", run: pending, defaults, forget: mac.forget)
        XCTAssertEqual(mac.heard.last, "forget \(pending)")
        XCTAssertEqual(MacConnection.pendingDeclares(defaults), [:], "and is never declared later")
        XCTAssertTrue(MacConnection.removedStoppedScans(defaults).contains(pending))

        // Review of #819 (F6): Remove on a stale run never clears a newer run's pending declare.
        let newer = "dddddddd-0000-4000-8000-000000000004"
        MacConnection.setPendingDeclare(project: "hook", run: newer, defaults)
        try await MacConnection.removeStoppedScan(project: "hook", run: pending, defaults, forget: { _, _ in XCTFail("not the Mac's") })
        XCTAssertEqual(MacConnection.pendingDeclares(defaults), ["hook": newer])

        // A Mac too old to forget: a scan it was told about stays, and Remove says to update; one it may never have
        // heard of (only pending) comes off (F5).
        let old = "ffffffff-0000-4000-8000-000000000006"
        let tooOld: (String, String) async throws -> Void = { _, _ in
            throw CompanionError(code: "needs-update", message: "Update Counterpart on your Mac to remove a scan it already knows about.") }
        MacConnection.setAcknowledgedRun(project: "pin", run: old, defaults)
        do {
            try await MacConnection.removeStoppedScan(project: "pin", run: old, defaults, forget: tooOld)
            XCTFail("told, and the Mac can't forget: Remove says so")
        } catch let failure as CompanionError { XCTAssertEqual(failure.code, "needs-update") }
        XCTAssertFalse(MacConnection.removedStoppedScans(defaults).contains(old), "still the project's scan")
        MacConnection.setPendingDeclare(project: "cup", run: old, defaults)
        try await MacConnection.removeStoppedScan(project: "cup", run: old, defaults, forget: tooOld)
        XCTAssertTrue(MacConnection.removedStoppedScans(defaults).contains(old))
        XCTAssertEqual(MacConnection.pendingForgets(defaults)["cup"], [old], "kept in case it landed, for after the update")

        // Under 20, never declared: nothing to tell the Mac.
        let few = "cccccccc-0000-4000-8000-000000000003"
        try await MacConnection.removeStoppedScan(project: "clip", run: few, defaults, forget: { _, _ in XCTFail("never told") })
        XCTAssertTrue(MacConnection.removedStoppedScans(defaults).contains(few))
    }

    /// Review of #819 (F1): a declare that landed but whose reply was lost looks exactly like one that never arrived.
    /// Remove with the Mac away then still has it forgotten, when the Mac comes back, and its draft starts from its words.
    func testRemoveAfterALostReplyStillHasTheMacForgetIt() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "lost-\(UUID().uuidString)"))
        let run = "3b072103-c190-41b9-8158-03177424d0c5", newer = "eeeeeeee-0000-4000-8000-000000000005"
        let mac = FakeMac()
        MacConnection.setPendingDeclare(project: "dad", run: run, defaults)
        MacConnection.setDeclaredRun(project: "dad", run: run, defaults)  // as recordStoppedDeclare leaves it
        mac.dropReply = true
        await MacConnection.retryDeclares(defaults, kept: { _ in .stopped(run: run, photos: 68) }, declare: { project, run in
            try await MacConnection.declare(project: project, run: run, defaults, forget: mac.forget, declare: mac.declare(run)) })
        XCTAssertEqual(mac.declared, run, "the declare landed")
        XCTAssertEqual(MacConnection.pendingDeclares(defaults), ["dad": run], "but its reply was lost")
        mac.dropReply = false
        mac.away = true
        try await MacConnection.removeStoppedScan(project: "dad", run: run, defaults, forget: mac.forget)
        XCTAssertTrue(MacConnection.removedStoppedScans(defaults).contains(run), "Remove goes through")
        XCTAssertEqual(MacConnection.pendingForgets(defaults), ["dad": [run]])
        XCTAssertTrue(MacConnection.isRemoved("dad", run, defaults))
        mac.away = false
        await MacConnection.retryForgets(defaults, forget: mac.forget)
        XCTAssertEqual(mac.heard.last, "forget \(run)", "the last thing the Mac hears is the forget")
        XCTAssertNil(mac.declared, "the draft can start from its words")
        XCTAssertEqual(MacConnection.pendingForgets(defaults), [:])

        // A forget still waiting goes before the project's next declare.
        mac.away = true
        MacConnection.addPendingForget(project: "dad", run: run, defaults)
        mac.declared = run
        mac.away = false
        let named = try await MacConnection.declare(project: "dad", run: newer, defaults, forget: mac.forget, declare: mac.declare(newer))
        XCTAssertTrue(named)
        XCTAssertEqual(Array(mac.heard.suffix(2)), ["forget \(run)", "declare \(newer)"])
        XCTAssertEqual(MacConnection.pendingForgets(defaults), [:])
    }

    /// Review of #819 (N1): every Remove made while the Mac is away is kept, not only the last, and a Mac too old to
    /// forget keeps it for after its update. When the Mac answers, it hears each forget, oldest first.
    func testEveryRemoveWhileTheMacIsAwayIsForgottenInOrder() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "forgets-\(UUID().uuidString)"))
        let first = "3b072103-c190-41b9-8158-03177424d0c5", second = "eeeeeeee-0000-4000-8000-000000000005"
        let mac = FakeMac()
        _ = try await MacConnection.declare(project: "dad", run: first, defaults, forget: mac.forget, declare: mac.declare(first))
        mac.away = true
        try await MacConnection.removeStoppedScan(project: "dad", run: first, defaults, forget: mac.forget)
        MacConnection.setPendingDeclare(project: "dad", run: second, defaults)   // a newer stop, recorded while away
        try await MacConnection.removeStoppedScan(project: "dad", run: second, defaults, forget: mac.forget)
        try await MacConnection.removeStoppedScan(project: "dad", run: second, defaults, forget: mac.forget)
        XCTAssertEqual(MacConnection.pendingForgets(defaults), ["dad": [first, second]], "both kept, once each")
        mac.away = false
        await MacConnection.retryForgets(defaults, forget: mac.forget)
        XCTAssertEqual(mac.heard, ["declare \(first)", "forget \(first)", "forget \(second)"])
        XCTAssertNil(mac.declared)
        XCTAssertEqual(MacConnection.pendingForgets(defaults), [:])

        // A Mac too old to forget keeps the forget for after its update; a refusal as no longer matching ends it.
        MacConnection.addPendingForget(project: "pin", run: first, defaults)
        await MacConnection.retryForgets(defaults, forget: { _, _ in
            throw CompanionError(code: "needs-update", message: "Update Counterpart on your Mac to remove a scan it already knows about.") })
        XCTAssertEqual(MacConnection.pendingForgets(defaults), ["pin": [first]], "still pending")
        await MacConnection.retryForgets(defaults, forget: { _, _ in
            throw CompanionError(code: "invalid-state", message: "A different scan is waiting for this project, so this one was left as it is.") })
        XCTAssertEqual(MacConnection.pendingForgets(defaults), [:])
    }

    /// Regression watcher on e6a975db: Remove right after Stop, while the stopped scan's declare is still on its way to the
    /// Mac. The Remove waits for that declare, and its forget is the last thing the Mac hears; nothing is left recorded
    /// as the Mac's, so the draft is never stranded "still on the phone".
    func testRemoveDuringAnInFlightDeclareForgetsAfterIt() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "race-\(UUID().uuidString)"))
        let run = "3b072103-c190-41b9-8158-03177424d0c5"
        let mac = FakeMac()
        mac.holdDeclare = true
        MacConnection.setPendingDeclare(project: "dad", run: run, defaults)
        MacConnection.setDeclaredRun(project: "dad", run: run, defaults)  // as recordStoppedDeclare leaves it
        let retry = Task { @MainActor in
            await MacConnection.retryDeclares(defaults, kept: { _ in .stopped(run: run, photos: 68) }, declare: { project, run in
                try await MacConnection.declare(project: project, run: run, defaults, forget: mac.forget, declare: mac.declare(run)) })
        }
        while mac.held == nil { await Task.yield() }
        let remove = Task { @MainActor in
            try await MacConnection.removeStoppedScan(project: "dad", run: run, defaults, forget: mac.forget)
        }
        for _ in 0..<50 { await Task.yield() }
        XCTAssertEqual(mac.heard, [], "the Remove waits for the declare's turn")
        mac.held?.resume()
        await retry.value
        try await remove.value
        XCTAssertEqual(mac.heard, ["declare \(run)", "forget \(run)"], "the forget comes after the declare it raced")
        XCTAssertNil(mac.declared)
        XCTAssertEqual(MacConnection.acknowledgedRuns(defaults), [:], "the declare's acknowledgement is cleared by the Remove")
        XCTAssertNil(MacConnection.macRun("dad", defaults), "nothing left recorded as the Mac's")
        XCTAssertEqual(MacConnection.pendingDeclares(defaults), [:])
        XCTAssertTrue(MacConnection.removedStoppedScans(defaults).contains(run))
    }

    /// Review of #819 (F2): a send's declare and its upload each take the project's turn. A Remove that asked during the
    /// declare goes between them, so nothing is uploaded or started; one that asked during the upload goes after it, and
    /// its forget takes off every frame that came. Either way the forget is the last thing the Mac hears.
    func testARemoveDuringASendStopsItAndIsTheLastThingTheMacHears() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "send-\(UUID().uuidString)"))
        let run = "3b072103-c190-41b9-8158-03177424d0c5"
        let mac = FakeMac()
        mac.holdDeclare = true
        let send = Task { @MainActor in
            try await MacConnection.declareThenUpload(project: "dad", run: run, defaults,
                declare: { try await MacConnection.declare(project: "dad", run: run, defaults, forget: mac.forget, declare: mac.declare(run)) },
                upload: { mac.heard.append("upload") })
        }
        while mac.held == nil { await Task.yield() }
        let remove = Task { @MainActor in try await MacConnection.removeStoppedScan(project: "dad", run: run, defaults, forget: mac.forget) }
        for _ in 0..<50 { await Task.yield() }
        mac.held?.resume()
        let sending = try await send.value
        try await remove.value
        XCTAssertFalse(sending)
        XCTAssertEqual(mac.heard, ["declare \(run)", "forget \(run)"], "no upload")
        XCTAssertThrowsError(try MacConnection.ensureStillSending("dad", run: run, defaults), "and no start")
        XCTAssertNil(mac.declared)
        XCTAssertNil(MacConnection.declaredRuns(defaults)["dad"])
        let again = try await MacConnection.declare(project: "dad", run: run, defaults, forget: mac.forget, declare: mac.declare(run))
        XCTAssertFalse(again, "a removed run is never named again")
        XCTAssertEqual(mac.heard.count, 2)

        // Removed during the upload: the forget waits for it, then takes it all off; the send never starts.
        let later = "eeeeeeee-0000-4000-8000-000000000005"
        mac.heard = []
        mac.held = nil
        let second = Task { @MainActor in
            try await MacConnection.declareThenUpload(project: "hook", run: later, defaults,
                declare: { try await MacConnection.declare(project: "hook", run: later, defaults, forget: mac.forget, declare: mac.declare(later)) },
                upload: { mac.heard.append("upload"); await withCheckedContinuation { mac.held = $0 } })
        }
        while mac.held == nil { await Task.yield() }
        let removeLater = Task { @MainActor in try await MacConnection.removeStoppedScan(project: "hook", run: later, defaults, forget: mac.forget) }
        for _ in 0..<50 { await Task.yield() }
        XCTAssertEqual(mac.heard, ["declare \(later)", "upload"], "the forget waits for the upload")
        mac.held?.resume()
        let uploaded = try await second.value
        XCTAssertTrue(uploaded)
        try await removeLater.value
        XCTAssertEqual(mac.heard, ["declare \(later)", "upload", "forget \(later)"])
        XCTAssertThrowsError(try MacConnection.ensureStillSending("hook", run: later, defaults), "removed before its start: never started")
    }

    /// Scans the build before this one (202611142311) declared recorded only `declaredRuns`, set once the Mac answered.
    /// After the update they are still the Mac's: Remove forgets them, and a newer run forgets them first.
    func testScansDeclaredByTheEarlierBuildAreStillForgotten() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "earlier-\(UUID().uuidString)"))
        let dad = "3b072103-c190-41b9-8158-03177424d0c5", newer = "eeeeeeee-0000-4000-8000-000000000005"
        var forgotten: [String] = []
        MacConnection.setDeclaredRun(project: "dad", run: dad, defaults)
        XCTAssertEqual(MacConnection.macRun("dad", defaults), dad)
        try await MacConnection.removeStoppedScan(project: "dad", run: dad, defaults, forget: { forgotten.append("\($0) \($1)") })
        XCTAssertEqual(forgotten, ["dad \(dad)"], "the Mac had it: told to forget")

        MacConnection.setDeclaredRun(project: "hook", run: dad, defaults)
        _ = try await MacConnection.declare(project: "hook", run: newer, defaults, forget: { forgotten.append("\($0) \($1)") }, declare: { _ in })
        XCTAssertEqual(forgotten, ["dad \(dad)", "hook \(dad)"], "a newer run forgets the earlier build's first")

        MacConnection.setDeclaredRun(project: "clip", run: dad, defaults)
        MacConnection.setPendingDeclare(project: "clip", run: dad, defaults)
        XCTAssertNil(MacConnection.macRun("clip", defaults), "still pending: the Mac may never have had it")
    }

    /// A newer run is never rebuilt with an older run's photos: runs name their photos alike (0001.heic…) and a send skips
    /// names the Mac already has, so a different run the Mac acknowledged is forgotten before the newer one is named.
    /// Defence only: the scan guard already refuses a new capture once the Mac has a project's photos.
    func testANewerRunIsDeclaredOnlyAfterTheMacForgetsTheOlderOne() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "redeclare-\(UUID().uuidString)"))
        let older = "3b072103-c190-41b9-8158-03177424d0c5", newer = "eeeeeeee-0000-4000-8000-000000000005"
        var calls: [String] = []
        let forget: (String, String) async throws -> Void = { calls.append("forget \($0) \($1)") }
        _ = try await MacConnection.declare(project: "dad", run: older, defaults, forget: forget, declare: { calls.append("declare \($0)") })
        _ = try await MacConnection.declare(project: "dad", run: older, defaults, forget: forget, declare: { calls.append("declare \($0)") })
        XCTAssertEqual(calls, ["declare dad", "declare dad"], "the same run again (a resumed send): its photos stay")
        calls = []
        _ = try await MacConnection.declare(project: "dad", run: newer, defaults, forget: forget, declare: { calls.append("declare \($0)") })
        XCTAssertEqual(calls, ["forget dad \(older)", "declare dad"])
        XCTAssertEqual(MacConnection.acknowledgedRuns(defaults), ["dad": newer])
        do {
            _ = try await MacConnection.declare(project: "dad", run: older, defaults, forget: { _, _ in throw CompanionError.unreachable },
                                                declare: { _ in XCTFail("never named over the newer run's photos") })
            XCTFail("the Mac didn't answer")
        } catch {}
        XCTAssertEqual(MacConnection.acknowledgedRuns(defaults), ["dad": newer], "unchanged until the Mac forgets it")
        // The Mac refuses the forget (another phone's scan is waiting there): nothing of the older run is left, so the
        // newer one is named.
        calls = []
        _ = try await MacConnection.declare(project: "dad", run: older, defaults, forget: { _, _ in
            throw CompanionError(code: "invalid-state", message: "A different scan is waiting for this project, so this one was left as it is.")
        }, declare: { calls.append("declare \($0)") })
        XCTAssertEqual(calls, ["declare dad"])
    }

    /// What the New sheet says under a stopped scan's question (#795): enough photos are simply sent; a few are sent
    /// with a warning beside Remove, never kept back.
    func testAStoppedScanSaysWhatItKeptAndWhetherThatIsEnough() {
        XCTAssertTrue(MacConnection.isEnough(stoppedPhotos: 68))
        XCTAssertFalse(MacConnection.isEnough(stoppedPhotos: 19))
        XCTAssertEqual(MacConnection.stoppedScanWords(photos: 68), "Stopped at 68 photos. Your Mac builds the model from them.")
        XCTAssertEqual(MacConnection.stoppedScanWords(photos: 20), "Stopped at 20 photos. Your Mac builds the model from them.")
        XCTAssertEqual(MacConnection.stoppedScanWords(photos: 19),
                       "Stopped at 19 photos, which may be too few. Remove it, or your Mac will try.")
        XCTAssertEqual(MacConnection.stoppedScanWords(photos: 12),
                       "Stopped at 12 photos, which may be too few. Remove it, or your Mac will try.")
        XCTAssertEqual(MacConnection.stoppedScanWords(photos: 1),
                       "Stopped at 1 photo, which may be too few. Remove it, or your Mac will try.")
    }
}

// MARK: A stop stranded by the build before #795 (#825)

extension AppTests {
    /// The phone's own send of a kept stopped scan, as `sendStoppedScan` makes it: the declare and upload in the project's
    /// turn (`declareThenUpload`), then the start only if the scan wasn't removed meanwhile.
    fileprivate func stoppedSend(_ mac: FakeMac, _ defaults: UserDefaults, refuseStart: String? = nil) -> (String, String) async throws -> Void {
        { project, run in
            let sending = try await MacConnection.declareThenUpload(project: project, run: run, defaults,
                declare: { try await MacConnection.declare(project: project, run: run, defaults, forget: mac.forget, declare: mac.declare(run)) },
                upload: { mac.heard.append("upload") })
            guard sending else { throw MacConnection.removedWhileSending }
            try MacConnection.ensureStillSending(project, run: run, defaults)
            if mac.away { throw CompanionError.unreachable }
            if let refuseStart { throw CompanionError(code: "invalid-state", message: refuseStart) }
            mac.heard.append("start")
        }
    }

    /// A project as the Mac lists it after a words-only pass that asked for photos: no model, its question open.
    fileprivate func askingForPhotos(_ id: String, state: Project.State = .needsCloseup) -> Project {
        var project = Project(id: id, createdAtMs: 1, updatedAtMs: 2, instructions: "A replica of this DAD desk thing", state: state)
        project.ask = Project.Ask(id: "5f868ee2-bd8c-49ff-97e4-8e3e7644a9cc", question: "The scan still hasn't arrived. Can you rescan it?",
                                  answers: ["camera", "photos", "best-guess", "text"], kind: "closeup")
        return project
    }

    /// David, Nov 15: "i sent it once why would i send it again?" His 68-photo DAD scan stopped on the phone; the build
    /// before #795 started its project from the words alone, and the project now asks for photos with no model. On the
    /// next contact the phone sends that scan by itself and the Mac starts from it, once: never again, whatever the Mac
    /// later says it holds.
    func testAStrandedStopIsSentOnceToTheProjectAskingForIt() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "stranded-\(UUID().uuidString)"))
        let dad = "b8158144-d1c2-41e7-a356-9948167964ea", run = "3b072103-c190-41b9-8158-03177424d0c5"
        let mac = FakeMac()
        let asking = askingForPhotos(dad)
        let kept: (String) -> MacConnection.KeptScan? = { $0 == dad ? .stopped(run: run, photos: 68) : nil }

        let due = MacConnection.strandedScans([asking], defaults, kept: kept, requested: { _ in false })
        XCTAssertEqual(due, [MacConnection.StrandedScan(project: dad, run: run, photos: 68, action: .send)])
        for scan in due { try await MacConnection.sendStranded(scan, defaults, send: stoppedSend(mac, defaults)) }
        XCTAssertEqual(mac.heard, ["declare \(run)", "upload", "start"], "declared, every photo, then the start")
        XCTAssertNil(MacConnection.recoveryRefusals(defaults)[dad])

        // The next contact, and every one after: nothing, even once the phone's record of the declare is gone.
        XCTAssertEqual(MacConnection.strandedScans([asking], defaults, kept: kept, requested: { _ in false }), [])
        MacConnection.setDeclaredRun(project: dad, run: nil, defaults)
        MacConnection.setAcknowledgedRun(project: dad, run: nil, defaults)
        XCTAssertEqual(MacConnection.strandedScans([asking], defaults, kept: kept, requested: { _ in false }), [], "sent once: never again")
        XCTAssertEqual(mac.heard.count, 3)
        XCTAssertEqual(MacConnection.recoveringWords(photos: 68), "Sending the 68 photos your stopped scan kept")
    }

    /// Lead, Nov 15 (regression watcher): a draft left with a stop from before the fix is never uploaded or started by
    /// itself, which would spend a tester's model budget with no tap. It is only declared, as Stop with 20 or more does
    /// now: the Mac knows a scan is coming and nothing starts from the words alone. Send and Remove stay the person's.
    func testAStrandedStopOnANewDraftIsOnlyDeclared() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "stranded-draft-\(UUID().uuidString)"))
        let draft = "aaaaaaaa-0000-4000-8000-0000000000aa", run = "eeeeeeee-0000-4000-8000-000000000005"
        let mac = FakeMac()
        let new = Project(id: draft, createdAtMs: 1, updatedAtMs: 2, instructions: "A hook", state: .new)
        let kept: (String) -> MacConnection.KeptScan? = { _ in .stopped(run: run, photos: 30) }

        let due = MacConnection.strandedScans([new], defaults, kept: kept, requested: { _ in false })
        XCTAssertEqual(due, [MacConnection.StrandedScan(project: draft, run: run, photos: 30, action: .declare)])
        for scan in due { MacConnection.declareStranded(scan, defaults) }
        XCTAssertEqual(MacConnection.pendingDeclares(defaults), [draft: run], "recorded at once, as a Stop with 20 or more is")
        await MacConnection.retryDeclares(defaults, kept: kept, declare: { project, run in
            try await MacConnection.declare(project: project, run: run, defaults, forget: mac.forget, declare: mac.declare(run)) })
        XCTAssertEqual(mac.heard, ["declare \(run)"], "declared at most: no upload, no start")
        XCTAssertEqual(MacConnection.strandedScans([new], defaults, kept: kept, requested: { _ in false }), [], "second contact: nothing new")

        // Its Remove still takes it off, and the Mac forgets it.
        try await MacConnection.removeStoppedScan(project: draft, run: run, defaults, forget: mac.forget)
        XCTAssertEqual(mac.heard, ["declare \(run)", "forget \(run)"])
        XCTAssertEqual(MacConnection.strandedScans([new], defaults, kept: kept, requested: { _ in false }), [])
    }

    /// A send cut short: the Mac didn't answer, so it is carried on at the next contact. One whose start went through with
    /// its reply lost finds the project moved on, and is closed without sending anything again.
    func testAStrandedSendCutShortCarriesOnOrClosesOnceItsProjectMovedOn() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "stranded-cut-\(UUID().uuidString)"))
        let dad = "b8158144-d1c2-41e7-a356-9948167964ea", run = "3b072103-c190-41b9-8158-03177424d0c5"
        let mac = FakeMac()
        let kept: (String) -> MacConnection.KeptScan? = { _ in .stopped(run: run, photos: 68) }
        let asking = askingForPhotos(dad)
        let due = MacConnection.strandedScans([asking], defaults, kept: kept, requested: { _ in false })
        mac.away = true
        do { try await MacConnection.sendStranded(due[0], defaults, send: stoppedSend(mac, defaults)); XCTFail("the Mac is away") } catch {}
        XCTAssertEqual(mac.heard, [], "nothing reached it")
        mac.away = false
        XCTAssertEqual(MacConnection.strandedScans([asking], defaults, kept: kept, requested: { _ in false }), due, "unfinished: carried on")
        do {
            try await MacConnection.sendStranded(due[0], defaults, send: { project, run in
                try await self.stoppedSend(mac, defaults)(project, run)
                throw CompanionError.unreachable   // the start's reply was lost
            })
            XCTFail("no reply")
        } catch {}
        XCTAssertEqual(mac.heard, ["declare \(run)", "upload", "start"])
        var working = asking
        working.state = .touchingUp
        XCTAssertEqual(MacConnection.strandedScans([working], defaults, kept: kept, requested: { _ in false }), [])
        XCTAssertEqual(MacConnection.strandedScans([asking], defaults, kept: kept, requested: { _ in false }), [], "closed: never again")
        XCTAssertEqual(mac.heard.count, 3)
    }

    /// Only a stop from before the fix (never declared, pending, acknowledged or removed), of 20 photos or more. Sent only
    /// to a project asking for photos with no model; with a model, another question, or any other state: nothing.
    func testOnlyAStrandedStopIsSentByItselfNeverAfterRemoveOrWithAModel() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "stranded-not-\(UUID().uuidString)"))
        let dad = "b8158144-d1c2-41e7-a356-9948167964ea", run = "3b072103-c190-41b9-8158-03177424d0c5"
        let mac = FakeMac()
        let kept: (String) -> MacConnection.KeptScan? = { _ in .stopped(run: run, photos: 68) }
        let none: (String) -> Bool = { _ in false }
        var modelled = askingForPhotos(dad)
        modelled.current = Project.Result(model: "current/model.stl", renders: [])
        XCTAssertEqual(MacConnection.strandedScans([modelled], defaults, kept: kept, requested: none), [], "asking, with a model")
        var file = askingForPhotos(dad)
        file.ask = Project.Ask(id: "5f868ee2-bd8c-49ff-97e4-8e3e7644a9cc", question: "Download the model and share it here.", answers: ["file"], kind: "file")
        XCTAssertEqual(MacConnection.strandedScans([file], defaults, kept: kept, requested: none), [], "asking for a file")
        var answered = askingForPhotos(dad)
        answered.ask?.status = "answered"
        XCTAssertEqual(MacConnection.strandedScans([answered], defaults, kept: kept, requested: none), [], "nothing open")
        for state: Project.State in [.ready, .touchingUp, .failed, .printing] {
            XCTAssertEqual(MacConnection.strandedScans([askingForPhotos(dad, state: state)], defaults, kept: kept, requested: none), [], state.rawValue)
        }
        let asking = askingForPhotos(dad)
        XCTAssertEqual(MacConnection.strandedScans([asking], defaults, kept: { _ in .stopped(run: run, photos: 19) }, requested: none), [],
                       "fewer than 20 wait for Send")
        XCTAssertEqual(MacConnection.strandedScans([asking], defaults, kept: { _ in .finished(run: run) }, requested: none), [],
                       "a finished scan goes with its own send")
        XCTAssertEqual(MacConnection.strandedScans([asking], defaults, kept: kept, requested: { _ in true }), [],
                       "Send was pressed: its own resume finishes it")
        MacConnection.setPendingDeclare(project: dad, run: run, defaults)
        XCTAssertEqual(MacConnection.strandedScans([asking], defaults, kept: kept, requested: none), [], "being declared: #795's path")
        MacConnection.setPendingDeclare(project: dad, run: nil, defaults)
        MacConnection.setDeclaredRun(project: dad, run: run, defaults)
        XCTAssertEqual(MacConnection.strandedScans([asking], defaults, kept: kept, requested: none), [], "declared after the fix")
        MacConnection.setDeclaredRun(project: dad, run: nil, defaults)
        MacConnection.setAcknowledgedRun(project: dad, run: run, defaults)
        XCTAssertEqual(MacConnection.strandedScans([asking], defaults, kept: kept, requested: none), [], "the Mac has it")
        MacConnection.setAcknowledgedRun(project: dad, run: nil, defaults)

        // Removed before the Mac answered: never sent, then or later.
        try await MacConnection.removeStoppedScan(project: dad, run: run, defaults, forget: mac.forget)
        XCTAssertEqual(MacConnection.strandedScans([asking], defaults, kept: kept, requested: none), [])
        // Removed while its send waits its turn: nothing is uploaded or started.
        let hook = "aaaaaaaa-0000-4000-8000-0000000000aa", later = "eeeeeeee-0000-4000-8000-000000000005"
        let hookKept: (String) -> MacConnection.KeptScan? = { _ in .stopped(run: later, photos: 30) }
        let due = MacConnection.strandedScans([askingForPhotos(hook)], defaults, kept: hookKept, requested: none)
        XCTAssertEqual(due.map(\.action), [.send])
        mac.holdDeclare = true
        let send = Task { @MainActor in try await MacConnection.sendStranded(due[0], defaults, send: self.stoppedSend(mac, defaults)) }
        while mac.held == nil { await Task.yield() }
        let remove = Task { @MainActor in try await MacConnection.removeStoppedScan(project: hook, run: later, defaults, forget: mac.forget) }
        for _ in 0..<50 { await Task.yield() }
        mac.held?.resume()
        do { try await send.value; XCTFail("removed") } catch let failure as CompanionError { XCTAssertEqual(failure.code, "scan-removed") }
        try await remove.value
        XCTAssertEqual(mac.heard, ["forget \(run)", "declare \(later)", "forget \(later)"], "no upload, no start")
        XCTAssertNil(MacConnection.recoveryRefusals(defaults)[hook], "a Remove is not the Mac's refusal")
        XCTAssertEqual(MacConnection.strandedScans([askingForPhotos(hook)], defaults, kept: hookKept, requested: none), [])
    }

    /// The Mac refuses (an older Mac that still won't take the scan): the scan stays on the phone, the project says why
    /// in the Mac's own words, and it isn't sent by itself again.
    func testAStrandedStopTheMacRefusesStaysAndSaysWhy() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "stranded-refused-\(UUID().uuidString)"))
        let dad = "b8158144-d1c2-41e7-a356-9948167964ea", run = "3b072103-c190-41b9-8158-03177424d0c5"
        let mac = FakeMac()
        let kept: (String) -> MacConnection.KeptScan? = { _ in .stopped(run: run, photos: 68) }
        let asking = askingForPhotos(dad)
        let due = MacConnection.strandedScans([asking], defaults, kept: kept, requested: { _ in false })
        let words = "The scan can only be added before the touch-up starts."
        do { try await MacConnection.sendStranded(due[0], defaults, send: stoppedSend(mac, defaults, refuseStart: words)); XCTFail("refused") }
        catch let failure as CompanionError { XCTAssertEqual(failure.message, words) }
        XCTAssertEqual(MacConnection.recoveryRefusals(defaults), [dad: words])
        XCTAssertFalse(MacConnection.isRemoved(dad, run, defaults), "the scan stays")
        XCTAssertEqual(MacConnection.strandedScans([asking], defaults, kept: kept, requested: { _ in false }), [], "not sent by itself again")
    }
}

/// A Mac as the phone's declares and forgets see it (review of #819): the run whose list it holds, what it heard, and
/// whether it answers. `dropReply`: a declare lands but its reply is lost, so the phone sees the Mac as unreachable.
@MainActor final class FakeMac {
    var declared: String?
    var heard: [String] = []
    var away = false, dropReply = false, holdDeclare = false
    var held: CheckedContinuation<Void, Never>?

    func declare(_ run: String) -> (String) async throws -> Void {
        { [self] _ in
            if holdDeclare { holdDeclare = false; await withCheckedContinuation { held = $0 } }
            if away { throw CompanionError.unreachable }
            declared = run
            heard.append("declare \(run)")
            if dropReply { throw CompanionError.unreachable }
        }
    }

    func forget(_ project: String, _ run: String) async throws {
        if away { throw CompanionError.unreachable }
        guard let declared else { heard.append("forget \(run)"); return }
        guard declared == run else {
            throw CompanionError(code: "invalid-state", message: "A different scan is waiting for this project, so this one was left as it is.")
        }
        self.declared = nil
        heard.append("forget \(run)")
    }
}
