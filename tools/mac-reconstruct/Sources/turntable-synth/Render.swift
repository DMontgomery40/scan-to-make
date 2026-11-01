import Foundation
import SceneKit
import ModelIO
import SceneKit.ModelIO
import AppKit
import simd
import HandheldKit

/// A fixed pinhole camera at the origin looking down −Z (image y down, world y up).
struct Pinhole {
    var width: Int, height: Int
    var fx: Double
    var cx: Double { Double(width) / 2 }
    var cy: Double { Double(height) / 2 }
    var horizontalFOVDegrees: Double { 2 * atan(Double(width) / 2 / fx) * 180 / .pi }
    func scaled(toWidth w: Int) -> Pinhole { Pinhole(width: w, height: height * w / width, fx: fx * Double(w) / Double(width)) }
}

/// The model's triangles in its own frame, for rasterising exact depth.
struct Mesh {
    var positions: [SIMD3<Float>] = []
    var triangles: [SIMD3<UInt32>] = []

    init(node root: SCNNode) {
        root.enumerateHierarchy { node, _ in
            guard let geometry = node.geometry, let source = geometry.sources(for: .vertex).first else { return }
            let toRoot = root.simdConvertTransform(matrix_identity_float4x4, from: node)
            let base = UInt32(positions.count)
            source.data.withUnsafeBytes { raw in
                for i in 0..<source.vectorCount {
                    let p = raw.baseAddress!.advanced(by: source.dataOffset + i * source.dataStride).assumingMemoryBound(to: Float.self)
                    let v = toRoot * SIMD4<Float>(p[0], p[1], p[2], 1)
                    positions.append(SIMD3(v.x, v.y, v.z))
                }
            }
            for element in geometry.elements where element.primitiveType == .triangles {
                element.data.withUnsafeBytes { raw in
                    func index(_ i: Int) -> UInt32 {
                        switch element.bytesPerIndex {
                        case 2: return UInt32(raw.load(fromByteOffset: i * 2, as: UInt16.self))
                        case 4: return raw.load(fromByteOffset: i * 4, as: UInt32.self)
                        default: return UInt32(raw.load(fromByteOffset: i, as: UInt8.self))
                        }
                    }
                    for t in 0..<element.primitiveCount {
                        triangles.append(SIMD3(base + index(t * 3), base + index(t * 3 + 1), base + index(t * 3 + 2)))
                    }
                }
            }
        }
    }

    /// Planar depth (camera z, metres) of the model under `transform`, 0 where it isn't.
    func depth(transform: simd_float4x4, camera: Pinhole) -> [Float] {
        let w = camera.width, h = camera.height
        var z = [Float](repeating: 0, count: w * h)
        let projected: [SIMD3<Double>] = positions.map { p in
            let c = transform * SIMD4<Float>(p, 1)
            let depth = Double(-c.z)
            return SIMD3(camera.cx + camera.fx * Double(c.x) / depth, camera.cy - camera.fx * Double(c.y) / depth, depth)
        }
        for t in triangles {
            let a = projected[Int(t.x)], b = projected[Int(t.y)], c = projected[Int(t.z)]
            guard a.z > 0.01, b.z > 0.01, c.z > 0.01 else { continue }
            let area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
            if abs(area) < 1e-12 { continue }
            let minX = max(0, Int(floor(min(a.x, b.x, c.x)))), maxX = min(w - 1, Int(ceil(max(a.x, b.x, c.x))))
            let minY = max(0, Int(floor(min(a.y, b.y, c.y)))), maxY = min(h - 1, Int(ceil(max(a.y, b.y, c.y))))
            if minX > maxX || minY > maxY { continue }
            for y in minY...maxY { for x in minX...maxX {
                let px = Double(x) + 0.5, py = Double(y) + 0.5
                let w0 = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area
                let w1 = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area
                let w2 = 1 - w0 - w1
                if w0 < 0 || w1 < 0 || w2 < 0 { continue }
                let inverse = w0 / a.z + w1 / b.z + w2 / c.z   // perspective-correct
                let d = Float(1 / inverse)
                let i = y * w + x
                if z[i] == 0 || d < z[i] { z[i] = d }
            } }
        }
        return z
    }
}

/// Renders the textured model alone on a transparent background with SceneKit.
final class ModelRenderer {
    let scene = SCNScene()
    let holder = SCNNode()      // moved each frame; the model's centre sits at its origin
    let model: SCNNode
    let mesh: Mesh
    let renderer: SCNRenderer
    let camera: Pinhole

