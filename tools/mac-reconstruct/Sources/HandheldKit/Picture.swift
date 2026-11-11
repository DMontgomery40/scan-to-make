import Foundation
import AppKit
import CoreGraphics
import CoreImage
import ImageIO
import Metal
import ModelIO
import SceneKit
import SceneKit.ModelIO
import Vision
import simd

/// A project's picture (PRD §5.1, §5.4; David, Nov 10: "of ALL THE OPTIONS ... the photograph including everything in it
/// is by far the worst"): the object alone on the apps' dark stage, the way the mockups draw it. Drawn once on the Mac
/// so every client, notification and Live Activity shows the same picture.
public struct PictureSpec {
    /// A model: a project STL/3MF (millimetres, Z up) or a scan (USDZ, Y up, its own textures).
    public var model: URL?
    public var zUp = false
    /// The spool a one-colour part prints in; nil draws the stage's neutral material.
    public var tint: NSColor?
    /// Legacy backdrop request, ignored: the stage always stays dark. Kept for older command-line callers.
    public var lightStage: Bool?
    /// A scan placed in the model at each seat (row-major 4×4, the part's millimetre frame; docs/protocols/seats.md).
    public var object: URL?
    public var seats: [[Double]] = []
    /// A photo, when there is no model yet: its subject cut out of the room by Vision, alone on the stage.
    public var photo: URL?
    public var pixels = 900
    public init() {}
}

