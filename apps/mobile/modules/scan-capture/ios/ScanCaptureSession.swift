import ARKit
import Foundation

/// Headless ARKit world-tracking session that reports delivered frame counts
/// and thermal state on a fixed timer. It does not render a camera preview yet;
/// the D004 run is only representative once the AR preview view is added.
@objc(ScanCaptureSession)
public final class ScanCaptureSession: NSObject, ARSessionDelegate {
  @objc public var onSample: (([String: Any]) -> Void)?
  @objc public var onError: ((String) -> Void)?

  @objc public static var isSupported: Bool {
    ARWorldTrackingConfiguration.isSupported
  }

  // Session delegate callbacks and the sample timer share this serial queue,
  // so the counters below are never touched concurrently.
  private let queue = DispatchQueue(label: "com.scantomake.scancapture.session")
  private var session: ARSession?
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

      let configuration = ARWorldTrackingConfiguration()
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
    // Do not retain `frame`; holding ARFrames starves ARKit's frame pool.
    framesInWindow += 1
    tracking = Self.describe(frame.camera.trackingState)
  }

  public func session(_ session: ARSession, didFailWithError error: Error) {
    onError?(error.localizedDescription)
  }

  private func stopOnQueue() {
    timer?.cancel()
    timer = nil
    session?.pause()
    session?.delegate = nil
    session = nil
  }

  private func emitWindow() {
    let now = ProcessInfo.processInfo.systemUptime
    let sample: [String: Any] = [
      "tMs": (now - startedAt) * 1000,
      "intervalMs": (now - windowStartedAt) * 1000,
      "frames": framesInWindow,
      "thermal": Self.thermalState(),
      "tracking": tracking,
    ]
    windowStartedAt = now
    framesInWindow = 0
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
