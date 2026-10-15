import ARKit
import SceneKit
import UIKit

@objc(ScanCapturePreview)
public final class ScanCapturePreview: ARSCNView {
  // The renderer delegate must be a separate object. On iOS 27 an ARSCNView
  // that delegates to itself recurses in the view-rotation observer path.
  private let rendererDelegate = ScanCapturePreviewRendererDelegate()

  @objc public override init(frame: CGRect, options: [String: Any]? = nil) {
    super.init(frame: frame, options: options)
    delegate = rendererDelegate
    automaticallyUpdatesLighting = true
    accessibilityLabel = "Live capture preview. Center a detected surface, then tap to place the stability probe."
    isAccessibilityElement = true
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(placeProbe)))
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { ScanCaptureSession.shared.attach(self) }
    else { ScanCaptureSession.shared.detach(self) }
  }
  var isActuallyVisible: Bool {
    guard let window, UIApplication.shared.applicationState == .active else { return false }
    var visible = convert(bounds, to: window)
    var ancestor: UIView? = self
    while let view = ancestor {
      if view.isHidden || view.alpha <= 0.01 { return false }
      if view.clipsToBounds { visible = visible.intersection(view.convert(view.bounds, to: window)) }
      ancestor = view.superview
    }
    visible = visible.intersection(window.bounds)
    return bounds.width > 1 && bounds.height > 1 && !visible.isNull &&
      visible.width * visible.height >= bounds.width * bounds.height * 0.95
  }
  @objc private func placeProbe() { ScanCaptureSession.shared.placeProbe(in: self) }
}

final class ScanCapturePreviewRendererDelegate: NSObject, ARSCNViewDelegate {
  func renderer(_ renderer: SCNSceneRenderer, didRenderScene scene: SCNScene, atTime time: TimeInterval) {
    guard let view = renderer as? ScanCapturePreview else { return }
    // Copy only the timestamp; never retain ARFrame buffers.
    let renderedSession = view.session
    let timestamp = renderedSession.currentFrame?.timestamp
    DispatchQueue.main.async { [weak view] in
      guard let view, let timestamp else { return }
      ScanCaptureSession.shared.didRender(view, session: renderedSession, timestamp: timestamp)
    }
  }
  func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
    guard anchor.name == "stability-probe" else { return nil }
    let node = SCNNode()
    let sphere = SCNSphere(radius: 0.005)
    sphere.firstMaterial?.diffuse.contents = UIColor.systemOrange
    sphere.firstMaterial?.lightingModel = .constant
    node.geometry = sphere
    return node
  }
}
