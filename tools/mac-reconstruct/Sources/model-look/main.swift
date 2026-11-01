import Foundation
import SceneKit
import ModelIO
import SceneKit.ModelIO
import AppKit

// Measures a model and renders it the same way every time, for comparing reconstructions.
// Usage: model-look <model.usdz|.stl|.obj> <output-prefix>
// Prints {"triangles":…,"sizeMm":[x,y,z]} and writes <prefix>-front.png, -side.png, -top.png.

let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write(Data("usage: model-look <model> <output-prefix> [--clay]\n".utf8)); exit(2) }
// --clay: plain matte grey, so the shape (what prints) shows instead of the photo texture.
let clay = args.contains("--clay")
let url = URL(fileURLWithPath: args[1])
let asset = MDLAsset(url: url)
asset.loadTextures()
let scene = SCNScene(mdlAsset: asset)
var triangles = 0
scene.rootNode.enumerateHierarchy { node, _ in
    node.geometry?.elements.forEach { if $0.primitiveType == .triangles { triangles += $0.primitiveCount } }
}
if clay {
    let material = SCNMaterial()
    material.diffuse.contents = NSColor(white: 0.72, alpha: 1)
    material.lightingModel = .physicallyBased
    material.roughness.contents = 0.75
    scene.rootNode.enumerateHierarchy { node, _ in if let geometry = node.geometry { geometry.materials = [material] } }
}
let (low, high) = scene.rootNode.boundingBox
// USDZ from Object Capture is in metres; STL/OBJ from the touch-up is in millimetres.
let scale: Double = url.pathExtension.lowercased() == "usdz" ? 1000 : 1
let size = [Double(high.x - low.x), Double(high.y - low.y), Double(high.z - low.z)].map { ($0 * scale * 10).rounded() / 10 }
let center = SCNVector3((low.x + high.x) / 2, (low.y + high.y) / 2, (low.z + high.z) / 2)
let radius = Double(sqrt(pow(high.x - low.x, 2) + pow(high.y - low.y, 2) + pow(high.z - low.z, 2))) / 2

let renderer = SCNRenderer(device: MTLCreateSystemDefaultDevice(), options: nil)
renderer.scene = scene
renderer.autoenablesDefaultLighting = true
scene.background.contents = NSColor(white: 0.17, alpha: 1)
let camera = SCNNode(); camera.camera = SCNCamera(); camera.camera!.fieldOfView = 30
camera.camera!.zNear = radius / 100; camera.camera!.zFar = radius * 20
scene.rootNode.addChildNode(camera)
renderer.pointOfView = camera
let distance = radius / sin(15 * .pi / 180) * 1.05
for (name, direction) in [("front", SCNVector3(0, 0, 1)), ("side", SCNVector3(1, 0, 0)), ("top", SCNVector3(0, 1, 0.001))] {
    camera.position = SCNVector3(center.x + direction.x * CGFloat(distance), center.y + direction.y * CGFloat(distance), center.z + direction.z * CGFloat(distance))
    camera.look(at: center)
    let image = renderer.snapshot(atTime: 0, with: CGSize(width: 900, height: 900), antialiasingMode: .multisampling4X)
    if let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
        try png.write(to: URL(fileURLWithPath: "\(args[2])-\(name).png"))
    }
}
let json = try JSONSerialization.data(withJSONObject: ["triangles": triangles, "sizeMm": size])
print(String(data: json, encoding: .utf8)!)