/// The stage the apps draw: a vertical gradient (top 0.13/0.14/0.17 to 0.05/0.05/0.07) with a soft light below centre;
/// the same dark backdrop for every filament colour.
func stage(_ size: Int, light: Bool = false) -> CGContext? {
    let light = false // A backdrop request never changes the app’s dark stage.
    guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
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

/// Neutral studio clay tuned so faces separate cleanly on both the dark and light backdrops.
private func neutral(lightStage: Bool) -> SIMD3<Float> {
    lightStage ? SIMD3<Float>(0.45, 0.47, 0.51) : SIMD3<Float>(0.64, 0.65, 0.68)
}

/// Maps caller spool colours into physically plausible plastic reflectance so pure `#000000` still shows facets and
/// pure `#FFFFFF` keeps highlight headroom, without shifting midtones or saturated filament hues.
private func plasticRGB(_ colour: NSColor?, lightStage: Bool) -> SIMD3<Float> {
    guard let srgb = colour?.usingColorSpace(.sRGB) else { return neutral(lightStage: lightStage) }
    var c = SIMD3<Float>(
        min(1, max(0, Float(srgb.redComponent))),
        min(1, max(0, Float(srgb.greenComponent))),
        min(1, max(0, Float(srgb.blueComponent)))
    )
    let lum = 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z
    let floorLum: Float = lightStage ? 0.13 : 0.20
    if lum < floorLum {
        let lift = (floorLum - lum) / floorLum
        c += lift * SIMD3<Float>(floorLum, floorLum * 1.01, floorLum * 1.04)
    }
    let peak = max(c.x, max(c.y, c.z))
    if peak > 0.94 {
        c *= 0.94 / peak
    }
    return simd_clamp(c, SIMD3<Float>(repeating: 0), SIMD3<Float>(repeating: 1))
}

/// Monochrome contrast step for uncoloured flush inlays (e.g. lettering recessed flush into a lid or pick face).
private func inlayRGB(for host: SIMD3<Float>, lightStage: Bool) -> SIMD3<Float> {
    let lum = 0.2126 * host.x + 0.7152 * host.y + 0.0722 * host.z
    if lum < 0.26 {
        return SIMD3<Float>(0.70, 0.71, 0.74)
    }
    let floorVal: Float = lightStage ? 0.14 : 0.19
    return simd_max(host * 0.28, SIMD3<Float>(floorVal, floorVal * 1.01, floorVal * 1.03))
}

/// Gentle studio value step across separate uncoloured bodies so multi-part assemblies and plates do not merge.
private func steppedRGB(_ base: SIMD3<Float>, index: Int) -> SIMD3<Float> {
    let steps: [Float] = [1.00, 0.92, 1.06, 0.96]
    return simd_clamp(base * steps[index % steps.count], SIMD3<Float>(repeating: 0.08), SIMD3<Float>(repeating: 0.95))
}

private func makePlasticMaterial(rgb: SIMD3<Float>) -> SCNMaterial {
    let m = SCNMaterial()
    m.lightingModel = .physicallyBased
    m.diffuse.contents = NSColor(srgbRed: CGFloat(rgb.x), green: CGFloat(rgb.y), blue: CGFloat(rgb.z), alpha: 1)
    m.roughness.contents = 0.46
    m.metalness.contents = 0.0
    m.isDoubleSided = true
    return m
}

private let undersideInlayMarker = "\u{001F}underside-inlay"
private let heroSeatMarker = "\u{001F}seated-scan"

private enum InlayKind {
    case none
    case top
    case underside
}

private func detectThreeMFInlays(_ meshes: [ThreeMF.Mesh]) -> [InlayKind] {
    guard meshes.count >= 2 else { return Array(repeating: .none, count: meshes.count) }
    struct Box {
        var lo: SIMD3<Float>
        var hi: SIMD3<Float>
        var valid: Bool
        var volume: Float {
            let s = simd_max(hi - lo, SIMD3<Float>(repeating: 0))
            return s.x * s.y * s.z
        }
    }
    let boxes: [Box] = meshes.map { mesh in
        guard !mesh.triangles.isEmpty, !mesh.positions.isEmpty else {
            return Box(lo: .zero, hi: .zero, valid: false)
        }
        var lo = SIMD3<Float>(repeating: .infinity), hi = SIMD3<Float>(repeating: -.infinity)
        for p in mesh.positions { lo = simd_min(lo, p); hi = simd_max(high: hi, p: p) }
        return Box(lo: lo, hi: hi, valid: lo.x.isFinite)
    }
    var kinds = Array(repeating: InlayKind.none, count: meshes.count)
    for i in meshes.indices where boxes[i].valid {
        let b = boxes[i]
        let dz = b.hi.z - b.lo.z
        guard dz <= 1.8 else { continue }
        for h in meshes.indices where h != i && boxes[h].valid {
            let hb = boxes[h]
            guard hb.volume > 0, b.volume < hb.volume * 0.40 else { continue }
            let insideXY = b.lo.x >= hb.lo.x - 0.08 && b.hi.x <= hb.hi.x + 0.08 &&
                           b.lo.y >= hb.lo.y - 0.08 && b.hi.y <= hb.hi.y + 0.08
            let insideZ = b.lo.z >= hb.lo.z - 0.08 && b.hi.z <= hb.hi.z + 0.08
            guard insideXY && insideZ else { continue }
            if abs(b.hi.z - hb.hi.z) <= 0.08 && b.lo.z >= hb.lo.z + 0.04 {
                kinds[i] = .top
                break
            } else if abs(b.lo.z - hb.lo.z) <= 0.08 && b.hi.z <= hb.hi.z - 0.04 {
                kinds[i] = .underside
                break
            }
        }
    }
    return kinds
}

@inline(__always)
private func simd_max(high: SIMD3<Float>, p: SIMD3<Float>) -> SIMD3<Float> {
    simd_max(high, p)
}

/// A 3MF's objects as they sit in its build (millimetres, Z up), each triangle in the colour the file gives it (the 3MF
/// materials extension), else the spool's colour or neutral. Flat-shaded, as a printed part's facets read.
func threeMFNode(_ url: URL, tint: NSColor?, lightStage: Bool = false) throws -> SCNNode {
    try threeMFNode(ThreeMF.read(url), tint: tint, lightStage: lightStage)
}

func threeMFNode(_ model: ThreeMF, tint: NSColor?, lightStage: Bool = false, limits: ThreeMFLimits = ThreeMFLimits()) throws -> SCNNode {
    // Refuse the entire scene before allocating any expanded geometry or SceneKit-owned copies.
    var budget = ThreeMFPlacementBudget(limits: limits)
    var materials = 0
    var uniformFlags = [Bool]()
    uniformFlags.reserveCapacity(model.meshes.count)
    for mesh in model.meshes {
        try budget.consume(vertices: mesh.positions.count, triangles: mesh.triangles.count)
        let first = mesh.colours.first ?? nil
        let isUniform = mesh.colours.allSatisfy { $0 == first }
        uniformFlags.append(isUniform)
        let count = isUniform ? 1 : max(1, Set(mesh.colours).count)
        guard count <= limits.materials - materials else { throw ThreeMFError.budget("rendered materials") }
        materials += count
    }

    let basePlastic = plasticRGB(tint, lightStage: lightStage)
    let inlayKinds = detectThreeMFInlays(model.meshes)
    let nonInlayCount = model.meshes.indices.filter { !model.meshes[$0].triangles.isEmpty && inlayKinds[$0] == .none }.count
    var bodyStepIndex = 0
    let holder = SCNNode()

    for (meshIndex, mesh) in model.meshes.enumerated() where !mesh.triangles.isEmpty {
        let inlay = inlayKinds[meshIndex]
        let defaultRGB: SIMD3<Float>
        switch inlay {
        case .top, .underside:
            defaultRGB = inlayRGB(for: basePlastic, lightStage: lightStage)
        case .none:
            defaultRGB = nonInlayCount >= 2 ? steppedRGB(basePlastic, index: bodyStepIndex) : basePlastic
            bodyStepIndex += 1
        }
        func material(_ colour: SIMD4<Float>?) -> SCNMaterial {
            if let c = colour {
                let ns = NSColor(srgbRed: CGFloat(c.x), green: CGFloat(c.y), blue: CGFloat(c.z), alpha: 1)
                return makePlasticMaterial(rgb: plasticRGB(ns, lightStage: lightStage))
            }
            return makePlasticMaterial(rgb: defaultRGB)
        }

        let vertexCap = mesh.triangles.count * 9
        var posFloats = [Float]()
        var normFloats = [Float]()
        posFloats.reserveCapacity(vertexCap)
        normFloats.reserveCapacity(vertexCap)
        let pCount = mesh.positions.count

        let geometry: SCNGeometry
        if uniformFlags[meshIndex] {
            for t in mesh.triangles {
                let i0 = Int(t.x), i1 = Int(t.y), i2 = Int(t.z)
                guard i0 < pCount, i1 < pCount, i2 < pCount else { continue }
                let a = mesh.positions[i0], b = mesh.positions[i1], c = mesh.positions[i2]
                let cross = simd_cross(b - a, c - a)
                let len2 = simd_length_squared(cross)
                let face = len2 > 1e-20 ? cross * (1.0 / sqrt(len2)) : SIMD3<Float>(0, 0, 1)
                posFloats.append(a.x); posFloats.append(a.y); posFloats.append(a.z)
                posFloats.append(b.x); posFloats.append(b.y); posFloats.append(b.z)
                posFloats.append(c.x); posFloats.append(c.y); posFloats.append(c.z)
                for _ in 0..<3 {
                    normFloats.append(face.x); normFloats.append(face.y); normFloats.append(face.z)
                }
            }
            let vCount = posFloats.count / 3
            guard vCount >= 3 else { continue }
            let indices = [UInt32](0..<UInt32(vCount))
            let posData = posFloats.withUnsafeBufferPointer { Data(buffer: $0) }
            let normData = normFloats.withUnsafeBufferPointer { Data(buffer: $0) }
            let idxData = indices.withUnsafeBufferPointer { Data(buffer: $0) }
            let vSource = SCNGeometrySource(data: posData, semantic: .vertex, vectorCount: vCount, usesFloatComponents: true,
                                            componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 0, dataStride: 12)
            let nSource = SCNGeometrySource(data: normData, semantic: .normal, vectorCount: vCount, usesFloatComponents: true,
                                            componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 0, dataStride: 12)
            let element = SCNGeometryElement(data: idxData, primitiveType: .triangles, primitiveCount: vCount / 3, bytesPerIndex: 4)
            geometry = SCNGeometry(sources: [vSource, nSource], elements: [element])
            geometry.materials = [material(mesh.colours.first ?? nil)]
        } else {
            var groups: [SIMD4<Float>?: (colour: SIMD4<Float>?, first: UInt32, indices: [UInt32])] = [:]
            for (n, t) in mesh.triangles.enumerated() {
                let i0 = Int(t.x), i1 = Int(t.y), i2 = Int(t.z)
                guard i0 < pCount, i1 < pCount, i2 < pCount else { continue }
                let a = mesh.positions[i0], b = mesh.positions[i1], c = mesh.positions[i2]
                let cross = simd_cross(b - a, c - a)
                let len2 = simd_length_squared(cross)
                let face = len2 > 1e-20 ? cross * (1.0 / sqrt(len2)) : SIMD3<Float>(0, 0, 1)
                let base = UInt32(posFloats.count / 3)
                posFloats.append(a.x); posFloats.append(a.y); posFloats.append(a.z)
                posFloats.append(b.x); posFloats.append(b.y); posFloats.append(b.z)
                posFloats.append(c.x); posFloats.append(c.y); posFloats.append(c.z)
                for _ in 0..<3 {
                    normFloats.append(face.x); normFloats.append(face.y); normFloats.append(face.z)
                }
                let colour = mesh.colours[safe: n] ?? nil
                if groups[colour] == nil {
                    groups[colour] = (colour, base, [base, base + 1, base + 2])
                } else {
                    groups[colour]!.indices.append(contentsOf: [base, base + 1, base + 2])
                }
            }
            let vCount = posFloats.count / 3
            guard vCount >= 3 else { continue }
            let ordered = groups.values.sorted { $0.first < $1.first }
            let posData = posFloats.withUnsafeBufferPointer { Data(buffer: $0) }
            let normData = normFloats.withUnsafeBufferPointer { Data(buffer: $0) }
            let vSource = SCNGeometrySource(data: posData, semantic: .vertex, vectorCount: vCount, usesFloatComponents: true,
                                            componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 0, dataStride: 12)
            let nSource = SCNGeometrySource(data: normData, semantic: .normal, vectorCount: vCount, usesFloatComponents: true,
                                            componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 0, dataStride: 12)
            let elements = ordered.map { group -> SCNGeometryElement in
                let idxData = group.indices.withUnsafeBufferPointer { Data(buffer: $0) }
                return SCNGeometryElement(data: idxData, primitiveType: .triangles, primitiveCount: group.indices.count / 3, bytesPerIndex: 4)
            }
            geometry = SCNGeometry(sources: [vSource, nSource], elements: elements)
            geometry.materials = ordered.map { material($0.colour) }
        }

        let node = SCNNode(geometry: geometry)
        if inlay == .underside {
            node.name = (mesh.name ?? "") + undersideInlayMarker
            node.simdPosition.z = -0.015
        } else if inlay == .top {
            node.name = mesh.name
            node.simdPosition.z = 0.015
        } else {
            node.name = mesh.name
        }
        holder.addChildNode(node)
    }
    return holder
}

/// Splits single-material non-inlay meshes containing multiple disconnected solids (`53a48b5e`, `874333ab` box + lid)
/// so each solid gets studio value separation, amphitheater ordering, and isolated inset framing.
private func splitConnectedComponentsIfHelpful(_ holder: SCNNode, baseRGB: SIMD3<Float>) {
    var geomNodes: [SCNNode] = []
    holder.enumerateHierarchy { node, _ in
        if node.geometry != nil { geomNodes.append(node) }
    }
    guard geomNodes.count <= 3 else { return }
    var stepCounter = 0
    for targetNode in geomNodes {
        guard let geom = targetNode.geometry, geom.elements.count == 1,
              !(targetNode.name ?? "").contains(undersideInlayMarker) else { continue }
        let localTris = readGeometryTriangles(geom, transform: matrix_identity_float4x4)
        guard localTris.count >= 4, localTris.count <= 50_000 else { continue }
        let groups = connectedTriangleGroups(localTris)
        guard groups.count >= 2 && groups.count <= 32 else { stepCounter += 1; continue }

        let parent = targetNode.parent ?? holder
        let baseTransform = targetNode.simdTransform
        let origName = targetNode.name
        targetNode.removeFromParentNode()
        for triIndices in groups {
            var posFloats = [Float]()
            var normFloats = [Float]()
            posFloats.reserveCapacity(triIndices.count * 9)
            normFloats.reserveCapacity(triIndices.count * 9)
            for ti in triIndices {
                let tri = localTris[ti]
                let cross = simd_cross(tri.b - tri.a, tri.c - tri.a)
                let len2 = simd_length_squared(cross)
                let face = len2 > 1e-20 ? cross * (1.0 / sqrt(len2)) : SIMD3<Float>(0, 0, 1)
                for p in [tri.a, tri.b, tri.c] {
                    posFloats.append(p.x); posFloats.append(p.y); posFloats.append(p.z)
                    normFloats.append(face.x); normFloats.append(face.y); normFloats.append(face.z)
                }
            }
            let vCount = posFloats.count / 3
            guard vCount >= 3 else { continue }
            let indices = [UInt32](0..<UInt32(vCount))
            let vSource = SCNGeometrySource(data: posFloats.withUnsafeBufferPointer { Data(buffer: $0) }, semantic: .vertex,
                                            vectorCount: vCount, usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 0, dataStride: 12)
            let nSource = SCNGeometrySource(data: normFloats.withUnsafeBufferPointer { Data(buffer: $0) }, semantic: .normal,
                                            vectorCount: vCount, usesFloatComponents: true, componentsPerVector: 3, bytesPerComponent: 4, dataOffset: 0, dataStride: 12)
            let element = SCNGeometryElement(data: indices.withUnsafeBufferPointer { Data(buffer: $0) }, primitiveType: .triangles,
                                             primitiveCount: vCount / 3, bytesPerIndex: 4)
            let subGeom = SCNGeometry(sources: [vSource, nSource], elements: [element])
            subGeom.materials = [makePlasticMaterial(rgb: steppedRGB(baseRGB, index: stepCounter))]
            stepCounter += 1
            let subNode = SCNNode(geometry: subGeom)
            subNode.name = origName
            subNode.simdTransform = baseTransform
            parent.addChildNode(subNode)
        }
    }
}

/// The model's nodes, turned Y up when requested, with physical plastic shading for parts and unlit `.constant` for scans.
private func loadNode(_ url: URL, zUp: Bool, tint: NSColor?, own: Bool, lightStage: Bool) throws -> SCNNode {
    if url.pathExtension.lowercased() == "3mf" {
        let node = try threeMFNode(url, tint: tint, lightStage: lightStage)
        splitConnectedComponentsIfHelpful(node, baseRGB: plasticRGB(tint, lightStage: lightStage))
        if zUp {
            node.simdTransform = simd_float4x4(simd_quatf(angle: -.pi / 2, axis: SIMD3<Float>(1, 0, 0)))
        }
        return node
    }
    let asset = MDLAsset(url: url)
    asset.loadTextures()
    let scene = SCNScene(mdlAsset: asset)
    let holder = SCNNode()
    for child in scene.rootNode.childNodes { child.removeFromParentNode(); holder.addChildNode(child) }
    let baseRGB = plasticRGB(tint, lightStage: lightStage)
    var bodyIdx = 0
    holder.enumerateHierarchy { node, _ in
        guard let materials = node.geometry?.materials, !materials.isEmpty else { return }
        let rgb = bodyIdx > 0 ? steppedRGB(baseRGB, index: bodyIdx) : baseRGB
        bodyIdx += 1
        for material in materials {
            material.isDoubleSided = true
            if own {
                // A scan's texture already carries the light it was photographed in: shown as photographed.
                material.lightingModel = .constant
            } else {
                material.lightingModel = .physicallyBased
                material.diffuse.contents = NSColor(srgbRed: CGFloat(rgb.x), green: CGFloat(rgb.y), blue: CGFloat(rgb.z), alpha: 1)
                material.roughness.contents = 0.46
                material.metalness.contents = 0.0
            }
        }
    }
    if !own {
        splitConnectedComponentsIfHelpful(holder, baseRGB: baseRGB)
    }
    if zUp {
        holder.simdTransform = simd_float4x4(simd_quatf(angle: -.pi / 2, axis: SIMD3<Float>(1, 0, 0)))
    }
    return holder
}

private func luminance(_ colour: NSColor?) -> CGFloat {
    guard let rgb = colour?.usingColorSpace(.sRGB) else { return 0.5 }
    return 0.2126 * rgb.redComponent + 0.7152 * rgb.greenComponent + 0.0722 * rgb.blueComponent
}

/// The stage never changes mode for a filament colour. Dark parts are lifted in their material instead.
public func wantsLightStage(_ colour: NSColor?) -> Bool { false }

// MARK: - Scene Geometry Extraction & Component Analysis

private struct WorldTri {
    var a: SIMD3<Float>
    var b: SIMD3<Float>
    var c: SIMD3<Float>
}

private struct SceneBody {
    var node: SCNNode
    var lo: SIMD3<Float>
    var hi: SIMD3<Float>
    var area: Double
    var centroid: SIMD3<Double>
    var isHeroSeat: Bool
    var isUndersideInlay: Bool
    var triangles: [WorldTri]

    var span: SIMD3<Float> { hi - lo }
    var diag: Float { simd_length(hi - lo) }
}

private func readGeometryTriangles(_ geometry: SCNGeometry, transform: simd_float4x4) -> [WorldTri] {
    guard let vSource = geometry.sources(for: .vertex).first, vSource.vectorCount > 0, vSource.componentsPerVector >= 3 else {
        return []
    }
    let vCount = vSource.vectorCount
    let stride = vSource.dataStride
    let offset = vSource.dataOffset
    let bpc = vSource.bytesPerComponent
    let c0 = SIMD3<Float>(transform.columns.0.x, transform.columns.0.y, transform.columns.0.z)
    let c1 = SIMD3<Float>(transform.columns.1.x, transform.columns.1.y, transform.columns.1.z)
    let c2 = SIMD3<Float>(transform.columns.2.x, transform.columns.2.y, transform.columns.2.z)
    let c3 = SIMD3<Float>(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)

    var verts = [SIMD3<Float>]()
    verts.reserveCapacity(vCount)
    vSource.data.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return }
        if vSource.usesFloatComponents && bpc == 4 {
            for i in 0..<vCount {
                let p = base.advanced(by: offset + i * stride).assumingMemoryBound(to: Float.self)
                let v = SIMD3<Float>(p[0], p[1], p[2])
                verts.append(c0 * v.x + c1 * v.y + c2 * v.z + c3)
            }
        } else if vSource.usesFloatComponents && bpc == 8 {
            for i in 0..<vCount {
                let p = base.advanced(by: offset + i * stride).assumingMemoryBound(to: Double.self)
                let v = SIMD3<Float>(Float(p[0]), Float(p[1]), Float(p[2]))
                verts.append(c0 * v.x + c1 * v.y + c2 * v.z + c3)
            }
        }
    }
    guard verts.count == vCount else { return [] }

    var tris = [WorldTri]()
    let totalPrims = geometry.elements.reduce(0) { $0 + ($1.primitiveType == .triangles ? $1.primitiveCount : 0) }
    tris.reserveCapacity(totalPrims)
    for elem in geometry.elements where elem.primitiveType == .triangles && elem.primitiveCount > 0 {
        let bpi = elem.bytesPerIndex
        let pCount = elem.primitiveCount
        elem.data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            @inline(__always)
            func idx(_ k: Int) -> Int {
                switch bpi {
                case 1: return Int(base.load(fromByteOffset: k, as: UInt8.self))
                case 2: return Int(base.load(fromByteOffset: k * 2, as: UInt16.self))
                case 4: return Int(base.load(fromByteOffset: k * 4, as: UInt32.self))
                case 8: return Int(truncatingIfNeeded: base.load(fromByteOffset: k * 8, as: UInt64.self))
                default: return -1
                }
            }
            for t in 0..<pCount {
                let i0 = idx(t * 3), i1 = idx(t * 3 + 1), i2 = idx(t * 3 + 2)
                guard i0 >= 0, i0 < vCount, i1 >= 0, i1 < vCount, i2 >= 0, i2 < vCount else { continue }
                let a = verts[i0], b = verts[i1], c = verts[i2]
                guard a.x.isFinite && a.y.isFinite && a.z.isFinite &&
                      b.x.isFinite && b.y.isFinite && b.z.isFinite &&
                      c.x.isFinite && c.y.isFinite && c.z.isFinite else { continue }
                tris.append(WorldTri(a: a, b: b, c: c))
            }
        }
    }
    return tris
}

