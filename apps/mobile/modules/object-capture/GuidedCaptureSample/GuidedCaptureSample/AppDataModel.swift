/*
See the LICENSE.txt file for this sample’s licensing information.

Abstract:
A data model for maintaining the app state, including the underlying object capture state as well as any extra app state
 you maintain in addition, perhaps with invariants between them.
*/

import RealityKit
import Darwin
import ARKit
import CoreMotion
import SwiftUI
import os

private let logger = Logger(subsystem: GuidedCaptureSampleApp.subsystem,
                            category: "AppDataModel")

// State metadata only. Keep the initial observation plus the newest bounded history.
private struct CaptureEvaluationEventBuffer {
    static let maximumEvents = 256
    static let maximumBytes = 64 * 1024
    private(set) var events: [[String: Any]] = []
    private(set) var droppedEvents = 0
    private var lastSignature: Data?

    mutating func append(_ event: [String: Any]) {
        var identity = event
        identity.removeValue(forKey: "elapsedSeconds")
        guard let signature = try? JSONSerialization.data(withJSONObject: identity, options: [.sortedKeys]),
              let encoded = try? JSONSerialization.data(withJSONObject: [event], options: [.prettyPrinted, .sortedKeys]),
              encoded.count <= Self.maximumBytes else {
            droppedEvents += 1
            return
        }
        guard signature != lastSignature else { return }
        lastSignature = signature
        events.append(event)
        while events.count > Self.maximumEvents || encodedByteCount > Self.maximumBytes {
            events.remove(at: events.count > 1 ? 1 : 0)
            droppedEvents += 1
        }
    }

    var encodedByteCount: Int {
        (try? JSONSerialization.data(withJSONObject: events, options: [.prettyPrinted, .sortedKeys]).count)
            ?? Self.maximumBytes + 1
    }
}

@MainActor
@Observable
class AppDataModel: Identifiable {
    static let instance = AppDataModel()
    let captureDirectory: URL?
    var isEmbedded: Bool { captureDirectory != nil }
    var onEmbeddedCompletion: ((URL?, String?) -> Void)?
    private var embeddedCompletionSent = false
    private var reconstructionTask: Task<Void, Never>?
    private var reconstructionWaitTask: Task<Void, Never>?
    private(set) var reconstructionProgress: Float = 0
    private(set) var reconstructionRemainingTime: TimeInterval?
    private(set) var reconstructionStage: String?
    private(set) var stitchingIncomplete = false
    private(set) var reconstructionFailure: Swift.Error?
    private(set) var isStoppingReconstruction = false
    private(set) var reconstructionStopWaitExceeded = false

    private func finishEmbedded(output: URL? = nil, error: String? = nil) {
        guard isEmbedded, !embeddedCompletionSent else { return }
        embeddedCompletionSent = true
        UIApplication.shared.isIdleTimerDisabled = false
        onEmbeddedCompletion?(output, error)
    }

    func stopEmbeddedCapture() {
        if photogrammetrySession != nil { cancelReconstruction() }
        else if objectCaptureSession != nil { stopCapture(reason: "Capture closed or interrupted") }
        else { finishEmbedded() }
    }

    /// When we start the capture phase, this will be set to the correct locations in the captureFolderManager.
    var objectCaptureSession: ObjectCaptureSession? {
        willSet {
            detachListeners()
        }
        didSet {
            guard objectCaptureSession != nil else { return }
            attachListeners()
        }
    }

    /// Once we are headed to reconstruction portion, we will hold the session here.
    private(set) var photogrammetrySession: PhotogrammetrySession?

    /// When we start a new capture, the folder will be set here.
    private(set) var captureFolderManager: CaptureFolderManager?

    /// Shows whether the user decided to skip reconstruction.
    private(set) var isSaveDraftEnabled = false

    var messageList = TimedMessageList()

    enum ModelState {
        case notSet
        case ready
        case capturing
        case prepareToReconstruct
        case reconstructing
        case viewing
        case completed
        case restart
        case failed
    }

    var state: ModelState = .notSet {
        didSet {
            logger.debug("didSet AppDataModel.state to \(String(describing: self.state))")
            performStateTransition(from: oldValue, to: state)
        }
    }

    var orbit: Orbit = .orbit1
    var isObjectFlipped: Bool = false

    var hasIndicatedObjectCannotBeFlipped: Bool = false
    var hasIndicatedFlipObjectAnyway: Bool = false
    var isObjectFlippable: Bool {
        // Override the objectNotFlippable feedback if the user has indicated
        // the object cannot be flipped or if they want to flip the object anyway
        guard !hasIndicatedObjectCannotBeFlipped else { return false }
        guard !hasIndicatedFlipObjectAnyway else { return true }
        guard let session = objectCaptureSession else { return true }
        return !session.feedback.contains(.objectNotFlippable)
    }

