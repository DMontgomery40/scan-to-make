import ARKit
import Foundation
import UIKit
import SceneKit

/// Owns the one session used by the visible preview and workload counters.
/// All state is serialized on the main queue; no ARFrame is retained.
@objc(ScanCaptureSession)
public final class ScanCaptureSession: NSObject, ARSessionDelegate {
  @objc public static let shared = ScanCaptureSession()
  @objc public var onSample: (([String: Any]) -> Void)?
  @objc public var onError: ((String) -> Void)?

  @objc public static var isSupported: Bool {
    ARWorldTrackingConfiguration.isSupported
  }

  // Session delegate callbacks and the sample timer share this serial queue,
  // so the counters below are never touched concurrently.
  private let queue = DispatchQueue.main
  private var session: ARSession?
  private weak var preview: ScanCapturePreview?
  private var runId = ""
  private var probeMessage = "Center a mapped surface, then tap the preview to place the probe."
  private var probe: ARAnchor?
  private var placedAt: TimeInterval = 0
  private var renderedFrames = 0
  private var renderedProbeFrames = 0
  private var depthFrames = 0
  private var previewContinuous = true
  private var trackingContinuous = true
  private var meshIds = Set<UUID>()
  private var lastRenderedTimestamp: TimeInterval = -1

  func attach(_ view: ScanCapturePreview) {
    if let preview, preview !== view { stopOnQueue() }
    preview = view
    if let session { view.session = session }
  }
  func detach(_ view: ScanCapturePreview) {
    guard preview === view else { return }
    if session != nil { onError?("Capture preview was removed.") }
    stopOnQueue()
    preview = nil
  }
  func placeProbe(in view: ScanCapturePreview) {
    guard let session, preview === view, view.isActuallyVisible, probe == nil,
      let frame = session.currentFrame, case .normal = frame.camera.trackingState else { return }
    let center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
    guard let query = view.raycastQuery(from: center, allowing: .existingPlaneGeometry, alignment: .any),
      let hit = session.raycast(query).first else {
      probeMessage = "No detected surface at the center. Move slowly to map a surface, then tap again."
      return
    }
    let anchor = ARAnchor(name: "stability-probe", transform: hit.worldTransform)
    probe = anchor
    probeMessage = "Probe placed. Keep it visible throughout the scored run."
    session.add(anchor: anchor)
    placedAt = ProcessInfo.processInfo.systemUptime
    windowStartedAt = placedAt
    framesInWindow = 0; renderedFrames = 0; renderedProbeFrames = 0; depthFrames = 0
  }
  func didRender(_ view: ScanCapturePreview, session renderedSession: ARSession, timestamp: TimeInterval) {
    guard session === renderedSession, preview === view, view.isActuallyVisible,
      timestamp != lastRenderedTimestamp else { return }
    lastRenderedTimestamp = timestamp
    renderedFrames += 1
    if let probe, let node = view.node(for: probe), node.geometry != nil,
      let camera = view.pointOfView, view.isNode(node, insideFrustumOf: camera) {
      renderedProbeFrames += 1
    }
  }
  public func sessionWasInterrupted(_ session: ARSession) {
    guard self.session === session else { return }
    onError?("AR session was interrupted. Start a new run.")
    stopOnQueue()
  }
  public func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
    guard self.session === session else { return }
    for anchor in anchors where anchor is ARMeshAnchor { meshIds.insert(anchor.identifier) }
  }
  public func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
    guard self.session === session else { return }
    for anchor in anchors { meshIds.remove(anchor.identifier) }
  }
  private func matrix(_ value: simd_float4x4) -> [Double] {
    (0..<4).flatMap { column in (0..<4).map { Double(value[column][$0]) } }
  }
  private var timer: DispatchSourceTimer?
  private var startedAt: TimeInterval = 0
  private var windowStartedAt: TimeInterval = 0
  private var framesInWindow = 0
  private var tracking = "notAvailable"

  @objc(startWithSampleIntervalMs:completion:)
  public func start(
    sampleIntervalMs: Double,
    completion: @escaping ([String: Any]?, String?) -> Void
  ) {
    guard Self.isSupported else {
      completion(nil, "ARKit world tracking is not supported on this device.")
      return
    }
    queue.async { [self] in
      stopOnQueue()
      guard let preview, preview.isActuallyVisible else {
        completion(nil, "The visible capture preview must be on screen before starting.")
        return
      }

      let configuration = ARWorldTrackingConfiguration()
      configuration.planeDetection = [.horizontal, .vertical]
      var depthEnabled = false
      var meshEnabled = false
      if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
        configuration.frameSemantics.insert(.sceneDepth)
        depthEnabled = true
      }
      if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
        configuration.sceneReconstruction = .mesh
        meshEnabled = true
      }

      let session = ARSession()
      session.delegate = self
      session.delegateQueue = queue
      self.session = session
      preview.session = session
      runId = UUID().uuidString

      let now = ProcessInfo.processInfo.systemUptime
      startedAt = now
      windowStartedAt = now
      framesInWindow = 0
      tracking = "notAvailable"
      session.run(configuration, options: [.resetTracking, .removeExistingAnchors])

      let intervalMs = Int(max(100, sampleIntervalMs))
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(
        deadline: .now() + .milliseconds(intervalMs),
        repeating: .milliseconds(intervalMs),
        leeway: .milliseconds(5)
      )
      timer.setEventHandler { [weak self] in self?.emitWindow() }
      timer.resume()
      self.timer = timer

      completion(
        [
          "framework": "arkit",
          "runId": runId,
          "previewSupported": true,
          "measurementOrigin": "surface-anchor-placement",
          "deviceModel": Self.deviceModel(),
          "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
          "depthEnabled": depthEnabled,
          "meshEnabled": meshEnabled,
        ],
        nil
      )
    }
  }

  @objc public func stop() {
    queue.async { [self] in stopOnQueue() }
  }

  public func session(_ session: ARSession, didUpdate frame: ARFrame) {
    guard self.session === session else { return }
    // Do not retain `frame`; holding ARFrames starves ARKit's frame pool.
    framesInWindow += 1
    if frame.sceneDepth != nil { depthFrames += 1 }
    tracking = Self.describe(frame.camera.trackingState)
    if preview?.isActuallyVisible != true { previewContinuous = false }
    if tracking != "normal" { trackingContinuous = false }
  }

  public func session(_ session: ARSession, didFailWithError error: Error) {
    guard self.session === session else { return }
    onError?(error.localizedDescription)
    stopOnQueue()
  }

  private func stopOnQueue() {
    timer?.cancel()
    timer = nil
    if let probe { session?.remove(anchor: probe) }
    session?.pause()
    session?.delegate = nil
    session = nil
    preview?.scene = SCNScene()
    probeMessage = "Center a mapped surface, then tap the preview to place the probe."
    probe = nil; placedAt = 0; renderedFrames = 0; renderedProbeFrames = 0; depthFrames = 0
    meshIds.removeAll(); lastRenderedTimestamp = -1
    previewContinuous = true; trackingContinuous = true
  }

  private func emitWindow() {
    let now = ProcessInfo.processInfo.systemUptime
    guard let session else { return }
    let visible = preview?.isActuallyVisible == true
    let probeNode = probe.flatMap { preview?.node(for: $0) }
    let anchorVisible = visible && probeNode != nil && preview?.pointOfView != nil &&
      preview!.isNode(probeNode!, insideFrustumOf: preview!.pointOfView!)
    var sample: [String: Any] = [
      "tMs": placedAt > 0 ? (now - placedAt) * 1000 : 0,
      "sessionElapsedMs": (now - startedAt) * 1000,
      "runId": runId,
      "probeMessage": probeMessage,
      "previewVisible": visible && previewContinuous,
      "trackingNormalThroughout": trackingContinuous,
      "renderedFrames": renderedFrames,
      "depthFrames": depthFrames,
      "meshAnchorCount": meshIds.count,
      "anchorId": probe?.identifier.uuidString ?? "",
      "anchorVisible": anchorVisible,
      "previewContent": "known-orange-sphere-diameter-10mm-v1",
      "contentAttached": probeNode?.geometry != nil && probeNode?.parent != nil,
      "renderedProbeFrames": renderedProbeFrames,
      "anchorMethod": probe == nil ? "unplaced" : "existing-plane-geometry-center-raycast",
      "anchorPlacedAtSessionMs": placedAt > 0 ? (placedAt - startedAt) * 1000 : -1,
      "intervalMs": (now - windowStartedAt) * 1000,
      "frames": framesInWindow,
      "thermal": Self.thermalState(),
      "tracking": tracking,
    ]
    if let probe { sample["anchorTransform"] = matrix(probe.transform) }
    if let frame = session.currentFrame { sample["cameraTransform"] = matrix(frame.camera.transform) }
    windowStartedAt = now
    previewContinuous = true; trackingContinuous = true
    framesInWindow = 0; renderedFrames = 0; renderedProbeFrames = 0; depthFrames = 0
    onSample?(sample)
  }

  private static func thermalState() -> String {
    switch ProcessInfo.processInfo.thermalState {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "unknown"
    }
  }

  private static func describe(_ state: ARCamera.TrackingState) -> String {
    switch state {
    case .normal:
      return "normal"
    case .notAvailable:
      return "notAvailable"
    case .limited(let reason):
      switch reason {
      case .initializing: return "limited:initializing"
      case .excessiveMotion: return "limited:excessiveMotion"
      case .insufficientFeatures: return "limited:insufficientFeatures"
      case .relocalizing: return "limited:relocalizing"
      @unknown default: return "limited:unknown"
      }
    }
  }

  private static func deviceModel() -> String {
    var info = utsname()
    uname(&info)
    return withUnsafePointer(to: &info.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
    }
  }
}
