/*
See the LICENSE.txt file for this sample’s licensing information.

Abstract:
A data model for maintaining the app state, including the underlying object capture state as well as any extra app state
 you maintain in addition, perhaps with invariants between them.
*/

import RealityKit
import Darwin
import ARKit
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

    static let minNumImages = 10

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

    enum CaptureMode: Equatable {
        case object
        case area
    }

    var captureMode: CaptureMode = .object { didSet { record("capture-mode", detail: String(describing: captureMode)) } }
    private var evaluationBuffer = CaptureEvaluationEventBuffer()
    private var lastObservedTracking: String?
    private var lastObservedPause: Bool?
    var evaluationStarted = Date()
    private(set) var captureStopped = false
    private(set) var stopMessage: String?
    var evaluationWriteError: String?

    enum CameraRelease: Equatable {
        case notRequested
        case pending
        case confirmed
        case unconfirmed
    }

    static let cancellationConfirmationLimit: TimeInterval = 5

    // Held until the session reports a terminal state so teardown finishes before it is released.
    private(set) var cameraRelease: CameraRelease = .notRequested
    private var cancellingSession: ObjectCaptureSession?
    private var cancellationTasks: [Task<Void, Never>] = []
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
    private init() {
        NotificationCenter.default.addObserver(self,
                                               selector: #selector(handleAppTermination(notification:)),
                                               name: UIApplication.willTerminateNotification,
                                               object: nil)
    }

    isolated deinit {
        NotificationCenter.default.removeObserver(self)
        for task in tasks { task.cancel() }
        for task in cancellationTasks { task.cancel() }
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
        guard objectCaptureSession == nil, photogrammetrySession == nil, cameraRelease != .pending else { return }
        captureStopped = false
        stopMessage = nil
        cameraRelease = .notRequested
        reset()
    }

    func stopCapture(reason: String = "Stopped by user", message: String? = nil) {
        guard !captureStopped, let session = objectCaptureSession else { return }
        captureStopped = true
        stopMessage = message
        record("interrupted", detail: reason + "; original files retained")
        detachListeners()
        awaitCancellation(of: session)
        session.cancel()
        record("cancel-requested", detail: "Public cancellation requested; awaiting session confirmation")
        objectCaptureSession = nil
        showOverlaySheets = false
        UIApplication.shared.isIdleTimerDisabled = false
        state = .notSet
    }

    private func awaitCancellation(of session: ObjectCaptureSession) {
        cancellingSession = session
        cameraRelease = .pending
        cancellationTasks = [
            Task<Void, Never> { [weak self] in
                var terminal = AppDataModel.isTerminal(session.state)
                if !terminal {
                    for await newState in session.stateUpdates where AppDataModel.isTerminal(newState) {
                        terminal = true
                        break
                    }
                }
                guard terminal, !Task.isCancelled else { return }
                self?.finishCancellation(of: session, confirmed: true)
            },
            Task<Void, Never> { [weak self] in
                try? await Task.sleep(for: .seconds(AppDataModel.cancellationConfirmationLimit))
                guard !Task.isCancelled else { return }
                self?.finishCancellation(of: session, confirmed: false)
            }
        ]
    }

    private func finishCancellation(of session: ObjectCaptureSession, confirmed: Bool) {
        guard let cancellingSession, cancellingSession.id == session.id else { return }
        for task in cancellationTasks { task.cancel() }
        cancellationTasks.removeAll()
        cameraRelease = confirmed ? .confirmed : .unconfirmed
        if confirmed {
            record("cancel-confirmed", detail: "Session reported \(String(describing: session.state))")
        } else {
            record("cancel-unconfirmed",
                   detail: "No terminal session state within \(Int(Self.cancellationConfirmationLimit))s")
        }
        self.cancellingSession = nil
    }

    private static func isTerminal(_ state: ObjectCaptureSession.CaptureState) -> Bool {
        switch state {
            case .completed, .failed: return true
            default: return false
        }
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
                let reason = watchdog.observe(tracking: AppDataModel.watchdogTracking(model.cameraTracking),
                                              paused: model.isPaused,
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

        captureFolderManager = try CaptureFolderManager()
        evaluationBuffer = CaptureEvaluationEventBuffer()
        evaluationStarted = Date()
        passCount = 1
        flipCount = 0
        objectCaptureSession = ObjectCaptureSession()
        record("started")

        guard let session = objectCaptureSession else {
            preconditionFailure("startNewCapture() got unexpectedly nil session!")
        }

        guard let captureFolderManager else {
            preconditionFailure("captureFolderManager unexpectedly nil!")
        }

        var configuration = ObjectCaptureSession.Configuration()
        configuration.isOverCaptureEnabled = true
        configuration.checkpointDirectory = captureFolderManager.checkpointFolder
        // Starts the initial segment and sets the output locations.
        session.start(imagesDirectory: captureFolderManager.imagesFolder,
                      configuration: configuration)

        if case let .failed(error) = session.state {
            logger.error("Got error starting session! \(String(describing: error))")
            switchToErrorState(error: error)
        } else {
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
        if captureMode == .area {
            configuration.isObjectMaskingEnabled = false
        }

        guard let captureFolderManager else {
            preconditionFailure("captureFolderManager unexpectedly nil!")
        }

        configuration.checkpointDirectory = captureFolderManager.checkpointFolder
        photogrammetrySession = try PhotogrammetrySession(
            input: captureFolderManager.imagesFolder,
            configuration: configuration)

        state = .reconstructing
    }

    private func reset() {
        logger.info("reset() called...")
        photogrammetrySession = nil
        objectCaptureSession = nil
        captureFolderManager = nil
        showOverlaySheets = false
        orbit = .orbit1
        isObjectFlipped = false
        currentFeedback = []
        messageList.removeAll()
        captureMode = .object
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
                reset()
            } else {
                logger.log("Switch app model to reconstruction...")
                state = .prepareToReconstruct
            }
        } else if case let .failed(error) = newState {
            logger.error("OCS moved to error state \(String(describing: error))...")
            if case ObjectCaptureSession.Error.cancelled = error {
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
            if let feedbackString = FeedbackMessages.getFeedbackString(for: thisFeedback, captureMode: captureMode) {
                messageList.remove(feedbackString)
            }
        }

        // Find the new feedbacks.
        let feebackToAdd = feedback.subtracting(persistentFeedback)
        for thisFeedback in feebackToAdd {
            if let feedbackString = FeedbackMessages.getFeedbackString(for: thisFeedback, captureMode: captureMode) {
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
                reset()
            case .viewing:
                photogrammetrySession = nil

                removeCheckpointFolder()
            case .failed:
                logger.error("App failed state error=\(String(describing: self.error!))")
                // We will show error screen here
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

    func determineCurrentOnboardingState() -> OnboardingState? {
        guard let session = objectCaptureSession else { return nil }

        switch captureMode {
            case .object:
                let orbitCompleted = session.userCompletedScanPass
                var currentState = OnboardingState.tooFewImages
                if session.numberOfShotsTaken >= AppDataModel.minNumImages {
                    switch orbit {
                        case .orbit1:
                            currentState = orbitCompleted ? .firstSegmentComplete : .firstSegmentNeedsWork
                        case .orbit2:
                            currentState = orbitCompleted ? .secondSegmentComplete : .secondSegmentNeedsWork
                        case .orbit3:
                            currentState = orbitCompleted ? .thirdSegmentComplete : .thirdSegmentNeedsWork
                        }
                }
                return currentState
            case .area:
                return .captureInAreaMode
        }
    }
}

// Evaluation metadata never promotes capture coverage into mechanical-fit evidence.
extension AppDataModel {
    func record(_ event: String, detail: String = "") {
        guard let folder = captureFolderManager?.captureFolder else { return }
        var entry: [String: Any] = [
            "event": String(event.prefix(64)), "detail": String(detail.prefix(512)),
            "detailTruncated": detail.count > 512,
            "elapsedSeconds": Date().timeIntervalSince(evaluationStarted),
            "modelState": String(describing: state), "sessionAvailable": objectCaptureSession != nil,
            "thermalState": Self.thermalStateName, "cameraRelease": String(describing: cameraRelease),
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
        let manifest: [String: Any] = [
            "formatVersion": "0.1", "createdAt": ISO8601DateFormatter().string(from: evaluationStarted),
            "captureMode": String(describing: captureMode), "hideObjectReticle": captureMode == .area,
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
    private static var thermalStateName: String {
        switch ProcessInfo.processInfo.thermalState {
            case .nominal: return "nominal"
            case .fair: return "fair"
            case .serious: return "serious"
            case .critical: return "critical"
            @unknown default: return "unknown"
        }
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
