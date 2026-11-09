import Foundation
import AppKit
import Metal
import ModelIO
import SceneKit
import SceneKit.ModelIO

/// A picture of a model for the project page, the way the apps show a project before it is turned: its own textures,
/// from the front and a little above, on the dark stage the apps use. Y is up, as in Apple's USDZ; `zUp` draws a
/// project STL (millimetres, Z up) turned the same way.
public func renderOverview(model: URL, to output: URL, pixels: Int = 900, zUp: Bool = false) throws {
    let asset = MDLAsset(url: model)
    asset.loadTextures()
    let scene = SCNScene(mdlAsset: asset)
    if zUp {
        let turned = SCNNode()
        for child in scene.rootNode.childNodes { child.removeFromParentNode(); turned.addChildNode(child) }
        turned.eulerAngles.x = -.pi / 2
        scene.rootNode.addChildNode(turned)
    }
    let (low, high) = scene.rootNode.boundingBox
    let centre = SIMD3<Double>(Double(low.x + high.x) / 2, Double(low.y + high.y) / 2, Double(low.z + high.z) / 2)
    let radius = simd_length(SIMD3<Double>(Double(high.x - low.x), Double(high.y - low.y), Double(high.z - low.z))) / 2
    guard radius.isFinite, radius > 0 else { throw HandheldError.io("\(model.lastPathComponent) has nothing to draw") }

    guard let device = MTLCreateSystemDefaultDevice() else { throw HandheldError.unsupported("no Metal device to draw with") }
    let renderer = SCNRenderer(device: device, options: nil)
    renderer.scene = scene
    renderer.autoenablesDefaultLighting = true
    scene.background.contents = NSColor(white: 0.17, alpha: 1)
    let camera = SCNNode()
    camera.camera = SCNCamera()
    camera.camera!.fieldOfView = 30
    camera.camera!.zNear = radius / 100
    camera.camera!.zFar = radius * 20
    scene.rootNode.addChildNode(camera)
    renderer.pointOfView = camera
    let eye = centre + simd_normalize(SIMD3<Double>(0.5, 0.4, 1)) * (radius / sin(15 * .pi / 180) * 1.05)
    camera.position = SCNVector3(CGFloat(eye.x), CGFloat(eye.y), CGFloat(eye.z))
    camera.look(at: SCNVector3(CGFloat(centre.x), CGFloat(centre.y), CGFloat(centre.z)))
    let image = renderer.snapshot(atTime: 0, with: CGSize(width: pixels, height: pixels), antialiasingMode: .multisampling4X)
    guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else { throw HandheldError.io("couldn't draw \(model.lastPathComponent)") }
    try png.write(to: output, options: .atomic)
}