    /// Apple's freeform capture with no box and no mode is the only capture (quick-sweep-capture.md §3.1). There is no
    /// Area mode: it turns object masking off, and the Mac rebuild keeps it on.
    private(set) var freeformFlow = FreeformCaptureFlow()
    /// How far the camera looked down for each photo, from the device's gravity when the shot count went up. Apple's
    /// session reports the count (`numberOfShotsTakenUpdates`) but not each shot's camera, so the phone's own motion
    /// sensor says which height each photo came from.
    private(set) var shotLookDowns: [Double] = []
    /// One motion manager for the app, as Apple asks ("Create only one CMMotionManager object for your app").
    private let motion = CMMotionManager()
    /// When the app takes the next photo (``FreeformCaptureFlow/ShotPacer``), while it paces the shots at all.
    private var pacer = FreeformCaptureFlow.ShotPacer()
    private var pacing = false
    /// What the photos so far cover, which gates Done (``FreeformCaptureFlow/Coverage``).
    var captureCoverage: FreeformCaptureFlow.Coverage {
        FreeformCaptureFlow.Coverage(shots: objectCaptureSession?.numberOfShotsTaken ?? 0, lookDowns: shotLookDowns,
                                     heightsKnown: motion.isDeviceMotionAvailable)
    }
    private var evaluationBuffer = CaptureEvaluationEventBuffer()
    /// The newest evaluation.json, built when its event was recorded and not yet on disk (see ``record(_:detail:)``).
    private var evaluationPending: (folder: URL, manifest: [String: Any])?
    private var evaluationLastWrite = -Double.infinity
    private var evaluationFlushTask: Task<Void, Never>?
    /// The session's shutter and image limit, read once it has started.
    private var evaluationSession: [String: Any]?
    private var lastObservedTracking: String?
    private var lastObservedPause: Bool?
    var evaluationStarted = Date()
    private(set) var stopMessage: String?
    private(set) var captureStopped = false
    private(set) var isStoppingCapture = false
    private(set) var stopWaitExceeded = false
    private var stopStateTask: Task<Void, Never>?
    private var stopWaitTask: Task<Void, Never>?
    var evaluationWriteError: String?
    var passCount = 1
    var flipCount = 0

    // When state moves to failed, this is the error causing it.
    private(set) var error: Swift.Error?

    // Use setShowOverlaySheets(to:) to change this so you can maintain ObjectCaptureSession's pause state
    // properly because you don't hide the ObjectCaptureView. If you hide the ObjectCaptureView it pauses automatically.
    private(set) var showOverlaySheets = false

    // Shows whether the tutorial has played once during a session.
    var tutorialPlayedOnce = false

    // Postpone creating ObjectCaptureSession and PhotogrammetrySession until necessary.
    init(captureDirectory: URL? = nil) {
        self.captureDirectory = captureDirectory
        NotificationCenter.default.addObserver(self,
                                               selector: #selector(handleAppTermination(notification:)),
                                               name: UIApplication.willTerminateNotification,
                                               object: nil)
    }

    isolated deinit {
        NotificationCenter.default.removeObserver(self)
        for task in tasks { task.cancel() }
        stopStateTask?.cancel()
        stopWaitTask?.cancel()
        reconstructionTask?.cancel()
        reconstructionWaitTask?.cancel()
    }

    /// Once reconstruction and viewing are complete, this should be called to let the app know it can go back to the new capture
    /// view.  We explicitly DO NOT destroy the model here to avoid transition state errors.  The splash screen will set up the
    /// AppDataModel to a clean slate when it starts.
    /// This can also be called after a cancelled or error reconstruction to go back to the start screen.
    func endCapture() {
        state = .completed
    }

    // Only a deliberate Begin action may create a session after a retained stop.
    func beginCapture() {
        guard !isStoppingCapture, objectCaptureSession == nil, photogrammetrySession == nil else { return }
        captureStopped = false
        stopMessage = nil
        reset()
    }

    func stopCapture(reason: String = "Stopped by user", message: String? = nil) {
        guard !captureStopped, let session = objectCaptureSession else { return }
        captureStopped = true
        stopMessage = message
        isStoppingCapture = true
        stopWaitExceeded = false
        record("interrupted", detail: reason + "; original files retained")
        detachListeners()
        // cancel() is a request. Keep ownership until the SDK reaches a terminal state.
        stopStateTask = Task { [weak self, session] in
            guard !Task.isCancelled, let self else { return }
            if self.finishStopIfTerminal(session.state, session: session) { return }
            for await newState in session.stateUpdates {
                guard !Task.isCancelled else { return }
                if self.finishStopIfTerminal(newState, session: session) { return }
            }
        }
        session.cancel()
        record("cancel-requested", detail: "Public cancellation requested; hardware release not verified")
        showOverlaySheets = false
        UIApplication.shared.isIdleTimerDisabled = false
        state = .notSet
        if finishStopIfTerminal(session.state, session: session) { return }
        stopWaitTask = Task { [weak self, session] in
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            guard !Task.isCancelled else { return }
            self?.markStopStillPending(session: session)
        }
    }

