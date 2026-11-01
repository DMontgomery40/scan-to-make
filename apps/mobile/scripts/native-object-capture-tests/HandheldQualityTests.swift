import Foundation
import CoreGraphics
import CoreMedia

// QUALITY_POLICY
// DIAGNOSTIC_OPTIONS

enum HandheldCapture { static let minimumPhotos = 24 }
// CAPTURE_ARCHIVE

// Controlled synchronized containers exercise the actual production callback prefix before Start.
struct ProbeSample { var image: Int? = 1 }
func CMSampleBufferGetImageBuffer(_ sample: ProbeSample) -> Int? { sample.image }
struct ProbeDropReason { var rawValue = 2 }
struct AVCaptureSynchronizedSampleBufferData {
    var sampleBufferWasDropped = false
    var droppedReason = ProbeDropReason()
    var sampleBuffer = ProbeSample()
    var timestamp = CMTime(seconds: 1, preferredTimescale: 1000)
}
struct ProbeDepth { var cameraCalibrationData: Int? = 1 }
struct AVCaptureSynchronizedDepthData {
    var depthDataWasDropped = false
    var droppedReason = ProbeDropReason()
    var depthData = ProbeDepth()
    var timestamp = CMTime(seconds: 1, preferredTimescale: 1000)
}
struct AVCaptureDataOutputSynchronizer {}
struct AVCaptureSynchronizedDataCollection {
    var video: AVCaptureSynchronizedSampleBufferData? = .init()
    var depth: AVCaptureSynchronizedDepthData? = .init()
    func synchronizedData(for output: Int) -> Any? { output == 0 ? video : depth }
}
final class ProbeCallbacks {
    var video = 0, ready = 0
    func onVideo(_ sample: ProbeSample) { video += 1 }
    func onDepthReady() { ready += 1 }
}
final class RecorderCallbackProbe {
    enum Drop { case videoDropped, missingDepth, depthDropped, missingCalibration, invalidTimestamp }
    let videoOutput = 0, depthOutput = 1
    let callbacks = ProbeCallbacks()
    var recording = false, synchronizedCallbacks = 0, recordedDrops = 0
    var diagnosticEvents: [String: Int] = [:]
    var lastVideoAt: TimeInterval?, lastDepthAt: TimeInterval?
    var lastRGBTimestamp: Double?, lastDepthTimestamp: Double?
    func dropped(_ reason: Drop, sensorReason: Int? = nil) { recordedDrops += 1 }
    // RECORDER_CALLBACK_PREFIX
}

@MainActor final class DiagnosticCameraProbe {
    var saved = true, openCalls = 0, captureCalls = 0
    func open() async { openCalls += 1 }
    func diagnosticCapture(seconds: Int) async -> Bool { captureCalls += 1; return saved }
}
@MainActor final class DiagnosticViewProbe {
    let camera = DiagnosticCameraProbe()
    var preview = false
    var diagnosticSeconds: Int? = 3
    var dismissCalls = 0
    func done(_ success: Bool) { dismissCalls += 1 }
    // VIEW_APPEAR_TASK
}

// Only the recorder boundary is controlled. Production owner methods are extracted below;
// stop() suspends until the test releases the writer drain. No camera/session is opened.
@MainActor final class HandheldDepthRecorder {
    struct Summary: Codable {
        var framesSaved = 24
        var bytes: Int64 = 4096
        var failure: String?
        var limitReached = false
    }
    private var drains: [CheckedContinuation<Summary, Never>] = []
    private var observers: [(Int, CheckedContinuation<Void, Never>)] = []
    private(set) var stopCalls = 0
    func stop() async -> Summary {
        stopCalls += 1
        return await withCheckedContinuation { continuation in
            drains.append(continuation)
            let ready = observers.filter { $0.0 <= stopCalls }
            observers.removeAll { $0.0 <= stopCalls }
            ready.forEach { $0.1.resume() }
        }
    }
    func waitForStops(_ count: Int) async {
        guard stopCalls < count else { return }
        await withCheckedContinuation { observers.append((count, $0)) }
    }
    func releaseDrain(_ summary: Summary = .init()) {
        let pending = drains; drains.removeAll()
        pending.forEach { $0.resume(returning: summary) }
    }
}
final class CameraSession: @unchecked Sendable {
    var isRunning = true
    func stopRunning() {}
}
struct CameraDevice {
    var exposureDuration = CMTime(seconds: 0.025, preferredTimescale: 1000)
    var iso: Float = 1000
}

