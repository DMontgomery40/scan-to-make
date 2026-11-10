import XCTest
import CounterpartKit
import RealityKit

/// One companion's objects, as the control socket serves them.
private actor FakeObjects: ObjectsCompanion {
    var items: [[String: Any]] = []
    var listError: Error?
    var actionError: Error?
    private(set) var calls: [String] = []
    private(set) var correctionPhotoNames: [[String]?] = []
    private(set) var messageUploadFlags: [Bool] = []
    private var beforeDuplicateReply: (@Sendable () async -> Void)?
    func beforeDuplicateReturns(_ action: @escaping @Sendable () async -> Void) { beforeDuplicateReply = action }
    private var discoveryAvailable = false
    func enableDiscovery() { discoveryAvailable = true }
    private var listedPrinters: [PrinterDestination] = []
    func setPrinters(_ value: [PrinterDestination]) { listedPrinters = value }
    func printers() async throws -> PrinterCatalog {
        guard discoveryAvailable else { throw ControlClientError.unavailable }
        return .init(destinations: listedPrinters, defaultDestinationId: "current")
    }
    private var listedDevices: [ControlDevice] = []
    func setDevices(_ value: [ControlDevice]) { listedDevices = value }
    func devices() async throws -> [ControlDevice] {
        guard discoveryAvailable else { throw ControlClientError.unavailable }
        return listedDevices
    }

    private var controlWaiter: CheckedContinuation<Void, Never>?
    func control(_ id: String, _ action: PrintControl) async throws -> Project {
        calls.append("control-waiting")
        await withCheckedContinuation { controlWaiter = $0 }
        return try change(id, "control-finished", [:])
    }
    func finishControl() { controlWaiter?.resume(); controlWaiter = nil }
    private(set) var confirmationAnswer: PrintConfirmationAnswer?
    func set(_ items: [[String: Any]]) { self.items = items }
    private(set) var settingsPatches: [String: [String: JSONValue]] = [:]
    private var capabilities: ControlStatus.Capabilities?
    func setCapabilities(_ capabilities: ControlStatus.Capabilities) { self.capabilities = capabilities }
    private(set) var codeEngineCalls: [String] = []
    func codeEngine(_ action: CodeEngineStatus.Action) async throws -> CodeEngineStatus? {
        codeEngineCalls.append("cad." + action.rawValue)
        return action == .setup
            ? CodeEngineStatus(state: "setting-up", message: "Setting up… 0 s so far.", server: "bambu-printer-mcp", seconds: 0,
                               size: "Set Up downloads about 367 MB and uses about 1.6 GB on this computer.", canSetUp: false)
            : CodeEngineStatus(state: "not-set-up", message: "Not set up yet.", server: "bambu-printer-mcp",
                               size: "Set Up downloads about 367 MB and uses about 1.6 GB on this computer.", canSetUp: true)
    }
    func status() async throws -> ControlStatus {
        guard let capabilities else { throw ControlClientError.unavailable }
        return ControlStatus(companionVersion: "test", pairedDeviceCount: 1, capabilities: capabilities)
    }
    func objectsWithExtras() async throws -> (projects: [Project], extras: [String: PublishedExtras]) {
        let list = try await objects()
        var extras: [String: PublishedExtras] = [:]
        for item in items {
            if let id = item["id"] as? String, let data = try? JSONSerialization.data(withJSONObject: item),
               let found = try? JSONDecoder().decode(PublishedExtras.self, from: data), found != PublishedExtras() { extras[id] = found }
        }
        return (list, extras)
    }
    func setProjectSettings(_ id: String, _ patch: [String: JSONValue]) async throws -> Project {
        settingsPatches[id, default: [:]].merge(patch) { $1 }
        let item = items.first { $0["id"] as? String == id }
        var settings = item?["settings"] as? [String: Any] ?? ["status": "printed", "archived": false]
        var fields: [String: Any] = [:]
        if case .string(let title)? = patch["title"] { fields["title"] = title }
        if case .string(let status)? = patch["status"] {
            if status == "archived" { settings["archived"] = true } else { settings["status"] = status }
            if status == "works" { fields["state"] = "confirmed"; fields["status"] = ["phase": "confirmed", "text": "It works", "symbol": "checkmark.circle.fill", "tint": "green"] }
        }
        if case .bool(let archived)? = patch["archived"] { settings["archived"] = archived }
        for key in ["printDefaults", "designEngine", "notifications"] {
            if let value = patch[key] { settings[key] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value), options: .fragmentsAllowed) }
        }
        fields["settings"] = settings
        return try change(id, "settings", fields)
    }
    func duplicate(_ id: String) async throws -> Project {
        if let actionError { throw actionError }
        var copied = items.first { $0["id"] as? String == id }!
        copied["id"] = "copied"; copied["state"] = "ready"
        items.append(copied)
        calls.append("duplicate")
        await beforeDuplicateReply?()
        return try decode(copied)
    }
    func failList(with error: Error?) { listError = error }
    func failActions(with error: Error?) { actionError = error }

    private func decode(_ item: [String: Any]) throws -> Project {
        try JSONDecoder().decode(Project.self, from:JSONSerialization.data(withJSONObject:item))
    }
    private func change(_ id: String, _ call: String, _ fields: [String: Any]) throws -> Project {
        calls.append(call)
        if let actionError { throw actionError }
        guard let index = items.firstIndex(where: { $0["id"] as? String == id }) else { throw ControlRemoteError(code:"not-found", message:"gone") }
        items[index].merge(fields) { $1 }
        return try decode(items[index])
    }
    func objects() async throws -> [Project] {
        calls.append("list")
        if let listError { throw listError }
        return try items.map(decode)
    }
    func correct(_ id: String, note: String) async throws -> Project {
        correctionPhotoNames.append(nil)
        return try change(id, "correct:\(note)", ["state": "touching-up"])
    }
    func correct(_ id: String, note: String, photos: [String], photoNames: [String]) async throws -> Project {
        correctionPhotoNames.append(photoNames)
        return try change(id, "correct:\(note)", ["state": "touching-up"])
    }
    func addPhotoFile(_ id: String, path: String, forMessage: Bool) async throws -> String {
        messageUploadFlags.append(forMessage)
        // The initial worker fails while this queued upload is in flight; another message's photo also arrives.
        _ = try change(id, "upload", ["state": "failed", "current": NSNull(), "photos": ["other.jpg", "renamed-evidence.jpg"], "pendingPhotos": ["other.jpg", "renamed-evidence.jpg"]])
        return "renamed-evidence.jpg"
    }
    func answerCloseup(_ id: String, bestGuess: Bool) async throws -> Project { try change(id, "closeup:\(bestGuess)", ["state": "touching-up"]) }
    func print(_ id: String, checked: Bool) async throws -> Project { try change(id, "print:\(checked)", ["state": "printing"]) }
    func answerPrintConfirmation(_ id: String, confirmationId: String, answer: PrintConfirmationAnswer) async throws -> Project {
        confirmationAnswer = answer
        return try change(id, "confirmation:\(confirmationId):\(answer.action.rawValue)", ["printConfirmation":NSNull()])
    }
    func start(_ id: String) async throws -> Project { try change(id, "start", ["state": "touching-up"]) }
    /// As the companion does: the chosen plate is selected, and a send it couldn't confirm stays on its own plate.
    func selectPlate(_ id: String, fileIndex: Int, plateIndex: Int) async throws -> Project {
        guard let index = items.firstIndex(where: { $0["id"] as? String == id }) else { throw ControlRemoteError(code:"not-found", message:"gone") }
        let plates = (items[index]["plates"] as? [[String: Any]] ?? []).map { plate in
            plate.merging(["selected": plate["fileIndex"] as? Int == fileIndex && plate["plateIndex"] as? Int == plateIndex]) { $1 }
        }
        return try change(id, "plate:\(fileIndex):\(plateIndex)", ["plates": plates, "print": NSNull(), "failure": NSNull(), "state": "ready"])
    }
    func delete(_ id: String) async throws {
        calls.append("delete:\(id)")
        if let actionError { throw actionError }
        guard let index = items.firstIndex(where: { $0["id"] as? String == id }) else { throw ControlRemoteError(code:"not-found", message:"gone") }
        items.remove(at:index)
    }
}

