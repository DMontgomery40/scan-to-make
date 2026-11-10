import Foundation
import AppKit
import CoreImage
import Metal
import ModelIO
import SceneKit
import SceneKit.ModelIO
import Vision

/// A project's picture (PRD §5.1, §5.4; David, Nov 10: "of ALL THE OPTIONS ... the photograph including everything in it
/// is by far the worst"): the object alone on the apps' dark stage, the way the mockups draw it. Drawn once on the Mac
/// so every client, notification and Live Activity shows the same picture.
public struct PictureSpec {
    /// A model: a project STL (millimetres, Z up) or a scan (USDZ, Y up, its own textures).
    public var model: URL?
    public var zUp = false
    /// The spool a one-colour STL prints in; nil draws the stage's neutral material.
    public var tint: NSColor?
    /// A scan placed in the model at each seat (row-major 4×4, the part's millimetre frame; docs/protocols/seats.md).
    public var object: URL?
    public var seats: [[Double]] = []
    /// A photo, when there is no model yet: its subject cut out of the room by Vision, alone on the stage.
    public var photo: URL?
    public var pixels = 900
    public init() {}
}

/// The stage the apps draw: a vertical gradient (top 0.13/0.14/0.17 to 0.05/0.05/0.07) with a soft light below centre;
/// or the light stage (0.86/0.87/0.89 to 0.70/0.71/0.74) for a part that would be a silhouette on the dark one.
private func stage(_ size: Int, light: Bool = false) -> CGContext? {
    guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let top = light ? CGColor(red: 0.86, green: 0.87, blue: 0.89, alpha: 1) : CGColor(red: 0.13, green: 0.14, blue: 0.17, alpha: 1)
    let bottom = light ? CGColor(red: 0.70, green: 0.71, blue: 0.74, alpha: 1) : CGColor(red: 0.05, green: 0.05, blue: 0.07, alpha: 1)
    let linear = CGGradient(colorsSpace: space, colors: [top, bottom] as CFArray, locations: [0, 1])!
    context.drawLinearGradient(linear, start: CGPoint(x: 0, y: size), end: CGPoint(x: 0, y: 0), options: [])
    let glow = CGGradient(colorsSpace: space, colors: [CGColor(gray: 1, alpha: light ? 0.35 : 0.10), CGColor(gray: 1, alpha: 0)] as CFArray, locations: [0, 1])!
    let centre = CGPoint(x: Double(size) * 0.5, y: Double(size) * 0.38)
    context.drawRadialGradient(glow, startCenter: centre, startRadius: 4, endCenter: centre, endRadius: Double(size) * 0.55, options: [])
    return context
}

private func neutral() -> NSColor { NSColor(red: 0.58, green: 0.58, blue: 0.60, alpha: 1) }

/// A 3MF's objects as they sit in its build (millimetres, Z up), each triangle in the colour the file gives it (the 3MF
/// materials extension), else the spool's colour or neutral. Flat-shaded, as a printed part's facets read.
func threeMFNode(_ url: URL, tint: NSColor?) throws -> SCNNode {
    let model = try ThreeMF.read(url)
    let holder = SCNNode()
    func material(_ colour: SIMD4<Float>?) -> SCNMaterial {
        let m = SCNMaterial()
        m.lightingModel = .physicallyBased
        m.diffuse.contents = colour.map { NSColor(srgbRed: CGFloat($0.x), green: CGFloat($0.y), blue: CGFloat($0.z), alpha: 1) } ?? tint ?? neutral()
        m.roughness.contents = 0.55
        m.metalness.contents = 0.0
        m.isDoubleSided = true
        return m
    }
    for mesh in model.meshes where !mesh.triangles.isEmpty {
        // One element per colour; each triangle's three corners get their face's normal.
        var groups: [String: (colour: SIMD4<Float>?, start: Int, indices: [UInt32])] = [:]
        var positions: [SCNVector3] = [], normals: [SCNVector3] = []
        positions.reserveCapacity(mesh.triangles.count * 3); normals.reserveCapacity(mesh.triangles.count * 3)
        for (n, t) in mesh.triangles.enumerated() {
            guard Int(t.x) < mesh.positions.count, Int(t.y) < mesh.positions.count, Int(t.z) < mesh.positions.count else { continue }
            let a = mesh.positions[Int(t.x)], b = mesh.positions[Int(t.y)], c = mesh.positions[Int(t.z)]
            let normal = simd_normalize(simd_cross(b - a, c - a))
            let face = normal.x.isFinite ? normal : SIMD3<Float>(0, 0, 1)
            let colour = mesh.colours[safe: n] ?? nil
            let key = colour.map { "\($0)" } ?? "-"
            let base = UInt32(positions.count)
            for p in [a, b, c] { positions.append(SCNVector3(p.x, p.y, p.z)); normals.append(SCNVector3(face.x, face.y, face.z)) }
            groups[key, default: (colour, 0, [])].indices.append(contentsOf: [base, base + 1, base + 2])
        }
        let ordered = groups.values.sorted { ($0.indices.first ?? 0) < ($1.indices.first ?? 0) }
        let geometry = SCNGeometry(sources: [SCNGeometrySource(vertices: positions), SCNGeometrySource(normals: normals)],
                                   elements: ordered.map { SCNGeometryElement(indices: $0.indices, primitiveType: .triangles) })
        geometry.materials = ordered.map { material($0.colour) }
        let node = SCNNode(geometry: geometry)
        node.name = mesh.name
        holder.addChildNode(node)
    }
    return holder
}