    private func finishStopIfTerminal(_ newState: ObjectCaptureSession.CaptureState,
                                      session: ObjectCaptureSession) -> Bool {
        guard captureStopped, isStoppingCapture, objectCaptureSession?.id == session.id else { return false }
        // These are the SDK's two terminal states. Finishing is still in progress.
        switch newState {
        case .completed, .failed:
            break
        case .initializing, .ready, .detecting, .capturing, .finishing:
            return false
        @unknown default:
            return false
        }
        record("cancel-terminal", detail: String(describing: newState) + "; hardware release not verified")
        isStoppingCapture = false
        stopWaitExceeded = false
        stopStateTask?.cancel()
        stopStateTask = nil
        stopWaitTask?.cancel()
        stopWaitTask = nil
        objectCaptureSession = nil
        finishEmbedded(error: stopMessage)
        return true
    }

    private func markStopStillPending(session: ObjectCaptureSession) {
        guard captureStopped, isStoppingCapture, !stopWaitExceeded,
              objectCaptureSession?.id == session.id else { return }
        stopWaitExceeded = true
        record("cancel-still-pending", detail: "No terminal state after 10 seconds; session retained and new capture blocked")
    }

    // Don't touch the showOverlaySheets directly, call setShowOverlaySheets() instead.
    // Since we use sheets and leave the ObjectCaptureView on screen and blur it underneath,
    // the session doesn't pause. We need to pause/resume the session by hand.
    func setShowOverlaySheets(to shown: Bool) {
        guard !captureStopped, shown != showOverlaySheets else { return }
        if shown {
            showOverlaySheets = true
            objectCaptureSession?.pause()
        } else {
            objectCaptureSession?.resume()
            showOverlaySheets = false
        }
    }

    func saveDraft() {
        isSaveDraftEnabled = true
        objectCaptureSession?.finish()
    }

    // - MARK: Private Interface

    private var currentFeedback: Set<Feedback> = []

    private typealias Feedback = ObjectCaptureSession.Feedback
    private typealias Tracking = ObjectCaptureSession.Tracking

    private var tasks: [ Task<Void, Never> ] = []
}