@MainActor final class CaptureOwner {
    // CAMERA_PHASE
    var phase = Phase.capturing
    var taken = 0
    var bytesSaved: Int64 = 0
    var recordingLimitReached = false
    var legacyCapture = false
    var failure: String?
    var notice: String?
    var didFinish = false
    var finishInProgress = false
    var restartInProgress = false
    var closed = false
    var countdownTask: Task<Void, Never>?
    var watchdog: Timer?
    var diagnosticsTask: Task<Void, Never>?
    var recorder: HandheldDepthRecorder? = HandheldDepthRecorder()
    let session = CameraSession()
    var device: CameraDevice? = CameraDevice()
    var previewRendering = true
    var previewSize = CGSize(width: 300, height: 600)
    var lastVideoFrameAt: TimeInterval? = ProcessInfo.processInfo.systemUptime
    var lastDepthFrameAt: TimeInterval? = ProcessInfo.processInfo.systemUptime
    var mask: Int?
    let queue = DispatchQueue(label: "handheld.test.session")
    let folder: URL
    let testRoot: URL
    var events: [String] = []
    var openCalls = 0
    var filesAtOpen: [String] = []
    init() throws {
        testRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        folder = testRoot.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }
    deinit { try? FileManager.default.removeItem(at: testRoot) }
    var markerExists: Bool { FileManager.default.fileExists(atPath: folder.appending(path: "finished").path) }
    func recordDiagnostics(_ event: String) { events.append(event) }
    func open() async {
        openCalls += 1
        try! FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        filesAtOpen = try! FileManager.default.contentsOfDirectory(atPath: folder.path)
    }
    // CAN_START
    // CAN_RECORD_AGAIN
    // RECORD_AGAIN
    // RETAIN_SUMMARY
    // PAUSE_CAPTURE
    // CAPTURE_FAILED
    func watchdogTick() async {
        let callback = { [weak self] in
            // WATCHDOG_CALLBACK
        }
        await callback().value
    }
    // FINISH_CAPTURE
    // CLOSE_CAPTURE
}