private func connectedTriangleGroups(_ tris: [WorldTri]) -> [[Int]] {
    guard !tris.isEmpty else { return [] }
    var lo = SIMD3<Float>(repeating: .infinity), hi = SIMD3<Float>(repeating: -.infinity)
    for t in tris {
        lo = simd_min(lo, simd_min(t.a, simd_min(t.b, t.c)))
        hi = simd_max(hi, simd_max(t.a, simd_max(t.b, t.c)))
    }
    let diag = max(simd_length(hi - lo), 1e-5)
    let quantScale = 10_000.0 / diag
    var parent = Array(0..<tris.count)
    @inline(__always)
    func find(_ x: Int) -> Int {
        var r = x
        while parent[r] != r { r = parent[r] }
        var c = x
        while parent[c] != r { let next = parent[c]; parent[c] = r; c = next }
        return r
    }
    @inline(__always)
    func unite(_ a: Int, _ b: Int) {
        let ra = find(a), rb = find(b)
        if ra < rb { parent[rb] = ra } else if rb < ra { parent[ra] = rb }
    }
    var vertexOwner: [SIMD3<Int32>: Int] = [:]
    vertexOwner.reserveCapacity(tris.count)
    for (ti, t) in tris.enumerated() {
        for p in [t.a, t.b, t.c] {
            let key = SIMD3<Int32>(
                Int32(clamping: Int64(((p.x - lo.x) * quantScale).rounded())),
                Int32(clamping: Int64(((p.y - lo.y) * quantScale).rounded())),
                Int32(clamping: Int64(((p.z - lo.z) * quantScale).rounded()))
            )
            if let prev = vertexOwner[key] {
                unite(ti, prev)
            } else {
                vertexOwner[key] = ti
            }
        }
    }
    var buckets: [Int: [Int]] = [:]
    for ti in tris.indices {
        buckets[find(ti), default: []].append(ti)
    }
    return buckets.keys.sorted().map { buckets[$0]! }
}

private func makeBody(node: SCNNode, triangles: [WorldTri], isHeroSeat: Bool, isUndersideInlay: Bool) -> SceneBody? {
    guard !triangles.isEmpty else { return nil }
    var lo = SIMD3<Float>(repeating: .infinity), hi = SIMD3<Float>(repeating: -.infinity)
    var areaSum = 0.0
    var weightedCentroid = SIMD3<Double>.zero
    for t in triangles {
        lo = simd_min(lo, simd_min(t.a, simd_min(t.b, t.c)))
        hi = simd_max(hi, simd_max(t.a, simd_max(t.b, t.c)))
        let area = 0.5 * Double(simd_length(simd_cross(t.b - t.a, t.c - t.a)))
        areaSum += area
        let mid = (SIMD3<Double>(t.a) + SIMD3<Double>(t.b) + SIMD3<Double>(t.c)) / 3.0
        weightedCentroid += mid * area
    }
    let fallbackMid = SIMD3<Double>(lo + hi) * 0.5
    let centroid = areaSum > 1e-12 ? weightedCentroid / areaSum : fallbackMid
    return SceneBody(node: node, lo: lo, hi: hi, area: areaSum, centroid: centroid,
                     isHeroSeat: isHeroSeat, isUndersideInlay: isUndersideInlay, triangles: triangles)
}

private func extractSceneBodies(from root: SCNNode) -> [SceneBody] {
    var rawBodies: [SceneBody] = []
    func visit(_ node: SCNNode, parentWorld: simd_float4x4, inheritedSeat: Bool) {
        guard !node.isHidden else { return }
        let world = parentWorld * simd_float4x4(node.transform)
        let name = node.name ?? ""
        let isSeat = inheritedSeat || name.contains(heroSeatMarker)
        let isUnderside = name.contains(undersideInlayMarker)
        if let geom = node.geometry {
            let tris = readGeometryTriangles(geom, transform: world)
            if !tris.isEmpty, let body = makeBody(node: node, triangles: tris, isHeroSeat: isSeat, isUndersideInlay: isUnderside) {
                rawBodies.append(body)
            }
        }
        for child in node.childNodes {
            visit(child, parentWorld: world, inheritedSeat: isSeat)
        }
    }
    visit(root, parentWorld: matrix_identity_float4x4, inheritedSeat: false)

    // Split disconnected sub-solids up to 40k triangles per mesh (e.g. a box + separate lid exported as one <object>, or stray scan crumbs)
    // in memory for view selection, amphitheater ordering, and inset framing without mutating textured geometry.
    if rawBodies.count <= 4 {
        var expanded: [SceneBody] = []
        for body in rawBodies {
            if !body.isUndersideInlay && body.triangles.count <= 40_000 {
                let groups = connectedTriangleGroups(body.triangles)
                if groups.count >= 2 && groups.count <= 32 {
                    for idxs in groups {
                        if let sub = makeBody(node: body.node, triangles: idxs.map { body.triangles[$0] },
                                              isHeroSeat: body.isHeroSeat, isUndersideInlay: false) {
                            expanded.append(sub)
                        }
                    }
                    continue
                }
            }
            expanded.append(body)
        }
        rawBodies = expanded
    }

    guard rawBodies.count >= 2 else { return rawBodies }
    let totalArea = rawBodies.reduce(0.0) { $0 + $1.area }
    guard let largest = rawBodies.max(by: { $0.area < $1.area }), totalArea > 0 else { return rawBodies }
    let mainDiag = max(largest.diag, 1e-5)

    let filtered = rawBodies.filter { body in
        if body.isHeroSeat || body.isUndersideInlay { return true }
        if body.area >= totalArea * 0.002 || body.diag >= mainDiag * 0.06 { return true }
        // Tiny speck: keep if it sits right next to or inside the primary body, drop if it's an isolated outlier crumb.
        let dx = max(0, max(largest.lo.x - body.hi.x, body.lo.x - largest.hi.x))
        let dy = max(0, max(largest.lo.y - body.hi.y, body.lo.y - largest.hi.y))
        let dz = max(0, max(largest.lo.z - body.hi.z, body.lo.z - largest.hi.z))
        let gap = sqrt(dx * dx + dy * dy + dz * dz)
        return gap <= mainDiag * 0.12
    }
    return filtered.isEmpty ? rawBodies : filtered
}