private func item(_ id: String, _ state: String, _ fields: [String: Any] = [:]) -> [String: Any] {
    ["id": id, "createdAtMs": 1, "updatedAtMs": 1, "state": state, "photos": [], "passes": [], "directory": "/tmp/\(id)",
     "current": ["model": "current/model.stl", "renders": []]].merging(fields) { $1 }
}

private func project(_ item: [String: Any]) throws -> Project {
    try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: item))
}

@MainActor final class ObjectsModelTests: XCTestCase {
    func testPresenceRefreshIsNotMaskedByNewerCredentialTimestamp() async {
        let companion = FakeObjects()
        await companion.enableDiscovery()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func device(_ seen: Double) -> ControlDevice {
            ControlDevice(deviceId: "phone", deviceName: "Phone", pairedAt: 1,
                          lastRefreshedAt: now.timeIntervalSince1970 * 1000, expiresAt: 0,
                          lastSeenAt: seen)
        }
        await companion.setDevices([device((now.timeIntervalSince1970 - 900) * 1000)])
        var clock = now
        let model = ObjectsModel(companion: companion, now: { clock })
        await model.refresh()
        XCTAssertEqual(model.latestDevice?.connectedNow(at: now), false)
        await companion.setDevices([device((now.timeIntervalSince1970 - 1) * 1000)])
        clock = clock.addingTimeInterval(ObjectsModel.extrasDelay)
        await model.refresh()
        XCTAssertEqual(model.latestDevice?.connectedNow(at: now), true)
    }