extension AppDataModel {
    private func attachListeners() {
        logger.debug("Attaching listeners...")
        guard let model = objectCaptureSession else {
            fatalError("Logic error")
        }

        lastObservedTracking = String(describing: model.cameraTracking)
        lastObservedPause = model.isPaused
        record("session-initial")

        tasks.append(Task<Void, Never> { [weak self] in
            for await tracking in model.cameraTrackingUpdates {
                guard !Task.isCancelled, let self, self.objectCaptureSession?.id == model.id else { return }
                let value = String(describing: tracking)
                guard value != self.lastObservedTracking else { continue }
                self.lastObservedTracking = value
                self.record("camera-tracking", detail: value)
            }
        })
        tasks.append(Task<Void, Never> { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(33))
                guard !Task.isCancelled, let self, self.objectCaptureSession?.id == model.id else { return }
                self.paceShot(model)
            }
        })
        tasks.append(Task<Void, Never> { [weak self] in
            for await shots in model.numberOfShotsTakenUpdates {
                guard !Task.isCancelled, let self, self.objectCaptureSession?.id == model.id else { return }
                self.noteShots(shots)
            }
        })
        tasks.append(Task<Void, Never> { [weak self] in
            for await paused in model.isPausedUpdates {
                guard !Task.isCancelled, let self, self.objectCaptureSession?.id == model.id else { return }
                guard paused != self.lastObservedPause else { continue }
                self.lastObservedPause = paused
                self.record("session-paused", detail: String(paused))
            }
        })

        tasks.append(
            Task<Void, Never> { [weak self] in
                for await newFeedback in model.feedbackUpdates {
                    logger.debug("Task got async feedback change to: \(String(describing: newFeedback))")
                    guard !Task.isCancelled, let self, self.objectCaptureSession?.id == model.id else { return }
                    self.updateFeedbackMessages(for: newFeedback)
                }
                logger.log("^^^ Got nil from stateUpdates iterator!  Ending observation task...")
            })

        tasks.append(Task<Void, Never> { [weak self] in
            for await newState in model.stateUpdates {
                logger.debug("Task got async state change to: \(String(describing: newState))")
                guard !Task.isCancelled, let self, self.objectCaptureSession?.id == model.id else { return }
                self.onStateChanged(newState: newState)
            }
            logger.log("^^^ Got nil from stateUpdates iterator!  Ending observation task...")
        })
        tasks.append(Task<Void, Never> { [weak self] in
            var watchdog = CaptureWatchdog()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self, !self.captureStopped,
                      self.objectCaptureSession?.id == model.id else { return }
                // Finishing writes the retained images; interrupting it would lose them.
                switch model.state {
                    case .finishing, .completed, .failed: return
                    default: break
                }
                // Background time must not consume foreground tracking/progress budgets.
                guard UIApplication.shared.applicationState == .active else {
                    watchdog = CaptureWatchdog()
                    continue
                }
                // Reviewing the point cloud pauses the session on purpose; the person ends it with Use scan or
                // Keep scanning, never the watchdog.
                guard !self.freeformFlow.isReviewing else {
                    watchdog = CaptureWatchdog()
                    continue
                }
                let reason = watchdog.observe(tracking: AppDataModel.watchdogTracking(model.cameraTracking),
                                              paused: model.isPaused,
                                              capturing: model.state == .capturing,
                                              shots: model.numberOfShotsTaken,
                                              thermalCritical: ProcessInfo.processInfo.thermalState == .critical,
                                              at: ProcessInfo.processInfo.systemUptime)
                if let reason {
                    self.stopCapture(reason: reason.detail, message: reason.message)
                    return
                }
            }
        })
    }

    private static func watchdogTracking(_ tracking: Tracking) -> CaptureWatchdog.Tracking {
        switch tracking {
            case .normal: return .normal
            case .notAvailable: return .notAvailable
            default: return .limited
        }
    }

    private func detachListeners() {
        logger.debug("Detaching listeners...")
        for task in tasks {
            task.cancel()
        }
        tasks.removeAll()
        motion.stopDeviceMotionUpdates()
        lastObservedTracking = nil
        lastObservedPause = nil
    }

    @objc
    private func handleAppTermination(notification: Notification) {
        logger.log("Notification for the app termination is received...")
        if state == .ready || state == .capturing {
            record("interrupted", detail: "App termination; capture retained")
        }
    }

    // Should be called when a new capture is to be created, before the session will be needed.
    private func startNewCapture() throws {
        logger.log("startNewCapture() called...")
        if !ObjectCaptureSession.isSupported {
            throw NSError(domain: "CaptureEvaluation", code: 1, userInfo: [NSLocalizedDescriptionKey: "Object Capture is unavailable on this device."])
        }

        // The last run's unwritten events go to its own folder before the folder changes.
        flushEvaluation()
        captureFolderManager = try CaptureFolderManager(captureDirectory: captureDirectory)
        evaluationBuffer = CaptureEvaluationEventBuffer()
        evaluationSession = nil
        evaluationStarted = Date()
        passCount = 1
        flipCount = 0
        freeformFlow = FreeformCaptureFlow()
        shotLookDowns = []
        pacer = FreeformCaptureFlow.ShotPacer()
        pacing = motion.isDeviceMotionAvailable
        objectCaptureSession = ObjectCaptureSession()
        // After the session is set (setting it detaches the last one's listeners and stops motion). Gravity-vertical
        // attitude for the shutter and each photo's height; device motion needs no permission (NSMotionUsageDescription
        // covers only CMSensorRecorder, CMPedometer, CMMotionActivityManager and CMMovementDisorderManager).
        if motion.isDeviceMotionAvailable {
            motion.deviceMotionUpdateInterval = 1.0 / 60
            motion.startDeviceMotionUpdates(using: .xArbitraryZVertical)
        }
        record("started", detail: "freeform")

        guard let session = objectCaptureSession else {
            preconditionFailure("startNewCapture() got unexpectedly nil session!")
        }

        guard let captureFolderManager else {
            preconditionFailure("captureFolderManager unexpectedly nil!")
        }

        // PRD §10 allows a success haptic when a result is ready and a warning on a plate alert, nothing else.
        session.shouldPlayHaptics = false
        // The app takes the photos (ShotPacer): "If disabled, only manually triggered shots are taken". Without a motion
        // sensor there is nothing to pace by, so Apple's auto-capture stays on.
        session.isAutoCaptureEnabled = !pacing
        var configuration = ObjectCaptureSession.Configuration()
        // Every image goes to the Mac: "meant for use when the images are intended to be transferred to macOS".
        configuration.isOverCaptureEnabled = true
        configuration.checkpointDirectory = captureFolderManager.checkpointFolder
        // Starts the initial segment and sets the output locations.
        session.start(imagesDirectory: captureFolderManager.imagesFolder,
                      configuration: configuration)

        if case let .failed(error) = session.state {
            if isEmbedded { objectCaptureSession = nil }
            logger.error("Got error starting session! \(String(describing: error))")
            switchToErrorState(error: error)
        } else {
            evaluationSession = ["isAutoCaptureEnabled": session.isAutoCaptureEnabled,
                                 "maximumNumberOfInputImages": session.maximumNumberOfInputImages]
            state = .capturing
        }
    }

    private func switchToErrorState(error inError: Swift.Error) {
        // Set the error first since the transitions will assume it is non-nil!
        record("failed", detail: String(describing: inError))
        error = inError
        state = .failed
    }

    // Moves from prepareToReconstruct to .reconstructing.
    // Should be called from the ReconstructionPrimaryView async task once it is on the screen.
    private func startReconstruction() throws {
        logger.debug("startReconstruction() called.")

        guard PhotogrammetrySession.isSupported else {
            throw NSError(domain: "CaptureEvaluation", code: 2, userInfo: [NSLocalizedDescriptionKey: "On-device reconstruction is unavailable; original images are retained in Files."])
        }
        record("reconstruction-started", detail: "iOS reduced; native scale unchanged")
        var configuration = PhotogrammetrySession.Configuration()

        guard let captureFolderManager else {
            preconditionFailure("captureFolderManager unexpectedly nil!")
        }

        configuration.checkpointDirectory = captureFolderManager.checkpointFolder
        photogrammetrySession = try PhotogrammetrySession(
            input: captureFolderManager.imagesFolder,
            configuration: configuration)

        state = .reconstructing
        beginReconstruction(outputFile: captureFolderManager.modelsFolder.appendingPathComponent("model-mobile.usdz"))
    }

    func cancelReconstruction() {
        guard let session = photogrammetrySession, !isStoppingReconstruction else { return }
        isStoppingReconstruction = true
        record("reconstruction-cancel-requested", detail: "Session retained until terminal output")
        session.cancel()
        reconstructionWaitTask = Task { [weak self, session] in
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            guard let self, self.photogrammetrySession === session, self.isStoppingReconstruction else { return }
            self.reconstructionStopWaitExceeded = true
            self.record("reconstruction-cancel-still-pending", detail: "No terminal output after 10 seconds; session retained")
        }
    }

    private func beginReconstruction(outputFile: URL) {
        guard let session = photogrammetrySession, reconstructionTask == nil else { return }
        reconstructionProgress = 0
        reconstructionFailure = nil
        stitchingIncomplete = false
        isStoppingReconstruction = false
        reconstructionStopWaitExceeded = false
        reconstructionTask = Task { [weak self, session] in
            guard let self else { return }
            do {
                try session.process(requests: [.modelFile(url: outputFile, detail: .reduced)])
            } catch {
                // process threw before accepting a request. No processing operation was started.
                self.finishReconstruction(session: session, outputFile: outputFile, failure: error)
                return
            }
            for await output in UntilProcessingCompleteFilter(input: session.outputs) {
                guard !Task.isCancelled, self.photogrammetrySession === session else { return }
                switch output {
                case .requestProgress(_, let fraction): self.reconstructionProgress = Float(fraction)
                case .requestProgressInfo(_, let info):
                    self.reconstructionRemainingTime = info.estimatedRemainingTime
                    self.reconstructionStage = info.processingStage?.processingStageString
                case .requestError(_, let error):
                    self.reconstructionFailure = error
                    self.record("reconstruction-request-error", detail: String(describing: error))
                case .processingComplete:
                    let missing = !FileManager.default.fileExists(atPath: outputFile.path)
                    let error = self.reconstructionFailure ?? (missing ? NSError(domain: "CaptureEvaluation", code: 3,
                        userInfo: [NSLocalizedDescriptionKey: "Reconstruction returned no model file."]) : nil)
                    self.finishReconstruction(session: session, outputFile: outputFile, failure: error)
                    return
                case .processingCancelled:
                    self.isStoppingReconstruction = true
                    self.finishReconstruction(session: session, outputFile: outputFile, failure: nil)
                    return
                case .stitchingIncomplete:
                    self.stitchingIncomplete = true
                    self.record("reconstruction-warning", detail: String(describing: output))
                case .invalidSample, .skippedSample, .automaticDownsampling:
                    self.record("reconstruction-warning", detail: String(describing: output))
                default: break
                }
            }
            // An unexpectedly ended stream is not a terminal output: keep ownership blocked.
            if self.photogrammetrySession === session {
                self.reconstructionStopWaitExceeded = true
                self.record("reconstruction-observation-ended", detail: "No terminal output; session retained")
            }
        }
    }

    private func finishReconstruction(session: PhotogrammetrySession, outputFile: URL, failure: Swift.Error?) {
        guard photogrammetrySession === session else { return }
        let stopped = isStoppingReconstruction
        reconstructionWaitTask?.cancel(); reconstructionWaitTask = nil
        reconstructionTask = nil
        photogrammetrySession = nil
        isStoppingReconstruction = false
        reconstructionStopWaitExceeded = false
        UIApplication.shared.isIdleTimerDisabled = false
        if stopped {
            record("reconstruction-cancel-terminal", detail: "Original files retained")
            if isEmbedded { state = .notSet; finishEmbedded() } else { state = .restart }
        } else if let failure {
            reconstructionFailure = failure
            switchToErrorState(error: failure)
        } else {
            record("reconstruction-complete", detail: "Models/model-mobile.usdz; accuracy unverified")
            state = .viewing
            finishEmbedded(output: outputFile)
        }
    }

    private func reset() {
        logger.info("reset() called...")
        photogrammetrySession = nil
        objectCaptureSession = nil
        flushEvaluation()
        captureFolderManager = nil
        showOverlaySheets = false
        orbit = .orbit1
        isObjectFlipped = false
        currentFeedback = []
        messageList.removeAll()
        state = .ready
        isSaveDraftEnabled = false
        tutorialPlayedOnce = false
    }

    private func onStateChanged(newState: ObjectCaptureSession.CaptureState) {
        guard !captureStopped else { return }
        record("capture-state", detail: String(describing: newState))
        logger.info("OCViewModel switched to state: \(String(describing: newState))")
        if case .completed = newState {
            logger.log("ObjectCaptureSession moved in .completed state.")
            if isSaveDraftEnabled {
                logger.log("The data is stored. Closing the session...")
                if isEmbedded {
                    objectCaptureSession = nil
                    state = .completed
                    finishEmbedded()
                } else { reset() }
            } else {
                logger.log("Switch app model to reconstruction...")
                state = .prepareToReconstruct
            }
        } else if case let .failed(error) = newState {
            logger.error("OCS moved to error state \(String(describing: error))...")
            if isEmbedded {
                objectCaptureSession = nil
                switchToErrorState(error: error)
                finishEmbedded(error: error.localizedDescription)
            } else if case ObjectCaptureSession.Error.cancelled = error {
                state = .restart
            } else {
                switchToErrorState(error: error)
            }
        }
    }

    private func updateFeedbackMessages(for feedback: Set<Feedback>) {
        record("feedback", detail: feedback.map { String(describing: $0) }.sorted().joined(separator: ", "))
        // Compare the incoming feedback with the previous feedback to find the intersection.
        let persistentFeedback = currentFeedback.intersection(feedback)

        // Find the feedbacks that are not active anymore.
        let feedbackToRemove = currentFeedback.subtracting(persistentFeedback)
        for thisFeedback in feedbackToRemove {
            if let feedbackString = FeedbackMessages.getFeedbackString(for: thisFeedback) {
                messageList.remove(feedbackString)
            }
        }

        // Find the new feedbacks.
        let feebackToAdd = feedback.subtracting(persistentFeedback)
        for thisFeedback in feebackToAdd {
            if let feedbackString = FeedbackMessages.getFeedbackString(for: thisFeedback) {
                messageList.add(feedbackString)
            }
        }

        currentFeedback = feedback
    }

    private func performStateTransition(from fromState: ModelState, to toState: ModelState) {
        if captureStopped, toState != .notSet {
            state = .notSet
            return
        }
        if fromState == toState { return }
        if fromState == .failed { error = nil }

        switch toState {
            case .ready:
                do {
                    try startNewCapture()
                } catch {
                    switchToErrorState(error: error)
                }
            case .prepareToReconstruct:
                // Clean up the session to free GPU and memory resources.
                objectCaptureSession = nil
                do {
                    try startReconstruction()
                } catch {
                    logger.error("Reconstructing failed!")
                    switchToErrorState(error: error)
                }
            case .restart, .completed:
                if isEmbedded { stopEmbeddedCapture() } else { reset() }
            case .viewing:
                photogrammetrySession = nil

                if !isEmbedded { removeCheckpointFolder() }
            case .failed:
                logger.error("App failed state error=\(String(describing: self.error!))")
                if isEmbedded, objectCaptureSession == nil, photogrammetrySession == nil {
                    finishEmbedded(error: error?.localizedDescription)
                }
            default:
                break
        }
    }

    private func removeCheckpointFolder() {
        // Remove checkpoint folder to free up space now that the model is generated.
        if let checkpoint = captureFolderManager?.checkpointFolder {
            DispatchQueue.global(qos: .background).async {
                try? FileManager.default.removeItem(at: checkpoint)
            }
        }
    }
}