// MARK: - Multi-Plate Clustering & Inset Rule

private enum InsetMode {
    case none
    case multiPlateOverview(heroIndices: Set<Int>)
    case undersideInlay
}

/// Evaluates the exact second-inset rule:
/// 1. Multi-plate kit spread (`>= 6` bodies, `> 380 mm` horizontal span, primary cluster `< 62%` of total horizontal span).
/// 2. Flush underside build-plate inlay (`lo.z` inlaid lid/base graphic hidden from all above-horizon views).
private func chooseInsetMode(for bodies: [SceneBody]) -> InsetMode {
    if bodies.contains(where: \.isUndersideInlay) {
        return .undersideInlay
    }
    guard bodies.count >= 6 else { return .none }
    var lo = SIMD3<Float>(repeating: .infinity), hi = SIMD3<Float>(repeating: -.infinity)
    for b in bodies { lo = simd_min(lo, b.lo); hi = simd_max(hi, b.hi) }
    let totalHorizDiag = hypot(hi.x - lo.x, hi.z - lo.z)
    guard totalHorizDiag > 380.0 else { return .none }

    let gapLimit: Float = 45.0
    var parent = Array(0..<bodies.count)
    func find(_ x: Int) -> Int {
        var r = x
        while parent[r] != r { r = parent[r] }
        return r
    }
    for i in 0..<bodies.count {
        for j in (i + 1)..<bodies.count {
            let dx = max(0, max(bodies[i].lo.x - bodies[j].hi.x, bodies[j].lo.x - bodies[i].hi.x))
            let dz = max(0, max(bodies[i].lo.z - bodies[j].hi.z, bodies[j].lo.z - bodies[i].hi.z))
            if hypot(dx, dz) <= gapLimit {
                let ri = find(i), rj = find(j)
                if ri < rj { parent[rj] = ri } else if rj < ri { parent[ri] = rj }
            }
        }
    }
    var clusters: [Int: [Int]] = [:]
    for i in 0..<bodies.count { clusters[find(i), default: []].append(i) }
    guard clusters.count >= 2 else { return .none }

    let bestCluster = clusters.values.max { a, b in
        let areaA = a.reduce(0.0) { $0 + bodies[$1].area }
        let areaB = b.reduce(0.0) { $0 + bodies[$1].area }
        return areaA < areaB
    }!
    var cLo = SIMD3<Float>(repeating: .infinity), cHi = SIMD3<Float>(repeating: -.infinity)
    for idx in bestCluster { cLo = simd_min(cLo, bodies[idx].lo); cHi = simd_max(cHi, bodies[idx].hi) }
    let heroHorizDiag = hypot(cHi.x - cLo.x, cHi.z - cLo.z)
    guard heroHorizDiag < totalHorizDiag * 0.62 else { return .none }
    return .multiPlateOverview(heroIndices: Set(bestCluster))
}

// MARK: - Shape-Driven View Selection (3D PCA + Z-Buffer Cavity/Relief + Amphitheater)

/// Exact symmetric 3×3 eigendecomposition via deterministic Jacobi rotations; returns unit eigenvectors paired with spans.
private func symmetricEigen3x3(_ cov: simd_double3x3) -> [SIMD3<Double>] {
    var a = cov
    var v = matrix_identity_double3x3
    for _ in 0..<18 {
        var p = 0, q = 1
        var maxOff = abs(a[0][1])
        if abs(a[0][2]) > maxOff { maxOff = abs(a[0][2]); p = 0; q = 2 }
        if abs(a[1][2]) > maxOff { maxOff = abs(a[1][2]); p = 1; q = 2 }
        if maxOff < 1e-13 { break }
        let app = a[p][p], aqq = a[q][q], apq = a[p][q]
        let tau = (aqq - app) / (2.0 * apq)
        let t = tau >= 0 ? 1.0 / (tau + hypot(1.0, tau)) : -1.0 / (-tau + hypot(1.0, tau))
        let c = 1.0 / hypot(1.0, t)
        let s = t * c
        a[p][p] = app - t * apq
        a[q][q] = aqq + t * apq
        a[p][q] = 0; a[q][p] = 0
        for r in 0..<3 where r != p && r != q {
            let arp = a[r][p], arq = a[r][q]
            a[r][p] = c * arp - s * arq; a[p][r] = a[r][p]
            a[r][q] = s * arp + c * arq; a[q][r] = a[r][q]
        }
        for r in 0..<3 {
            let vrp = v[p][r], vrq = v[q][r]
            v[p][r] = c * vrp - s * vrq
            v[q][r] = s * vrp + c * vrq
        }
    }
    return [simd_normalize(v.columns.0), simd_normalize(v.columns.1), simd_normalize(v.columns.2)]
}

private struct SampledTri {
    var a: SIMD3<Double>
    var b: SIMD3<Double>
    var c: SIMD3<Double>
    var centroid: SIMD3<Double>
    var normal: SIMD3<Double>
    var area: Double
    var bodyIndex: Int
    var heroBonus: Double
}

private func lookBasis(fromTargetToEye viewDir: SIMD3<Double>) -> (r: SIMD3<Double>, u: SIMD3<Double>, v: SIMD3<Double>) {
    let v = simd_normalize(viewDir)
    let upRef = abs(v.y) < 0.985 ? SIMD3<Double>(0, 1, 0) : SIMD3<Double>(0, 0, 1)
    let r = simd_normalize(simd_cross(upRef, v))
    let u = simd_normalize(simd_cross(v, r))
    return (r, u, v)
}

/// Scores a candidate view direction using a miniature 24×24 orthographic Z-buffer for true visible cavity/relief depth,
/// visible normal diversity, seated-object visibility, and multi-body unoccluded distinctness.
private func scoreCandidateView(_ viewDir: SIMD3<Double>, samples: [SampledTri], bodies: [SceneBody], meanCenter: SIMD3<Double>) -> Double {
    let (r, u, v) = lookBasis(fromTargetToEye: viewDir)
    var minX = Double.infinity, maxX = -Double.infinity
    var minY = Double.infinity, maxY = -Double.infinity
    var minZ = Double.infinity, maxZ = -Double.infinity
    for b in bodies {
        for cx in [Double(b.lo.x), Double(b.hi.x)] {
            for cy in [Double(b.lo.y), Double(b.hi.y)] {
                for cz in [Double(b.lo.z), Double(b.hi.z)] {
                    let p = SIMD3<Double>(cx, cy, cz)
                    let px = simd_dot(p, r), py = simd_dot(p, u), pz = simd_dot(p, v)
                    if px < minX { minX = px }; if px > maxX { maxX = px }
                    if py < minY { minY = py }; if py > maxY { maxY = py }
                    if pz < minZ { minZ = pz }; if pz > maxZ { maxZ = pz }
                }
            }
        }
    }
    let spanX = max(maxX - minX, 1e-6)
    let spanY = max(maxY - minY, 1e-6)
    let spanZ = max(maxZ - minZ, 1e-6)

    let gridN = 24
    let cellCount = gridN * gridN
    var zBuf = [Double](repeating: -Double.infinity, count: cellCount)
    var nBuf = [SIMD3<Double>](repeating: .zero, count: cellCount)
    var bodyBuf = [Int](repeating: -1, count: cellCount)
    var heroBuf = [Double](repeating: 0, count: cellCount)

    let scaleX = Double(gridN - 1) / spanX
    let scaleY = Double(gridN - 1) / spanY

    for tri in samples {
        let ax = (simd_dot(tri.a, r) - minX) * scaleX, ay = (simd_dot(tri.a, u) - minY) * scaleY, az = simd_dot(tri.a, v)
        let bx = (simd_dot(tri.b, r) - minX) * scaleX, by = (simd_dot(tri.b, u) - minY) * scaleY, bz = simd_dot(tri.b, v)
        let cx = (simd_dot(tri.c, r) - minX) * scaleX, cy = (simd_dot(tri.c, u) - minY) * scaleY, cz = simd_dot(tri.c, v)

        let ix0 = max(0, min(gridN - 1, Int(min(ax, min(bx, cx)).rounded(.down))))
        let ix1 = max(0, min(gridN - 1, Int(max(ax, max(bx, cx)).rounded(.up))))
        let iy0 = max(0, min(gridN - 1, Int(min(ay, min(by, cy)).rounded(.down))))
        let iy1 = max(0, min(gridN - 1, Int(max(ay, max(by, cy)).rounded(.up))))

        let orientedNormal = simd_dot(tri.normal, v) >= 0 ? tri.normal : -tri.normal

        if ix0 == ix1 && iy0 == iy1 {
            let z = (az + bz + cz) / 3.0
            let idx = iy0 * gridN + ix0
            if z > zBuf[idx] {
                zBuf[idx] = z; nBuf[idx] = orientedNormal; bodyBuf[idx] = tri.bodyIndex; heroBuf[idx] = tri.heroBonus
            }
            continue
        }

        let denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(denom) < 1e-9 {
            let mx = max(0, min(gridN - 1, Int(((ax + bx + cx) / 3.0).rounded())))
            let my = max(0, min(gridN - 1, Int(((ay + by + cy) / 3.0).rounded())))
            let z = (az + bz + cz) / 3.0
            let idx = my * gridN + mx
            if z > zBuf[idx] {
                zBuf[idx] = z; nBuf[idx] = orientedNormal; bodyBuf[idx] = tri.bodyIndex; heroBuf[idx] = tri.heroBonus
            }
            continue
        }
        let invDenom = 1.0 / denom
        for iy in iy0...iy1 {
            let py = Double(iy)
            for ix in ix0...ix1 {
                let px = Double(ix)
                let w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) * invDenom
                let w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) * invDenom
                let w2 = 1.0 - w0 - w1
                if w0 >= -0.18 && w1 >= -0.18 && w2 >= -0.18 {
                    let z = w0 * az + w1 * bz + w2 * cz
                    let idx = iy * gridN + ix
                    if z > zBuf[idx] {
                        zBuf[idx] = z; nBuf[idx] = orientedNormal; bodyBuf[idx] = tri.bodyIndex; heroBuf[idx] = tri.heroBonus
                    }
                }
            }
        }
    }

    var occupied = 0
    var normalSum = SIMD3<Double>.zero
    var reliefSum = 0.0
    var reliefPairs = 0
    var zVisMax = -Double.infinity
    var zVisSum = 0.0
    var heroHits = 0.0
    var seenBodies = Set<Int>()
    for iy in 0..<gridN {
        for ix in 0..<gridN {
            let idx = iy * gridN + ix
            guard bodyBuf[idx] >= 0 else { continue }
            occupied += 1
            let z = zBuf[idx]
            if z > zVisMax { zVisMax = z }
            zVisSum += z
            normalSum += nBuf[idx]
            heroHits += heroBuf[idx]
            seenBodies.insert(bodyBuf[idx])
            if ix + 1 < gridN && bodyBuf[idx + 1] >= 0 && bodyBuf[idx + 1] == bodyBuf[idx] {
                reliefSum += min(abs(z - zBuf[idx + 1]) / spanZ, 0.30)
                reliefPairs += 1
            }
            if iy + 1 < gridN && bodyBuf[idx + gridN] >= 0 && bodyBuf[idx + gridN] == bodyBuf[idx] {
                reliefSum += min(abs(z - zBuf[idx + gridN]) / spanZ, 0.30)
                reliefPairs += 1
            }
        }
    }
    guard occupied > 0 else { return 0 }
    let occ = Double(occupied)
    let normalDiversity = 1.0 - min(1.0, simd_length(normalSum / occ))
    let reliefScore = reliefPairs > 0 ? reliefSum / Double(reliefPairs) : 0
    let recessDepth = zVisMax.isFinite ? max(0.0, (zVisMax - zVisSum / occ) / spanZ) : 0
    let fillCoverage = occ / Double(cellCount)
    let heroScore = heroHits / occ
    let visibleBodiesRatio = bodies.count > 1 ? Double(seenBodies.count) / Double(bodies.count) : 1.0

    // Amphitheater row ordering on multi-object plates: shorter parts in foreground, taller parts in background.
    var amphitheater = 0.0
    if bodies.count >= 2 {
        let heights = bodies.map { Double($0.hi.y - $0.lo.y) }
        let meanH = heights.reduce(0, +) / Double(heights.count)
        let maxH = max(heights.max() ?? 1, 1e-6)
        let horizDir = simd_normalize(SIMD2<Double>(viewDir.x, viewDir.z))
        if horizDir.x.isFinite {
            var corr = 0.0
            var maxDist = 1e-6
            for b in bodies {
                maxDist = max(maxDist, hypot(b.centroid.x - meanCenter.x, b.centroid.z - meanCenter.z))
            }
            for (i, b) in bodies.enumerated() {
                let relH = (heights[i] - meanH) / maxH
                let frontPos = ((b.centroid.x - meanCenter.x) * horizDir.x + (b.centroid.z - meanCenter.z) * horizDir.y) / maxDist
                corr += -relH * frontPos
            }
            amphitheater = corr / Double(bodies.count)
        }
    }

    // Gentle convention tie-breaker toward front-right (+Z, +X) when a part is symmetric.
    let studioTieBreak = 0.012 * (0.75 * viewDir.z + 0.45 * viewDir.x)

    return 1.35 * normalDiversity +
           2.20 * reliefScore +
           1.45 * recessDepth +
           0.55 * fillCoverage +
           1.80 * visibleBodiesRatio +
           1.05 * amphitheater +
           2.20 * heroScore +
           studioTieBreak
}

