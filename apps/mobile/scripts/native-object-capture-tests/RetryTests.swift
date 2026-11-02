import Foundation

struct Project {
    enum State { case new, touchingUp }
    var id = "object-1"
    var state = State.new
    var scan: String?
    var capture: [String]?
}
typealias StmObject = Project
struct CompanionError: Error { var code: String; var message: String }
struct ChosenPhoto: Equatable { var id: String }

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
    static func reset() { frames = []; captures = 0; isFinished = false; MacConnection.pending = [:]; MacConnection.requested = [] }
}

/// The Mac side: what it has received, keyed by file, and whether start came before every file.
@MainActor final class MacConnection {
    static var pending: [String: [ChosenPhoto]] = [:]
    static var requested: Set<String> = []
    var events: [String] = []
    var received: [Int: String] = [:]
    var photos: Set<String> = []
    var savedRun: String?
    var captures = 0
    var failUpload = false
    var startedWithIncompleteCapture = false
    var startedWithoutPhotos = false
    var expectedPhotos: Set<String> = []
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
    func sendHandheld(_ id: String) async throws -> StmObject {
        events.append("send-handheld")
        try upload(HandheldCapture.frames)
        return try await start(id)
    }
    func sendChosen(_ id: String, _ chosen: [ChosenPhoto]) async throws {
        for photo in chosen where !photos.contains(photo.id) {
            events.append("send-photo")
            if failUpload { failUpload = false; throw CompanionError(code: "unreachable", message: "Interrupted upload") }
            photos.insert(photo.id)
        }
    }
    private func upload(_ frames: [String]) throws {
        for (index, frame) in frames.enumerated() where received[index] == nil {
            received[index] = frame
            if failUpload {
                failUpload = false
                throw CompanionError(code: "unreachable", message: "Interrupted upload")
            }
        }
    }
    func start(_ id: String) async throws -> StmObject {
        events.append("start")
        if (HandheldCapture.isFinished || savedRun != nil) && received.count < 3 { startedWithIncompleteCapture = true }
        if !expectedPhotos.isSubset(of: photos) { startedWithoutPhotos = true }
        return StmObject(state: .touchingUp)
    }
    static func pendingPhotos(_ id: String) -> [ChosenPhoto] { pending[id] ?? [] }
    static func savePending(_ id: String, _ photos: [ChosenPhoto]) { pending[id] = photos }
    static func clearPending(_ id: String) { pending[id] = nil; requested.remove(id) }
    static func sendRequested(_ id: String) -> Bool { requested.contains(id) }
    static func markSendRequested(_ id: String) { requested.insert(id) }
    // SEND_PROJECT
}

/// Sends run in the background in the app; here they finish before the call returns.
@MainActor final class ProjectsStore {
    let mac = MacConnection()
    var sending: Set<String> = []
    var failure: Error?
    var latest: Project?
    private var request = 0
    func startRequest() -> Int { request += 1; return request }
    @discardableResult func replace(_ project: Project, ticket: Int) -> Bool {
        guard ticket == request else { return false }
        latest = project
        return true
    }
    func replace(_ project: Project) { latest = project }
    func sendInBackground(_ id: String, _ body: @escaping @MainActor () async throws -> Void) async {
        sending.insert(id)
        defer { sending.remove(id) }
        do { try await body() } catch { failure = error }
    }
}
@propertyWrapper final class FixtureState<Value> {
    var wrappedValue: Value
    init(wrappedValue: Value) { self.wrappedValue = wrappedValue }
}

// Only UI state and native boundaries are replaced. The async methods below are extracted verbatim
// from the production views and MacConnection, as in the lifecycle seam alongside this test.
@MainActor struct NewObjectView {
    enum Attached: Equatable { case walkAround, inHand }
    let store = ProjectsStore()
    var canSend: Bool { true }
    @FixtureState var askedForDescription = false
    @FixtureState var describing = false
    @FixtureState var instructions = "A cup holder"
    @FixtureState var draftId = "object-1"
    @FixtureState var photos: [ChosenPhoto] = []
    @FixtureState var attached: Attached? = nil
    @FixtureState var draft = Project()
    @FixtureState var result: Project? = nil
    @FixtureState var failure: Error? = nil
    func object(scanning: Bool = false) async throws -> Project { draft }
    func started(_ object: Project) { result = object }
    func run(_ kind: String, _ body: () async throws -> Void) async {
        do { try await body() } catch { failure = error }
    }
    // NEW_OBJECT_METHODS
}

