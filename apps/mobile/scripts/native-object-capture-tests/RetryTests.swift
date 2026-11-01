import Foundation

struct StmObject {
    enum State { case new, touchingUp }
    var id = "object-1"
    var state = State.new
    var scan: String?
    var capture: [String]?
}
struct MacError: Error { var code: String; var message: String }

@MainActor enum HandheldCapture {
    static var frames: [String] = []
    static var captures = 0
    static var isFinished = false
    static func finished(_ id: String) -> Bool { isFinished }
    static func run(objectId: String) async -> Bool {
        captures += 1
        frames = (0..<3).map { "capture-\(captures)-frame-\($0)" }
        isFinished = true
        return true
    }
    static func reset() { frames = []; captures = 0; isFinished = false }
}

@MainActor final class MacConnection {
    var events: [String] = []
    var received: [Int: String] = [:]
    var savedRun: String?
    var captures = 0
    var failUpload = false
    var startedWithIncompleteCapture = false
    func scan(_ id: String) async throws -> String? {
        captures += 1
        savedRun = "run-\(captures)"
        events.append("capture-walkaround")
        return savedRun
    }
    func finishedScan(_ id: String) async -> String? { savedRun }
    func sendCapture(_ id: String, run: String) async throws {
        events.append("send-walkaround:\(run)")
        try upload((0..<3).map { "\(run)-frame-\($0)" })
    }
    func sendScan(_ id: String, run: String) async throws -> StmObject {
        try await sendCapture(id, run: run)
        return try await start(id)
    }
    func sendHandheld(_ id: String) async throws -> StmObject {
        events.append("send-handheld")
        try upload(HandheldCapture.frames)
        return try await start(id)
    }
    private func upload(_ frames: [String]) throws {
        for (index, frame) in frames.enumerated() where received[index] == nil {
            received[index] = frame
            if failUpload {
                failUpload = false
                throw MacError(code: "unreachable", message: "Interrupted upload")
            }
        }
    }
    func start(_ id: String) async throws -> StmObject {
        events.append("start")
        if (HandheldCapture.isFinished || savedRun != nil) && received.count < 3 {
            startedWithIncompleteCapture = true
        }
        return StmObject(state: .touchingUp)
    }
}
@MainActor final class ObjectsStore { let mac = MacConnection() }
@propertyWrapper final class FixtureState<Value> {
    var wrappedValue: Value
    init(wrappedValue: Value) { self.wrappedValue = wrappedValue }
}

// Only UI state/native boundaries are replaced. The async methods below are extracted verbatim
// from the production views, as in the lifecycle seam alongside this test.
@MainActor struct NewObjectView {
    let store = ObjectsStore()
    @FixtureState var described = true
    @FixtureState var askedForDescription = false
    @FixtureState var describing = false
    @FixtureState var draft = StmObject()
    @FixtureState var result: StmObject? = nil
    @FixtureState var failure: Error? = nil
    func object() async throws -> StmObject { draft }
    func started(_ object: StmObject) { result = object }
    func sendPhotos(_ id: String) async throws { store.mac.events.append("send-chosen") }
    func run(_ kind: String, _ body: () async throws -> Void) async {
        do { try await body() } catch { failure = error }
    }
    // NEW_OBJECT_METHODS
}

@MainActor struct ObjectDetailView {
    let store = ObjectsStore()
    @FixtureState var object: StmObject? = StmObject()
    @FixtureState var resumed = false
    @FixtureState var working = false
    @FixtureState var pending: (() async throws -> StmObject?)? = nil
    func act(_ body: @escaping () async throws -> StmObject?) { pending = body }
    // OBJECT_DETAIL_METHODS
}

