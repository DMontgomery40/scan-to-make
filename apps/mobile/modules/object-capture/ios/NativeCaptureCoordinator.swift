import Foundation
import Observation

enum NativeCaptureOutcome { case completed, stopped, failed(String) }
@MainActor protocol NativeCaptureEngine: AnyObject {
    var onFinish: ((NativeCaptureOutcome) -> Void)? { get set }
    func start()
    func stop()
}

/// Owned independently of React and presentation. Only a terminal engine callback detaches it.
@MainActor @Observable final class NativeCaptureRunOwner {
    let store: NativeCaptureDraftStore
    private let makeEngine: (URL) throws -> NativeCaptureEngine
    private(set) var activeRunID: String?
    private(set) var engine: NativeCaptureEngine?
    private(set) var stopping = false
    private(set) var message: String?
    init(store: NativeCaptureDraftStore, makeEngine: @escaping (URL) throws -> NativeCaptureEngine) {
        self.store = store; self.makeEngine = makeEngine
    }
    @discardableResult func start(origin: NativeCaptureDestination) throws -> NativeCaptureDraft {
        guard engine == nil else { throw NSError(domain: "NativeCapture", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Another capture is still active or stopping. Your files are kept."]) }
        let draft = try store.create(origin: origin)
        do {
            let next = try makeEngine(store.directory(draft.runID))
            activeRunID = draft.runID; engine = next; stopping = false; message = nil
            next.onFinish = { [weak self] outcome in self?.finish(draft.runID, outcome: outcome) }
            next.start()
        } catch {
            try? store.update(draft.runID, status: "failed", message: error.localizedDescription)
            throw error
        }
        return draft
    }
    func stop() {
        guard let engine, let id = activeRunID, !stopping else { return }
        stopping = true
        do { try store.update(id, status: "stopping") } catch { message = error.localizedDescription }
        engine.stop()
    }
    private func finish(_ id: String, outcome: NativeCaptureOutcome) {
        guard id == activeRunID, engine != nil else { return }
        do {
            switch outcome {
            case .completed where !stopping: _ = try store.complete(id)
            case .completed, .stopped: try store.update(id, status: "stopped")
            case .failed(let detail):
                message = detail
                try store.update(id, status: "failed", message: detail)
            }
        } catch { message = error.localizedDescription }
        // The callback is a terminal observation, not evidence of physical camera release.
        engine = nil; activeRunID = nil; stopping = false
    }
}

#if canImport(UIKit)
import UIKit
import SwiftUI
import RealityKit
import ARKit

@MainActor final class GuidedNativeCaptureEngine: NativeCaptureEngine {
    let model: AppDataModel
    var onFinish: ((NativeCaptureOutcome) -> Void)?
    init(directory: URL) {
        model = AppDataModel(captureDirectory: directory)
        model.onEmbeddedCompletion = { [weak self] output, error in
            self?.onFinish?(output != nil ? .completed : error.map(NativeCaptureOutcome.failed) ?? .stopped)
        }
    }
    func start() { model.beginCapture() }
    func stop() { model.stopEmbeddedCapture() }
}

/// The walk-around Object Capture scan's entry and exit for the app: start a scan for a project, show it
/// full screen, and return its saved draft when it closes. The capture module itself is Apple's sample,
/// unchanged; drafts and their files are kept on this device until they're sent.
@MainActor public final class NativeCaptureCoordinator {
    static let owner = NativeCaptureRunOwner(store: NativeCaptureDraftStore()) { GuidedNativeCaptureEngine(directory: $0) }
    public static let shared = NativeCaptureCoordinator()
    private var host: UIViewController?
    private var completion: CheckedContinuation<[String: Any], Error>?
    private var presentedRunID: String?

    /// Whether this device can scan: Object Capture and a LiDAR Scanner (scene depth).
    public static func status() -> [String: Any] {
        ["supported": ObjectCaptureSession.isSupported && PhotogrammetrySession.isSupported,
         "lidar": ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth),
         "activeRunID": owner.activeRunID as Any? ?? NSNull()]
    }

    public func drafts() throws -> [[String: Any]] {
        try Self.owner.store.list(activeRunID: Self.owner.activeRunID).map { try $0.dictionary() }
    }

    /// Starts a scan for `origin` and shows it. Returns the draft when the scan screen closes.
    public func start(_ origin: NativeCaptureDestination) async throws -> [String: Any] {
        guard ObjectCaptureSession.isSupported && PhotogrammetrySession.isSupported else {
            throw NSError(domain: "NativeCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Scanning needs an iPhone or iPad with LiDAR."])
        }
        guard host == nil, let presenter = Self.topViewController(), presenter.presentedViewController == nil else {
            throw NSError(domain: "NativeCapture", code: 3, userInfo: [NSLocalizedDescriptionKey: "Close the current sheet first."])
        }
        let draft = try Self.owner.start(origin: origin)
        guard let engine = Self.owner.engine as? GuidedNativeCaptureEngine else {
            // Synchronous startup failure was retained by the owner.
            return try Self.owner.store.read(draft.runID).dictionary()
        }
        return try await withCheckedThrowingContinuation { continuation in
            completion = continuation; presentedRunID = draft.runID
            let controller = UIHostingController(rootView: NativeCaptureHostView(owner: Self.owner, model: engine.model) { [weak self] add in self?.close(add: add) })
            controller.modalPresentationStyle = .fullScreen; controller.isModalInPresentation = true
            host = controller; presenter.present(controller, animated: true)
        }
    }

    private func close(add: Bool) {
        guard let id = presentedRunID else { return }
        Self.owner.stop()
        let continuation = completion
        completion = nil; presentedRunID = nil
        let controller = host; host = nil
        controller?.dismiss(animated: true) {
            do { var result = try Self.owner.store.read(id).dictionary(); result["addRequested"] = add; continuation?.resume(returning: result) }
            catch { continuation?.resume(throwing: error) }
        }
    }

    public func stop() { Self.owner.stop() }

    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        var top = scenes.flatMap(\.windows).first { $0.isKeyWindow }?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}
#endif
