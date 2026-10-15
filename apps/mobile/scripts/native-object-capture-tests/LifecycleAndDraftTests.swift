#if !MODEL_FIXTURE
import Foundation

@MainActor
final class DelayedEngine: NativeCaptureEngine {
    var onFinish: ((NativeCaptureOutcome) -> Void)?
    var starts = 0
    var stops = 0
    func start() { starts += 1 }
    func stop() { stops += 1 }
}

@main struct LifecycleAndDraftTests {
    @MainActor static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = NativeCaptureDraftStore(root: root)
        let origin = NativeCaptureDestination(projectId: "one", revision: 0, snapshot: "{\"revision\":0}", context: "https://test|device")
        var engines: [DelayedEngine] = []
        let owner = NativeCaptureRunOwner(store: store) { _ in
            let engine = DelayedEngine(); engines.append(engine); return engine
        }
        let first = try owner.start(origin: origin)
        precondition(engines.count == 1 && engines[0].starts == 1)
        owner.stop(); owner.stop()
        precondition(engines[0].stops == 1, "Cancel must be requested once")
        do { _ = try owner.start(origin: origin); fatalError("Started before terminal") } catch {}
        precondition(owner.activeRunID == first.runID, "Retain ownership while cancellation is pending")
        let reloaded = try store.list(activeRunID: owner.activeRunID)
        precondition(reloaded.first?.status == "stopping", "Bridge reload must not mark the still-owned run interrupted")
        engines[0].onFinish?(.stopped)
        precondition(owner.activeRunID == nil)
        let stopped = try store.read(first.runID); precondition(stopped.status == "stopped")
        let second = try owner.start(origin: origin)
        engines[0].onFinish?(.failed("late failure"))
        precondition(owner.activeRunID == second.runID, "Late old callback must not detach the new engine")
        precondition(engines.count == 2 && engines[1].starts == 1)
        let output = try store.directory(second.runID).appendingPathComponent("Models/model-mobile.usdz")
        try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("abc".utf8).write(to: output)
        engines[1].onFinish?(.completed)
        let ready = try store.read(second.runID)
        precondition(ready.status == "ready" && ready.origin == origin)
        precondition(ready.file?.sha256 == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        precondition(ready.file?.byteLength == 3)
        let reopened = NativeCaptureDraftStore(root: root)
        let retained = try reopened.read(second.runID)
        precondition(retained == ready, "Draft survives a new store instance")
        let original = try Data(contentsOf: output)
        precondition(original == Data("abc".utf8), "Keep original bytes")
        let third = try owner.start(origin: origin)
        let interrupted = try reopened.list(activeRunID: nil)
        precondition(interrupted.first(where: { $0.runID == third.runID })?.status == "interrupted")
        owner.stop(); engines[2].onFinish?(.stopped)
        for bad in ["../outside", "", second.runID + "/../outside"] {
            do { _ = try store.read(bad); fatalError("Accepted unsafe run ID") } catch {}
        }
        let fourth = try store.create(origin: origin)
        let models = try store.directory(fourth.runID).appendingPathComponent("Models")
        try FileManager.default.createSymbolicLink(at: models, withDestinationURL: output.deletingLastPathComponent())
        do { _ = try store.complete(fourth.runID); fatalError("Accepted symlink output directory") } catch {}
        print("PASS: once-only cancel, terminal ownership, duplicate start, reload, stale callback, durable identity, interruption, path and symlink rejection")
    }
}

#endif

