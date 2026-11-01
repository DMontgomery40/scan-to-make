import Foundation
import SceneKit
import ModelIO
import SceneKit.ModelIO
import AppKit

// Measures a model and renders it the same way every time, for comparing reconstructions.
// Usage: model-look <model.usdz|.stl|.obj> <output-prefix> [--clay] [--pca]
// Prints {"triangles":…,"sizeMm":[x,y,z],"pcaSizeMm":[a,b,c]} and writes <prefix>-front.png, -side.png, -top.png.
// sizeMm is the box in the model's own axes. pcaSizeMm is the box along the model's principal axes, longest first,
// so it doesn't depend on how the model happens to be oriented (a handheld scan has no gravity to set "up").
// --pca renders in that frame too (longest axis up), so two scans of the same object can be compared side by side.
import simd

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
// Principal axes from the vertices, in the model's own units.
var points: [SIMD3<Double>] = []
scene.rootNode.enumerateHierarchy { node, _ in
    guard let source = node.geometry?.sources(for: .vertex).first else { return }
    let world = node.simdWorldTransform
    source.data.withUnsafeBytes { raw in
        for i in 0..<source.vectorCount {
            let p = raw.baseAddress!.advanced(by: source.dataOffset + i * source.dataStride).assumingMemoryBound(to: Float.self)
            let v = world * SIMD4<Float>(p[0], p[1], p[2], 1)
            points.append(SIMD3(Double(v.x), Double(v.y), Double(v.z)))
        }
    }
}
let mean = points.reduce(SIMD3<Double>(repeating: 0), +) / Double(max(1, points.count))
var cov = simd_double3x3()
for p in points { let d = p - mean; cov += simd_double3x3(rows: [d * d.x, d * d.y, d * d.z]) }
// Jacobi eigen-decomposition of the symmetric covariance.
var a = cov, vectors = matrix_identity_double3x3
for _ in 0..<50 {
    var (p, q) = (0, 1)
    for (i, j) in [(0, 1), (0, 2), (1, 2)] where abs(a[j][i]) > abs(a[q][p]) { (p, q) = (i, j) }
    if abs(a[q][p]) < 1e-18 { break }
    let theta = (a[q][q] - a[p][p]) / (2 * a[q][p])
    let t = (theta >= 0 ? 1 : -1) / (abs(theta) + (theta * theta + 1).squareRoot())
    let c = 1 / (t * t + 1).squareRoot(), sn = t * c
    var r = matrix_identity_double3x3
    r[p][p] = c; r[q][q] = c; r[q][p] = sn; r[p][q] = -sn
    a = r.transpose * a * r; vectors = vectors * r
}
var axes = (0..<3).map { (value: a[$0][$0], vector: vectors[$0]) }.sorted { $0.value > $1.value }.map { $0.vector }
// Point each axis toward the model's heavier tail (third moment) so the frame is the same for two scans.
for k in 0..<2 {
    let skew = points.reduce(0.0) { $0 + pow(simd_dot($1 - mean, axes[k]), 3) }
    if skew < 0 { axes[k] = -axes[k] }
}
axes[2] = simd_cross(axes[0], axes[1])
var pcaLow = SIMD3<Double>(repeating: .infinity), pcaHigh = SIMD3<Double>(repeating: -.infinity)
for p in points {
    let d = p - mean
    let c = SIMD3(simd_dot(d, axes[0]), simd_dot(d, axes[1]), simd_dot(d, axes[2]))
    pcaLow = simd_min(pcaLow, c); pcaHigh = simd_max(pcaHigh, c)
}
if args.contains("--pca") {
    // Longest axis up (y), second across (x), third toward the camera (z); rows (a1, a0, a1×a0) keep it a rotation.
    let rows = [axes[1], axes[0], simd_cross(axes[1], axes[0])]
    let r = simd_double3x3(rows: rows)
    let t = -(r * mean)
    let m = simd_float4x4(columns: (
        SIMD4(Float(r[0][0]), Float(r[0][1]), Float(r[0][2]), 0), SIMD4(Float(r[1][0]), Float(r[1][1]), Float(r[1][2]), 0),
        SIMD4(Float(r[2][0]), Float(r[2][1]), Float(r[2][2]), 0), SIMD4(Float(t.x), Float(t.y), Float(t.z), 1)))
    let holder = SCNNode()
    for child in scene.rootNode.childNodes { child.removeFromParentNode(); holder.addChildNode(child) }
    holder.simdTransform = m
    scene.rootNode.addChildNode(holder)
}
var (low, high) = scene.rootNode.boundingBox
if args.contains("--pca") {
    // SceneKit's box around a transformed child is loose; use the exact extents in the new frame.
    low = SCNVector3(pcaLow[1], pcaLow[0], -pcaHigh[2]); high = SCNVector3(pcaHigh[1], pcaHigh[0], -pcaLow[2])
}
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
let pcaSize = (0..<3).map { ((pcaHigh[$0] - pcaLow[$0]) * scale * 10).rounded() / 10 }
let json = try JSONSerialization.data(withJSONObject: ["triangles": triangles, "sizeMm": size, "pcaSizeMm": pcaSize])
print(String(data: json, encoding: .utf8)!)