@main struct RetryTests {
    @MainActor static func main() async throws {
        var failures: [String] = []
        func check(_ value: Bool, _ message: String) { if !value { failures.append(message) } }

        HandheldCapture.reset()
        let handheld = NewObjectView()
        handheld.store.mac.failUpload = true
        await handheld.scan(handheld: true)
        check(handheld.failure != nil, "fixture must interrupt the first upload")
        await handheld.scan(handheld: true)
        check(HandheldCapture.captures == 1, "handheld retry reopened the camera")
        check(handheld.store.mac.received == [0: "capture-1-frame-0", 1: "capture-1-frame-1", 2: "capture-1-frame-2"],
              "handheld retry mixed photos from different captures")
        check(!handheld.store.mac.startedWithIncompleteCapture, "handheld started before all saved photos arrived")

        HandheldCapture.reset()
        let make = NewObjectView()
        make.store.mac.failUpload = true
        await make.scan(handheld: true)
        await make.make()
        check(make.store.mac.received.count == 3, "Make It skipped the saved handheld photos")
        check(!make.store.mac.startedWithIncompleteCapture, "Make It started an incomplete saved capture")
        check(HandheldCapture.captures == 1, "Make It opened capture again")

        HandheldCapture.reset()
        let walkaround = NewObjectView()
        walkaround.store.mac.failUpload = true
        await walkaround.scan(handheld: false)
        await walkaround.scan(handheld: true)
        check(walkaround.store.mac.captures == 1 && HandheldCapture.captures == 0,
              "changing retry mode replaced the saved walkaround capture")
        check(walkaround.store.mac.received == [0: "run-1-frame-0", 1: "run-1-frame-1", 2: "run-1-frame-2"],
              "walkaround retry mixed or omitted original photos")

        HandheldCapture.reset()
        let makeWalkaround = NewObjectView()
        makeWalkaround.store.mac.failUpload = true
        await makeWalkaround.scan(handheld: false)
        await makeWalkaround.make()
        check(makeWalkaround.store.mac.received.count == 3 && !makeWalkaround.store.mac.startedWithIncompleteCapture,
              "Make It skipped the saved walkaround capture")

        HandheldCapture.reset()
        let detail = ObjectDetailView()
        detail.store.mac.failUpload = true
        do { _ = try await detail.scan(StmObject(), handheld: true) } catch { }
        _ = try await detail.scan(StmObject(), handheld: false)
        check(HandheldCapture.captures == 1 && detail.store.mac.captures == 0,
              "detail retry replaced the saved handheld capture")
        check(detail.store.mac.received == [0: "capture-1-frame-0", 1: "capture-1-frame-1", 2: "capture-1-frame-2"],
              "detail retry mixed photos")

        HandheldCapture.reset()
        let detailMake = ObjectDetailView()
        detailMake.store.mac.failUpload = true
        do { _ = try await detailMake.scan(StmObject(), handheld: false) } catch { }
        _ = try await detailMake.finishSending(StmObject())
        check(detailMake.store.mac.received.count == 3 && !detailMake.store.mac.startedWithIncompleteCapture,
              "detail Make It/Finish Sending started before the saved scan arrived")

        HandheldCapture.reset()
        _ = await HandheldCapture.run(objectId: "object-1")
        let relaunched = ObjectDetailView()
        relaunched.store.mac.received[0] = HandheldCapture.frames[0]
        await relaunched.resumeSavedCapture()
        check(relaunched.pending != nil, "relaunch did not resume the saved handheld capture")
        _ = try await relaunched.pending?()
        check(relaunched.store.mac.received.count == 3 && !relaunched.store.mac.startedWithIncompleteCapture,
              "relaunch did not finish sending handheld photos")
        relaunched.pending = nil
        await relaunched.resumeSavedCapture()
        check(relaunched.pending == nil, "same detail view automatically resumed twice")

        HandheldCapture.reset()
        let modelAlreadySent = ObjectDetailView()
        modelAlreadySent.object = StmObject(scan: "scan.usdz")
        modelAlreadySent.store.mac.savedRun = "saved-walkaround"
        modelAlreadySent.store.mac.received[0] = "saved-walkaround-frame-0"
        await modelAlreadySent.resumeSavedCapture()
        check(modelAlreadySent.pending != nil, "already-uploaded model prevented remaining photo recovery")
        _ = try await modelAlreadySent.pending?()
        check(modelAlreadySent.store.mac.received.count == 3 && !modelAlreadySent.store.mac.startedWithIncompleteCapture,
              "relaunch started before remaining walkaround photos arrived")

        HandheldCapture.reset()
        _ = await HandheldCapture.run(objectId: "object-1")
        let alreadyStarted = ObjectDetailView()
        alreadyStarted.object = StmObject(state: .touchingUp)
        await alreadyStarted.resumeSavedCapture()
        check(alreadyStarted.pending == nil, "relaunch resent a capture for a running project")
        let alreadyStartedForm = NewObjectView()
        alreadyStartedForm.draft = StmObject(state: .touchingUp)
        await alreadyStartedForm.make()
        await alreadyStartedForm.scan(handheld: true)
        check(alreadyStartedForm.store.mac.events.isEmpty, "lost start response caused another upload or start")

        HandheldCapture.reset()
        let missingLocal = NewObjectView()
        missingLocal.draft = StmObject(capture: ["0000.heic"])
        await missingLocal.scan(handheld: true)
        check(missingLocal.failure != nil && HandheldCapture.captures == 0,
              "missing local capture silently reused an object with uploaded frames")
        let missingLocalDetail = ObjectDetailView()
        var refused = false
        do { _ = try await missingLocalDetail.scan(StmObject(scan: "scan.usdz"), handheld: false) }
        catch { refused = true }
        check(refused && missingLocalDetail.store.mac.captures == 0,
              "detail scan replaced an uploaded scan when local capture was unavailable")

        if !failures.isEmpty {
            failures.forEach { print("FAIL: \($0)") }
            exit(1)
        }
        print("Capture retry checks passed")
    }
}