// Evaluation metadata never promotes capture coverage into mechanical-fit evidence.
extension AppDataModel {
    /// evaluation.json is written at most this often while events stream in (feedback changes many times a second).
    static let evaluationWriteInterval: TimeInterval = 2

    /// Events written at once: a run that ends, fails, stops or changes state must be on disk even if the app dies next.
    static func isDurableEvaluationEvent(_ event: String, detail: String) -> Bool {
        event.hasPrefix("reconstruction") || event.contains("failed")
            || ["started", "interrupted", "cancel-requested", "cancel-terminal", "cancel-still-pending", "capture-state",
                "new-pass", "auto-capture-fallback"].contains(event)
            || (event == "freeform" && detail == String(describing: FreeformCaptureFlow.SessionCall.finish))
    }

    /// Adds the event and builds the report as it stands now. The file is written at once for a durable event or when
    /// the last write is 2 s old; otherwise one write is scheduled for when it is, so a killed run loses at most ~2 s.
    func record(_ event: String, detail: String = "") {
        guard let folder = captureFolderManager?.captureFolder else { return }
        var entry: [String: Any] = [
            "event": String(event.prefix(64)), "detail": String(detail.prefix(512)),
            "detailTruncated": detail.count > 512,
            "elapsedSeconds": Date().timeIntervalSince(evaluationStarted),
            "modelState": String(describing: state), "sessionAvailable": objectCaptureSession != nil,
            "shots": objectCaptureSession?.numberOfShotsTaken ?? 0,
            "completedCurrentPass": objectCaptureSession?.userCompletedScanPass ?? false
        ]
        if let session = objectCaptureSession {
            entry["captureState"] = String(String(describing: session.state).prefix(512))
            entry["cameraTracking"] = String(String(describing: session.cameraTracking).prefix(512))
            entry["isPaused"] = session.isPaused
            entry["feedback"] = session.feedback.map { String(String(describing: $0).prefix(512)) }
                .sorted().prefix(32).map { $0 }
        }
        evaluationBuffer.append(entry)
        var manifest: [String: Any] = [
            "formatVersion": "0.1", "createdAt": ISO8601DateFormatter().string(from: evaluationStarted),
            "captureMode": "freeform",
            "hideObjectReticle": true,
            "shotsLow": captureCoverage.low, "shotsFromAbove": captureCoverage.high,
            "objectCaptureSupported": ObjectCaptureSession.isSupported,
            "photogrammetrySupported": PhotogrammetrySession.isSupported,
            "sceneDepthSupported": ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth),
            "deviceModel": UIDevice.current.model, "hardwareIdentifier": Self.hardwareIdentifier, "os": UIDevice.current.systemVersion,
            "shotsObserved": evaluationBuffer.events.compactMap { $0["shots"] as? Int }.max() ?? 0,
            "reconstructionHost": "iOS", "reconstructionDetail": "reduced",
            "scaleMethod": "native-unrescaled", "metricAccuracy": "unverified",
            "depthMetadataAudit": "pending-independent-import", "missingOrGuessedRegions": "unassessed",
            "completeObjectVerified": false, "physicalFitVerified": false,
            "passCount": passCount, "flipCount": flipCount, "images": "Images", "models": "Models",
            "events": evaluationBuffer.events,
            "diagnosticHistory": ["maximumEvents": CaptureEvaluationEventBuffer.maximumEvents,
                                  "maximumEventBytes": CaptureEvaluationEventBuffer.maximumBytes,
                                  "droppedEvents": evaluationBuffer.droppedEvents,
                                  "initialObservationRetained": evaluationBuffer.events.first?["event"] as? String == "session-initial"]
        ]
        if let evaluationSession { manifest["session"] = evaluationSession }
        evaluationPending = (folder, manifest)
        let now = ProcessInfo.processInfo.systemUptime
        if Self.isDurableEvaluationEvent(event, detail: detail) || now - evaluationLastWrite >= Self.evaluationWriteInterval {
            flushEvaluation()
        } else if evaluationFlushTask == nil {
            let delay = Self.evaluationWriteInterval - (now - evaluationLastWrite)
            evaluationFlushTask = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                self?.flushEvaluation()
            }
        }
    }

    /// Writes the pending evaluation.json, if any, to the folder of the run it describes.
    func flushEvaluation() {
        evaluationFlushTask?.cancel()
        evaluationFlushTask = nil
        guard let (folder, manifest) = evaluationPending else { return }
        evaluationPending = nil
        evaluationLastWrite = ProcessInfo.processInfo.systemUptime
        do {
            let bytes = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
            guard bytes.count <= 128 * 1024 else {
                throw NSError(domain: "CaptureEvaluation", code: 3,
                              userInfo: [NSLocalizedDescriptionKey: "Evaluation metadata exceeded its byte limit."])
            }
            try bytes.write(to: folder.appendingPathComponent("evaluation.json"), options: .atomic)
            evaluationWriteError = nil
        } catch { evaluationWriteError = "Evaluation report could not be saved. Original images may still be available in Files." }
    }
    private static var hardwareIdentifier: String {
        var size = 0
        guard sysctlbyname("hw.machine", nil, &size, nil, 0) == 0, size > 0 else { return "unknown" }
        var value = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.machine", &value, &size, nil, 0) == 0 else { return "unknown" }
        return String(cString: value)
    }
    func recordPass(flipped: Bool) {
        passCount += 1
        if flipped { flipCount += 1 }
        record("new-pass", detail: flipped ? "beginNewScanPassAfterFlip" : "beginNewScanPass")
    }
}