@main struct StreamingTests {
    @MainActor static func main() async throws {
        var failures: [String] = []
        func check(_ value: Bool, _ message: String) { if !value { failures.append(message) } }
        let flag = "-STMHandheldDiagnosticSeconds"
        check(HandheldDiagnosticOptions.seconds(arguments: ["app", flag, "3"], previewState: "ready") == 3, "minimum diagnostic duration")
        check(HandheldDiagnosticOptions.seconds(arguments: ["app", flag, "15"], previewState: "ready") == 15, "maximum diagnostic duration")
        for args in [["app"], ["app", flag], ["app", flag, "2"], ["app", flag, "16"], ["app", flag, "nan"], ["app", flag, "3", flag, "4"]] {
            check(HandheldDiagnosticOptions.seconds(arguments: args, previewState: "ready") == nil, "diagnostic requires one bounded explicit duration")
        }
        check(HandheldDiagnosticOptions.seconds(arguments: ["app", flag, "3"], previewState: "capturing") == nil, "diagnostic never drives fake capture layout")
        for saved in [true, false] {
            let view = DiagnosticViewProbe(); view.camera.saved = saved
            await view.appear()
            check(view.camera.openCalls == 1 && view.camera.captureCalls == 1 && view.dismissCalls == 0,
                  "diagnostic success/failure dismissed the awake stand view")
        }
        let ordinaryView = DiagnosticViewProbe(); ordinaryView.diagnosticSeconds = nil
        await ordinaryView.appear()
        check(ordinaryView.camera.openCalls == 1 && ordinaryView.camera.captureCalls == 0 && ordinaryView.dismissCalls == 0,
              "ordinary launch started a diagnostic capture")
        func probe(_ data: AVCaptureSynchronizedDataCollection, _ reason: String, ready: Bool = false) {
            let recorder = RecorderCallbackProbe()
            recorder.dataOutputSynchronizer(.init(), didOutput: data)
            check(recorder.synchronizedCallbacks == 1, "count callback before Start")
            check(recorder.diagnosticEvents[reason] == 1, "persist before-Start reason: \(reason)")
            check(recorder.recordedDrops == 0, "diagnostics leave recording drop totals unchanged")
            check(recorder.callbacks.ready == (ready ? 1 : 0), "readiness still requires calibrated valid pair")
        }
        probe(.init(video: nil), "missingVideo")
        probe(.init(video: .init(sampleBufferWasDropped: true)), "videoDropped:2")
        probe(.init(depth: nil), "missingDepth")
        probe(.init(depth: .init(depthDataWasDropped: true)), "depthDropped:2")
        probe(.init(depth: .init(depthData: .init(cameraCalibrationData: nil))), "missingCalibration")
        probe(.init(video: .init(timestamp: .invalid)), "invalidTimestamp")
        probe(.init(), "calibratedPair", ready: true)
        func usable(rgb: TimeInterval? = 10, depth: TimeInterval? = 10,
                    exposure: Double = 0.025, iso: Double = 1000) -> Bool {
            HandheldCaptureQuality.canCapture(lastFrameAt: rgb, lastDepthAt: depth,
                now: 10.1, exposure: exposure, iso: iso)
        }
        check(usable(), "Fresh RGB/depth with valid exposure was rejected; brightness is not a readiness condition")
        check(!usable(rgb: nil), "Missing RGB was accepted")
        check(!usable(depth: nil), "Missing depth was accepted")
        check(!usable(rgb: 7), "Stale RGB was accepted")
        check(!usable(depth: 7), "Stale depth was accepted")
        check(!usable(rgb: 11) && !usable(depth: 11), "Future timestamps were accepted")
        check(!usable(exposure: 0) && !usable(iso: 0), "Observed zero exposure/ISO was accepted")
        check(!usable(exposure: .nan) && !usable(iso: .infinity), "Nonfinite exposure/ISO was accepted")

        let ready = try CaptureOwner()
        check(ready.canStart, "Ready synchronized camera could not start")
        ready.previewRendering = false
        check(!ready.canStart, "Capture started before the live preview rendered")
        ready.previewRendering = true
        ready.retain(.init(limitReached: true))
        check(ready.recordingLimitReached && !ready.canStart, "A terminal storage limit still offered Resume")
        let retained = try JSONSerialization.jsonObject(with: Data(contentsOf: ready.folder.appending(path: "capture-diagnostics.json"))) as! [String: Any]
        check(retained["limitReached"] as? Bool == true && ready.bytesSaved == 4096, "Recorder summary was not retained")
        ready.retain(.init())
        ready.legacyCapture = true
        check(!ready.canStart, "Legacy saved capture offered incompatible streaming append")

        let uninterrupted = try CaptureOwner()
        await uninterrupted.watchdogTick()
        check(uninterrupted.phase == .capturing && uninterrupted.recorder!.stopCalls == 0,
              "Readiness watchdog stopped a healthy recording")
        for interruption in ["preview", "rgb", "depth"] {
            let paused = try CaptureOwner(), pausedRecorder = paused.recorder!
            if interruption == "preview" { paused.previewRendering = false }
            if interruption == "rgb" { paused.lastVideoFrameAt = nil }
            if interruption == "depth" { paused.lastDepthFrameAt = nil }
            let pauseTask = Task { await paused.watchdogTick() }
            await pausedRecorder.waitForStops(1)
            check(paused.phase == .saving && !paused.markerExists,
                  "Readiness pause did not wait for the active writer drain")
            await paused.watchdogTick()
            check(pausedRecorder.stopCalls == 1, "Repeated readiness callback started another pause")
            pausedRecorder.releaseDrain(.init(framesSaved: 7))
            await pauseTask.value
            check(paused.phase == .paused && paused.taken == 7 && !paused.markerExists,
                  "Readiness pause lost the committed partial capture")
            check(paused.failure == nil && paused.notice != nil && !paused.canStart,
                  "Transient readiness loss latched a fatal error or allowed premature Resume")
            paused.previewRendering = true
            paused.lastVideoFrameAt = ProcessInfo.processInfo.systemUptime
            paused.lastDepthFrameAt = ProcessInfo.processInfo.systemUptime
            check(paused.canStart, "Fresh camera evidence did not restore Resume after a transient pause")
        }
        let pauseFailure = try CaptureOwner(), pauseFailureRecorder = pauseFailure.recorder!
        let pauseWithFailedWrite = Task { await pauseFailure.pause() }
        await pauseFailureRecorder.waitForStops(1)
        pauseFailureRecorder.releaseDrain(.init(framesSaved: 7, failure: "writer failed during pause"))
        await pauseWithFailedWrite.value
        check(pauseFailure.failure == "writer failed during pause" && !pauseFailure.canStart,
              "Pause silently cleared a fatal writer failure")
        let fatal = try CaptureOwner(), fatalRecorder = fatal.recorder!
        let fatalTask = Task { await fatal.captureFailed("encoding failed") }
        await fatalRecorder.waitForStops(1)
        fatalRecorder.releaseDrain(.init(framesSaved: 7, failure: "encoding failed"))
        await fatalTask.value
        await fatal.watchdogTick()
        check(fatal.failure == "encoding failed" && fatal.phase == .paused && !fatal.canStart,
              "Readiness watchdog cleared a real encoding failure")

        for count in [1, 23] {
            let legacy = try CaptureOwner()
            legacy.legacyCapture = true; legacy.phase = .paused; legacy.taken = count; legacy.recorder = nil
            let fm = FileManager.default
            let originals = (0..<count).map { (String(format: "%04d.heic", $0), Data("original-\($0)".utf8)) } + [("capture-ui-diagnostics.json", Data("retained diagnostics".utf8))]
            for (name, data) in originals { try data.write(to: legacy.folder.appendingPathComponent(name)) }
            let nested = legacy.folder.appendingPathComponent("retained-notes")
            try fm.createDirectory(at: nested, withIntermediateDirectories: true)
            try Data("nested evidence".utf8).write(to: nested.appendingPathComponent("note.txt"))
            check(legacy.canRecordAgain, "short legacy capture did not offer Record Again")
            await legacy.recordAgain()
            let archiveParent = legacy.testRoot.appending(path: "Archives/\(legacy.folder.lastPathComponent)")
            let archives = try fm.contentsOfDirectory(at: archiveParent, includingPropertiesForKeys: nil)
            check(archives.count == 1, "restart did not create exactly one project archive")
            for (name, bytes) in originals { check(try Data(contentsOf: archives[0].appendingPathComponent(name)) == bytes, "archived original bytes changed") }
            check(try Data(contentsOf: archives[0].appending(path: "retained-notes/note.txt")) == Data("nested evidence".utf8), "nested original files were lost")
            check(legacy.openCalls == 1 && legacy.filesAtOpen.isEmpty, "fresh production open was not called after complete archive")
            check(!legacy.legacyCapture && legacy.taken == 0 && legacy.bytesSaved == 0 && legacy.phase == .ready, "legacy owner state was mixed into restart")
            try Data("fresh-frame".utf8).write(to: legacy.folder.appendingPathComponent("0000.heic"))
            check(try Data(contentsOf: archives[0].appendingPathComponent("0000.heic")) == Data("original-0".utf8), "new capture overwrote archived frame")
            await legacy.recordAgain()
            check(legacy.openCalls == 1, "duplicate Record Again reopened a fresh capture")
        }

        let collision = try CaptureOwner(), fixedID = UUID()
        try Data("original".utf8).write(to: collision.folder.appendingPathComponent("0000.heic"))
        let occupied = collision.testRoot.appending(path: "Archives/\(collision.folder.lastPathComponent)/\(fixedID.uuidString.lowercased())")
        try FileManager.default.createDirectory(at: occupied, withIntermediateDirectories: true)
        try Data("existing archive".utf8).write(to: occupied.appendingPathComponent("0000.heic"))
        do { _ = try HandheldCaptureArchive.preserveLegacy(collision.folder, identifier: fixedID); check(false, "archive collision overwrote files") } catch {}
        check(try Data(contentsOf: collision.folder.appendingPathComponent("0000.heic")) == Data("original".utf8), "archive collision removed current capture")
        check(try Data(contentsOf: occupied.appendingPathComponent("0000.heic")) == Data("existing archive".utf8), "archive collision changed earlier archive")

        let archiveFailure = try CaptureOwner()
        archiveFailure.legacyCapture = true; archiveFailure.phase = .paused; archiveFailure.taken = 1; archiveFailure.recorder = nil
        try Data("original".utf8).write(to: archiveFailure.folder.appendingPathComponent("0000.heic"))
        try Data("blocks directory".utf8).write(to: archiveFailure.testRoot.appendingPathComponent("Archives"))
        await archiveFailure.recordAgain()
        check(archiveFailure.openCalls == 0 && archiveFailure.legacyCapture && archiveFailure.phase == .paused && archiveFailure.failure != nil, "failed archive still opened/reinitialized capture")
        check(try Data(contentsOf: archiveFailure.folder.appendingPathComponent("0000.heic")) == Data("original".utf8), "failed archive lost original")
        for protectedName in ["finished", "capture-frames.jsonl", "0000.depth.plist"] {
            let protected = try CaptureOwner()
            try Data("original".utf8).write(to: protected.folder.appendingPathComponent("0000.heic"))
            try Data().write(to: protected.folder.appendingPathComponent(protectedName))
            do { _ = try HandheldCaptureArchive.preserveLegacy(protected.folder); check(false, "protected complete/stream capture was archived") } catch {}
            check(FileManager.default.fileExists(atPath: protected.folder.appendingPathComponent("0000.heic").path), "protected capture was removed")
        }

        let normal = try CaptureOwner(), normalRecorder = normal.recorder!
        let timer = Timer(timeInterval: 0.5, repeats: true) { _ in }
        normal.watchdog = timer
        let finishing = Task { await normal.finish() }
        await normalRecorder.waitForStops(1)
        check(normal.phase == .saving && !normal.markerExists, "Finished marker appeared before writer drain")
        check(!timer.isValid && normal.watchdog == nil, "Finish left the readiness watchdog running")
        let duplicate = await normal.finish()
        check(!duplicate && normalRecorder.stopCalls == 1, "Concurrent Done started another finish/drain")
        normalRecorder.releaseDrain(.init(framesSaved: 31, bytes: 8192))
        let finished = await finishing.value
        check(finished && normal.markerExists && normal.phase == .finished && normal.taken == 31,
              "Successful drain did not publish the saved capture")
        check(normal.events.filter { $0 == "saved" }.count == 1, "Concurrent Done completed more than once")

        let failed = try CaptureOwner(), failedRecorder = failed.recorder!
        let newFailure = Task { await failed.finish() }
        await failedRecorder.waitForStops(1)
        failedRecorder.releaseDrain(.init(failure: "writer failed"))
        let failedResult = await newFailure.value
        check(!failedResult && !failed.markerExists && failed.failure == "writer failed" && failed.phase == .paused,
              "A newly failed write was silently marked finished")
        // A second explicit Save acknowledges the failure and keeps already committed valid pairs.
        let saveKnownFailure = Task { await failed.finish() }
        await failedRecorder.waitForStops(2)
        check(failed.failure == "writer failed" && !failed.markerExists,
              "Explicit Save cleared the active error before the finished marker existed")
        failedRecorder.releaseDrain(.init(failure: "writer failed"))
        let savedKnownFailure = await saveKnownFailure.value
        check(savedKnownFailure && failed.markerExists, "Explicit save after a known failure was blocked")
        check(failed.failure == nil && failed.phase == .finished,
              "Successful explicit Save still displayed the old active failure")
        let failureHistory = try JSONSerialization.jsonObject(with: Data(contentsOf: failed.folder.appending(path: "capture-diagnostics.json"))) as! [String: Any]
        check(failureHistory["failure"] as? String == "writer failed",
              "Successful explicit Save erased the retained recorder failure history")

        let canceled = try CaptureOwner(), canceledRecorder = canceled.recorder!
        let canceledFinish = Task { await canceled.finish() }
        await canceledRecorder.waitForStops(1)
        canceled.close()
        await canceledRecorder.waitForStops(2)
        check(!canceled.markerExists, "Cancel during drain published a finished marker")
        canceledRecorder.releaseDrain()
        let canceledResult = await canceledFinish.value
        check(!canceledResult && !canceled.markerExists && canceled.closed,
              "Canceled finish published the capture after its delayed drain")

        let short = try CaptureOwner(), shortRecorder = short.recorder!
        let shortFinish = Task { await short.finish() }
        await shortRecorder.waitForStops(1)
        shortRecorder.releaseDrain(.init(framesSaved: 23))
        let shortResult = await shortFinish.value
        check(!shortResult && !short.markerExists && short.phase == .paused, "Insufficient frames were marked finished")

        let unwritable = try CaptureOwner(), unwritableRecorder = unwritable.recorder!
        unwritable.failure = "known writer failure"
        let unwritableFinish = Task { await unwritable.finish() }
        await unwritableRecorder.waitForStops(1)
        try FileManager.default.removeItem(at: unwritable.folder)
        unwritableRecorder.releaseDrain()
        let unwritableResult = await unwritableFinish.value
        check(!unwritableResult && !unwritable.markerExists && unwritable.failure != nil,
              "Finished-marker write failure was reported as success")

        if !failures.isEmpty { failures.forEach { print("FAIL: \($0)") }; exit(1) }
        print("PASS synchronized readiness, transient pause/resume, retained fatal failures, saved status/history, retained limits, drain-before-finish, duplicate Done and canceled finish")
    }
}