private func chooseShapeView(for bodies: [SceneBody]) -> SIMD3<Double> {
    let totalTris = bodies.reduce(0) { $0 + $1.triangles.count }
    guard totalTris > 0 else { return simd_normalize(SIMD3<Double>(0.55, 0.50, 1.0)) }

    let sampleStride = max(1, totalTris / 6_000)
    var samples = [SampledTri]()
    samples.reserveCapacity(min(totalTris, 6_500))

    var areaTotal = 0.0
    var mean = SIMD3<Double>.zero
    var globalCounter = 0
    for (bi, body) in bodies.enumerated() {
        let bonus = body.isHeroSeat ? 1.0 : 0.0
        for t in body.triangles {
            defer { globalCounter += 1 }
            guard globalCounter % sampleStride == 0 else { continue }
            let a = SIMD3<Double>(t.a), b = SIMD3<Double>(t.b), c = SIMD3<Double>(t.c)
            let cross = simd_cross(b - a, c - a)
            let doubleArea = simd_length(cross)
            guard doubleArea > 1e-14 else { continue }
            let area = 0.5 * doubleArea
            let mid = (a + b + c) / 3.0
            let n = cross / doubleArea
            samples.append(SampledTri(a: a, b: b, c: c, centroid: mid, normal: n, area: area, bodyIndex: bi, heroBonus: bonus))
            areaTotal += area
            mean += mid * area
        }
    }
    guard !samples.isEmpty, areaTotal > 0 else { return simd_normalize(SIMD3<Double>(0.55, 0.50, 1.0)) }
    mean /= areaTotal

    // 1. Full 3D PCA to guarantee thin flat parts (in ANY orientation: lying flat, standing on edge, or tilted) are NEVER edge-on.
    var cov3 = simd_double3x3(0)
    for s in samples {
        let d = s.centroid - mean
        let w = s.area / areaTotal
        cov3.columns.0 += SIMD3<Double>(d.x * d.x, d.y * d.x, d.z * d.x) * w
        cov3.columns.1 += SIMD3<Double>(d.x * d.y, d.y * d.y, d.z * d.y) * w
        cov3.columns.2 += SIMD3<Double>(d.x * d.z, d.y * d.z, d.z * d.z) * w
    }
    let rawAxes = symmetricEigen3x3(cov3)
    let axesWithSpans: [(axis: SIMD3<Double>, span: Double)] = rawAxes.map { axis in
        var lo = Double.infinity, hi = -Double.infinity
        for s in samples {
            for p in [s.a, s.b, s.c] {
                let proj = simd_dot(p, axis)
                if proj < lo { lo = proj }; if proj > hi { hi = proj }
            }
        }
        return (axis, max(hi - lo, 1e-8))
    }.sorted { $0.span > $1.span }

    let e1 = axesWithSpans[0].axis, s1 = axesWithSpans[0].span
    let e2 = axesWithSpans[1].axis, s2 = axesWithSpans[1].span
    let e3 = axesWithSpans[2].axis, s3 = axesWithSpans[2].span
    _ = s1

    if s3 / max(s2, 1e-8) < 0.16 {
        // Thin-sheet invariant: keep |viewDir · e3| >= 0.78 (~58° open when horizontal, broadside 3/4 when vertical/tilted).
        if abs(e3.y) > 0.65 {
            let nUp = e3.y >= 0 ? e3 : -e3
            var h1 = SIMD3<Double>(e1.x, 0, e1.z)
            h1 = simd_length(h1) > 1e-5 ? simd_normalize(h1) : SIMD3<Double>(1, 0, 0)
            let h2 = SIMD3<Double>(-h1.z, 0, h1.x)
            let elev = 58.0 * Double.pi / 180.0
            var bestDir = simd_normalize(sin(elev) * nUp + cos(elev) * simd_normalize(0.82 * h2 + 0.57 * h1))
            var bestScore = -Double.infinity
            for sA in [-1.0, 1.0] {
                for sB in [-1.0, 1.0] {
                    let horiz = simd_normalize(0.82 * (sA * h2) + 0.57 * (sB * h1))
                    let cand = simd_normalize(sin(elev) * nUp + cos(elev) * horiz)
                    let sc = scoreCandidateView(cand, samples: samples, bodies: bodies, meanCenter: mean)
                    if sc > bestScore { bestScore = sc; bestDir = cand }
                }
            }
            return bestDir
        } else {
            var hAlong = SIMD3<Double>(e1.x, 0, e1.z)
            if simd_length(hAlong) < 1e-5 { hAlong = SIMD3<Double>(e2.x, 0, e2.z) }
            hAlong = simd_length(hAlong) > 1e-5 ? simd_normalize(hAlong) : SIMD3<Double>(1, 0, 0)
            var bestDir = simd_normalize(0.86 * (e3.z >= 0 ? e3 : -e3) + SIMD3<Double>(0, 0.36, 0) + 0.26 * hAlong)
            var bestScore = -Double.infinity
            for signFace in [-1.0, 1.0] {
                let face = signFace * e3
                for signHoriz in [-1.0, 1.0] {
                    var cand = simd_normalize(0.86 * face + SIMD3<Double>(0, 0.38, 0) + 0.25 * (signHoriz * hAlong))
                    if cand.y < 0.30 {
                        cand = simd_normalize(SIMD3<Double>(cand.x, 0.34, cand.z))
                    }
                    guard abs(simd_dot(cand, e3)) >= 0.72 else { continue }
                    let sc = scoreCandidateView(cand, samples: samples, bodies: bodies, meanCenter: mean)
                    if sc > bestScore { bestScore = sc; bestDir = cand }
                }
            }
            return bestDir
        }
    }

    // 2. General 3D parts & multi-object plates: horizontal 2D PCA for broadside three-quarter framing + adaptive pitch.
    var covXX = 0.0, covXZ = 0.0, covZZ = 0.0
    var worldLoY = Double.infinity, worldHiY = -Double.infinity
    for b in bodies {
        worldLoY = min(worldLoY, Double(b.lo.y))
        worldHiY = max(worldHiY, Double(b.hi.y))
    }
    for s in samples {
        let dx = s.centroid.x - mean.x, dz = s.centroid.z - mean.z
        let w = s.area / areaTotal
        covXX += dx * dx * w; covXZ += dx * dz * w; covZZ += dz * dz * w
    }
    let halfAngle = 0.5 * atan2(2.0 * covXZ, covXX - covZZ)
    let uMajor = SIMD2<Double>(cos(halfAngle), sin(halfAngle))
    let uMinor = SIMD2<Double>(-uMajor.y, uMajor.x)

    var majLo = Double.infinity, majHi = -Double.infinity
    var minLo = Double.infinity, minHi = -Double.infinity
    for b in bodies {
        for x in [Double(b.lo.x), Double(b.hi.x)] {
            for z in [Double(b.lo.z), Double(b.hi.z)] {
                let pMaj = x * uMajor.x + z * uMajor.y
                let pMin = x * uMinor.x + z * uMinor.y
                if pMaj < majLo { majLo = pMaj }; if pMaj > majHi { majHi = pMaj }
                if pMin < minLo { minLo = pMin }; if pMin > minHi { minHi = pMin }
            }
        }
    }
    let hMajor = max(majHi - majLo, 1e-6)
    let hMinor = max(minHi - minLo, 1e-6)
    let vSpan = max(worldHiY - worldLoY, 1e-6)
    let horizMean = sqrt(hMajor * hMinor)
    let flatness = horizMean / vSpan

    var elevDeg: Double
    if flatness < 0.75 {
        elevDeg = 21.0
    } else if flatness < 2.2 {
        let t = (flatness - 0.75) / (2.2 - 0.75)
        elevDeg = 23.0 + t * 12.0
    } else {
        let t = min(1.0, (flatness - 2.2) / 4.0)
        elevDeg = 35.0 + t * 9.0
    }
    if bodies.count >= 3 {
        elevDeg = max(elevDeg, 40.0)
    }
    let elevRad = elevDeg * Double.pi / 180.0
    let cosEl = cos(elevRad), sinEl = sin(elevRad)

    let yawOffsetDeg = (hMajor / hMinor > 2.1) ? 28.0 : 35.0
    let yawRad = yawOffsetDeg * Double.pi / 180.0
    let cYaw = cos(yawRad), sYaw = sin(yawRad)

    var horizCandidates: [SIMD2<Double>] = []
    for sMin in [-1.0, 1.0] {
        for sMaj in [-1.0, 1.0] {
            horizCandidates.append(simd_normalize(uMinor * (sMin * cYaw) + uMajor * (sMaj * sYaw)))
        }
    }
    // When horizontal footprint is nearly square, also test cardinal diagonals relative to principal axes.
    if hMajor / hMinor < 1.32 {
        for sMin in [-1.0, 1.0] {
            horizCandidates.append(simd_normalize(uMinor * (sMin * 0.96) + uMajor * 0.28))
        }
        for sMaj in [-1.0, 1.0] {
            horizCandidates.append(simd_normalize(uMajor * (sMaj * 0.96) + uMinor * 0.28))
        }
    }

    var bestDir = SIMD3<Double>(horizCandidates[0].x * cosEl, sinEl, horizCandidates[0].y * cosEl)
    var bestScore = -Double.infinity
    for h in horizCandidates {
        let cand = simd_normalize(SIMD3<Double>(h.x * cosEl, sinEl, h.y * cosEl))
        let sc = scoreCandidateView(cand, samples: samples, bodies: bodies, meanCenter: mean)
        if sc > bestScore {
            bestScore = sc
            bestDir = cand
        }
    }
    return bestDir
}

