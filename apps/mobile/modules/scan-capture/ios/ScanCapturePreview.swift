import ARKit
import SceneKit
import UIKit

@objc(ScanCapturePreview)
public final class ScanCapturePreview: ARSCNView {
  // The renderer delegate must be a separate object. On iOS 27 an ARSCNView
  // that delegates to itself recurses in the view-rotation observer path.
  private let rendererDelegate = ScanCapturePreviewRendererDelegate()
  private let probeLocator = ProbeLocatorView(frame: CGRect(x: 0, y: 0, width: 38, height: 38))

  @objc public override init(frame: CGRect, options: [String: Any]? = nil) {
    super.init(frame: frame, options: options)
    delegate = rendererDelegate
    automaticallyUpdatesLighting = true
    accessibilityLabel = "Live capture preview. Center a detected surface, then tap to place the stability probe."
    isAccessibilityElement = true
    probeLocator.isHidden = true
    addSubview(probeLocator)
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(placeProbe)))
  }

  // Classify on the main thread, where UIKit view geometry may be read.
  func updateProbeLocator(projected: SCNVector3?) {
    guard let projected, projected.z > 0, projected.z < 1 else {
      probeLocator.isHidden = true
      return
    }
    let center = CGPoint(x: CGFloat(projected.x), y: CGFloat(projected.y))
    guard center.x.isFinite, center.y.isFinite else {
      probeLocator.isHidden = true
      return
    }
    if bounds.contains(center) {
      probeLocator.center = center
      probeLocator.apply(bounds.insetBy(dx: 24, dy: 24).contains(center) ? .inside : .nearEdge)
    } else {
      probeLocator.center = CGPoint(
        x: min(max(center.x, 19), max(19, bounds.width - 19)),
        y: min(max(center.y, 19), max(19, bounds.height - 19))
      )
      probeLocator.apply(.outside)
    }
    probeLocator.isHidden = false
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
  private weak var probeNode: SCNNode?

  func renderer(_ renderer: SCNSceneRenderer, didRenderScene scene: SCNScene, atTime time: TimeInterval) {
    guard let view = renderer as? ScanCapturePreview else { return }
    // Copy only the timestamp; never retain ARFrame buffers.
    let renderedSession = view.session
    let timestamp = renderedSession.currentFrame?.timestamp
    let projectedProbe: SCNVector3? = probeNode.flatMap { node in
      node.parent == nil ? nil : view.projectPoint(node.worldPosition)
    }
    DispatchQueue.main.async { [weak view] in
      guard let view else { return }
      view.updateProbeLocator(projected: projectedProbe)
      guard let timestamp else { return }
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
    probeNode = node
    return node
  }
}

final class ProbeLocatorView: UIView {
  enum State {
    case inside
    case nearEdge
    case outside
  }

  private let dot = UIView(frame: CGRect(x: 16, y: 16, width: 6, height: 6))
  private var appliedState: State?

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    isUserInteractionEnabled = false
    layer.borderWidth = 3
    layer.cornerRadius = 19
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.55
    layer.shadowRadius = 2
    layer.shadowOffset = .zero

    dot.layer.cornerRadius = 3
    addSubview(dot)
    apply(.inside)
  }

  func apply(_ state: State) {
    guard appliedState != state else { return }
    appliedState = state
    switch state {
    case .inside:
      layer.borderColor = UIColor.systemOrange.cgColor
      layer.borderWidth = 3
      backgroundColor = .clear
      dot.backgroundColor = .systemOrange
      dot.isHidden = false
      alpha = 1
    case .nearEdge:
      layer.borderColor = UIColor.systemRed.cgColor
      layer.borderWidth = 4
      backgroundColor = UIColor.systemRed.withAlphaComponent(0.12)
      dot.backgroundColor = .systemRed
      dot.isHidden = false
      alpha = 1
    case .outside:
      layer.borderColor = UIColor.systemRed.cgColor
      layer.borderWidth = 3
      backgroundColor = UIColor.systemRed.withAlphaComponent(0.12)
      dot.isHidden = true
      alpha = 0.75
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}
