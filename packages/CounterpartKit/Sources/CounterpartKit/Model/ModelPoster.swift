#if canImport(RealityKit) && canImport(Metal)
import Foundation
import CoreGraphics
import Metal
import RealityKit
import simd

/// A bounded still of a model, without a camera session or a persistent render loop.
@available(iOS 18, macOS 15, *)
@MainActor public enum ModelPoster {
    private static let images: NSCache<NSString, CGImage> = {
        let cache = NSCache<NSString, CGImage>()
        cache.countLimit = 8
        cache.totalCostLimit = 24 * 1024 * 1024
        return cache
    }()
    private static var pending: [String: Task<CGImage?, Never>] = [:]

    public static func image(key: String, model: Entity, yaw: Float, pitch: Float, fit: Float) async -> CGImage? {
        let key = "\(key)#\(yaw)#\(pitch)#\(fit)"
        if let image = images.object(forKey: key as NSString) { return image }
        if let task = pending[key] { return await task.value }
        let task = Task { @MainActor in
            try? await render(model: model, yaw: yaw, pitch: pitch, fit: fit)
        }
        pending[key] = task
        let image = await task.value
        pending[key] = nil
        if let image { images.setObject(image, forKey: key as NSString, cost: image.bytesPerRow * image.height) }
        return image
    }

    /// Shared framing makes the idle still and the interactive model agree.
    public static func scene(model: Entity, yaw: Float, pitch: Float, fit: Float) -> (root: Entity, pivot: Entity, camera: PerspectiveCamera) {
        let root = Entity(), pivot = Entity(), object = model.clone(recursive: true)
        let bounds = object.visualBounds(relativeTo: nil)
        let size = max(bounds.extents.x, max(bounds.extents.y, bounds.extents.z))
        let scale = fit / max(size, 0.0001)
        object.scale = SIMD3(repeating: scale)
        object.position = -bounds.center * scale
        pivot.addChild(object)
        pivot.orientation = simd_quatf(angle: pitch, axis: [1, 0, 0]) * simd_quatf(angle: yaw, axis: [0, 1, 0])
        root.addChild(pivot)
        for (intensity, from) in [(Float(4200), SIMD3<Float>(0.4, 0.6, 0.5)), (1600, [-0.5, 0.1, 0.3]), (2200, [0, 0.3, -0.6]), (900, [0, -0.5, 0.3])] {
            let light = DirectionalLight()
            light.light.intensity = intensity
            light.look(at: .zero, from: from, relativeTo: nil)
            root.addChild(light)
        }
        let camera = PerspectiveCamera()
        camera.camera.fieldOfViewInDegrees = 34
        // A rotated cube's diagonal is larger than any one side. Frame its
        // bounding sphere so even the largest allowed preview cannot clip.
        let distance = max(Float(0.58), simd_length(bounds.extents * scale) * 0.5 / sin(Float.pi * 17 / 180) * 1.15)
        camera.look(at: .zero, from: [0, distance * 0.08, distance], relativeTo: nil)
        root.addChild(camera)
        return (root, pivot, camera)
    }

    private static func render(model: Entity, yaw: Float, pitch: Float, fit: Float) async throws -> CGImage? {
        guard let device = MTLCreateSystemDefaultDevice() else { return nil }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm_srgb, width: 768, height: 768, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead, .shaderWrite]
        descriptor.storageMode = .shared
        guard let texture = device.makeTexture(descriptor: descriptor) else { return nil }
        let renderer = try RealityRenderer()
        renderer.cameraSettings.colorBackground = .color(CGColor(red: 0, green: 0, blue: 0, alpha: 0))
        let (root, _, camera) = scene(model: model, yaw: yaw, pitch: pitch, fit: fit)
        renderer.entities.append(root)
        renderer.activeCamera = camera
        let output = try RealityRenderer.CameraOutput(.singleProjection(colorTexture: texture))
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            do {
                try renderer.updateAndRender(deltaTime: 0, cameraOutput: output, onComplete: { _ in continuation.resume() })
            } catch { continuation.resume(throwing: error) }
        }
        var bytes = [UInt8](repeating: 0, count: 768 * 768 * 4)
        texture.getBytes(&bytes, bytesPerRow: 768 * 4, from: MTLRegionMake2D(0, 0, 768, 768), mipmapLevel: 0)
        guard let provider = CGDataProvider(data: Data(bytes) as CFData), let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        return CGImage(width: 768, height: 768, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 768 * 4,
                       space: space, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue).union(.byteOrder32Little),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }
}
#endif