// MARK: - Exact 2D Perspective Silhouette Fit

private struct CameraPlacement {
    var eye: SIMD3<Double>
    var target: SIMD3<Double>
    var r: SIMD3<Double>
    var u: SIMD3<Double>
    var v: SIMD3<Double>
    var dist: Double
    var visibleRadius: Double
    var zNear: Double
    var zFar: Double
}

private func collectFramingVertices(from bodies: [SceneBody], basis: (r: SIMD3<Double>, u: SIMD3<Double>, v: SIMD3<Double>)) -> [SIMD3<Double>] {
    let totalTris = bodies.reduce(0) { $0 + $1.triangles.count }
    let strideStep = max(1, totalTris / 40_000)
    var points = [SIMD3<Double>]()
    points.reserveCapacity(min(totalTris * 3, 125_000) + bodies.count * 24)

    // Always include exact directional extremes of every body so stride sampling on 1.1M-triangle models never clips a corner.
    var hullDirs: [SIMD3<Float>] = []
    for k in 0..<12 {
        let ang = Double(k) * (2.0 * Double.pi / 12.0)
        let dir2D = cos(ang) * basis.r + sin(ang) * basis.u
        hullDirs.append(SIMD3<Float>(Float(dir2D.x + 0.22 * basis.v.x), Float(dir2D.y + 0.22 * basis.v.y), Float(dir2D.z + 0.22 * basis.v.z)))
        hullDirs.append(SIMD3<Float>(Float(dir2D.x - 0.22 * basis.v.x), Float(dir2D.y - 0.22 * basis.v.y), Float(dir2D.z - 0.22 * basis.v.z)))
    }

    var idx = 0
    for body in bodies {
        var bestPts = [SIMD3<Float>](repeating: body.triangles[0].a, count: hullDirs.count)
        var bestDots = [Float](repeating: -.infinity, count: hullDirs.count)
        for t in body.triangles {
            if idx % strideStep == 0 {
                points.append(SIMD3<Double>(t.a))
                points.append(SIMD3<Double>(t.b))
                points.append(SIMD3<Double>(t.c))
            }
            if strideStep > 1 {
                for p in [t.a, t.b, t.c] {
                    for dIdx in hullDirs.indices {
                        let dp = simd_dot(p, hullDirs[dIdx])
                        if dp > bestDots[dIdx] { bestDots[dIdx] = dp; bestPts[dIdx] = p }
                    }
                }
            }
            idx += 1
        }
        if strideStep > 1 {
            for p in bestPts { points.append(SIMD3<Double>(p)) }
        }
    }
    return points
}

private func fitPerspectiveCamera(
    bodies: [SceneBody],
    viewDir: SIMD3<Double>,
    fovDegrees: Double = 24.0,
    targetFill: Double = 0.808
) -> CameraPlacement? {
    let basis = lookBasis(fromTargetToEye: viewDir)
    let pts = collectFramingVertices(from: bodies, basis: basis)
    guard !pts.isEmpty else { return nil }

    var lo = SIMD3<Double>(repeating: .infinity), hi = SIMD3<Double>(repeating: -.infinity)
    for p in pts { lo = simd_min(lo, p); hi = simd_max(hi, p) }
    let boxSpan = hi - lo
    let radius = 0.5 * simd_length(boxSpan)
    guard radius.isFinite, radius > 0 else { return nil }

    let tanHalf = tan(0.5 * fovDegrees * Double.pi / 180.0)
    var target = 0.5 * (lo + hi)
    var dist = (radius / tanHalf) * 1.22
    var minDepth = dist * 0.5
    var maxDepth = dist * 1.5

    for _ in 0..<8 {
        let eye = target + basis.v * dist
        var nxMin = Double.infinity, nxMax = -Double.infinity
        var nyMin = Double.infinity, nyMax = -Double.infinity
        var zMin = Double.infinity, zMax = -Double.infinity
        for p in pts {
            let rel = p - eye
            let zc = max(-simd_dot(rel, basis.v), dist * 0.02)
            if zc < zMin { zMin = zc }; if zc > zMax { zMax = zc }
            let inv = 1.0 / (zc * tanHalf)
            let nx = simd_dot(rel, basis.r) * inv
            let ny = simd_dot(rel, basis.u) * inv
            if nx < nxMin { nxMin = nx }; if nx > nxMax { nxMax = nx }
            if ny < nyMin { nyMin = ny }; if ny > nyMax { nyMax = ny }
        }
        minDepth = zMin; maxDepth = zMax
        let cx = 0.5 * (nxMin + nxMax)
        let cy = 0.5 * (nyMin + nyMax)
        let fill = 0.5 * max(nxMax - nxMin, nyMax - nyMin)
        guard fill.isFinite, fill > 1e-9 else { break }

        target += (basis.r * cx + basis.u * cy) * (dist * tanHalf)
        dist *= (fill / targetFill)
    }

    let finalEye = target + basis.v * dist
    let zNear = max(minDepth * 0.35, radius * 0.01)
    let zFar = max(maxDepth * 2.5, dist + radius * 4.0)
    return CameraPlacement(eye: finalEye, target: target, r: basis.r, u: basis.u, v: basis.v,
                           dist: dist, visibleRadius: radius, zNear: zNear, zFar: zFar)
}

private func applyCamera(_ placement: CameraPlacement, fovDegrees: Double = 24.0, to cameraNode: SCNNode) {
    let cam = cameraNode.camera ?? SCNCamera()
    cam.projectionDirection = .vertical
    cam.fieldOfView = CGFloat(fovDegrees)
    cam.zNear = placement.zNear
    cam.zFar = placement.zFar
    cameraNode.camera = cam
    cameraNode.simdTransform = simd_float4x4(columns: (
        SIMD4<Float>(Float(placement.r.x), Float(placement.r.y), Float(placement.r.z), 0),
        SIMD4<Float>(Float(placement.u.x), Float(placement.u.y), Float(placement.u.z), 0),
        SIMD4<Float>(Float(placement.v.x), Float(placement.v.y), Float(placement.v.z), 0),
        SIMD4<Float>(Float(placement.eye.x), Float(placement.eye.y), Float(placement.eye.z), 1)
    ))
}

// MARK: - Studio Environment, 3-Point Shadowed Lights & Contact Shadow

private let studioEnvironmentImage: CGImage = {
    let w = 128, h = 64
    var pixels = [UInt8](repeating: 255, count: w * h * 4)
    for y in 0..<h {
        let v = Double(y) / Double(h - 1) // 0 = zenith, 0.5 = horizon, 1 = nadir
        for x in 0..<w {
            let u = Double(x) / Double(w)
            let phi = u * 2.0 * Double.pi
            let rVal: Double, gVal: Double, bVal: Double
            if v <= 0.52 {
                let t = v / 0.52 // 0 at zenith -> 1 at horizon
                let dome = 0.88 - 0.38 * t
                let softbox = 0.14 * max(0, cos(phi - 1.1)) * (1.0 - t * 0.6)
                rVal = min(1.0, dome + softbox)
                gVal = min(1.0, (dome + softbox) * 1.01)
                bVal = min(1.0, (dome + softbox) * 1.05)
            } else {
                let t = (v - 0.52) / 0.48
                let bounce = 0.34 - 0.10 * t
                rVal = bounce; gVal = bounce * 1.01; bVal = bounce * 1.04
            }
            let o = (y * w + x) * 4
            pixels[o] = UInt8((rVal * 255).rounded())
            pixels[o + 1] = UInt8((gVal * 255).rounded())
            pixels[o + 2] = UInt8((bVal * 255).rounded())
            pixels[o + 3] = 255
        }
    }
    let ctx = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    return ctx.makeImage()!
}()