// The quick scan's buttons. Each asks the flow which session call to make, so the steps stay in one tested place.
extension AppDataModel {
    func freeformRecord() {
        guard let session = objectCaptureSession, case .ready = session.state,
              let call = freeformFlow.record(sessionReady: true, trackingNormal: session.cameraTracking == .normal)
        else { return }
        perform(call, on: session)
    }

    func freeformDone() {
        guard let session = objectCaptureSession,
              let call = freeformFlow.done(coverage: captureCoverage,
                                           trackingNormal: session.cameraTracking == .normal && !session.isPaused)
        else { return }
        perform(call, on: session)
    }

    func freeformKeepScanning() {
        guard let session = objectCaptureSession, let call = freeformFlow.keepScanning() else { return }
        perform(call, on: session)
    }

    func freeformUseScan() {
        guard let session = objectCaptureSession, let call = freeformFlow.useScan() else { return }
        perform(call, on: session)
    }

    /// Stop from the review sheet: the same stop as the capture screen's, files kept.
    func freeformStop() {
        guard freeformFlow.stop() else { return }
        stopCapture()
    }

    /// The app's shutter, checked 30 times a second while capturing: Apple's `requestImageCapture()` ("request an image
    /// be manually captured at the current location") each time the view has turned 5° since the last photo, at most 3 a
    /// second, only while Apple can take one (`canRequestImageCapture`), tracking is normal, the session isn't paused,
    /// and Apple isn't saying `movingTooFast` ("the capturing may be paused to ensure quality").
    fileprivate func paceShot(_ session: ObjectCaptureSession) {
        guard pacing, freeformFlow.step == .capturing, case .capturing = session.state, !session.isPaused,
              session.cameraTracking == .normal, session.canRequestImageCapture,
              !session.feedback.contains(.movingTooFast), let reading = motion.deviceMotion else { return }
        let m = reading.attitude.rotationMatrix
        let direction = FreeformCaptureFlow.ShotPacer.cameraDirection(
            rotation: [m.m11, m.m12, m.m13, m.m21, m.m22, m.m23, m.m31, m.m32, m.m33],
            gravity: .init(x: reading.gravity.x, y: reading.gravity.y, z: reading.gravity.z))
        let now = ProcessInfo.processInfo.systemUptime
        // Apple isn't taking the photos asked for: give the shutter back to its auto-capture rather than end with none.
        if pacer.needsAutoCapture(at: now) {
            session.isAutoCaptureEnabled = true
            pacing = false
            record("auto-capture-fallback", detail: "\(pacer.unanswered) requests unanswered")
            return
        }
        guard pacer.isDue(direction, at: now) else { return }
        pacer.requested(direction, at: now)
        session.requestImageCapture()
    }