    init(modelURL: URL, camera: Pinhole) {
        self.camera = camera
        let asset = MDLAsset(url: modelURL)
        asset.loadTextures()
        let loaded = SCNScene(mdlAsset: asset)
        model = SCNNode()
        for child in loaded.rootNode.childNodes { model.addChildNode(child) }
        let (low, high) = model.boundingBox
        model.position = SCNVector3(-(low.x + high.x) / 2, -(low.y + high.y) / 2, -(low.z + high.z) / 2)
        holder.addChildNode(model)
        scene.rootNode.addChildNode(holder)
        mesh = Mesh(node: holder)

        let eye = SCNNode(); eye.camera = SCNCamera()
        eye.camera!.projectionDirection = .horizontal
        eye.camera!.fieldOfView = CGFloat(camera.horizontalFOVDegrees)
        eye.camera!.zNear = 0.01; eye.camera!.zFar = 10
        scene.rootNode.addChildNode(eye)
        let ambient = SCNNode(); ambient.light = SCNLight(); ambient.light!.type = .ambient; ambient.light!.intensity = 550
        scene.rootNode.addChildNode(ambient)
        let key = SCNNode(); key.light = SCNLight(); key.light!.type = .directional; key.light!.intensity = 650
        key.simdPosition = SIMD3(-0.3, 0.4, 0.3); key.simdLook(at: SIMD3(0, 0, -0.25))
        scene.rootNode.addChildNode(key)
        scene.background.contents = NSColor.clear
        renderer = SCNRenderer(device: MTLCreateSystemDefaultDevice(), options: nil)
        renderer.scene = scene
        renderer.pointOfView = eye
        renderer.autoenablesDefaultLighting = false
    }

    /// RGBA pixels (premultiplied, row 0 at the top) of the model under `transform`.
    func render(transform: simd_float4x4) -> CGImage {
        holder.simdTransform = transform
        let image = renderer.snapshot(atTime: 0, with: CGSize(width: camera.width, height: camera.height), antialiasingMode: .multisampling4X)
        var rect = CGRect(x: 0, y: 0, width: camera.width, height: camera.height)
        return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)!
    }
}

/// A premultiplied RGBA canvas, row 0 at the top.
struct Canvas {
    var width: Int, height: Int
    var rgba: [UInt8]
    init(width: Int, height: Int) { self.width = width; self.height = height; rgba = [UInt8](repeating: 0, count: width * height * 4) }

    mutating func draw(_ image: CGImage, in rect: CGRect) {
        let w = width, h = height
        rgba.withUnsafeMutableBytes { raw in
            let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            ctx.interpolationQuality = .high
            // CoreGraphics' origin is bottom-left; flip so `rect` is in top-left image coordinates.
            ctx.translateBy(x: 0, y: CGFloat(h)); ctx.scaleBy(x: 1, y: -1)
            ctx.translateBy(x: rect.minX, y: rect.maxY); ctx.scaleBy(x: 1, y: -1)
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: rect.width, height: rect.height))
        }
    }

    func alpha(x: Int, y: Int) -> UInt8 { rgba[(y * width + x) * 4 + 3] }

    func cgImage(opaque: Bool = true) -> CGImage {
        CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(rawValue: (opaque ? CGImageAlphaInfo.noneSkipLast : CGImageAlphaInfo.premultipliedLast).rawValue),
                provider: CGDataProvider(data: Data(rgba) as CFData)!, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    }

    static func from(_ image: CGImage) -> Canvas {
        var canvas = Canvas(width: image.width, height: image.height)
        canvas.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return canvas
    }
}

func loadStoredImage(_ url: URL) throws -> CGImage {
    // The stored pixels, ignoring the EXIF orientation: a background only needs to be a real scene.
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw HandheldError.io("can't read \(url.path)") }
    return image
}

func writePNG(_ image: CGImage, to url: URL) throws {
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { throw HandheldError.io(url.path) }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { throw HandheldError.io(url.path) }
}

func rotation(_ angle: Double, _ axis: SIMD3<Float>) -> simd_float4x4 {
    simd_float4x4(simd_quatf(angle: Float(angle), axis: simd_normalize(axis)))
}

func translation(_ t: SIMD3<Float>) -> simd_float4x4 {
    var m = matrix_identity_float4x4; m.columns.3 = SIMD4(t, 1); return m
}