private func makeStudioLightRig(
    for placement: CameraPlacement,
    lightStage: Bool,
    darkPart: Bool,
    brightPart: Bool
) -> SCNNode {
    let rig = SCNNode()
    let scale: CGFloat = brightPart ? 0.76 : (darkPart && !lightStage ? 1.32 : 1.0)
    let rad = max(placement.visibleRadius, 1e-4)

    func orientLightNode(_ node: SCNNode, fromTargetDir dir: SIMD3<Double>, distanceFactor: Double) {
        let b = lookBasis(fromTargetToEye: dir)
        let pos = placement.target + b.v * (rad * distanceFactor)
        node.simdTransform = simd_float4x4(columns: (
            SIMD4<Float>(Float(b.r.x), Float(b.r.y), Float(b.r.z), 0),
            SIMD4<Float>(Float(b.u.x), Float(b.u.y), Float(b.u.z), 0),
            SIMD4<Float>(Float(b.v.x), Float(b.v.y), Float(b.v.z), 0),
            SIMD4<Float>(Float(pos.x), Float(pos.y), Float(pos.z), 1)
        ))
    }

    // 1. Shadowed key light from upper front-left: separates faces and casts crisp cavity/part self-shadows.
    let keyDir = simd_normalize(-0.52 * placement.r + 0.74 * placement.u + 0.43 * placement.v)
    let keyNode = SCNNode()
    let key = SCNLight()
    key.type = .directional
    key.color = NSColor(srgbRed: 1.0, green: 0.985, blue: 0.96, alpha: 1)
    key.intensity = 880 * scale
    key.castsShadow = true
    key.shadowMode = .forward
    key.shadowMapSize = CGSize(width: 2048, height: 2048)
    key.shadowRadius = 2.5
    key.shadowSampleCount = 16
    key.shadowBias = 1.5
    key.shadowColor = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: lightStage ? 0.36 : 0.42)
    key.automaticallyAdjustsShadowProjection = false
    key.orthographicScale = CGFloat(rad * 1.25)
    key.zNear = CGFloat(rad * 0.4)
    key.zFar = CGFloat(rad * 5.6)
    keyNode.light = key
    orientLightNode(keyNode, fromTargetDir: keyDir, distanceFactor: 3.0)
    rig.addChildNode(keyNode)

    // 2. Cool fill light from front-right so shadow-side facets stay legible and orthogonal faces contrast with the warm key.
    let fillDir = simd_normalize(0.76 * placement.r + 0.18 * placement.u + 0.62 * placement.v)
    let fillNode = SCNNode()
    let fill = SCNLight()
    fill.type = .directional
    fill.color = NSColor(srgbRed: 0.90, green: 0.94, blue: 1.0, alpha: 1)
    fill.intensity = (darkPart && !lightStage ? 430 : 320) * (brightPart ? 0.80 : 1.0)
    fillNode.light = fill
    orientLightNode(fillNode, fromTargetDir: fillDir, distanceFactor: 3.0)
    rig.addChildNode(fillNode)

    // 3. Rim / kicker light from upper back-right to lift silhouettes off the dark stage and define top bevels.
    let rimDir = simd_normalize(0.46 * placement.r + 0.66 * placement.u - 0.59 * placement.v)
    let rimNode = SCNNode()
    let rim = SCNLight()
    rim.type = .directional
    rim.color = NSColor(srgbRed: 0.95, green: 0.97, blue: 1.0, alpha: 1)
    let rimBase: CGFloat = lightStage ? 300 : (darkPart ? 960 : 640)
    rim.intensity = rimBase * (brightPart ? 0.75 : 1.0)
    rimNode.light = rim
    orientLightNode(rimNode, fromTargetDir: rimDir, distanceFactor: 3.0)
    rig.addChildNode(rimNode)

    return rig
}

/// Builds a soft height-weighted footprint contact-shadow plane right under the model on the stage's floor (`floorY`),
/// grounding both printed parts and `.constant`-lit USDZ scans without throwing sideways cast shadows.
private func makeContactShadowNode(for bodies: [SceneBody], lightStage: Bool) -> SCNNode? {
    guard !bodies.isEmpty else { return nil }
    var lo = SIMD3<Float>(repeating: .infinity), hi = SIMD3<Float>(repeating: -.infinity)
    for b in bodies { lo = simd_min(lo, b.lo); hi = simd_max(hi, b.hi) }
    let rawSpanX = max(hi.x - lo.x, 1e-4)
    let rawSpanY = max(hi.y - lo.y, 1e-4)
    let rawSpanZ = max(hi.z - lo.z, 1e-4)
    let horizMax = max(rawSpanX, rawSpanZ)
    let pad = horizMax * 0.10
    let minX = lo.x - pad, maxX = hi.x + pad
    let minZ = lo.z - pad, maxZ = hi.z + pad
    let spanX = maxX - minX, spanZ = maxZ - minZ
    let floorY = lo.y
    let heightCutoff = max(min(rawSpanY * 0.28, horizMax * 0.14), horizMax * 0.04)

    let texN = 128
    var density = [Float](repeating: 0, count: texN * texN)
    let totalTris = bodies.reduce(0) { $0 + $1.triangles.count }
    let strideStep = max(1, totalTris / 24_000)
    let sx = Float(texN - 1) / spanX
    let sz = Float(texN - 1) / spanZ

    var counter = 0
    for body in bodies {
        for t in body.triangles {
            defer { counter += 1 }
            guard counter % strideStep == 0 else { continue }
            let triLowY = min(t.a.y, min(t.b.y, t.c.y)) - floorY
            guard triLowY < heightCutoff else { continue }
            let normH = max(0, 1.0 - triLowY / heightCutoff)
            let weight = normH * normH

            let ax = (t.a.x - minX) * sx, az = (t.a.z - minZ) * sz
            let bx = (t.b.x - minX) * sx, bz = (t.b.z - minZ) * sz
            let cx = (t.c.x - minX) * sx, cz = (t.c.z - minZ) * sz

            let x0 = max(0, min(texN - 1, Int((min(ax, min(bx, cx)) - 0.5).rounded(.down))))
            let x1 = max(0, min(texN - 1, Int((max(ax, max(bx, cx)) + 0.5).rounded(.up))))
            let z0 = max(0, min(texN - 1, Int((min(az, min(bz, cz)) - 0.5).rounded(.down))))
            let z1 = max(0, min(texN - 1, Int((max(az, max(bz, cz)) + 0.5).rounded(.up))))

            if x0 == x1 && z0 == z1 {
                let idx = z0 * texN + x0
                if weight > density[idx] { density[idx] = weight }
                continue
            }

            let denom = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
            if abs(denom) < 1e-6 {
                // Thin vertical edge: splat conservative segment midpoint + endpoints so thin standing sheets still ground.
                for (px, pz) in [(ax, az), (bx, bz), (cx, cz), ((ax + bx + cx) / 3, (az + bz + cz) / 3)] {
                    let ix = max(0, min(texN - 1, Int(px.rounded())))
                    let iz = max(0, min(texN - 1, Int(pz.rounded())))
                    let idx = iz * texN + ix
                    if weight > density[idx] { density[idx] = weight }
                }
                continue
            }
            let invDenom = 1.0 / denom
            let edgeScale = max(hypot(bx - ax, bz - az), max(hypot(cx - bx, cz - bz), hypot(ax - cx, az - cz)))
            let tol = max(0.25, 0.65 / max(edgeScale, 1.0))
            for iz in z0...z1 {
                let pz = Float(iz)
                for ix in x0...x1 {
                    let px = Float(ix)
                    let w0 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) * invDenom
                    let w1 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) * invDenom
                    let w2 = 1.0 - w0 - w1
                    if w0 >= -tol && w1 >= -tol && w2 >= -tol {
                        let cw0 = max(0, w0), cw1 = max(0, w1), cw2 = max(0, w2)
                        let wSum = max(cw0 + cw1 + cw2, 1e-6)
                        let interpY = (cw0 * t.a.y + cw1 * t.b.y + cw2 * t.c.y) / wSum - floorY
                        guard interpY < heightCutoff else { continue }
                        let localNorm = max(0, 1.0 - interpY / heightCutoff)
                        let localWeight = localNorm * localNorm
                        let idx = iz * texN + ix
                        if localWeight > density[idx] { density[idx] = localWeight }
                    }
                }
            }
        }
    }

    // Separable [1, 2, 1]/4 tent blur for a smooth contact penumbra (tighter on dark stage so grounding reads against #14161B).
    var scratch = [Float](repeating: 0, count: texN * texN)
    let blurPasses = lightStage ? 5 : 3
    for _ in 0..<blurPasses {
        for z in 0..<texN {
            let row = z * texN
            for x in 0..<texN {
                let l = density[row + max(0, x - 1)]
                let c = density[row + x]
                let r = density[row + min(texN - 1, x + 1)]
                scratch[row + x] = 0.25 * (l + 2.0 * c + r)
            }
        }
        for z in 0..<texN {
            let zPrev = max(0, z - 1) * texN, zCur = z * texN, zNext = min(texN - 1, z + 1) * texN
            for x in 0..<texN {
                density[zCur + x] = 0.25 * (scratch[zPrev + x] + 2.0 * scratch[zCur + x] + scratch[zNext + x])
            }
        }
    }

    // Taper outer 6 texels smoothly to 0 so the plane boundary is completely invisible.
    let peakAlpha: Float = lightStage ? 0.30 : 0.84
    var rgba = [UInt8](repeating: 0, count: texN * texN * 4)
    for z in 0..<texN {
        let dzBorder = min(Float(z), Float(texN - 1 - z)) / 6.0
        for x in 0..<texN {
            let dxBorder = min(Float(x), Float(texN - 1 - x)) / 6.0
            let taper = min(1.0, min(dxBorder, dzBorder))
            let a = min(1.0, max(0.0, density[z * texN + x] * taper * peakAlpha))
            rgba[(z * texN + x) * 4 + 3] = UInt8((a * 255.0).rounded())
        }
    }
    guard let shadowCtx = CGContext(data: &rgba, width: texN, height: texN, bitsPerComponent: 8, bytesPerRow: texN * 4,
                                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let shadowImg = shadowCtx.makeImage() else { return nil }

    let plane = SCNPlane(width: CGFloat(spanX), height: CGFloat(spanZ))
    let mat = SCNMaterial()
    mat.lightingModel = .constant
    mat.diffuse.contents = shadowImg
    mat.writesToDepthBuffer = false
    mat.readsFromDepthBuffer = true
    mat.blendMode = .alpha
    mat.isDoubleSided = false
    plane.materials = [mat]

    let node = SCNNode(geometry: plane)
    node.castsShadow = false
    node.renderingOrder = -10
    let rot = simd_float4x4(simd_quatf(angle: -.pi / 2, axis: SIMD3<Float>(1, 0, 0)))
    var xform = rot
    let eps = max(horizMax, rawSpanY) * 0.0008
    xform.columns.3 = SIMD4<Float>(0.5 * (minX + maxX), floorY - eps, 0.5 * (minZ + maxZ), 1)
    node.simdTransform = xform
    return node
}