#if MODEL_FIXTURE
import Foundation
import Observation
#if canImport(UIKit)
import UIKit
#else
@MainActor final class UIApplication { static let shared = UIApplication(); var isIdleTimerDisabled = false }
#endif
struct FixtureLog { func debug(_ value: String) {}; func info(_ value: String) {}; func log(_ value: String) {}; func error(_ value: String) {} }
let logger = FixtureLog()
@MainActor final class ObjectCaptureSession {
    enum CaptureState { case initializing, ready, detecting, capturing, finishing, completed, failed(Swift.Error) }
    enum Error: Swift.Error { case cancelled, sensorFailed }
    let id = UUID()
    var state = CaptureState.ready
    var cancels = 0
    var numberOfShotsTaken = 0
    let stateUpdates: AsyncStream<CaptureState>
    let continuation: AsyncStream<CaptureState>.Continuation
    init() { let stream = AsyncStream<CaptureState>.makeStream(); stateUpdates = stream.stream; continuation = stream.continuation }
    func cancel() { cancels += 1 }
    func emit(_ value: CaptureState) { state = value; continuation.yield(value) }
    func pause() {}; func resume() {}
}
@MainActor final class PhotogrammetrySession {
    enum Failure: Swift.Error { case invalidRequest, failedRequest }
    enum Detail { case reduced }
    enum Request { case modelFile(url: URL, detail: Detail) }
    struct ProgressInfo { var estimatedRemainingTime: TimeInterval?; var processingStage: Output.ProcessingStage? }
    enum Output {
        enum ProcessingStage { case preProcessing, imageAlignment, pointCloudGeneration, meshGeneration, textureMapping, optimization }
        case requestProgress(Request, Double), requestProgressInfo(Request, ProgressInfo), requestError(Request, Swift.Error)
        case processingComplete, processingCancelled, invalidSample, skippedSample, automaticDownsampling, stitchingIncomplete, inputComplete
    }
    var cancels = 0; var processCalls = 0; var throwsOnProcess = false
    let outputs: AsyncStream<Output>; let continuation: AsyncStream<Output>.Continuation
    init() { let pair = AsyncStream<Output>.makeStream(); outputs = pair.stream; continuation = pair.continuation }
    func process(requests: [Request]) throws { processCalls += 1; if throwsOnProcess { throw Failure.invalidRequest } }
    func cancel() { cancels += 1 }
    func emit(_ output: Output) { continuation.yield(output) }
}
#if !UI_FIXTURE
extension PhotogrammetrySession.Output.ProcessingStage { var processingStageString: String? { "Processing" } }
#endif
struct FixtureFolders { let captureFolder: URL; var modelsFolder: URL { captureFolder.appendingPathComponent("Models") }; var imagesFolder: URL { captureFolder.appendingPathComponent("Images") } }
struct FixtureMessages { mutating func removeAll() {} }
@MainActor @Observable final class AppDataModel: Identifiable {
    let id = UUID()
    var isEmbedded = true
    var embeddedCompletionSent = false
    var onEmbeddedCompletion: ((URL?, String?) -> Void)?
    var reconstructionTask: Task<Void, Never>?
    var reconstructionWaitTask: Task<Void, Never>?
    var reconstructionProgress: Float = 0
    var reconstructionRemainingTime: TimeInterval?
    var reconstructionStage: String?
    var reconstructionFailure: Swift.Error?
    var isStoppingReconstruction = false
    var reconstructionStopWaitExceeded = false
    var captureStopped = false; var isStoppingCapture = false; var stopWaitExceeded = false
    var stopStateTask: Task<Void, Never>?; var stopWaitTask: Task<Void, Never>?
    var objectCaptureSession: ObjectCaptureSession?
    var photogrammetrySession: PhotogrammetrySession?
    var captureFolderManager: FixtureFolders?
    var showOverlaySheets = false
    enum Orbit { case orbit1 }; var orbit = Orbit.orbit1
    var isObjectFlipped = false; var currentFeedback: [String] = []
    var messageList = FixtureMessages()
    enum CaptureMode { case object }; var captureMode = CaptureMode.object
    var isSaveDraftEnabled = false; var tutorialPlayedOnce = false
    var error: Swift.Error?; var evaluationWriteError: String?
    var state = ModelState.notSet { didSet { performStateTransition(from: oldValue, to: state) } }
    var events: [String] = []; var starts = 0; var completions = 0
    var fixtureRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    func record(_ event: String, detail: String = "") { events.append(event) }
    func detachListeners() {}
    func startNewCapture() throws {
        starts += 1; objectCaptureSession = ObjectCaptureSession()
        captureFolderManager = FixtureFolders(captureFolder: fixtureRoot)
        try FileManager.default.createDirectory(at: fixtureRoot.appendingPathComponent("Models"), withIntermediateDirectories: true)
        state = .capturing
    }
    func startReconstruction() throws {
        photogrammetrySession = PhotogrammetrySession(); state = .reconstructing
        beginReconstruction(outputFile: captureFolderManager!.modelsFolder.appendingPathComponent("model-mobile.usdz"))
    }
    func switchToErrorState(error: Swift.Error) { self.error = error; state = .failed }
    func removeCheckpointFolder() { precondition(!isEmbedded, "Embedded run must retain checkpoints") }
    func endCapture() { state = .completed }
    func deliverCapture(_ value: ObjectCaptureSession.CaptureState) { onStateChanged(newState: value) }
    func beginFixtureReconstruction(_ session: PhotogrammetrySession, output: URL) { photogrammetrySession = session; state = .reconstructing; beginReconstruction(outputFile: output) }
    // MODEL_METHODS
}
// MODEL_FILTER
#if !UI_FIXTURE
@MainActor func check(_ value: @autoclosure () -> Bool, _ label: String) { if !value() { fatalError(label) }; print("PASS " + label) }
@MainActor func flush() async { for _ in 0..<50 { await Task.yield() } }
@main struct ModelLifecycleTests {
    @MainActor static func main() async throws {
        setbuf(stdout, nil)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let output = root.appendingPathComponent("model.usdz"); try Data("retained".utf8).write(to: output)
        let capture = AppDataModel(); capture.fixtureRoot = root; var completionCount = 0
        capture.onEmbeddedCompletion = { _,_ in completionCount += 1 }
        capture.beginCapture(); let first = capture.objectCaptureSession!
        capture.stopEmbeddedCapture(); capture.stopEmbeddedCapture(); capture.beginCapture(); await flush()
        check(first.cancels == 1 && capture.starts == 1 && capture.objectCaptureSession === first, "capture delayed cancellation retains engine and blocks duplicate Begin")
        for state in [ObjectCaptureSession.CaptureState.initializing,.ready,.detecting,.capturing,.finishing] {
            first.emit(state); await flush(); check(capture.objectCaptureSession === first, "nonterminal capture state retained")
        }
        let reconstruction = AppDataModel(); reconstruction.fixtureRoot = root
        var reconstructionCompletions = 0
        reconstruction.onEmbeddedCompletion = { _,_ in reconstructionCompletions += 1 }
        let session = PhotogrammetrySession(); reconstruction.beginFixtureReconstruction(session, output: output); await flush()
        reconstruction.stopEmbeddedCapture(); reconstruction.stopEmbeddedCapture(); reconstruction.beginCapture()
        check(session.cancels == 1 && reconstruction.photogrammetrySession === session && reconstruction.starts == 0, "reconstruction cancellation is once only and retains ownership")
        // Observe the diagnostic with a bounded scheduling allowance, not an exact wall-clock equality.
        let deadline = Date().addingTimeInterval(14)
        while !(capture.stopWaitExceeded && reconstruction.reconstructionStopWaitExceeded) && Date() < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        check(capture.stopWaitExceeded && capture.objectCaptureSession === first, "never-terminal capture remains blocked after timing report")
        print("Reconstruction after wait: pending=\(reconstruction.isStoppingReconstruction) wait=\(reconstruction.reconstructionStopWaitExceeded) retained=\(reconstruction.photogrammetrySession === session) events=\(reconstruction.events)")
        check(reconstruction.reconstructionStopWaitExceeded && reconstruction.photogrammetrySession === session, "never-terminal reconstruction remains blocked after timing report")
        check(reconstruction.events.filter { $0 == "reconstruction-cancel-still-pending" }.count == 1, "bounded reconstruction stop timing log")
        first.emit(.failed(ObjectCaptureSession.Error.cancelled)); session.emit(.processingCancelled); await flush()
        check(capture.objectCaptureSession == nil && completionCount == 1 && capture.starts == 1, "capture terminal completes once without implicit restart")
        check(reconstruction.photogrammetrySession == nil && reconstructionCompletions == 1 && reconstruction.starts == 0, "reconstruction terminal completes without implicit restart")
        first.emit(.completed); session.emit(.processingComplete); capture.deliverCapture(.completed); await flush()
        check(completionCount == 1 && reconstructionCompletions == 1, "late callbacks cannot complete twice")
        check(try! Data(contentsOf: output) == Data("retained".utf8), "stopping retains original output bytes")
        for terminal in [ObjectCaptureSession.CaptureState.completed,.failed(ObjectCaptureSession.Error.sensorFailed)] {
            let model = AppDataModel(); model.fixtureRoot = root; model.beginCapture(); let active = model.objectCaptureSession!
            model.stopEmbeddedCapture(); active.emit(terminal); await flush()
            check(model.objectCaptureSession == nil && model.starts == 1, "both SDK capture terminal states release ownership")
        }
        let race = AppDataModel(); let raceSession = PhotogrammetrySession(); var raceOutput: URL?
        race.onEmbeddedCompletion = { url,_ in raceOutput = url }
        race.beginFixtureReconstruction(raceSession, output: output); await flush(); race.stopEmbeddedCapture(); raceSession.emit(.processingComplete); await flush()
        check(race.photogrammetrySession == nil && raceOutput == nil && race.starts == 0, "completion racing cancellation stays stopped, not implicitly imported")
        let failed = AppDataModel(); let failedSession = PhotogrammetrySession()
        failed.beginFixtureReconstruction(failedSession, output: output); await flush()
        failedSession.emit(.requestError(.modelFile(url: output, detail: .reduced), PhotogrammetrySession.Failure.failedRequest)); await flush()
        check(failed.photogrammetrySession === failedSession, "request error alone is not terminal")
        failedSession.emit(.processingComplete); await flush()
        check(failed.photogrammetrySession == nil && failed.state == .failed && failed.starts == 0, "terminal request failure is retained without restart")
        let missing = AppDataModel(); let missingSession = PhotogrammetrySession()
        missing.beginFixtureReconstruction(missingSession, output: root.appendingPathComponent("missing.usdz")); await flush(); missingSession.emit(.processingComplete); await flush()
        check(missing.state == .failed && missing.photogrammetrySession == nil, "missing completed model cannot become ready")
        let ready = AppDataModel(); let readySession = PhotogrammetrySession(); var readyOutput: URL?
        ready.onEmbeddedCompletion = { url,_ in readyOutput = url }
        ready.beginFixtureReconstruction(readySession, output: output); await flush(); readySession.emit(.processingComplete); await flush()
        check(ready.state == .viewing && readyOutput == output && readySession.processCalls == 1, "completed model is handed off exactly once")
        let rejected = AppDataModel(); let rejectedSession = PhotogrammetrySession(); rejectedSession.throwsOnProcess = true
        rejected.beginFixtureReconstruction(rejectedSession, output: output); await flush()
        check(rejected.photogrammetrySession == nil && rejected.state == .failed, "synchronously rejected processing starts no active operation")
    }
}
#endif
#endif