/// The model's nodes, turned Y up, with one material for an STL (its spool, or neutral) and a scan's own textures.
private func loadNode(_ url: URL, zUp: Bool, tint: NSColor?, own: Bool) throws -> SCNNode {
    if url.pathExtension.lowercased() == "3mf" {
        let node = try threeMFNode(url, tint: tint)
        if zUp { node.eulerAngles.x = -.pi / 2 }
        return node
    }
    let asset = MDLAsset(url: url)
    asset.loadTextures()
    let scene = SCNScene(mdlAsset: asset)
    let holder = SCNNode()
    for child in scene.rootNode.childNodes { child.removeFromParentNode(); holder.addChildNode(child) }
    holder.enumerateHierarchy { node, _ in
        for material in node.geometry?.materials ?? [] {
            material.isDoubleSided = true
            if own {
                // A scan's texture already carries the light it was photographed in: shown as photographed.
                material.lightingModel = .constant
            } else {
                material.lightingModel = .physicallyBased
                material.diffuse.contents = tint ?? neutral()
                material.roughness.contents = 0.55
                material.metalness.contents = 0.0
            }
        }
    }
    if zUp { holder.eulerAngles.x = -.pi / 2 }
    return holder
}

/// Scene lights for a printed part: a key from above and in front, a fill, a rim, and enough ambient that black PLA
/// still reads on the dark stage.
private func addLights(_ root: SCNNode, dark: Bool, bright: Bool = false) {
    // A white or pale part keeps its shading instead of washing out.
    let scale: CGFloat = bright ? 0.72 : 1
    func light(_ type: SCNLight.LightType, _ intensity: CGFloat, _ euler: SCNVector3 = SCNVector3Zero) {
        let node = SCNNode(); node.light = SCNLight(); node.light!.type = type; node.light!.intensity = intensity * scale
        node.eulerAngles = euler; root.addChildNode(node)
    }
    light(.ambient, dark ? 420 : 260)
    light(.directional, dark ? 1100 : 750, SCNVector3(-0.75, -0.45, 0))
    light(.directional, dark ? 420 : 260, SCNVector3(-0.2, 1.4, 0))
    light(.directional, dark ? 900 : 450, SCNVector3(0.6, 2.9, 0))
}

private func luminance(_ colour: NSColor?) -> CGFloat {
    guard let rgb = colour?.usingColorSpace(.sRGB) else { return 0.5 }
    return 0.2126 * rgb.redComponent + 0.7152 * rgb.greenComponent + 0.0722 * rgb.blueComponent
}