@MainActor struct ProjectView {
    let store = ProjectsStore()
    @FixtureState var object: Project? = Project()
    @FixtureState var resumed = false
    @FixtureState var working = false
    @FixtureState var pending: (() async throws -> Project?)? = nil
    func act(_ body: @escaping () async throws -> Project?) { pending = body }
    // PROJECT_METHODS
}

@main struct RetryTests {
    @MainActor static func main() async throws {
        var failures: [String] = []
        func check(_ value: Bool, _ message: String) { if !value { failures.append(message) } }

        // New: a scan attaches; Send sends it in the background; a send cut short resends only what's missing.
        HandheldCapture.reset()
        let handheld = NewObjectView()
        await handheld.scan(handheld: true)
        check(handheld.attached == .inHand && handheld.store.mac.events.isEmpty, "scanning in New sent something before Send")
        handheld.store.mac.failUpload = true
        await handheld.make()
        check(handheld.store.failure != nil, "fixture must interrupt the first upload")
        await handheld.scan(handheld: true)
        check(HandheldCapture.captures == 1, "handheld retry reopened the camera")
        await handheld.make()
        check(handheld.store.mac.received == [0: "capture-1-frame-0", 1: "capture-1-frame-1", 2: "capture-1-frame-2"],
              "handheld retry mixed photos from different captures")
        check(!handheld.store.mac.startedWithIncompleteCapture, "handheld started before all saved photos arrived")

        HandheldCapture.reset()
        let walkaround = NewObjectView()
        await walkaround.scan(handheld: false)
        await walkaround.scan(handheld: true)
        check(walkaround.store.mac.captures == 1 && HandheldCapture.captures == 0,
              "changing scan mode replaced the saved walkaround capture")
        check(walkaround.attached == .walkAround, "the saved walkaround scan wasn't attached")
        walkaround.store.mac.failUpload = true
        await walkaround.make()
        await walkaround.make()
        check(walkaround.store.mac.received == [0: "run-1-frame-0", 1: "run-1-frame-1", 2: "run-1-frame-2"],
              "walkaround retry mixed or omitted original photos")
        check(!walkaround.store.mac.startedWithIncompleteCapture, "Send started an incomplete saved capture")

        // Photos chosen in New survive a send cut short, and the project page sends the rest before start.
        HandheldCapture.reset()
        let chosen = NewObjectView()
        chosen.photos = [ChosenPhoto(id: "a.jpg"), ChosenPhoto(id: "b.jpg")]
        chosen.store.mac.expectedPhotos = ["a.jpg", "b.jpg"]
        chosen.store.mac.failUpload = true
        await chosen.make()
        check(chosen.store.failure != nil && !chosen.store.mac.events.contains("start"), "a failed photo upload still started")
        let page = ProjectView()
        page.store.mac.photos = chosen.store.mac.photos
        page.store.mac.expectedPhotos = chosen.store.mac.expectedPhotos
        _ = try await page.finishSending(Project())
        check(page.store.mac.photos == ["a.jpg", "b.jpg"] && !page.store.mac.startedWithoutPhotos,
              "the project page didn't finish sending the photos chosen in New")
        check(MacConnection.pendingPhotos("object-1").isEmpty, "sent photos stayed pending")
        check(!MacConnection.sendRequested("object-1"), "a finished send stayed marked as requested")

        // The project page: Scan again after a failed send reuses the saved capture.
        HandheldCapture.reset()
        let detail = ProjectView()
        detail.store.mac.failUpload = true
        do { _ = try await detail.scan(Project(), handheld: true) } catch { }
        _ = try await detail.scan(Project(), handheld: false)
        check(HandheldCapture.captures == 1 && detail.store.mac.captures == 0,
              "page retry replaced the saved handheld capture")
        check(detail.store.mac.received == [0: "capture-1-frame-0", 1: "capture-1-frame-1", 2: "capture-1-frame-2"],
              "page retry mixed photos")

        HandheldCapture.reset()
        let detailFinish = ProjectView()
        detailFinish.store.mac.failUpload = true
        do { _ = try await detailFinish.scan(Project(), handheld: false) } catch { }
        _ = try await detailFinish.finishSending(Project())
        check(detailFinish.store.mac.received.count == 3 && !detailFinish.store.mac.startedWithIncompleteCapture,
              "Finish Sending started before the saved scan arrived")

        // A scan attached in New but never sent stays a draft: opening it doesn't send it.
        HandheldCapture.reset()
        _ = await HandheldCapture.run(objectId: "object-1")
        let unsent = ProjectView()
        await unsent.resumeSavedCapture()
        check(unsent.pending == nil, "opening an unsent draft sent its scan")

        HandheldCapture.reset()
        _ = await HandheldCapture.run(objectId: "object-1")
        MacConnection.requested.insert("object-1")
        let relaunched = ProjectView()
        relaunched.store.mac.received[0] = HandheldCapture.frames[0]
        await relaunched.resumeSavedCapture()
        check(relaunched.pending != nil, "relaunch did not resume the saved handheld capture")
        _ = try await relaunched.pending?()
        check(relaunched.store.mac.received.count == 3 && !relaunched.store.mac.startedWithIncompleteCapture,
              "relaunch did not finish sending handheld photos")
        relaunched.pending = nil
        await relaunched.resumeSavedCapture()
        check(relaunched.pending == nil, "the same project page resumed twice")

        HandheldCapture.reset()
        let stillSending = ProjectView()
        _ = await HandheldCapture.run(objectId: "object-1")
        MacConnection.requested.insert("object-1")
        stillSending.store.sending.insert("object-1")
        await stillSending.resumeSavedCapture()
        check(stillSending.pending == nil, "the page resumed a send New is still running")

        HandheldCapture.reset()
        let modelAlreadySent = ProjectView()
        MacConnection.requested.insert("object-1")
        modelAlreadySent.object = Project(scan: "scan.usdz")
        modelAlreadySent.store.mac.savedRun = "saved-walkaround"
        modelAlreadySent.store.mac.received[0] = "saved-walkaround-frame-0"
        await modelAlreadySent.resumeSavedCapture()
        check(modelAlreadySent.pending != nil, "an already-uploaded model prevented recovering the remaining photos")
        _ = try await modelAlreadySent.pending?()
        check(modelAlreadySent.store.mac.received.count == 3 && !modelAlreadySent.store.mac.startedWithIncompleteCapture,
              "relaunch started before the remaining walkaround photos arrived")

        HandheldCapture.reset()
        _ = await HandheldCapture.run(objectId: "object-1")
        let alreadyStarted = ProjectView()
        MacConnection.requested.insert("object-1")
        alreadyStarted.object = Project(state: .touchingUp)
        await alreadyStarted.resumeSavedCapture()
        check(alreadyStarted.pending == nil, "relaunch resent a capture for a running project")
        let alreadyStartedForm = NewObjectView()
        alreadyStartedForm.draft = Project(state: .touchingUp)
        await alreadyStartedForm.make()
        await alreadyStartedForm.scan(handheld: true)
        check(alreadyStartedForm.store.mac.events.isEmpty, "a lost start reply caused another upload or start")

        HandheldCapture.reset()
        let missingLocal = NewObjectView()
        missingLocal.draft = Project(capture: ["0000.heic"])
        await missingLocal.scan(handheld: true)
        check(missingLocal.failure != nil && HandheldCapture.captures == 0,
              "a missing local capture silently reused a project with uploaded frames")
        let missingLocalDetail = ProjectView()
        var refused = false
        do { _ = try await missingLocalDetail.scan(Project(scan: "scan.usdz"), handheld: false) }
        catch { refused = true }
        check(refused && missingLocalDetail.store.mac.captures == 0,
              "the page replaced an uploaded scan when the local capture was gone")

        if !failures.isEmpty {
            failures.forEach { print("FAIL: \($0)") }
            exit(1)
        }
        print("Capture retry checks passed")
    }
}