    func testPrinterHistoryFollowsCompanionAliasesWithoutRewritingHistory() async throws {
        let companion = FakeObjects()
        await companion.enableDiscovery()
        let winner = try JSONDecoder().decode(PrinterDestination.self, from: Data(#"{"id":"winner","name":"Printer","backend":"test","aliases":["old-duplicate","other-mcp"]}"#.utf8))
        await companion.setPrinters([winner])
        await companion.set([
            item("same-backend", "printed", ["print": ["bundleId": "a", "destination": ["id": "old-duplicate", "name": "Old"]]]),
            item("switched-mcp", "printed", ["print": ["bundleId": "b", "destination": ["id": "other-mcp", "name": "Old"]]]),
            item("unrelated", "printed", ["printerDestinationId": "winner", "print": ["bundleId": "c", "destination": ["id": "elsewhere", "name": "Other"]]])
        ])
        var clock = Date()
        let model = ObjectsModel(companion: companion, now: { clock })
        await model.refresh()
        XCTAssertEqual(Set(model.projects(forPrinter: "winner").map(\.id)), ["same-backend", "switched-mcp"])
        XCTAssertEqual(model.objects.first { $0.id == "same-backend" }?.print?.destination?.id, "old-duplicate")
        await companion.setPrinters([.init(id: "new-winner", name: "Printer", backend: "test", aliases: ["old-duplicate", "other-mcp", "winner"])])
        clock = clock.addingTimeInterval(ObjectsModel.extrasDelay)
        await model.refresh()
        XCTAssertEqual(model.projects(forPrinter: "new-winner").count, 2)
        XCTAssertEqual(model.projects(forPrinter: "winner").count, 2)
        XCTAssertEqual(model.printerCatalog?.destination(for: "winner")?.id, "new-winner")
        XCTAssertTrue(model.projects(forPrinter: "unknown").isEmpty)
    }

    func testPrinterProjectsUseRecordedDestinationAndRefreshWhenItChanges() async {
        let companion = FakeObjects()
        await companion.set([
            item("printed-here", "printed", ["printerDestinationId": "other", "print": ["bundleId": "b", "destination": ["id": "here", "name": "Here"]]]),
            item("printed-elsewhere", "printed", ["printerDestinationId": "here", "print": ["bundleId": "c", "destination": ["id": "other", "name": "Other"]]]),
            item("never-printed", "ready", ["printerDestinationId": "here"])
        ])
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        XCTAssertEqual(model.projects(forPrinter: "here").map(\.id), ["printed-here"])
        XCTAssertEqual(model.projects(forPrinter: "other").map(\.id), ["printed-elsewhere"])
        XCTAssertTrue(model.projects(forPrinter: "removed").isEmpty)
        await companion.set([])
        await model.refresh()
        XCTAssertTrue(model.projects(forPrinter: "here").isEmpty)
    }

    /// David, Nov 6, on his six-plate rig: "i can't select which plate to print in the app i can see them but i can't click
    /// on them". Plate 1's start couldn't be confirmed (`print.uncertain`), which disabled every plate on the Mac. Every
    /// plate stays choosable with projects present, and only the plate that may have started asks for the printer check.
    func testEveryPlateStaysChoosableAfterAnUnconfirmedStartWithProjectsPresent() async throws {
        let companion = FakeObjects()
        // The shared fixture the companion's own tests check: David's rig after plate 1's start timed out.
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("packages/contracts/fixtures/six-plate-unconfirmed.json"))) as? [String: Any])
        let unconfirmed = try XCTUnwrap(fixture["unconfirmed"] as? [String: Any])
        let id = try XCTUnwrap(unconfirmed["id"] as? String)
        let names = try XCTUnwrap(unconfirmed["plates"] as? [[String: Any]]).compactMap { $0["name"] as? String }
        XCTAssertEqual(names.count, 6)
        await companion.set([item("caliper", "ready"), unconfirmed.merging(["directory": "/tmp/rig"]) { $1 }])
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        var rig = try XCTUnwrap(model.objects.first { $0.id == id })
        XCTAssertTrue(rig.canSelectPlate, "the plates stay buttons you can press")
        XCTAssertTrue(rig.printNeedsCheck)
        for (i, name) in names.enumerated().reversed() {
            let plate = try XCTUnwrap(rig.plates?[i])
            let chose = await model.selectPlate(id, plate: plate)
            XCTAssertTrue(chose)
            rig = try XCTUnwrap(model.objects.first { $0.id == id })
            XCTAssertEqual(rig.selectedPlate?.name, name)
            XCTAssertTrue(rig.canSelectPlate)
            XCTAssertEqual(rig.printNeedsCheck, i == 0, "only Screws, which may have started, asks for the check")
        }
        let calls = await companion.calls
        XCTAssertEqual(calls.filter { $0.hasPrefix("plate:") }, ["plate:0:5", "plate:0:4", "plate:0:3", "plate:0:2", "plate:0:1", "plate:0:0"])
    }

    /// Add printer…'s Slicer section stays reachable with projects present: the chosen MCP's own slicer choice and
    /// paths (mcp-3d-printer-server 1.2.50's `counterpart_setup_fields`), and only a changed slicer is sent (Codex review on #346).
    /// Settings → AI → Design engine (PRD §8.9, §6.1): the code design engine's row reads the companion and Set Up asks
    /// it to set the engine up, with projects present.
    func testTheDesignEngineRowReadsTheCodeEngineAndSetsItUpWithProjectsPresent() async throws {
        let companion = FakeObjects()
        await companion.set([item("caliper", "ready"), item("holder", "ready")])
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        XCTAssertFalse(model.objects.isEmpty, "projects are present")
        let row = try await model.codeEngine(.status)
        XCTAssertEqual(row?.state, "not-set-up")
        XCTAssertEqual(row?.message, "Not set up yet.")
        XCTAssertEqual(row?.canSetUp, true, "Set Up is offered")
        XCTAssertEqual(row?.size, "Set Up downloads about 367 MB and uses about 1.6 GB on this computer.", "what Set Up takes, before it runs")
        let setUp = try await model.codeEngine(.setup)
        XCTAssertEqual(setUp?.isWorking, true)
        XCTAssertEqual(setUp?.canSetUp, false, "no second Set Up while it runs")
        let calls = await companion.codeEngineCalls
        XCTAssertEqual(calls, ["cad.status", "cad.setup"])
        // The row is on screen: the AI tab's settings render the code engine's section through this model (review F4).
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("App/SettingsViews.swift"), encoding: .utf8)
        XCTAssertTrue(source.contains(#"Tab("AI", systemImage:"sparkles", value:.ai) { AISettings(model:cleanup, objects:objects) }"#), "the AI tab shows AISettings with the projects model")
        let ai = try XCTUnwrap(source.range(of: "struct AISettings: View {"), "AISettings exists")
        let body = source[ai.upperBound...]
        let end = body.range(of: "\n}\n")?.lowerBound ?? body.endIndex
        XCTAssertTrue(body[..<end].contains("CodeEngineSettingsSection { [objects] action in try await objects.codeEngine(action) }"),
                      "AISettings renders the code design engine's section, wired to ObjectsModel")
    }

    func testAddPrinterSlicerControlsComeFromTheChosenMCPWithProjectsPresent() async throws {
        let companion = FakeObjects()
        await companion.set([item("caliper", "ready")])
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        XCTAssertFalse(model.objects.isEmpty, "projects are present")
        let options = try JSONDecoder().decode(PrinterSetupOptions.self, from: Data("""
        {"types":[],"models":{},"slicer":{"mcp-3d-printer-server":{"type":"prusaslicer","path":"/opt/nowhere/bambu-studio","found":false,"fields":[
          {"name":"slicer","env":"SLICER_TYPE","label":"Slicer","required":false,"choices":[{"value":"prusaslicer","label":"PrusaSlicer"},{"value":"orcaslicer","label":"OrcaSlicer"},{"value":"bambustudio","label":"Bambu Studio"}]},
          {"name":"slicer-path","env":"SLICER_PATH","label":"PrusaSlicer app","input":"path","required":true,"hint":"PrusaSlicer isn't at /opt/nowhere/bambu-studio. Install it, or choose where it is."}]}}}
        """.utf8))
        var form = PrinterForm()
        form.backend = "mcp-3d-printer-server"
        let controls = try XCTUnwrap(SlicerControls(options: options, backend: form.backend))
        XCTAssertEqual(controls.choice?.choices?.map(\.value), ["prusaslicer", "orcaslicer", "bambustudio"])
        XCTAssertEqual(controls.path?.env, "SLICER_PATH")
        XCTAssertNil(controls.profiles, "no profiles folder unless the MCP asks for one")
        XCTAssertEqual(controls.selected(in: form), "prusaslicer", "the MCP's own slicer shows as chosen")
        controls.choose("orcaslicer", in: &form)
        XCTAssertEqual(form.slicer, "orcaslicer", "another slicer is sent with its app")
        controls.choose("prusaslicer", in: &form)
        XCTAssertNil(form.slicer, "the MCP's own slicer sends nothing")
        XCTAssertNil(SlicerControls(options: options, backend: "bambu-printer-mcp"), "an MCP that declares no slicer settings shows none")
        XCTAssertNil(SlicerControls(options: nil, backend: "mcp-3d-printer-server"))
    }

    /// Add printer…'s "Approve in OctoPrint" stays reachable with projects present: the button is the chosen MCP's own
    /// (`obtain` on OctoPrint's key, mcp-3d-printer-server 1.2.53's `counterpart_setup_fields`), and none elsewhere.
    func testAddPrinterApprovalButtonComesFromTheChosenMCPWithProjectsPresent() async throws {
        let companion = FakeObjects()
        await companion.set([item("caliper", "ready")])
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        XCTAssertFalse(model.objects.isEmpty, "projects are present")
        let options = try JSONDecoder().decode(PrinterSetupOptions.self, from: Data("""
        {"types":[
          {"printerType":"bambu","label":"Bambu Lab","backends":["bambu-printer-mcp"],"serial":true,"secret":{"label":"Access code","required":true}},
          {"printerType":"octoprint","label":"OctoPrint","backends":["mcp-3d-printer-server"],"serial":false,
           "secret":{"label":"API key","hint":"Approve this app in OctoPrint, or copy a key from OctoPrint: Settings → Application Keys","required":true,
             "obtain":{"label":"Approve in OctoPrint","hint":"OctoPrint asks you to allow this app in its web page","backends":["mcp-3d-printer-server"]}}}],
         "models":{}}
        """.utf8))
        var form = PrinterForm()
        form.backend = "mcp-3d-printer-server"; form.printerType = "octoprint"; form.host = "octopi.local"
        let control = try XCTUnwrap(ObtainControl(options: options, form: form))
        XCTAssertEqual(control.label, "Approve in OctoPrint")
        XCTAssertEqual(control.hint, "OctoPrint asks you to allow this app in its web page")
        var bambu = PrinterForm()
        bambu.host = "192.168.1.40"
        XCTAssertNil(ObtainControl(options: options, form: bambu), "a field the MCP doesn't fetch shows no button")
        XCTAssertNil(ObtainControl(options: options, form: PrinterForm(folder: "/Users/someone/mcp-3D-printer-server")), "a found folder has its own .env")
        XCTAssertEqual(ControlClient.timeout(for: "printers.obtain"), 70)
    }

    /// Add printer…'s address offers a web address only where the MCP's own host field takes one (mcp-3d-printer-server
    /// 1.2.55's `input: "url"` on OctoPrint), with projects present.
    func testAddPrinterAddressOffersAWebAddressOnlyWhereTheMCPTakesOneWithProjectsPresent() async throws {
        let companion = FakeObjects()
        await companion.set([item("caliper", "ready")])
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        XCTAssertFalse(model.objects.isEmpty, "projects are present")
        let options = try JSONDecoder().decode(PrinterSetupOptions.self, from: Data("""
        {"types":[
          {"printerType":"octoprint","label":"OctoPrint","backends":["mcp-3d-printer-server"],"serial":false,
           "address":{"hint":"OctoPrint's address (octopi.local or an IP address), or its full URL for HTTPS or a sub-path","url":true}},
          {"printerType":"klipper","label":"Klipper (Moonraker)","backends":["mcp-3d-printer-server"],"serial":false,"address":{"hint":"The printer's IP address or host name"}}],
         "models":{}}
        """.utf8))
        let octoprint = AddressField(options: options, printerType: "octoprint")
        XCTAssertTrue(octoprint.prompt.contains("https://"))
        XCTAssertEqual(octoprint.hint?.contains("sub-path"), true)
        let klipper = AddressField(options: options, printerType: "klipper")
        XCTAssertFalse(klipper.prompt.contains("https://"))
        XCTAssertEqual(klipper.hint, "The printer's IP address or host name")
        XCTAssertFalse(AddressField(options: nil, printerType: "octoprint").prompt.contains("https://"))
        var form = PrinterForm()
        form.backend = "mcp-3d-printer-server"; form.printerType = "octoprint"; form.host = " https://pi.example.com/octoprint "
        XCTAssertEqual(form.json, .object(["backend": .string("mcp-3d-printer-server"), "printerType": .string("octoprint"), "host": .string("https://pi.example.com/octoprint")]),
                       "sent as typed; the companion checks it against the MCP's field")
    }

    func testDiscoveryDoesNotClaimEmptyPhonesOrPrintersBeforeSuccessfulReads() async {
        let failed = ObjectsModel(companion: FakeObjects())
        XCTAssertEqual(failed.missingPhoneText, "Checking connected phones…")
        XCTAssertEqual(failed.missingPrinterText, "Reading your printer settings…")
        await failed.refresh()
        XCTAssertEqual(failed.missingPhoneText, "Couldn't read connected phones.")
        XCTAssertEqual(failed.missingPrinterText, "Couldn't read your printer settings.")
        let companion = FakeObjects()
        await companion.enableDiscovery()
        let empty = ObjectsModel(companion: companion)
        await empty.refresh()
        XCTAssertEqual(empty.missingPhoneText, "No phone connected yet")
        XCTAssertEqual(empty.missingPrinterText, "No printer found in your printer MCP’s settings.")
    }

    func testDuplicateReplyDoesNotInsertASecondIdentityAfterBackgroundRefresh() async throws {
        let companion = FakeObjects()
        await companion.set([item("source", "ready")])
        await companion.setCapabilities(.init(projectPreferences: true))
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        await companion.beforeDuplicateReturns { _ = await model.refresh() }
        try await model.duplicate("source")
        let ids = model.objects.map(\.id)
        guard Set(ids).count == ids.count else { return XCTFail("Duplicate reply inserted an already observed project twice") }
        XCTAssertEqual(ids.filter { $0 == "copied" }.count, 1)
        XCTAssertEqual(model.selection, "copied")
        await model.refresh() // building the next identity dictionary must remain safe
        XCTAssertEqual(model.objects.count, 2)
    }

    func testQueuedPhotoKeepsItsIntentAndExactReceiptWhenInitialPassFailsDuringUpload() async throws {
        let companion = FakeObjects()
        await companion.set([item("queued", "touching-up", ["current": NSNull(), "pendingPhotos": ["other.jpg"]])])
        let model = ObjectsModel(companion: companion, defaults: UserDefaults(suiteName: UUID().uuidString)!)
        await model.refresh()
        let accepted = await model.requestChanges("queued", note: "Widen this", photos: [URL(fileURLWithPath: "/tmp/evidence.jpg")])
        XCTAssertTrue(accepted)
        let flags = await companion.messageUploadFlags
        XCTAssertEqual(flags, [true])
        await model.refresh()
        XCTAssertEqual(model.objects.first?.state, .failed)
        XCTAssertEqual(model.corrections.messages["queued"]?.first?.photos, ["renamed-evidence.jpg"], "never claim unrelated pending photos")
        XCTAssertEqual(model.corrections.pending("queued"), "Widen this", "a failed initial pass cannot consume the queued correction")
    }

    func testSavedPreferencesAndDuplicateUpdateTheOpenProjectWithoutStartingAPass() async throws {
        let companion = FakeObjects()
        await companion.set([item("source", "ready")])
        await companion.setCapabilities(.init(projectPreferences: true))
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        try await model.savePreferences("source", patch: ["printDefaults": .object(["copies": .number(1), "quality": .string("fine")]), "notifications": .string("problems")])
        XCTAssertEqual(model.selected?.settings?.printDefaults?.copies, 1)
        XCTAssertEqual(model.selected?.settings?.notifications, "problems")
        try await model.duplicate("source")
        XCTAssertEqual(model.selection, "copied")
        XCTAssertEqual(model.objects.count, 2)
        XCTAssertEqual(model.selected?.settings?.printDefaults?.quality, "fine")
        XCTAssertEqual(model.selected?.state, .ready)
        let calls = await companion.calls
        XCTAssertFalse(calls.contains(where: { $0.hasPrefix("correct:") || $0 == "start" }))
        await companion.failActions(with: ControlRemoteError(code: "unavailable", message: "Couldn't copy the model."))
        do { try await model.duplicate("source"); XCTFail("The failure must reach the sheet") } catch {}
        XCTAssertEqual(model.objects.count, 2)
        XCTAssertEqual(model.selection, "copied")
    }

    func testChangesWrittenDuringAPassAreSavedAndSentOnceWhenItEnds() async throws {
        let defaults = UserDefaults(suiteName: "counterpart-queue-\(UUID().uuidString)")!
        let companion = FakeObjects()
        await companion.set([item("queued", "touching-up")])
        let model = ObjectsModel(companion: companion, defaults: defaults)
        await model.refresh()
        let accepted = await model.requestChanges("queued", note: "Widen the flange")
        XCTAssertTrue(accepted)
        XCTAssertEqual(model.corrections.pending("queued"), "Widen the flange")
        let before = await companion.calls
        XCTAssertFalse(before.contains("correct:Widen the flange"))
        XCTAssertEqual(CorrectionQueue(saved: defaults.dictionary(forKey: "CounterpartQueuedNotes")).pending("queued"), "Widen the flange")
        await companion.set([item("queued", "ready")])
        await model.refresh()
        for _ in 0..<100 where model.corrections.pending("queued") != nil { await Task.yield() }
        XCTAssertNil(model.corrections.pending("queued"))
        XCTAssertEqual(model.objects.first?.state, .touchingUp)
        let after = await companion.calls
        XCTAssertEqual(after.filter { $0 == "correct:Widen the flange" }.count, 1)
    }

    func testRetryOfASavedMessageDoesNotSelectLaterUploadedPhotos() async throws {
        let suite = "counterpart-saved-retry-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let companion = FakeObjects()
        let held = item("saved", "ready", [
            "photos": ["a.jpg", "b.jpg"], "pendingPhotos": ["b.jpg"],
            "pendingFollowup": "DONE", "pendingMessageId": "message-a",
            "messages": [["id": "message-a", "text": "DONE", "atMs": 1, "photos": ["a.jpg"]]]
        ])
        await companion.set([held])
        await companion.setCapabilities(.init(messagePhotos: true))
        let model = ObjectsModel(companion: companion, defaults: defaults)
        await model.refresh()
        let retried = await model.perform(.correct, on: "saved", note: " DONE ")
        XCTAssertTrue(retried)
        let retryRequests = await companion.correctionPhotoNames
        XCTAssertEqual(retryRequests.count, 1)
        XCTAssertNil(retryRequests[0], "Omit photoNames so the companion retains A's own evidence instead of claiming pending B")
        // A genuinely new message still explicitly claims the pending photo.
        await companion.set([held])
        await model.refresh()
        let changed = await model.perform(.correct, on: "saved", note: "Use the new photo for this change")
        XCTAssertTrue(changed)
        let allRequests = await companion.correctionPhotoNames
        XCTAssertEqual(allRequests.last!, ["b.jpg"])
    }

    func testRenameUsesItsOwnCapabilityAndKeepsTheRequest() async {
        let companion = FakeObjects()
        await companion.set([item("rename", "ready", ["instructions": "A mount for the pole"])])
        await companion.setCapabilities(.init(projectSettings: true, projectRename: true))
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        let renamed = await model.rename("rename", title: "Studio mic mount")
        XCTAssertTrue(renamed)
        XCTAssertEqual(model.objects.first?.title, "Studio mic mount")
        XCTAssertEqual(model.objects.first?.instructions, "A mount for the pole")
        XCTAssertEqual(model.objects.first?.state, .ready)
        let older = ObjectsModel(companion: companion)
        let refused = await older.rename("rename", title: "Should wait for capability")
        XCTAssertFalse(refused)
    }

    func testResumeConfirmationCanBeAnsweredWhileControlWaits() async {
        let companion = FakeObjects()
        let question: [String: Any] = ["id":"q1", "message":"Resume this job?", "expiresAtMs":Date().timeIntervalSince1970 * 1000 + 60_000,
            "supported":true, "fields":[["name":"confirmed", "title":"Confirm", "required":true]]]
        await companion.set([item("a", "printing", ["printConfirmation":question])])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        let control = Task { await model.control("a", .resume) }
        for _ in 0..<100 {
            if await companion.calls.contains("control-waiting") { break }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTAssertTrue(model.working.contains("a"))
        let accepted = await model.answerPrintConfirmation("a", confirmationId:"q1", answer:.init(action:.accept, content:["confirmed":.bool(true)]))
        XCTAssertTrue(accepted, "the confirmation must not deadlock behind the control awaiting it")
        XCTAssertTrue(model.working.contains("a"), "answering must not release the original control's busy state")
        await companion.finishControl()
        let resumed = await control.value
        XCTAssertTrue(resumed)
        XCTAssertFalse(model.working.contains("a"))
    }

    func testConfirmationRejectsStaleAndIncompleteAnswers() async {
        let companion = FakeObjects()
        var question: [String: Any] = ["id":"q1", "message":"Check the actual printer.", "expiresAtMs":Date().timeIntervalSince1970 * 1000 + 60_000,
            "supported":true, "fields":[["name":"spool_loaded", "title":"The spool is loaded", "required":true]]]
        await companion.set([item("a", "printing", ["printConfirmation":question])])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        let incomplete = await model.answerPrintConfirmation("a", confirmationId:"q1", answer:.init(action:.accept))
        XCTAssertFalse(incomplete)
        question["id"] = "q2"
        await companion.set([item("a", "printing", ["printConfirmation":question])])
        await model.refresh()
        let stale = await model.answerPrintConfirmation("a", confirmationId:"q1", answer:.init(action:.accept, content:["spool_loaded":.bool(true)]))
        XCTAssertFalse(stale)
        let before = await companion.calls
        XCTAssertFalse(before.contains { $0.hasPrefix("confirmation:") })
        let accepted = await model.answerPrintConfirmation("a", confirmationId:"q2", answer:.init(action:.accept, content:["spool_loaded":.bool(true)]))
        XCTAssertTrue(accepted)
        let calls = await companion.calls
        XCTAssertEqual(calls.last, "confirmation:q2:accept")
        let answer = await companion.confirmationAnswer
        XCTAssertEqual(answer?.content, ["spool_loaded":.bool(true)])
        XCTAssertNil(model.selected?.printConfirmation)
    }

    func testATypedAnswerGoesThroughTheSharedChecks() async {
        let companion = FakeObjects()
        let question: [String: Any] = ["id":"q1", "message":"Set the bed temperature.", "expiresAtMs":Date().timeIntervalSince1970 * 1000 + 60_000,
                                       "supported":true, "fields":[["name":"temp", "title":"Bed temperature", "type":"integer", "minimum":40, "maximum":110, "required":true]]]
        await companion.set([item("a", "printing", ["printConfirmation":question])])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        let outOfRange = await model.answerPrintConfirmation("a", confirmationId:"q1", answer:.init(action:.accept, content:["temp":.number(120)]))
        XCTAssertFalse(outOfRange)
        let accepted = await model.answerPrintConfirmation("a", confirmationId:"q1", answer:.init(action:.accept, content:["temp":.number(60)]))
        XCTAssertTrue(accepted)
        let answer = await companion.confirmationAnswer
        XCTAssertEqual(answer?.content, ["temp":.number(60)])
    }

    func testUnsupportedAndExpiredConfirmationCanBeCanceledButNotAccepted() async {
        let companion = FakeObjects()
        await companion.set([item("a", "printing", ["printConfirmation":["id":"q", "message":"Unknown form", "expiresAtMs":1, "supported":false, "fields":[]]])])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        let accepted = await model.answerPrintConfirmation("a", confirmationId:"q", answer:.init(action:.accept, content:[:]))
        XCTAssertFalse(accepted)
        let canceled = await model.answerPrintConfirmation("a", confirmationId:"q", answer:.init(action:.cancel))
        XCTAssertTrue(canceled)
        let calls = await companion.calls
        XCTAssertEqual(calls.last, "confirmation:q:cancel")
    }

    func testReadsQuicklyOnlyWhileSomethingIsBusy() async {
        let companion = FakeObjects()
        await companion.set([item("a", "ready"), item("b", "printed")])
        let model = ObjectsModel(companion:companion)
        let idle = await model.refresh()
        XCTAssertEqual(idle, ObjectsModel.idleDelay)
        XCTAssertEqual(model.availability, .ready)
        XCTAssertEqual(model.selection, "a", "the newest object is shown first")
        await companion.set([item("c", "touching-up"), item("a", "ready")])
        let busy = await model.refresh()
        XCTAssertEqual(busy, 3)
        XCTAssertEqual(model.selection, "a", "a new object doesn't take over the page")
    }

    func testObjectsNotSetUpReadsAsOneStateNotAnError() async {
        let companion = FakeObjects()
        await companion.failList(with:ControlRemoteError(code:"unavailable", message:"The requested capability is unavailable"))
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        XCTAssertEqual(model.availability, .notSetUp)
        // A companion from before objects refuses the method itself; it answered, so it is running.
        await companion.failList(with:ControlRemoteError(code:"invalid-request", message:"Invalid local control request"))
        for _ in 0..<3 { await model.refresh() }
        XCTAssertEqual(model.availability, .notSetUp)
    }

    func testAMissingCompanionIsReportedOnlyAfterAFewTries() async {
        let companion = FakeObjects()
        await companion.set([item("a", "ready")])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        await companion.failList(with:ControlClientError.unavailable)
        await model.refresh(); await model.refresh()
        XCTAssertEqual(model.availability, .ready, "a restart shouldn't flash an error")
        XCTAssertEqual(model.objects.count, 1)
        await model.refresh()
        XCTAssertEqual(model.availability, .notRunning)
    }

    func testAnUncertainPrintIsSentWithCheckedAndTheResultShowsAtOnce() async {
        let companion = FakeObjects()
        await companion.set([item("a", "failed", ["print": ["bundleId": "b", "uncertain": true]])])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        XCTAssertEqual(model.selected?.words.actions.first, .printChecked)
        let sent = await model.perform(.printChecked, on:"a")
        XCTAssertTrue(sent)
        XCTAssertEqual(model.selected?.state, .printing)
        XCTAssertTrue(model.working.isEmpty)
        let calls = await companion.calls
        XCTAssertEqual(calls.last, "print:true")
    }

    func testCorrectionsAreTrimmedAndRefusalsSayOneSentence() async {
        let companion = FakeObjects()
        await companion.set([item("a", "ready")])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        await model.perform(.correct, on:"a", note:"  the clip is missing \n")
        let calls = await companion.calls
        XCTAssertEqual(calls.last, "correct:the clip is missing")
        await companion.failActions(with:ControlRemoteError(code:"conflict", message:"The requested operation conflicts with current state"))
        let refused = await model.perform(.print, on:"a")
        XCTAssertFalse(refused)
        XCTAssertEqual(model.problem, .init(id:"a", text:"That can't be done right now."), "an older Mac's generic refusal")
        await companion.failActions(with:ControlRemoteError(code:"conflict", message:"There is no model to print yet."))
        _ = await model.perform(.print, on:"a")
        XCTAssertEqual(model.problem, .init(id:"a", text:"There is no model to print yet."), "the Mac's own plain sentence")
        let after = await companion.calls
        XCTAssertEqual(after.last, "list", "a refusal reads the object again to show where it is now")
    }

    func testLimitStopsKeepTheirWordsAndRetryWithProjectsPresent() async throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appendingPathComponent("packages/CounterpartKit/Tests/CounterpartKitTests/Fixtures/capped-projects.json"))
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        let companion = FakeObjects()
        for row in rows where (row["name"] as? String)?.hasPrefix("limit-") == true {
            let stopped = try XCTUnwrap(row["expected"] as? [String: Any])
            await companion.set([item("other", "ready"), stopped])
            let model = ObjectsModel(companion: companion)
            await model.refresh()
            let project = try XCTUnwrap(model.objects.first { $0.id == (stopped["id"] as? String) })
            XCTAssertEqual(ProjectWords(project).status, project.failure)
            XCTAssertTrue(ProjectWords(project).actions.contains(.retry))
            let retried = await model.perform(.retry, on: project.id)
            XCTAssertTrue(retried)
            let calls = await companion.calls
            XCTAssertEqual(calls.last, "start")
        }
    }

    func testAFailedTouchUpStartsAgain() async {
        let companion = FakeObjects()
        await companion.set([item("b", "failed", ["failure": "Blender is not open on your Mac.", "current": NSNull()])])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        let started = await model.perform(.retry, on:"b")
        XCTAssertTrue(started)
        let calls = await companion.calls
        XCTAssertEqual(calls.last, "start")
    }

    func testPollingFollowsTheWindow() async {
        let model = ObjectsModel(companion:FakeObjects())
        model.setVisible(true)
        XCTAssertTrue(model.isPolling)
        model.setVisible(false)
        XCTAssertFalse(model.isPolling)
        model.wake()
        XCTAssertFalse(model.isPolling, "focusing a closed window doesn't start reading")
    }

    func testAnASCIIOrBinarySTLStandsUprightInMetres() throws {
        // A 100 mm box, Z-up in millimetres as slicers write it.
        let s: Float = 50, v: [SIMD3<Float>] = [[-s,-s,-s],[s,-s,-s],[s,s,-s],[-s,s,-s],[-s,-s,s],[s,-s,s],[s,s,s],[-s,s,s]]
        let faces = [(0,2,1),(0,3,2),(4,5,6),(4,6,7),(0,1,5),(0,5,4),(2,3,7),(2,7,6),(1,2,6),(1,6,5),(0,4,7),(0,7,3)]
        var ascii = "solid cube\n"
        for (a, b, c) in faces {
            ascii += "facet normal 0 0 0\nouter loop\n"
            for i in [a, b, c] { ascii += "vertex \(v[i].x) \(v[i].y) \(v[i].z + 50)\n" }
            ascii += "endloop\nendfacet\n"
        }
        let fromText = try XCTUnwrap(ModelMesh.stl(Data((ascii + "endsolid cube\n").utf8)))
        XCTAssertEqual(fromText.triangleCount, 12)
        XCTAssertEqual(fromText.bounds.min.y, 0, accuracy: 1e-6, "Z-up 0…100 mm becomes Y-up 0…0.1 m")
        XCTAssertEqual(fromText.bounds.max.y, 0.1, accuracy: 1e-6)
        var binary = Data(count: 80)
        binary.append(contentsOf: withUnsafeBytes(of: UInt32(faces.count).littleEndian, Array.init))
        for (a, b, c) in faces {
            let values: [Float] = [0, 0, 0] + [v[a], v[b], v[c]].flatMap { [$0.x, $0.y, $0.z + 50] }
            for value in values {
                binary.append(contentsOf: withUnsafeBytes(of: value.bitPattern.littleEndian, Array.init))
            }
            binary.append(contentsOf: [0, 0])
        }
        let fromBinary = try XCTUnwrap(ModelMesh.stl(binary))
        XCTAssertEqual(fromBinary.positions, fromText.positions, "both encodings read the same triangles")
        XCTAssertNil(ModelMesh.stl(Data("not a model".utf8)))
        XCTAssertNil(ModelMesh.stl(binary.dropLast(10)), "a truncated binary file is refused, not half drawn")
    }

    func testNativePreviewKeepsEveryVertexNormalAndRenderedPixel() async throws {
        // A non-coplanar corner makes incorrect strides, normals or index winding visible.
        let positions: [SIMD3<Float>] = [[0,0,0],[0.1,0,0],[0,0.1,0], [0,0,0],[0,0.1,0],[0,0,0.1]]
        let normals: [SIMD3<Float>] = [[0,0,1],[0,0,1],[0,0,1], [1,0,0],[1,0,0],[1,0,0]]
        let mesh = ModelMesh(positions: positions, normals: normals)
        let loaded = await mesh.resource()
        let resource = try XCTUnwrap(loaded)
        let buffers = try XCTUnwrap(resource.lowLevelMesh)
        buffers.withUnsafeBytes(bufferIndex: 0) { bytes in
            let values = bytes.bindMemory(to: Float.self)
            for i in positions.indices {
                XCTAssertEqual(Array(values[(i * 6)..<(i * 6 + 6)]), [positions[i].x, positions[i].y, positions[i].z, normals[i].x, normals[i].y, normals[i].z])
            }
        }
        buffers.withUnsafeIndices { bytes in
            XCTAssertEqual(Array(bytes.bindMemory(to: UInt32.self).prefix(positions.count)), Array(0..<UInt32(positions.count)))
        }
        var descriptor = MeshDescriptor()
        descriptor.positions = MeshBuffers.Positions(positions)
        descriptor.normals = MeshBuffers.Normals(normals)
        descriptor.primitives = .triangles(Array(0..<UInt32(positions.count)))
        let previous = try await MeshResource(from: [descriptor])
        var material = PhysicallyBasedMaterial()
        material.baseColor = .init(tint: .gray)
        material.faceCulling = .none
        let expected = await ModelPoster.image(key: "preview-descriptor", model: ModelEntity(mesh: previous, materials: [material]), yaw: 0.6, pitch: -0.35, fit: 0.15)
        let actual = await ModelPoster.image(key: "preview-native", model: ModelEntity(mesh: resource, materials: [material]), yaw: 0.6, pitch: -0.35, fit: 0.15)
        let oldBytes = try XCTUnwrap(expected?.dataProvider?.data) as Data
        let newBytes = try XCTUnwrap(actual?.dataProvider?.data) as Data
        XCTAssertEqual(oldBytes.count, newBytes.count)
        XCTAssertGreaterThan(stride(from: 3, to: newBytes.count, by: 4).filter { newBytes[$0] > 240 }.count, 100)
        XCTAssertLessThanOrEqual(zip(oldBytes, newBytes).map { abs(Int($0) - Int($1)) }.max() ?? 0, 1, "Only GPU channel rounding may differ; keep geometry, lighting and transparency")
    }

    func testSidebarPrinterAttentionAndPrintingRemainVisibleWithProjects() async throws {
        let companion = FakeObjects()
        await companion.enableDiscovery()
        let printer = try JSONDecoder().decode(PrinterDestination.self, from: Data(#"{"id":"p1","name":"P1S","backend":"test","state":"ready","aliases":["old"]}"#.utf8))
        let offline = try JSONDecoder().decode(PrinterDestination.self, from: Data(#"{"id":"p2","name":"Desk","backend":"test","state":"offline"}"#.utf8))
        await companion.setPrinters([printer, offline])
        await companion.set([item("clip", "printing", ["print": ["bundleId": "clip", "monitor": ["phase": "watching"], "destination": ["id": "old", "name": "P1S"]]])])
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        XCTAssertEqual(model.printerProblems, 1)
        XCTAssertEqual(model.sidebarPrinterStatus(printer), "P1S printing")
        XCTAssertEqual(model.sidebarPrinterStatus(offline), "Desk")
    }

    func testTheSidebarGroupsEveryProjectAndStartsAtTheTop() async {
        let companion = FakeObjects()
        await companion.set([item("p", "printed"), item("r", "ready"), item("n", "needs-closeup"), item("w", "touching-up"),
                             item("f", "failed"), item("x", "archived")])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        XCTAssertEqual(model.groups.map(\.group), [.now, .needsYou, .ready, .printed])
        XCTAssertEqual(model.groups.map { $0.objects.map(\.id) }, [["w", "x"], ["n", "f"], ["r"], ["p"]])
        XCTAssertEqual(model.ordered.count, 6, "no project falls out of the sidebar")
        XCTAssertEqual(model.selection, "w", "the first row in the sidebar is shown first")
    }

    /// Nov 5, caliper card 1f1c5515: "It shouldn't have changed a single thing about the physical print". The Mac's
    /// print sheet starts a designer's file at Standard and says so, from the project the companion serves (PRD §6.1).
    func testADesignersFilePrintsWithItsOwnSettings() async throws {
        let companion = FakeObjects()
        let designer: [String: Any] = ["model": "current/model.3mf", "renders": [], "ownSettings": true, "ownSettingsFor": "current"]
        await companion.set([item("d", "ready", ["title": "Caliper card copy", "kind": "copy", "current": designer,
                                                 "settings": ["printDefaults": ["quality": "fine", "strength": "strong"]]]),
                             item("m", "ready", ["title": "Mic mount", "settings": ["printDefaults": ["quality": "fine", "strength": "strong"]]])])
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        let copy = try XCTUnwrap(model.objects.first { $0.id == "d" })
        let start = PrintSettings(saved: copy.printSheetStart(destinationId: "current"))
        XCTAssertEqual(start.quality, .standard, "never the saved Fine")
        XCTAssertEqual(start.strength, .standard, "never the saved Strong")
        XCTAssertEqual(copy.designerSettingsWords(quality: start.quality.rawValue, strength: start.strength.rawValue),
                       "Prints with the designer’s settings saved in this file.")
        let other = try XCTUnwrap(model.objects.first { $0.id == "m" })
        XCTAssertEqual(PrintSettings(saved: copy.resolvedPrintDefaults(destinationId: "current")).strength, .strong, "Project Settings keeps the saved defaults")
        XCTAssertEqual(PrintSettings(saved: other.printSheetStart(destinationId: "current")).strength, .strong, "any other file keeps its saved defaults")
        XCTAssertNil(other.designerSettingsWords(quality: "standard", strength: "standard"))
    }

    /// Nov 5: "caliper card" left in the search showed 1 of 10 projects and nothing said the rest were hidden.
    func testASearchSaysHowManyProjectsItHides() async {
        let companion = FakeObjects()
        await companion.set([item("c", "confirmed", ["title": "Caliper card logo", "outcome": "works"]),
                             item("v", "confirmed", ["title": "Vernier caliper print", "outcome": "works"]),
                             item("s", "ready", ["title": "Stove gap filler"]), item("a", "printed", ["title": "Old pick"])])
        await companion.setCapabilities(.init(objectsCreate: true, projectSettings: true))
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        let archived = await model.setArchived(true, for: "a")
        XCTAssertTrue(archived)
        XCTAssertEqual(model.groups.last?.group, .archived)
        let narrowed = model.groups(matching: "caliper card")
        XCTAssertEqual(narrowed.groups.flatMap { $0.objects.map(\.id) }, ["c"])
        XCTAssertEqual(narrowed.hidden, 3, "every project the search leaves out is counted, archived ones too")
        XCTAssertEqual(model.groups(matching: "caliper").hidden, 2)
        let none = model.groups(matching: "zzz")
        XCTAssertTrue(none.groups.isEmpty)
        XCTAssertEqual(none.hidden, 4)
        for query in ["", "  "] {
            let all = model.groups(matching: query)
            XCTAssertEqual(all.hidden, 0, "no search hides nothing")
            XCTAssertEqual(all.groups.map(\.group), model.groups.map(\.group))
        }
    }

    /// David, Nov 5: "where did the 'start with these things' thing go, to print the 3d scan rig and the calipers?"
    /// The Mac showed the starters only with no project selected, and it selects the first project on launch.
    func testTheSidebarListsTheStartersWhileProjectsExist() async {
        let companion = FakeObjects()
        await companion.set([item("r", "ready"), item("p", "printed")])
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        XCTAssertNotNil(model.selection, "a project is open, so a no-selection screen can't be the only way in")
        let sidebar = model.groups(matching: "")
        XCTAssertEqual(sidebar.starters.map(\.id), StarterProject.all.map(\.id))
        XCTAssertTrue(sidebar.starters.contains { $0.id == "scan-platform" }, "the scan rig")
        XCTAssertTrue(sidebar.starters.contains { $0.id == "long-vernier-caliper" }, "the caliper")
        XCTAssertTrue(model.groups(matching: "  ").starters.count == StarterProject.all.count)
        XCTAssertTrue(model.groups(matching: "stove").starters.isEmpty, "a search shows only what it matches")
        await companion.set([])
        await model.refresh()
        XCTAssertEqual(model.groups(matching: "").starters.count, StarterProject.all.count, "and with no projects")
    }

    func testANewProjectWaitsForACompanionThatCanStartOne() async {
        let model = ObjectsModel(companion:FakeObjects())
        await model.refresh()
        let refused = await model.startProject(instructions:"A hook", files:[])
        XCTAssertEqual(refused, ObjectsModel.createUnavailable, "an older companion: say so, never fail silently")
        XCTAssertEqual(ObjectsModel.fileKind(URL(fileURLWithPath:"/a/b.HEIC")), "photos")
        XCTAssertEqual(ObjectsModel.fileKind(URL(fileURLWithPath:"/a/b.3mf")), "scan")
        XCTAssertNil(ObjectsModel.fileKind(URL(fileURLWithPath:"/a/b.pdf")))
    }

    func testErrorSentencesNeverDumpTheError() {
        for error: Error in [ControlRemoteError(code:"internal", message:"stack trace"), ControlClientError.invalidResponse,
                             ControlClientError.timedOut, ControlClientError.unavailable,
                             ControlRemoteError(code:"not-found", message:"The requested item is no longer available")] {
            let text = ObjectsModel.sentence(for:error)
            XCTAssertFalse(text.contains("stack") || text.contains("Error") || text.contains("companion"), text)
            XCTAssertTrue(text.hasSuffix("."), text)
        }
    }

    /// Nov 6: David's starter project said "Something went wrong on your Mac." whatever the companion said; the
    /// companion had closed the request without an answer. The Mac shows the companion's own sentence.
    func testARefusalSaysTheCompanionsOwnSentence() async {
        for (code, message) in [("unavailable", "Update bambu-printer-mcp in Settings → Printers."), ("invalid-request", "Choose a whole number of copies."),
                                ("timed-out", "Your Mac took too long to answer. It may still finish; this page updates when it does."),
                                ("busy", "Your Mac is answering too many requests at once. Try again in a moment."),
                                ("slicer-error", "Bambu Studio couldn’t slice this model: a part is off the plate."), ("not-found", "That file is no longer in Downloads.")] {
            XCTAssertEqual(ObjectsModel.sentence(for: ControlRemoteError(code: code, message: message)), message, code)
        }
        // An older companion's words for developers still read as plain sentences, and `internal` never shows its text.
        XCTAssertEqual(ObjectsModel.sentence(for: ControlRemoteError(code: "unavailable", message: "The requested capability is unavailable")), "That isn’t available on your Mac right now.")
        XCTAssertEqual(ObjectsModel.sentence(for: ControlRemoteError(code: "internal", message: "stack trace")), "Something went wrong on your Mac.")
        // No answer at all: the work may still have happened (David's file was added; the page then showed it Ready).
        XCTAssertEqual(ObjectsModel.sentence(for: ControlClientError.invalidResponse), "Your Mac didn’t answer. It may still have done it: this page shows what it did.")
        let companion = FakeObjects()
        await companion.set([item("a", "ready")])
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        await companion.failActions(with: ControlRemoteError(code: "unavailable", message: "Update bambu-printer-mcp in Settings → Printers."))
        _ = await model.perform(.print, on: "a")
        XCTAssertEqual(model.problem, .init(id: "a", text: "Update bambu-printer-mcp in Settings → Printers."))
    }

    func testDeleteRemovesTheObjectAndShowsTheNextOne() async {
        let companion = FakeObjects()
        await companion.set([item("a", "ready"), item("b", "printed"), item("c", "failed")])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        model.selection = "b"
        let deleted = await model.delete("b")
        XCTAssertTrue(deleted)
        XCTAssertEqual(model.objects.map(\.id), ["a", "c"])
        XCTAssertEqual(model.selection, "c", "the page moves to the next object, not back to the top")
        let calls = await companion.calls
        XCTAssertTrue(calls.contains("delete:b"))
        await model.refresh()
        XCTAssertEqual(model.objects.map(\.id), ["a", "c"], "it stays gone after the next read")
    }

    func testDeletingTheLastObjectSelectsTheOneBefore() async {
        let companion = FakeObjects()
        await companion.set([item("a", "ready"), item("b", "printed")])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        model.selection = "b"
        _ = await model.delete("b")
        XCTAssertEqual(model.selection, "a")
        _ = await model.delete("a")
        XCTAssertNil(model.selection)
        XCTAssertTrue(model.objects.isEmpty)
    }

    func testADeleteThatFailsKeepsTheObjectAndSaysWhy() async {
        let companion = FakeObjects()
        await companion.set([item("a", "ready"), item("b", "printing")])
        let model = ObjectsModel(companion:companion)
        await model.refresh()
        model.selection = "b"
        await companion.failActions(with:ControlRemoteError(code:"conflict", message:"This is printing. Delete it once the print is done."))
        let deleted = await model.delete("b")
        XCTAssertFalse(deleted)
        XCTAssertEqual(model.objects.map(\.id), ["a", "b"])
        XCTAssertEqual(model.selection, "b")
        XCTAssertEqual(model.problem, ObjectsModel.Problem(id:"b", text:"This is printing. Delete it once the print is done."))
    }

    func testDoneIsAStatusTheSidebarShowsAndArchiveIsSeparate() async {
        let companion = FakeObjects()
        await companion.set([item("m", "printed", ["current": ["model": "current/model.stl", "renders": []],
                                                    "print": ["bundleId": "b", "monitor": ["phase": "ended", "endState": "done"]]])])
        await companion.setCapabilities(.init(objectsCreate: true, projectSettings: true))
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        XCTAssertEqual(model.groups.map(\.group), [.printed])
        let done = await model.setStatus("works", for: "m")
        XCTAssertTrue(done)
        let patches = await companion.settingsPatches
        XCTAssertEqual(patches["m"], ["status": .string("works")], "Done is the `works` status, set through Project Settings")
        await model.refresh()
        XCTAssertEqual(model.groups.map(\.group), [.done], "It works moves it to Done")
        XCTAssertTrue(model.objects[0].words.actions.contains(.print), "Done stays printable: Print Another…")
        _ = await model.setArchived(true, for: "m")
        XCTAssertEqual(model.groups.map(\.group), [.archived], "Archive hides it in Archived, separate from Done")
        let archive = await companion.settingsPatches
        XCTAssertEqual(archive["m"]?["archived"], .bool(true), "a flag, not a status")
        XCTAssertEqual(archive["m"]?["status"], .string("works"), "Archive never changes the status")
        _ = await model.setArchived(false, for: "m")
        XCTAssertEqual(model.groups.map(\.group), [.done], "Unarchive brings Done back")
    }

    /// "Did it fit?" is asked once per print: answering Needs Changes (or Not Now) ends it until the next print.
    func testDidItFitIsAskedOncePerPrint() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "fit-\(UUID().uuidString)"))
        let first = try project(item("m", "printed", ["print": ["bundleId": "b1", "printId": "p1"]]))
        XCTAssertTrue(DidItFit.asks(first, nil, defaults: defaults))
        let answered = try JSONDecoder().decode(PublishedExtras.self, from: Data(#"{"settings":{"status":"needs-changes","archived":false}}"#.utf8))
        XCTAssertFalse(DidItFit.asks(first, answered, defaults: defaults), "Needs Changes is an answer")
        DidItFit.dismiss(first, defaults: defaults)
        XCTAssertFalse(DidItFit.asks(first, nil, defaults: defaults), "Not Now sets this print aside")
        let next = try project(item("m", "printed", ["print": ["bundleId": "b2", "printId": "p2"]]))
        XCTAssertTrue(DidItFit.asks(next, nil, defaults: defaults), "the next print asks again")
    }

    /// P1: a follow-up pass showed "Ready to print" throughout. pass.ready, then pass.started 182 ms later: the read
    /// for the first can answer after the read for the second, and must not put Ready back.
    func testAnOlderReadNeverPutsBackAStateTheProjectLeft() throws {
        let model = ObjectsModel(companion: FakeObjects())
        let ready = try project(item("s", "ready")), touchingUp = try project(item("s", "touching-up"))
        let afterReady = model.startRead(), afterStarted = model.startRead()
        XCTAssertTrue(model.apply(read: afterStarted, [touchingUp], [:]))
        XCTAssertFalse(model.apply(read: afterReady, [ready], [:]), "the older reply is dropped")
        XCTAssertEqual(model.objects.first?.state.rawValue, "touching-up")
        XCTAssertNotEqual(model.objects.first?.words.capsule, "Ready to print")
    }

    /// An action's reply is newer than a read that started before it.
    func testAReadFromBeforeAnActionDoesNotUndoIt() async throws {
        let companion = FakeObjects()
        await companion.set([item("s", "ready")])
        let model = ObjectsModel(companion: companion)
        await model.refresh()
        let stale = model.startRead()
        let corrected = await model.perform(.correct, on: "s", note: "Wider lip")
        XCTAssertTrue(corrected)
        XCTAssertFalse(model.apply(read: stale, [try project(item("s", "ready"))], [:]))
        XCTAssertEqual(model.objects.first?.state.rawValue, "touching-up")
    }

    /// A poll whose list loses to a newer read still reads the printers and recovers the availability.
    func testARefreshThatLosesToANewerReadStillDoesTheRest() async throws {
        let companion = FakeObjects()
        await companion.set([item("s", "ready")])
        let model = ObjectsModel(companion: companion)
        XCTAssertTrue(model.apply(read: model.startRead() + 100, [try project(item("s", "touching-up"))], [:]))
        await model.refresh()
        XCTAssertEqual(model.objects.first?.state.rawValue, "touching-up", "the newer read stays")
        XCTAssertEqual(model.availability, .ready)
        XCTAssertEqual(model.selection, "s", "the first read still picks the top project")
    }
}