    /// Notes how far the camera looks down for each new photo. The count can jump by more than one between updates;
    /// each new photo gets the latest reading.
    fileprivate func noteShots(_ count: Int) {
        guard count > shotLookDowns.count else { return }
        pacer.shotTaken(at: ProcessInfo.processInfo.systemUptime)
        let lookDown = motion.deviceMotion.map {
            FreeformCaptureFlow.lookDownDegrees(gravityX: $0.gravity.x, y: $0.gravity.y, z: $0.gravity.z)
        }
        guard let lookDown else { return }
        shotLookDowns += Array(repeating: lookDown, count: count - shotLookDowns.count)
    }

    private func perform(_ call: FreeformCaptureFlow.SessionCall, on session: ObjectCaptureSession) {
        record("freeform", detail: String(describing: call))
        switch call {
        case .startCapturing:
            session.startCapturing()
            // Again once capturing, in case starting it reset the shutter: the app paces the photos.
            if pacing { session.isAutoCaptureEnabled = false }
        case .pause:
            // The review sheet covers the capture view: "Call this when object capture view is not visible".
            setShowOverlaySheets(to: true)
        case .resume:
            setShowOverlaySheets(to: false)
        case .finish:
            // As Apple's sample does from its paused review sheet; the session saves every image, then completes.
            session.finish()
        }
    }
}