/// The part reads better on the light stage than the dark one (WCAG contrast of relative luminance; the same rule as
/// CounterpartKit `StageContrast`, whose stage colours are #22242B and #C8CACF).
public func wantsLightStage(_ colour: NSColor?) -> Bool {
    guard let rgb = colour?.usingColorSpace(.sRGB) else { return false }
    func linear(_ c: CGFloat) -> Double { let c = Double(c); return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
    let part = 0.2126 * linear(rgb.redComponent) + 0.7152 * linear(rgb.greenComponent) + 0.0722 * linear(rgb.blueComponent)
    let dark = 0.01776, light = 0.59025
    func ratio(_ a: Double, _ b: Double) -> Double { (max(a, b) + 0.05) / (min(a, b) + 0.05) }
    return ratio(part, light) > ratio(part, dark)
}

public func renderPicture(_ spec: PictureSpec, to output: URL) throws {
    let size = spec.pixels
    guard let context = stage(size, light: spec.model != nil && wantsLightStage(spec.tint)) else { throw HandheldError.io("no drawing context") }
    if let model = spec.model {
        let scene = SCNScene()
        scene.background.contents = NSColor.clear
        let own = !spec.zUp && spec.tint == nil
        let root = SCNNode()
        let part = try loadNode(model, zUp: false, tint: spec.tint, own: own)
        let frame = SCNNode()
        frame.addChildNode(part)
        if let object = spec.object, !spec.seats.isEmpty {
            // The scan's frame (metres, Y up) into the part's frame (millimetres, Z up), then each seat.
            let toSeatFrame = simd_float4x4(rows: [SIMD4(1000, 0, 0, 0), SIMD4(0, 0, -1000, 0), SIMD4(0, 1000, 0, 0), SIMD4(0, 0, 0, 1)])
            let scan = try loadNode(object, zUp: false, tint: nil, own: true)
            for seat in spec.seats where seat.count == 16 {
                let m = simd_float4x4(rows: (0..<4).map { r in SIMD4<Float>((0..<4).map { Float(seat[r * 4 + $0]) }) })
                let placed = scan.clone()
                placed.simdTransform = m * toSeatFrame
                frame.addChildNode(placed)
            }
        }
        if spec.zUp { frame.eulerAngles.x = -.pi / 2 }
        root.addChildNode(frame)
        scene.rootNode.addChildNode(root)
        if !own { addLights(scene.rootNode, dark: luminance(spec.tint) < 0.2, bright: luminance(spec.tint) > 0.8) }
        let (low, high) = root.boundingBox
        let lowW = root.convertPosition(low, to: nil), highW = root.convertPosition(high, to: nil)
        let centre = SIMD3<Double>(Double(lowW.x + highW.x) / 2, Double(lowW.y + highW.y) / 2, Double(lowW.z + highW.z) / 2)
        let radius = simd_length(SIMD3<Double>(Double(highW.x - lowW.x), Double(highW.y - lowW.y), Double(highW.z - lowW.z))) / 2
        guard radius.isFinite, radius > 0 else { throw HandheldError.io("\(model.lastPathComponent) has nothing to draw") }
        guard let device = MTLCreateSystemDefaultDevice() else { throw HandheldError.unsupported("no Metal device to draw with") }
        let renderer = SCNRenderer(device: device, options: nil)
        renderer.scene = scene
        renderer.autoenablesDefaultLighting = own
        let camera = SCNNode()
        camera.camera = SCNCamera()
        camera.camera!.fieldOfView = 30
        camera.camera!.zNear = radius / 100
        camera.camera!.zFar = radius * 20
        scene.rootNode.addChildNode(camera)
        renderer.pointOfView = camera
        // The apps' own stage angle (yaw 0.6, pitch −0.35 rad): from the front-right and a little above.
        let eye = centre + simd_normalize(SIMD3<Double>(0.55, 0.42, 1)) * (radius / sin(15 * .pi / 180) * 1.02)
        camera.position = SCNVector3(CGFloat(eye.x), CGFloat(eye.y), CGFloat(eye.z))
        camera.look(at: SCNVector3(CGFloat(centre.x), CGFloat(centre.y), CGFloat(centre.z)))
        let image = renderer.snapshot(atTime: 0, with: CGSize(width: size, height: size), antialiasingMode: .multisampling4X)
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { throw HandheldError.io("couldn't draw \(model.lastPathComponent)") }
        context.draw(cg, in: CGRect(x: 0, y: 0, width: size, height: size))
    } else if let photo = spec.photo {
        try drawCutOut(photo, into: context, size: size)
    } else {
        throw HandheldError.io("nothing to draw")
    }
    guard let picture = context.makeImage() else { throw HandheldError.io("couldn't draw the picture") }
    let png = NSBitmapImageRep(cgImage: picture).representation(using: .png, properties: [:])
    try png?.write(to: output, options: .atomic)
}

/// The photo's subject, cut out of its background by Vision's foreground mask, scaled to sit on the stage like a model.
private func drawCutOut(_ photo: URL, into context: CGContext, size: Int) throws {
    guard let source = CGImageSourceCreateWithURL(photo as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary) else { throw HandheldError.io("can't read \(photo.lastPathComponent)") }
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let orientation = (properties?[kCGImagePropertyOrientation] as? UInt32).flatMap(CGImagePropertyOrientation.init(rawValue:)) ?? .up
    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(cgImage: image, orientation: orientation)
    try handler.perform([request])
    guard let observation = request.results?.first, !observation.allInstances.isEmpty else { throw HandheldError.io("no subject in \(photo.lastPathComponent)") }
    let buffer = try observation.generateMaskedImage(ofInstances: observation.allInstances, from: handler, croppedToInstancesExtent: true)
    let ci = CIImage(cvPixelBuffer: buffer)
    guard let cut = CIContext().createCGImage(ci, from: ci.extent) else { throw HandheldError.io("couldn't cut out \(photo.lastPathComponent)") }
    // A cut-out that is most of the frame is the room, not an object: refuse it rather than show the room.
    let frameArea = Double(image.width * image.height), cutArea = Double(cut.width * cut.height)
    if cutArea > frameArea * 0.85 { throw HandheldError.io("the subject of \(photo.lastPathComponent) is the whole frame") }
    let scale = min(Double(size) * 0.78 / Double(cut.width), Double(size) * 0.78 / Double(cut.height))
    let width = Double(cut.width) * scale, height = Double(cut.height) * scale
    context.draw(cut, in: CGRect(x: (Double(size) - width) / 2, y: (Double(size) - height) / 2, width: width, height: height))
}