private func drawInsetBadge(_ insetImage: CGImage, into context: CGContext, size: Int, lightStage: Bool) {
    let badgeSize = (Double(size) * 0.28).rounded()
    let originX = (Double(size) * 0.61).rounded()
    let originY = (Double(size) * 0.11).rounded()
    let rect = CGRect(x: originX, y: originY, width: badgeSize, height: badgeSize)
    let corner = CGFloat(badgeSize * 0.14)
    let path = CGPath(roundedRect: rect, cornerWidth: corner, cornerHeight: corner, transform: nil)

    context.saveGState()
    context.addPath(path)
    context.setFillColor(lightStage
        ? CGColor(srgbRed: 0.91, green: 0.92, blue: 0.94, alpha: 0.95)
        : CGColor(srgbRed: 0.16, green: 0.17, blue: 0.21, alpha: 0.95))
    context.fillPath()

    context.addPath(path)
    context.clip()
    context.draw(insetImage, in: rect)
    context.restoreGState()

    context.saveGState()
    context.addPath(path)
    context.setStrokeColor(lightStage
        ? CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.18)
        : CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.22))
    context.setLineWidth(max(1.0, CGFloat(size) / 420.0))
    context.strokePath()
    context.restoreGState()
}

// MARK: - Public Entry Point

public func renderPicture(_ spec: PictureSpec, to output: URL) throws {
    let size = spec.pixels
    let useLightStage = false
    guard let context = stage(size, light: useLightStage) else { throw HandheldError.io("no drawing context") }

    if let model = spec.model {
        let scene = SCNScene()
        scene.background.contents = NSColor.clear
        let ext = model.pathExtension.lowercased()
        let own = !spec.zUp && spec.tint == nil && ext != "3mf" && ext != "stl"

        let root = SCNNode()
        let part = try loadNode(model, zUp: false, tint: spec.tint, own: own, lightStage: useLightStage)
        let frame = SCNNode()
        frame.addChildNode(part)

        if let object = spec.object, !spec.seats.isEmpty {
            // The scan's frame (metres, Y up) into the part's frame (millimetres, Z up), then each seat.
            let toSeatFrame = simd_float4x4(rows: [SIMD4(1000, 0, 0, 0), SIMD4(0, 0, -1000, 0), SIMD4(0, 1000, 0, 0), SIMD4(0, 0, 0, 1)])
            let scan = try loadNode(object, zUp: false, tint: nil, own: true, lightStage: useLightStage)
            for seat in spec.seats where seat.count == 16 {
                let m = simd_float4x4(rows: (0..<4).map { r in SIMD4<Float>((0..<4).map { Float(seat[r * 4 + $0]) }) })
                let placed = scan.clone()
                placed.name = heroSeatMarker
                placed.simdTransform = m * toSeatFrame
                frame.addChildNode(placed)
            }
        }
        if spec.zUp {
            frame.simdTransform = simd_float4x4(simd_quatf(angle: -.pi / 2, axis: SIMD3<Float>(1, 0, 0)))
        }
        root.addChildNode(frame)
        scene.rootNode.addChildNode(root)

        let allBodies = extractSceneBodies(from: root)
        guard !allBodies.isEmpty else { throw HandheldError.io("\(model.lastPathComponent) has nothing to draw") }

        let insetMode = chooseInsetMode(for: allBodies)
        let mainBodies: [SceneBody]
        var hiddenForMain: [SCNNode] = []
        switch insetMode {
        case .multiPlateOverview(let heroIndices):
            mainBodies = heroIndices.sorted().map { allBodies[$0] }
            let visibleNodes = Set(mainBodies.map { ObjectIdentifier($0.node) })
            for (idx, body) in allBodies.enumerated() where !heroIndices.contains(idx) {
                if !visibleNodes.contains(ObjectIdentifier(body.node)) && !body.node.isHidden {
                    body.node.isHidden = true
                    hiddenForMain.append(body.node)
                }
            }
        case .none, .undersideInlay:
            mainBodies = allBodies
        }

        let mainViewDir = chooseShapeView(for: mainBodies)
        guard let mainPlacement = fitPerspectiveCamera(bodies: mainBodies, viewDir: mainViewDir, fovDegrees: 24.0, targetFill: 0.808) else {
            throw HandheldError.io("\(model.lastPathComponent) has nothing to draw")
        }

        let darkPart = !own && luminance(spec.tint) < 0.22
        let brightPart = !own && luminance(spec.tint) > 0.80
        if !own {
            scene.lightingEnvironment.contents = studioEnvironmentImage
            scene.lightingEnvironment.intensity = brightPart ? 0.36 : (darkPart && !useLightStage ? 0.88 : 0.54)
        }
        let mainRig = own ? nil : makeStudioLightRig(for: mainPlacement, lightStage: useLightStage, darkPart: darkPart, brightPart: brightPart)
        if let mainRig { scene.rootNode.addChildNode(mainRig) }
        let mainShadow = makeContactShadowNode(for: mainBodies, lightStage: useLightStage)
        if let mainShadow { scene.rootNode.addChildNode(mainShadow) }

        guard let device = MTLCreateSystemDefaultDevice() else { throw HandheldError.unsupported("no Metal device to draw with") }
        let renderer = SCNRenderer(device: device, options: nil)
        renderer.scene = scene
        renderer.autoenablesDefaultLighting = false

        let camera = SCNNode()
        scene.rootNode.addChildNode(camera)
        renderer.pointOfView = camera
        applyCamera(mainPlacement, fovDegrees: 24.0, to: camera)

        let image = renderer.snapshot(atTime: 0, with: CGSize(width: size, height: size), antialiasingMode: .multisampling4X)
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw HandheldError.io("couldn't draw \(model.lastPathComponent)")
        }
        context.draw(cg, in: CGRect(x: 0, y: 0, width: size, height: size))

        // Second inset badge when the geometric rule says a single view hides distant plates or an underside inlay.
        if size >= 300 {
            switch insetMode {
            case .none:
                break
            case .multiPlateOverview:
                for node in hiddenForMain { node.isHidden = false }
                mainShadow?.removeFromParentNode()
                mainRig?.removeFromParentNode()
                let elev = 52.0 * Double.pi / 180.0
                let overviewDir = simd_normalize(SIMD3<Double>(0.42 * cos(elev), sin(elev), 0.91 * cos(elev)))
                if let ovPlacement = fitPerspectiveCamera(bodies: allBodies, viewDir: overviewDir, fovDegrees: 24.0, targetFill: 0.82) {
                    let ovRig = own ? nil : makeStudioLightRig(for: ovPlacement, lightStage: useLightStage, darkPart: darkPart, brightPart: brightPart)
                    if let ovRig { scene.rootNode.addChildNode(ovRig) }
                    applyCamera(ovPlacement, fovDegrees: 24.0, to: camera)
                    let insetPx = max(128, Int((Double(size) * 0.28).rounded()))
                    let ovSnap = renderer.snapshot(atTime: 0, with: CGSize(width: insetPx, height: insetPx), antialiasingMode: .multisampling4X)
                    if let ovCG = ovSnap.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                        drawInsetBadge(ovCG, into: context, size: size, lightStage: useLightStage)
                    }
                }
            case .undersideInlay:
                mainShadow?.removeFromParentNode()
                mainRig?.removeFromParentNode()
                let inlays = allBodies.filter(\.isUndersideInlay)
                var iLo = SIMD3<Float>(repeating: .infinity), iHi = SIMD3<Float>(repeating: -.infinity)
                for b in inlays { iLo = simd_min(iLo, b.lo); iHi = simd_max(iHi, b.hi) }
                let focusBodies = allBodies.filter { b in
                    if b.isUndersideInlay { return true }
                    return b.lo.x <= iHi.x + 1.0 && b.hi.x >= iLo.x - 1.0 &&
                           b.lo.z <= iHi.z + 1.0 && b.hi.z >= iLo.z - 1.0
                }
                let focusNodes = Set(focusBodies.map { ObjectIdentifier($0.node) })
                for b in allBodies where !focusNodes.contains(ObjectIdentifier(b.node)) {
                    b.node.isHidden = true
                }
                let underDir = simd_normalize(SIMD3<Double>(0.04, -0.96, 0.28))
                if let unPlacement = fitPerspectiveCamera(bodies: focusBodies.isEmpty ? allBodies : focusBodies, viewDir: underDir, fovDegrees: 22.0, targetFill: 0.82) {
                    let unRig = own ? nil : makeStudioLightRig(for: unPlacement, lightStage: useLightStage, darkPart: darkPart, brightPart: brightPart)
                    if let unRig { scene.rootNode.addChildNode(unRig) }
                    applyCamera(unPlacement, fovDegrees: 22.0, to: camera)
                    let insetPx = max(128, Int((Double(size) * 0.28).rounded()))
                    let unSnap = renderer.snapshot(atTime: 0, with: CGSize(width: insetPx, height: insetPx), antialiasingMode: .multisampling4X)
                    if let unCG = unSnap.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                        drawInsetBadge(unCG, into: context, size: size, lightStage: useLightStage)
                    }
                }
            }
        }
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
    let scale = min(Double(size) * 0.82 / Double(cut.width), Double(size) * 0.82 / Double(cut.height))
    let width = Double(cut.width) * scale, height = Double(cut.height) * scale
    context.draw(cut, in: CGRect(x: (Double(size) - width) / 2, y: (Double(size) - height) / 2, width: width, height: height))
}
