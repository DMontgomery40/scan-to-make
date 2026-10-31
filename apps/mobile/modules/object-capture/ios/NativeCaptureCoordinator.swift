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
            case .failed(let detail): try store.update(id, status: "failed", message: detail)
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
import React

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

@MainActor @objc(NativeCaptureCoordinator)
final class NativeCaptureCoordinator: NSObject {
    // A bridge reload destroys its module, never the active session owner.
    static let owner = NativeCaptureRunOwner(store: NativeCaptureDraftStore()) { GuidedNativeCaptureEngine(directory: $0) }
    private var host: UIViewController?
    private var completion: RCTPromiseResolveBlock?
    private var rejection: RCTPromiseRejectBlock?
    private var presentedRunID: String?
    @objc nonisolated static func requiresMainQueueSetup() -> Bool { true }
    @objc nonisolated func methodQueue() -> DispatchQueue { .main }
    @objc func status(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        // Scene depth is only available with a LiDAR scanner; it lets the app say why scanning is off.
        resolve(["supported": ObjectCaptureSession.isSupported && PhotogrammetrySession.isSupported,
                 "lidar": ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth),
                 "activeRunID": Self.owner.activeRunID as Any? ?? NSNull()])
    }
    @objc func drafts(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
        do { resolve(try Self.owner.store.list(activeRunID: Self.owner.activeRunID).map { try $0.dictionary() }) }
        catch { reject("storage-error", error.localizedDescription, error) }
    }
    @objc func start(_ options: NSDictionary, resolve: @escaping RCTPromiseResolveBlock,
                     reject: @escaping RCTPromiseRejectBlock) {
        guard ObjectCaptureSession.isSupported && PhotogrammetrySession.isSupported else {
            reject("unsupported", "Scanning is unavailable on this device. Choose a USDZ file instead.", nil); return
        }
        guard host == nil, let presenter = RCTPresentedViewController(), presenter.presentedViewController == nil else {
            reject("busy", "Close the current sheet first.", nil); return
        }
        do {
            let origin = try JSONDecoder().decode(NativeCaptureDestination.self,
                from: JSONSerialization.data(withJSONObject: options))
            let draft = try Self.owner.start(origin: origin)
            guard let engine = Self.owner.engine as? GuidedNativeCaptureEngine else {
                // Synchronous startup failure was retained by the owner.
                resolve(try Self.owner.store.read(draft.runID).dictionary()); return
            }
            completion = resolve; rejection = reject; presentedRunID = draft.runID
            let controller = UIHostingController(rootView: NativeCaptureHostView(owner: Self.owner, model: engine.model) { [weak self] add in self?.close(add: add) })
            controller.modalPresentationStyle = .fullScreen; controller.isModalInPresentation = true
            host = controller; presenter.present(controller, animated: true)
        } catch { reject("capture-error", error.localizedDescription, error) }
    }
    private func close(add: Bool) {
        guard let id = presentedRunID else { return }
        Self.owner.stop()
        let resolve = completion; let reject = rejection
        completion = nil; rejection = nil; presentedRunID = nil
        let controller = host; host = nil
        controller?.dismiss(animated: true) {
            do { var result = try Self.owner.store.read(id).dictionary(); result["addRequested"] = add; resolve?(result) }
            catch { reject?("storage-error", error.localizedDescription, error) }
        }
    }
    @objc func stop(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) { Self.owner.stop(); resolve(nil) }
    @objc nonisolated func invalidate() {
        Task { @MainActor [self] in
            // Invalidation is an interruption; no implicit restart when the bridge comes back.
            if let id = presentedRunID, Self.owner.activeRunID == id { Self.owner.stop() }
            completion = nil; rejection = nil; presentedRunID = nil
            host?.dismiss(animated: false); host = nil
        }
    }
}
#endif
